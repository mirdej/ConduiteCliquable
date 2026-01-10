(() => {
  const cfg = window.__PLAY__ || { oscGoUrl: '/osc/go', eventsUrl: '/events', wsPath: '/ws' };

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

  /** @type {HTMLElement[]} */
  let cues = [];
  let pendingIndex = -1;

  /** @type {Map<number, HTMLButtonElement>} */
  const tocButtonsByIndex = new Map();

  /** @type {HTMLButtonElement | null} */
  let btnPrev = null;
  /** @type {HTMLButtonElement | null} */
  let btnNext = null;
  /** @type {HTMLButtonElement | null} */
  let btnGo = null;

  /** @type {HTMLElement | null} */
  let tocPanel = null;

  /** @type {HTMLButtonElement | null} */
  let tocTab = null;

  /** @type {HTMLElement | null} */
  let pendingPanel = null;

  /** @type {HTMLElement | null} */
  let lastTriggeredPanel = null;

  /** @type {WebSocket | null} */
  let ws = null;
  let suppressWsSend = false;

  window.addEventListener('DOMContentLoaded', () => {
    // Collect cues (read-only)
    cues = Array.from(document.querySelectorAll('.cue-label'));

    addCommentBadges();

    mountLastTriggeredPanel();
    mountPendingInfoPanel();

    mountControls();
    mountToc();

    // Click any cue (or its comment badge) to make it the pending cue.
    document.addEventListener('click', (e) => {
      if (goHoldActive) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (!t) return;
      // Don't steal interactions from UI chrome.
      if (t.closest('.play-controls, .play-toc, .play-toc-tab')) return;

      const cue = t.closest('.cue-label');
      if (!cue) return;
      const idx = cues.indexOf(/** @type {HTMLElement} */ (cue));
      if (idx < 0) return;
      e.preventDefault();
      setPending(idx);
    }, true);

    // Initial pending cue
    const preset = document.querySelector('.cue-label.play-pending, .cue-label.cue-label--pending');
    if (preset && preset.classList.contains('cue-label')) {
      const idx = cues.indexOf(/** @type {HTMLElement} */ (preset));
      setPending(Math.max(0, idx));
    } else {
      setPending(cues.length ? 0 : -1);
    }

    wireRemoteControl();

    // Live sync (pending cue + file changes)
    initWebSocket();
  });

  function addCommentBadges() {
    for (const cue of cues) {
      const comment = String(cue?.dataset?.comment || '').trim();
      const has = comment.length > 0;
      cue.classList.toggle('has-comment', has);
      if (!has) continue;

      if (cue.querySelector('.play-comment-badge')) continue;
      const badge = document.createElement('span');
      badge.className = 'play-comment-badge';
      badge.innerHTML = `<span class="play-comment-badge-letter" aria-hidden="true">C</span><span class="play-comment-badge-text"></span>`;
      badge.setAttribute('aria-hidden', 'true');
      badge.title = comment;
      cue.appendChild(badge);
    }

    refreshCommentBadges();
  }

  function refreshCommentBadges() {
    // Put the whole comment into the badge, but only show it for the pending cue
    // to keep the page readable.
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const comment = String(cue?.dataset?.comment || '').trim();
      const textEl = cue.querySelector('.play-comment-badge-text');
      if (!textEl) continue;
      textEl.textContent = comment;
      textEl.classList.toggle('is-visible', i === pendingIndex && comment.length > 0);
    }
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
        // Simplest + safest: reload to fetch the new HTML.
        // Debounce by letting the browser coalesce multiple updates.
        window.setTimeout(() => location.reload(), 50);
        return;
      }

      if (type === 'state' || type === 'pending') {
        const pending = msg?.pending || {};
        const cueId = String(pending?.cueId || '');
        const index = Number.isFinite(pending?.index) ? Number(pending.index) : -1;

        suppressWsSend = true;
        try {
          if (cueId) {
            const idx = cues.findIndex((c) => String(c?.dataset?.cueId || '') === cueId);
            if (idx >= 0) setPending(idx);
            else if (index >= 0) setPending(Math.max(0, Math.min(cues.length - 1, index)));
          } else if (index >= 0) {
            setPending(Math.max(0, Math.min(cues.length - 1, index)));
          }
        } finally {
          suppressWsSend = false;
        }
      }

      if (type === 'go') {
        const cue = msg?.cue || {};
        const cueId = String(cue?.cueId || '');
        if (cueId) {
          const el = cues.find((c) => String(c?.dataset?.cueId || '') === cueId) || null;
          if (el) {
            refreshLastTriggeredPanel(el);
            return;
          }
        }

        refreshLastTriggeredPanelFromData({
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
      // best-effort reconnect
      window.setTimeout(initWebSocket, 1000);
    });
  }

  function mountControls() {
    const bar = document.createElement('div');
    bar.className = 'play-controls';
    bar.innerHTML = `
      <button class="play-btn play-btn--small" type="button" data-action="prev" aria-label="Previous cue">Prev</button>
      <button class="play-btn play-btn--go" type="button" data-action="go" aria-label="Go">GO</button>
      <button class="play-btn play-btn--small" type="button" data-action="next" aria-label="Next cue">Next</button>
    `;
    document.body.appendChild(bar);

    const setControlsHeightVar = () => {
      try {
        const h = Math.round(bar.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--play-controls-height', `${h}px`);
      } catch {
        // ignore
      }
    };
    setControlsHeightVar();
    window.addEventListener('resize', setControlsHeightVar);

    btnPrev = bar.querySelector('button[data-action="prev"]');
    btnNext = bar.querySelector('button[data-action="next"]');
    btnGo = bar.querySelector('button[data-action="go"]');

    btnPrev?.addEventListener('click', (e) => {
      e.preventDefault();
      gotoCueByDelta(-1);
    });

    btnNext?.addEventListener('click', (e) => {
      e.preventDefault();
      gotoCueByDelta(1);
    });

    // GO: trigger-on-release (prevents false triggers on touch screens)
    // - pointerdown arms + blocks UI interactions
    // - pointerup triggers only if released on the button
    if (btnGo) {
      const haptic = (kind) => {
        // Best-effort only: iOS Safari does not reliably support Vibration API.
        try {
          const v = navigator?.vibrate;
          if (typeof v !== 'function') return;
          if (kind === 'press') v.call(navigator, 12);
          if (kind === 'go') v.call(navigator, [18, 26, 18]);
        } catch {}
      };

      const updateHoldInsideFromPoint = (x, y) => {
        if (!btnGo) return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const r = btnGo.getBoundingClientRect();
        const inside = (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
        goHoldInside = inside;
        btnGo.classList.toggle('is-hold-outside', !inside);
      };

      btnGo.addEventListener('pointerdown', (e) => {
        if (!btnGo || btnGo.disabled) return;
        // Only the primary button/finger should arm.
        if (typeof e.button === 'number' && e.button !== 0) return;
        if (goHoldActive) return;
        e.preventDefault();

        goHoldActive = true;
        goHoldPointerId = e.pointerId;
        goHoldInside = true;
        ignoreGoClickUntil = Date.now() + 1500;
        btnGo.classList.add('is-hold');
        btnGo.classList.remove('is-hold-outside');
        document.body.classList.add('go-hold-active');
        ensureGoHoldBlockers();
        ensureGoShield();
        if (goShieldEl) goShieldEl.hidden = false;
        freezeScrollWhileHoldingGo();
        haptic('press');

        // Ensure the pending strip slides up enough to never be covered by the huge GO.
        requestAnimationFrame(() => {
          try {
            const r = btnGo.getBoundingClientRect();
            const lift = Math.max(120, Math.round(r.height * 0.95));
            document.documentElement.style.setProperty('--play-go-hold-lift', `${lift}px`);
          } catch {}
        });

        try { btnGo.setPointerCapture(e.pointerId); } catch {}
      }, { passive: false });

      // With pointer capture, we still receive moves even if the finger drifts.
      btnGo.addEventListener('pointermove', (e) => {
        if (!goHoldActive) return;
        if (goHoldPointerId != null && e.pointerId !== goHoldPointerId) return;
        updateHoldInsideFromPoint(e.clientX, e.clientY);
      }, { passive: true });

      const endHold = () => {
        goHoldActive = false;
        goHoldPointerId = null;
        goHoldInside = false;
        btnGo?.classList.remove('is-hold');
        btnGo?.classList.remove('is-hold-outside');
        document.body.classList.remove('go-hold-active');
        if (goShieldEl) goShieldEl.hidden = true;
        try { document.documentElement.style.removeProperty('--play-go-hold-lift'); } catch {}
        unfreezeScrollWhileHoldingGo();
      };

      btnGo.addEventListener('pointercancel', () => {
        if (!goHoldActive) return;
        endHold();
      });

      btnGo.addEventListener('lostpointercapture', () => {
        if (!goHoldActive) return;
        endHold();
      });

      btnGo.addEventListener('pointerup', async (e) => {
        if (!btnGo || !goHoldActive) return;
        if (goHoldPointerId != null && e.pointerId !== goHoldPointerId) return;
        e.preventDefault();

        // iOS reliability: use bounding-rect tracking instead of elementFromPoint.
        updateHoldInsideFromPoint(e.clientX, e.clientY);
        const releasedOnGo = goHoldInside;

        endHold();
        if (!releasedOnGo) return;
        if (btnGo.disabled) return;
        haptic('go');
        await triggerPendingCueAndAdvance();
      }, { passive: false });

      // Keep keyboard accessibility: if a real keyboard "click" happens, still GO.
      // Ignore synthetic clicks produced after pointer interactions.
      btnGo.addEventListener('click', async (e) => {
        if (goHoldActive || Date.now() < ignoreGoClickUntil) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        await triggerPendingCueAndAdvance();
      });
    }

    // Optional: spacebar to GO (mobile won’t use this, but harmless)
    window.addEventListener('keydown', async (e) => {
      if (goHoldActive) return;
      if (e.code === 'Space') {
        // avoid scrolling, and avoid triggering when typing in an input
        const active = document.activeElement;
        const tag = active?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return;
        e.preventDefault();
        await triggerPendingCueAndAdvance();
      }
      if (e.key === 'ArrowLeft') gotoCueByDelta(-1);
      if (e.key === 'ArrowRight') gotoCueByDelta(1);
    }, { passive: false });

    syncControlsEnabled();
  }

  function ensureGoShield() {
    if (goShieldEl) return;
    const el = document.createElement('div');
    el.className = 'play-go-shield';
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');

    const stop = (e) => {
      if (!goHoldActive) return;
      e.preventDefault();
      e.stopPropagation();
    };

    // Block interactions (tap, click, drag, scroll) while GO is held.
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

    // iOS Safari: touch drags can still scroll/select even with pointer capture.
    // Block at the document level in the capture phase.
    document.addEventListener('touchstart', block, { capture: true, passive: false });
    document.addEventListener('touchmove', block, { capture: true, passive: false });
    document.addEventListener('touchend', block, { capture: true, passive: false });
    document.addEventListener('touchcancel', block, { capture: true, passive: false });
    document.addEventListener('selectionstart', block, true);
    document.addEventListener('contextmenu', block, true);
    window.addEventListener('scroll', (e) => {
      if (!goHoldActive) return;
      // In case scroll still happens, snap back.
      try { window.scrollTo(0, goHoldScrollY); } catch {}
      e.preventDefault?.();
    }, { passive: false });
  }

  function freezeScrollWhileHoldingGo() {
    // Freeze the page to prevent iOS scroll rubber-banding + accidental text selection.
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

  function mountPendingInfoPanel() {
    const panel = document.createElement('div');
    panel.className = 'play-pending-panel';
    panel.innerHTML = `
      <span class="play-pending-label">Pending</span>
      <span class="play-pending-name" aria-label="Pending cue">(none)</span>
      <span class="play-pending-meta" aria-label="Pending cue details"></span>
    `;
    document.body.appendChild(panel);
    pendingPanel = panel;
    refreshPendingInfoPanel();
  }

  function mountLastTriggeredPanel() {
    const panel = document.createElement('div');
    panel.className = 'play-last-panel is-empty';
    panel.innerHTML = `
      <span class="play-last-label">Last GO</span>
      <span class="play-last-name" aria-label="Last triggered cue">(none)</span>
      <span class="play-last-meta" aria-label="Last triggered cue details"></span>
      <span class="play-last-time" aria-label="Last triggered cue time"></span>
    `;
    document.body.appendChild(panel);
    lastTriggeredPanel = panel;
  }

  function refreshLastTriggeredPanel(cueEl) {
    if (!lastTriggeredPanel) return;
    const nameEl = lastTriggeredPanel.querySelector('.play-last-name');
    const metaEl = lastTriggeredPanel.querySelector('.play-last-meta');
    const timeEl = lastTriggeredPanel.querySelector('.play-last-time');

    if (!cueEl) {
      if (nameEl) nameEl.textContent = '(none)';
      if (metaEl) metaEl.textContent = '';
      if (timeEl) timeEl.textContent = '';
      lastTriggeredPanel.classList.add('is-empty');
      return;
    }

    lastTriggeredPanel.classList.remove('is-empty');

    const ds = /** @type {any} */ (cueEl.dataset || {});
    const name = cueName(cueEl);
    refreshLastTriggeredPanelFromData({
      name,
      light: String(ds.light || ''),
      video: String(ds.video || ''),
      audio: String(ds.audio || ''),
      tracker: String(ds.tracker || '')
    });

    if (timeEl) {
      try {
        const t = new Date();
        timeEl.textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch {
        timeEl.textContent = '';
      }
    }
  }

  function refreshLastTriggeredPanelFromData(data) {
    if (!lastTriggeredPanel) return;
    const nameEl = lastTriggeredPanel.querySelector('.play-last-name');
    const metaEl = lastTriggeredPanel.querySelector('.play-last-meta');
    if (!nameEl || !metaEl) return;

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

  function refreshPendingInfoPanel() {
    if (!pendingPanel) return;
    const nameEl = pendingPanel.querySelector('.play-pending-name');
    const metaEl = pendingPanel.querySelector('.play-pending-meta');

    const cue = (pendingIndex >= 0 && pendingIndex < cues.length) ? cues[pendingIndex] : null;
    if (!cue) {
      if (nameEl) nameEl.textContent = '(none)';
      if (metaEl) metaEl.textContent = '';
      pendingPanel.classList.add('is-empty');
      return;
    }

    pendingPanel.classList.remove('is-empty');

    const ds = /** @type {any} */ (cue.dataset || {});
    const name = cueName(cue);
    if (nameEl) nameEl.textContent = `${name} (${pendingIndex + 1}/${cues.length})`;

    if (metaEl) {
      const parts = [];
      const light = String(ds.light || '').trim();
      const video = String(ds.video || '').trim();
      const audio = String(ds.audio || '').trim();
      const tracker = String(ds.tracker || '').trim();
      if (light) parts.push(`L:${light}`);
      if (video) parts.push(`V:${video}`);
      if (audio) parts.push(`A:${audio}`);
      if (tracker) parts.push(`T:${tracker}`);
      metaEl.textContent = parts.join('  ');
    }
  }

  function mountToc() {
    const tab = document.createElement('button');
    tab.className = 'play-toc-tab';
    tab.type = 'button';
    tab.setAttribute('aria-label', 'Open table of contents');
    tab.setAttribute('title', 'TOC');
    tab.textContent = 'TOC';
    document.body.appendChild(tab);
    tocTab = tab;

    const panel = document.createElement('aside');
    panel.className = 'play-toc';
    panel.innerHTML = `
      <div class="play-toc-header">
        <button class="play-toc-toggle" type="button" aria-label="Toggle table of contents" title="TOC">TOC</button>
        <div class="play-toc-title">Table of contents</div>
      </div>
      <div class="play-toc-content"></div>
    `;
    document.body.appendChild(panel);
    tocPanel = panel;

    const toggle = panel.querySelector('.play-toc-toggle');
    const content = panel.querySelector('.play-toc-content');

    const setTocOpen = (open) => {
      panel.classList.toggle('is-open', Boolean(open));
      if (tocTab) tocTab.hidden = Boolean(open);
      if (toggle) toggle.setAttribute('aria-expanded', String(Boolean(open)));
      if (tocTab) tocTab.setAttribute('aria-expanded', String(Boolean(open)));
    };

    setTocOpen(false);

    toggle?.addEventListener('click', () => {
      setTocOpen(!panel.classList.contains('is-open'));
    });

    tab.addEventListener('click', () => {
      setTocOpen(true);
    });

    // Close the TOC when tapping outside it (mobile friendly)
    document.addEventListener('pointerdown', (e) => {
      if (goHoldActive) return;
      if (!panel.classList.contains('is-open')) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (tocTab && tocTab.contains(t)) return;
      if (panel.contains(t)) return;
      setTocOpen(false);
    });

    // Build sectioned TOC based on cue-separator elements
    const sections = buildSections();
    if (!content) return;

    for (const section of sections) {
      const details = document.createElement('details');
      details.open = false;

      const summary = document.createElement('summary');
      summary.textContent = section.title;
      details.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'play-toc-list';

      for (const cueIndex of section.cueIndexes) {
        const cueEl = cues[cueIndex];
        const label = cueName(cueEl);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'play-toc-item';
        btn.textContent = label;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          setPending(cueIndex);
          // keep TOC open (so it’s usable on mobile)
        });
        list.appendChild(btn);
        tocButtonsByIndex.set(cueIndex, btn);
      }

      details.appendChild(list);
      content.appendChild(details);
    }

    // Open first section by default, if any
    const first = content.querySelector('details');
    if (first) first.open = true;
  }

  function cueName(cueEl) {
    const ds = /** @type {any} */ (cueEl.dataset || {});
    const name = String(ds.name || '').trim();
    if (name) return name;
    return String(cueEl.textContent || '').trim() || '(cue)';
  }

  function buildSections() {
    /** @type {{ title: string, cueIndexes: number[] }[]} */
    const sections = [];

    // Map cue element -> index for quick lookup
    const cueIndexByEl = new Map();
    cues.forEach((el, idx) => cueIndexByEl.set(el, idx));

    // Find separators and the cues that follow them
    const allNodes = Array.from(document.body.querySelectorAll('.cue-separator, .cue-label'));

    let currentTitle = 'Start';
    /** @type {number[]} */
    let current = [];

    const pushSection = () => {
      if (current.length) sections.push({ title: currentTitle, cueIndexes: current });
    };

    for (const node of allNodes) {
      if (node.classList.contains('cue-separator')) {
        // start new section
        pushSection();
        currentTitle = String(node.textContent || '').trim() || 'Section';
        current = [];
        continue;
      }
      if (node.classList.contains('cue-label')) {
        const idx = cueIndexByEl.get(node);
        if (typeof idx === 'number') current.push(idx);
      }
    }

    pushSection();

    // If there were no separators and we still have cues, ensure one section
    if (!sections.length && cues.length) {
      sections.push({ title: 'Cues', cueIndexes: cues.map((_, i) => i) });
    }

    return sections;
  }

  function setPending(nextIndex) {
    // Clear
    if (pendingIndex >= 0 && cues[pendingIndex]) {
      cues[pendingIndex].classList.remove('play-pending');
      tocButtonsByIndex.get(pendingIndex)?.classList.remove('is-active');
    }

    pendingIndex = nextIndex;

    if (pendingIndex >= 0 && cues[pendingIndex]) {
      const el = cues[pendingIndex];
      el.classList.add('play-pending');
      tocButtonsByIndex.get(pendingIndex)?.classList.add('is-active');
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }

    refreshCommentBadges();
    refreshPendingInfoPanel();

    // Broadcast pending cue selection to other clients.
    if (!suppressWsSend && ws && ws.readyState === ws.OPEN && pendingIndex >= 0 && cues[pendingIndex]) {
      const cueId = String(cues[pendingIndex]?.dataset?.cueId || '');
      try {
        ws.send(JSON.stringify({ type: 'setPending', cueId, index: pendingIndex, ts: Date.now() }));
      } catch {
        // ignore
      }
    }

    syncControlsEnabled();
  }

  function syncControlsEnabled() {
    const has = cues.length > 0 && pendingIndex >= 0;
    if (btnGo) btnGo.disabled = !has;
    if (btnPrev) btnPrev.disabled = !has || pendingIndex <= 0;
    if (btnNext) btnNext.disabled = !has || pendingIndex >= cues.length - 1;
  }

  function gotoCueByDelta(delta) {
    if (!cues.length) return;
    const base = pendingIndex >= 0 ? pendingIndex : 0;
    const next = Math.max(0, Math.min(cues.length - 1, base + delta));
    setPending(next);
  }

  // Guard against duplicate GO triggers (OSC/SSE duplicates, key repeat, double taps).
  let goInFlight = false;
  let lastGoAtMs = 0;
  const GO_COOLDOWN_MS = 250;

  async function triggerPendingCueAndAdvance() {
    if (!cues.length) return;
    if (pendingIndex < 0) setPending(0);
    if (pendingIndex < 0) return;

     const now = Date.now();
     if (goInFlight) return;
     if (GO_COOLDOWN_MS > 0 && now - lastGoAtMs < GO_COOLDOWN_MS) return;
     goInFlight = true;
     lastGoAtMs = now;

    const cueEl = cues[pendingIndex];
    try {
      await sendOscGo(cueEl);
      refreshLastTriggeredPanel(cueEl);
      cueEl.classList.add('play-triggered');
      tocButtonsByIndex.get(pendingIndex)?.classList.add('is-triggered');
    } catch (err) {
      console.warn('OSC send failed', err);
      return;
    } finally {
      // Keep a small cooldown even after completion; helps with back-to-back duplicates.
      window.setTimeout(() => {
        goInFlight = false;
      }, GO_COOLDOWN_MS);
    }

    // advance
    if (pendingIndex < cues.length - 1) setPending(pendingIndex + 1);
  }

  async function sendOscGo(cueEl) {
    const ds = /** @type {any} */ (cueEl.dataset || {});
    const body = {
      cueId: String(ds.cueId || ''),
      name: cueName(cueEl),
      light: String(ds.light || ''),
      video: String(ds.video || ''),
      audio: String(ds.audio || ''),
      tracker: String(ds.tracker || ''),
      comment: String(ds.comment || '')
    };

    const resp = await fetch(cfg.oscGoUrl || '/osc/go', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`oscGo failed: ${resp.status} ${txt}`);
    }
  }

  function wireRemoteControl() {
    try {
      const prev = window.__LCDC_PLAY_EVENTS__;
      try { prev?.close?.(); } catch {}

      const es = new EventSource(cfg.eventsUrl || '/events');
      window.__LCDC_PLAY_EVENTS__ = es;
      es.addEventListener('message', async (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        const cmd = String(data?.cmd || '');
        if (cmd === 'go') {
          if (btnGo?.disabled) return;
          await triggerPendingCueAndAdvance();
        } else if (cmd === 'prev') {
          gotoCueByDelta(-1);
        } else if (cmd === 'next') {
          gotoCueByDelta(1);
        }
      });

      window.addEventListener('beforeunload', () => {
        try { es.close(); } catch {}
      });
    } catch {
      // ignore
    }
  }
})();
