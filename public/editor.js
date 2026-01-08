(() => {
  const cfg = window.__EDITOR__ || { saveUrl: '/save', backupUrl: '/backup' };
  let editMode = true;
  const patches = new Map(); // key: path string, value: { path, oldValue, newValue }
  let searchHits = [];
  let currentHitIndex = -1;
  let highlightEls = [];
   let isDark = true;

  // Controls
  const controls = document.createElement('div');
  controls.className = 'editor-controls';
  controls.innerHTML = `
    <input type="search" class="editor-search-input" placeholder="Search…" />
    <button data-action="find">Find</button>
    <button data-action="prev">Prev</button>
    <button data-action="next">Next</button>
    <span class="editor-search-count"></span>
    <button data-action="clear-search" title="Clear search">✕</button>
    <span class="editor-controls-sep"></span>
     <button data-action="theme">Theme: Dark</button>
    <button data-action="toggle">Editing: On</button>
    <button data-action="save">Save</button>
    <button data-action="backup">Backup</button>
    <span class="editor-status" aria-live="polite"></span>
  `;
  // Append at the end of body to keep child indices stable
  window.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(controls);
  });

  const statusEl = () => controls.querySelector('.editor-status');
  const searchInputEl = () => controls.querySelector('.editor-search-input');
  const searchCountEl = () => controls.querySelector('.editor-search-count');
   const themeBtnEl = () => controls.querySelector('button[data-action="theme"]');

  controls.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'toggle') {
      editMode = !editMode;
      btn.textContent = `Editing: ${editMode ? 'On' : 'Off'}`;
      setStatus(editMode ? 'Editing enabled' : 'Editing disabled');
     } else if (action === 'theme') {
       isDark = !isDark;
       applyTheme();
       const t = themeBtnEl();
       if (t) t.textContent = `Theme: ${isDark ? 'Dark' : 'Light'}`;
       try { localStorage.setItem('editorTheme', isDark ? 'dark' : 'light'); } catch {}
    } else if (action === 'find') {
      const q = searchInputEl()?.value?.trim();
      performSearch(q);
    } else if (action === 'next') {
      gotoHit(currentHitIndex + 1);
    } else if (action === 'prev') {
      gotoHit(currentHitIndex - 1);
    } else if (action === 'clear-search') {
      clearSearch();
    } else if (action === 'save') {
      await savePatches();
    } else if (action === 'backup') {
      try {
        const res = await fetch(cfg.backupUrl, { method: 'POST' });
        const json = await res.json();
        if (json.ok) setStatus('Backup created');
        else setStatus('Backup failed');
      } catch (err) {
        setStatus('Backup error');
      }
    }
  });

  // Enter key in search input triggers find
  window.addEventListener('DOMContentLoaded', () => {
    const input = searchInputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch(input.value.trim());
      });
    }
  });
    window.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(controls);
      try {
        const pref = localStorage.getItem('editorTheme');
        if (pref === 'light') isDark = false;
      } catch {}
      applyTheme();
      const t = themeBtnEl();
      if (t) t.textContent = `Theme: ${isDark ? 'Dark' : 'Light'}`;
    });

  function setStatus(msg) {
    const el = statusEl();
    if (el) {
      el.textContent = msg;
      setTimeout(() => { el.textContent = ''; }, 2000);
    }
  }

  // Click-to-edit text node
  document.addEventListener('dblclick', (e) => {
    if (!editMode) return;
    const target = e.target;
    const { clientX: x, clientY: y } = e;
    const textNode = findTextNodeAtPoint(target, x, y);
    if (!textNode) return;

    const pathArr = computeNodePath(textNode);
    const key = pathArr.join('/');
    const oldValue = textNode.nodeValue;

    const rect = getTextNodeRect(textNode);
    const overlay = createOverlay(rect, oldValue);

    overlay.onCommit = (newValue) => {
      textNode.nodeValue = newValue;
      patches.set(key, { path: pathArr, oldValue, newValue });
      setStatus('Edited');
      // Refresh search overlays if a query is active
      const q = searchInputEl()?.value?.trim();
      if (q) performSearch(q);
    };
  }, true);

  async function savePatches() {
    if (!patches.size) {
      setStatus('No changes');
      return;
    }
    const payload = { patches: Array.from(patches.values()) };
    try {
      const res = await fetch(cfg.saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (json.ok) {
        setStatus('Saved');
        patches.clear();
      } else {
        setStatus('Save failed');
      }
    } catch (err) {
      setStatus('Save error');
    }
  }

  function findTextNodeAtPoint(element, x, y) {
    // Search text nodes under the clicked element
    const nodes = collectTextNodes(element);
    let best = null;
    for (const tn of nodes) {
      const rects = getTextNodeRects(tn);
      for (const r of rects) {
        if (pointInRect(x, y, r)) {
          return tn; // pick first that contains point
        }
        // fallback: nearest horizontally
        const dy = Math.abs((y) - (r.top + r.height / 2));
        const dx = Math.abs((x) - (r.left + r.width / 2));
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.dist) best = { node: tn, dist };
      }
    }
    return best?.node || null;
  }

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let cur;
    while ((cur = walker.nextNode())) out.push(cur);
    return out;
  }

  function performSearch(query) {
    clearHighlightsOnly();
    searchHits = [];
    currentHitIndex = -1;
    updateSearchCount();
    if (!query) return;

    const q = query.toLowerCase();
    const nodes = collectTextNodes(document.body);
    for (const tn of nodes) {
      const text = tn.nodeValue;
      let i = 0;
      while (true) {
        const idx = text.toLowerCase().indexOf(q, i);
        if (idx === -1) break;
        const range = document.createRange();
        range.setStart(tn, idx);
        range.setEnd(tn, idx + q.length);
        const rects = Array.from(range.getClientRects());
        const overlays = createHighlightOverlaysForRects(rects);
        const firstRect = rects[0];
        const pathArr = computeNodePath(tn);
        searchHits.push({ path: pathArr, node: tn, start: idx, end: idx + q.length, rect: firstRect, overlays });
        i = idx + q.length;
      }
    }
    updateSearchCount();
    if (searchHits.length) gotoHit(0);
  }

  function clearSearch() {
    clearHighlightsOnly();
    searchHits = [];
    currentHitIndex = -1;
    updateSearchCount();
    const input = searchInputEl();
    if (input) input.value = '';
  }

  function clearHighlightsOnly() {
    for (const el of highlightEls) el.remove();
    highlightEls = [];
  }

  function updateSearchCount() {
    const el = searchCountEl();
    if (!el) return;
    if (!searchHits.length) {
      el.textContent = '';
    } else {
      el.textContent = `${currentHitIndex + 1}/${searchHits.length}`;
    }
  }

  function gotoHit(index) {
    if (!searchHits.length) return;
    if (index < 0) index = searchHits.length - 1;
    if (index >= searchHits.length) index = 0;
    currentHitIndex = index;
    // Style current hit
    for (const hit of searchHits) {
      for (const el of hit.overlays) el.classList.remove('editor-search-hit--current');
    }
    const hit = searchHits[currentHitIndex];
    for (const el of hit.overlays) el.classList.add('editor-search-hit--current');
    updateSearchCount();
    // Scroll to hit
    if (hit.rect) {
      const top = hit.rect.top + window.scrollY - 80; // offset for comfort
      window.scrollTo({ top, behavior: 'smooth' });
    } else {
      hit.node.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function getTextNodeRects(tn) {
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = Array.from(range.getClientRects());
    range.detach?.();
    return rects;
  }

  function getTextNodeRect(tn) {
    const rects = getTextNodeRects(tn);
    return rects[0] || tn.parentElement.getBoundingClientRect();
  }

  function pointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function computeNodePath(node) {
    const path = [];
    let cur = node;
    while (cur) {
      const parent = cur.parentNode;
      if (!parent) break;
      const list = parent.nodeType === 9 ? [parent.documentElement] : parent.childNodes;
      const idx = Array.prototype.indexOf.call(list, cur);
      path.unshift(idx); // prepend
      cur = parent;
    }
    // At document level: implicit step from Document to documentElement
    return path;
  }

  function createOverlay(rect, value) {
    const ov = document.createElement('div');
    ov.className = 'editor-overlay';
    ov.style.left = `${Math.max(8, rect.left)}px`;
    ov.style.top = `${Math.max(8, rect.top)}px`;
    ov.style.width = `${Math.max(80, rect.width)}px`;

    const ta = document.createElement('textarea');
    ta.value = value;
    ov.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'overlay-actions';
    const ok = document.createElement('button');
    ok.textContent = 'Apply';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    actions.append(ok, cancel);
    ov.appendChild(actions);

    const close = () => ov.remove();

    ok.addEventListener('click', () => {
      ov.onCommit?.(ta.value);
      close();
    });
    cancel.addEventListener('click', close);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        ov.onCommit?.(ta.value);
        close();
      }
    });

    document.body.appendChild(ov);
    ta.focus();
    return ov;
  }

  function createHighlightOverlaysForRects(rects) {
    const out = [];
    for (const r of rects) {
      const el = document.createElement('div');
      el.className = 'editor-search-hit';
      el.style.left = `${r.left + window.scrollX}px`;
      el.style.top = `${r.top + window.scrollY}px`;
      el.style.width = `${Math.max(2, r.width)}px`;
      el.style.height = `${Math.max(14, r.height)}px`;
      document.body.appendChild(el);
      out.push(el);
      highlightEls.push(el);
    }
    return out;
  }

   function applyTheme() {
     document.documentElement.classList.toggle('editor-theme-dark', isDark);
   }
})();
