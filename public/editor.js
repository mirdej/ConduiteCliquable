(() => {
  const cfg = window.__EDITOR__ || {
    saveUrl: '/save',
    saveHtmlUrl: '/saveHtml',
    backupUrl: '/backup',
    oscGoUrl: '/osc/go',
    eventsUrl: '/events'
  };

  // Default to Play mode on load.
  let editMode = false;
  let playMode = true;
  let isDark = true;

  // Keyboard shortcut state
  let spacebarGoShortcutEnabled = true;

  // Search state
  let searchHits = [];
  let currentHitIndex = -1;
  let highlightEls = [];

  // Pending cue state
  let pendingCueEl = null;
  let draggingCueEl = null;
  let selectedCueEl = null;
  let selectedDomEl = null;
  let lastScriptRange = null;
  let lastPointer = null;
  let dropPlaceholderEl = null;
  let dropIndicatorEl = null;
  let lastDropKey = null;
  let draggingCueSize = null;
  let commentBubbleEl = null;
  let tocPanelEl = null;
  let tocListEl = null;
  let tocVisible = false;
  let lastTriggeredCueId = '';

  // Controls (bottom-right)
  const controls = document.createElement('div');
  controls.className = 'editor-controls';
  controls.innerHTML = `
    <div class="editor-controls-left">
      <input type="search" class="editor-search-input" placeholder="Search…" />
      <button class="editor-btn-search" data-action="find" title="Find" aria-label="Find">
        <svg class="editor-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M10 4a6 6 0 1 0 3.7 10.7l4.8 4.8 1.4-1.4-4.8-4.8A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/>
        </svg>
      </button>
      <button class="editor-btn-search" data-action="prev" title="Previous match">Prev</button>
      <button class="editor-btn-search" data-action="next" title="Next match">Next</button>
      <span class="editor-search-count"></span>
      <button class="editor-btn-search" data-action="clear-search" title="Clear search" aria-label="Clear search">✕</button>
      <span class="editor-controls-sep"></span>
      <span class="cue-label cue-label--template" data-template="1" draggable="true" title="Drag into the script to create a new cue">New cue. Drag me!</span>
      <span class="editor-status" aria-live="polite"></span>
    </div>
    <div class="editor-controls-right">
      <button data-action="mode">Mode: Edit</button>
      <button data-action="toggle">Editing: On</button>
      <button data-action="spacebar-go" title="Enable/disable Spacebar to GO">Space GO: On</button>
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
    <label>Tracker <input class="playbar-tracker" type="text" /></label>
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
  const modeBtnEl = () => controls.querySelector('button[data-action="mode"]');
  const toggleBtnEl = () => controls.querySelector('button[data-action="toggle"]');
  const spacebarGoBtnEl = () => controls.querySelector('button[data-action="spacebar-go"]');

  const pendingLabelEl = () => playbar.querySelector('.playbar-pending-label');
  const pendingLightEl = () => playbar.querySelector('.playbar-light');
  const pendingVideoEl = () => playbar.querySelector('.playbar-video');
  const pendingAudioEl = () => playbar.querySelector('.playbar-audio');
  const pendingTrackerEl = () => playbar.querySelector('.playbar-tracker');
  const pendingCommentEl = () => playbar.querySelector('.playbar-comment');
  const goBtnEl = () => playbar.querySelector('button[data-action="cue-go"]');

  window.addEventListener('DOMContentLoaded', () => {
    // Mount play UI first (top), then spacer, then controls at end of body.
    document.body.prepend(playbar);
    document.body.prepend(playbarSpacer);
    document.body.appendChild(controls);

    mountCueTocPanel();

    // Theme init
    try {
      const pref = localStorage.getItem('editorTheme');
      if (pref === 'light') isDark = false;
    } catch {}

    // Spacebar GO shortcut init
    try {
      const pref = localStorage.getItem('editorSpacebarGo');
      if (pref === '0') spacebarGoShortcutEnabled = false;
      if (pref === '1') spacebarGoShortcutEnabled = true;
    } catch {}
    applyTheme();


    // Search input Enter triggers find
    const input = searchInputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch(input.value.trim());
      });

      input.addEventListener('input', () => {
        updateSearchUi();
      });
    }

    // Ensure any existing cue labels behave properly
    updateCueInteractivity();
    // Sync UI labels + visuals to initial mode.
    syncModeUi();
    applyMode();

    // Slide in TOC after first paint.
    requestAnimationFrame(() => {
      setTocVisible(true);
    });

    updateSearchUi();

    // Remote control (OSC -> server -> SSE)
    try {
      const es = new EventSource(cfg.eventsUrl || '/events');
      es.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        const cmd = String(data?.cmd || '');
        if (cmd === 'go') {
          // Match the GO button behavior: ignore if GO is disabled.
          const go = goBtnEl();
          if (go?.disabled) return;
          triggerPendingCueAndAdvance();
        }
        if (cmd === 'prev') {
          gotoCueByDelta(-1);
        }
        if (cmd === 'next') {
          gotoCueByDelta(1);
        }
      });
    } catch {
      // ignore
    }
  });

  function applySpacebarGoShortcutUi() {
    const b = spacebarGoBtnEl();
    if (!b) return;
    b.textContent = `Space GO: ${spacebarGoShortcutEnabled ? 'On' : 'Off'}`;
    b.setAttribute('aria-pressed', String(spacebarGoShortcutEnabled));
  }

  function isTypingContext() {
    const active = document.activeElement;
    const tag = active?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return true;
    if (active?.closest?.('.editor-overlay')) return true;
    return false;
  }

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

  function mountCueTocPanel() {
    if (tocPanelEl) return;
    const panel = document.createElement('aside');
    panel.className = 'editor-toc';
    panel.innerHTML = `
      <button class="editor-toc-toggle" type="button" aria-label="Toggle cue list" title="Toggle cue list">›</button>
      <div class="editor-toc-header">Cues</div>
      <div class="editor-toc-list" role="navigation" aria-label="Cue list"></div>
    `;
    tocPanelEl = panel;
    tocListEl = panel.querySelector('.editor-toc-list');
    document.body.appendChild(panel);

    const toggle = panel.querySelector('.editor-toc-toggle');
    toggle?.addEventListener('click', (e) => {
      e.preventDefault();
      setTocVisible(!tocVisible);
    });

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cue-id]');
      if (!btn) return;
      const cueId = btn.getAttribute('data-cue-id');
      if (!cueId) return;
      const cue = document.querySelector(`.cue-label[data-cue-id="${cssEscape(cueId)}"]`);
      if (!cue) return;
      setPendingCue(cue);
    });
  }

  function setTocVisible(next) {
    tocVisible = Boolean(next);
    if (!tocPanelEl) return;
    tocPanelEl.classList.toggle('is-visible', tocVisible);
    const toggle = tocPanelEl.querySelector('.editor-toc-toggle');
    if (toggle) toggle.textContent = tocVisible ? '›' : '‹';
  }

  function refreshCueToc() {
    if (!tocListEl) return;
    const cues = getCueLabels();
    const pendingId = pendingCueEl?.dataset?.cueId || '';

    tocListEl.innerHTML = '';
    for (const cue of cues) {
      const cueId = cue.dataset.cueId || '';
      const name = (cue.dataset.name || cue.textContent || '').trim() || '(cue)';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'editor-toc-item';
      if (cueId && cueId === pendingId) item.classList.add('is-active');
      if (cueId && cueId === lastTriggeredCueId) item.classList.add('is-triggered');
      item.setAttribute('data-cue-id', cueId);

      const indicator = [
        (cue.dataset.light || '').trim() ? 'L' : '',
        (cue.dataset.video || '').trim() ? 'V' : '',
        (cue.dataset.audio || '').trim() ? 'A' : '',
        (cue.dataset.tracker || '').trim() ? 'T' : '',
        (cue.dataset.comment || '').trim() ? 'C' : ''
      ].join('');

      const nameEl = document.createElement('span');
      nameEl.className = 'editor-toc-item-name';
      nameEl.textContent = name;

      const indEl = document.createElement('span');
      indEl.className = 'editor-toc-item-ind';
      indEl.textContent = indicator;
      indEl.style.display = indicator ? 'inline' : 'none';

      item.appendChild(nameEl);
      item.appendChild(indEl);
      tocListEl.appendChild(item);
    }
  }

  function cssEscape(str) {
    if (globalThis.CSS?.escape) return CSS.escape(str);
    return String(str).replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
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

  // Keyboard shortcut (macOS): Cmd+G finds next.
  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if (key !== 'g') return;
    if (!e.metaKey) return;
    if (e.ctrlKey || e.altKey || e.shiftKey) return;

    const query = searchInputEl()?.value?.trim() || '';
    if (!query) return;

    e.preventDefault();

    // If there isn't an active result set yet, run the search first.
    if (!searchHits.length) {
      performSearch(query);
      return;
    }

    gotoHit(currentHitIndex + 1);
  });

  // Keyboard shortcut: Space triggers GO (optional).
  document.addEventListener('keydown', (e) => {
    if (isTypingContext()) return;

    const isSpace = e.code === 'Space' || e.key === ' ';
    if (!isSpace) return;

    // Don't steal browser/system shortcuts.
    if (e.metaKey || e.ctrlKey) return;

    // Extra navigation shortcuts (only when Space GO is enabled)
    if (spacebarGoShortcutEnabled && playMode) {
      if (e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (e.repeat) return;
        gotoCueByDelta(-1);
        return;
      }
      if (e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (e.repeat) return;
        gotoCueByDelta(1);
        return;
      }
    }

    // Plain Space: always prevent page scroll (even when Space GO is disabled).
    if (!e.shiftKey && !e.altKey) {
      e.preventDefault();
    } else {
      // With modifiers, only block defaults if we handled it above.
      return;
    }

    // Only trigger GO if shortcut is enabled, in play mode, and not repeating.
    if (!spacebarGoShortcutEnabled) return;
    if (!playMode) return;
    if (e.repeat) return;

    // Only handle if GO is currently enabled.
    const go = goBtnEl();
    if (go?.disabled) return;

    triggerPendingCueAndAdvance();
  });

  // Delete selected cue in Edit mode (Delete/Backspace). Esc clears selection.
  document.addEventListener('keydown', (e) => {
    if (!(editMode && !playMode)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (e.key === 'Escape') {
      clearSelectedCue();
      clearSelectedDomEl();
      return;
    }
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();

    if (selectedCueEl) {
      deleteCue(selectedCueEl);
      return;
    }
    if (selectedDomEl) {
      deleteDomEl(selectedDomEl);
      clearSelectedDomEl();
    }
  });

  // Keyboard shortcut: Cmd/Ctrl+Enter edits selected element outerHTML.
  document.addEventListener('keydown', (e) => {
    if (!(editMode && !playMode)) return;
    if (isTypingContext()) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.shiftKey || e.altKey) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const el = selectedDomEl || selectedCueEl;
    if (!el) return;
    editElementOuterHtml(el);
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

    if (action === 'spacebar-go') {
      spacebarGoShortcutEnabled = !spacebarGoShortcutEnabled;
      applySpacebarGoShortcutUi();
      setStatus(spacebarGoShortcutEnabled ? 'Spacebar GO enabled' : 'Spacebar GO disabled');
      try { localStorage.setItem('editorSpacebarGo', spacebarGoShortcutEnabled ? '1' : '0'); } catch {}
      return;
    }

    if (action === 'mode') {
      setMode(!playMode);
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
    pendingCueEl.dataset.tracker = pendingTrackerEl()?.value ?? '';
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

  function isWysiwygActive() {
    return Boolean(editMode && !playMode);
  }

  function isInEditorUi(node) {
    return Boolean(node?.closest?.('.editor-controls, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .editor-overlay, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator'));
  }

  function applyWysiwygEditableState() {
    const enabled = Boolean(editMode && !playMode);

    // Turn the page into a WYSIWYG editor in Edit mode.
    if (enabled) document.body.setAttribute('contenteditable', 'true');
    else document.body.removeAttribute('contenteditable');

    // Always protect injected UI from edits.
    document.querySelectorAll('.editor-controls, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .editor-overlay, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator').forEach((n) => {
      try { n.setAttribute('contenteditable', 'false'); } catch {}
    });

    // Keep cue labels controlled (rename via our prompt so dataset stays in sync).
    document.querySelectorAll('.cue-label').forEach((n) => {
      try { n.setAttribute('contenteditable', 'false'); } catch {}
    });

    if (!enabled) clearSelectedDomEl();
  }

  function setSelectedDomEl(el) {
    if (selectedDomEl === el) return;
    if (selectedDomEl) selectedDomEl.classList.remove('editor-dom-selected');
    selectedDomEl = el;
    if (selectedDomEl) selectedDomEl.classList.add('editor-dom-selected');
  }

  function clearSelectedDomEl() {
    if (!selectedDomEl) return;
    selectedDomEl.classList.remove('editor-dom-selected');
    selectedDomEl = null;
  }

  function deleteDomEl(el) {
    if (!el) return;
    if (isInEditorUi(el)) return;
    const tag = String(el.tagName || '').toUpperCase();
    if (!tag || tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') return;
    try {
      el.remove();
      setStatus('Deleted');
    } catch {
      // ignore
    }
  }

  function editElementOuterHtml(el) {
    if (!el) return;
    if (isInEditorUi(el)) return;
    const tag = String(el.tagName || '').toUpperCase();
    if (!tag || tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') return;

    const rect = el.getBoundingClientRect();
    const oldHtml = el.outerHTML;
    const overlay = createOverlay(rect, oldHtml);
    overlay.onCommit = (newValue) => {
      const html = String(newValue || '').trim();
      if (!html) return;
      const t = document.createElement('template');
      t.innerHTML = html;
      const nodes = Array.from(t.content.childNodes);
      if (!nodes.length) return;
      const firstEl = nodes.find((n) => n.nodeType === 1) || null;
      el.replaceWith(...nodes);
      if (firstEl) setSelectedDomEl(firstEl);
      updateCueInteractivity();
      refreshCueToc();
      const q = searchInputEl()?.value?.trim();
      if (q) performSearch(q);
      setStatus('HTML updated');
    };
  }

  function applyEditModeVisual() {
    document.documentElement.classList.toggle('editor-edit-mode', Boolean(editMode && !playMode));
    const tmpl = templateCueEl();
    if (tmpl) tmpl.style.display = (editMode && !playMode) ? 'inline-block' : 'none';

    applyWysiwygEditableState();
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
    applySpacebarGoShortcutUi();
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
    if (!(editMode && !playMode)) {
      clearSelectedCue();
      clearSelectedDomEl();
    }
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
    if (!(editMode && !playMode)) return;

    // In edit mode: double-click a cue to rename it.
    const cue = e.target?.closest?.('.cue-label');
    if (cue) {
      if (cue.classList.contains('cue-label--template')) return;
      e.preventDefault();

      const currentName = String(cue.dataset.name || cue.textContent || '').trim();
      const suggested = currentName || nextCueName();
      const name = window.prompt('Cue name:', suggested);
      if (name === null) return;
      const finalName = String(name).trim() || suggested;
      cue.dataset.name = finalName;
      cue.textContent = finalName;
      setStatus('Cue renamed');
      if (pendingCueEl === cue) setPendingCue(cue, { scroll: false });
      refreshCueToc();
      return;
    }

    // In WYSIWYG mode, text is edited directly via contenteditable.
    if (isWysiwygActive()) return;

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
    htmlEl.querySelectorAll('.editor-controls, .editor-overlay, .editor-search-hit, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .cue-drop-placeholder, .editor-drop-indicator').forEach((n) => n.remove());
    htmlEl.querySelectorAll('script[src="/static/editor.js"], link[href="/static/editor.css"]').forEach((n) => n.remove());
    htmlEl.querySelectorAll('script').forEach((s) => {
      const t = (s.textContent || '').trim();
      if (t.includes('window.__EDITOR__')) s.remove();
    });
    htmlEl.classList.remove('editor-theme-dark');
    htmlEl.classList.remove('editor-edit-mode');
    htmlEl.querySelectorAll('.cue-label--selected').forEach((n) => n.classList.remove('cue-label--selected'));

    // Remove WYSIWYG/editor-only attributes & classes.
    htmlEl.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    htmlEl.querySelectorAll('[spellcheck]').forEach((n) => n.removeAttribute('spellcheck'));
    htmlEl.querySelectorAll('.editor-dom-selected').forEach((n) => n.classList.remove('editor-dom-selected'));

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
    refreshCueToc();
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
    el.dataset.tracker = '';
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
    refreshCueToc();
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
      if (pendingTrackerEl()) pendingTrackerEl().value = '';
      if (pendingCommentEl()) pendingCommentEl().value = '';
      return;
    }

    if (label) label.textContent = pendingCueEl.dataset.name || '(cue)';
    if (pendingLightEl()) pendingLightEl().value = pendingCueEl.dataset.light || '';
    if (pendingVideoEl()) pendingVideoEl().value = pendingCueEl.dataset.video || '';
    if (pendingAudioEl()) pendingAudioEl().value = pendingCueEl.dataset.audio || '';
    if (pendingTrackerEl()) pendingTrackerEl().value = pendingCueEl.dataset.tracker || '';
    if (pendingCommentEl()) pendingCommentEl().value = pendingCueEl.dataset.comment || '';

    const shouldScroll = opts.scroll !== false;
    if (shouldScroll) {
      pendingCueEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateCommentBubble();
    refreshCueToc();
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
      tracker: pendingCueEl.dataset.tracker || '',
      comment: pendingCueEl.dataset.comment || ''
    };
    // Placeholder until OSC/MIDI is implemented
    console.log('[CUE GO]', payload);
    setStatus(`GO ${payload.name}`);

    // Fire-and-forget OSC bridge call.
    try {
      fetch(cfg.oscGoUrl || '/osc/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          light: payload.light,
          video: payload.video,
          audio: payload.audio,
          tracker: payload.tracker,
          comment: payload.comment
        }),
        keepalive: true
      }).catch(() => {});
    } catch {
      // ignore
    }

    lastTriggeredCueId = pendingCueEl?.dataset?.cueId || '';
    refreshCueToc();

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
        clearSelectedDomEl();
        // Also load cue into playbar fields for editing.
        setPendingCue(cue);
        setStatus('Cue selected (Del to delete)');
      } else {
        clearSelectedCue();

        const target = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
        const el = target?.closest?.('*');
        if (!el || isInEditorUi(el)) {
          clearSelectedDomEl();
          return;
        }
        const tag = String(el.tagName || '').toUpperCase();
        if (!tag || tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') {
          clearSelectedDomEl();
          return;
        }
        if (el.classList.contains('cue-label')) {
          clearSelectedDomEl();
          return;
        }
        setSelectedDomEl(el);
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
        // Newly created cue should become the pending cue.
        setPendingCue(draggingCueEl, { scroll: false });

        // After dropping + naming a cue, focus the Light textbox for immediate entry.
        const light = pendingLightEl();
        if (light) {
          // Defer to ensure the DOM/state updates are fully applied.
          requestAnimationFrame(() => {
            try { light.focus(); } catch {}
            try { light.select(); } catch {}
          });
        }
      }
      refreshCueToc();
    } else {
      setStatus('Cue moved');
      refreshCueToc();
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
        if (!node.nodeValue || !node.nodeValue.trim().length) return NodeFilter.FILTER_SKIP;
        const pe = node.parentElement;
        if (pe) {
          const tag = pe.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_SKIP;
          if (pe.closest('.editor-controls, .editor-playbar, .editor-toc, .editor-comment-bubble, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator')) {
            return NodeFilter.FILTER_SKIP;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
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
    updateSearchUi();
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
        const absTop = firstRect ? firstRect.top + window.scrollY : null;
        const pathArr = computeNodePath(tn);
        searchHits.push({ path: pathArr, node: tn, start: idx, end: idx + q.length, rect: firstRect, absTop, overlays });
        i = idx + q.length;
      }
    }
    updateSearchCount();
    updateSearchUi();
    if (searchHits.length) gotoHit(0);
  }

  function clearSearch() {
    clearHighlightsOnly();
    searchHits = [];
    currentHitIndex = -1;
    updateSearchCount();
    const input = searchInputEl();
    if (input) input.value = '';
    updateSearchUi();
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

  function updateSearchUi() {
    const input = searchInputEl();
    const query = (input?.value || '').trim();
    const hasQuery = query.length > 0;
    const hasHits = searchHits.length > 0;

    const findBtn = controls.querySelector('button[data-action="find"]');
    const prevBtn = controls.querySelector('button[data-action="prev"]');
    const nextBtn = controls.querySelector('button[data-action="next"]');
    const clearBtn = controls.querySelector('button[data-action="clear-search"]');
    const countEl = searchCountEl();

    if (findBtn) findBtn.disabled = !hasQuery;

    if (prevBtn) prevBtn.style.display = hasHits ? '' : 'none';
    if (nextBtn) nextBtn.style.display = hasHits ? '' : 'none';
    if (countEl) countEl.style.display = hasHits ? '' : 'none';

    if (clearBtn) clearBtn.style.display = hasQuery ? '' : 'none';
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
    if (typeof hit.absTop === 'number') {
      const top = hit.absTop - 80; // offset for comfort
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
