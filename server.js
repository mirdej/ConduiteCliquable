import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import osc from 'osc';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TARGET_FILE = path.join(__dirname, 'playScript.html');
const BACKUP_DIR = path.join(__dirname, 'backups');

const OSC_HOST = process.env.OSC_HOST || '10.0.1.7';
const OSC_PORT = Number(process.env.OSC_PORT || 9000);
const OSC_IN_PORT = Number(process.env.OSC_IN_PORT || 9009);
const OSC_CMD_DEDUP_MS = 2000;//Number(process.env.OSC_CMD_DEDUP_MS || 300);
const OSC_IN_LOG = process.env.OSC_IN_LOG === '1';

/** @type {{ cueId: string, index: number }} */
let sharedPending = { cueId: '', index: -1 };

let fileMtimeMs = 0;
let fileWatchDebounce = null;

/** @type {Set<import('ws').WebSocket>} */
const wsClients = new Set();

function wsBroadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(payload);
    } catch {
      // ignore
    }
  }
}

async function refreshFileMtime() {
  try {
    const st = await fs.stat(TARGET_FILE);
    fileMtimeMs = Number(st.mtimeMs || 0);
  } catch {
    // ignore
  }
}

function scheduleFileUpdatedBroadcast(reason = 'unknown') {
  if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
  fileWatchDebounce = setTimeout(async () => {
    await refreshFileMtime();
    wsBroadcast({ type: 'fileUpdated', reason, mtimeMs: fileMtimeMs, ts: Date.now() });
  }, 150);
}

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

let oscReady = false;
const oscUdpPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: 0
});
oscUdpPort.on('ready', () => {
  oscReady = true;
  console.log(`[OSC] Ready (target ${OSC_HOST}:${OSC_PORT})`);
});
oscUdpPort.on('error', (err) => {
  oscReady = false;
  console.warn('[OSC] Error:', err?.message || err);
});
oscUdpPort.open();

function broadcastEditorCommand(cmd) {
  const payload = JSON.stringify({ cmd, ts: Date.now() });
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      try { res.end(); } catch {}
      sseClients.delete(res);
    }
  }
}

// OSC inbound listener (e.g. /go /prev /next)
let oscInReady = false;
/** @type {Map<string, number>} */
const lastOscCmdAtMs = new Map();
const oscInPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: OSC_IN_PORT
});
oscInPort.on('ready', () => {
  oscInReady = true;
  console.log(`[OSC IN] Listening on 0.0.0.0:${OSC_IN_PORT}`);
});
oscInPort.on('error', (err) => {
  oscInReady = false;
  console.warn('[OSC IN] Error:', err?.message || err);
});
oscInPort.on('message', (msg) => {
  const address = String(msg?.address || '');
  const a = address.replace(/\/+$/, '');

  // Some OSC senders can emit duplicate messages (bundles, retries, button bounce).
  // Deduplicate by normalized address within a small time window.
  const now = Date.now();
  const last = lastOscCmdAtMs.get(a) || 0;
  if (OSC_CMD_DEDUP_MS > 0 && now - last < OSC_CMD_DEDUP_MS) return;
  lastOscCmdAtMs.set(a, now);

  if (OSC_IN_LOG) console.log(`[OSC IN] ${a}`);

  if (a === '/go') broadcastEditorCommand('go');
  else if (a === '/prev') broadcastEditorCommand('prev');
  else if (a === '/next') broadcastEditorCommand('next');
});
oscInPort.open();

app.use(express.json({ limit: '2mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/edit'));

app.get('/edit', async (req, res) => {
  try {
    const html = await fs.readFile(TARGET_FILE, 'utf8');
    const injected = injectEditor(html);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (err) {
    res.status(500).send(`<pre>Error reading file: ${err.message}</pre>`);
  }
});

app.get('/play', async (req, res) => {
  try {
    const html = await fs.readFile(TARGET_FILE, 'utf8');
    const injected = injectPlay(html);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (err) {
    res.status(500).send(`<pre>Error reading file: ${err.message}</pre>`);
  }
});

app.get('/list', async (req, res) => {
  try {
    const format = String(req.query?.format || '').toLowerCase();
    if (format === 'json') {
      const payload = await buildCueListPayload();
      return res.json(payload);
    }

    const payload = await buildCueListPayload();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderCueListHtml(payload));
  } catch (err) {
    res.status(500).send(`<pre>Error building list: ${escapeHtml(err.message)}</pre>`);
  }
});

app.get('/list.json', async (req, res) => {
  try {
    const payload = await buildCueListPayload();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/print', async (req, res) => {
  try {
    const html = await fs.readFile(TARGET_FILE, 'utf8');
    const injected = injectPrint(html);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  } catch (err) {
    res.status(500).send(`<pre>Error building print view: ${escapeHtml(err.message)}</pre>`);
  }
});

// Keep the previous printable cue list (table) under /list/print
app.get('/list/print', async (req, res) => {
  try {
    const html = await fs.readFile(TARGET_FILE, 'utf8');
    const items = extractCueItemsFromHtml(html);
    const payload = await buildCueListPayload();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPrintHtml({ items, payload }));
  } catch (err) {
    res.status(500).send(`<pre>Error building print view: ${escapeHtml(err.message)}</pre>`);
  }
});

// Server-Sent Events stream for remote control commands
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Initial ping
  res.write(`data: ${JSON.stringify({ cmd: 'hello', oscInReady, ts: Date.now() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/backup', async (req, res) => {
  try {
    const backupPath = await createBackup(TARGET_FILE);
    res.json({ ok: true, backupPath });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/save', async (req, res) => {
  try {
    const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];
    if (!patches.length) return res.status(400).json({ ok: false, error: 'No patches provided' });

    const originalHtml = await fs.readFile(TARGET_FILE, 'utf8');
    await createBackup(TARGET_FILE);

    const dom = new JSDOM(originalHtml);
    const { document } = dom.window;

    for (const p of patches) {
      const pathArr = p.path;
      const newValue = p.newValue ?? '';
      if (!Array.isArray(pathArr) || !pathArr.every(Number.isInteger)) continue;
      const node = getNodeByPath(document, pathArr);
      if (node && node.nodeType === 3) {
        node.nodeValue = newValue;
      }
    }

    const updatedHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    await fs.writeFile(TARGET_FILE, updatedHtml, 'utf8');
    scheduleFileUpdatedBroadcast('save');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/saveHtml', async (req, res) => {
  try {
    const html = typeof req.body?.html === 'string' ? req.body.html : '';
    if (!html.trim()) return res.status(400).json({ ok: false, error: 'No html provided' });

    // Backups are created via POST /backup (client triggers them periodically).

    const dom = new JSDOM(html);
    const { document } = dom.window;

    // Remove editor artifacts before writing back.
    document.querySelectorAll('.editor-controls, .editor-overlay, .editor-search-hit, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .cue-drop-placeholder, .editor-drop-indicator').forEach((n) => n.remove());
    document.querySelectorAll('script[src="/static/editor.js"], link[href="/static/editor.css"]').forEach((n) => n.remove());
    // Remove the injected inline config script (best-effort)
    document.querySelectorAll('script').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t.includes('window.__EDITOR__')) s.remove();
    });
    document.documentElement.classList.remove('editor-theme-dark');
    document.documentElement.classList.remove('editor-edit-mode');
    document.querySelectorAll('.cue-label--selected').forEach((n) => n.classList.remove('cue-label--selected'));

    // Remove WYSIWYG/editor-only attributes & classes.
    document.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    document.querySelectorAll('[spellcheck]').forEach((n) => n.removeAttribute('spellcheck'));
    document.querySelectorAll('.editor-dom-selected').forEach((n) => n.classList.remove('editor-dom-selected'));

    const updatedHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    await fs.writeFile(TARGET_FILE, updatedHtml, 'utf8');
    scheduleFileUpdatedBroadcast('saveHtml');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/osc/go', (req, res) => {
  try {
    if (!oscReady) return res.status(503).json({ ok: false, error: 'OSC not ready' });

    const cueId = String(req.body?.cueId ?? '');
    const name = String(req.body?.name ?? '');

    const light = String(req.body?.light ?? '');
    const video = String(req.body?.video ?? '');
    const audio = String(req.body?.audio ?? '');
    const tracker = String(req.body?.tracker ?? '');
    const comment = String(req.body?.comment ?? '');

    // Send OSC messages: address + string arg
    oscUdpPort.send({ address: '/go/light/', args: [light] }, OSC_HOST, OSC_PORT);
    oscUdpPort.send({ address: '/go/video/', args: [video] }, OSC_HOST, OSC_PORT);
    oscUdpPort.send({ address: '/go/audio/', args: [audio] }, OSC_HOST, OSC_PORT);
    oscUdpPort.send({ address: '/go/tracker/', args: [tracker] }, OSC_HOST, OSC_PORT);
    oscUdpPort.send({ address: '/go/comment/', args: [comment] }, OSC_HOST, OSC_PORT);

    // Notify all clients that a GO happened (so UIs can update even when
    // the GO was triggered from another connected device).
    wsBroadcast({
      type: 'go',
      cue: { cueId, name, light, video, audio, tracker, comment },
      ts: Date.now()
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create HTTP server so WebSocket can share the same port.
const server = http.createServer(app);

// WebSocket endpoint for live updates + shared pending cue state.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', async (ws) => {
  wsClients.add(ws);
  await refreshFileMtime();
  try {
    ws.send(JSON.stringify({ type: 'state', pending: sharedPending, mtimeMs: fileMtimeMs, ts: Date.now() }));
  } catch {
    // ignore
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data || ''));
    } catch {
      return;
    }

    const type = String(msg?.type || '');
    if (type === 'setPending') {
      const cueId = String(msg?.cueId || '');
      const index = Number.isFinite(msg?.index) ? Number(msg.index) : -1;
      sharedPending = { cueId, index };
      wsBroadcast({ type: 'pending', pending: sharedPending, ts: Date.now() });
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

// Best-effort file watcher for external edits.
try {
  fsSync.watch(TARGET_FILE, { persistent: false }, () => {
    scheduleFileUpdatedBroadcast('watch');
  });
} catch {
  // ignore
}

server.listen(PORT, HOST, () => {
  console.log(`Editor server listening on http://${HOST}:${PORT}/edit`);
  console.log(`Open from another device: http://<this-mac-LAN-IP>:${PORT}/edit`);
  console.log(`Play mode: http://<this-mac-LAN-IP>:${PORT}/play`);
});

function injectEditor(html) {
  const toolbar = `\n<link rel=\"stylesheet\" href=\"/static/editor.css\">\n<script>window.__EDITOR__ = { saveUrl: '/save', saveHtmlUrl: '/saveHtml', backupUrl: '/backup', oscGoUrl: '/osc/go', eventsUrl: '/events', wsPath: '/ws' }<\/script>\n<script src=\"/static/editor.js\" defer><\/script>`;

  // Idempotent injection: avoid duplicating scripts/styles if the source HTML already contains them.
  if (/\/static\/editor\.js\b/i.test(html) || /window\.__EDITOR__\b/i.test(html) || /\/static\/editor\.css\b/i.test(html)) {
    return html;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${toolbar}\n</body>`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${toolbar}\n</head>`);
  }
  return html + toolbar;
}

function injectPlay(html) {
  const payload = `\n<link rel=\"stylesheet\" href=\"/static/play.css\">\n<script>window.__PLAY__ = { oscGoUrl: '/osc/go', eventsUrl: '/events', wsPath: '/ws' }<\/script>\n<script src=\"/static/play.js\" defer><\/script>`;

  // Idempotent injection: avoid duplicating scripts/styles if the source HTML already contains them.
  if (/\/static\/play\.js\b/i.test(html) || /window\.__PLAY__\b/i.test(html) || /\/static\/play\.css\b/i.test(html)) {
    return html;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${payload}\n</body>`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${payload}\n</head>`);
  }
  return html + payload;
}

function injectPrint(html) {
  const payload = `\n<link rel=\"stylesheet\" href=\"/static/print.css\">`;

  // Idempotent injection
  if (/\/static\/print\.css\b/i.test(html)) return html;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${payload}\n</head>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${payload}\n</body>`);
  }
  return html + payload;
}

function hasValue(v) {
  return String(v || '').trim().length > 0;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildCueListPayload() {
  const html = await fs.readFile(TARGET_FILE, 'utf8');
  const cues = extractCuesFromHtml(html);

  /** @type {Record<string, { count: number, cues: any[] }>} */
  const categories = {
    light: { count: 0, cues: [] },
    video: { count: 0, cues: [] },
    audio: { count: 0, cues: [] },
    tracker: { count: 0, cues: [] },
    comment: { count: 0, cues: [] }
  };

  for (const cue of cues) {
    if (hasValue(cue.light)) categories.light.cues.push(cue);
    if (hasValue(cue.video)) categories.video.cues.push(cue);
    if (hasValue(cue.audio)) categories.audio.cues.push(cue);
    if (hasValue(cue.tracker)) categories.tracker.cues.push(cue);
    if (hasValue(cue.comment)) categories.comment.cues.push(cue);
  }

  for (const k of Object.keys(categories)) {
    categories[k].count = categories[k].cues.length;
  }

  return { ok: true, total: cues.length, categories, ts: Date.now() };
}

function cueHref(cue) {
  const cueId = String(cue?.cueId || '').trim();
  const index = Number.isFinite(cue?.index) ? Number(cue.index) : -1;
  const qs = new URLSearchParams();
  if (cueId) qs.set('cueId', cueId);
  if (index >= 0) qs.set('index', String(index));
  const q = qs.toString();
  return `/play${q ? `?${q}` : ''}`;
}

function renderCueRow(cue) {
  const name = escapeHtml(String(cue?.name || '').trim());
  const cueId = escapeHtml(String(cue?.cueId || '').trim());
  const index = Number.isFinite(cue?.index) ? Number(cue.index) : -1;
  const light = escapeHtml(String(cue?.light || '').trim());
  const video = escapeHtml(String(cue?.video || '').trim());
  const audio = escapeHtml(String(cue?.audio || '').trim());
  const tracker = escapeHtml(String(cue?.tracker || '').trim());
  const comment = escapeHtml(String(cue?.comment || '').trim());
  const href = cueHref(cue);

  const badges = [
    light ? `<span class="badge badge--l" title="Light">L:${light}</span>` : '',
    video ? `<span class="badge badge--v" title="Video">V:${video}</span>` : '',
    audio ? `<span class="badge badge--a" title="Audio">A:${audio}</span>` : '',
    tracker ? `<span class="badge badge--t" title="Tracker">T</span>` : '',
    comment ? `<span class="badge badge--c" title="Comment">C</span>` : ''
  ].filter(Boolean).join('');

  const meta = [
    cueId ? `<span class="meta">id: <code>${cueId}</code></span>` : '',
    index >= 0 ? `<span class="meta">#${index + 1}</span>` : ''
  ].filter(Boolean).join('');

  const dataSearch = escapeHtml([
    name,
    cueId,
    light,
    video,
    audio,
    tracker,
    comment
  ].join(' | '));

  return `
    <li class="cue" data-search="${dataSearch}">
      <a class="cue-link" href="${href}">
        <span class="cue-title">${name || '(cue)'}</span>
        <span class="cue-badges">${badges}</span>
      </a>
      <div class="cue-sub">
        <span class="cue-meta">${meta}</span>
        ${comment ? `<div class="cue-comment">${comment}</div>` : ''}
      </div>
    </li>
  `;
}

function renderCueListHtml(payload) {
  const total = Number.isFinite(payload?.total) ? Number(payload.total) : 0;
  const ts = Number.isFinite(payload?.ts) ? Number(payload.ts) : Date.now();
  const categories = payload?.categories || {};

  const renderCategory = (key, title) => {
    const cat = categories[key] || { count: 0, cues: [] };
    const count = Number.isFinite(cat.count) ? Number(cat.count) : 0;
    const cues = Array.isArray(cat.cues) ? cat.cues : [];
    const items = cues.map(renderCueRow).join('');
    const open = count ? 'open' : '';
    return `
      <details class="cat" ${open}>
        <summary>
          <span class="cat-title">${escapeHtml(title)}</span>
          <span class="cat-count">${count}</span>
        </summary>
        ${count ? `<ol class="cue-list">${items}</ol>` : `<div class="empty">(none)</div>`}
      </details>
    `;
  };

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cue List</title>
    <style>
      :root{color-scheme:dark;--bg:#0b0f16;--panel:#111827;--panel2:#0f172a;--muted:#9ca3af;--text:#e5e7eb;--border:rgba(255,255,255,.08);--accent:#60a5fa;--accent2:#34d399}
      *{box-sizing:border-box}
      body{margin:0;padding:20px;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:linear-gradient(180deg,var(--bg),#070a10);color:var(--text)}
      a{color:inherit}
      .wrap{max-width:1100px;margin:0 auto}
      .top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px}
      .title{display:flex;flex-direction:column;gap:2px}
      h1{margin:0;font-size:18px;letter-spacing:.2px}
      .sub{color:var(--muted);font-size:12px}
      .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .btn{display:inline-flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.03);text-decoration:none}
      .btn:hover{border-color:rgba(96,165,250,.5)}
      .search{flex:1;min-width:240px;display:flex;gap:8px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.03)}
      .search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:14px}
      .grid{display:grid;grid-template-columns:1fr;gap:10px}
      .cat{border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.02));overflow:hidden}
      .cat summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px}
      .cat summary::-webkit-details-marker{display:none}
      .cat-title{font-weight:650}
      .cat-count{font-variant-numeric:tabular-nums;color:var(--muted)}
      .cue-list{margin:0;padding:0 0 6px 0}
      .cue{list-style:none;padding:10px 14px;border-top:1px solid var(--border)}
      .cue-link{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;text-decoration:none}
      .cue-title{font-weight:600}
      .cue-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .badge{font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text);background:rgba(255,255,255,.03);font-variant-numeric:tabular-nums}
      .badge--l{border-color:rgba(96,165,250,.35)}
      .badge--v{border-color:rgba(52,211,153,.35)}
      .badge--a{border-color:rgba(244,114,182,.35)}
      .badge--t{border-color:rgba(251,191,36,.35)}
      .badge--c{border-color:rgba(167,139,250,.35)}
      .cue-sub{margin-top:6px;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
      .cue-meta{color:var(--muted);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:#c7d2fe}
      .cue-comment{flex:1;min-width:200px;color:var(--muted)}
      .empty{padding:0 14px 12px 14px;color:var(--muted)}
      .footer{margin-top:14px;color:var(--muted);font-size:12px}
      .hidden{display:none !important}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="title">
          <h1>Cue List</h1>
          <div class="sub">Total cues: <strong>${total}</strong> · Generated: ${escapeHtml(new Date(ts).toLocaleString())}</div>
        </div>
        <div class="actions">
          <a class="btn" href="/play">Open Play</a>
          <a class="btn" href="/edit">Open Editor</a>
          <a class="btn" href="/print">Print (inline)</a>
          <a class="btn" href="/list/print">Print (table)</a>
          <a class="btn" href="/list.json">JSON</a>
        </div>
      </div>

      <div class="search" role="search">
        <span style="color:var(--muted)">Filter</span>
        <input id="q" type="search" placeholder="Type to filter cues (name, id, values, comment…)" autocomplete="off" />
        <a class="btn" href="#" id="clear" style="padding:6px 10px">Clear</a>
      </div>

      <div class="grid" id="cats">
        ${renderCategory('light', 'Light')}
        ${renderCategory('video', 'Video')}
        ${renderCategory('audio', 'Audio')}
        ${renderCategory('tracker', 'Tracker')}
        ${renderCategory('comment', 'Comment')}
      </div>

      <div class="footer">
        Tip: click a cue to open Play mode with that cue selected.
      </div>
    </div>

    <script>
      (function(){
        var q = document.getElementById('q');
        var clear = document.getElementById('clear');
        function norm(s){return String(s||'').toLowerCase().trim();}
        function apply(){
          var term = norm(q && q.value);
          var items = document.querySelectorAll('.cue');
          if (!term) {
            items.forEach(function(el){el.classList.remove('hidden');});
            return;
          }
          items.forEach(function(el){
            var hay = norm(el.getAttribute('data-search'));
            el.classList.toggle('hidden', hay.indexOf(term) === -1);
          });
        }
        if (q) q.addEventListener('input', apply);
        if (clear) clear.addEventListener('click', function(e){ e.preventDefault(); if(q) q.value=''; apply(); q && q.focus(); });
      })();
    </script>
  </body>
  </html>`;
}

function extractCuesFromHtml(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  const els = Array.from(document.querySelectorAll('.cue-label'))
    .filter((el) => !el.classList.contains('cue-label--template'));

  return els.map((el, index) => {
    const cueId = String(el.getAttribute('data-cue-id') || '').trim();
    const nameAttr = String(el.getAttribute('data-name') || '').trim();
    const text = String(el.textContent || '').trim();

    const light = String(el.getAttribute('data-light') || '').trim();
    const video = String(el.getAttribute('data-video') || '').trim();
    const audio = String(el.getAttribute('data-audio') || '').trim();
    const tracker = String(el.getAttribute('data-tracker') || '').trim();
    const comment = String(el.getAttribute('data-comment') || '').trim();

    return {
      index,
      cueId,
      name: nameAttr || text,
      text,
      light,
      video,
      audio,
      tracker,
      comment
    };
  });
}

function extractCueItemsFromHtml(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;

  const nodes = Array.from(document.body.querySelectorAll('.cue-separator, .cue-label'))
    .filter((el) => !el.classList.contains('cue-label--template'));

  let cueIndex = 0;
  /** @type {any[]} */
  const items = [];

  for (const el of nodes) {
    if (el.classList.contains('cue-separator')) {
      const title = String(el.textContent || '').trim() || 'Section';
      items.push({ type: 'separator', title });
      continue;
    }

    // cue-label
    const cueId = String(el.getAttribute('data-cue-id') || '').trim();
    const nameAttr = String(el.getAttribute('data-name') || '').trim();
    const text = String(el.textContent || '').trim();

    const light = String(el.getAttribute('data-light') || '').trim();
    const video = String(el.getAttribute('data-video') || '').trim();
    const audio = String(el.getAttribute('data-audio') || '').trim();
    const tracker = String(el.getAttribute('data-tracker') || '').trim();
    const comment = String(el.getAttribute('data-comment') || '').trim();

    items.push({
      type: 'cue',
      index: cueIndex,
      cueId,
      name: nameAttr || text,
      text,
      light,
      video,
      audio,
      tracker,
      comment
    });
    cueIndex++;
  }

  return items;
}

function renderPrintHtml({ items, payload }) {
  const total = Number.isFinite(payload?.total) ? Number(payload.total) : 0;
  const ts = Number.isFinite(payload?.ts) ? Number(payload.ts) : Date.now();
  const categories = payload?.categories || {};

  const catCount = (k) => {
    const c = categories?.[k];
    const n = Number.isFinite(c?.count) ? Number(c.count) : 0;
    return n;
  };

  const rows = (Array.isArray(items) ? items : []).map((it) => {
    if (it.type === 'separator') {
      return `
        <tr class="sep"><td colspan="7">${escapeHtml(String(it.title || 'Section'))}</td></tr>
      `;
    }

    const n = Number.isFinite(it.index) ? Number(it.index) + 1 : '';
    const name = escapeHtml(String(it.name || it.text || '(cue)'));
    const cueId = escapeHtml(String(it.cueId || ''));
    const light = escapeHtml(String(it.light || ''));
    const video = escapeHtml(String(it.video || ''));
    const audio = escapeHtml(String(it.audio || ''));
    const tracker = escapeHtml(String(it.tracker || ''));
    const comment = escapeHtml(String(it.comment || ''));
    const href = cueHref(it);

    return `
      <tr>
        <td class="num">${n}</td>
        <td class="name"><a href="${href}">${name}</a>${cueId ? `<div class="id">${cueId}</div>` : ''}</td>
        <td class="val">${light}</td>
        <td class="val">${video}</td>
        <td class="val">${audio}</td>
        <td class="val">${tracker}</td>
        <td class="comment">${comment}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Print – Cues</title>
    <style>
      :root{--text:#111;--muted:#555;--border:#ddd;--bg:#fff}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--text);font:13px/1.35 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
      .wrap{max-width:1200px;margin:0 auto;padding:18px}
      h1{margin:0 0 6px 0;font-size:18px}
      .meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:12px}
      .meta a{color:inherit;text-decoration:none;border-bottom:1px dotted #999}
      .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .pill{border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--muted)}
      table{width:100%;border-collapse:collapse}
      thead th{position:sticky;top:0;background:#fafafa;border-bottom:2px solid var(--border);text-align:left;font-size:12px;color:var(--muted);padding:8px}
      td{border-bottom:1px solid var(--border);padding:8px;vertical-align:top}
      .num{width:44px;color:var(--muted);font-variant-numeric:tabular-nums}
      .val{width:70px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .name a{color:inherit;text-decoration:none}
      .id{margin-top:2px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px}
      .comment{min-width:220px}
      tr.sep td{background:#f6f6f6;font-weight:650;border-top:2px solid var(--border)}

      @media print {
        .meta a{border-bottom:none}
        thead th{position:static}
        @page{margin:12mm}
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Printable Cue List</h1>
      <div class="meta">
        <span>Total cues: <strong>${total}</strong></span>
        <span>Generated: ${escapeHtml(new Date(ts).toLocaleString())}</span>
        <span><a href="/list">Back to /list</a></span>
        <span><a href="/edit">/edit</a></span>
        <span><a href="/play">/play</a></span>
      </div>
      <div class="stats">
        <span class="pill">Light: ${catCount('light')}</span>
        <span class="pill">Video: ${catCount('video')}</span>
        <span class="pill">Audio: ${catCount('audio')}</span>
        <span class="pill">Tracker: ${catCount('tracker')}</span>
        <span class="pill">Comment: ${catCount('comment')}</span>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Light</th>
            <th>Video</th>
            <th>Audio</th>
            <th>Tracker</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </body>
  </html>`;
}

function getNodeByPath(document, pathArr) {
  let node = document; // start at Document
  for (const idx of pathArr) {
    // Document -> documentElement for first step
    const pool = node.nodeType === 9 ? [node.documentElement] : node.childNodes;
    node = pool[idx] || null;
    if (!node) return null;
  }
  return node;
}

async function createBackup(filePath) {
  const ts = formatBackupTimestampLocal(new Date());
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const { name, ext } = path.parse(filePath);
  const backupName = `${name}.backup-${ts}${ext || '.html'}`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  const content = await fs.readFile(filePath);
  await fs.writeFile(backupPath, content);
  return backupPath;
}

function formatBackupTimestampLocal(date) {
  // Use a stable local timestamp for filenames.
  // Europe/Paris corresponds to the commonly expected GMT+1 (with DST to GMT+2).
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);

  // 'sv-SE' yields 'YYYY-MM-DD HH:MM:SS'
  return parts.replace(' ', '_').replace(/:/g, '-');
}
