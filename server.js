import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET_FILE = path.join(__dirname, 'playScript.html');
const BACKUP_DIR = path.join(__dirname, 'backups');

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

app.listen(PORT, () => {
  console.log(`Editor server running at http://localhost:${PORT}/edit`);
});

function injectEditor(html) {
  const toolbar = `\n<link rel=\"stylesheet\" href=\"/static/editor.css\">\n<script>window.__EDITOR__ = { saveUrl: '/save', backupUrl: '/backup' }<\/script>\n<script src=\"/static/editor.js\" defer><\/script>`;
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
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const { name, ext } = path.parse(filePath);
  const backupName = `${name}.backup-${ts}${ext || '.html'}`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  const content = await fs.readFile(filePath);
  await fs.writeFile(backupPath, content);
  return backupPath;
}
