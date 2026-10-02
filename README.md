---
title: Where Should We Eat
emoji: 🍽️
colorFrom: orange
colorTo: red
sdk: docker
app_port: 7860
---
Group restaurant voting app.

## Rooms
Create a room on `/` to get a 4-digit code (valid 24h, `ROOM_TTL_MS` to override). Share `/r/<code>` (list voting) or `/r/<code>/wheel`.
Live sync via Server-Sent Events; spins are decided by the server and synced to all clients. State persists in a SQLite database (`app.db`).

## Saved lists
In a room, "Save this list" stores the restaurant names + notes (not votes) under a permanent 6-character code (no 0/O/1/I/L). Enter the code on the home page ("Open a saved list") to start a new room with it, or use "Load saved list" inside a room. Saving again from a browser that holds the list's edit token updates the same code; otherwise a new list/code is created.

## Storage / deployment
Requires Node 22.5+ (uses built-in `node:sqlite`, no npm dependencies). All data lives in one SQLite file, `DATA_DIR/app.db` (WAL mode; `DATA_DIR` defaults to the app folder). Rooms expire after 24h; saved lists are deleted after 90 days without being opened or updated (`SAVED_TTL_DAYS`); cleanup runs at startup and hourly. Old `data.json` / `saved-lists.json` files are imported automatically on first start and renamed to `*.migrated`. On Railway, mount a volume at `/data` and set `DATA_DIR=/data`.
