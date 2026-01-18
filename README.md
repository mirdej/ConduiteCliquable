# Conduite Cliquable

    This code has been written entirely by artificial intelligence. 
    I'm not the author, dont blame me for messy code ;-)



Local Node/Express server that serves and augments `playScript.html` with two modes:

- **Editor**: http://localhost:3000/edit
- **Play**: http://localhost:3000/play

It also supports OSC “GO” sending, OSC inbound remote commands, auto-backups, and live sync between connected clients.

## Quick start

```bash
npm install
npm start
```

By default the server listens on `http://0.0.0.0:3000`.

## What it does

### Edit mode (`/edit`)

- Inline editing overlay for the HTML content.
- Save back to `playScript.html`.
- Backup helpers (timestamped backups under `./backups/`).
- Live updates between clients via WebSocket (shared “pending cue” state + file update notifications).

### Play mode (`/play`)

- Lightweight runtime view (no editor UI).
- Receives remote control commands (see “Remote control”).

## Remote control

### OSC outbound (send GO)

The UI can trigger `POST /osc/go` which sends OSC messages to:

- `/go/light/`, `/go/video/`, `/go/audio/`, `/go/tracker/`, `/go/comment/` (string args)

### OSC inbound (receive commands)

The server listens for OSC messages and forwards them to connected browsers (Server-Sent Events):

- `/go` → `go`
- `/prev` → `prev`
- `/next` → `next`

Browser clients subscribe via `GET /events`.

## Endpoints (useful for debugging)

- `GET /edit` editor UI
- `GET /play` play UI
- `GET /list` clickable HTML page: cues grouped by non-empty fields (light/video/audio/tracker/comment)
- `GET /list.json` JSON payload for the same data (or `GET /list?format=json`)
- `GET /print` printable HTML page with all cues in script order
- `POST /save` apply text-node patches (creates a backup first)
- `POST /saveHtml` write a full HTML document back (strips editor artifacts)
- `POST /backup` create a timestamped backup
- `POST /osc/go` send OSC GO payload and broadcast to clients
- `GET /events` SSE stream for remote commands
- `WS /ws` live sync (pending cue + fileUpdated/go broadcasts)

## Configuration

Environment variables (defaults shown):

- `PORT=3000`
- `HOST=0.0.0.0`
- `OSC_HOST=10.0.1.7`
- `OSC_PORT=9000`
- `OSC_IN_PORT=9009`
- `OSC_CMD_DEDUP_MS=2000` (deduplicate repeated inbound OSC addresses)
- `OSC_IN_LOG=1` to log inbound OSC addresses

Example:

```bash
HOST=127.0.0.1 PORT=3000 OSC_HOST=127.0.0.1 OSC_PORT=9000 OSC_IN_PORT=9009 npm start
```

## Files & folders

- `playScript.html`: source document served by `/edit` and `/play`.
- `public/`: injected client assets (`editor.js/css`, `play.js/css`).
- `backups/`: auto-generated HTML backups (`playScript.backup-YYYY-MM-DD_HH-MM-SS.html`).

## Note on provenance

Parts of this project were generated with AI assistance; treat the code as pragmatic tooling and feel free to refactor/clean up.
