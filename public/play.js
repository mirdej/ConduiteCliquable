(() => {
  const cfg = window.__PLAY__ || { oscGoUrl: '/osc/go', eventsUrl: '/events', wsPath: '/ws' };

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

  /** @type {WebSocket | null} */
  let ws = null;
  let suppressWsSend = false;

  window.addEventListener('DOMContentLoaded', () => {
    // Collect cues (read-only)
    cues = Array.from(document.querySelectorAll('.cue-label'));

    addCommentBadges();

    mountControls();
    mountToc();

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

    btnGo?.addEventListener('click', async (e) => {
      e.preventDefault();
      await triggerPendingCueAndAdvance();
    });

    // Optional: spacebar to GO (mobile won’t use this, but harmless)
    window.addEventListener('keydown', async (e) => {
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

  function mountToc() {
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

    toggle?.addEventListener('click', () => {
      panel.classList.toggle('is-open');
    });

    // Close the TOC when tapping outside it (mobile friendly)
    document.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('is-open')) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (panel.contains(t)) return;
      panel.classList.remove('is-open');
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

  async function triggerPendingCueAndAdvance() {
    if (!cues.length) return;
    if (pendingIndex < 0) setPending(0);
    if (pendingIndex < 0) return;

    const cueEl = cues[pendingIndex];
    try {
      await sendOscGo(cueEl);
      cueEl.classList.add('play-triggered');
      tocButtonsByIndex.get(pendingIndex)?.classList.add('is-triggered');
    } catch (err) {
      console.warn('OSC send failed', err);
      return;
    }

    // advance
    if (pendingIndex < cues.length - 1) setPending(pendingIndex + 1);
  }

  async function sendOscGo(cueEl) {
    const ds = /** @type {any} */ (cueEl.dataset || {});
    const body = {
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
      const es = new EventSource(cfg.eventsUrl || '/events');
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
    } catch {
      // ignore
    }
  }
})();
