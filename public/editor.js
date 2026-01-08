(() => {
  const cfg = window.__EDITOR__ || {
    saveUrl: '/save',
    saveHtmlUrl: '/saveHtml',
    backupUrl: '/backup'
  };

  // Default to Play mode on load.
  let editMode = false;
  let playMode = true;
  let isDark = true;

  // Search state
  let searchHits = [];
  let currentHitIndex = -1;
  let highlightEls = [];

  // Pending cue state
  let pendingCueEl = null;
  let draggingCueEl = null;
  let selectedCueEl = null;
  let lastScriptRange = null;
  let lastPointer = null;
  let dropPlaceholderEl = null;
  let dropIndicatorEl = null;
  let lastDropKey = null;
  let draggingCueSize = null;
  let commentBubbleEl = null;

  // Controls (bottom-right)
  const controls = document.createElement('div');
  controls.className = 'editor-controls';
  controls.innerHTML = `
    <div class="editor-controls-left">
      <input type="search" class="editor-search-input" placeholder="Search…" />
      <button data-action="find">Find</button>
      <button data-action="prev">Prev</button>
      <button data-action="next">Next</button>
      <span class="editor-search-count"></span>
      <button data-action="clear-search" title="Clear search">✕</button>
      <span class="editor-controls-sep"></span>
      <span class="cue-label cue-label--template" data-template="1" draggable="true" title="Drag into the script to create a new cue">New cue. Drag me!</span>
      <span class="editor-status" aria-live="polite"></span>
    </div>
    <div class="editor-controls-right">
      <button data-action="mode">Mode: Edit</button>
      <button data-action="theme">Theme: Dark</button>
      <button data-action="toggle">Editing: On</button>
      <button data-action="save">Save</button>
    </div>
  `;

  // Play bar (fixed top)
  const playbar = document.createElement('div');
  playbar.className = 'editor-playbar';
  playbar.innerHTML = `
    <span class="playbar-title">Pending Cue:</span>
    <span class="playbar-pending-label">(none)</span>
    <label>Light <input class="playbar-light" type="text" /></label>
    <label>Video <input class="playbar-video" type="text" /></label>
    <label>Audio <input class="playbar-audio" type="text" /></label>
    <label>Comment <input class="playbar-comment" type="text" /></label>
    <span class="playbar-actions">
      <button data-action="cue-prev">Prev</button>
      <button data-action="cue-next">Next</button>
      <button class="go" data-action="cue-go">GO</button>
    </span>
  `;

  const playbarSpacer = document.createElement('div');
  playbarSpacer.className = 'editor-playbar-spacer';

  const statusEl = () => controls.querySelector('.editor-status');
  const searchInputEl = () => controls.querySelector('.editor-search-input');
  const searchCountEl = () => controls.querySelector('.editor-search-count');
  const themeBtnEl = () => controls.querySelector('button[data-action="theme"]');
  const modeBtnEl = () => controls.querySelector('button[data-action="mode"]');
  const toggleBtnEl = () => controls.querySelector('button[data-action="toggle"]');

  const pendingLabelEl = () => playbar.querySelector('.playbar-pending-label');
  const pendingLightEl = () => playbar.querySelector('.playbar-light');
  const pendingVideoEl = () => playbar.querySelector('.playbar-video');
  const pendingAudioEl = () => playbar.querySelector('.playbar-audio');
  const pendingCommentEl = () => playbar.querySelector('.playbar-comment');
  const goBtnEl = () => playbar.querySelector('button[data-action="cue-go"]');

  window.addEventListener('DOMContentLoaded', () => {
    // Mount play UI first (top), then spacer, then controls at end of body.
    document.body.prepend(playbar);
    document.body.prepend(playbarSpacer);
    document.body.appendChild(controls);

    // Theme init
    try {
      const pref = localStorage.getItem('editorTheme');
      if (pref === 'light') isDark = false;
    } catch {}
    applyTheme();
    const t = themeBtnEl();
    if (t) t.textContent = `Theme: ${isDark ? 'Dark' : 'Light'}`;

    // Search input Enter triggers find
    const input = searchInputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch(input.value.trim());
      });
    }

    // Ensure any existing cue labels behave properly
    updateCueInteractivity();
    // Sync UI labels + visuals to initial mode.
    syncModeUi();
    applyMode();
  });

  function ensureCommentBubble() {
    if (commentBubbleEl) return commentBubbleEl;
    const el = document.createElement('div');
    el.className = 'editor-comment-bubble';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    commentBubbleEl = el;
    return el;
  }

  function positionCommentBubble() {
    if (!commentBubbleEl) return;
    if (!pendingCueEl) return;
    if (!commentBubbleEl.classList.contains('is-visible')) return;

    const cueRect = pendingCueEl.getBoundingClientRect();
    const bubbleRect = commentBubbleEl.getBoundingClientRect();
    const pad = 12;
    const gap = 10;

    // Prefer to the right of the cue; if not enough space, go left; if still tight, go below.
    let x = cueRect.right + gap;
    let y = cueRect.top - 6;

    if (x + bubbleRect.width + pad > window.innerWidth) {
      x = cueRect.left - gap - bubbleRect.width;
    }

    if (x < pad) {
      x = Math.min(window.innerWidth - pad - bubbleRect.width, cueRect.left);
      y = cueRect.bottom + gap;
    }

    x = Math.max(pad, Math.min(window.innerWidth - pad - bubbleRect.width, x));
    y = Math.max(pad, Math.min(window.innerHeight - pad - bubbleRect.height, y));

    commentBubbleEl.style.left = `${Math.round(x)}px`;
    commentBubbleEl.style.top = `${Math.round(y)}px`;
  }

  function updateCommentBubble() {
    const el = ensureCommentBubble();
    const comment = (pendingCueEl?.dataset?.comment || '').trim();
    const shouldShow = Boolean(playMode && comment.length);
    el.textContent = comment;
    el.classList.toggle('is-visible', shouldShow);
    // Position after layout updates.
    requestAnimationFrame(positionCommentBubble);
  }

  // Keep comment bubble near the cue if the page scrolls/resizes.
  window.addEventListener('scroll', () => {
    requestAnimationFrame(positionCommentBubble);
  }, true);
  window.addEventListener('resize', () => {
    requestAnimationFrame(positionCommentBubble);
  });

  function templateCueEl() {
    return controls.querySelector('.cue-label--template');
  }

  // Keyboard shortcut: Cmd/Ctrl+E toggles Play/Edit mode.
  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if (key !== 'e') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    e.preventDefault();
    setMode(!playMode);
  });

  // Keyboard shortcut: Cmd/Ctrl+S triggers Save.
  document.addEventListener('keydown', async (e) => {
    const key = (e.key || '').toLowerCase();
    if (key !== 's') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey || e.altKey) return;
    // If the inline overlay editor is open, let it handle Cmd+S.
    if (document.activeElement?.closest?.('.editor-overlay')) return;
    e.preventDefault();
    await saveHtml();
  });

  // Delete selected cue in Edit mode (Delete/Backspace). Esc clears selection.
  document.addEventListener('keydown', (e) => {
    if (!(editMode && !playMode)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (e.key === 'Escape') {
      clearSelectedCue();
      return;
    }
    if (!selectedCueEl) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();
    deleteCue(selectedCueEl);
  });

  // Track last meaningful selection/click inside the script content.
  document.addEventListener('selectionchange', () => {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      const container = r.commonAncestorContainer.nodeType === 1
        ? r.commonAncestorContainer
        : r.commonAncestorContainer.parentElement;
      if (!container) return;
      if (container.closest?.('.editor-controls, .editor-playbar')) return;
      lastScriptRange = r.cloneRange();
    } catch {
      // ignore
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target?.closest?.('.editor-controls, .editor-playbar')) return;
    lastPointer = { x: e.clientX, y: e.clientY };
  }, true);

  controls.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.getAttribute('data-action');

    if (action === 'toggle') {
      editMode = !editMode;
      const b = toggleBtnEl();
      if (b) b.textContent = `Editing: ${editMode ? 'On' : 'Off'}`;
      setStatus(editMode ? 'Editing enabled' : 'Editing disabled');
      applyEditModeVisual();
      updateCueInteractivity();
      return;
    }

    if (action === 'mode') {
      setMode(!playMode);
      return;
    }

    if (action === 'theme') {
      isDark = !isDark;
      applyTheme();
      const b = themeBtnEl();
      if (b) b.textContent = `Theme: ${isDark ? 'Dark' : 'Light'}`;
      try { localStorage.setItem('editorTheme', isDark ? 'dark' : 'light'); } catch {}
      return;
    }

    // (Add Cue button removed; use the draggable template badge.)

    if (action === 'find') {
      performSearch(searchInputEl()?.value?.trim());
      return;
    }
    if (action === 'next') {
      gotoHit(currentHitIndex + 1);
      return;
    }
    if (action === 'prev') {
      gotoHit(currentHitIndex - 1);
      return;
    }
    if (action === 'clear-search') {
      clearSearch();
      return;
    }

    if (action === 'save') {
      await saveHtml();
      return;
    }
  });

  playbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'cue-prev') gotoCueByDelta(-1);
    if (action === 'cue-next') gotoCueByDelta(1);
    if (action === 'cue-go') triggerPendingCueAndAdvance();
  });

  playbar.addEventListener('input', () => {
    if (!pendingCueEl) return;
    pendingCueEl.dataset.light = pendingLightEl()?.value ?? '';
    pendingCueEl.dataset.video = pendingVideoEl()?.value ?? '';
    pendingCueEl.dataset.audio = pendingAudioEl()?.value ?? '';
    pendingCueEl.dataset.comment = pendingCommentEl()?.value ?? '';
    updateCommentBubble();
  });

  function setStatus(msg) {
    const el = statusEl();
    if (el) {
      el.textContent = msg;
      setTimeout(() => { el.textContent = ''; }, 2000);
    }
  }

  function applyTheme() {
    document.documentElement.classList.toggle('editor-theme-dark', isDark);
  }

  function applyEditModeVisual() {
    document.documentElement.classList.toggle('editor-edit-mode', Boolean(editMode && !playMode));
    const tmpl = templateCueEl();
    if (tmpl) tmpl.style.display = (editMode && !playMode) ? 'inline-block' : 'none';
  }

  function applyGoEnabledState() {
    const go = goBtnEl();
    if (!go) return;
    const disabled = Boolean(editMode && !playMode);
    go.disabled = disabled;
    go.setAttribute('aria-disabled', String(disabled));
  }

  function syncModeUi() {
    const b = modeBtnEl();
    if (b) b.textContent = `Mode: ${playMode ? 'Play' : 'Edit'}`;
    const eb = toggleBtnEl();
    if (eb) eb.textContent = `Editing: ${editMode ? 'On' : 'Off'}`;
    applyEditModeVisual();
    applyGoEnabledState();
    updateCommentBubble();
  }

  function setMode(nextPlayMode) {
    // Preserve exact scroll position when toggling modes.
    const sx = window.scrollX;
    const sy = window.scrollY;

    playMode = Boolean(nextPlayMode);
    editMode = !playMode;
    // Don't keep an edit-selection when leaving edit mode.
    if (!(editMode && !playMode)) clearSelectedCue();
    syncModeUi();
    applyMode({ preserveScroll: true });
    updateCueInteractivity();

    window.scrollTo(sx, sy);
  }

  function applyMode(opts = {}) {
    // Keep playbar visible in both modes so cue fields are always editable.
    playbar.classList.add('is-visible');
    playbarSpacer.classList.add('is-visible');
    applyEditModeVisual();
    applyGoEnabledState();

    // If nothing selected, default to first cue (in either mode).
    const shouldPreserveScroll = Boolean(opts.preserveScroll);
    if (!pendingCueEl) {
      const cues = getCueLabels();
      if (cues.length) setPendingCue(cues[0], { scroll: !shouldPreserveScroll });
      else setPendingCue(null);
    } else {
      setPendingCue(pendingCueEl, { scroll: !shouldPreserveScroll });
    }

    updateCommentBubble();
  }

  // Click-to-edit text node (text only)
  document.addEventListener('dblclick', (e) => {
    if (!editMode) return;
    if (e.target?.closest?.('.cue-label')) return;
    if (e.target?.closest?.('.editor-controls, .editor-playbar')) return;
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
      setStatus('Edited');
      // Refresh search overlays if a query is active
      const q = searchInputEl()?.value?.trim();
      if (q) performSearch(q);
    };
  }, true);

  async function saveHtml() {
    const nextSaveNumber = getSaveCount() + 1;
    if (nextSaveNumber % 5 === 0) {
      await maybeAutoBackup();
    }
    const html = serializeCleanHtml();
    try {
      const res = await fetch(cfg.saveHtmlUrl || '/saveHtml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html })
      });
      const json = await res.json();
      if (json.ok) {
        setSaveCount(nextSaveNumber);
        setStatus('Saved');
      }
      else setStatus('Save failed');
    } catch {
      setStatus('Save error');
    }
  }

  function getSaveCount() {
    try {
      const raw = localStorage.getItem('editorSaveCount');
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  function setSaveCount(n) {
    try { localStorage.setItem('editorSaveCount', String(n)); } catch {}
  }

  async function maybeAutoBackup() {
    try {
      const res = await fetch(cfg.backupUrl, { method: 'POST' });
      const json = await res.json();
      if (json.ok) setStatus('Auto-backup created');
      else setStatus('Auto-backup failed');
    } catch {
      setStatus('Auto-backup error');
    }
  }

  function serializeCleanHtml() {
    const htmlEl = document.documentElement.cloneNode(true);

    // Remove injected editor artifacts
    htmlEl.querySelectorAll('.editor-controls, .editor-overlay, .editor-search-hit, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .cue-drop-placeholder, .editor-drop-indicator').forEach((n) => n.remove());
    htmlEl.querySelectorAll('script[src="/static/editor.js"], link[href="/static/editor.css"]').forEach((n) => n.remove());
    htmlEl.querySelectorAll('script').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t.includes('window.__EDITOR__')) s.remove();
    });
    htmlEl.classList.remove('editor-theme-dark');
    htmlEl.classList.remove('editor-edit-mode');
    htmlEl.querySelectorAll('.cue-label--selected').forEach((n) => n.classList.remove('cue-label--selected'));

    return '<!DOCTYPE html>\n' + htmlEl.outerHTML;
  }

  function setSelectedCue(el) {
    if (selectedCueEl === el) return;
    if (selectedCueEl) selectedCueEl.classList.remove('cue-label--selected');
    selectedCueEl = el;
    if (selectedCueEl) selectedCueEl.classList.add('cue-label--selected');
  }

  function clearSelectedCue() {
    if (!selectedCueEl) return;
    selectedCueEl.classList.remove('cue-label--selected');
    selectedCueEl = null;
  }

  function deleteCue(el) {
    if (!el) return;
    if (el.classList.contains('cue-label--template')) return;
    if (pendingCueEl === el) setPendingCue(null);
    if (selectedCueEl === el) selectedCueEl = null;
    try { el.remove(); } catch {}
    setStatus('Cue deleted');
  }

  // Cue labels
  function getCueLabels() {
    return Array.from(document.querySelectorAll('.cue-label:not(.cue-label--template)'));
  }

  function nextCueName() {
    const existing = getCueLabels()
      .map((el) => el.dataset.name)
      .filter(Boolean);
    const usedNums = existing
      .map((s) => /^C(\d+)$/.exec(s))
      .map((m) => (m ? Number(m[1]) : null))
      .filter((n) => Number.isFinite(n));
    const next = (usedNums.length ? Math.max(...usedNums) : 0) + 1;
    return `C${next}`;
  }

  function createCueLabel(name) {
    const el = document.createElement('span');
    el.className = 'cue-label';
    const id = (globalThis.crypto?.randomUUID?.() || `cue-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    el.dataset.cueId = id;
    el.dataset.name = (name && String(name).trim()) ? String(name).trim() : nextCueName();
    el.dataset.light = '';
    el.dataset.video = '';
    el.dataset.audio = '';
    el.dataset.comment = '';
    el.textContent = el.dataset.name;
    el.setAttribute('draggable', 'false');
    return el;
  }

  function updateCueInteractivity() {
    for (const el of getCueLabels()) {
      el.dataset.mode = editMode && !playMode ? 'edit' : 'play';
      el.setAttribute('draggable', String(Boolean(editMode && !playMode)));
    }
  }

  function addCueAtSelection() {
    const suggested = nextCueName();
    const name = window.prompt('Cue name:', suggested);
    if (name === null) return;

    const cue = createCueLabel(name);

    // Prefer current selection if it’s in script content. Clicking the controls often
    // clears the selection, so we fall back to the last known script selection/click.
    let range = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        const container = r.commonAncestorContainer.nodeType === 1
          ? r.commonAncestorContainer
          : r.commonAncestorContainer.parentElement;
        if (container && !container.closest?.('.editor-controls, .editor-playbar')) {
          range = r;
        }
      }
    } catch {
      // ignore
    }

    if (!range && lastScriptRange) range = lastScriptRange.cloneRange();
    if (!range && lastPointer) range = caretRangeFromPoint(lastPointer.x, lastPointer.y);

    if (range) {
      range.collapse(true);
      range.insertNode(cue);
      cue.after(document.createTextNode(' '));
      updateCueInteractivity();
      setStatus('Cue added');
      return;
    }

    // Last resort: append at end of document (before the controls).
    document.body.insertBefore(cue, controls);
    cue.after(document.createTextNode(' '));
    updateCueInteractivity();
    setStatus('Cue added (appended)');
  }

  function setPendingCue(el, opts = {}) {
    if (pendingCueEl) pendingCueEl.classList.remove('cue-label--pending');
    pendingCueEl = el;
    if (pendingCueEl) pendingCueEl.classList.add('cue-label--pending');

    const label = pendingLabelEl();
    if (!pendingCueEl) {
      if (label) label.textContent = '(none)';
      if (pendingLightEl()) pendingLightEl().value = '';
      if (pendingVideoEl()) pendingVideoEl().value = '';
      if (pendingAudioEl()) pendingAudioEl().value = '';
      if (pendingCommentEl()) pendingCommentEl().value = '';
      return;
    }

    if (label) label.textContent = pendingCueEl.dataset.name || '(cue)';
    if (pendingLightEl()) pendingLightEl().value = pendingCueEl.dataset.light || '';
    if (pendingVideoEl()) pendingVideoEl().value = pendingCueEl.dataset.video || '';
    if (pendingAudioEl()) pendingAudioEl().value = pendingCueEl.dataset.audio || '';
    if (pendingCommentEl()) pendingCommentEl().value = pendingCueEl.dataset.comment || '';

    const shouldScroll = opts.scroll !== false;
    if (shouldScroll) {
      pendingCueEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateCommentBubble();
  }

  function gotoCueByDelta(delta) {
    const cues = getCueLabels();
    if (!cues.length) return;
    const idx = pendingCueEl ? cues.indexOf(pendingCueEl) : -1;
    const nextIdx = idx === -1 ? 0 : Math.min(cues.length - 1, Math.max(0, idx + delta));
    setPendingCue(cues[nextIdx]);
  }

  function triggerPendingCueAndAdvance() {
    if (!pendingCueEl) return;
    const payload = {
      name: pendingCueEl.dataset.name || '',
      light: pendingCueEl.dataset.light || '',
      video: pendingCueEl.dataset.video || '',
      audio: pendingCueEl.dataset.audio || '',
      comment: pendingCueEl.dataset.comment || ''
    };
    // Placeholder until OSC/MIDI is implemented
    console.log('[CUE GO]', payload);
    setStatus(`GO ${payload.name}`);

    const cues = getCueLabels();
    const idx = cues.indexOf(pendingCueEl);
    if (idx >= 0 && idx + 1 < cues.length) setPendingCue(cues[idx + 1]);
  }

  // Cue click selects pending cue in play mode
  document.addEventListener('click', (e) => {
    const cue = e.target?.closest?.('.cue-label');
    if (cue && cue.classList.contains('cue-label--template')) return;

    if (playMode) {
      if (!cue) return;
      e.preventDefault();
      setPendingCue(cue);
      return;
    }

    if (editMode && !playMode) {
      if (cue) {
        e.preventDefault();
        setSelectedCue(cue);
        // Also load cue into playbar fields for editing.
        setPendingCue(cue);
        setStatus('Cue selected (Del to delete)');
      } else {
        clearSelectedCue();
      }
    }
  }, true);

  // Drag/drop cue movement (edit mode only)
  document.addEventListener('dragstart', (e) => {
    const cue = e.target?.closest?.('.cue-label');
    if (!cue) return;
    if (!(editMode && !playMode)) {
      e.preventDefault();
      return;
    }
    clearDropPreview();
    const isTemplate = cue.classList.contains('cue-label--template') || cue.dataset.template === '1';
    draggingCueEl = isTemplate ? createCueLabel('') : cue;
    draggingCueEl.dataset.fromTemplate = isTemplate ? '1' : '';
    const r = cue.getBoundingClientRect();
    draggingCueSize = { w: Math.max(20, r.width), h: Math.max(14, r.height) };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require data to be set for drag events to work.
      e.dataTransfer.setData('text/plain', cue.dataset.cueId || cue.dataset.name || 'cue');
    }
  });

  document.addEventListener('dragover', (e) => {
    if (!draggingCueEl) return;
    if (e.target?.closest?.('.editor-controls, .editor-playbar')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const range = caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) return;
    normalizeRangeForCueDrop(range);
    showDropPreviewAtRange(range);
  });

  document.addEventListener('drop', (e) => {
    if (!draggingCueEl) return;
    if (e.target?.closest?.('.editor-controls, .editor-playbar')) return;
    e.preventDefault();

    const range = caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) return;

    normalizeRangeForCueDrop(range);
    clearDropPreview();

    range.collapse(true);
    range.insertNode(draggingCueEl);
    draggingCueEl.after(document.createTextNode(' '));
    updateCueInteractivity();

    if (draggingCueEl.dataset.fromTemplate === '1') {
      const suggested = nextCueName();
      const name = window.prompt('Cue name:', suggested);
      if (name === null) {
        try { draggingCueEl.remove(); } catch {}
        setStatus('Cancelled');
      } else {
        const finalName = String(name).trim() || suggested;
        draggingCueEl.dataset.name = finalName;
        draggingCueEl.textContent = finalName;
        draggingCueEl.dataset.fromTemplate = '';
        setStatus('Cue added');
      }
    } else {
      setStatus('Cue moved');
    }
  });

  document.addEventListener('dragend', () => {
    draggingCueEl = null;
    draggingCueSize = null;
    clearDropPreview();
  });

  function normalizeRangeForCueDrop(range) {
    const n = range.startContainer;
    const el = n?.nodeType === 1 ? n : n?.parentElement;
    const inCue = el?.closest?.('.cue-label');
    if (inCue) {
      try {
        range.setStartAfter(inCue);
        range.setEndAfter(inCue);
      } catch {
        // ignore
      }
    }
  }

  function rangeKey(range) {
    try {
      const node = range.startContainer;
      const path = computeNodePath(node);
      return `${path.join('/')}:${range.startOffset}`;
    } catch {
      return null;
    }
  }

  function ensureDropIndicator() {
    if (dropIndicatorEl) return dropIndicatorEl;
    const el = document.createElement('div');
    el.className = 'editor-drop-indicator';
    document.body.appendChild(el);
    dropIndicatorEl = el;
    return el;
  }

  function ensureDropPlaceholder() {
    if (dropPlaceholderEl) return dropPlaceholderEl;
    const el = document.createElement('span');
    el.className = 'cue-drop-placeholder';
    dropPlaceholderEl = el;
    return el;
  }

  function showDropPreviewAtRange(range) {
    const key = rangeKey(range);
    const indicator = ensureDropIndicator();

    // Position indicator at caret
    const rect = range.getClientRects?.()[0] || range.getBoundingClientRect?.();
    if (rect) {
      indicator.style.left = `${rect.left + window.scrollX}px`;
      indicator.style.top = `${rect.top + window.scrollY}px`;
      indicator.style.height = `${Math.max(18, rect.height || 0)}px`;
      indicator.style.display = 'block';
    }

    // Only move placeholder when the insertion point actually changes.
    if (key && key === lastDropKey) return;
    lastDropKey = key;

    const placeholder = ensureDropPlaceholder();
    placeholder.classList.remove('is-visible');
    placeholder.style.width = `${Math.round(draggingCueSize?.w || 60)}px`;
    placeholder.style.height = `${Math.round(draggingCueSize?.h || 24)}px`;

    try {
      placeholder.remove();
    } catch {}

    try {
      const r = range.cloneRange();
      r.collapse(true);
      r.insertNode(placeholder);
      requestAnimationFrame(() => {
        placeholder.classList.add('is-visible');
      });
    } catch {
      // ignore
    }
  }

  function clearDropPreview() {
    lastDropKey = null;
    if (dropPlaceholderEl) {
      try { dropPlaceholderEl.remove(); } catch {}
      dropPlaceholderEl = null;
    }
    if (dropIndicatorEl) {
      try { dropIndicatorEl.remove(); } catch {}
      dropIndicatorEl = null;
    }
  }

  function caretRangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.setEnd(pos.offsetNode, pos.offset);
    return range;
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

})();
