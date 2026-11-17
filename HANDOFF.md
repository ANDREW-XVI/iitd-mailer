# IITD Mailer: handout

Everything needed to run, deploy or change this app, written so a new chat (or
a person) can pick it up without the conversation it was built in. Give this
file, plus the files you want changed, to a new chat.

Last updated: 17 Nov 2026 (added §0 "Where things stand", the phone-commands doc, open ideas). 15 Nov 2026: terminal monitor over SSH: monitor.py / ./mon; run_mac_linux.sh keeps the Mac awake. Earlier the same day: one message for everyone, {Greeting name}, saved templates, row filters, clearer "no address" rows). Before that, 28 Oct 2026: attach-to-every-email, BCC me, copies in Sent, address memory, rename/archive, edit row, replace CSV, history.

---

## 0. Where things stand

- **Runs locally** from the project folder (`sh run_mac_linux.sh`). The server deploy (§2, DEPLOY.md) is
  written and tested with stubs, but has not been tried on a real VM.
- **Your own data is not in this repository.** `data/` (settings, saved password, lists, uploaded files),
  `sent_log.csv` and personal test lists are created on your machine and are ignored by git
  (see `.gitignore`). Never commit them: they hold a mail password and people's addresses.
- **Terminal monitor**: `./mon` / `monitor.py` (§4.10).
- **Ideas discussed, not built**:
  - *Fix missing addresses*: "Export rows to fix" (rows with no/bad address to CSV) and "Update from CSV"
    (upload the fixed file, match rows, fill the To column, show what changed before saving).
    `/rows/<i>` with `__to__` and `plan_replace()` are the pieces to build on.
  - Sending through IITD webmail (Roundcube) with a hidden browser: advised against.
  - Running from GitHub Actions: advised against (terms, no persistent state).

---

## 1. What it is

A small web app that sends **personalised emails from a CSV** (one row = one
email) through the owner's **IIT Delhi** mail account (or Gmail). It shows every
email before sending, holds back rows with problems, keeps to an **hourly sending
limit**, and pauses and retries by itself when the mail server refuses.

It runs in two ways:

| Mode | Where | How it's started | Who can open it |
| --- | --- | --- | --- |
| **Local** | Owner's MacBook (`~/Claude/iitd-mailer`) | `sh run_mac_linux.sh` | Only that computer (127.0.0.1:8765) |
| **Server** | Oracle Cloud Always Free Ubuntu VM | `systemd` service, set up by `deploy/setup.sh` | Anyone with the https address **and** the app password |

Stack: Python 3 + Flask (served by waitress on the server), plain HTML, CSS and
JavaScript (no framework, no build step), Caddy for HTTPS on the server.

---

## 2. Set it up

### On the Mac (local)

1. Python 3.8 or newer (`python3 --version`).
2. `cd ~/Claude/iitd-mailer && sh run_mac_linux.sh`
   (installs `flask` and `waitress`, then runs `python3 app.py`).
3. The browser opens http://127.0.0.1:8765. Keep the terminal open while sending.
4. **Account**: IIT Delhi, Kerberos ID (e.g. `ab1234567`) + password,
   server `smtp.iitd.ac.in`, port **465** (try 587 or 25 if it fails).
   **Connect and test**. Optionally tick *Remember the password*.
5. **New list from CSV**, check the rows, **Send test to me**, then **Send**.

Windows: double-click `run_windows.bat`.

### On the free server (keeps sending with the laptop off)

Full steps are in **`DEPLOY.md`**. In short:

1. Oracle Cloud account, home region **Mumbai or Hyderabad** (can't change later).
2. Create an instance: Ubuntu 24.04, shape `VM.Standard.A1.Flex` (1 OCPU, 6 GB)
   or `VM.Standard.E2.1.Micro`, public IPv4 on, **save the private SSH key**.
3. In the subnet's Security List add ingress TCP **80** and **443** from `0.0.0.0/0`.
4. From the Mac:
   `sh deploy/push_to_server.sh ubuntu@<PUBLIC IP> ~/Downloads/ssh-key-XXXX.key`
5. It prints the address (`https://<ip-with-dashes>.sslip.io`) and the **app
   password, shown once**. Step 6 of its output says whether the server can
   reach `smtp.iitd.ac.in` and on which port.
6. Sign in, open **Account**, connect, **tick Remember the password on this
   server** (needed to resume after a reboot), then send.

Update the server later: run the same command as step 4. Data is kept.

---

## 3. Files

```
iitd-mailer/
├── app.py                 backend: Flask app, CSV parsing, email building, SMTP, send queue, API
├── templates/index.html   page shell (sidebar, top bar, <main id="view">); loads static/app.js
├── static/app.js          all front-end logic (state, routing, rendering, polling)
├── static/app.css         all styles; dark + light themes as CSS custom properties
├── static/fonts/          Inter 400/500/600/700 (woff2) + OFL licence
├── requirements.txt       flask>=2.2, waitress>=2.1
├── run_mac_linux.sh       installs requirements, runs app.py (under `caffeinate -i` on a Mac, so it doesn't sleep)
├── monitor.py             terminal monitor/controller (stdlib only), see §4.10
├── mon                    shortcut: `./mon [status|log N|stop|resume|retry|start]`
├── run_windows.bat        same for Windows
├── deploy/setup.sh        server install/update (Ubuntu): venv, systemd, Caddy, firewall, checks
├── deploy/push_to_server.sh   run on the Mac: rsync to server + run setup.sh
├── deploy/check_smtp.py   tests whether a host's SMTP ports 465/587/25 are reachable
├── DEPLOY.md              step-by-step Oracle guide for the owner
├── README.md              overview and quick start
├── HANDOFF.md             this file
├── attachments/           optional: drop attachment files here (fee-notice.txt is a sample)
├── sample.csv, test_15_mails.csv, test_batch_B_10_mails.csv   example lists
├── sent_log.csv           created on first send (local mode)
└── data/                  created on first run (local mode), see §4.2
```

---

## 4. How it works

### 4.1 Flow

1. **Account**: `POST /api/account` logs in to SMTP once to check the password,
   then saves the account (without password) to `data/settings.json`. The
   password is kept in memory; if *Remember* is ticked it's also written to
   `data/secret.json` (chmod 600). Env `MAILER_SMTP_PASSWORD` overrides both.
2. **List**: uploading a CSV (`POST /api/lists`) saves the raw file as
   `data/lists/<id>/source.csv` and a `meta.json` (columns, guessed column
   mapping, options, per-row send status). The newest/last-opened list is the
   current one.
3. **Check**: `GET /api/lists/<id>/check` builds every email (without sending)
   and returns per-row `errors` (block sending) and `warnings` (shown only).
4. **Preview**: `GET /api/lists/<id>/preview/<i>` returns the full built email.
5. **Send**: `POST /api/send` creates a **job** (the queue) and starts a
   background thread (`run_job`). The browser polls `GET /api/status` every
   1 s while sending, every 15 s otherwise. The job survives restarts.

### 4.2 Data on disk

Local mode: `./data/` and `./sent_log.csv`. Server: `/var/lib/iitd-mailer/`
(both, via `MAILER_DATA` and `MAILER_LOG`).

| File | Contents |
| --- | --- |
| `settings.json` | `account` {provider, host, port, username, from_email, from_name, reply_to}, `pace` {delay, per_hour}, `test_to`, `current` (list id), `copies` {bcc_self, bcc_to, save_sent, imap_host, imap_port, sent_folder}, `templates` [{id, name, subject, body, saved}] (saved messages, shared by all lists) |
| `secret.json` | `{"smtp_password": "..."}`, only if Remember is ticked; mode 600 |
| `secret_key` | Flask session key (random, generated once) |
| `contacts.json` | everyone emailed, by lower-cased address: up to 5 `{time, list_id, list_name, row, subject}` each. Rebuilt from `sent_log.csv` if missing; kept when a list is deleted. Test emails don't count |
| `lists/<id>/sent/<row>.json` | what actually went out for that row (headers, body, attachment names), shown in the preview of sent rows |
| `lists/<id>/old-<stamp>.csv` | the previous file, saved when the CSV is replaced |
| `lists/<id>/source.csv` | the uploaded CSV, byte for byte |
| `lists/<id>/meta.json` | `id, name, filename, created, columns, count, mapping{to,subject,body,cc,bcc,reply_to,attachments → column}, opts{format: auto/text/html, unescape: bool, attach: [file names sent with every email]}, status{"<row index>": {status: sent/failed/unsure, time, error, copy: saved/failed, copy_error}}, again[] (rows to send even though emailed before), archived, message {mode: template/csv, subject, body, name_col, fallback: "Dr."/"Professor"/"name"} (missing on old lists = csv mode), history[] ({kind: created/renamed/send/test/replaced/edited/archived/unarchived, time, …})` |
| `files/` | attachments uploaded in the app |
| `job.json` | the current/last job (see §4.4) |
| `sent_log.csv` | `time, csv_file, row, to, subject, status, error`; status is `sent`, `failed`, `test` or `unsure` |

List ids look like `20261027-182206-c8f0`. Row indices are 0-based in code,
shown 1-based ("row 4" = index 3).

### 4.3 Building one email (`render()` in app.py)

- **Column mapping** is guessed from names (`GUESSES`, `CONTAINS`): Email/To →
  to, Subject → subject, Body/Message/Mainbody → body, CC, BCC, Reply-to,
  Attachments. The user can change it ("Change columns").
- **Placeholders**: `{Column name}` or `{{Column name}}` in any field, matched
  ignoring case, spaces and punctuation (`{roll_no}` = `{Roll No}`). Unknown
  word-like placeholders give a warning and stay as written.
- **Body**: `\n` typed in a cell becomes a line break (option). Format is
  auto-detected as HTML if it contains common tags, or forced text/HTML. HTML
  emails get a plain-text alternative.
- **Addresses**: several per cell, separated by `,` `;` or spaces. Invalid ones
  are errors.
- **Attachments**: names separated by `;` `,` `|` or newlines; looked up in
  `data/files/`, then `attachments/`, then as a full path. Missing file = error.
  Files can also be attached to **every email in a list** (`opts.attach`, picked
  with "Attach files" on the list's strip, `openAttach()` in app.js); they are
  added to each row's own files, without duplicates. Over 15 MB in total = warning.
  The preview always shows an "Attached" line, `/check` returns each row's
  `attachments`, and the Send confirmation lists which files go with how many emails.
- **One message for everyone** (`meta.message.mode == "template"`): subject and body come from
  `meta.message` (typed in the Message panel) instead of columns; placeholders are filled per row as
  usual. New lists start in this mode when the CSV has no Subject+Body columns; "From CSV columns" is
  the old behaviour. `message_of(meta)` supplies the default for older lists (csv).
- **Name placeholders** (`with_names()`, `name_parts()`): `{Greeting name}`, `{First name}`,
  `{Last name}`, `{Title}`, from the column in `message.name_col` (guessed: a column with "name" that
  isn't lab/group/university…). Title comes from the name ("Prof.", "Dr.") or else from any cell that
  starts with a role ("Professor; …" → Professor; "Dr; …", "Assistant/Associate Professor", "Reader",
  "Lecturer" → Dr.); if none, `message.fallback`. Surname = last word, plus particles (Mac, van, de, di,
  Li…); middle initials ignored. Warnings (row shows "Check"): title unclear; three or more names where
  the surname may be double ("Anna Maria Rossi"), unless the given names are short ("Bao Hua Xu").
  A CSV column named Greeting name / Greeting / Salutation wins when non-empty; empty cells fall back
  to the computed greeting. The preview's Greeting box saves via `/rows/<i>` with key `__greeting__`,
  creating a "Greeting name" column. An empty greeting is an **error** (never sends "Dear ,").
  On a real 440-row list: 256 Dr., 184 Professor, 1 unclear, 25 surnames to check.
- **No address text**: a To cell with no "@" ("Not listed publicly - see URL") is "No email address in
  this row (it says …)", not a bad address; `info.no_address_note` and `info.links` (URLs in the row)
  feed the preview's "Open their page" link.
- **Errors** (row never sent): no To column chosen, no/invalid address, invalid
  CC/BCC, attachment not found, empty greeting. **Warnings**: empty subject/body, unknown
  placeholder, greeting to check.
- Test emails go to `test_to` (default the From address), subject prefixed
  `[TEST] `, no CC/BCC, and count toward the hourly limit.

### 4.4 The send queue (`run_job()` in app.py)

Job fields: `id, list_id, list_name, state, indices[], pos, total, done, sent,
failed, current, results[], error, resume_at, wait_reason, next_at, delay,
per_hour, throttle_hits, inflight, started`.
States: `running` → `waiting` (timed pause) → `running` … → `done` / `stopped`
/ `paused` (needs the user: password missing after restart, or gave up).

- **Pace**: `delay` seconds between emails; at most `per_hour` emails in any
  rolling 60 minutes, counted from `SENT_TIMES`, which is seeded from
  `sent_log.csv` at start-up, so it holds across lists and restarts. Default
  5 s and 20/hour.
- **Refusals**: `classify()` treats 4xx replies, replies mentioning
  rate/limit/quota/policy, connection errors, or two different rows refused in
  a row as **throttling** → wait `COOLDOWNS_MIN` = 15, 30, 60 minutes and retry
  the same row; after the third, state `paused` with an explanation. A single
  5xx refusal fails only that row.
- **Reconnects** every 40 emails and once on a dropped connection.
- **Crash safety**: before each send `inflight = row` is saved; each result is
  saved together with `pos += 1`. On restart (`restore_job()`), an in-flight row
  is marked `unsure` ("Check inbox") instead of being re-sent, and the job
  resumes by itself if a password is available, otherwise it waits as `paused`.
- **Copies** (Account → "Copies of what you send"):
  - *BCC me*: `render()` adds `copies.bcc_to` (default the From address) to BCC on real sends, not tests.
    It adds a recipient, which IITD may count toward its limit.
  - *Save a copy in Sent*: `SentCopies` in app.py logs in over IMAP (IITD: mailstore.iitd.ac.in:993,
    same Kerberos login) and APPENDs each sent email, flagged \Seen, to the folder found by
    `find_sent_folder()` (\Sent flag, else a usual name, else creates "Sent"). It runs **after**
    `record()`, so a crash there can't cause a resend; a failure only marks the row `copy: failed`,
    never stops sending; after 3 failures in a row it stops trying for that job (`job.copy_error`).
    Turning it on in Account logs in once to check, and saves the folder name. Off for Gmail
    (Gmail already saves SMTP sends in Sent).
- **Emailed before**: `befores(meta)` marks each unsent row whose To address is in `contacts.json`
  (`kind: sent`, from any list) or appears in an earlier row of the same list (`kind: dup`). Those rows
  are held back unless the row is in `meta.again` ("Send again anyway"). `run_job` checks again just
  before each send (so a duplicate later in the same job is skipped, `job.skipped`, status `skipped`
  in results only, nothing logged). After each send: `remember_sent()` + `save_snapshot()`.
- **History**: `add_event()`; one `send` event per run of a job (`log_run()`, deltas from `job.run`).
- **Replace CSV**: `plan_replace()` matches new rows to old by their sorted To addresses; statuses,
  `again`, snapshots and contact row numbers move with the match. Two steps: `/replace` (saves
  `pending.csv`, returns a summary) then `/replace/confirm`.
- Actions: `POST /api/job/stop | retry (skip the wait) | resume | dismiss`.

### 4.5 API

| Method + path | Does |
| --- | --- |
| `GET /api/bootstrap` | everything the page needs on load (mode, account, pace, lists, current list with rows, files, job, allowance) |
| `GET /api/status` | job + allowance + account (polled) |
| `POST /api/account` | connect/test and save account; body includes `password`, `remember` |
| `POST /api/account/forget` | delete saved password |
| `POST /api/settings` | `pace {delay, per_hour}`, `test_to`, `copies {...}` (logs in to IMAP when save_sent is on) |
| `POST /api/lists` (multipart `file`) | new list from CSV |
| `GET /api/lists/<id>` | open a list (makes it current) |
| `POST /api/lists/<id>/config` | `mapping`, `opts`, `name`, `archived`, `message` {mode, subject, body, name_col, fallback} |
| `GET/POST /api/templates`, `DELETE /api/templates/<id>` | saved messages; POST `{name, subject, body}` overwrites a template with the same name |
| `POST /api/lists/<id>/again` | `{index, on}` send to an emailed-before row anyway |
| `POST /api/lists/<id>/rows/<i>` | `{values: {column: text}}` edit an unsent row (rewrites source.csv). Key `__to__` = the address column, created as "Email" if the CSV has none. Used by the type-in address boxes in the Needs fixing tab (`saveTo()` in app.js) |
| `POST /api/lists/<id>/replace` (multipart), `POST …/replace/confirm` | replace the CSV, keeping progress |
| `GET /api/lists/<id>/export.csv` | the list with Status, Sent at, Copy in Sent, Note columns |
| `GET /api/lists/<id>/file/old-….csv` | a previous file of the list |
| `DELETE /api/lists/<id>` | delete a list (not while it's sending) |
| `GET /api/lists/<id>/check` | per-row errors/warnings + status |
| `GET /api/lists/<id>/preview/<i>` | one built email |
| `POST /api/lists/<id>/test` | send row `index` to the test address |
| `POST /api/send` | `{list_id, indices[]}` start a job |
| `POST /api/job/<action>` | stop, retry, resume, dismiss |
| `POST /api/files` (multipart `files`), `DELETE /api/files/<name>` | attachments |
| `GET /api/log`, `GET /api/log.csv` | sent log (latest 500 as JSON; full CSV) |
| `GET/POST /login`, `POST /logout` | only when `MAILER_LOGIN_PASSWORD` is set |

### 4.6 Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAILER_MODE` | (local) | `server` = needs a login password, uses waitress, trusts Caddy's proxy headers, no browser |
| `MAILER_LOGIN_PASSWORD` | none | app sign-in password; required in server mode or when not on 127.0.0.1 |
| `MAILER_DATA` | `./data` | data folder |
| `MAILER_LOG` | `./sent_log.csv` | log file |
| `MAILER_SMTP_PASSWORD` | none | mail password from the environment instead of `secret.json` |
| `MAILER_HOST`, `PORT` | `127.0.0.1`, `8765` | where the app listens |
| `MAILER_COOLDOWNS` | `15,30,60` | minutes to wait after refusals (tests use tiny values) |
| `MAILER_COOKIE_SECURE` | `1` in server mode | `0` only for testing sign-in over plain http |
| `NO_BROWSER` | unset | `1` = don't open a browser (local mode) |

### 4.7 Front end (`static/app.js`)

- One state object `S` (account, pace, lists, current `list` incl. `rows`,
  `checks`, `status`, `selected` Set, `filter`, `cur` row, `job`, `allowance`).
- Hash routes: `#/list/<id>` (main screen), `#/list/<id>/<row>` (opens that row), `#/history/<id>`, `#/log`, `#/files`, `#/account`.
  `route()` → `renderList` / `renderLog` / `renderFiles` / `renderAccount`.
- Main screen parts: `renderHead` (title + finding + Send), `renderStrip`
  (file + column mapping + "Change columns" editor), `renderMessage` (the Message panel: one-line
  summary, or the editor with Subject, Message, Insert buttons, Names, Templates; autosaves 700 ms after
  typing via `saveMessage()`), `renderFilters` (Filter button in the Recipients header: "Where <column>
  is <value>" rows, AND-ed, kept per list in localStorage `iitdmailer:filters:<id>`; only columns with
  2–40 distinct values; "Select the N ready to send" replaces the selection; tab counts follow the
  filters via `counts(true)`/`passes(i)`), `jobHTML` (progress /
  paused / finished bar), `allowanceHTML` (the hourly blocks), `renderTable`
  (tabs To send / Needs fixing / Sent / All, checkboxes), `preview` (the email;
  HTML in a sandboxed iframe).
- `rowState(i)` decides each row's label: Sending, Sent, Queued, a problem
  ("No address", "Bad address", "File missing", "No To column"), Failed,
  Check inbox (unsure), Check (warnings), Ready.
- `simulate(n)` estimates when the last of n emails goes out under the limits
  (used in the Send confirmation).
- `poll()` refreshes job and allowance; `refreshListParts()` redraws.
- Theme: `data-theme="dark|light"` on `<html>`, saved in localStorage
  (`iitdmailer:theme`); default dark.
- Phone/tablet (≤900px): sidebar becomes a menu; list and preview show one at a
  time with a Back button. ≤640px: table becomes two-line rows.

### 4.8 Design rules (keep these when editing the UI)

The look was chosen by the owner from three mockups: **"true-black flat"** from
the design-taste-frontend skill (app-screen rules), with a light theme.

- Dark: ground `#000`, panels `#111`, nested `#1d1d1d`; text `#fff`, greys
  `#b4b4b4` / `#949494`. Light, "Paper" (chosen 28 Oct 2026): warm ground `#f3f1ec`,
  white panels with a 1px `#e2ded5` border, ink `#1a1814`, greys `#57534b` / `#6f6a62`,
  amber `#b86a00`. All colours are tokens in `:root` / `[data-theme]` in app.css;
  every text pair passes 4.5:1.
- Logo "Envelope M" (chosen 28 Oct 2026): an envelope outline whose flap is an M,
  `<path d="M5 8v16h22V8l-11 9z"/>` on a 32 grid, stroked in `--logo` (amber `#ffb347`
  on dark, `#b86a00` on light). App icon / favicon: `static/favicon.svg` (amber mark on a
  `#161616` tile). Used in `templates/index.html` and the login page in app.py.
- **Amber (`--accent`) is for data only**: sent blocks, progress bar, sent dot,
  the logo mark. The primary button is inverted (white on dark, near-black on
  light). One primary per screen.
- Elevation by lightness, **no shadows** except the dialog and toast; no
  gradients, glass, glows, emoji, icons in tinted squares; no uppercase tracked
  labels; one typeface (Inter, bundled); figures use tabular numbers.
- Pills are pale tints with dark text of the same hue (ok/bad/warn/neutral).
- Radii: panels 18px, inner 10px, controls fully round.
- Grid: sidebar 232px + canvas with 32px gutters; every block spans the same
  two edges; list and preview share a bottom edge.
- Words of the trade, sentence case, plain English ("2 need fixing (row 4: no
  address)").
- Checked with the skill's `inspect.mjs --app` and `lint.mjs --app`: 0 FAIL on
  the list, account and first-run screens (one accepted WARN: empty space below
  the one-time first-run screen).

### 4.9 Server layout (from `deploy/setup.sh`)

- App `/opt/iitd-mailer` (owned by root, venv inside), data `/var/lib/iitd-mailer`
  (user `mailer`, mode 700), password file `/etc/iitd-mailer.env` (600).
- Service `iitd-mailer.service` (runs as `mailer`, `Restart=always`, hardened:
  `ProtectSystem=strict`, only the data dir writable). Logs:
  `sudo journalctl -u iitd-mailer -n 100`.
- Caddy reverse-proxies `https://<domain>` → `127.0.0.1:8765` with automatic
  HTTPS. Default domain `<ip with dashes>.sslip.io`; `DOMAIN=...` to override.
- Opens 80/443 in the VM's iptables (Oracle images block them) and saves them.
- Re-running setup.sh is safe: keeps data and the app password; a
  `sent_log.csv` copied from the Mac is imported once.

### 4.10 Terminal monitor (`monitor.py`, `./mon`)

For watching and controlling a send from a terminal, mainly over SSH from the owner's iPhone into
the Mac, alongside the browser UI (it doesn't replace it). Standard library only, Python 3.6+.

- Talks to the running app: `GET /api/status` (job, allowance, account) and
  `POST /api/job/<stop|resume|retry>`. Default `http://127.0.0.1:8765`; `--url` / `MAILER_URL`
  for another one. If the app answers 401 (server mode) it signs in with `MAILER_LOGIN_PASSWORD` or
  asks for it, posting to `/login` without following the redirect and reusing the `session=` cookie.
- If the app doesn't answer, it reads `data/job.json`, `data/settings.json` and `sent_log.csv`
  directly and says the app isn't running (a running/waiting job "carries on when the app starts
  again"). Respects `MAILER_DATA` / `MAILER_LOG`.
- `live` (default): redraws every 2 s with ANSI codes; keys read in cbreak mode with `select`
  (s twice within 5 s = stop, r resume, t try now/skip the pause, l log, q quit); restores the
  terminal and cursor on exit. `status` prints one snapshot; `log [N]` the last N log lines;
  `start` launches `app.py` detached (`start_new_session`, output to `app-background.log`, under
  `caffeinate -i` on macOS) and waits until `/api/status` answers.
- Layout fits phone terminals (tested at 46 columns): state line (● Sending / ⏸ Paused / ■ Stopped /
  ✓ Finished), "x of y sent · failed · skipped · left", progress bar, next email or pause-until with
  the reason, hourly allowance bar, last 6 results (✓ sent, ✗ failed + reason, – skipped as
  already emailed, ? unsure). Result statuses it knows: sent, failed, skipped, unsure, test.
- Tested: snapshots while sending, at the hourly limit, stopped, finished and with the app down;
  every key through a pseudo-terminal; `start`; sign-in against server mode (wrong password refused).

---

## 5. Testing changes

A fake SMTP server that accepts any login (needs `pip install aiosmtpd`):

```python
# fake_smtp.py  ->  python3 fake_smtp.py   (listens on 127.0.0.1:1029, saves mails as out*.eml)
import time
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult
class H:
    n = 0
    async def handle_DATA(self, server, session, env):
        H.n += 1; open(f"out{H.n}.eml", "wb").write(env.original_content); return "250 OK"
Controller(H(), hostname="127.0.0.1", port=1029,
           authenticator=lambda *a: AuthResult(success=True), auth_require_tls=False).start()
while True: time.sleep(1)
```

Run a throwaway copy of the app against it, so real data is untouched:

```sh
MAILER_DATA=/tmp/mtest MAILER_LOG=/tmp/mtest.csv NO_BROWSER=1 PORT=8770 python3 app.py
# Account: provider Other, host 127.0.0.1, port 1029, any username/password
```

What was verified on 15 Nov 2026 (message panel), with a real 440-row
pipe-separated CSV against the fake server:
- Upload → starts in "Same for everyone" with the editor open; message autosaves; preview fills
  "Dear Dr. Bao"; all 440 emails build with no empty greeting and no leftover `{…}`.
- Greeting fix on a double surname; afterwards every other row still gets its computed greeting
  (a bug where the new empty column blanked them, "Dear ,", was found in the sent .eml files and fixed).
- Filters Fit Tier = A + Email Status = Verified → 31 rows → Send 31; test + real sends; hourly cap
  paused at 20; template saved; CSV-column lists unchanged; 1440/768/390 px, dark and light.

Earlier checks (in a Linux sandbox):
- Full UI flow with Playwright: connect, upload, problem rows held back, test
  send, send 8, sent log, attachments, light theme, 768px and 390px layouts.
- Killing the app mid-send and restarting: each of 10 emails delivered exactly
  once; an in-flight row becomes "Check inbox".
- Server refusing after 3 emails: waits, then sends the rest; hourly cap waits
  with the right reason; sign-in required in server mode.
- `deploy/setup.sh` run end to end with system commands stubbed (it is **not**
  yet run on a real Oracle VM).

---

## 6. Facts and history worth knowing

- The owner's IIT Delhi account started refusing recipients after **about 28
  emails in a short time** ("Server refused recipient(s)"), while webmail still
  worked. That's why the hourly limit and pause-and-retry exist. The real IITD
  limit is unknown; 20/hour is a guess.
- IIT Delhi's CSC page says SMTP works over TLS: STARTTLS on 25 or SSL/TLS on
  465. CSC's web-mail page confirms `smtp.iitd.ac.in` on 465 (IMAP: mailstore.iitd.ac.in:993).
  IITD webmail (webmail.iitd.ac.in) is Roundcube; sending through it with a
  hidden browser was discussed and not built (fragile, may break policy).
- Hosting options checked (Oct 2026): Render free blocks SMTP ports 25/465/587;
  PythonAnywhere free allows only Gmail's SMTP; Fly.io has no free tier; Koyeb
  and Cloud Run sleep. Oracle Always Free was chosen. Oracle may **reclaim idle
  Always Free instances** (<20% CPU p95, network, and A1 memory over 7 days).
- Unknown until tried: whether `smtp.iitd.ac.in` accepts connections and logins
  from an Oracle cloud IP. `deploy/check_smtp.py` tests reachability.
- The Kerberos password is shared with Moodle/Wi-Fi; storing it on a server is a
  conscious trade-off. Gmail with an App Password is the safer fallback.
- The owner sends from an IITD account, tests to their own Gmail, and
  prefers being shown design options before a redesign.

---

## 7. Common changes, and where to make them

| Change | Where |
| --- | --- |
| Default hourly limit or gap | `DEFAULT_PACE` in app.py (existing installs keep their saved value; change it in Account) |
| Wait times after refusals | `COOLDOWNS_MIN` / env `MAILER_COOLDOWNS` |
| Which words count as "limit" replies | `LIMIT_WORDS` in app.py |
| New column-name guesses | `GUESSES` / `CONTAINS` in app.py |
| A new per-row check | `render()` in app.py → append to `errors` (blocks) or `warnings`; add a short label to `ERR_SHORT` in app.js |
| Change the message for a list | the Message panel (`renderMessage()` in app.js, `meta.message` in app.py) |
| How greetings are worked out | `name_parts()` / `ROLE_RE` / `PARTICLES` in app.py |
| A new field (e.g. a fixed signature) | add to `render()`; if per list, store in `meta["opts"]` via `/config`; add a control in `renderStrip()` |
| Scheduling a send for later | new `start_at` on the job: `run_job` waits with `wait_until(job, start_at, ...)`; add a time field to `confirmSend()` |
| Colours / theme | tokens at the top of app.css (both themes) |
| Text on screens | the `render*` functions in app.js |
| A new screen | add a nav link in index.html, a route in `route()`, a `render<Name>()` |
| Server domain | `DOMAIN=mail.example.com sudo -E bash deploy/setup.sh` on the server |

After any change: test locally against the fake server (§5); for the server,
re-run `deploy/push_to_server.sh`.

---

## 8. Starting a new chat

Starting prompt that works best when the new chat can reach the Mac's `~/Claude` folder:

> Read ~/Claude/iitd-mailer/HANDOFF.md first, then the files it names for my change. I want to:
> <your change>. Back up the files you change into a `backup-before-<change>` folder, keep the design
> rules (§4.8) and crash-safety rules (§4.4), test against the fake SMTP server (§5) with a
> throwaway copy of data, and update HANDOFF.md (and the phone-commands doc if commands change).

Otherwise, attach or share the `iitd-mailer` folder (or the files you want changed) and
this file, then say something like:

> Read HANDOFF.md first. It describes my IITD Mailer app (Flask + vanilla JS,
> deployed on Oracle Always Free). I want to: <your change>. Keep the design
> rules in §4.8 and the crash-safety rules in §4.4, test against the fake SMTP
> server in §5, and tell me which files changed.

If the new chat can reach your Mac's `~/Claude` folder, it can edit the files in
place; then run `sh deploy/push_to_server.sh ...` to update the server.
