import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

// ---------------------------------------------------------------- utilità
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '');
const nf = new Intl.NumberFormat('it-IT');
const money = (v, cur) => {
  if (v == null) return '–';
  const c = cur === 'EUR' || cur === 'USD' ? cur : null;
  return c ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v) : nf.format(v);
};
const date = v => (v ? new Date(v).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '–');
const monthLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString('it-IT', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const TYPE_LABEL = { Partner: 'Partner', Affiliate: 'Affiliato', Unspecified: 'Non definito' };
const FORMAT_LABEL = { video: 'Video', short: 'Short', live: 'Live', post: 'Post', reel: 'Reel', carousel: 'Carosello', story: 'Storia', other: 'Altro' };
const PLATFORM_LABEL = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', other: 'Altro' };
const REVIEW_LABEL = { confirmed: 'Confermata', not_relevant: 'Non pertinente', pending: 'Da verificare' };
const MENTION_LABEL = { present: 'Presente', not_detected: 'Non rilevata', not_applicable: 'Non applicabile' };

async function fetchAll(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

function downloadCsv(filename, header, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const text = [header, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toast(msg, kind = 'ok') {
  const t = Object.assign(document.createElement('div'), { className: `toast toast-${kind}`, textContent: msg, role: 'status' });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------------------------------------------------------------- stato
const state = {
  session: null,
  profile: null,
  list: null,          // { rows, ladders, asOf }
  filters: { q: '', type: 'all', onboarding: 'all', sort: 'income', dir: 'desc' },
};

// ---------------------------------------------------------------- avvio e accesso
async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange((_e, session) => {
    const changed = (session?.user?.id || null) !== (state.session?.user?.id || null);
    state.session = session;
    if (changed) { state.profile = null; state.list = null; route(); }
  });
  window.addEventListener('hashchange', route);
  route();
}

async function ensureProfile() {
  if (state.profile) return state.profile;
  const { data, error } = await sb.from('app_users').select('role, partner_id, active').eq('user_id', state.session.user.id).maybeSingle();
  if (error) throw error;
  state.profile = data && data.active ? data : { role: 'none' };
  return state.profile;
}

function renderLogin(message = '', email = '') {
  const codeStep = Boolean(email);
  app.innerHTML = `
    <main class="login">
      <form class="login-card" id="login-form" novalidate>
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span>DeepCharts <span class="brand-sub">Partner</span></div>
        <h1>Accedi</h1>
        ${codeStep
          ? `<p class="hint">Abbiamo inviato un codice a <strong>${esc(email)}</strong>. Controlla anche lo spam.</p>
             <label>Codice ricevuto via email<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required autofocus></label>`
          : `<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>`}
        ${message ? `<p class="form-error" role="alert">${esc(message)}</p>` : ''}
        <button type="submit" class="btn btn-primary">${codeStep ? 'Accedi' : 'Invia il codice'}</button>
        ${codeStep
          ? '<button type="button" class="btn btn-ghost" id="change-email">Usa un\'altra email</button>'
          : '<p class="hint">Riceverai un codice via email, come nella dashboard attuale.</p>'}
      </form>
    </main>`;
  document.getElementById('change-email')?.addEventListener('click', () => renderLogin());
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    if (!codeStep) {
      const address = String(f.get('email') || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { btn.disabled = false; return renderLogin('Inserisci un indirizzo email valido.'); }
      btn.textContent = 'Invio in corso…';
      const { error } = await sb.auth.signInWithOtp({ email: address, options: { shouldCreateUser: false } });
      if (error) {
        const msg = /signups? not allowed|not found|otp_disabled/i.test(error.message)
          ? 'Questa email non è abilitata alla dashboard.'
          : /rate|seconds/i.test(error.message) ? 'Hai richiesto troppi codici. Aspetta un minuto e riprova.' : error.message;
        return renderLogin(msg);
      }
      return renderLogin('', address);
    }
    const token = String(f.get('code') || '').replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(token)) { btn.disabled = false; return renderLogin('Il codice è fatto solo di cifre: ricontrolla l\'email.', email); }
    btn.textContent = 'Verifica in corso…';
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) renderLogin(/expired|invalid/i.test(error.message) ? 'Codice non valido o scaduto. Richiedine uno nuovo.' : error.message, email);
  });
}

function shell(content, { back = false } = {}) {
  return `
    <header class="topbar">
      <div class="topbar-left">
        ${back ? '<a class="back" href="#/">Tutti i partner</a>' : ''}
        <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>DeepCharts <span class="brand-sub">Partner</span></a>
      </div>
      <div class="topbar-right">
        <span class="user">${esc(state.session.user.email)}</span>
        <button class="btn btn-ghost" id="logout">Esci</button>
      </div>
    </header>
    <main class="page">${content}</main>`;
}
function bindShell() {
  document.getElementById('logout')?.addEventListener('click', () => sb.auth.signOut());
}

async function route() {
  if (!state.session) return renderLogin();
  try {
    const profile = await ensureProfile();
    if (profile.role === 'none') {
      app.innerHTML = shell(`<section class="empty"><h1>Account non abilitato</h1><p>Il tuo account esiste ma non ha accesso a questa dashboard. Chiedi a un amministratore di abilitarlo.</p></section>`);
      return bindShell();
    }
    const m = location.hash.match(/^#\/p\/([0-9a-f-]{36})$/i);
    if (profile.role === 'partner') return renderDetail(profile.partner_id, { partnerView: true });
    if (m) return renderDetail(m[1]);
    return renderList();
  } catch (err) {
    app.innerHTML = shell(`<section class="empty"><h1>Dati non disponibili</h1><p>${esc(err.message || err)}</p><p><a class="btn" href="">Riprova</a></p></section>`);
    bindShell();
  }
}

// ---------------------------------------------------------------- scala onboarding
function ladder(steps, { size = 'sm' } = {}) {
  const cells = steps.sort((a, b) => a.position - b.position).map(s =>
    `<span class="rung rung-${s.status}" title="${esc(s.position + '. ' + s.label + ': ' + statusText(s.status))}"></span>`).join('');
  return `<span class="ladder ladder-${size}" role="img" aria-label="Onboarding ${steps.filter(s => s.status === 'done' || s.status === 'auto').length} su ${steps.filter(s => s.status !== 'not_applicable').length}">${cells}</span>`;
}
const statusText = s => ({ done: 'completato', auto: 'rilevato in automatico', todo: 'da fare', not_applicable: 'non applicabile' }[s]);

// ---------------------------------------------------------------- lista partner
async function loadList() {
  const [rows, steps] = await Promise.all([
    fetchAll(() => sb.from('partner_overview').select('*').order('id')),
    fetchAll(() => sb.from('partner_onboarding_status').select('partner_id, position, label, status').order('partner_id').order('position')),
  ]);
  const ladders = new Map();
  for (const s of steps) {
    if (!ladders.has(s.partner_id)) ladders.set(s.partner_id, []);
    ladders.get(s.partner_id).push(s);
  }
  const asOf = rows.reduce((m, r) => (r.metrics_as_of && r.metrics_as_of > m ? r.metrics_as_of : m), '');
  state.list = { rows, ladders, asOf };
}

function filteredRows() {
  const { rows } = state.list;
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let out = rows.filter(r =>
    (f.type === 'all' || r.type === f.type) &&
    (!q || [r.name, r.email, r.affiliate_code, r.brand].some(v => (v || '').toLowerCase().includes(q))) &&
    (f.onboarding === 'all' ||
      (f.onboarding === 'complete' && r.onboarding_total > 0 && r.onboarding_done >= r.onboarding_total) ||
      (f.onboarding === 'open' && r.onboarding_done < r.onboarding_total) ||
      (f.onboarding === 'review' && r.pending_review > 0)));
  const key = f.sort, dir = f.dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string' || typeof vb === 'string') return dir * String(va || '').localeCompare(String(vb || ''), 'it');
    return dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
  return out;
}

async function renderList() {
  if (!state.list) {
    app.innerHTML = shell('<p class="loading">Caricamento partner…</p>');
    bindShell();
    await loadList();
  }
  const f = state.filters;
  app.innerHTML = shell(`
    <section class="list-head">
      <div>
        <h1>Partner e affiliati</h1>
        <p class="sub">Dati commerciali aggiornati al ${esc(date(state.list.asOf))}</p>
      </div>
      <button class="btn" id="export-list">Esporta CSV</button>
    </section>
    <section class="filters" aria-label="Filtri">
      <input type="search" id="q" placeholder="Cerca per nome, email o codice" value="${esc(f.q)}" aria-label="Cerca">
      <div class="seg" role="group" aria-label="Tipo">
        ${[['all', 'Tutti'], ['Partner', 'Partner'], ['Affiliate', 'Affiliati']].map(([v, l]) =>
          `<button data-type="${v}" aria-pressed="${f.type === v}">${l}</button>`).join('')}
      </div>
      <select id="onb" aria-label="Stato">
        <option value="all" ${f.onboarding === 'all' ? 'selected' : ''}>Tutti gli stati</option>
        <option value="open" ${f.onboarding === 'open' ? 'selected' : ''}>Onboarding in corso</option>
        <option value="complete" ${f.onboarding === 'complete' ? 'selected' : ''}>Onboarding completo</option>
        <option value="review" ${f.onboarding === 'review' ? 'selected' : ''}>Con pubblicazioni da verificare</option>
      </select>
    </section>
    <section id="summary" class="summary"></section>
    <div class="table-wrap"><table class="grid" id="list-table"></table></div>
    <p class="legend">${ladder([
      { position: 1, label: 'Completato a mano', status: 'done' },
      { position: 2, label: 'Rilevato dai dati', status: 'auto' },
      { position: 3, label: 'Da fare', status: 'todo' },
      { position: 4, label: 'Non applicabile', status: 'not_applicable' }])}
      <span>Ogni tacca è uno step di onboarding: verde completato, blu rilevato dai dati, vuoto da fare, tratteggiato non applicabile.</span></p>
  `);
  bindShell();
  drawListTable();

  document.getElementById('q').addEventListener('input', e => { f.q = e.target.value; drawListTable(); });
  document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    f.type = b.dataset.type;
    document.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawListTable();
  }));
  document.getElementById('onb').addEventListener('change', e => { f.onboarding = e.target.value; drawListTable(); });
  document.getElementById('export-list').addEventListener('click', () => {
    const rows = filteredRows();
    downloadCsv(`partner-deepcharts-${state.list.asOf}.csv`,
      ['Nome', 'Email', 'Codice', 'Tipo', 'Stato account', 'Valuta', 'Fatturato', 'Fatturato CSV precedente', 'Commissioni', 'Pending', 'Ordini', 'Click', 'Utenti', 'Demo',
        'Pubblicazioni confermate', 'Confermate ultimi 30 giorni', 'Da verificare', 'Ultima pubblicazione confermata', 'Onboarding completati', 'Onboarding totali', 'Data dati'],
      rows.map(r => [r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], r.account_status, r.currency, r.income, r.prev_income, r.commissions, r.pending, r.orders, r.clicks, r.users, r.demos,
        r.confirmed_publications, r.confirmed_last_30d, r.pending_review, r.last_confirmed_at?.slice(0, 10), r.onboarding_done, r.onboarding_total, r.metrics_as_of]));
  });
}

const COLUMNS = [
  ['name', 'Partner'], ['type', 'Tipo'], ['income', 'Fatturato'], ['orders', 'Ordini'], ['clicks', 'Click'],
  ['confirmed_last_30d', 'Pubblicazioni 30 gg'], ['onboarding_done', 'Onboarding'], ['pending_review', 'Da verificare'],
];

function drawListTable() {
  const rows = filteredRows();
  const f = state.filters;
  const totals = {};
  for (const r of rows) if (r.income != null) totals[r.currency] = (totals[r.currency] || 0) + Number(r.income);
  document.getElementById('summary').innerHTML =
    `<span><strong>${nf.format(rows.length)}</strong> ${rows.length === 1 ? 'partner' : 'partner'}</span>` +
    Object.entries(totals).filter(([c]) => c !== 'UNSPECIFIED').map(([c, v]) => `<span><strong>${money(v, c)}</strong> fatturato ${c}</span>`).join('');

  const head = `<thead><tr>${COLUMNS.map(([k, l]) => {
    const active = f.sort === k;
    const aria = active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${aria}" class="${['income', 'orders', 'clicks', 'confirmed_last_30d', 'pending_review'].includes(k) ? 'num' : ''}"><button data-sort="${k}">${l}${active ? `<span class="caret" aria-hidden="true">${f.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</button></th>`;
  }).join('')}</tr></thead>`;

  const body = rows.length ? rows.map(r => {
    const delta = r.prev_income != null && r.income != null ? Number(r.income) - Number(r.prev_income) : null;
    return `<tr data-id="${esc(r.id)}" tabindex="0">
      <td><a class="pname" href="#/p/${esc(r.id)}">${esc(r.name)}</a><span class="pmeta">${esc(r.affiliate_code || r.email)}</span></td>
      <td><span class="tag tag-${esc(r.type)}">${esc(TYPE_LABEL[r.type] || r.type)}</span></td>
      <td class="num">${money(r.income, r.currency)}${delta ? `<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${money(delta, r.currency)}</span>` : ''}</td>
      <td class="num">${r.orders == null ? '–' : nf.format(r.orders)}</td>
      <td class="num">${r.clicks == null ? '–' : nf.format(r.clicks)}</td>
      <td class="num">${nf.format(r.confirmed_last_30d)}</td>
      <td>${ladder([...(state.list.ladders.get(r.id) || [])])}<span class="ladder-count">${r.onboarding_done}/${r.onboarding_total}</span></td>
      <td class="num">${r.pending_review ? `<span class="pill-warn">${r.pending_review}</span>` : ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="${COLUMNS.length}" class="empty-row">Nessun partner corrisponde ai filtri. Prova a cancellare la ricerca o a scegliere "Tutti".</td></tr>`;

  const table = document.getElementById('list-table');
  table.innerHTML = head + `<tbody>${body}</tbody>`;
  table.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.sort;
    if (f.sort === k) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
    else { f.sort = k; f.dir = ['name', 'type'].includes(k) ? 'asc' : 'desc'; }
    drawListTable();
  }));
  table.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = '#/p/' + tr.dataset.id; });
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = '#/p/' + tr.dataset.id; });
  });
}

// ---------------------------------------------------------------- scheda partner
async function renderDetail(id, { partnerView = false } = {}) {
  app.innerHTML = shell('<p class="loading">Caricamento scheda…</p>', { back: !partnerView });
  bindShell();
  const isStaff = state.profile.role === 'admin' || state.profile.role === 'staff';

  const [p, internal, metrics, steps, goals, targets, settings, pubs, channels] = await Promise.all([
    sb.from('partners').select('*').eq('id', id).maybeSingle(),
    isStaff ? sb.from('partner_internal').select('*').eq('partner_id', id).maybeSingle() : Promise.resolve({ data: null }),
    sb.from('commercial_metrics').select('*').eq('partner_id', id).order('as_of'),
    sb.from('partner_onboarding_status').select('*').eq('partner_id', id).order('position'),
    sb.from('partner_monthly_goals').select('*').eq('partner_id', id).order('month', { ascending: false }).limit(6),
    sb.from('monthly_goal_targets').select('*').order('position'),
    sb.from('program_settings').select('*'),
    fetchAll(() => sb.from('publications').select('*').eq('partner_id', id).order('published_at', { ascending: false })),
    sb.from('social_channels').select('*').eq('partner_id', id).order('platform'),
  ].map(async q => { const r = await q; if (r && r.error) throw r.error; return Array.isArray(r) ? r : r.data; }));

  if (!p) {
    app.innerHTML = shell('<section class="empty"><h1>Partner non trovato</h1><p>Il link potrebbe essere vecchio, oppure non hai accesso a questo partner.</p><p><a class="btn" href="#/">Torna alla lista</a></p></section>', { back: !partnerView });
    return bindShell();
  }

  const S = Object.fromEntries(settings.map(s => [s.key, Number(s.value)]));
  const latest = metrics[metrics.length - 1];
  const prev = metrics[metrics.length - 2];
  const applicable = steps.filter(s => s.status !== 'not_applicable');
  const doneCount = applicable.filter(s => s.status === 'done' || s.status === 'auto').length;
  const onboardingComplete = applicable.length > 0 && doneCount === applicable.length;
  const uplift = p.type === 'Partner' ? S.goal_uplift_partner_pct : S.goal_uplift_affiliate_pct;

  const kpi = (label, key, fmt) => {
    const v = latest?.[key];
    const d = prev && v != null ? Number(v) - Number(prev[key]) : null;
    return `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value">${v == null ? '–' : fmt(v)}</span>${d ? `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)} dal ${esc(date(prev.as_of))}</span>` : ''}</div>`;
  };
  const cur = latest?.currency;

  // Goal mensili: ultimi 6 mesi, il più recente a destra
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  const goalByMonth = new Map(goals.map(g => [g.month, g]));
  const goalKey = { story_weeks: 'story_weeks', reels: 'reels', videos: 'videos', lives: 'lives' };
  const currentMonth = goalByMonth.get(months[5]);

  const ytFormatsUnclassified = goals.reduce((n, g) => n + (g.videos_unclassified || 0), 0);

  app.innerHTML = shell(`
    <section class="detail-head">
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="sub">
          <span class="tag tag-${esc(p.type)}">${esc(TYPE_LABEL[p.type])}</span>
          ${p.affiliate_code ? `<span>Codice <strong>${esc(p.affiliate_code)}</strong></span>` : ''}
          <span>${esc(p.email)}</span>
          ${p.account_status ? `<span>Account ${esc(p.account_status === 'Enabled' ? 'attivo' : p.account_status === 'Disabled' ? 'disattivato' : p.account_status)}</span>` : ''}
          ${p.activation_date ? `<span>Attivo dal ${esc(date(p.activation_date))}</span>` : ''}
          ${p.manager_email ? `<span>Manager ${esc(p.manager_email)}</span>` : ''}
        </p>
      </div>
      <div class="actions">
        <button class="btn" id="export-pubs">Esporta pubblicazioni</button>
        <button class="btn btn-primary" id="print">Scarica report PDF</button>
      </div>
    </section>

    <section class="kpis" aria-label="Dati commerciali">
      ${kpi('Fatturato', 'income', v => money(v, cur))}
      ${kpi('Commissioni', 'commissions', v => money(v, cur))}
      ${kpi('In attesa', 'pending', v => money(v, cur))}
      ${kpi('Ordini', 'orders', v => nf.format(v))}
      ${kpi('Click', 'clicks', v => nf.format(v))}
      ${kpi('Utenti', 'users', v => nf.format(v))}
      ${kpi('Demo', 'demos', v => nf.format(v))}
      <p class="kpi-note">${latest ? `Valori cumulativi dal CSV del ${esc(date(latest.as_of))}.${metrics.length > 1 ? ` Storico disponibile: ${metrics.length} caricamenti.` : ''}` : 'Nessun dato commerciale per questo partner.'}</p>
    </section>

    <div class="two-col">
      <section class="panel" aria-labelledby="onb-title">
        <div class="panel-head">
          <h2 id="onb-title">Onboarding</h2>
          <span class="panel-figure">${doneCount}<small>/${applicable.length}</small></span>
        </div>
        <p class="panel-note">${onboardingComplete
          ? `Completato: sblocca il bonus di ${money(S.onboarding_bonus_usd, 'USD')} sul primo payout${p.type === 'Partner' ? ' e la prima call con Andrea' : ''}.`
          : `Mancano ${applicable.length - doneCount} step per il bonus di ${money(S.onboarding_bonus_usd, 'USD')} sul primo payout${p.type === 'Partner' ? ' e la prima call con Andrea' : ''}.`}</p>
        <ol class="dom">
          ${steps.map(s => `
            <li class="dom-row dom-${s.status}">
              <span class="dom-level">${s.position}</span>
              <span class="dom-bar" aria-hidden="true"></span>
              <span class="dom-label">${esc(s.label)}
                <span class="dom-meta">${s.status === 'auto' ? `Rilevato dai dati il ${esc(date(s.completed_at))}`
                  : s.status === 'done' ? `Segnato il ${esc(date(s.completed_at))}${s.evidence ? ': ' + esc(s.evidence) : ''}`
                  : s.status === 'not_applicable' ? 'Non applicabile' : s.auto_rule ? 'Si completa da solo quando arrivano i dati' : 'Da fare'}</span>
              </span>
              ${isStaff ? `<span class="dom-actions">
                ${s.status === 'todo' || s.status === 'auto' ? `<button class="btn btn-small" data-step="${esc(s.step_code)}" data-act="done">${s.status === 'auto' ? 'Conferma' : 'Segna fatto'}</button>` : ''}
                ${s.status === 'todo' ? `<button class="btn btn-small btn-ghost" data-step="${esc(s.step_code)}" data-act="na">Non applicabile</button>` : ''}
                ${s.status === 'done' || s.status === 'not_applicable' ? `<button class="btn btn-small btn-ghost" data-step="${esc(s.step_code)}" data-act="undo">Annulla</button>` : ''}
              </span>` : ''}
            </li>`).join('')}
        </ol>
      </section>

      <section class="panel" aria-labelledby="goal-title">
        <div class="panel-head">
          <h2 id="goal-title">Goal mensili</h2>
          <span class="panel-figure ${currentMonth?.all_goals_met ? 'is-met' : ''}">${currentMonth?.all_goals_met ? `+${uplift}%` : '–'}</span>
        </div>
        <p class="panel-note">${currentMonth?.all_goals_met
          ? `Questo mese tutti i goal sono raggiunti: commissione +${uplift}%.`
          : `Con tutti e 4 i goal raggiunti nel mese la commissione sale del ${uplift}% (${p.type === 'Partner' ? 'partner' : 'affiliati'}). Conta solo le pubblicazioni confermate.`}</p>
        <div class="table-wrap">
          <table class="footprint">
            <thead><tr><th scope="col">Goal</th>${months.map(m => `<th scope="col">${esc(monthLabel(m))}</th>`).join('')}</tr></thead>
            <tbody>
              ${targets.map(t => `<tr><th scope="row">${esc(t.label)}<span class="target">obiettivo ${t.target}</span></th>
                ${months.map(m => {
                  const g = goalByMonth.get(m);
                  const v = g ? g[goalKey[t.code]] : 0;
                  const ratio = Math.min(1, v / t.target);
                  return `<td class="${v >= t.target ? 'met' : v > 0 ? 'part' : 'zero'}" style="--fill:${ratio}" title="${esc(t.label)}: ${v} su ${t.target}">${v}</td>`;
                }).join('')}</tr>`).join('')}
              <tr class="total-row"><th scope="row">Tutti raggiunti</th>${months.map(m => `<td>${goalByMonth.get(m)?.all_goals_met ? '✓' : ''}</td>`).join('')}</tr>
            </tbody>
          </table>
        </div>
        ${ytFormatsUnclassified ? `<p class="panel-note muted">${ytFormatsUnclassified} video YouTube confermati non sono ancora classificati come tutorial, dedicati o live, quindi non contano per il goal video.</p>` : ''}
      </section>
    </div>

    <section class="panel" aria-labelledby="pub-title">
      <div class="panel-head">
        <h2 id="pub-title">Pubblicazioni</h2>
        <div class="seg" role="group" aria-label="Stato verifica">
          ${[['all', 'Tutte'], ['confirmed', 'Confermate'], ['pending', 'Da verificare'], ['not_relevant', 'Non pertinenti']].map(([v, l]) =>
            `<button data-pub="${v}" aria-pressed="${v === (partnerView ? 'confirmed' : 'all')}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="table-wrap"><table class="grid" id="pub-table"></table></div>
    </section>

    <div class="two-col">
      <section class="panel" aria-labelledby="ch-title">
        <h2 id="ch-title">Canali</h2>
        ${channels.length ? `<ul class="channels">${channels.map(c => `<li>
          <span class="tag">${esc(PLATFORM_LABEL[c.platform])}</span>
          <a href="${safeUrl(c.url)}" target="_blank" rel="noopener">${esc(c.handle ? '@' + c.handle : c.url)}</a>
          <span class="${c.monitored ? 'ok' : 'muted'}">${c.monitored ? 'Monitorato' : 'Non monitorato'}</span></li>`).join('')}</ul>`
          : '<p class="muted">Nessun canale monitorato. Aggiungilo nei fogli Canali YouTube o Canali Instagram dello Sheet.</p>'}
        ${[['Instagram', p.instagram_url], ['YouTube', p.youtube_url], ['TikTok', p.tiktok_url], ['X', p.x_url]].filter(([, u]) => u).length
          ? `<p class="panel-note">Profili indicati nel file commerciale: ${[['Instagram', p.instagram_url], ['YouTube', p.youtube_url], ['TikTok', p.tiktok_url], ['X', p.x_url]].filter(([, u]) => u)
              .map(([l, u]) => safeUrl(u) ? `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${l}</a>` : `${l}: ${esc(u)}`).join(', ')}</p>` : ''}
      </section>
      ${isStaff ? `<section class="panel" aria-labelledby="int-title">
        <h2 id="int-title">Note interne</h2>
        <dl class="notes">
          ${[['Prossima azione', internal?.next_action], ['Stato pubblicazioni', internal?.publication_status], ['Frequenza di pubblicazione', internal?.posting_frequency],
             ['Frequenza contenuti DeepCharts', internal?.sharing_frequency], ['Ultimo aggiornamento', internal?.latest_update], ['Identità', internal?.identity_notes],
             ['Telefono', internal?.phone], ['Gruppo WhatsApp o Telegram', internal?.has_group_chat == null ? null : internal.has_group_chat ? 'Sì' : 'No']]
            .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') || '<p class="muted">Nessuna nota.</p>'}
        </dl>
        <p class="panel-note muted">Visibili solo al team. Si modificano nel foglio Data.</p>
      </section>` : ''}
    </div>
  `, { back: !partnerView });
  bindShell();

  // Pubblicazioni
  let pubFilter = partnerView ? 'confirmed' : 'all';
  const drawPubs = () => {
    const rows = pubs.filter(x => pubFilter === 'all' || x.review_status === pubFilter);
    document.getElementById('pub-table').innerHTML = `
      <thead><tr><th scope="col">Data</th><th scope="col">Canale</th><th scope="col">Formato</th><th scope="col">Titolo</th><th scope="col">Menzione</th><th scope="col">Stato</th></tr></thead>
      <tbody>${rows.length ? rows.slice(0, 300).map(x => `<tr>
        <td class="nowrap">${esc(date(x.published_at))}</td>
        <td>${esc(PLATFORM_LABEL[x.platform])}</td>
        <td>${esc(FORMAT_LABEL[x.format])}</td>
        <td class="title-cell">${safeUrl(x.url) ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'Apri contenuto')}</a>` : esc(x.title)}</td>
        <td>${esc(MENTION_LABEL[x.mention] || '–')}</td>
        <td><span class="status status-${esc(x.review_status)}">${esc(REVIEW_LABEL[x.review_status])}</span></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty-row">Nessuna pubblicazione con questo stato.</td></tr>'}</tbody>`;
  };
  drawPubs();
  document.querySelectorAll('[data-pub]').forEach(b => b.addEventListener('click', () => {
    pubFilter = b.dataset.pub;
    document.querySelectorAll('[data-pub]').forEach(x => x.setAttribute('aria-pressed', x === b));
    drawPubs();
  }));

  document.getElementById('print').addEventListener('click', () => window.print());
  document.getElementById('export-pubs').addEventListener('click', () => downloadCsv(
    `pubblicazioni-${(p.affiliate_code || p.name).replace(/[^\w-]+/g, '_')}.csv`,
    ['Data', 'Canale', 'Formato', 'Titolo', 'URL', 'Menzione', 'Stato'],
    pubs.filter(x => !partnerView || x.review_status === 'confirmed')
      .map(x => [x.published_at.slice(0, 10), PLATFORM_LABEL[x.platform], FORMAT_LABEL[x.format], x.title, x.url, MENTION_LABEL[x.mention] || '', REVIEW_LABEL[x.review_status]])));

  // Azioni onboarding
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', async () => {
    const step = b.dataset.step, act = b.dataset.act;
    b.disabled = true;
    let error;
    if (act === 'undo') {
      ({ error } = await sb.from('partner_onboarding').delete().eq('partner_id', id).eq('step_code', step));
    } else {
      const auto = steps.find(s => s.step_code === step && s.status === 'auto');
      ({ error } = await sb.from('partner_onboarding').upsert({
        partner_id: id, step_code: step,
        completed_at: auto ? auto.completed_at : new Date().toISOString(),
        not_applicable: act === 'na',
      }));
    }
    if (error) { b.disabled = false; return toast('Modifica non salvata: ' + error.message, 'err'); }
    toast(act === 'undo' ? 'Step riaperto' : act === 'na' ? 'Step segnato come non applicabile' : 'Step segnato come fatto');
    state.list = null;
    renderDetail(id, { partnerView });
  }));
}

boot();
