# Conduite Cliquable

    This code has been written entirely by artificial intelligence. 
    I'm not the author, dont blame me for messy code ;-)



A small Node.js app that wraps your `playScript.html` and enables basic inline text editing (no structural changes) and saving back to disk with automatic backups.

## Features
- Double-click a text to edit just that text node
- Saves changes without altering HTML structure
- Creates timestamped backups on save
- Lightweight overlay controls (Edit/Save/Backup)

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000/edit

## Notes
- Editing targets individual text nodes. Elements with nested markup are supported: the click aims at the nearest text run.
- Save applies patches to the original file using a DOM path, preserving structure.
- Backups are stored in `./backups/` as `playScript.backup-YYYY-MM-DD_HH-MM-SS.html`.
