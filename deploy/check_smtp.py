#!/usr/bin/env python3
"""Checks whether this machine can reach a mail server's SMTP ports (default: smtp.iitd.ac.in).
   python3 deploy/check_smtp.py [host]"""
import smtplib
import socket
import ssl
import sys

host = sys.argv[1] if len(sys.argv) > 1 else "smtp.iitd.ac.in"
ctx = ssl.create_default_context()
ok = []
for port in (465, 587, 25):
    try:
        if port == 465:
            s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=12)
        else:
            s = smtplib.SMTP(host, port, timeout=12)
            s.ehlo()
            if s.has_extn("starttls"):
                s.starttls(context=ctx)
                s.ehlo()
        auth = "login offered" if s.has_extn("auth") else "no login offered"
        s.quit()
        print(f"  port {port}: reachable ({auth})")
        ok.append(port)
    except (socket.timeout, TimeoutError):
        print(f"  port {port}: timed out (blocked somewhere between here and {host})")
    except Exception as e:
        print(f"  port {port}: {e.__class__.__name__}: {e}")
if ok:
    print(f"  Use port {ok[0]} in Account.")
else:
    print(f"  This server can't reach {host}. IIT Delhi may only accept connections from India or from campus;")
    print("  try an Oracle region in India (Mumbai or Hyderabad), or send from Gmail instead.")
    sys.exit(1)
