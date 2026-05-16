# Stones of Five

A browser-based multiplayer implementation of the classic five-in-a-row game with captures, playable on local Wi-Fi or via GitHub Pages using WebRTC (no server required).

## How to Play

Place stones on a 19×19 grid. Win by:
- Getting **five stones in a row** (horizontal, vertical, or diagonal), or
- Making **five capture pairs** (10 captured stones)

A capture occurs when you bracket exactly two of your opponent's stones with two of your own in a straight line.

## Multiplayer Modes

| File | Purpose |
|------|---------|
| `public/combined.html` | Host + play on one device (recommended for mobile) |
| `public/host.html` | Dedicated host screen — shows QR code for players to scan |
| `public/player.html` | Player join page — scan QR code or follow link from host |

Players connect peer-to-peer via [Trystero](https://github.com/dmotz/trystero) (Nostr WebRTC relay). No server needed.

## Running Locally

```bash
npm install
node server.js
```

Then open `http://localhost:8080/host.html` (or `combined.html`).

## Tech Stack

- Vanilla JS, HTML5 Canvas
- Trystero (bundled, no CDN dependency) for WebRTC signaling via Nostr

---

> **Disclaimer:** Stones of Five is an open-source implementation of the classic five-in-a-row game with captures, similar to Ninuki-renju. It is not affiliated with or endorsed by Hasbro, Inc. or the Pente brand.
