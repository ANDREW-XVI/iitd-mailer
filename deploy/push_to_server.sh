#!/bin/sh
# IITD Mailer, made by Ayush Vishwakarma.
# Run this ON YOUR MAC to copy the app to the server and install or update it there.
#   sh deploy/push_to_server.sh ubuntu@<server IP> ~/Downloads/ssh-key-XXXX.key
set -e
TARGET="$1"; KEY="$2"
if [ -z "$TARGET" ] || [ -z "$KEY" ]; then
  echo "Usage: sh deploy/push_to_server.sh ubuntu@<server IP> <path to the private key Oracle gave you>"; exit 1
fi
chmod 600 "$KEY"
cd "$(dirname "$0")/.."
rsync -az --delete --exclude data --exclude venv --exclude '__pycache__' -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" ./ "$TARGET:iitd-mailer/"
ssh -t -i "$KEY" "$TARGET" "sudo bash iitd-mailer/deploy/setup.sh"
