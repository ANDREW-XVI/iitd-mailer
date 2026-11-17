# Running IITD Mailer on a free Oracle Cloud server

This puts the mailer on a small Linux server that stays on, so a long send
carries on when your laptop is closed. You open it at an https:// address
and sign in with an app password. About 30 minutes, once.

You need: a credit or debit card for Oracle's sign-up check (Always Free
resources are not charged), your Mac, and this folder.

---

## 1. Create the Oracle account

1. Go to <https://www.oracle.com/cloud/free/> and choose **Start for free**.
2. For **Home Region** pick **India West (Mumbai)** or **India South
   (Hyderabad)**. It can't be changed later, and an Indian region gives the
   best chance that IIT Delhi's mail server accepts the connection.
3. Finish the card and phone check.

## 2. Create the server

1. In the console: **Compute → Instances → Create instance**.
2. **Image**: Canonical **Ubuntu 24.04** (or 22.04).
3. **Shape**: *Ampere* **VM.Standard.A1.Flex**, 1 OCPU and 6 GB memory
   (Always Free). If Oracle says it is out of capacity, use *AMD*
   **VM.Standard.E2.1.Micro** instead; the mailer runs fine on either.
4. **Networking**: keep the defaults and make sure **Assign a public IPv4
   address** is on.
5. **SSH keys**: choose **Generate a key pair for me** and click **Save
   private key**. It lands in Downloads as `ssh-key-….key`. Keep it safe:
   it is the only way into the server.
6. **Create**. When it shows *Running*, copy the **Public IP address**.

## 3. Let web traffic in

1. On the instance page, open the **Subnet** link, then its **Security List**
   (named *Default Security List…*).
2. **Add Ingress Rules**, twice:
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `443`

(The server's own firewall is opened by the setup script.)

## 4. Install the mailer from your Mac

Open **Terminal** and run, with your IP and key file:

```sh
cd ~/Claude/iitd-mailer
sh deploy/push_to_server.sh ubuntu@<PUBLIC IP> ~/Downloads/ssh-key-XXXX.key
```

Type `yes` if it asks about the server's fingerprint. The script copies the
app, installs everything, and ends with a box like this:

```
 IITD Mailer is running
 Open:      https://129-154-1-2.sslip.io
 Sign in with this app password (shown once, write it down):
            k3Jx…
```

Write the password down. Step 6 of the script also says whether the server can
reach `smtp.iitd.ac.in`, and on which port.

## 5. First sign-in

1. Open the https address (the certificate is made on the first visit, give
   it a minute) and sign in.
2. **Account**: IIT Delhi, your Kerberos ID and password, the port the check
   reported, and turn on **Remember the password on this server**. Without
   it the server can't carry on sending after a restart. **Connect and test**.
3. **Sending pace**: keep 20 an hour unless IIT Delhi tells you otherwise.
4. **New list from CSV**, check the rows, **Send test to me**, then send.
   You can close the page and your laptop; the server keeps going.

## Updating later

Change the files in `~/Claude/iitd-mailer`, then run the same command as in
step 4. Your lists, attachments, settings and log on the server are kept.

## Good to know

- **Where things live on the server**: the app in `/opt/iitd-mailer`, your
  data in `/var/lib/iitd-mailer` (lists, attachments, `sent_log.csv`, the
  saved mail password in `secret.json`, readable only by the app), the app
  password in `/etc/iitd-mailer.env`.
- **Change the app password**: `ssh -i <key> ubuntu@<IP>`, then
  `sudo nano /etc/iitd-mailer.env` and `sudo systemctl restart iitd-mailer`.
- **Logs if something breaks**: `sudo journalctl -u iitd-mailer -n 100`.
- **Your Kerberos password is stored on the server** when you tick Remember.
  It is the same password as Moodle and Wi-Fi, so keep the key file and the app
  password private. Use **Account → Forget the saved password** when you
  don't need the server for a while.
- **Oracle can reclaim idle Always Free servers.** Its documentation says a
  server counts as idle when, over 7 days, CPU (95th percentile), network and,
  on Ampere, memory use all stay under 20%. A mailer is idle most of the time,
  so keep this folder up to date. If the server disappears, create a new one
  and run step 4 again (about 10 minutes). Download the log from **Sent log →
  Download CSV** after big sends.
- **If IIT Delhi refuses the server**: the setup check says so. Options are an
  Indian region (if you didn't pick one), asking CSC whether off-campus
  SMTP is allowed from cloud servers, or sending from Gmail with an App
  Password and your IITD address as Reply-to.
- **Your own domain** instead of `…sslip.io`: point an A record at the IP,
  then on the server `sudo DOMAIN=mail.yourname.in bash iitd-mailer/deploy/setup.sh`.
