#!/usr/bin/env python3
"""
IITD Mailer - send personalised emails from a CSV through your IIT Delhi
(or Gmail) account, with a per-hour limit and automatic pause-and-retry.

Made by Ayush Vishwakarma.

On your laptop:
    pip install -r requirements.txt
    python app.py                -> opens http://127.0.0.1:8765

On a server (see DEPLOY.md):
    MAILER_MODE=server MAILER_LOGIN_PASSWORD=... python app.py

Everything the app keeps (lists, attachments, settings, the send queue) lives
in the data/ folder next to this file. sent_log.csv records every send.
"""
import csv
import html as htmllib
import imaplib
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import socket
import ssl
import sys
import threading
import time
import uuid
import webbrowser
from collections import deque
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from flask import Flask, Response, jsonify, redirect, render_template, request, session

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MAILER_DATA", HERE / "data")).resolve()
LISTS_DIR = DATA / "lists"
FILES_DIR = DATA / "files"
ATT_DIR = HERE / "attachments"          # optional: drop files here too
LOG_FILE = Path(os.environ.get("MAILER_LOG", HERE / "sent_log.csv"))
SETTINGS_FILE = DATA / "settings.json"
CONTACTS_FILE = DATA / "contacts.json"   # everyone emailed, by address, across all lists
SECRET_FILE = DATA / "secret.json"       # saved SMTP password (only if you ask), chmod 600
JOB_FILE = DATA / "job.json"

SERVER_MODE = os.environ.get("MAILER_MODE", "").lower() == "server"
LOGIN_PASSWORD = os.environ.get("MAILER_LOGIN_PASSWORD", "")
COOLDOWNS_MIN = [float(x) for x in os.environ.get("MAILER_COOLDOWNS", "15,30,60").split(",")]

for d in (DATA, LISTS_DIR, FILES_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 250 * 1024 * 1024


# ---------------------------------------------------------------- small storage helpers
def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, obj, private=False):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    if private:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def secret_key():
    p = DATA / "secret_key"
    if not p.exists():
        p.write_text(secrets.token_hex(32))
        os.chmod(p, 0o600)
    return p.read_text().strip()


app.secret_key = secret_key()
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=SERVER_MODE and os.environ.get("MAILER_COOKIE_SECURE", "1") != "0",
                  PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30)
if SERVER_MODE:  # behind Caddy: trust its https / client-address headers
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

PROVIDERS = {
    "iitd": {"host": "smtp.iitd.ac.in", "port": 465},
    "gmail": {"host": "smtp.gmail.com", "port": 465},
}
DEFAULT_PACE = {"delay": 5, "per_hour": 20}

FIELDS = ["to", "subject", "body", "cc", "bcc", "reply_to", "attachments"]
GUESSES = {
    "to": ["email", "e-mail", "email id", "emailid", "email address", "mail id", "mail",
           "to", "recipient", "recipient email", "recipients"],
    "subject": ["subject", "subject line", "mail subject", "email subject"],
    "body": ["body", "mainbody", "main body", "message", "content", "mail body",
             "email body", "text"],
    "cc": ["cc"],
    "bcc": ["bcc"],
    "reply_to": ["reply-to", "reply to", "replyto"],
    "attachments": ["attachments", "attachment", "files", "file", "attach"],
}
CONTAINS = {"to": "email", "subject": "subject", "body": "body", "attachments": "attach"}

EMAIL_RE = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$")
HTML_RE = re.compile(r"<\s*/?\s*(p|br|div|html|body|b|i|u|strong|em|a|ul|ol|li|table|tr|td|span|h[1-6]|img|hr)\b", re.I)
PH_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}|\{([^{}\n]{1,60})\}")
LIMIT_WORDS = re.compile(r"rate|limit|too many|quota|exceed|try again later|throttl|policy|temporar", re.I)

lock = threading.RLock()
state = {"account": None, "password": "", "lists": {}, "rows": {}, "job": None}
SENT_TIMES = deque()   # epoch seconds of every email sent in the last hour (all lists, tests too)


# ---------------------------------------------------------------- settings and account
def load_settings():
    s = read_json(SETTINGS_FILE, {})
    s.setdefault("pace", dict(DEFAULT_PACE))
    s.setdefault("account", None)
    s.setdefault("current", None)
    s.setdefault("copies", {"bcc_self": False, "bcc_to": "", "save_sent": False, "imap_host": "", "imap_port": 993, "sent_folder": ""})
    s.setdefault("templates", [])        # saved messages: {id, name, subject, body, saved}
    return s


SETTINGS = load_settings()


def save_settings():
    write_json(SETTINGS_FILE, SETTINGS)


def saved_password():
    return os.environ.get("MAILER_SMTP_PASSWORD") or read_json(SECRET_FILE, {}).get("smtp_password", "")


def account_with_password():
    acc = SETTINGS.get("account")
    if not acc:
        return None
    pw = state["password"] or saved_password()
    return dict(acc, password=pw) if pw else None


def public_account():
    acc = SETTINGS.get("account")
    if not acc:
        return None
    return dict(acc, connected=bool(state["password"] or saved_password()),
                password_saved=bool(saved_password()),
                password_from_env=bool(os.environ.get("MAILER_SMTP_PASSWORD")))


# ---------------------------------------------------------------- CSV and lists
def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def guess_mapping(columns):
    mapping, used = {}, set()
    for field in FIELDS:
        targets = {norm(g) for g in GUESSES[field]}
        pick = next((c for c in columns if c not in used and norm(c) in targets), None)
        if pick:
            mapping[field] = pick
            used.add(pick)
    for field, kw in CONTAINS.items():
        if field not in mapping:
            pick = next((c for c in columns if c not in used and kw in norm(c)), None)
            if pick:
                mapping[field] = pick
                used.add(pick)
    return mapping


def parse_csv(raw):
    text = None
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    first = text.split("\n", 1)[0]
    delim = max([",", ";", "\t", "|"], key=first.count)
    if first.count(delim) == 0:
        delim = ","
    table = [r for r in csv.reader(io.StringIO(text, newline=""), delimiter=delim)]
    table = [r for r in table if any(c.strip() for c in r)]
    if not table:
        raise ValueError("the file is empty")
    header, seen = [], {}
    for i, h in enumerate(table[0]):
        h = h.strip() or f"Column {i + 1}"
        if h in seen:
            seen[h] += 1
            h = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
        header.append(h)
    rows = []
    for r in table[1:]:
        r = r + [""] * (len(header) - len(r))
        rows.append({h: r[i].strip() for i, h in enumerate(header)})
    if not rows:
        raise ValueError("it has a header row but no data rows")
    return header, rows


def load_lists():
    for d in sorted(LISTS_DIR.iterdir()) if LISTS_DIR.exists() else []:
        meta = read_json(d / "meta.json", None)
        if meta and (d / "source.csv").exists():
            state["lists"][meta["id"]] = meta


def list_rows(lid):
    if lid not in state["rows"]:
        cols, rows = parse_csv((LISTS_DIR / lid / "source.csv").read_bytes())
        state["rows"][lid] = rows
    return state["rows"][lid]


def save_meta(meta):
    write_json(LISTS_DIR / meta["id"] / "meta.json", meta)


def list_summary(meta):
    sent = sum(1 for v in meta["status"].values() if v.get("status") == "sent")
    return {"id": meta["id"], "name": meta["name"], "filename": meta["filename"], "count": meta["count"],
            "sent": sent, "created": meta["created"], "archived": bool(meta.get("archived"))}


def all_summaries():
    return [list_summary(m) for m in sorted(state["lists"].values(), key=lambda m: m["created"], reverse=True)]


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def add_event(meta, kind, **kw):
    h = meta.setdefault("history", [])
    h.append(dict(kw, kind=kind, time=now_str()))
    del h[:-300]


# ----- who has been emailed already (by address, across every list, kept even if a list is deleted)
CONTACTS = {}


def addr_key(a):
    return a.strip().lower()


def add_contact(contacts, addr, entry):
    lst = contacts.setdefault(addr_key(addr), [])
    lst.append(entry)
    del lst[:-5]


def load_contacts():
    c = read_json(CONTACTS_FILE, None)
    if c is not None:
        return c
    c = {}                                   # first run: rebuild from the sent log
    by_file = {m["filename"]: m for m in state["lists"].values()}
    for r in read_log():
        if r.get("status") != "sent":
            continue
        m = by_file.get(r.get("csv_file"))
        row = int(r["row"]) - 1 if str(r.get("row", "")).isdigit() else None
        for a in split_addrs(r.get("to", "")):
            if EMAIL_RE.match(a):
                add_contact(c, a, {"time": r.get("time", ""), "list_id": m["id"] if m else None,
                                   "list_name": m["name"] if m else r.get("csv_file", ""), "row": row,
                                   "subject": r.get("subject", "")})
    write_json(CONTACTS_FILE, c)
    return c


def remember_sent(meta, idx, info, when):
    for a in info["to"]:
        add_contact(CONTACTS, a, {"time": when, "list_id": meta["id"], "list_name": meta["name"], "row": idx,
                                  "subject": info["subject"]})
    write_json(CONTACTS_FILE, CONTACTS)


def emailed_before(lid, idx, addrs):
    """The latest earlier send to any of these addresses, not counting this very row."""
    best = None
    for a in addrs:
        for e in CONTACTS.get(addr_key(a), []):
            if e.get("list_id") == lid and e.get("row") == idx:
                continue
            if best is None or e.get("time", "") > best.get("time", ""):
                best = dict(e, addr=a)
    if best:
        m = state["lists"].get(best.get("list_id"))
        best.update(kind="sent", same_list=best.get("list_id") == lid, list_exists=bool(m),
                    list_name=m["name"] if m else best.get("list_name", ""))
    return best


def row_addrs(row, mapping):
    return [a for a in split_addrs(fill(col(row, mapping, "to"), row, set())) if EMAIL_RE.match(a)]


def befores(meta):
    """Rows not sent yet whose address was emailed before, or already appears in an earlier row of this list."""
    out, first, lid = {}, {}, meta["id"]
    mapping = meta.get("mapping") or {}
    for i, row in enumerate(list_rows(lid)):
        addrs = row_addrs(row, mapping)
        if (meta["status"].get(str(i)) or {}).get("status") != "sent":
            hit = emailed_before(lid, i, addrs)
            if not hit:
                dup = next((a for a in addrs if addr_key(a) in first), None)
                if dup:
                    hit = {"kind": "dup", "addr": dup, "row": first[addr_key(dup)]}
            if hit:
                out[i] = hit
        for a in addrs:
            first.setdefault(addr_key(a), i)
    return out


def save_snapshot(meta, idx, info, when):
    d = LISTS_DIR / meta["id"] / "sent"
    d.mkdir(exist_ok=True)
    snap = {k: info.get(k) for k in ("from", "to", "to_raw", "cc", "bcc", "reply_to", "subject", "body", "is_html", "attachments")}
    snap["time"] = when
    write_json(d / f"{idx}.json", snap)


def list_busy(lid):
    job = state["job"]
    return bool(job and job["list_id"] == lid and job["state"] in ("running", "waiting"))


def write_rows(meta, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(meta["columns"])
    for r in rows:
        w.writerow([r.get(c, "") for c in meta["columns"]])
    (LISTS_DIR / meta["id"] / "source.csv").write_bytes(buf.getvalue().encode("utf-8"))


def row_key(row, mapping):
    return ",".join(sorted(addr_key(a) for a in row_addrs(row, mapping)))


def plan_replace(meta, cols, rows):
    """Match the new file's rows to the old ones by email address."""
    old_rows, old_map = list_rows(meta["id"]), meta.get("mapping") or {}
    mapping = {k: v for k, v in old_map.items() if v in cols}
    for k, v in guess_mapping(cols).items():
        if k not in mapping and (k in old_map or k in ("to", "subject", "body")):
            mapping[k] = v
    pool = {}
    for i, r in enumerate(old_rows):
        k = row_key(r, old_map)
        if k:
            pool.setdefault(k, deque()).append(i)
    match = {}
    for j, r in enumerate(rows):
        k = row_key(r, mapping)
        if k and pool.get(k):
            match[j] = pool[k].popleft()
    sent = {int(k) for k, v in meta["status"].items() if v.get("status") == "sent"}
    used = set(match.values())
    text = lambda r, m: (col(r, m, "subject"), col(r, m, "body"))
    summary = {"rows": len(rows), "sent_kept": len(used & sent), "unsent_updated": len(used - sent),
               "new": len(rows) - len(match), "removed_unsent": len(set(range(len(old_rows))) - used - sent),
               "removed_sent": len(sent - used), "no_to": not mapping.get("to"),
               "text_changed": sum(1 for j, o in match.items() if o in sent and text(rows[j], mapping) != text(old_rows[o], old_map))}
    return mapping, match, summary


# ---------------------------------------------------------------- building one email
def fill(text, row, missing):
    lookup = {norm(k): k for k in row}

    def rep(m):
        key = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
        col = lookup.get(norm(key)) if norm(key) else None
        if col is not None:
            return row[col]
        if re.fullmatch(r"[A-Za-z_][\w .\-]{0,40}", key):
            missing.add(key)
        return m.group(0)

    return PH_RE.sub(rep, text or "")


def split_addrs(s):
    return [a for a in re.split(r"[;,\s]+", s or "") if a]


def stored_files():
    return {p.name.lower(): p for p in FILES_DIR.iterdir() if p.is_file()} if FILES_DIR.exists() else {}


def find_attachment(name, files):
    name = name.strip().strip('"').strip("'")
    if not name:
        return None
    key = Path(name).name.lower()
    if key in files:
        return files[key]
    for p in (Path(name).expanduser(), ATT_DIR / name, ATT_DIR / Path(name).name):
        try:
            if p.is_file():
                return p
        except OSError:
            pass
    return None


def html_to_text(h):
    t = re.sub(r"(?is)<(script|style).*?</\1>", "", h)
    t = re.sub(r"(?i)<br\s*/?>", "\n", t)
    t = re.sub(r"(?i)</(p|div|h[1-6]|li|tr)>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    return re.sub(r"\n{3,}", "\n\n", htmllib.unescape(t)).strip()


def col(row, mapping, field):
    c = mapping.get(field)
    return row.get(c, "") if c else ""


# ----- one message for everyone ("template" mode) and the name placeholders it can use
NAME_FALLBACKS = ("Dr.", "Professor", "name")
NAME_KEYS = ("Greeting name", "First name", "Last name", "Title")
NAME_PH_RE = re.compile(r"\{\{?\s*(greeting\s*name|first\s*name|last\s*name|title)\s*\}?\}", re.I)
TITLE_RE = re.compile(r"^(prof(?:essor)?|dr|doctor|mr|mrs|ms|miss|sir|dame)\.?\s+", re.I)
TITLE_WORDS = {"prof": "Professor", "professor": "Professor", "dr": "Dr.", "doctor": "Dr.", "mr": "Mr", "mrs": "Mrs",
               "ms": "Ms", "miss": "Ms", "sir": "Sir", "dame": "Dame"}
# a role written at the start of another cell, e.g. "Professor; profile mentions ..." or "Assistant Professor; ..."
ROLE_RE = re.compile(r"^\s*(assistant professor|associate professor|senior lecturer|lecturer|reader|professor|prof\.?|dr\.?|doctor)\b", re.I)
PARTICLES = {"mac", "mc", "van", "von", "der", "den", "de", "di", "da", "del", "della", "du", "le", "la", "dos", "das",
             "st", "al", "el", "bin", "ten", "ter", "li"}
GREETING_COLS = ("greeting name", "greeting", "salutation", "dear")


def default_message(columns, mapping):
    has_text = bool(mapping.get("subject") and mapping.get("body"))
    return {"mode": "csv" if has_text else "template", "subject": "", "body": "",
            "name_col": guess_name_col(columns), "fallback": "Dr."}


def guess_name_col(columns):
    bad = ("lab", "group", "university", "school", "department", "company", "file", "list", "subject", "greeting")
    for c in columns:
        n = c.lower()
        if "name" in n and not any(b in n for b in bad):
            return c
    return None


def message_of(meta):
    m = meta.get("message")
    if not m:
        m = {"mode": "csv", "subject": "", "body": "", "name_col": guess_name_col(meta["columns"]), "fallback": "Dr."}
    return m


def name_parts(full, row, name_col, fallback):
    """Dr./Professor + surname from a name like 'Prof. Claire S. Adjiman' or 'Huashan Bao'.
    The title comes from the name, else from a cell that starts with a role ('Professor; ...')."""
    s = " ".join(re.sub(r"\([^)]*\)", " ", full or "").split())
    title = None
    while True:
        m = TITLE_RE.match(s)
        if not m:
            break
        title = title or TITLE_WORDS[m.group(1).lower()]
        s = s[m.end():]
    tokens = s.split()
    core = [w for w in tokens if not re.fullmatch(r"[A-Z]\.?", w)]   # drop middle initials
    if len(core) < 2 and len(tokens) >= 2:
        core = tokens
    first = core[0] if core else ""
    last, check = "", False
    if len(core) >= 2:
        last, j = core[-1], len(core) - 2
        while j >= 1 and core[j].lower().rstrip(".") in PARTICLES:
            last = core[j] + " " + last
            j -= 1
        given = core[:j + 1]
        # three or more names may hide a double surname ("Anna Maria Rossi"); short given names
        # like "Bao Hua Xu" or "Tuck Seng Wong" are left alone
        check = (len(given) >= 2 and not all(len(w) <= 4 for w in given)) or len(last.replace(".", "")) <= 1
    unclear = False
    if not title:
        for c, v in row.items():
            if c == name_col:
                continue
            m = ROLE_RE.match(v or "")
            if m:
                w = m.group(1).lower().rstrip(".")
                title = "Professor" if w in ("professor", "prof") else "Dr."
                break
    if not title:
        unclear = True
        title = "" if fallback == "name" else fallback
    if title and last:
        greeting = f"{title} {last}"
    elif title and first and not last:
        greeting = f"{title} {first}"
    else:
        greeting = " ".join(core) or (full or "").strip()
    return {"Greeting name": greeting, "First name": first, "Last name": last or first, "Title": title,
            "_unclear": unclear, "_check": check, "_full": (full or "").strip()}


def with_names(meta, row):
    """The row plus {Greeting name}, {First name}, {Last name}, {Title}, unless the CSV already has such columns."""
    msg = message_of(meta)
    nc = msg.get("name_col")
    extra = {}
    if nc and nc in row:
        extra = name_parts(row.get(nc, ""), row, nc, msg.get("fallback") or "Dr.")
    own = {norm(k): k for k in row}
    for k in GREETING_COLS:                     # a Greeting column in the CSV always wins
        c = own.get(norm(k))
        if c and (row.get(c) or "").strip():
            extra = dict(extra, **{"Greeting name": row[c].strip(), "_unclear": False, "_check": False})
            break
    out = dict(row)
    for k in NAME_KEYS:
        if k not in extra:
            continue
        c = own.get(norm(k))
        if c is None:
            out[k] = extra[k]
        elif not (row.get(c) or "").strip():     # the CSV has this column but it's empty for this row
            out[c] = extra[k]
    return out, extra


def render(meta, idx, build=False, test_to=None, files=None):
    rows = list_rows(meta["id"])
    row = rows[idx]
    mapping, opts = meta.get("mapping") or {}, meta.get("opts") or {}
    files = stored_files() if files is None else files
    missing = set()
    msg = message_of(meta)
    templ = msg.get("mode") == "template"
    if templ:                                   # one message for everyone, typed in the app
        raw_subject, raw_body = msg.get("subject") or "", msg.get("body") or ""
    else:
        raw_subject, raw_body = col(row, mapping, "subject"), col(row, mapping, "body")
        if opts.get("unescape", True):
            raw_body = raw_body.replace("\\n", "\n").replace("\\t", "\t")
    row_n, names = with_names(meta, row)
    uses_names = bool(NAME_PH_RE.search(raw_subject + " " + raw_body))
    subject = " ".join(fill(raw_subject, row_n, missing).split())
    body = fill(raw_body, row_n, missing)
    fmt = opts.get("format", "auto")
    is_html = fmt == "html" or (fmt == "auto" and HTML_RE.search(body) is not None)

    to_text = fill(col(row, mapping, "to"), row, missing).strip()
    no_addr_note = ""
    if to_text and "@" not in to_text:          # e.g. "Not listed publicly - see URL": no address, not a bad one
        no_addr_note, to_text = to_text, ""
    to_all = split_addrs(to_text)
    cc_all = split_addrs(fill(col(row, mapping, "cc"), row, missing))
    bcc_all = split_addrs(fill(col(row, mapping, "bcc"), row, missing))
    reply_to = fill(col(row, mapping, "reply_to"), row, missing).strip()
    bad = [a for a in to_all + cc_all + bcc_all if not EMAIL_RE.match(a)]
    to = [a for a in to_all if EMAIL_RE.match(a)]
    cc = [a for a in cc_all if EMAIL_RE.match(a)]
    bcc = [a for a in bcc_all if EMAIL_RE.match(a)]
    cp, acc0 = SETTINGS.get("copies") or {}, SETTINGS.get("account") or {}
    bcc_self = (cp.get("bcc_to") or acc0.get("from_email") or "").strip() if cp.get("bcc_self") else ""
    if bcc_self and bcc_self.lower() not in {a.lower() for a in to + cc + bcc}:
        bcc = bcc + [bcc_self]           # a copy to yourself; recipients don't see it (test emails skip it)

    att_names = [a.strip() for a in re.split(r"[;|\n,]", fill(col(row, mapping, "attachments"), row, missing)) if a.strip()]
    seen = {Path(n).name.lower() for n in att_names}
    for n in opts.get("attach") or []:          # files attached to every email in this list
        if Path(n).name.lower() not in seen:
            att_names.append(n)
            seen.add(Path(n).name.lower())
    found, missing_att = [], []
    for n in att_names:
        p = find_attachment(n, files)
        (found.append(p) if p else missing_att.append(n))

    errors, warnings = [], []
    if not mapping.get("to"):
        errors.append("Choose which column has the email address.")
    elif not to:
        if to_all:
            errors.append("No valid email address in this row.")
        else:
            errors.append("No email address in this row" + (f" (it says \u201c{no_addr_note[:80]}\u201d)." if no_addr_note else "."))
    if bad:
        errors.append("Not a valid address: " + ", ".join(bad))
    if missing_att:
        errors.append("Attachment not found: " + ", ".join(missing_att))
    if not subject:
        warnings.append("The subject is empty." if not templ else "Write a subject in Message.")
    if not body.strip():
        warnings.append("The body is empty." if not templ else "Write the message in Message.")
    if uses_names and names and not (names.get("Greeting name") or "").strip() and NAME_PH_RE.search(raw_subject + raw_body):
        errors.append("The greeting would be empty (no name in this row). Type one under Greeting, or use Edit row.")
    if uses_names:
        if not names:
            warnings.append("Choose which column has the names (Message, under Names), so {Greeting name} can be filled in.")
        else:
            if names.get("_unclear"):
                warnings.append(f"Couldn't tell whether {names['_full'] or 'this person'} is Dr. or Professor, so the greeting says "
                                f"\u201c{names['Greeting name']}\u201d. Check it, or fix it with Greeting below.")
            if names.get("_check"):
                warnings.append(f"Check the surname: {names['_full']} has several names, and the greeting says "
                                f"\u201c{names['Greeting name']}\u201d.")
    att_bytes = sum(p.stat().st_size for p in found)
    if att_bytes > 15 * 1024 * 1024:
        warnings.append(f"Attachments add up to {att_bytes / 1048576:.1f} MB. Mail servers often refuse emails over about 20 MB.")
    if missing:
        warnings.append("No column matches " + ", ".join("{" + m + "}" for m in sorted(missing)) + ", so it is sent as written.")

    acc = SETTINGS.get("account") or {}
    from_hdr = formataddr((acc.get("from_name") or "", acc["from_email"])) if acc else ""
    info = {
        "index": idx, "from": from_hdr, "to": to, "to_raw": ", ".join(to_all), "cc": cc, "bcc": bcc,
        "reply_to": reply_to or acc.get("reply_to", ""), "subject": subject, "body": body,
        "is_html": is_html, "attachments": [p.name for p in found], "missing_attachments": missing_att,
        "attach_all": [Path(n).name for n in opts.get("attach") or []], "bcc_self": bcc_self,
        "errors": errors, "warnings": warnings, "template": templ, "no_address_note": no_addr_note,
        "greeting": names.get("Greeting name", "") if (names and uses_names) else "",
        "links": [v for v in row.values() if re.match(r"^https?://\S+$", (v or "").strip())][:2],
    }
    if not build:
        return info, None

    msg = EmailMessage()
    msg["From"] = from_hdr
    if test_to:
        msg["To"] = test_to
        msg["Subject"] = "[TEST] " + subject
    else:
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        if bcc:
            msg["Bcc"] = ", ".join(bcc)
        msg["Subject"] = subject
    if info["reply_to"]:
        msg["Reply-To"] = info["reply_to"]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=acc["from_email"].split("@")[-1])
    if is_html:
        html_doc = body if re.search(r"(?i)<html", body) else f"<html><body>{body}</body></html>"
        msg.set_content(html_to_text(body))
        msg.add_alternative(html_doc, subtype="html")
    else:
        msg.set_content(body)
    for p in found:
        ctype, _ = mimetypes.guess_type(p.name)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        msg.add_attachment(p.read_bytes(), maintype=maintype, subtype=subtype, filename=p.name)
    return info, msg


# ---------------------------------------------------------------- SMTP
def connect(acc):
    host, port = acc["host"], int(acc["port"])
    ctx = ssl.create_default_context()
    if port == 465:
        s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=30)
    else:
        s = smtplib.SMTP(host, port, timeout=30)
        s.ehlo()
        if s.has_extn("starttls"):
            s.starttls(context=ctx)
            s.ehlo()
    if acc.get("password"):
        s.login(acc["username"], acc["password"])
    return s


def friendly(e):
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return "Login rejected: check your username and password. (Gmail needs an App Password.)"
    if isinstance(e, socket.gaierror):
        return "Couldn't find that mail server. Check the server name and the internet connection."
    if isinstance(e, ssl.SSLError):
        return f"Secure connection failed ({e.reason or e}). If you use port 465 try 587, or the other way round."
    if isinstance(e, (TimeoutError, socket.timeout)):
        return "Timed out reaching the mail server. The port may be blocked on this network: try 587 or 25."
    if isinstance(e, ConnectionRefusedError):
        return "The mail server refused the connection on that port. Try 465, 587 or 25."
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        parts = []
        for addr, (code, resp) in e.recipients.items():
            resp = resp.decode(errors="replace") if isinstance(resp, bytes) else str(resp)
            parts.append(f"{addr} ({code} {resp.strip()})")
        return "Server refused recipient: " + "; ".join(parts)
    if isinstance(e, smtplib.SMTPResponseException):
        msg = e.smtp_error.decode(errors="replace") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        return f"Mail server said {e.smtp_code}: {msg}"
    return str(e) or e.__class__.__name__


def classify(e):
    """'throttle' = the server is limiting us (wait and retry), 'reject' = maybe just this row, 'other'."""
    codes = []
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        codes = [c for c, _ in e.recipients.values()]
    elif isinstance(e, smtplib.SMTPResponseException):
        codes = [e.smtp_code]
    if any(400 <= c < 500 for c in codes) or LIMIT_WORDS.search(friendly(e)):
        return "throttle"
    return "reject" if codes else "other"


def close_quietly(server):
    if server:
        try:
            server.quit()
        except Exception:
            try:
                server.close()
            except Exception:
                pass


# ---------------------------------------------------------------- copies in the Sent folder (IMAP)
IMAP_HOSTS = {"iitd": "mailstore.iitd.ac.in", "gmail": "imap.gmail.com"}
SENT_NAMES = ("Sent", "Sent Items", "Sent Messages", "Sent Mail", "INBOX.Sent", "INBOX/Sent")


def imap_connect(acc):
    cp = SETTINGS.get("copies") or {}
    host = (cp.get("imap_host") or IMAP_HOSTS.get(acc.get("provider"), "")).strip()
    port = int(cp.get("imap_port") or 993)
    if not host:
        raise ValueError("Enter the server for your Sent folder (IMAP).")
    try:
        m = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=30)
    except TypeError:   # Python 3.8 has no timeout argument
        m = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())
    m.login(acc["username"], acc["password"])
    return m


def imap_quote(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def find_sent_folder(m):
    """The folder flagged \\Sent, else one with a usual name, else create "Sent"."""
    typ, data = m.list()
    names = []
    for raw in data or []:
        line = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        mt = re.match(r'\((?P<flags>[^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(?P<name>.+)$', line)
        if not mt:
            continue
        name = mt["name"].strip()
        if len(name) > 1 and name[0] == name[-1] == '"':
            name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        if "\\sent" in mt["flags"].lower():
            return name
        names.append(name)
    low = {n.lower(): n for n in names}
    for want in SENT_NAMES:
        if want.lower() in low:
            return low[want.lower()]
    for n in names:
        if "sent" in n.lower():
            return n
    m.create(imap_quote("Sent"))
    return "Sent"


def friendly_imap(e):
    if isinstance(e, imaplib.IMAP4.error):
        s = str(e).strip()
        if s[:2] in ("b'", 'b"'):
            s = s[2:-1]
        if "AUTHENTICATIONFAILED" in s.upper() or "LOGIN" in s.upper():
            return "The Sent-folder server rejected the login: " + s
        return "The Sent-folder server said: " + s
    if isinstance(e, socket.gaierror):
        return "Couldn't find the Sent-folder server. Check its name."
    if isinstance(e, (TimeoutError, socket.timeout)):
        return "Timed out reaching the Sent-folder server. Port 993 may be blocked on this network."
    if isinstance(e, ConnectionRefusedError):
        return "The Sent-folder server refused the connection on that port."
    if isinstance(e, ssl.SSLError):
        return f"Secure connection to the Sent-folder server failed ({e.reason or e})."
    return str(e) or e.__class__.__name__


class SentCopies:
    """Puts a copy of each sent email in the Sent folder. A failure here never stops or repeats a send."""

    def __init__(self, acc):
        self.acc, self.m, self.fails, self.off = acc, None, 0, ""
        self.folder = (SETTINGS.get("copies") or {}).get("sent_folder") or ""

    def save(self, msg):
        if self.off:
            return self.off
        last = ""
        for _ in range(2):
            try:
                if self.m is None:
                    self.m = imap_connect(self.acc)
                    if not self.folder:
                        self.folder = find_sent_folder(self.m)
                data = msg.as_bytes(policy=msg.policy.clone(linesep="\r\n"))
                typ, resp = self.m.append(imap_quote(self.folder), "(\\Seen)", imaplib.Time2Internaldate(time.time()), data)
                if typ != "OK":
                    raise imaplib.IMAP4.error(" ".join(r.decode(errors="replace") for r in resp if isinstance(r, bytes)) or typ)
                self.fails = 0
                return ""
            except Exception as e:
                last = friendly_imap(e)
                self.close()
                self.folder = ""          # look the folder up again on the retry
        self.fails += 1
        if self.fails >= 3:
            self.off = "Stopped saving copies after 3 failures in a row. " + last
        return last

    def close(self):
        if self.m:
            try:
                self.m.logout()
            except Exception:
                pass
        self.m = None


# ---------------------------------------------------------------- sent log and the hourly allowance
LOG_HEADER = ["time", "csv_file", "row", "to", "subject", "status", "error"]


def append_log(rec, list_name):
    new = not LOG_FILE.exists()
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(LOG_HEADER)
        w.writerow([rec["time"], list_name, rec["row"], rec["to"], rec["subject"], rec["status"], rec["error"]])


def read_log():
    if not LOG_FILE.exists():
        return []
    with open(LOG_FILE, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def seed_sent_times():
    cutoff = time.time() - 3600
    for r in read_log():
        if r.get("status") not in ("sent", "test"):
            continue
        try:
            t = datetime.strptime(r["time"], "%Y-%m-%d %H:%M:%S").timestamp()
        except Exception:
            continue
        if t > cutoff:
            SENT_TIMES.append(t)


def prune_sent_times():
    cutoff = time.time() - 3600
    while SENT_TIMES and SENT_TIMES[0] <= cutoff:
        SENT_TIMES.popleft()


def allowance():
    prune_sent_times()
    per_hour = int(SETTINGS["pace"].get("per_hour") or 0)
    return {"per_hour": per_hour, "sent_last_hour": len(SENT_TIMES), "times": list(SENT_TIMES),
            "now": time.time()}


# ---------------------------------------------------------------- the sending job (persisted, resumable)
def save_job():
    job = state["job"]
    if job:
        write_json(JOB_FILE, {k: v for k, v in job.items() if k not in ("_stop", "_resume")})


def public_job():
    job = state["job"]
    if not job:
        return None
    out = {k: v for k, v in job.items() if not k.startswith("_") and k != "indices"}
    out["remaining"] = job["indices"][job["pos"]:]
    return out


def wait_until(job, until, reason):
    job.update(state="waiting", resume_at=until, wait_reason=reason)
    job["waits"] = job.get("waits", 0) + 1
    job["_resume"] = False
    save_job()
    while time.time() < until and not job["_stop"] and not job["_resume"]:
        time.sleep(0.5)
    job.update(state="running", resume_at=None, wait_reason="")
    save_job()
    return not job["_stop"]


def run_job(job):
    acc = account_with_password()
    meta = state["lists"].get(job["list_id"])
    if not acc or not meta:
        job.update(state="paused", error="Connect your mail account to resume sending.")
        save_job()
        return
    server, since_connect = None, 0
    rejects_in_a_row, last_reject = 0, None
    files = stored_files()
    copier = SentCopies(acc) if (SETTINGS.get("copies") or {}).get("save_sent") and acc.get("provider") != "gmail" else None

    def record(rec):
        # the result and the step forward are saved together, so a restart never repeats this row
        job["inflight"] = None
        job["pos"] += 1
        job["results"].append(rec)
        job["done"] = len(job["results"])
        append_log(rec, meta["filename"])
        meta["status"][str(rec["index"])] = {"status": rec["status"], "time": rec["time"], "error": rec["error"]}
        save_meta(meta)
        save_job()

    while job["pos"] < len(job["indices"]) and not job["_stop"]:
        idx = job["indices"][job["pos"]]
        job["current"] = idx

        per_hour = int(job.get("per_hour") or 0)
        if per_hour:
            prune_sent_times()
            if len(SENT_TIMES) >= per_hour:
                close_quietly(server)
                server = None
                if not wait_until(job, SENT_TIMES[0] + 3601, f"Reached your limit of {per_hour} emails an hour."):
                    break
                continue

        rec = {"index": idx, "row": idx + 1, "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "to": "", "subject": "", "status": "", "error": ""}
        try:
            info, msg = render(meta, idx, build=True, files=files)
            rec["to"], rec["subject"] = ", ".join(info["to"]), info["subject"]
        except Exception as e:
            info, msg = {"errors": [friendly(e)]}, None
        if info["errors"]:
            rec["status"], rec["error"] = "failed", " ".join(info["errors"])
            job["failed"] += 1
            record(rec)
            continue
        if idx not in set(meta.get("again") or []):
            hit = emailed_before(meta["id"], idx, info["to"])     # e.g. the same address twice in one list
            if hit:
                job["skipped"] = job.get("skipped", 0) + 1
                job["inflight"] = None
                job["pos"] += 1
                job["results"].append({"index": idx, "row": idx + 1, "time": rec["time"], "to": rec["to"],
                                       "subject": rec["subject"], "status": "skipped",
                                       "error": f"Already emailed {hit.get('time', '')}"})
                job["done"] = len(job["results"])
                save_job()
                continue

        job["inflight"] = idx          # if the app dies now, we must not send this one twice
        save_job()
        try:
            if server is None or since_connect >= 40:
                close_quietly(server)
                server, since_connect = connect(acc), 0
            try:
                server.send_message(msg)
            except (smtplib.SMTPServerDisconnected, ConnectionError):
                close_quietly(server)
                time.sleep(3)
                server, since_connect = connect(acc), 0
                server.send_message(msg)
        except Exception as e:
            kind = classify(e)
            if kind == "reject":
                rejects_in_a_row += 1
            if kind in ("throttle", "other") or rejects_in_a_row >= 2:
                job["throttle_hits"] = job.get("throttle_hits", 0) + 1
                if rejects_in_a_row >= 2 and last_reject:
                    pos, prev = last_reject
                    if prev in job["results"]:
                        job["results"].remove(prev)
                        job["failed"] -= 1
                        job["done"] = len(job["results"])
                        meta["status"].pop(str(prev["index"]), None)
                        save_meta(meta)
                    job["pos"] = pos
                rejects_in_a_row, last_reject = 0, None
                close_quietly(server)
                server = None
                if job["throttle_hits"] > len(COOLDOWNS_MIN):
                    job["error"] = ("The mail server is still refusing after waiting about 2 hours, so sending has stopped. "
                                    "You have most likely hit a daily limit. The emails not sent yet are kept; "
                                    "press Resume later (for example tomorrow). Last reply: " + friendly(e))
                    job["state"] = "paused"
                    save_job()
                    log_run(job)
                    if copier:
                        copier.close()
                    return
                mins = COOLDOWNS_MIN[job["throttle_hits"] - 1]
                if not wait_until(job, time.time() + mins * 60,
                                  f"The server started refusing, probably a sending limit. Trying again in {mins:g} min. "
                                  f"It said: {friendly(e)}"):
                    break
                continue
            rec["status"], rec["error"] = "failed", friendly(e)
            job["failed"] += 1
            pos_before = job["pos"]
            record(rec)
            if kind == "reject":
                last_reject = (pos_before, rec)
            continue

        rec["status"] = "sent"
        job["sent"] += 1
        SENT_TIMES.append(time.time())
        record(rec)
        try:
            remember_sent(meta, idx, info, rec["time"])
            save_snapshot(meta, idx, info, rec["time"])
        except Exception:
            pass
        if copier:                     # after the send is recorded, so a crash here can't cause a resend
            err = copier.save(msg)
            rec["copy"] = "failed" if err else "saved"
            st = meta["status"].setdefault(str(idx), {})
            st["copy"] = rec["copy"]
            if err:
                rec["copy_error"] = st["copy_error"] = job["copy_error"] = err
            save_meta(meta)
            save_job()
        since_connect += 1
        rejects_in_a_row, last_reject = 0, None
        job["throttle_hits"] = 0
        if job["pos"] < len(job["indices"]):
            job["next_at"] = time.time() + job["delay"]
            end = job["next_at"]
            while time.time() < end and not job["_stop"]:
                time.sleep(0.2)
            job["next_at"] = None

    close_quietly(server)
    if copier:
        copier.close()
    job["current"] = None
    if job["state"] not in ("paused",):
        job["state"] = "stopped" if job["_stop"] else "done"
    log_run(job)
    save_job()


def log_run(job):
    """One history entry per run of a send (a resumed send gets its own)."""
    meta, r = state["lists"].get(job.get("list_id")), job.get("run")
    job["run"] = None
    if not meta or not r:
        return
    d = {k: job.get(k, 0) - r.get(k, 0) for k in ("sent", "failed", "skipped", "waits")}
    if not (d["sent"] or d["failed"] or d["skipped"]):
        return
    outcome = {"done": "finished", "stopped": "stopped by you"}.get(job["state"], "stopped: " + (job.get("error") or "")[:200])
    add_event(meta, "send", start=r.get("start"), outcome=outcome, **d)
    save_meta(meta)


def start_job_thread(job):
    job["_stop"], job["_resume"] = False, False
    job["state"] = "running"
    job["error"] = ""
    job["run"] = {"start": now_str(), **{k: job.get(k, 0) for k in ("sent", "failed", "skipped", "waits")}}
    state["job"] = job
    save_job()
    threading.Thread(target=run_job, args=(job,), daemon=True).start()


def restore_job():
    """After a restart (or a server reboot), carry on with an unfinished send."""
    saved = read_json(JOB_FILE, None)
    if not saved:
        return
    saved.setdefault("results", [])
    inflight = saved.get("inflight")
    if inflight is not None and saved.get("pos", 0) < len(saved.get("indices", [])) and saved["indices"][saved["pos"]] == inflight:
        meta = state["lists"].get(saved.get("list_id"))
        rec = {"index": inflight, "row": inflight + 1, "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "to": "",
               "subject": "", "status": "unsure",
               "error": "The app stopped while this email was being sent, so it may or may not have gone out. "
                        "Check your Sent folder before sending it again."}
        if meta:
            try:
                info, _ = render(meta, inflight)
                rec["to"], rec["subject"] = ", ".join(info["to"]), info["subject"]
            except Exception:
                pass
            meta["status"][str(inflight)] = {"status": "unsure", "time": rec["time"], "error": rec["error"]}
            save_meta(meta)
            append_log(rec, meta["filename"])
        saved["results"].append(rec)
        saved["done"] = len(saved["results"])
        saved["pos"] += 1
    saved["inflight"] = None
    if saved.get("state") in ("running", "waiting") and saved.get("pos", 0) < len(saved.get("indices", [])):
        saved.update(resume_at=None, wait_reason="", next_at=None)
        if account_with_password() and saved.get("list_id") in state["lists"]:
            start_job_thread(saved)
            return
        saved.update(state="paused", error="The app restarted. Connect your mail account to resume sending.")
    state["job"] = saved
    save_job()


# ---------------------------------------------------------------- login (on a server)
LOGIN_HTML = """<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>IITD Mailer: sign in · Ayush Vishwakarma</title><meta name="author" content="Ayush Vishwakarma">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/static/app.css"></head><body class="login-body">
<form class="login" method="post" action="/login"><div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 8v16h22V8l-11 9z"/></svg></span>
<div><b>IITD Mailer</b><span>This mailer is private</span></div></div>
<h1>Sign in</h1><label>App password<input name="password" type="password" autofocus autocomplete="current-password"></label>
{error}<button class="btn primary" type="submit">Sign in</button><p class="credit">Made by <b>Ayush Vishwakarma</b></p></form>
<script>try{{const t=localStorage.getItem('iitdmailer:theme');if(t)document.documentElement.dataset.theme=t}}catch(e){{}}</script>
</body></html>"""


@app.before_request
def guard():
    if not LOGIN_PASSWORD:
        return None
    if request.path in ("/login",) or request.path.startswith("/static/"):
        return None
    if session.get("ok"):
        return None
    if request.path.startswith("/api/"):
        return jsonify(error="Please sign in again."), 401
    return redirect("/login")


@app.route("/login", methods=["GET", "POST"])
def login():
    if not LOGIN_PASSWORD:
        return redirect("/")
    error = ""
    if request.method == "POST":
        if secrets.compare_digest(request.form.get("password", ""), LOGIN_PASSWORD):
            session.permanent = True
            session["ok"] = True
            return redirect("/")
        time.sleep(1.5)
        error = '<p class="msg bad">That password is not right.</p>'
    return LOGIN_HTML.format(error=error)


@app.post("/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return render_template("index.html")


def current_list_payload(lid):
    meta = state["lists"].get(lid)
    if not meta:
        return None
    rows = list_rows(lid)
    return dict(meta, rows=rows, message=message_of(meta))


@app.get("/api/bootstrap")
def bootstrap():
    cur = SETTINGS.get("current")
    if cur not in state["lists"]:
        cur = next(iter(sorted(state["lists"].values(), key=lambda m: m["created"], reverse=True)), {}).get("id")
    return jsonify(mode="server" if SERVER_MODE else "local", login=bool(LOGIN_PASSWORD),
                   account=public_account(), pace=SETTINGS["pace"], test_to=SETTINGS.get("test_to", ""),
                   lists=[list_summary(m) for m in sorted(state["lists"].values(), key=lambda m: m["created"], reverse=True)],
                   current=current_list_payload(cur), files=files_payload(), copies=SETTINGS["copies"],
                   templates=SETTINGS["templates"],
                   job=public_job(), allowance=allowance(), data_dir=str(DATA))


@app.get("/api/status")
def status():
    return jsonify(job=public_job(), allowance=allowance(), account=public_account(), lists=all_summaries())


@app.post("/api/account")
def set_account():
    d = request.get_json(force=True)
    prov = d.get("provider", "iitd")
    defaults = PROVIDERS.get(prov, {})
    username = (d.get("username") or "").strip()
    from_email = (d.get("from_email") or "").strip()
    if not from_email:
        from_email = username if "@" in username else (f"{username}@iitd.ac.in" if prov == "iitd" else "")
    password = d.get("password") or ""
    old = SETTINGS.get("account")
    if not password and old and old["username"] == username:
        password = state["password"] or saved_password()
    acc = {
        "provider": prov,
        "host": (d.get("host") or defaults.get("host", "")).strip(),
        "port": int(d.get("port") or defaults.get("port", 465)),
        "username": username, "from_email": from_email,
        "from_name": (d.get("from_name") or "").strip(), "reply_to": (d.get("reply_to") or "").strip(),
    }
    if not acc["host"]:
        return jsonify(error="Enter the mail server."), 400
    if not username:
        return jsonify(error="Enter your username."), 400
    if not EMAIL_RE.match(from_email):
        return jsonify(error="Enter a valid From address."), 400
    if not password:
        return jsonify(error="Enter your password."), 400
    try:
        s = connect(dict(acc, password=password))
        s.quit()
    except Exception as e:
        return jsonify(error=friendly(e)), 400
    SETTINGS["account"] = acc
    state["password"] = password
    if d.get("remember"):
        write_json(SECRET_FILE, {"smtp_password": password}, private=True)
    elif SECRET_FILE.exists() and d.get("remember") is False:
        SECRET_FILE.unlink()
    if not SETTINGS.get("test_to"):
        SETTINGS["test_to"] = from_email
    save_settings()
    job = state["job"]
    if job and job.get("state") == "paused" and "Connect your mail account" in (job.get("error") or ""):
        job["error"] = ""
        save_job()
    return jsonify(ok=True, account=public_account())


@app.post("/api/account/forget")
def forget_password():
    state["password"] = ""
    if SECRET_FILE.exists():
        SECRET_FILE.unlink()
    return jsonify(account=public_account())


@app.post("/api/settings")
def set_settings():
    d = request.get_json(force=True)
    if "pace" in d:
        p = d["pace"]
        SETTINGS["pace"] = {"delay": max(0.0, float(p.get("delay", 5) or 0)),
                            "per_hour": max(0, int(float(p.get("per_hour", 0) or 0)))}
    if "test_to" in d:
        t = (d.get("test_to") or "").strip()
        if t and not EMAIL_RE.match(t):
            return jsonify(error="Enter a valid address for test emails."), 400
        SETTINGS["test_to"] = t
    if "copies" in d:
        c = d["copies"] or {}
        new = {"bcc_self": bool(c.get("bcc_self")), "bcc_to": (c.get("bcc_to") or "").strip(),
               "save_sent": bool(c.get("save_sent")), "imap_host": (c.get("imap_host") or "").strip(),
               "imap_port": int(float(c.get("imap_port") or 993)), "sent_folder": ""}
        if new["bcc_to"] and not EMAIL_RE.match(new["bcc_to"]):
            return jsonify(error="Enter a valid address for the BCC copy."), 400
        if new["save_sent"]:
            acc = account_with_password()
            if not acc:
                return jsonify(error="Connect your mail account first, so the app can log in to your Sent folder."), 400
            if acc.get("provider") == "gmail":
                return jsonify(error="Gmail already keeps a copy in Sent, so this isn't needed."), 400
            old = SETTINGS.get("copies")
            SETTINGS["copies"] = new
            try:
                m = imap_connect(acc)
                new["sent_folder"] = find_sent_folder(m)
                m.logout()
            except Exception as e:
                SETTINGS["copies"] = old
                return jsonify(error=friendly_imap(e)), 400
        SETTINGS["copies"] = new
    save_settings()
    return jsonify(pace=SETTINGS["pace"], test_to=SETTINGS.get("test_to", ""), copies=SETTINGS["copies"])


# ----- saved messages (templates), shared by all lists
@app.get("/api/templates")
def get_templates():
    return jsonify(templates=SETTINGS["templates"])


@app.post("/api/templates")
def save_template():
    d = request.get_json(force=True)
    name = str(d.get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="Give the template a name."), 400
    t = {"name": name, "subject": str(d.get("subject") or "")[:500], "body": str(d.get("body") or "")[:50000],
         "saved": now_str()}
    old = next((x for x in SETTINGS["templates"] if x["name"].lower() == name.lower()), None)
    if old:
        old.update(t)
    else:
        SETTINGS["templates"].append(dict(t, id=uuid.uuid4().hex[:8]))
    save_settings()
    return jsonify(templates=SETTINGS["templates"])


@app.delete("/api/templates/<tid>")
def delete_template(tid):
    SETTINGS["templates"] = [x for x in SETTINGS["templates"] if x.get("id") != tid]
    save_settings()
    return jsonify(templates=SETTINGS["templates"])


# ----- lists
@app.post("/api/lists")
def upload_list():
    f = request.files.get("file")
    if not f:
        return jsonify(error="No file received."), 400
    raw = f.read()
    try:
        columns, rows = parse_csv(raw)
    except Exception as e:
        return jsonify(error=f"Couldn't read that CSV: {e}."), 400
    lid = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    (LISTS_DIR / lid).mkdir(parents=True)
    (LISTS_DIR / lid / "source.csv").write_bytes(raw)
    name = re.sub(r"[_\-]+", " ", Path(f.filename or "list.csv").stem).strip() or "Untitled list"
    meta = {"id": lid, "name": name[:1].upper() + name[1:], "filename": Path(f.filename or "list.csv").name,
            "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "columns": columns, "count": len(rows),
            "mapping": guess_mapping(columns), "opts": {"format": "auto", "unescape": True}, "status": {}, "again": [],
            "message": default_message(columns, guess_mapping(columns)),
            "history": [{"kind": "created", "time": now_str(), "file": Path(f.filename or "list.csv").name, "rows": len(rows)}]}
    save_meta(meta)
    state["lists"][lid] = meta
    state["rows"][lid] = rows
    SETTINGS["current"] = lid
    save_settings()
    return jsonify(list=current_list_payload(lid), lists=[list_summary(m) for m in sorted(state["lists"].values(), key=lambda m: m["created"], reverse=True)])


@app.get("/api/lists/<lid>")
def open_list(lid):
    if lid not in state["lists"]:
        return jsonify(error="That list no longer exists."), 404
    SETTINGS["current"] = lid
    save_settings()
    return jsonify(list=current_list_payload(lid))


@app.post("/api/lists/<lid>/config")
def config_list(lid):
    meta = state["lists"].get(lid)
    if not meta:
        return jsonify(error="That list no longer exists."), 404
    d = request.get_json(force=True)
    if "mapping" in d:
        meta["mapping"] = {k: v for k, v in d["mapping"].items() if k in FIELDS and v in meta["columns"]}
    if "opts" in d:
        o = d["opts"]
        meta["opts"] = {"format": o.get("format", "auto") if o.get("format") in ("auto", "text", "html") else "auto",
                        "unescape": bool(o.get("unescape", True)),
                        "attach": [Path(str(a)).name for a in (o.get("attach") or []) if str(a).strip()][:20]}
    if "message" in d:
        m, old = d["message"] or {}, message_of(meta)
        meta["message"] = {
            "mode": "template" if m.get("mode", old["mode"]) == "template" else "csv",
            "subject": str(m.get("subject", old["subject"]))[:500],
            "body": str(m.get("body", old["body"]))[:50000],
            "name_col": m.get("name_col", old.get("name_col")) if m.get("name_col", old.get("name_col")) in meta["columns"] else None,
            "fallback": m.get("fallback", old.get("fallback")) if m.get("fallback", old.get("fallback")) in NAME_FALLBACKS else "Dr.",
        }
    if "name" in d and str(d["name"]).strip():
        new = str(d["name"]).strip()[:80]
        if new != meta["name"]:
            add_event(meta, "renamed", old=meta["name"], new=new)
        meta["name"] = new
    if "archived" in d:
        a = bool(d["archived"])
        if a != bool(meta.get("archived")):
            add_event(meta, "archived" if a else "unarchived")
        meta["archived"] = a
    save_meta(meta)
    return jsonify(ok=True, name=meta["name"], lists=all_summaries())


@app.post("/api/lists/<lid>/again")
def set_again(lid):
    meta = state["lists"].get(lid)
    d = request.get_json(force=True)
    i = int(d.get("index", -1))
    if not meta or not 0 <= i < meta["count"]:
        return jsonify(error="No such row."), 404
    s = set(meta.get("again") or [])
    (s.add if d.get("on") else s.discard)(i)
    meta["again"] = sorted(s)
    save_meta(meta)
    return jsonify(again=meta["again"])


@app.post("/api/lists/<lid>/rows/<int:i>")
def edit_row(lid, i):
    meta = state["lists"].get(lid)
    if not meta or not 0 <= i < meta["count"]:
        return jsonify(error="No such row."), 404
    if list_busy(lid):
        return jsonify(error="Stop the send from this list before editing it."), 400
    if (meta["status"].get(str(i)) or {}).get("status") == "sent":
        return jsonify(error="This row was already sent, so it can't be changed."), 400
    vals = dict((request.get_json(force=True) or {}).get("values") or {})
    rows = list_rows(lid)
    row = rows[i]
    if "__to__" in vals:                    # "the address", whichever column holds it
        v = vals.pop("__to__")
        tocol = (meta.get("mapping") or {}).get("to")
        if not tocol:                       # the CSV has no address column yet: add one
            tocol, n = "Email", 2
            while tocol in meta["columns"]:
                tocol, n = f"Email ({n})", n + 1
            meta["columns"].append(tocol)
            meta.setdefault("mapping", {})["to"] = tocol
            for r in rows:
                r.setdefault(tocol, "")
        vals[tocol] = v
    if "__greeting__" in vals:              # fix one greeting: kept in a "Greeting name" column
        v = vals.pop("__greeting__")
        own = {norm(c): c for c in meta["columns"]}
        gcol = next((own[norm(k)] for k in GREETING_COLS if norm(k) in own), None)
        if not gcol:
            gcol = "Greeting name"
            meta["columns"].append(gcol)
            for r in rows:
                r.setdefault(gcol, "")
        vals[gcol] = v
    changed = [c for c in meta["columns"] if c in vals and str(vals[c]).strip() != row.get(c, "")]
    for c in changed:
        row[c] = str(vals[c]).strip()
    if changed:
        write_rows(meta, rows)
        add_event(meta, "edited", row=i + 1, cols=changed)
        save_meta(meta)
    return jsonify(row=row, changed=changed, columns=meta["columns"], mapping=meta.get("mapping") or {})


@app.post("/api/lists/<lid>/replace")
def replace_preview(lid):
    meta = state["lists"].get(lid)
    f = request.files.get("file")
    if not meta or not f:
        return jsonify(error="Choose a CSV file."), 400
    if list_busy(lid):
        return jsonify(error="Stop the send from this list before replacing its file."), 400
    raw = f.read()
    try:
        cols, rows = parse_csv(raw)
    except Exception as e:
        return jsonify(error=f"Couldn't read that CSV: {e}."), 400
    name = Path(f.filename or "list.csv").name
    (LISTS_DIR / lid / "pending.csv").write_bytes(raw)
    write_json(LISTS_DIR / lid / "pending.json", {"filename": name})
    _, _, summary = plan_replace(meta, cols, rows)
    summary["file"] = name
    return jsonify(summary=summary)


@app.post("/api/lists/<lid>/replace/confirm")
def replace_confirm(lid):
    meta = state["lists"].get(lid)
    d = LISTS_DIR / lid
    pend = d / "pending.csv"
    if not meta or not pend.exists():
        return jsonify(error="Choose the new file again."), 400
    if list_busy(lid):
        return jsonify(error="Stop the send from this list before replacing its file."), 400
    raw = pend.read_bytes()
    cols, rows = parse_csv(raw)
    mapping, match, summary = plan_replace(meta, cols, rows)
    old_name = "old-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".csv"
    shutil.copy(d / "source.csv", d / old_name)
    old_status, old_again = meta["status"], set(meta.get("again") or [])
    meta["status"] = {str(j): old_status[str(o)] for j, o in match.items() if str(o) in old_status}
    meta["again"] = sorted(j for j, o in match.items() if o in old_again)
    sd = d / "sent"
    if sd.exists():                    # keep each "what was sent" copy with its row's new number
        nd = d / "sent.new"
        shutil.rmtree(nd, ignore_errors=True)
        nd.mkdir()
        for j, o in match.items():
            if (sd / f"{o}.json").exists():
                shutil.copy(sd / f"{o}.json", nd / f"{j}.json")
        shutil.rmtree(sd, ignore_errors=True)
        nd.rename(sd)
    back = {o: j for j, o in match.items()}
    for ents in CONTACTS.values():
        for e in ents:
            if e.get("list_id") == lid and e.get("row") is not None:
                e["row"] = back.get(e["row"])
    write_json(CONTACTS_FILE, CONTACTS)
    filename = read_json(d / "pending.json", {}).get("filename") or meta["filename"]
    (d / "source.csv").write_bytes(raw)
    pend.unlink()
    if (d / "pending.json").exists():
        (d / "pending.json").unlink()
    meta.update(columns=cols, count=len(rows), mapping=mapping, filename=filename)
    msg = message_of(meta)
    if msg.get("name_col") not in cols:
        meta["message"] = dict(msg, name_col=guess_name_col(cols))
    state["rows"][lid] = rows
    add_event(meta, "replaced", file=filename, old_file=old_name,
              **{k: summary[k] for k in ("sent_kept", "unsent_updated", "new", "removed_unsent", "removed_sent")})
    save_meta(meta)
    return jsonify(list=current_list_payload(lid), lists=all_summaries())


@app.get("/api/lists/<lid>/export.csv")
def export_list(lid):
    meta = state["lists"].get(lid)
    if not meta:
        return jsonify(error="That list no longer exists."), 404
    rows, bf, files, again = list_rows(lid), befores(meta), stored_files(), set(meta.get("again") or [])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(meta["columns"] + ["Status", "Sent at", "Copy in Sent", "Note"])
    for i, r in enumerate(rows):
        st = meta["status"].get(str(i)) or {}
        s, note = st.get("status"), ""
        if s == "sent":
            label = "Sent"
        elif s == "unsure":
            label, note = "Check inbox", st.get("error", "")
        else:
            info, _ = render(meta, i, files=files)
            b = bf.get(i)
            if info["errors"]:
                label, note = "Needs fixing", " ".join(info["errors"])
            elif b and i not in again:
                label, note = (("Duplicate", f"Same address as row {b['row'] + 1}") if b["kind"] == "dup"
                               else ("Emailed before", f"{b.get('time', '')}, from {b.get('list_name', '')}"))
            elif s == "failed":
                label, note = "Failed", st.get("error", "")
            else:
                label = "Not sent"
        when = st.get("time", "") if s in ("sent", "unsure", "failed") else ""
        w.writerow([r.get(c, "") for c in meta["columns"]] + [label, when, {"saved": "Yes", "failed": "No"}.get(st.get("copy"), ""), note])
    name = re.sub(r"[^\w\- ]+", "", meta["name"]).strip() or "list"
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name} with status.csv"'})


@app.get("/api/lists/<lid>/file/<name>")
def list_file(lid, name):
    p = LISTS_DIR / lid / name
    if lid not in state["lists"] or not re.fullmatch(r"old-\d{8}-\d{6}\.csv", name) or not p.exists():
        return jsonify(error="That file is gone."), 404
    return Response(p.read_bytes(), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.delete("/api/lists/<lid>")
def delete_list(lid):
    job = state["job"]
    if job and job["list_id"] == lid and job["state"] in ("running", "waiting"):
        return jsonify(error="Stop the send from this list first."), 400
    if lid in state["lists"]:
        shutil.rmtree(LISTS_DIR / lid, ignore_errors=True)
        state["lists"].pop(lid, None)
        state["rows"].pop(lid, None)
    return jsonify(ok=True)


@app.get("/api/lists/<lid>/check")
def check_list(lid):
    meta = state["lists"].get(lid)
    if not meta:
        return jsonify(error="That list no longer exists."), 404
    files = stored_files()
    bf, again = befores(meta), set(meta.get("again") or [])
    out = []
    for i in range(meta["count"]):
        info, _ = render(meta, i, files=files)
        out.append({"to": info["to_raw"], "subject": info["subject"], "errors": info["errors"], "warnings": info["warnings"],
                    "attachments": info["attachments"], "before": bf.get(i), "again": i in again})
    return jsonify(rows=out, status=meta["status"])


@app.get("/api/lists/<lid>/preview/<int:i>")
def preview(lid, i):
    meta = state["lists"].get(lid)
    if not meta or not 0 <= i < meta["count"]:
        return jsonify(error="No such row."), 404
    st = meta["status"].get(str(i)) or {}
    snap = LISTS_DIR / lid / "sent" / f"{i}.json"
    if st.get("status") == "sent" and snap.exists():     # show what actually went out, not today's CSV
        info = dict(read_json(snap, {}), index=i, errors=[], warnings=[], missing_attachments=[], attach_all=[],
                    bcc_self="", snapshot=True)
        info.setdefault("cc", []); info.setdefault("bcc", []); info.setdefault("attachments", [])
    else:
        info, _ = render(meta, i)
        info["before"] = befores(meta).get(i)
    info["again"] = i in (meta.get("again") or [])
    return jsonify(info)


@app.post("/api/lists/<lid>/test")
def send_test(lid):
    meta = state["lists"].get(lid)
    acc = account_with_password()
    if not acc:
        return jsonify(error="Connect your mail account first (Account)."), 400
    d = request.get_json(force=True)
    to = (d.get("to") or SETTINGS.get("test_to") or acc["from_email"]).strip()
    if not EMAIL_RE.match(to):
        return jsonify(error="Set a valid address for test emails in Account."), 400
    i = int(d.get("index", 0))
    try:
        info, msg = render(meta, i, build=True, test_to=to)
        if info["missing_attachments"]:
            raise ValueError("Attachment not found: " + ", ".join(info["missing_attachments"]))
        s = connect(acc)
        s.send_message(msg)
        s.quit()
    except Exception as e:
        return jsonify(error=friendly(e)), 400
    SENT_TIMES.append(time.time())
    append_log({"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "row": i + 1, "to": to,
                "subject": "[TEST] " + info["subject"], "status": "test", "error": ""}, meta["filename"])
    add_event(meta, "test", row=i + 1, to=to)
    save_meta(meta)
    return jsonify(ok=True, to=to, allowance=allowance())


# ----- sending
@app.post("/api/send")
def start_send():
    d = request.get_json(force=True)
    lid = d.get("list_id")
    meta = state["lists"].get(lid)
    if not meta:
        return jsonify(error="Open a list first."), 400
    if not account_with_password():
        return jsonify(error="Connect your mail account first (Account)."), 400
    job = state["job"]
    if job and job["state"] in ("running", "waiting"):
        return jsonify(error="A send is already running."), 400
    indices = sorted({int(i) for i in d.get("indices", []) if 0 <= int(i) < meta["count"]})
    if not indices:
        return jsonify(error="No rows selected."), 400
    pace = SETTINGS["pace"]
    job = {"id": uuid.uuid4().hex[:8], "list_id": lid, "list_name": meta["name"], "state": "running",
           "indices": indices, "pos": 0, "total": len(indices), "done": 0, "sent": 0, "failed": 0,
           "current": None, "results": [], "error": "", "resume_at": None, "wait_reason": "", "next_at": None,
           "delay": float(pace["delay"]), "per_hour": int(pace["per_hour"]), "throttle_hits": 0,
           "started": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    start_job_thread(job)
    return jsonify(job=public_job())


@app.post("/api/job/<action>")
def job_action(action):
    job = state["job"]
    if not job:
        return jsonify(error="Nothing is sending."), 400
    if action == "stop":
        job["_stop"] = True
        if job["state"] == "paused":
            job["state"] = "stopped"
            save_job()
    elif action == "retry":
        job["_resume"] = True
    elif action == "resume":
        if job["state"] in ("running", "waiting"):
            return jsonify(job=public_job())
        if not account_with_password():
            return jsonify(error="Connect your mail account first (Account)."), 400
        job["throttle_hits"] = 0
        start_job_thread(job)
    elif action == "dismiss":
        if job["state"] in ("running", "waiting"):
            return jsonify(error="It is still sending."), 400
        state["job"] = None
        if JOB_FILE.exists():
            JOB_FILE.unlink()
    return jsonify(job=public_job())


# ----- attachments
def files_payload():
    out = []
    for p in sorted(stored_files().values(), key=lambda p: p.name.lower()):
        out.append({"name": p.name, "size": p.stat().st_size, "where": "app"})
    if ATT_DIR.exists():
        for p in sorted(ATT_DIR.iterdir(), key=lambda p: p.name.lower()):
            if p.is_file() and not p.name.startswith("."):
                out.append({"name": p.name, "size": p.stat().st_size, "where": "folder"})
    return out


@app.post("/api/files")
def upload_files():
    for f in request.files.getlist("files"):
        name = Path(f.filename or "").name
        if name and not name.startswith("."):
            f.save(FILES_DIR / name)
    return jsonify(files=files_payload())


@app.delete("/api/files/<name>")
def delete_file(name):
    p = FILES_DIR / Path(name).name
    if p.is_file():
        p.unlink()
    return jsonify(files=files_payload())


# ----- the log
@app.get("/api/log")
def get_log():
    rows = read_log()
    rows.reverse()
    return jsonify(rows=rows[:500], total=len(rows),
                   sent=sum(1 for r in rows if r.get("status") == "sent"),
                   failed=sum(1 for r in rows if r.get("status") in ("failed", "unsure")),
                   tests=sum(1 for r in rows if r.get("status") == "test"))


@app.get("/api/log.csv")
def download_log():
    data = LOG_FILE.read_bytes() if LOG_FILE.exists() else (",".join(LOG_HEADER) + "\n").encode()
    return Response(data, mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=sent_log.csv"})


# ---------------------------------------------------------------- start
load_lists()
CONTACTS.update(load_contacts())
seed_sent_times()
restore_job()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    host = os.environ.get("MAILER_HOST", "127.0.0.1")
    if SERVER_MODE and not LOGIN_PASSWORD:
        sys.exit("Server mode needs a login: set MAILER_LOGIN_PASSWORD (see DEPLOY.md).")
    if host not in ("127.0.0.1", "localhost") and not LOGIN_PASSWORD:
        sys.exit("Refusing to listen on the network without MAILER_LOGIN_PASSWORD.")
    url = f"http://127.0.0.1:{port}"
    if SERVER_MODE:
        print(f"IITD Mailer by Ayush Vishwakarma (server mode) on {host}:{port}, data in {DATA}")
        try:
            from waitress import serve
            serve(app, host=host, port=port, threads=8)
        except ImportError:
            app.run(host=host, port=port, threaded=True)
    else:
        print(f"\n  IITD Mailer by Ayush Vishwakarma is running at {url}\n  Keep this window open while sending. Press Ctrl+C to quit.\n")
        if not os.environ.get("NO_BROWSER"):
            threading.Timer(1.2, lambda: webbrowser.open(url)).start()
        app.run(host=host, port=port, debug=False, threaded=True)
