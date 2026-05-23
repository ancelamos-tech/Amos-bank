(() => {
  'use strict';

  // ---------- CONFIG ----------
  const REFRESH_MS = 60_000;

  // ILS is the base — display "1 X = ? ILS" for each of these.
  const BASE = 'ILS';
  const CURRENCIES = [
    { code: 'USD', name: 'US Dollar',          flag: 'US' },
    { code: 'EUR', name: 'Euro',               flag: 'EU' },
    { code: 'GBP', name: 'British Pound',      flag: 'GB' },
    { code: 'JPY', name: 'Japanese Yen',       flag: 'JP' },
    { code: 'CHF', name: 'Swiss Franc',        flag: 'CH' },
    { code: 'CAD', name: 'Canadian Dollar',    flag: 'CA' },
    { code: 'AUD', name: 'Australian Dollar',  flag: 'AU' },
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
          <span class="muted">1 ${c.code} → ILS</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  async function fetchFx() {
    setStatus(null, 'Fetching rates…');
    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${BASE}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.result !== 'success' && !data.rates) throw new Error('Bad payload');
      // API returns rates[X] = how many X per 1 ILS. We want ILS per 1 X = 1 / rates[X].
      const ratesPerILS = data.rates;
      const ilsPer = {};
      for (const c of CURRENCIES) {
        const r = ratesPerILS[c.code];
        if (r && isFinite(r) && r > 0) ilsPer[c.code] = 1 / r;
      }
      const ts = data.time_last_update_unix ? new Date(data.time_last_update_unix * 1000) : new Date();
      state.fxOnline = true;
      renderFx(ilsPer, ts, true);
      setStatus(true, `Live · ${fmtTime()}`);
    } catch (err) {
      console.warn('FX fetch failed', err);
      state.fxOnline = false;
      renderFxError();
      setStatus(false, 'Rates offline');
    }
  }

  function renderFx(ilsPer, ts, animate) {
    const grid = $('#fx-grid');
    grid.innerHTML = '';
    for (const c of CURRENCIES) {
      const rate = ilsPer[c.code]; // ILS per 1 unit of c.code
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
        const up = diff > 0; // rate up = currency strengthened against ILS
        const cls = up ? 'up' : 'down';
        const arrow = up ? '▲' : '▼';
        changeHtml = `<span class="change ${cls}">${arrow} ${Math.abs(pct).toFixed(3)}%</span>`;
        if (animate) flashClass = up ? 'flash-up' : 'flash-down';
      }

      const display = rate != null ? '₪ ' + fmtNum(rate, 4) : '—';

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
        </div>
        <div class="card-foot">
          ${changeHtml}
          <span class="muted">1 ${c.code} → ILS</span>
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

  // ---------- WALLET (simplified) ----------
  const WALLET_KEY = 'amosmoney.wallet.v2';

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

  const fmtILS = (n) => '₪ ' + fmtNum(n, 2);

  function renderWallet() {
    const list = $('#wallet-list');
    const empty = $('#wallet-empty');
    list.innerHTML = '';

    const total = state.wallet.reduce((s, h) => s + (Number(h.value) || 0), 0);
    $('#wallet-total').textContent = fmtILS(total);

    empty.hidden = state.wallet.length > 0;

    for (const h of state.wallet) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="name"></span>
        <span class="val">${fmtILS(Number(h.value) || 0)}</span>
        <button class="del" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      `;
      li.querySelector('.name').textContent = h.name;
      li.querySelector('.del').addEventListener('click', () => {
        state.wallet = state.wallet.filter(x => x.id !== h.id);
        saveWallet();
        renderWallet();
      });
      list.appendChild(li);
    }
  }

  const walletForm = $('#wallet-form');
  walletForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = walletForm.elements.name.value.trim();
    const value = Number(walletForm.elements.value.value);
    if (!name || !isFinite(value) || value < 0) return;
    state.wallet.push({ id: uid(), name, value });
    saveWallet();
    renderWallet();
    walletForm.reset();
    walletForm.elements.name.focus();
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
