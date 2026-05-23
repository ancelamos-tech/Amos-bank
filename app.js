(() => {
  'use strict';

  // ---------- CONFIG ----------
  const REFRESH_MS = 60_000;

  const CURRENCIES = [
    { code: 'USD', name: 'US Dollar',          flag: 'US' },
    { code: 'EUR', name: 'Euro',               flag: 'EU' },
    { code: 'GBP', name: 'British Pound',      flag: 'GB' },
    { code: 'JPY', name: 'Japanese Yen',       flag: 'JP' },
    { code: 'CHF', name: 'Swiss Franc',        flag: 'CH' },
    { code: 'CAD', name: 'Canadian Dollar',    flag: 'CA' },
    { code: 'AUD', name: 'Australian Dollar',  flag: 'AU' },
    { code: 'ILS', name: 'Israeli Shekel',     flag: 'IL' },
  ];

  const STOCKS = [
    { symbol: 'AAPL',  name: 'Apple Inc.' },
    { symbol: 'MSFT',  name: 'Microsoft' },
    { symbol: 'GOOGL', name: 'Alphabet' },
    { symbol: 'AMZN',  name: 'Amazon' },
    { symbol: 'NVDA',  name: 'NVIDIA' },
    { symbol: 'META',  name: 'Meta Platforms' },
    { symbol: 'TSLA',  name: 'Tesla' },
    { symbol: 'BRK-B', name: 'Berkshire Hathaway' },
    { symbol: 'JPM',   name: 'JPMorgan Chase' },
    { symbol: 'V',     name: 'Visa Inc.' },
  ];

  // ---------- STATE ----------
  const state = {
    fx: {},       // code -> { rate, prev }
    stk: {},      // symbol -> { price, prev, change, changePct, currency }
    wallet: [],
    route: 'currency',
    fxTimer: null,
    stkTimer: null,
    fxOnline: null,
    stkOnline: null,
  };

  // ---------- UTILS ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtMoney = (n, ccy = 'USD', max = 2) => {
    if (n == null || !isFinite(n)) return '—';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: ccy,
        minimumFractionDigits: 2, maximumFractionDigits: max,
      }).format(n);
    } catch {
      return `${ccy} ${n.toFixed(max)}`;
    }
  };
  const fmtNum = (n, max = 4) => {
    if (n == null || !isFinite(n)) return '—';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: max,
    }).format(n);
  };
  const fmtTime = (d = new Date()) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  const uid = () => 'h_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const setStatus = (ok, text) => {
    const dot = $('#status-dot'); const t = $('#status-text');
    dot.classList.remove('ok', 'err');
    if (ok === true) dot.classList.add('ok');
    if (ok === false) dot.classList.add('err');
    t.textContent = text;
  };

  // ---------- ROUTING ----------
  function go(route) {
    state.route = route;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.route === route));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${route}`));
    try { history.replaceState(null, '', '#' + route); } catch {}
  }
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => go(b.dataset.route)));

  // ---------- CURRENCY ----------
  function renderFxSkeleton() {
    const grid = $('#fx-grid');
    grid.innerHTML = '';
    for (const c of CURRENCIES) {
      const card = document.createElement('div');
      card.className = 'card skeleton';
      card.dataset.code = c.code;
      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${c.flag}</div>
            <div>
              <div class="card-code">${c.code}</div>
              <div class="card-name">${c.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price"><span class="value">—</span></div>
        <div class="card-foot">
          <span class="change flat">—</span>
          <span class="muted">per 1 USD</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  async function fetchFx() {
    setStatus(null, 'Fetching rates…');
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.result !== 'success' && !data.rates) throw new Error('Bad payload');
      const rates = data.rates;
      const ts = data.time_last_update_unix ? new Date(data.time_last_update_unix * 1000) : new Date();
      state.fxOnline = true;
      renderFx(rates, ts, true);
      setStatus(true, `Live · ${fmtTime()}`);
    } catch (err) {
      console.warn('FX fetch failed', err);
      state.fxOnline = false;
      renderFxError();
      setStatus(false, 'Rates offline');
    }
  }

  function renderFx(rates, ts, animate) {
    const grid = $('#fx-grid');
    grid.innerHTML = '';
    for (const c of CURRENCIES) {
      const rate = c.code === 'USD' ? 1 : rates[c.code];
      const prev = state.fx[c.code]?.rate;
      state.fx[c.code] = { rate, prev };

      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.code = c.code;

      let changeHtml = '<span class="change flat">—</span>';
      let flashClass = '';
      if (prev != null && rate != null && prev !== rate) {
        const diff = rate - prev;
        const pct = (diff / prev) * 100;
        const up = diff > 0;
        // For FX vs USD, "up" in the rate means the currency weakened — invert visual semantics
        // so up arrow = strengthening currency (i.e., 1 unit buys more USD).
        const strengthens = c.code === 'USD' ? false : diff < 0;
        const cls = c.code === 'USD' ? 'flat' : (strengthens ? 'up' : 'down');
        const arrow = c.code === 'USD' ? '' : (strengthens ? '▲' : '▼');
        changeHtml = `<span class="change ${cls}">${arrow} ${Math.abs(pct).toFixed(3)}%</span>`;
        if (animate && c.code !== 'USD') flashClass = strengthens ? 'flash-up' : 'flash-down';
      }

      const display = c.code === 'USD' ? '1.0000' : fmtNum(rate, c.code === 'JPY' ? 2 : 4);

      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${c.flag}</div>
            <div>
              <div class="card-code">${c.code}</div>
              <div class="card-name">${c.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price">
          <span class="value">${display}</span>
          <span class="unit">${c.code}/USD</span>
        </div>
        <div class="card-foot">
          ${changeHtml}
          <span class="muted">${c.code === 'USD' ? 'Base currency' : '1 USD =' }</span>
        </div>
      `;
      grid.appendChild(card);
      if (flashClass) {
        requestAnimationFrame(() => card.classList.add(flashClass));
        setTimeout(() => card.classList.remove(flashClass), 1100);
      }
    }
    $('#fx-updated').textContent = `Updated ${fmtTime(ts)}`;
  }

  function renderFxError() {
    const grid = $('#fx-grid');
    grid.innerHTML = `
      <div class="empty" style="grid-column: 1/-1;">
        <div class="empty-icon">⚠</div>
        <h3>Couldn't load exchange rates</h3>
        <p>The rates service is unreachable. Check your connection and try again.</p>
      </div>
    `;
    $('#fx-updated').textContent = 'Offline';
  }

  // ---------- STOCKS ----------
  function renderStkSkeleton() {
    const grid = $('#stk-grid');
    grid.innerHTML = '';
    for (const s of STOCKS) {
      const card = document.createElement('div');
      card.className = 'card skeleton';
      card.dataset.symbol = s.symbol;
      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${s.symbol.slice(0, 2)}</div>
            <div>
              <div class="card-code">${s.symbol}</div>
              <div class="card-name">${s.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price"><span class="value">—</span></div>
        <div class="card-foot">
          <span class="change flat">—</span>
          <span class="muted">last trade</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  async function fetchOneStock(symbol) {
    // Yahoo Finance public chart endpoint — works cross-origin from browsers.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + symbol);
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error('No result for ' + symbol);
    const meta = r.meta || {};
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose;
    const currency = meta.currency || 'USD';
    if (price == null) throw new Error('No price for ' + symbol);
    return {
      price,
      prevClose,
      currency,
      change: prevClose != null ? price - prevClose : null,
      changePct: prevClose != null ? ((price - prevClose) / prevClose) * 100 : null,
    };
  }

  async function fetchStocks() {
    setStatus(null, 'Fetching quotes…');
    const results = await Promise.allSettled(STOCKS.map(s => fetchOneStock(s.symbol)));
    const updates = {};
    let okCount = 0;
    results.forEach((r, i) => {
      const sym = STOCKS[i].symbol;
      if (r.status === 'fulfilled') {
        updates[sym] = r.value;
        okCount++;
      } else {
        console.warn('Stock failed', sym, r.reason);
      }
    });
    state.stkOnline = okCount > 0;
    renderStocks(updates);
    if (okCount === STOCKS.length)      setStatus(true, `Live · ${fmtTime()}`);
    else if (okCount > 0)                setStatus(true, `Partial · ${okCount}/${STOCKS.length}`);
    else                                  setStatus(false, 'Quotes offline');
  }

  function renderStocks(updates) {
    const grid = $('#stk-grid');
    grid.innerHTML = '';
    let anyOk = false;
    for (const s of STOCKS) {
      const u = updates[s.symbol];
      const prevPrice = state.stk[s.symbol]?.price;
      if (u) {
        state.stk[s.symbol] = { ...u, prev: prevPrice };
        anyOk = true;
      }
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.symbol = s.symbol;

      let priceHtml, changeHtml = '<span class="change flat">—</span>', flashClass = '';
      if (u) {
        priceHtml = `<span class="value">${fmtMoney(u.price, u.currency, 2)}</span>`;
        if (u.change != null) {
          const up = u.change >= 0;
          const cls = u.change === 0 ? 'flat' : (up ? 'up' : 'down');
          const arrow = u.change === 0 ? '' : (up ? '▲' : '▼');
          changeHtml = `<span class="change ${cls}">${arrow} ${u.change >= 0 ? '+' : ''}${fmtNum(u.change, 2)} (${u.changePct >= 0 ? '+' : ''}${fmtNum(u.changePct, 2)}%)</span>`;
        }
        if (prevPrice != null && prevPrice !== u.price) {
          flashClass = u.price > prevPrice ? 'flash-up' : 'flash-down';
        }
      } else {
        priceHtml = `<span class="value muted">unavailable</span>`;
      }

      card.innerHTML = `
        <div class="card-head">
          <div class="card-symbol">
            <div class="flag">${s.symbol.replace('-', '').slice(0, 2)}</div>
            <div>
              <div class="card-code">${s.symbol}</div>
              <div class="card-name">${s.name}</div>
            </div>
          </div>
        </div>
        <div class="card-price">${priceHtml}</div>
        <div class="card-foot">
          ${changeHtml}
          <span class="muted">${u?.currency || 'USD'} · last</span>
        </div>
      `;
      grid.appendChild(card);
      if (flashClass) {
        requestAnimationFrame(() => card.classList.add(flashClass));
        setTimeout(() => card.classList.remove(flashClass), 1100);
      }
    }
    $('#stk-updated').textContent = anyOk ? `Updated ${fmtTime()}` : 'Offline';
  }

  // ---------- WALLET ----------
  const WALLET_KEY = 'amosmoney.wallet.v1';

  function loadWallet() {
    try {
      const raw = localStorage.getItem(WALLET_KEY);
      state.wallet = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.wallet)) state.wallet = [];
    } catch {
      state.wallet = [];
    }
  }
  function saveWallet() {
    try { localStorage.setItem(WALLET_KEY, JSON.stringify(state.wallet)); } catch {}
  }

  function renderWallet() {
    const list = $('#wallet-list');
    const empty = $('#wallet-empty');
    list.innerHTML = '';

    let total = 0;
    for (const h of state.wallet) total += (Number(h.amount) || 0) * (Number(h.value) || 0);
    $('#wallet-total').textContent = fmtMoney(total, 'USD', 2);
    $('#wallet-count').textContent = String(state.wallet.length);

    if (state.wallet.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const h of state.wallet) {
      const card = document.createElement('div');
      card.className = 'holding';
      const subtotal = (Number(h.amount) || 0) * (Number(h.value) || 0);
      card.innerHTML = `
        <div class="holding-head">
          <div>
            <div class="holding-name"></div>
            ${h.note ? '<div class="holding-note"></div>' : ''}
          </div>
          <div class="holding-actions">
            <button class="icon-btn" data-act="edit" aria-label="Edit holding">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
            <button class="icon-btn" data-act="delete" aria-label="Delete holding">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </div>
        <div class="holding-total">${fmtMoney(subtotal, 'USD', 2)}</div>
        <div class="holding-meta">
          <span>${fmtNum(Number(h.amount), 6)} × ${fmtMoney(Number(h.value), 'USD', 4)}</span>
          <span>${total > 0 ? ((subtotal / total) * 100).toFixed(1) + '%' : '—'}</span>
        </div>
      `;
      card.querySelector('.holding-name').textContent = h.name;
      const noteEl = card.querySelector('.holding-note');
      if (noteEl) noteEl.textContent = h.note;
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openModal(h.id));
      card.querySelector('[data-act="delete"]').addEventListener('click', () => deleteHolding(h.id));
      list.appendChild(card);
    }
  }

  function deleteHolding(id) {
    const h = state.wallet.find(x => x.id === id);
    if (!h) return;
    if (!confirm(`Delete "${h.name}"?`)) return;
    state.wallet = state.wallet.filter(x => x.id !== id);
    saveWallet();
    renderWallet();
  }

  // ---------- MODAL ----------
  const modal = $('#holding-modal');
  const form = $('#holding-form');
  let editingId = null;

  function openModal(id = null) {
    editingId = id;
    form.reset();
    $('#modal-title').textContent = id ? 'Edit Holding' : 'Add Holding';
    $('#modal-save').textContent = id ? 'Save changes' : 'Save';
    if (id) {
      const h = state.wallet.find(x => x.id === id);
      if (h) {
        form.elements.name.value = h.name;
        form.elements.amount.value = h.amount;
        form.elements.value.value = h.value;
        form.elements.note.value = h.note || '';
      }
    }
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => form.elements.name.focus(), 50);
  }
  function closeModal() {
    modal.setAttribute('aria-hidden', 'true');
    editingId = null;
  }

  $('#wallet-add').addEventListener('click', () => openModal());
  $$('#holding-modal [data-close]').forEach(el => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.getAttribute('aria-hidden') === 'false') closeModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const amount = Number(form.elements.amount.value);
    const value = Number(form.elements.value.value);
    const note = form.elements.note.value.trim();
    if (!name || !isFinite(amount) || !isFinite(value) || amount < 0 || value < 0) return;
    if (editingId) {
      const h = state.wallet.find(x => x.id === editingId);
      if (h) Object.assign(h, { name, amount, value, note });
    } else {
      state.wallet.push({ id: uid(), name, amount, value, note, createdAt: Date.now() });
    }
    saveWallet();
    renderWallet();
    closeModal();
  });

  // ---------- BOOT ----------
  function startTimers() {
    if (state.fxTimer) clearInterval(state.fxTimer);
    if (state.stkTimer) clearInterval(state.stkTimer);
    state.fxTimer = setInterval(fetchFx, REFRESH_MS);
    state.stkTimer = setInterval(fetchStocks, REFRESH_MS);
  }

  $('#fx-refresh').addEventListener('click', fetchFx);
  $('#stk-refresh').addEventListener('click', fetchStocks);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Refresh quietly when returning to tab if stale > 60s
      fetchFx();
      fetchStocks();
    }
  });

  function boot() {
    const hash = (location.hash || '').replace('#', '');
    if (['currency', 'stocks', 'wallet'].includes(hash)) go(hash);

    renderFxSkeleton();
    renderStkSkeleton();
    loadWallet();
    renderWallet();

    fetchFx();
    fetchStocks();
    startTimers();
  }
  boot();
})();
