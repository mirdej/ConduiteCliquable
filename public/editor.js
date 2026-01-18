(() => {
  const cfg = window.__EDITOR__ || {
    saveUrl: '/save',
    saveHtmlUrl: '/saveHtml',
    backupUrl: '/backup',
    oscGoUrl: '/osc/go',
    eventsUrl: '/events',
    wsPath: '/ws'
  };

  // Default to Edit mode on load (no client updates on cue clicks).
  let editMode = true;
  let playMode = false;
  let isDark = true;

  // Keyboard shortcut state
  let spacebarGoShortcutEnabled = true;

  // Search state
  let searchHits = [];
  let currentHitIndex = -1;
  let highlightEls = [];

  // Local editing state (not broadcast to other clients)
  let selectedCueEl = null;
  let draggingCueEl = null;
  let selectedDomEl = null;
  
  // Remote show state (received from /play clients via WebSocket)
  let remotePendingCueId = '';
  let remotePendingCueIndex = -1;
  let remoteLastTriggeredCueId = '';
  let remoteLastTriggeredCueIndex = -1;
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
  let lastTriggeredCueIndex = -1;
  /** @type {HTMLElement | null} */
  let lastPanelEl = null;
  /** @type {HTMLElement | null} */
  let pendingPanelEl = null;
  /** @type {Record<string, boolean>} */
  let collapsedSections = {};

  /** @type {WebSocket | null} */
  let ws = null;
  let suppressWsSend = false;

  // GO hold-to-trigger state (prevents false triggers on touch screens)
  let goHoldActive = false;
  let goHoldPointerId = null;
  let ignoreGoClickUntil = 0;
  let goHoldInside = false;
  /** @type {HTMLDivElement | null} */
  let goShieldEl = null;
  let goHoldBlockersAttached = false;
  let goHoldScrollY = 0;
  /** @type {Partial<CSSStyleDeclaration> | null} */
  let goHoldBodyPrevStyle = null;

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
      <span class="cue-separator cue-separator--template" data-template="1" draggable="true" title="Drag into the script to create a new section separator">Section. Drag me!</span>
      <span class="editor-status" aria-live="polite"></span>
    </div>
    <div class="editor-controls-right">
      <button data-action="save">Save</button>
    </div>
  `;

  // Play bar (fixed top)
  const playbar = document.createElement('div');
  playbar.className = 'editor-playbar';
  playbar.innerHTML = `
    <div class="playbar-top">
      <span class="playbar-title">Selected Cue:</span>
      <span class="playbar-pending-label">(none)</span>
      <span class="playbar-actions">
        <button data-action="cue-prev">Prev</button>
        <button data-action="cue-next">Next</button>
      </span>
    </div>
    <div class="playbar-fields">
      <label>Light <input class="playbar-light" type="text" /></label>
      <label>Video <input class="playbar-video" type="text" /></label>
      <label>Audio <input class="playbar-audio" type="text" /></label>
      <label>Tracker <input class="playbar-tracker" type="text" /></label>
      <label>Comment <input class="playbar-comment" type="text" /></label>
    </div>
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

  function ensureGoShield() {
    if (goShieldEl) return;
    const el = document.createElement('div');
    el.className = 'editor-go-shield';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');

    const stop = (e) => {
      if (!goHoldActive) return;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('pointerdown', stop, true);
    el.addEventListener('pointermove', stop, true);
    el.addEventListener('pointerup', stop, true);
    el.addEventListener('click', stop, true);
    el.addEventListener('wheel', stop, { passive: false, capture: true });

    document.body.appendChild(el);
    goShieldEl = el;
  }

  function ensureGoHoldBlockers() {
    if (goHoldBlockersAttached) return;
    goHoldBlockersAttached = true;

    const block = (e) => {
      if (!goHoldActive) return;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener('touchstart', block, { capture: true, passive: false });
    document.addEventListener('touchmove', block, { capture: true, passive: false });
    document.addEventListener('touchend', block, { capture: true, passive: false });
    document.addEventListener('touchcancel', block, { capture: true, passive: false });
    document.addEventListener('selectionstart', block, true);
    document.addEventListener('contextmenu', block, true);
    window.addEventListener('scroll', (e) => {
      if (!goHoldActive) return;
      try { window.scrollTo(0, goHoldScrollY); } catch {}
      e.preventDefault?.();
    }, { passive: false });
  }

  function freezeScrollWhileHoldingGo() {
    try {
      goHoldScrollY = window.scrollY || window.pageYOffset || 0;
    } catch {
      goHoldScrollY = 0;
    }

    if (!goHoldBodyPrevStyle) {
      goHoldBodyPrevStyle = {
        position: document.body.style.position,
        top: document.body.style.top,
        left: document.body.style.left,
        right: document.body.style.right,
        width: document.body.style.width,
        overflow: document.body.style.overflow
      };
    }

    document.body.style.position = 'fixed';
    document.body.style.top = `-${goHoldScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }

  function unfreezeScrollWhileHoldingGo() {
    if (!goHoldBodyPrevStyle) return;
    const prev = goHoldBodyPrevStyle;
    goHoldBodyPrevStyle = null;
    document.body.style.position = prev.position ?? '';
    document.body.style.top = prev.top ?? '';
    document.body.style.left = prev.left ?? '';
    document.body.style.right = prev.right ?? '';
    document.body.style.width = prev.width ?? '';
    document.body.style.overflow = prev.overflow ?? '';
    try { window.scrollTo(0, goHoldScrollY); } catch {}
  }

  function wireGoTriggerOnRelease() {
    const btnGo = goBtnEl();
    if (!btnGo) return;

    const haptic = (kind) => {
      // Best-effort only: iOS Safari often ignores vibration.
      try {
        const v = navigator?.vibrate;
        if (typeof v !== 'function') return;
        if (kind === 'press') v.call(navigator, 12);
        if (kind === 'go') v.call(navigator, [18, 26, 18]);
      } catch {}
    };

    const updateHoldInsideFromPoint = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const r = btnGo.getBoundingClientRect();
      const inside = (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      goHoldInside = inside;
      btnGo.classList.toggle('is-hold-outside', !inside);
    };

    const endHold = () => {
      goHoldActive = false;
      goHoldPointerId = null;
      goHoldInside = false;
      btnGo.classList.remove('is-hold');
      btnGo.classList.remove('is-hold-outside');
      document.documentElement.classList.remove('editor-go-hold-active');
      if (goShieldEl) goShieldEl.hidden = true;
      unfreezeScrollWhileHoldingGo();
    };

    btnGo.addEventListener('pointerdown', (e) => {
      if (!playMode) return;
      if (btnGo.disabled) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      if (goHoldActive) return;
      e.preventDefault();

      goHoldActive = true;
      goHoldPointerId = e.pointerId;
      goHoldInside = true;
      ignoreGoClickUntil = Date.now() + 1500;
      btnGo.classList.add('is-hold');
      btnGo.classList.remove('is-hold-outside');
      document.documentElement.classList.add('editor-go-hold-active');
      ensureGoHoldBlockers();
      ensureGoShield();
      if (goShieldEl) goShieldEl.hidden = false;
      freezeScrollWhileHoldingGo();
      haptic('press');
      try { btnGo.setPointerCapture(e.pointerId); } catch {}
    }, { passive: false });

    btnGo.addEventListener('pointermove', (e) => {
      if (!goHoldActive) return;
      if (goHoldPointerId != null && e.pointerId !== goHoldPointerId) return;
      updateHoldInsideFromPoint(e.clientX, e.clientY);
    }, { passive: true });

    btnGo.addEventListener('pointercancel', () => {
      if (!goHoldActive) return;
      endHold();
    });

    btnGo.addEventListener('lostpointercapture', () => {
      if (!goHoldActive) return;
      endHold();
    });

    btnGo.addEventListener('pointerup', (e) => {
      if (!goHoldActive) return;
      if (goHoldPointerId != null && e.pointerId !== goHoldPointerId) return;
      e.preventDefault();

      updateHoldInsideFromPoint(e.clientX, e.clientY);
      const releasedOnGo = goHoldInside;
      endHold();

      if (!releasedOnGo) return;
      if (!playMode) return;
      if (btnGo.disabled) return;
      haptic('go');
      triggerPendingCueAndAdvance();
    }, { passive: false });

    // Keep keyboard accessibility; ignore clicks emitted after pointer interactions.
    btnGo.addEventListener('click', (e) => {
      if (!playMode) return;
      if (goHoldActive || Date.now() < ignoreGoClickUntil) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      triggerPendingCueAndAdvance();
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    // Mount play UI first (top), then spacer, then controls at end of body.
    document.body.prepend(playbar);
    document.body.prepend(playbarSpacer);
    document.body.appendChild(controls);

    // Keep spacer height in sync with playbar height (multi-line responsive)
    const setPlaybarSpacerHeight = () => {
      try {
        const h = Math.round(playbar.getBoundingClientRect().height);
        const hh = Math.max(64, h);
        playbarSpacer.style.height = `${hh}px`;
        // Expose playbar height to CSS so panels can position below it
        document.documentElement.style.setProperty('--editor-playbar-height', `${hh}px`);
      } catch {}
    };
    setPlaybarSpacerHeight();
    window.addEventListener('resize', setPlaybarSpacerHeight);

    // Best-effort: measure controls to keep pending panel above it
    try {
      const h = Math.round(controls.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--editor-controls-height', `${h}px`);
      window.addEventListener('resize', () => {
        try {
          const hh = Math.round(controls.getBoundingClientRect().height);
          document.documentElement.style.setProperty('--editor-controls-height', `${hh}px`);
        } catch {}
      });
    } catch {}

    mountEditorLastPanel();
    mountEditorPendingPanel();

    mountCueTocPanel();

    // GO/play triggers remain disabled in edit mode.

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

    // No remote control/EventSource in edit mode.

    initWebSocket();
  });

  function flashCueJump(el) {
    if (!el) return;
    el.classList.add('play-jump');
    window.setTimeout(() => {
      try { el.classList.remove('play-jump'); } catch {}
    }, 650);
  }

  function scrollCueIntoView(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch {
      try { el.scrollIntoView(); } catch {}
    }
    flashCueJump(el);
  }

  function getCueById(cueId) {
    const id = String(cueId || '').trim();
    if (!id) return null;
    const cues = getCueLabels();
    return cues.find((c) => String(c?.dataset?.cueId || '') === id) || null;
  }

  function mountEditorPendingPanel() {
    const panel = document.createElement('div');
    panel.className = 'play-pending-panel';
    panel.innerHTML = `
      <span class="play-pending-label">Show: Pending</span>
      <span class="play-pending-name" aria-label="Remote pending cue">(none)</span>
      <span class="play-pending-meta" aria-label="Remote pending cue details"></span>
    `;
    document.body.appendChild(panel);
    pendingPanelEl = panel;
    // Make panel behave like a button and never editable
    panel.setAttribute('role', 'button');
    panel.setAttribute('tabindex', '0');
    panel.setAttribute('contenteditable', 'false');
    panel.addEventListener('click', (e) => {
      e.preventDefault();
      const cue = getCueById(remotePendingCueId) || (remotePendingCueIndex >= 0 ? getCueLabels()[remotePendingCueIndex] : null);
      if (cue) {
        setSelectedCue(cue);
        scrollCueIntoView(cue);
      }
    });
    // Keyboard activation
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const cue = getCueById(remotePendingCueId) || (remotePendingCueIndex >= 0 ? getCueLabels()[remotePendingCueIndex] : null);
      if (cue) {
        setSelectedCue(cue);
        scrollCueIntoView(cue);
      }
    });
    refreshEditorPendingPanel();
  }

  function mountEditorLastPanel() {
    const panel = document.createElement('div');
    panel.className = 'play-last-panel is-empty';
    panel.innerHTML = `
      <span class="play-last-label">Last GO</span>
      <span class="play-last-name" aria-label="Remote last triggered cue">(none)</span>
      <span class="play-last-meta" aria-label="Remote last triggered cue details"></span>
    `;
    document.body.appendChild(panel);
    lastPanelEl = panel;
    // Make panel behave like a button and never editable
    panel.setAttribute('role', 'button');
    panel.setAttribute('tabindex', '0');
    panel.setAttribute('contenteditable', 'false');
    panel.addEventListener('click', (e) => {
      e.preventDefault();
      const el = getCueById(remoteLastTriggeredCueId) || (remoteLastTriggeredCueIndex >= 0 ? getCueLabels()[remoteLastTriggeredCueIndex] : null);
      if (el) {
        setSelectedCue(el);
        scrollCueIntoView(el);
      }
    });
    // Keyboard activation
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const el = getCueById(remoteLastTriggeredCueId) || (remoteLastTriggeredCueIndex >= 0 ? getCueLabels()[remoteLastTriggeredCueIndex] : null);
      if (el) {
        setSelectedCue(el);
        scrollCueIntoView(el);
      }
    });
  }

  function refreshEditorPendingPanel() {
    const nameEl = pendingPanelEl?.querySelector('.play-pending-name');
    const metaEl = pendingPanelEl?.querySelector('.play-pending-meta');
    if (!pendingPanelEl || !nameEl || !metaEl) return;

    // Show remote pending cue from /play clients
    const cue = getCueById(remotePendingCueId) || (remotePendingCueIndex >= 0 ? getCueLabels()[remotePendingCueIndex] : null);
    if (!cue) {
      pendingPanelEl.classList.add('is-empty');
      pendingPanelEl.classList.remove('is-clickable');
      nameEl.textContent = '(none)';
      metaEl.textContent = '';
      return;
    }
    pendingPanelEl.classList.remove('is-empty');
    pendingPanelEl.classList.add('is-clickable');
    const ds = /** @type {any} */ (cue.dataset || {});
    const name = String(ds.name || cue.textContent || '').trim();
    nameEl.textContent = name ? `${name}` : '(cue)';
    const parts = [];
    if (ds.light) parts.push(`L:${ds.light}`);
    if (ds.video) parts.push(`V:${ds.video}`);
    if (ds.audio) parts.push(`A:${ds.audio}`);
    if (ds.tracker) parts.push(`T:${ds.tracker}`);
    metaEl.textContent = parts.join('  ');
  }

  function refreshEditorLastPanelFromCue(cueEl) {
    const nameEl = lastPanelEl?.querySelector('.play-last-name');
    const metaEl = lastPanelEl?.querySelector('.play-last-meta');
    if (!lastPanelEl || !nameEl || !metaEl) return;

    if (!cueEl) {
      remoteLastTriggeredCueId = '';
      remoteLastTriggeredCueIndex = -1;
      lastPanelEl.classList.add('is-empty');
      lastPanelEl.classList.remove('is-clickable');
      nameEl.textContent = '(none)';
      metaEl.textContent = '';
      return;
    }

    lastPanelEl.classList.remove('is-empty');
    lastPanelEl.classList.add('is-clickable');

    remoteLastTriggeredCueId = String(cueEl?.dataset?.cueId || '');
    remoteLastTriggeredCueIndex = getCueLabels().indexOf(cueEl);

    const ds = /** @type {any} */ (cueEl.dataset || {});
    const name = String(ds.name || cueEl.textContent || '').trim();
    nameEl.textContent = name || '(cue)';

    const parts = [];
    if (ds.light) parts.push(`L:${ds.light}`);
    if (ds.video) parts.push(`V:${ds.video}`);
    if (ds.audio) parts.push(`A:${ds.audio}`);
    if (ds.tracker) parts.push(`T:${ds.tracker}`);
    metaEl.textContent = parts.join('  ');
  }

  function refreshEditorLastPanelFromData(data) {
    const nameEl = lastPanelEl?.querySelector('.play-last-name');
    const metaEl = lastPanelEl?.querySelector('.play-last-meta');
    if (!lastPanelEl || !nameEl || !metaEl) return;
    lastPanelEl.classList.remove('is-empty');
    // Panel isn’t clickable if we don’t have a direct element reference
    lastPanelEl.classList.remove('is-clickable');

    const name = String(data?.name || '').trim();
    nameEl.textContent = name || '(cue)';

    const parts = [];
    const light = String(data?.light || '').trim();
    const video = String(data?.video || '').trim();
    const audio = String(data?.audio || '').trim();
    const tracker = String(data?.tracker || '').trim();
    if (light) parts.push(`L:${light}`);
    if (video) parts.push(`V:${video}`);
    if (audio) parts.push(`A:${audio}`);
    if (tracker) parts.push(`T:${tracker}`);
    metaEl.textContent = parts.join('  ');
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = String(cfg.wsPath || '/ws');
    return `${proto}//${location.host}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  function initWebSocket() {
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      ws = null;
      return;
    }

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data || '')); } catch { return; }
      const type = String(msg?.type || '');

      if (type === 'fileUpdated') {
        // Avoid clobbering edits: only auto-reload when not in edit mode.
        if (!editMode) {
          window.setTimeout(() => location.reload(), 50);
        } else {
          setStatus('File changed on server');
        }
        return;
      }

      // Receive remote pending cue from /play clients (show state)
      if (type === 'state' || type === 'pending') {
        const pending = msg?.pending || {};
        const cueId = String(pending?.cueId || '').trim();
        const index = Number.isFinite(pending?.index) ? Number(pending.index) : -1;

        // Update remote pending state (do NOT scroll or change local selection)
        remotePendingCueId = cueId;
        remotePendingCueIndex = index;
        refreshEditorPendingPanel();
        updateRemotePendingHighlight();
      }

      // Receive remote GO trigger from /play clients
      if (type === 'go') {
        const cue = msg?.cue || msg?.data || {};
        const cueId = String(cue?.cueId || '').trim();
        const index = Number.isFinite(cue?.index) ? Number(cue.index) : -1;
        
        // Update remote last triggered state (do NOT scroll or change local selection)
        remoteLastTriggeredCueId = cueId;
        remoteLastTriggeredCueIndex = index;
        
        // Update last panel from data
        refreshEditorLastPanelFromData({
          name: String(cue?.name || ''),
          light: String(cue?.light || ''),
          video: String(cue?.video || ''),
          audio: String(cue?.audio || ''),
          tracker: String(cue?.tracker || '')
        });
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      window.setTimeout(initWebSocket, 1000);
    });
  }

  // Sync the playbar fields to the current selected cue (local only)
  function syncPlaybarFields() {
    const labelEl = pendingLabelEl();
    const lightEl = pendingLightEl();
    const videoEl = pendingVideoEl();
    const audioEl = pendingAudioEl();
    const trackerEl = pendingTrackerEl();
    const commentEl = pendingCommentEl();

    if (!selectedCueEl) {
      if (labelEl) labelEl.textContent = '(none)';
      if (lightEl) lightEl.value = '';
      if (videoEl) videoEl.value = '';
      if (audioEl) audioEl.value = '';
      if (trackerEl) trackerEl.value = '';
      if (commentEl) commentEl.value = '';
      return;
    }

    const ds = /** @type {any} */ (selectedCueEl.dataset || {});
    const name = String(ds.name || selectedCueEl.textContent || '').trim();
    if (labelEl) labelEl.textContent = name || '(cue)';
    if (lightEl) lightEl.value = String(ds.light || '');
    if (videoEl) videoEl.value = String(ds.video || '');
    if (audioEl) audioEl.value = String(ds.audio || '');
    if (trackerEl) trackerEl.value = String(ds.tracker || '');
    if (commentEl) commentEl.value = String(ds.comment || '');
  }

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

  // Highlight the remote pending cue (show state) without changing local selection
  let remotePendingAppliedEl = null;
  function updateRemotePendingHighlight() {
    // Remove previous highlight
    if (remotePendingAppliedEl) {
      try { remotePendingAppliedEl.classList.remove('cue-label--pending'); } catch {}
      remotePendingAppliedEl = null;
    }

    // Find new remote pending element
    const el = getCueById(remotePendingCueId) || (remotePendingCueIndex >= 0 ? getCueLabels()[remotePendingCueIndex] : null);
    if (el && el.classList.contains('cue-label')) {
      el.classList.add('cue-label--pending');
      remotePendingAppliedEl = el;
    }
  }

  function positionCommentBubble() {
    if (!commentBubbleEl) return;
    if (!selectedCueEl) return;
    if (!commentBubbleEl.classList.contains('is-visible')) return;

    const cueRect = selectedCueEl.getBoundingClientRect();
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
    const comment = (selectedCueEl?.dataset?.comment || '').trim();
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
      const sectionBtn = e.target.closest('[data-sep-id]');
      if (sectionBtn) {
        const sepId = sectionBtn.getAttribute('data-sep-id') || '';
        if (!sepId) return;
        collapsedSections[sepId] = !collapsedSections[sepId];
        refreshCueToc();
        return;
      }

      const cueBtn = e.target.closest('[data-cue-id]');
      if (!cueBtn) return;
      const cueId = cueBtn.getAttribute('data-cue-id');
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
    const pendingId = selectedCueEl?.dataset?.cueId || '';

    tocListEl.innerHTML = '';

    const nodes = Array.from(document.querySelectorAll('.cue-separator:not(.cue-separator--template), .cue-label:not(.cue-label--template)'));
    let activeSepId = '';

    const renderSectionHeader = (sepEl) => {
      const sepId = sepEl.dataset.sepId || '';
      if (!sepId) return;
      const name = (sepEl.dataset.name || sepEl.textContent || '').trim() || 'Section';
      const collapsed = Boolean(collapsedSections[sepId]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'editor-toc-section';
      btn.setAttribute('data-sep-id', sepId);
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = `${collapsed ? '▸' : '▾'} ${name}`;
      tocListEl.appendChild(btn);
    };

    const renderCueItem = (cue) => {
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
    };

    for (const n of nodes) {
      if (n.classList.contains('cue-separator')) {
        activeSepId = n.dataset.sepId || '';
        renderSectionHeader(n);
        continue;
      }

      // cue-label
      if (activeSepId && collapsedSections[activeSepId]) continue;
      renderCueItem(n);
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

  function templateSeparatorEl() {
    return controls.querySelector('.cue-separator--template');
  }

  // Play/Edit mode toggle removed.

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

  // Spacebar GO shortcut removed.

  // Delete selected cue in Edit mode (Delete/Backspace). Esc clears selection.
  document.addEventListener('keydown', (e) => {
    if (!(editMode && !playMode)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // In WYSIWYG mode the document body is contenteditable, but we still want
    // Delete/Backspace to remove a selected cue/element.
    if (document.activeElement?.isContentEditable && !selectedCueEl && !selectedDomEl) return;
    if (e.key === 'Escape') {
      clearSelectedCue();
      clearSelectedDomEl();
      return;
    }
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();

    if (selectedCueEl) {
      pushStructuralUndoPoint();
      deleteCue(selectedCueEl);
      return;
    }
    if (selectedDomEl) {
      pushStructuralUndoPoint();
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

    // Removed actions: toggle edit, spacebar-go, mode.

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

  // Playbar interactions: prev/next; GO remains inactive in edit mode.
  playbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    if (action === 'cue-prev') gotoCueByDelta(-1);
    if (action === 'cue-next') gotoCueByDelta(1);
    // GO handled when play triggers are enabled (kept disabled in /edit).
    if (action === 'cue-go') return;
  });

  // Playbar inputs: edit current pending cue’s fields.
  playbar.addEventListener('input', () => {
    if (!selectedCueEl) return;
    selectedCueEl.dataset.light = pendingLightEl()?.value ?? '';
    selectedCueEl.dataset.video = pendingVideoEl()?.value ?? '';
    selectedCueEl.dataset.audio = pendingAudioEl()?.value ?? '';
    selectedCueEl.dataset.tracker = pendingTrackerEl()?.value ?? '';
    selectedCueEl.dataset.comment = pendingCommentEl()?.value ?? '';
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
    // Treat status panels as part of editor UI so clicks don't select/delete them
    return Boolean(node?.closest?.('.editor-controls, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .editor-overlay, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator, .play-pending-panel, .play-last-panel'));
  }

  // Exclude injected status panels from structural history snapshots
  const HISTORY_STRIP_SELECTORS = '.editor-controls, .editor-overlay, .editor-search-hit, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .cue-drop-placeholder, .editor-drop-indicator, .play-pending-panel, .play-last-panel';
  const STRUCT_HISTORY_MAX = 60;
  /** @type {Array<{ html: string, pendingCueId: string, selectedCueId: string, scrollY: number }>} */
  const structUndoStack = [];
  /** @type {Array<{ html: string, pendingCueId: string, selectedCueId: string, scrollY: number }>} */
  const structRedoStack = [];

  function getScriptBodyHtmlForHistory() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(HISTORY_STRIP_SELECTORS).forEach((n) => n.remove());
    return clone.innerHTML;
  }

  function captureStructuralState() {
    return {
      html: getScriptBodyHtmlForHistory(),
      pendingCueId: String(selectedCueEl?.dataset?.cueId || ''),
      selectedCueId: String(selectedCueEl?.dataset?.cueId || ''),
      scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0
    };
  }

  function restoreScriptBodyHtmlFromHistory(html) {
    // Clear transient editor artifacts.
    document.querySelectorAll('.editor-overlay, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator').forEach((n) => n.remove());

    // Remove all non-UI nodes from body.
    for (const n of Array.from(document.body.childNodes)) {
      if (n.nodeType === 1) {
        const el = /** @type {Element} */ (n);
        if (el.matches(HISTORY_STRIP_SELECTORS)) continue;
      }
      try { n.remove(); } catch {}
    }

    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';

    const anchor = controls || document.body.lastChild;
    while (tmp.firstChild) {
      if (anchor && anchor.parentNode === document.body) document.body.insertBefore(tmp.firstChild, anchor);
      else document.body.appendChild(tmp.firstChild);
    }
  }

  function restoreStructuralState(state) {
    if (!state) return;
    restoreScriptBodyHtmlFromHistory(state.html);

    // Re-apply editor invariants.
    applyWysiwygEditableState();
    updateCueInteractivity();

    // Restore selection-ish state.
    const selCueId = state.selectedCueId || '';
    const pendCueId = state.pendingCueId || '';
    const selCue = selCueId ? document.querySelector(`.cue-label[data-cue-id="${cssEscape(selCueId)}"]`) : null;
    const pendCue = pendCueId ? document.querySelector(`.cue-label[data-cue-id="${cssEscape(pendCueId)}"]`) : null;

    if (selCue) setSelectedCue(selCue);
    else clearSelectedCue();

    if (pendCue) setPendingCue(pendCue, { scroll: false });
    else setPendingCue(null, { scroll: false });

    try { window.scrollTo(0, state.scrollY || 0); } catch {}
    lastScriptRange = null;
    lastPointer = null;
  }

  function pushStructuralUndoPoint() {
    structUndoStack.push(captureStructuralState());
    while (structUndoStack.length > STRUCT_HISTORY_MAX) structUndoStack.shift();
    structRedoStack.length = 0;
  }

  function structuralUndo() {
    if (structUndoStack.length === 0) return false;
    structRedoStack.push(captureStructuralState());
    const prev = structUndoStack.pop();
    restoreStructuralState(prev);
    return true;
  }

  function structuralRedo() {
    if (structRedoStack.length === 0) return false;
    structUndoStack.push(captureStructuralState());
    const next = structRedoStack.pop();
    restoreStructuralState(next);
    return true;
  }

  const CUE_CLIPBOARD_MIME = 'application/x-conduite-cue';

  function isRealCueOrSeparatorEl(el) {
    if (!el) return false;
    if (!(el instanceof Element)) return false;
    if (el.classList.contains('cue-label')) return !el.classList.contains('cue-label--template');
    if (el.classList.contains('cue-separator')) return !el.classList.contains('cue-separator--template');
    return false;
  }

  function cueOrSeparatorFromNode(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    const hit = el?.closest?.('.cue-label, .cue-separator');
    return isRealCueOrSeparatorEl(hit) ? hit : null;
  }

  function getSingleCueOrSeparatorFromSelection() {
    try {
      const sel = window.getSelection();
      if (!sel) return null;

      const a = cueOrSeparatorFromNode(sel.anchorNode);
      const f = cueOrSeparatorFromNode(sel.focusNode);
      if (a && f && a === f) return a;

      if (sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (r.collapsed) {
          const fromCaret = cueOrSeparatorFromNode(r.startContainer);
          if (fromCaret) return fromCaret;
        }

        // If the selection intersects exactly one cue/separator, treat it as an atomic selection.
        let only = null;
        let count = 0;
        const nodes = document.querySelectorAll('.cue-label:not(.cue-label--template), .cue-separator:not(.cue-separator--template)');
        for (const n of nodes) {
          try {
            if (!r.intersectsNode(n)) continue;
          } catch {
            continue;
          }
          count++;
          if (count > 1) return null;
          only = n;
        }
        if (count === 1) return only;
      }
    } catch {
      // ignore
    }
    return null;
  }

  function serializeCueOrSeparator(el) {
    if (!isRealCueOrSeparatorEl(el)) return null;
    if (el.classList.contains('cue-separator')) {
      return {
        kind: 'sep',
        name: el.dataset.name || el.textContent || 'Section'
      };
    }
    // cue-label
    return {
      kind: 'cue',
      name: el.dataset.name || el.textContent || 'Cue',
      light: el.dataset.light || '',
      video: el.dataset.video || '',
      audio: el.dataset.audio || '',
      tracker: el.dataset.tracker || '',
      comment: el.dataset.comment || ''
    };
  }

  function deserializeCueOrSeparator(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.kind === 'sep') {
      const sep = createCueSeparator(payload.name || 'Section');
      return sep;
    }
    if (payload.kind === 'cue') {
      const cue = createCueLabel(payload.name || 'Cue');
      cue.dataset.light = String(payload.light || '');
      cue.dataset.video = String(payload.video || '');
      cue.dataset.audio = String(payload.audio || '');
      cue.dataset.tracker = String(payload.tracker || '');
      cue.dataset.comment = String(payload.comment || '');
      cue.textContent = cue.dataset.name || cue.textContent;
      return cue;
    }
    return null;
  }

  function deleteCueOrSeparator(el) {
    if (!isRealCueOrSeparatorEl(el)) return;
    if (el.classList.contains('cue-label')) {
      deleteCue(el);
      return;
    }
    // cue-separator
    if (selectedDomEl === el) clearSelectedDomEl();
    try { el.remove(); } catch {}
    setStatus('Section deleted');
    refreshCueToc();
  }

  function getRangeForScriptInsertion() {
    // Prefer live selection if it's in script content.
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        const container = r.commonAncestorContainer.nodeType === 1
          ? r.commonAncestorContainer
          : r.commonAncestorContainer.parentElement;
        if (container && !container.closest?.('.editor-controls, .editor-playbar')) return r;
      }
    } catch {
      // ignore
    }
    if (lastScriptRange) return lastScriptRange.cloneRange();
    if (lastPointer) return caretRangeFromPoint(lastPointer.x, lastPointer.y);
    return null;
  }

  function applyWysiwygEditableState() {
    const enabled = Boolean(editMode && !playMode);

    // Turn the page into a WYSIWYG editor in Edit mode.
    if (enabled) document.body.setAttribute('contenteditable', 'true');
    else document.body.removeAttribute('contenteditable');

    // Always protect injected UI from edits.
    document.querySelectorAll('.editor-controls, .editor-playbar, .editor-playbar-spacer, .editor-comment-bubble, .editor-toc, .editor-overlay, .editor-search-hit, .cue-drop-placeholder, .editor-drop-indicator, .play-pending-panel, .play-last-panel').forEach((n) => {
      try { n.setAttribute('contenteditable', 'false'); } catch {}
    });

    // Keep cue labels and separators controlled (rename via our prompt so dataset stays in sync).
    document.querySelectorAll('.cue-label, .cue-separator').forEach((n) => {
      try { n.setAttribute('contenteditable', 'false'); } catch {}
    });

    if (!enabled) clearSelectedDomEl();
  }

  // Atomic copy/cut/paste for cue labels & separators.
  // Default browser behavior can be shaky because these are non-editable inline elements.
  document.addEventListener('copy', (e) => {
    if (!isWysiwygActive()) return;
    if (!e.clipboardData) return;

    const el = getSingleCueOrSeparatorFromSelection() || (isRealCueOrSeparatorEl(selectedCueEl) ? selectedCueEl : null);
    if (!el) return;

    const payload = serializeCueOrSeparator(el);
    if (!payload) return;

    try {
      e.preventDefault();
      e.clipboardData.setData(CUE_CLIPBOARD_MIME, JSON.stringify(payload));
      e.clipboardData.setData('text/plain', payload.kind === 'sep' ? String(payload.name || 'Section') : String(payload.name || 'Cue'));
      setStatus(payload.kind === 'sep' ? 'Section copied' : 'Cue copied');
    } catch {
      // ignore
    }
  }, true);

  document.addEventListener('cut', (e) => {
    if (!isWysiwygActive()) return;
    if (!e.clipboardData) return;

    const el = getSingleCueOrSeparatorFromSelection() || (isRealCueOrSeparatorEl(selectedCueEl) ? selectedCueEl : null);
    if (!el) return;

    const payload = serializeCueOrSeparator(el);
    if (!payload) return;

    try {
      e.preventDefault();
      e.clipboardData.setData(CUE_CLIPBOARD_MIME, JSON.stringify(payload));
      e.clipboardData.setData('text/plain', payload.kind === 'sep' ? String(payload.name || 'Section') : String(payload.name || 'Cue'));
      pushStructuralUndoPoint();
      deleteCueOrSeparator(el);
      setStatus(payload.kind === 'sep' ? 'Section cut' : 'Cue cut');
    } catch {
      // ignore
    }
  }, true);

  document.addEventListener('paste', (e) => {
    if (!isWysiwygActive()) return;
    const raw = e.clipboardData?.getData?.(CUE_CLIPBOARD_MIME);
    if (!raw) return;

    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const el = deserializeCueOrSeparator(payload);
    if (!el) return;

    e.preventDefault();
    pushStructuralUndoPoint();

    const range = getRangeForScriptInsertion();
    if (!range) {
      document.body.insertBefore(el, controls);
      el.after(document.createTextNode(' '));
      updateCueInteractivity();
      setStatus(el.classList.contains('cue-separator') ? 'Section pasted' : 'Cue pasted');
      return;
    }

    // Avoid inserting *inside* a non-editable cue/separator.
    const inCue = cueOrSeparatorFromNode(range.startContainer);
    if (inCue) {
      try {
        range.setStartAfter(inCue);
        range.collapse(true);
      } catch {
        // ignore
      }
    }

    try {
      range.deleteContents();
    } catch {
      // ignore
    }

    range.insertNode(el);
    const space = document.createTextNode(' ');
    el.after(space);

    // Place caret after inserted cue.
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const r2 = document.createRange();
        r2.setStart(space, 1);
        r2.collapse(true);
        sel.addRange(r2);
      }
    } catch {
      // ignore
    }

    updateCueInteractivity();
    setStatus(el.classList.contains('cue-separator') ? 'Section pasted' : 'Cue pasted');
  }, true);

  // Undo/redo: prefer native undo (text), fallback to structural history (cues/moves).
  document.addEventListener('keydown', (e) => {
    if (!isWysiwygActive()) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.altKey) return;
    const k = String(e.key || '').toLowerCase();
    if (k !== 'z' && k !== 'y') return;

    // Let native behavior in standard inputs.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.closest?.('.editor-overlay')) return;

    const isRedo = (k === 'y') || (k === 'z' && e.shiftKey);
    e.preventDefault();

    // First, attempt native undo/redo.
    const before = getScriptBodyHtmlForHistory();
    try { document.execCommand(isRedo ? 'redo' : 'undo'); } catch {}
    const after = getScriptBodyHtmlForHistory();

    if (before !== after) {
      // Native handled it (typically text edits).
      updateCueInteractivity();
      return;
    }

    // Fall back to structural history.
    const ok = isRedo ? structuralRedo() : structuralUndo();
    if (ok) setStatus(isRedo ? 'Redo' : 'Undo');
  }, true);

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
      pushStructuralUndoPoint();
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
    const st = templateSeparatorEl();
    if (st) st.style.display = (editMode && !playMode) ? 'inline-block' : 'none';

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
    if (!selectedCueEl) {
      const cues = getCueLabels();
      if (cues.length) setPendingCue(cues[0], { scroll: !shouldPreserveScroll });
      else setPendingCue(null);
    } else {
      setPendingCue(selectedCueEl, { scroll: !shouldPreserveScroll });
    }

    updateCommentBubble();
  }

  // Click-to-edit text node (text only)
  document.addEventListener('dblclick', (e) => {
    if (!(editMode && !playMode)) return;

    // In edit mode: double-click a separator to rename it.
    const sep = e.target?.closest?.('.cue-separator');
    if (sep) {
      if (sep.classList.contains('cue-separator--template')) return;
      e.preventDefault();
      const currentName = String(sep.dataset.name || sep.textContent || '').trim();
      const suggested = currentName || 'Section';
      const name = window.prompt('Section name:', suggested);
      if (name === null) return;
      const finalName = String(name).trim() || suggested;
      pushStructuralUndoPoint();
      sep.dataset.name = finalName;
      sep.textContent = finalName;
      setStatus('Section renamed');
      refreshCueToc();
      return;
    }

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
      pushStructuralUndoPoint();
      cue.dataset.name = finalName;
      cue.textContent = finalName;
      setStatus('Cue renamed');
      if (selectedCueEl === cue) setPendingCue(cue, { scroll: false });
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
    // Keep playbar fields in sync with the current selection
    syncPlaybarFields();
    updateCommentBubble();
    // Position bubble after layout
    requestAnimationFrame(positionCommentBubble);
  }

  function clearSelectedCue() {
    if (!selectedCueEl) return;
    selectedCueEl.classList.remove('cue-label--selected');
    // Ensure no pending class remains from previous logic
    selectedCueEl.classList.remove('cue-label--pending');
    selectedCueEl = null;
    syncPlaybarFields();
    updateCommentBubble();
  }

  function deleteCue(el) {
    if (!el) return;
    if (el.classList.contains('cue-label--template')) return;
    if (selectedCueEl === el) setPendingCue(null);
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

  function createCueSeparator(name) {
    const el = document.createElement('span');
    el.className = 'cue-separator';
    const id = (globalThis.crypto?.randomUUID?.() || `sep-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    el.dataset.sepId = id;
    el.dataset.name = (name && String(name).trim()) ? String(name).trim() : 'Section';
    el.textContent = el.dataset.name;
    el.setAttribute('draggable', 'false');
    return el;
  }

  function updateCueInteractivity() {
    for (const el of getCueLabels()) {
      el.dataset.mode = editMode && !playMode ? 'edit' : 'play';
      el.setAttribute('draggable', String(Boolean(editMode && !playMode)));
    }

    for (const el of document.querySelectorAll('.cue-separator:not(.cue-separator--template)')) {
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
    // In Edit mode, pending is local selection only; do not alter remote pending highlight
    setSelectedCue(el);

    // Do not broadcast client-side pending changes from /edit.

    // Sync playbar fields from current selection
    syncPlaybarFields();

    const shouldScroll = opts.scroll !== false;
    if (shouldScroll) {
      selectedCueEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    updateCommentBubble();
    refreshEditorPendingPanel();
    refreshCueToc();
  }

  function gotoCueByDelta(delta) {
    const cues = getCueLabels();
    if (!cues.length) return;
    const idx = selectedCueEl ? cues.indexOf(selectedCueEl) : -1;
    const nextIdx = idx === -1 ? 0 : Math.min(cues.length - 1, Math.max(0, idx + delta));
    setPendingCue(cues[nextIdx]);
  }

  // Guard against duplicate GO triggers (OSC/SSE duplicates, key repeat, double taps).
  let goInFlight = false;
  let lastGoAtMs = 0;
  const GO_COOLDOWN_MS = 250;

  function triggerPendingCueAndAdvance() {
    if (!selectedCueEl) return;
    // Do not trigger OSC in Edit mode
    if (!playMode) return;

    const now = Date.now();
    if (goInFlight) return;
    if (GO_COOLDOWN_MS > 0 && now - lastGoAtMs < GO_COOLDOWN_MS) return;
    goInFlight = true;
    lastGoAtMs = now;

    const payload = {
      name: selectedCueEl.dataset.name || '',
      light: selectedCueEl.dataset.light || '',
      video: selectedCueEl.dataset.video || '',
      audio: selectedCueEl.dataset.audio || '',
      tracker: selectedCueEl.dataset.tracker || '',
      comment: selectedCueEl.dataset.comment || ''
    };
    // Placeholder until OSC/MIDI is implemented
    console.log('[CUE GO]', payload);
    setStatus(`GO ${payload.name}`);

    // Fire-and-forget OSC bridge call (Play mode only).
    try {
      fetch(cfg.oscGoUrl || '/osc/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cueId: selectedCueEl?.dataset?.cueId || '',
          name: selectedCueEl?.dataset?.name || '',
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

    lastTriggeredCueId = selectedCueEl?.dataset?.cueId || '';
    refreshEditorLastPanelFromCue(selectedCueEl);
    refreshCueToc();

    const cues = getCueLabels();
    const idx = cues.indexOf(selectedCueEl);
    if (idx >= 0 && idx + 1 < cues.length) setPendingCue(cues[idx + 1]);

    window.setTimeout(() => {
      goInFlight = false;
    }, GO_COOLDOWN_MS);
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
        const target = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
        const el = target?.closest?.('*');
        // If clicking inside editor UI (controls, playbar), do NOT clear selected cue
        if (!el || isInEditorUi(el)) {
          clearSelectedDomEl();
          return;
        }
        // Clicking outside editor UI: clear selected cue and potentially select a DOM element
        clearSelectedCue();

        const tag = String(el.tagName || '').toUpperCase();
        if (!tag || tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') {
          clearSelectedDomEl();
          return;
        }
        if (el.classList.contains('cue-label') || el.classList.contains('cue-separator')) {
          clearSelectedDomEl();
          return;
        }
        setSelectedDomEl(el);
      }
    }
  }, true);

  // Drag/drop cue movement (edit mode only)
  document.addEventListener('dragstart', (e) => {
    const el = e.target?.closest?.('.cue-label, .cue-separator');
    if (!el) return;
    if (!(editMode && !playMode)) {
      e.preventDefault();
      return;
    }
    clearDropPreview();

    const isCueTemplate = el.classList.contains('cue-label--template') || (el.dataset.template === '1' && el.classList.contains('cue-label'));
    const isSepTemplate = el.classList.contains('cue-separator--template') || (el.dataset.template === '1' && el.classList.contains('cue-separator'));
    const isSeparator = el.classList.contains('cue-separator') || isSepTemplate;
    const isTemplate = isCueTemplate || isSepTemplate;

    draggingCueEl = isTemplate ? (isSeparator ? createCueSeparator('') : createCueLabel('')) : el;
    draggingCueEl.dataset.fromTemplate = isTemplate ? '1' : '';
    draggingCueEl.dataset.itemType = isSeparator ? 'sep' : 'cue';

    const r = el.getBoundingClientRect();
    draggingCueSize = { w: Math.max(20, r.width), h: Math.max(14, r.height) };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require data to be set for drag events to work.
      e.dataTransfer.setData('text/plain', el.dataset.cueId || el.dataset.sepId || el.dataset.name || 'item');
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

    pushStructuralUndoPoint();

    const range = caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) return;

    normalizeRangeForCueDrop(range);
    clearDropPreview();

    range.collapse(true);
    range.insertNode(draggingCueEl);
    draggingCueEl.after(document.createTextNode(' '));
    updateCueInteractivity();

    if (draggingCueEl.dataset.fromTemplate === '1') {
      if (draggingCueEl.dataset.itemType === 'sep') {
        const suggested = 'Section';
        const name = window.prompt('Section name:', suggested);
        if (name === null) {
          try { draggingCueEl.remove(); } catch {}
          setStatus('Cancelled');
        } else {
          const finalName = String(name).trim() || suggested;
          draggingCueEl.dataset.name = finalName;
          draggingCueEl.textContent = finalName;
          draggingCueEl.dataset.fromTemplate = '';
          draggingCueEl.dataset.itemType = '';
          setStatus('Section added');
        }
        refreshCueToc();
      } else {
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
          draggingCueEl.dataset.itemType = '';
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
      }
    } else {
      setStatus(draggingCueEl.classList.contains('cue-separator') ? 'Section moved' : 'Cue moved');
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
    const inCue = el?.closest?.('.cue-label, .cue-separator');
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
