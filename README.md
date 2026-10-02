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
Live sync via Server-Sent Events; spins are decided by the server and synced to all clients. State persists in `data.json` (`DATA_FILE` to override).
