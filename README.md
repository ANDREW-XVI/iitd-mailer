# IITD Mailer

*Made by **Ayush Vishwakarma**.*

Send **personalised emails from a CSV** through your IIT Delhi (or Gmail) account, safely.
One row = one email. You see every email before it goes, problem rows are held back, and the app
keeps to an hourly sending limit and pauses and retries on its own when the mail server pushes back.

Plain Python (Flask) and vanilla JavaScript. No framework, no build step, no database.
Runs on your own computer, or on a free server so a long send carries on with your laptop closed.

## Features

- **Preview before sending.** Every row is built and shown as the exact email. Rows with a problem
  (no address, bad address, missing attachment, empty greeting) are never sent.
- **One message for everyone, or per-row text.** Write the subject and body once and fill in each
  row with `{Column name}`, or take subject and body from CSV columns.
- **Smart greetings.** `{Greeting name}`, `{First name}`, `{Last name}` and `{Title}` are worked out
  from a name column ("Dear Dr. Smith", "Dear Professor Li"), and uncertain ones are flagged to check.
- **Sending limits built in.** A "most emails per hour" cap and a gap between emails. If the server
  refuses, it waits 15, then 30, then 60 minutes and retries before giving up.
- **Crash-safe.** Each email is delivered exactly once, even if the app or computer stops mid-send.
  An email that was in flight is marked "Check inbox" instead of being sent again.
- **No accidental duplicates.** Anyone you've already emailed, on any list, is held back unless you
  choose "Send again anyway".
- **Attachments**, per row or on every email, plus BCC-me and a copy saved in your Sent folder.
- **Filters, saved templates, row editing, CSV replacement** that keeps progress, and a send history.
- **Watch it from a terminal** (`./mon`), including from a phone over SSH.
- Dark and light themes; works on a phone-sized screen.

## Quick start

You need **Python 3.8 or newer**.

```sh
git clone https://github.com/ANDREW-XVI/iitd-mailer.git
cd iitd-mailer
sh run_mac_linux.sh        # Mac / Linux
```

On Windows, double-click `run_windows.bat`. The script installs the two dependencies (`flask`,
`waitress`) and opens <http://127.0.0.1:8765>. Keep the terminal open while sending.
On a Mac it runs under `caffeinate`, so sending carries on while you step away.

Then, in the app:

1. **Account**: for IIT Delhi, use your Kerberos ID and password, server `smtp.iitd.ac.in`, port
   `465` (try `587` or `25` if that fails). Gmail needs an [App Password](https://myaccount.google.com/apppasswords).
2. **New list from CSV**, then check the rows.
3. **Send test to me**, then **Send**. Sent rows stay sent, so sending again only sends the rest.

## Your CSV

One row per email. The app guesses which column is which (`Email`/`To`, `Subject`, `Body`, `CC`, `BCC`,
`Reply-to`, `Attachments`) and you can change it. Any column can be used in the subject or body as
`{Column name}`; matching ignores case, spaces and punctuation.

```csv
Email,Name,Roll No,Subject,Body
aarav@example.com,Aarav Sharma,2023CS10123,"Reminder: {Roll No}","Dear {Name},\n\nYour form is pending.\n\nThanks"
```

See `sample.csv` for a fuller example, including HTML bodies and attachments. Comma, semicolon, tab and pipe-separated
files all work (the separator is detected).

## Sending limits

IIT Delhi's mail server started refusing recipients after about 28 emails in a short time, so the app
sends slowly by default: **20 emails per hour** with a gap between emails (both adjustable under
Account). Please use it responsibly: send to people who should reasonably expect your email, keep
messages relevant and honest, and don't use it for spam.

## Watch and control a send from a terminal

```sh
./mon              # live view: progress, next email, pauses and why, hourly allowance, last sends
./mon status       # one snapshot
./mon log 30       # last 30 log lines
./mon stop | resume | retry | start
```

Standard library only. It works over SSH too, so you can check a long send from your phone.

## Run it on a free server

`DEPLOY.md` is a step-by-step guide for an Oracle Cloud Always Free VM (about 30 minutes, once). It
sets up HTTPS and an app password, and the send carries on with your laptop off.

```sh
sh deploy/push_to_server.sh ubuntu@<server IP> ~/Downloads/ssh-key-XXXX.key
```

## Your data and security

- Everything you create lives in `data/` and `sent_log.csv`: settings, lists, uploaded files, and your
  mail password **only if** you tick *Remember the password*. These files are in `.gitignore`.
  **Never commit them.**
- By default the app only listens on `127.0.0.1`, so only your computer can open it. In server mode
  it needs a sign-in password.
- Your Kerberos password is shared with other IIT Delhi services. For a safer option, use Gmail with
  an App Password, or leave *Remember* unticked and type the password each session.

## Project layout

```
app.py              backend: Flask app, CSV parsing, email building, SMTP, send queue, API
templates/          page shell
static/             app.js (all front-end logic), app.css (themes), fonts
monitor.py, mon     terminal monitor / controller
deploy/             server install scripts (Ubuntu + systemd + Caddy)
sample.csv          example list
DEPLOY.md           server guide
HANDOFF.md          technical reference: how it works inside, data files, API, testing
```

`HANDOFF.md` explains the internals (the send queue, crash safety, the API, settings) and how to test
changes against a fake SMTP server without sending real email.

## Credits

The Inter typeface is bundled under the SIL Open Font License (`static/fonts/Inter-LICENSE.txt`).
