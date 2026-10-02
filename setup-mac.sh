#!/bin/bash
# Sets up and publishes the "Where should we eat?" app on a Mac.
set -e
DIR="$HOME/where-to-eat-vote"

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew install node cloudflared >/dev/null 2>&1 || brew install node cloudflared

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull; else git clone https://github.com/wandr247/where-to-eat-vote "$DIR"; fi
cd "$DIR"

command -v pm2 >/dev/null || npm install -g pm2
pm2 delete where-to-eat >/dev/null 2>&1 || true
PORT=3000 pm2 start server.js --name where-to-eat
pm2 save
echo "Run the command printed below once so the app starts at login:"
pm2 startup | tail -1

# Keep the Mac from sleeping while plugged in
sudo pmset -c sleep 0 || true

pm2 delete where-to-eat-tunnel >/dev/null 2>&1 || true
pm2 start cloudflared --name where-to-eat-tunnel -- tunnel --url http://localhost:3000
pm2 save
echo "Waiting for your public link..."
sleep 8
pm2 logs where-to-eat-tunnel --lines 40 --nostream 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
echo "App: http://localhost:3000   (the https link above is public; it changes if the tunnel restarts)"
