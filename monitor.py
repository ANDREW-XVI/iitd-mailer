#!/usr/bin/env python3
"""
IITD Mailer: terminal monitor. Watch and control sending from any terminal,
for example over SSH from your phone. The browser app keeps running as usual;
this only talks to it (or reads its files if it isn't running).

    python3 monitor.py            live view, refreshes every 2 s (keys below)
    python3 monitor.py status     one snapshot, then exit
    python3 monitor.py log [N]    the last N sends from sent_log.csv (default 15)
    python3 monitor.py stop       stop sending (unsent emails stay queued)
    python3 monitor.py resume     resume a stopped or paused send
    python3 monitor.py retry      skip a pause and try again now
    python3 monitor.py start      start the app in the background (keeps the Mac awake while it runs)

Live view keys:  s stop   r resume   t try now   l log   q quit

Options: --url http://host:port (default http://127.0.0.1:8765), --no-color.
On a server with a sign-in password, set MAILER_LOGIN_PASSWORD or you'll be asked for it.
Only uses Python's standard library.
"""
import csv
import getpass
import json
import os
import select
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MAILER_DATA", HERE / "data"))
LOG_FILE = Path(os.environ.get("MAILER_LOG", HERE / "sent_log.csv"))
REFRESH = 10.0

# ---------------------------------------------------------------- look
COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR") and "--no-color" not in sys.argv
def c(code, s):
    return f"\033[{code}m{s}\033[0m" if COLOR else s
bold = lambda s: c("1", s)
dim = lambda s: c("2", s)
amber = lambda s: c("38;5;214", s)
green = lambda s: c("32", s)
red = lambda s: c("31", s)
yellow = lambda s: c("33", s)


def width():
    return max(36, min(shutil.get_terminal_size((60, 24)).columns, 90))


def bar(frac, n, fill=amber):
    k = max(0, min(n, round(frac * n)))
    return fill("█" * k) + dim("░" * (n - k))


def clock(epoch):
    return datetime.fromtimestamp(epoch).strftime("%H:%M:%S") if epoch else "—"


def ago_or_in(epoch):
    d = int(epoch - time.time())
    s = abs(d)
    txt = f"{s}s" if s < 60 else f"{s // 60}m {s % 60:02d}s" if s < 3600 else f"{s // 3600}h {s % 3600 // 60:02d}m"
    return f"in {txt}" if d >= 0 else f"{txt} ago"


def cut(s, n):
    s = str(s or "")
    return s if len(s) <= n else s[: max(0, n - 1)] + "…"


def wrap(s, w, indent="  "):
    return textwrap.wrap(str(s or ""), width=w - len(indent), initial_indent=indent, subsequent_indent=indent) or [indent]


# ---------------------------------------------------------------- talking to the app
class App:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.cookie = None

    def _open(self, path, data=None, method=None):
        headers = {"Content-Type": "application/json"} if data is not None else {}
        if self.cookie:
            headers["Cookie"] = self.cookie
        req = urllib.request.Request(self.url + path, json.dumps(data).encode() if data is not None else None, headers, method=method)
        return urllib.request.urlopen(req, timeout=5)

    def login(self):
        pw = os.environ.get("MAILER_LOGIN_PASSWORD") or (getpass.getpass("App password: ") if sys.stdin.isatty() else "")
        if not pw:
            raise SystemExit("This app needs its sign-in password: set MAILER_LOGIN_PASSWORD.")

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        body = urllib.parse.urlencode({"password": pw}).encode()
        try:
            r = opener.open(urllib.request.Request(self.url + "/login", body), timeout=10)
        except urllib.error.HTTPError as e:
            r = e
        cookie = r.headers.get("Set-Cookie", "")
        if "session=" not in cookie or r.headers.get("Location", "").endswith("/login"):
            raise SystemExit("Sign-in failed: that password is not right.")
        self.cookie = cookie.split(";", 1)[0]

    def get(self, path):
        try:
            return json.load(self._open(path))
        except urllib.error.HTTPError as e:
            if e.code == 401 and not self.cookie:
                self.login()
                return json.load(self._open(path))
            raise

    def post(self, path, data=None):
        try:
            return json.load(self._open(path, data or {}))
        except urllib.error.HTTPError as e:
            if e.code == 401 and not self.cookie:
                self.login()
                return json.load(self._open(path, data or {}))
            try:
                msg = json.load(e).get("error")
            except Exception:
                msg = None
            raise SystemExit(msg or f"The app said {e.code}.")


def read_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return None


def read_log(n):
    if not LOG_FILE.exists():
        return []
    with open(LOG_FILE, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return rows[-n:]


def sent_last_hour_from_log():
    cutoff, out = time.time() - 3600, []
    for r in read_log(400):
        if r.get("status") not in ("sent", "test"):
            continue
        try:
            t = datetime.strptime(r["time"], "%Y-%m-%d %H:%M:%S").timestamp()
        except Exception:
            continue
        if t > cutoff:
            out.append(t)
    return out


def snapshot(app):
    """Everything the screen needs. Falls back to the files when the app isn't answering."""
    try:
        s = app.get("/api/status")
        return {"up": True, "job": s.get("job"), "allow": s.get("allowance") or {}, "account": s.get("account") or {}}
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        job = read_json(DATA / "job.json")
        if job:
            job["remaining"] = job.get("indices", [])[job.get("pos", 0):]
        settings = read_json(DATA / "settings.json") or {}
        times = sent_last_hour_from_log()
        return {"up": False, "job": job, "account": settings.get("account") or {},
                "allow": {"per_hour": (settings.get("pace") or {}).get("per_hour", 0), "sent_last_hour": len(times),
                          "times": times, "now": time.time()}}


# ---------------------------------------------------------------- the screen
def render(snap, note=""):
    w = width()
    lines = []
    now = datetime.now().strftime("%H:%M:%S")
    acc = snap["account"].get("from_email") or "no account"
    head = f"{bold('IITD Mailer')}  {dim(now)}"
    lines += [head, dim(cut(acc, w)), dim("─" * w)]

    if not snap["up"]:
        lines.append(red("● The app isn't running on this computer."))
        lines += [dim(l) for l in wrap("Nothing is being sent. Start it with: python3 monitor.py start (or open it on the Mac as usual).", w)]
        lines.append("")

    j = snap["job"]
    if not j:
        lines.append(dim("Nothing is sending. Start a send in the app."))
    else:
        st = j.get("state")
        name = cut(j.get("list_name") or "", w - 14)
        total, done, sent, failed = j.get("total", 0), j.get("done", 0), j.get("sent", 0), j.get("failed", 0)
        left = len(j.get("remaining") or []) if j.get("remaining") is not None else total - done
        if st == "running" and snap["up"]:
            lines.append(green("● Sending  ") + bold(name))
        elif st in ("running", "waiting") and not snap["up"]:
            lines.append(yellow("● Was sending when the app stopped  ") + bold(name))
        elif st == "waiting":
            lines.append(yellow("⏸ Paused  ") + bold(name))
        elif st == "paused":
            lines.append(red("■ Stopped  ") + bold(name))
        elif st == "stopped":
            lines.append(dim("■ Stopped by you  ") + bold(name))
        else:
            lines.append(green("✓ Finished  ") + bold(name))
        skipped = sum(1 for r in (j.get("results") or []) if r.get("status") == "skipped")
        nums = f"{sent} of {total} sent"
        nums += f" · {red(str(failed) + ' failed')}" if failed else ""
        nums += f" · {skipped} skipped" if skipped else ""
        nums += f" · {left} left"
        lines.append("  " + nums)
        frac = (done / total) if total else 0
        lines.append("  " + bar(frac, max(10, w - 9)) + f" {round(frac * 100):>3}%")
        if st == "running" and snap["up"]:
            if j.get("next_at"):
                lines.append(f"  Next email {clock(j['next_at'])} ({ago_or_in(j['next_at'])})")
            else:
                lines.append("  Sending now…")
        if st in ("running", "waiting") and not snap["up"]:
            lines += [dim(l) for l in wrap("It carries on by itself when the app starts again (if the mail password is remembered).", w)]
        if st == "waiting" and j.get("resume_at") and snap["up"]:
            lines.append(f"  Until {bold(clock(j['resume_at']))} ({ago_or_in(j['resume_at'])})")
            lines += [dim(l) for l in wrap(j.get("wait_reason"), w)]
        if st in ("paused",) and j.get("error"):
            lines += [red(l) for l in wrap(j.get("error"), w)]
            lines.append(dim("  Press r to resume (or: python3 monitor.py resume)."))
        if j.get("started"):
            lines.append(dim(f"  Started {j['started'][5:16]}" + (f" · {j.get('delay', 0):g}s apart" if j.get("delay") else "")))

    a = snap["allow"]
    per, used = int(a.get("per_hour") or 0), int(a.get("sent_last_hour") or 0)
    lines.append("")
    if per:
        times = sorted(a.get("times") or [])
        frees = (times[0] + 3600) if times else None
        lines.append(bold("Hourly allowance") + f"  {used} / {per}")
        lines.append("  " + bar(used / per if per else 0, max(10, min(per, w - 4)) if per <= w - 4 else w - 4))
        tail = f"{max(0, per - used)} left" + (f" · oldest drops off {clock(frees)[:5]}" if frees else "")
        lines.append(dim("  " + tail) if used < per else yellow("  Limit reached · next slot " + clock(frees)[:5]))
    else:
        lines.append(bold("Sent in the last hour") + f"  {used}" + dim("  (no hourly limit set)"))

    lines.append("")
    lines.append(bold("Recent"))
    recent = (j or {}).get("results") or []
    recent = recent[-6:] if recent else [
        {"time": r["time"], "row": r["row"], "to": r["to"], "status": r["status"], "error": r.get("error", "")} for r in read_log(6)]
    if not recent:
        lines.append(dim("  Nothing sent yet."))
    for r in reversed(recent):
        mark = {"sent": green("✓"), "failed": red("✗"), "unsure": yellow("?"), "test": dim("t"), "skipped": dim("–")}.get(r.get("status"), "·")
        t = (r.get("time") or "")[11:16]
        row = f"{r.get('row', '')}"
        tag = " " + dim("already emailed") if r.get("status") == "skipped" else ""
        lines.append(f"  {dim(t)} {mark} {dim('#' + row):<5} {cut(r.get('to') or '—', w - 16 - (16 if tag else 0))}{tag}")
        if r.get("status") in ("failed", "unsure") and r.get("error"):
            lines += [red(l) for l in wrap(cut(r["error"], 160), w, "      ")]

    lines.append(dim("─" * w))
    if note:
        lines += [yellow(l) for l in wrap(note, w, "")]
    lines.append(dim("s stop · r resume · t try now · l log · q quit"))
    return "\n".join(lines)


def print_log(n):
    rows = read_log(n)
    if not rows:
        print("Nothing in the sent log yet.")
        return
    w = width()
    for r in rows:
        mark = {"sent": green("✓"), "failed": red("✗"), "unsure": yellow("?"), "test": dim("t"), "skipped": dim("–")}.get(r.get("status"), "·")
        print(f"{dim(r['time'][5:16])} {mark} {dim('#' + str(r.get('row', ''))):<5} {cut(r.get('to') or '—', w - 22)}")
        if r.get("status") in ("failed", "unsure") and r.get("error"):
            for l in wrap(cut(r["error"], 200), w, "      "):
                print(red(l))
    sent = sum(1 for r in read_log(100000) if r.get("status") == "sent")
    print(dim(f"{sent} sent in total. Full log: {LOG_FILE}"))


# ---------------------------------------------------------------- actions
def act(app, action):
    try:
        j = app.post(f"/api/job/{action}")
    except (urllib.error.URLError, ConnectionError, OSError):
        raise SystemExit("The app isn't running, so there's nothing to control. Start it: python3 monitor.py start")
    st = (j.get("job") or {}).get("state")
    return {"stop": "Stopping. Unsent emails stay queued; resume any time.", "resume": "Resumed.",
            "retry": "Trying again now."}.get(action, "Done.") + (f" (state: {st})" if st else "")


def start_app(app):
    try:
        app.get("/api/status")
        print("The app is already running.")
        return
    except Exception:
        pass
    log = HERE / "app-background.log"
    cmd = [sys.executable, str(HERE / "app.py")]
    if sys.platform == "darwin" and shutil.which("caffeinate"):
        cmd = ["caffeinate", "-i"] + cmd          # keep the Mac awake while the app runs
    env = dict(os.environ, NO_BROWSER="1")
    with open(log, "ab") as f:
        subprocess.Popen(cmd, cwd=str(HERE), env=env, stdout=f, stderr=f, stdin=subprocess.DEVNULL,
                         start_new_session=True)
    for _ in range(30):
        time.sleep(0.5)
        try:
            app.get("/api/status")
            print("Started. It keeps running after you disconnect" + (" and keeps the Mac awake." if cmd[0] == "caffeinate" else "."))
            print(dim(f"Its output goes to {log.name}. Open {app.url} on the Mac as usual."))
            return
        except Exception:
            continue
    raise SystemExit(f"It didn't start. See {log}.")


# ---------------------------------------------------------------- live view
def live(app):
    interactive = sys.stdin.isatty()
    old = None
    if interactive:
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        tty.setcbreak(fd)
    note, confirm_stop = "", 0.0
    sys.stdout.write("\033[?25l")                      # hide the cursor
    try:
        while True:
            snap = snapshot(app)
            sys.stdout.write("\033[H\033[2J" + render(snap, note) + "\n")
            sys.stdout.flush()
            note = ""
            key = ""
            if interactive:
                r, _, _ = select.select([sys.stdin], [], [], REFRESH)
                if r:
                    key = os.read(sys.stdin.fileno(), 8).decode(errors="ignore")[:1].lower()
            else:
                time.sleep(REFRESH)
            if key in ("q", "\x03", "\x1b"):
                break
            try:
                if key == "s":
                    if time.time() - confirm_stop < 5:
                        note, confirm_stop = act(app, "stop"), 0.0
                    else:
                        note, confirm_stop = "Press s again within 5 seconds to stop sending.", time.time()
                elif key == "r":
                    note = act(app, "resume")
                elif key == "t":
                    note = act(app, "retry")
                elif key == "l":
                    sys.stdout.write("\033[H\033[2J")
                    print_log(max(5, shutil.get_terminal_size((60, 24)).lines - 4))
                    print(dim("Press any key to go back."))
                    sys.stdout.flush()
                    if interactive:
                        select.select([sys.stdin], [], [])
                        os.read(sys.stdin.fileno(), 8)
            except SystemExit as e:
                note = str(e)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\033[?25h\n")
        if old is not None:
            import termios
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)


def main():
    args = [a for a in sys.argv[1:] if a != "--no-color"]
    url = os.environ.get("MAILER_URL", f"http://127.0.0.1:{os.environ.get('PORT', 8765)}")
    if "--url" in args:
        i = args.index("--url")
        url = args[i + 1]
        del args[i:i + 2]
    app = App(url)
    cmd = args[0] if args else "live"
    if cmd in ("-h", "--help", "help"):
        print(__doc__.strip())
    elif cmd == "live":
        live(app)
    elif cmd == "status":
        print(render(snapshot(app)).rsplit("\n", 1)[0])
    elif cmd == "log":
        print_log(int(args[1]) if len(args) > 1 and args[1].isdigit() else 15)
    elif cmd in ("stop", "resume", "retry"):
        print(act(app, cmd))
    elif cmd == "start":
        start_app(app)
    else:
        raise SystemExit(f"Unknown command {cmd!r}. Try: python3 monitor.py help")


if __name__ == "__main__":
    main()
