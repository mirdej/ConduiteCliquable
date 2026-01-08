import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import osc from 'osc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_FILE = path.join(__dirname, 'playScript.html');
const BACKUP_DIR = path.join(__dirname, 'backups');

const OSC_HOST = process.env.OSC_HOST || '10.0.1.7';
const OSC_PORT = Number(process.env.OSC_PORT || 9000);

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

    const updatedHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    await fs.writeFile(TARGET_FILE, updatedHtml, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/osc/go', (req, res) => {
  try {
    if (!oscReady) return res.status(503).json({ ok: false, error: 'OSC not ready' });

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

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Editor server running at http://localhost:${PORT}/edit`);
});

function injectEditor(html) {
  const toolbar = `\n<link rel=\"stylesheet\" href=\"/static/editor.css\">\n<script>window.__EDITOR__ = { saveUrl: '/save', saveHtmlUrl: '/saveHtml', backupUrl: '/backup', oscGoUrl: '/osc/go' }<\/script>\n<script src=\"/static/editor.js\" defer><\/script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${toolbar}\n</body>`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${toolbar}\n</head>`);
  }
  return html + toolbar;
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
