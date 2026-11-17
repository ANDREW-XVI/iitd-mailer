#!/bin/sh
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt 2>/dev/null || python3 -m pip install -q --user -r requirements.txt
# On a Mac, keep it awake while the app runs, so sending (and SSH) keeps working when you step away.
# The screen can still turn off; closing the lid still sleeps unless it's plugged in with a display.
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i python3 app.py
else
  exec python3 app.py
fi
