@echo off
rem IITD Mailer, made by Ayush Vishwakarma.
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
python app.py
pause
