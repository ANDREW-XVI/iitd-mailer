IITD MAILER - personalised emails from a CSV
=============================================

ON YOUR LAPTOP
  Mac:      sh run_mac_linux.sh      Windows: double-click run_windows.bat
  It opens http://127.0.0.1:8765. Keep the terminal window open while sending.
  The Mac stays awake while it runs (caffeinate), so sending carries on when you
  step away; closing the lid still sleeps it unless it's plugged in to a display.
  Needs Python 3.8+ (python.org).

WATCH IT FROM YOUR PHONE (SSH)
  ssh into the Mac, then:
    cd ~/Claude/iitd-mailer && ./mon
  Live view of the send: progress, next email time, pauses and why, the hourly
  allowance, the last sends. Keys: s stop (press twice), r resume, t try now,
  l log, q quit. Other commands: ./mon status   ./mon log 30   ./mon stop
  ./mon resume   ./mon retry   ./mon start (starts the app if it isn't running,
  keeps the Mac awake, keeps running after you disconnect).
  The browser app on the Mac keeps working as before; both show the same send.

ON A FREE SERVER (keeps sending when your laptop is off)
  See DEPLOY.md: Oracle Cloud Always Free, about 30 minutes once.

USING IT
  1. Account: IIT Delhi = your Kerberos ID + password, smtp.iitd.ac.in, port 465
     (try 587 or 25 if that fails). Gmail needs an App Password.
  2. New list from CSV. One row = one email. Pick which column is To, Subject
     and Body ("Change columns"); CC, BCC, Reply-to and Attachments are optional.
     Any column can be used inside the subject or body as {Column name}.
  3. The list shows every row as Ready, Check, or a problem (no address, bad
     address, file missing). Problem rows are never sent. Click a row to see the
     exact email.
  4. Send test to me, then Send. Sent rows stay sent, so sending again only
     sends the rest.

SENDING LIMITS
  IIT Delhi refused after about 28 emails in a short time. The app keeps to a
  "most emails in any hour" limit (Account, default 20) and shows it on every
  list as the sending allowance. If the server still refuses, it pauses 15, then
  30, then 60 minutes and retries; after that it stops and keeps the rest for
  later (Resume).

FILES
  data/            your lists, attachments added in the app, settings, the send
                   queue, and (only if you tick Remember) the mail password
  sent_log.csv     every send, test and failure
  attachments/     you can also drop attachment files here
  static/fonts     Inter, under the SIL Open Font License (Inter-LICENSE.txt)
