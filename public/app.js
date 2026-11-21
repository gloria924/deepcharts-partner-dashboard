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
const REVIEW_LABEL = { confirmed: 'Confermata', on_topic: 'In tema, senza prodotto', not_relevant: 'Non pertinente', pending: 'Da verificare' };
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

const NAV = [
  ['#/', 'Partner'], ['#/review', 'Verifica'], ['#/social', 'Pubblicazioni'], ['#/top', 'Top 30'],
  ['#/new', 'Nuovi iscritti'], ['#/attention', 'Da attenzionare'],
];
function currentSection() {
  const h = location.hash || '#/';
  if (h.startsWith('#/p/')) return '#/';
  return NAV.some(([k]) => k === h) ? h : '#/';
}
function shell(content, { back = false } = {}) {
  const staff = state.profile && (state.profile.role === 'admin' || state.profile.role === 'staff');
  const active = currentSection();
  return `
    <header class="topbar">
      <div class="topbar-left">
        <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>DeepCharts <span class="brand-sub">Partner</span></a>
        ${staff ? `<nav class="nav" aria-label="Sezioni">${NAV.map(([href, label]) =>
          `<a href="${href}" ${href === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>` : ''}
      </div>
      <div class="topbar-right">
        <span class="user">${esc(state.session.user.email)}</span>
        <button class="btn btn-ghost" id="logout">Esci</button>
      </div>
    </header>
    <main class="page">${back ? '<a class="back" href="#/">Tutti i partner</a>' : ''}${content}</main>`;
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
    const section = currentSection();
    if (section === '#/review') return renderReview();
    if (section === '#/social') return renderSocial();
    if (section === '#/top') return renderTop();
    if (section === '#/new') return renderNew();
    if (section === '#/attention') return renderAttention();
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

async function ensureList() {
  if (state.list) return;
  app.innerHTML = shell('<p class="loading">Caricamento partner…</p>');
  bindShell();
  await loadList();
}

async function renderList() {
  await ensureList();
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
          : `Con tutti e 4 i goal raggiunti nel mese la commissione sale del ${uplift}% (${p.type === 'Partner' ? 'partner' : 'affiliati'}). Contano solo le pubblicazioni confermate, non quelle in tema senza prodotto.`}</p>
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
        ${ytFormatsUnclassified ? `<p class="panel-note muted">${ytFormatsUnclassified} video YouTube confermati non hanno ancora un tipo (educativo, dedicato o live): li classifichi nella coda di verifica, altrimenti non contano per il goal video.</p>` : ''}
      </section>
    </div>

    <section class="panel" aria-labelledby="pub-title">
      <div class="panel-head">
        <h2 id="pub-title">Pubblicazioni</h2>
        <div class="seg" role="group" aria-label="Stato verifica">
          ${[['all', 'Tutte'], ['confirmed', 'Confermate'], ['on_topic', 'In tema'], ['pending', 'Da verificare'], ['not_relevant', 'Non pertinenti']].map(([v, l]) =>
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
        <td>${esc(FORMAT_LABEL[x.format])}${x.category ? `<span class="pmeta">${esc(CATEGORY_LABEL[x.category] || x.category)}</span>` : ''}</td>
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

// ---------------------------------------------------------------- utilità per le sezioni
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);
const partnerCell = r => `<a class="pname" href="#/p/${esc(r.id)}">${esc(r.name)}</a><span class="pmeta">${esc(r.affiliate_code || r.email)}</span>`;
const typeCell = r => `<span class="tag tag-${esc(r.type)}">${esc(TYPE_LABEL[r.type] || r.type)}</span>`;
const accountLabel = v => (v === 'Enabled' ? 'Attivo' : v === 'Disabled' ? 'Disattivato' : v || '–');
const num = v => (v == null ? '–' : nf.format(v));
const isNewSignup = (r, asOf) => r.activation_date && daysBetween(r.activation_date, asOf) >= 0 && daysBetween(r.activation_date, asOf) <= 30;

function simpleTable(el, columns, rows, emptyText) {
  el.innerHTML = `<thead><tr>${columns.map(c => `<th scope="col" class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr ${r.id ? `data-id="${esc(r.id)}" tabindex="0"` : ''}>${columns.map(c =>
      `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="empty-row">${emptyText}</td></tr>`}</tbody>`;
  el.querySelectorAll('tbody tr[data-id]').forEach(tr => {
    tr.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = '#/p/' + tr.dataset.id; });
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = '#/p/' + tr.dataset.id; });
  });
}
const clickable = id => document.getElementById(id).classList.add('rows-link');

function sectionHead(title, sub, exportLabel = 'Esporta CSV') {
  return `<section class="list-head">
    <div><h1>${title}</h1><p class="sub">${sub}</p></div>
    <button class="btn" id="export">${exportLabel}</button>
  </section>`;
}

// ---------------------------------------------------------------- Top 30
async function renderTop() {
  await ensureList();
  const { rows: all, asOf } = state.list;
  const currencies = ['USD', 'EUR'].filter(c => all.some(r => r.currency === c));
  state.topCurrency ||= currencies[0] || 'USD';
  const cur = state.topCurrency;
  const pool = all.filter(r => r.currency === cur && r.income != null);
  const top = [...pool].sort((a, b) => Number(b.income) - Number(a.income) || a.email.localeCompare(b.email)).slice(0, 30);
  const totalPool = pool.reduce((t, r) => t + Number(r.income), 0);
  const totalTop = top.reduce((t, r) => t + Number(r.income), 0);

  app.innerHTML = shell(`
    ${sectionHead('Top 30', `Fatturato cumulativo in ${cur}, dati CSV al ${esc(date(asOf))}. A parità di fatturato decide l'email.`)}
    <section class="filters">
      <div class="seg" role="group" aria-label="Valuta">
        ${currencies.map(c => `<button data-cur="${c}" aria-pressed="${c === cur}">${c}</button>`).join('')}
      </div>
    </section>
    <section class="summary">
      <span><strong>${money(totalTop, cur)}</strong> fatturato dei primi 30</span>
      <span><strong>${totalPool ? Math.round(totalTop / totalPool * 100) : 0}%</strong> del fatturato totale in ${cur}</span>
      <span><strong>${nf.format(pool.length)}</strong> profili in ${cur}</span>
    </section>
    <div class="table-wrap"><table class="grid" id="top-table"></table></div>
  `);
  bindShell();
  const columns = [
    { label: '#', num: true, cell: r => `<span class="rank">${top.indexOf(r) + 1}</span>` },
    { label: 'Fascia', cell: r => top.indexOf(r) < 15 ? '<span class="tier tier-1">Top 15</span>' : '<span class="tier tier-2">16–30</span>' },
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Fatturato', num: true, cell: r => {
      const d = r.prev_income != null ? Number(r.income) - Number(r.prev_income) : null;
      return money(r.income, cur) + (d ? `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${money(d, cur)}</span>` : '');
    } },
    { label: 'Ordini', num: true, cell: r => num(r.orders) },
    { label: 'Click', num: true, cell: r => num(r.clicks) },
    { label: 'Commissioni', num: true, cell: r => money(r.commissions, cur) },
    { label: 'Attivo dal', cell: r => r.activation_date ? esc(date(r.activation_date)) : '<span class="muted">Non disponibile</span>', cls: 'nowrap' },
    { label: 'Ultima pubblicazione confermata', cell: r => r.last_confirmed_at ? esc(date(r.last_confirmed_at)) : '<span class="muted">Nessuna</span>', cls: 'nowrap' },
    { label: 'Account', cell: r => esc(accountLabel(r.account_status)) },
  ];
  simpleTable(document.getElementById('top-table'), columns, top, `Nessun profilo con fatturato in ${cur}.`);
  clickable('top-table');
  document.querySelectorAll('[data-cur]').forEach(b => b.addEventListener('click', () => { state.topCurrency = b.dataset.cur; renderTop(); }));
  document.getElementById('export').addEventListener('click', () => downloadCsv(`top30-${cur}-${asOf}.csv`,
    ['Posizione', 'Fascia', 'Nome', 'Email', 'Codice', 'Tipo', 'Valuta', 'Fatturato', 'Ordini', 'Click', 'Commissioni', 'Attivo dal', 'Ultima pubblicazione confermata', 'Account', 'Data dati'],
    top.map((r, i) => [i + 1, i < 15 ? 'Top 15' : '16-30', r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], cur, r.income, r.orders, r.clicks, r.commissions,
      r.activation_date || '', r.last_confirmed_at?.slice(0, 10) || '', accountLabel(r.account_status), asOf])));
}

// ---------------------------------------------------------------- Nuovi iscritti
async function renderNew() {
  await ensureList();
  const { rows: all, asOf, ladders } = state.list;
  const rows = all.filter(r => isNewSignup(r, asOf))
    .sort((a, b) => b.activation_date.localeCompare(a.activation_date) || a.name.localeCompare(b.name, 'it'));
  const withRevenue = rows.filter(r => Number(r.income) > 0).length;
  const partners = rows.filter(r => r.type === 'Partner').length;

  app.innerHTML = shell(`
    ${sectionHead('Nuovi iscritti', `Attivati nei 30 giorni prima della data dei dati commerciali (${esc(date(asOf))}), compresi quelli che hanno già fatturato.`)}
    <section class="summary">
      <span><strong>${nf.format(rows.length)}</strong> nuovi iscritti</span>
      <span><strong>${nf.format(partners)}</strong> partner</span>
      <span><strong>${nf.format(withRevenue)}</strong> hanno già fatturato</span>
    </section>
    <div class="table-wrap"><table class="grid" id="new-table"></table></div>
  `);
  bindShell();
  simpleTable(document.getElementById('new-table'), [
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Attivato il', cell: r => esc(date(r.activation_date)), cls: 'nowrap' },
    { label: 'Giorni', num: true, cell: r => daysBetween(r.activation_date, asOf) },
    { label: 'Fatturato', num: true, cell: r => money(r.income, r.currency) },
    { label: 'Ordini', num: true, cell: r => num(r.orders) },
    { label: 'Click', num: true, cell: r => num(r.clicks) },
    { label: 'Utenti', num: true, cell: r => num(r.users) },
    { label: 'Onboarding', cell: r => ladder([...(ladders.get(r.id) || [])]) + `<span class="ladder-count">${r.onboarding_done}/${r.onboarding_total}</span>` },
    { label: 'Account', cell: r => esc(accountLabel(r.account_status)) },
  ], rows, 'Nessun nuovo iscritto negli ultimi 30 giorni.');
  clickable('new-table');
  document.getElementById('export').addEventListener('click', () => downloadCsv(`nuovi-iscritti-${asOf}.csv`,
    ['Nome', 'Email', 'Codice', 'Tipo', 'Attivato il', 'Giorni dalla data dati', 'Valuta', 'Fatturato', 'Ordini', 'Click', 'Utenti', 'Onboarding completati', 'Onboarding totali', 'Account', 'Data dati'],
    rows.map(r => [r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], r.activation_date, daysBetween(r.activation_date, asOf), r.currency, r.income, r.orders, r.clicks, r.users,
      r.onboarding_done, r.onboarding_total, accountLabel(r.account_status), asOf])));
}

// ---------------------------------------------------------------- Da attenzionare
async function renderAttention() {
  await ensureList();
  const { rows: all, asOf } = state.list;
  state.attention ||= { type: 'all', group: 'all' };
  const f = state.attention;
  const zero = all.filter(r => r.income != null && Number(r.income) === 0 && !isNewSignup(r, asOf))
    .map(r => ({ ...r, reason: r.activation_date ? 'after30' : 'nodate', days: r.activation_date ? daysBetween(r.activation_date, asOf) : null }));
  const counts = { after30: zero.filter(r => r.reason === 'after30').length, nodate: zero.filter(r => r.reason === 'nodate').length };
  const rows = zero
    .filter(r => (f.type === 'all' || r.type === f.type) && (f.group === 'all' || r.reason === f.group))
    .sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'after30' ? -1 : 1) || (b.days ?? 0) - (a.days ?? 0) || Number(b.clicks || 0) - Number(a.clicks || 0));
  const REASON = { after30: 'Zero fatturato dopo 30 giorni', nodate: 'Data di attivazione non disponibile' };

  app.innerHTML = shell(`
    ${sectionHead('Da attenzionare', `Profili a zero fatturato al ${esc(date(asOf))}, esclusi i nuovi iscritti degli ultimi 30 giorni. Chi non ha la data di attivazione è tenuto a parte: non si può dire da quanto è attivo.`)}
    <section class="filters">
      <div class="seg" role="group" aria-label="Motivo">
        ${[['all', `Tutti (${zero.length})`], ['after30', `Dopo 30 giorni (${counts.after30})`], ['nodate', `Senza data (${counts.nodate})`]].map(([v, l]) =>
          `<button data-group="${v}" aria-pressed="${f.group === v}">${l}</button>`).join('')}
      </div>
      <div class="seg" role="group" aria-label="Tipo">
        ${[['all', 'Tutti'], ['Partner', 'Partner'], ['Affiliate', 'Affiliati']].map(([v, l]) =>
          `<button data-atype="${v}" aria-pressed="${f.type === v}">${l}</button>`).join('')}
      </div>
    </section>
    <section class="summary">
      <span><strong>${nf.format(rows.length)}</strong> profili mostrati</span>
      <span><strong>${nf.format(rows.filter(r => Number(r.clicks) > 0).length)}</strong> con click ma nessuna vendita</span>
      <span><strong>${nf.format(rows.filter(r => r.confirmed_last_30d > 0).length)}</strong> hanno pubblicato negli ultimi 30 giorni</span>
    </section>
    <div class="table-wrap"><table class="grid" id="att-table"></table></div>
  `);
  bindShell();
  simpleTable(document.getElementById('att-table'), [
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Motivo', cell: r => `<span class="reason reason-${r.reason}">${REASON[r.reason]}</span>` },
    { label: 'Attivo dal', cell: r => r.activation_date ? esc(date(r.activation_date)) : '<span class="muted">Non disponibile</span>', cls: 'nowrap' },
    { label: 'Giorni', num: true, cell: r => r.days ?? '–' },
    { label: 'Click', num: true, cell: r => num(r.clicks) },
    { label: 'Utenti', num: true, cell: r => num(r.users) },
    { label: 'Pubblicazioni 30 gg', num: true, cell: r => nf.format(r.confirmed_last_30d) },
    { label: 'Account', cell: r => esc(accountLabel(r.account_status)) },
  ], rows, 'Nessun profilo da attenzionare con questi filtri.');
  clickable('att-table');
  document.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => { f.group = b.dataset.group; renderAttention(); }));
  document.querySelectorAll('[data-atype]').forEach(b => b.addEventListener('click', () => { f.type = b.dataset.atype; renderAttention(); }));
  document.getElementById('export').addEventListener('click', () => downloadCsv(`da-attenzionare-${asOf}.csv`,
    ['Nome', 'Email', 'Codice', 'Tipo', 'Motivo', 'Attivo dal', 'Giorni dalla data dati', 'Valuta', 'Click', 'Utenti', 'Pubblicazioni confermate 30 gg', 'Account', 'Data dati'],
    rows.map(r => [r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], REASON[r.reason], r.activation_date || '', r.days ?? '', r.currency, r.clicks, r.users,
      r.confirmed_last_30d, accountLabel(r.account_status), asOf])));
}

// ---------------------------------------------------------------- Pubblicazioni social
async function renderSocial() {
  if (!state.social) {
    app.innerHTML = shell('<p class="loading">Caricamento pubblicazioni…</p>');
    bindShell();
    const rows = await fetchAll(() => sb.from('publications')
      .select('id, partner_id, platform, format, category, published_at, title, url, mention, review_status, partners(name, affiliate_code, type)')
      .order('published_at', { ascending: false }).order('id'));
    state.social = { rows, f: { platform: 'all', status: 'all', period: '30', format: 'all', q: '' } };
  }
  const { rows: all, f } = state.social;
  const since = f.period === 'all' ? '' : new Date(Date.now() - Number(f.period) * DAY).toISOString();
  const q = f.q.trim().toLowerCase();
  const base = all.filter(x => (!since || x.published_at >= since) &&
    (!q || [x.partners?.name, x.partners?.affiliate_code, x.title].some(v => (v || '').toLowerCase().includes(q))));
  const byPlatform = base.filter(x => f.platform === 'all' || x.platform === f.platform);
  const formats = [...new Set(byPlatform.map(x => x.format))];
  if (f.format !== 'all' && !formats.includes(f.format)) f.format = 'all';
  const rows = byPlatform.filter(x => (f.status === 'all' || x.review_status === f.status) && (f.format === 'all' || x.format === f.format));
  const confirmed = byPlatform.filter(x => x.review_status === 'confirmed');
  const activePartners = new Set(confirmed.map(x => x.partner_id)).size;
  const withMention = confirmed.filter(x => x.mention === 'present').length;
  const platformCount = p => base.filter(x => p === 'all' || x.platform === p).length;
  const periodLabel = { '7': 'ultimi 7 giorni', '30': 'ultimi 30 giorni', '90': 'ultimi 90 giorni', all: 'tutto il periodo' }[f.period];

  app.innerHTML = shell(`
    ${sectionHead('Pubblicazioni social', `Contenuti dei partner raccolti dalle automazioni, ${periodLabel}.`)}
    <nav class="tabs" aria-label="Social">
      ${[['all', 'Tutti i social'], ['instagram', 'Instagram'], ['youtube', 'YouTube'], ['tiktok', 'TikTok']].map(([v, l]) =>
        `<button data-platform="${v}" aria-pressed="${f.platform === v}">${l}<span class="count">${nf.format(platformCount(v))}</span></button>`).join('')}
    </nav>
    ${f.platform === 'tiktok' && !platformCount('tiktok') ? `<section class="empty-panel"><h2>TikTok non è ancora monitorato</h2>
      <p>Quando aggiungeremo il workflow TikTok, i video dei partner compariranno qui insieme a Instagram e YouTube, con la stessa verifica.</p></section>` : `
    <section class="kpis kpis-compact">
      <div class="kpi"><span class="kpi-label">Confermate</span><span class="kpi-value">${nf.format(confirmed.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Da verificare</span><span class="kpi-value ${byPlatform.some(x => x.review_status === 'pending') ? 'warn' : ''}">${nf.format(byPlatform.filter(x => x.review_status === 'pending').length)}</span></div>
      <div class="kpi"><span class="kpi-label">In tema, senza prodotto</span><span class="kpi-value">${nf.format(byPlatform.filter(x => x.review_status === 'on_topic').length)}</span></div>
      <div class="kpi"><span class="kpi-label">Partner con contenuti confermati</span><span class="kpi-value">${nf.format(activePartners)}</span></div>
      <div class="kpi"><span class="kpi-label">Confermate con menzione nel testo</span><span class="kpi-value">${confirmed.length ? Math.round(withMention / confirmed.length * 100) : 0}%</span></div>
    </section>
    <section class="filters">
      <input type="search" id="sq" placeholder="Cerca partner, codice o titolo" value="${esc(f.q)}" aria-label="Cerca">
      <div class="seg" role="group" aria-label="Stato">
        ${[['all', 'Tutte'], ['confirmed', 'Confermate'], ['on_topic', 'In tema'], ['pending', 'Da verificare'], ['not_relevant', 'Non pertinenti']].map(([v, l]) =>
          `<button data-status="${v}" aria-pressed="${f.status === v}">${l}</button>`).join('')}
      </div>
      <select id="period" aria-label="Periodo">
        ${[['7', 'Ultimi 7 giorni'], ['30', 'Ultimi 30 giorni'], ['90', 'Ultimi 90 giorni'], ['all', 'Tutto il periodo']].map(([v, l]) =>
          `<option value="${v}" ${f.period === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="format" aria-label="Formato">
        <option value="all">Tutti i formati</option>
        ${formats.map(v => `<option value="${v}" ${f.format === v ? 'selected' : ''}>${esc(FORMAT_LABEL[v] || v)}</option>`).join('')}
      </select>
    </section>
    <div class="table-wrap"><table class="grid" id="social-table"></table></div>
    ${rows.length > 500 ? `<p class="legend">Mostrate le 500 più recenti su ${nf.format(rows.length)}. Restringi i filtri o usa l'export per l'elenco completo.</p>` : ''}`}
  `);
  bindShell();

  document.querySelectorAll('[data-platform]').forEach(b => b.addEventListener('click', () => { f.platform = b.dataset.platform; renderSocial(); }));
  if (f.platform === 'tiktok' && !platformCount('tiktok')) return document.getElementById('export').setAttribute('disabled', '');

  simpleTable(document.getElementById('social-table'), [
    { label: 'Data', cell: x => esc(date(x.published_at)), cls: 'nowrap' },
    { label: 'Partner', cell: x => `<a class="pname" href="#/p/${esc(x.partner_id)}">${esc(x.partners?.name || '–')}</a><span class="pmeta">${esc(x.partners?.affiliate_code || '')}</span>` },
    { label: 'Social', cell: x => esc(PLATFORM_LABEL[x.platform]) },
    { label: 'Formato', cell: x => esc(FORMAT_LABEL[x.format]) },
    { label: 'Contenuto', cls: 'title-cell', cell: x => safeUrl(x.url) ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'Apri contenuto')}</a>` : esc(x.title) },
    { label: 'Menzione', cell: x => esc(MENTION_LABEL[x.mention] || '–') },
    { label: 'Stato', cell: x => `<span class="status status-${esc(x.review_status)}">${esc(REVIEW_LABEL[x.review_status])}</span>` },
  ], rows.slice(0, 500), 'Nessuna pubblicazione con questi filtri.');

  document.getElementById('sq').addEventListener('change', e => { f.q = e.target.value; renderSocial(); });
  document.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => { f.status = b.dataset.status; renderSocial(); }));
  document.getElementById('period').addEventListener('change', e => { f.period = e.target.value; renderSocial(); });
  document.getElementById('format').addEventListener('change', e => { f.format = e.target.value; renderSocial(); });
  document.getElementById('export').addEventListener('click', () => downloadCsv(`pubblicazioni-${f.platform}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Data', 'Partner', 'Codice', 'Tipo partner', 'Social', 'Formato', 'Titolo', 'URL', 'Menzione', 'Stato'],
    rows.map(x => [x.published_at.slice(0, 10), x.partners?.name, x.partners?.affiliate_code, TYPE_LABEL[x.partners?.type], PLATFORM_LABEL[x.platform],
      FORMAT_LABEL[x.format], x.title, x.url, MENTION_LABEL[x.mention] || '', REVIEW_LABEL[x.review_status]])));
}

// ---------------------------------------------------------------- Verifica pubblicazioni
const CATEGORY_LABEL = { tutorial: 'Educativo', dedicated: 'Dedicato a DeepCharts', live: 'Live', giveaway: 'Giveaway' };
const CATEGORY_KEYS = { 1: 'tutorial', 2: 'dedicated', 3: 'live', 4: 'giveaway' };
const ytId = url => (String(url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/live\/)([\w-]{11})/) || [])[1];
const igPath = url => (String(url).match(/instagram\.com\/((?:p|reel|reels|tv)\/[\w-]+)/) || [])[1];

function mediaPreview(x) {
  if (x.platform === 'youtube' && ytId(x.url)) {
    const id = ytId(x.url);
    return `<div class="frames">
      <img class="frame-main" src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="Miniatura del video">
      <div class="frame-row">${[1, 2, 3].map(n =>
        `<img src="https://i.ytimg.com/vi/${id}/hq${n}.jpg" alt="Fotogramma al ${n * 25}% del video" loading="lazy" data-hide-on-error>`).join('')}</div>
      <p class="frame-note">Miniatura e tre fotogrammi presi da YouTube al 25%, 50% e 75% del video.</p>
      <div id="player-slot"><button class="btn" id="load-player" data-yt="${id}">Guarda il video qui</button></div>
    </div>`;
  }
  if (x.platform === 'instagram' && x.format !== 'story' && igPath(x.url)) {
    return `<iframe class="ig-embed" src="https://www.instagram.com/${igPath(x.url)}/embed" title="Anteprima del post Instagram" loading="lazy"></iframe>`;
  }
  if (x.format === 'story' && x.media_drive_file_id) {
    return `<div class="frames">
      <img class="frame-story" src="https://drive.google.com/thumbnail?id=${encodeURIComponent(x.media_drive_file_id)}&sz=w800" alt="Storia archiviata" data-story-fallback>
    </div>`;
  }
  return '<p class="frame-note">Anteprima non disponibile per questo contenuto. Usa Apri contenuto.</p>';
}

function highlightMention(text) {
  return esc(text || '').replace(/\b(deep\s*(?:charts?|dom|gamma))\b/gi, '<mark>$1</mark>');
}

async function renderReview() {
  if (!state.review) {
    app.innerHTML = shell('<p class="loading">Caricamento pubblicazioni da verificare…</p>');
    bindShell();
    const rows = await fetchAll(() => sb.from('publications')
      .select('id, partner_id, platform, format, category, published_at, title, url, mention, evidence, media_drive_file_id, partners(name, affiliate_code, type)')
      .eq('review_status', 'pending').order('published_at', { ascending: false }).order('id'));
    state.review = { all: rows, platform: 'all', index: 0, category: null, history: [], done: 0, busy: false };
  }
  drawReview();
}

function reviewQueue() {
  const r = state.review;
  return r.all.filter(x => r.platform === 'all' || x.platform === r.platform)
    .sort((a, b) => (b.mention === 'present') - (a.mention === 'present') || b.published_at.localeCompare(a.published_at));
}

function drawReview() {
  const r = state.review;
  const queue = reviewQueue();
  if (r.index >= queue.length) r.index = Math.max(0, queue.length - 1);
  const x = queue[r.index];
  const count = p => r.all.filter(y => p === 'all' || y.platform === p).length;
  r.category = x ? (r.category ?? x.category ?? null) : null;

  app.innerHTML = shell(`
    <section class="list-head">
      <div><h1>Verifica pubblicazioni</h1>
      <p class="sub">Conferma se DeepCharts, DeepDOM o DeepGamma sono riconoscibili: a schermo, anche solo un frame, a voce, in didascalia, con il codice affiliato o un tag. Se parla di orderflow senza nessun riferimento al prodotto, scegli In tema.</p></div>
      <div class="review-progress"><strong>${nf.format(queue.length)}</strong> da verificare${r.done ? `<span>${nf.format(r.done)} decise ora</span>` : ''}</div>
    </section>
    <nav class="tabs" aria-label="Social">
      ${[['all', 'Tutti i social'], ['youtube', 'YouTube'], ['instagram', 'Instagram'], ['tiktok', 'TikTok']].map(([v, l]) =>
        `<button data-rplatform="${v}" aria-pressed="${r.platform === v}">${l}<span class="count">${nf.format(count(v))}</span></button>`).join('')}
    </nav>
    ${!x ? `<section class="empty-panel"><h2>Niente da verificare</h2><p>${r.done ? 'Hai finito la coda. ' : ''}Le nuove pubblicazioni raccolte dalle automazioni arriveranno qui.</p></section>` : `
    <section class="review">
      <div class="review-media">${mediaPreview(x)}</div>
      <div class="review-info">
        <p class="review-pos">${r.index + 1} di ${nf.format(queue.length)}</p>
        <h2 class="review-title">${esc(x.title || 'Senza titolo')}</h2>
        <p class="sub">
          <a href="#/p/${esc(x.partner_id)}">${esc(x.partners?.name || '–')}</a>
          <span>${esc(PLATFORM_LABEL[x.platform])}, ${esc((FORMAT_LABEL[x.format] || '').toLowerCase())}</span>
          <span>${esc(date(x.published_at))}</span>
        </p>
        <p class="mention mention-${esc(x.mention || 'none')}">${x.mention === 'present' ? 'DeepCharts citato nel testo' : x.mention === 'not_applicable' ? 'Testo non disponibile: verifica dall\'immagine' : 'Nessuna menzione nel testo'}</p>
        ${x.evidence ? `<blockquote class="evidence">${highlightMention(x.evidence)}</blockquote>` : ''}
        <a class="btn" href="${safeUrl(x.url)}" target="_blank" rel="noopener">Apri contenuto</a>

        <fieldset class="cats">
          <legend>Tipo di contenuto <span class="muted">(facoltativo: Educativo e Dedicato contano per il goal video sui video YouTube, Giveaway per l'onboarding)</span></legend>
          ${Object.entries(CATEGORY_KEYS).map(([k, v]) =>
            `<button type="button" data-cat="${v}" aria-pressed="${r.category === v}"><kbd>${k}</kbd>${CATEGORY_LABEL[v]}</button>`).join('')}
        </fieldset>

        <div class="decide">
          <button class="btn btn-confirm" id="act-confirm"><kbd>C</kbd>Conferma</button>
          <button class="btn btn-ontopic" id="act-ontopic"><kbd>T</kbd>In tema</button>
          <button class="btn btn-reject" id="act-reject"><kbd>N</kbd>Non pertinente</button>
          <button class="btn btn-ghost" id="act-skip"><kbd>S</kbd>Salta</button>
        </div>
        <p class="keys">
          ${r.history.length ? '<button class="linklike" id="act-undo"><kbd>Z</kbd> Annulla l\'ultima decisione</button>' : ''}
          <span class="muted">Frecce sinistra e destra per scorrere.</span>
        </p>
      </div>
    </section>`}
  `);
  bindShell();

  document.querySelectorAll('[data-rplatform]').forEach(b => b.addEventListener('click', () => { r.platform = b.dataset.rplatform; r.index = 0; r.category = null; drawReview(); }));
  if (!x) return;
  document.querySelectorAll('img[data-hide-on-error]').forEach(img => img.addEventListener('error', () => img.remove()));
  document.querySelectorAll('img[data-story-fallback]').forEach(img => img.addEventListener('error', () => {
    img.replaceWith(Object.assign(document.createElement('p'), { className: 'frame-note',
      textContent: "Anteprima non disponibile: serve essere collegati a Google con l'account che ha accesso alla cartella delle storie. Usa Apri contenuto." }));
  }));
  document.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => setCategory(b.dataset.cat)));
  document.getElementById('act-confirm').addEventListener('click', () => decide('confirmed'));
  document.getElementById('act-reject').addEventListener('click', () => decide('not_relevant'));
  document.getElementById('act-ontopic').addEventListener('click', () => decide('on_topic'));
  document.getElementById('act-skip').addEventListener('click', () => move(1));
  document.getElementById('act-undo')?.addEventListener('click', undoReview);
  document.getElementById('load-player')?.addEventListener('click', e => {
    const id = e.currentTarget.dataset.yt;
    document.getElementById('player-slot').innerHTML =
      `<iframe class="yt-embed" src="https://www.youtube-nocookie.com/embed/${id}" title="Video YouTube" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  });
}

function setCategory(cat) {
  const r = state.review;
  r.category = r.category === cat ? null : cat;
  document.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === r.category));
}
function move(step) {
  const r = state.review;
  const n = reviewQueue().length;
  if (!n) return;
  r.index = (r.index + step + n) % n;
  r.category = null;
  drawReview();
}

async function decide(status) {
  const r = state.review;
  if (r.busy) return;
  const x = reviewQueue()[r.index];
  if (!x) return;
  r.busy = true;
  const category = status === 'confirmed' ? r.category : null;
  const { error } = await sb.from('publications').update({ review_status: status, category }).eq('id', x.id);
  r.busy = false;
  if (error) return toast('Decisione non salvata: ' + error.message, 'err');
  r.all = r.all.filter(y => y.id !== x.id);
  r.history.push({ item: x });
  r.done += 1;
  r.category = null;
  state.list = null; state.social = null;
  toast(status === 'confirmed' ? `Confermata${category ? ' come ' + CATEGORY_LABEL[category].toLowerCase() : ''}`
    : status === 'on_topic' ? 'Segnata come in tema, senza prodotto' : 'Segnata come non pertinente');
  drawReview();
}

async function undoReview() {
  const r = state.review;
  const last = r.history.pop();
  if (!last) return;
  const { error } = await sb.from('publications').update({ review_status: 'pending', category: null }).eq('id', last.item.id);
  if (error) { r.history.push(last); return toast('Annullamento non riuscito: ' + error.message, 'err'); }
  r.all.push({ ...last.item, category: null });
  r.done -= 1;
  r.index = reviewQueue().findIndex(y => y.id === last.item.id);
  r.category = null;
  state.list = null; state.social = null;
  toast('Decisione annullata: la pubblicazione è di nuovo da verificare');
  drawReview();
}

document.addEventListener('keydown', e => {
  if (currentSection() !== '#/review' || !state.review || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, iframe')) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { e.preventDefault(); decide('confirmed'); }
  else if (k === 'n') { e.preventDefault(); decide('not_relevant'); }
  else if (k === 't') { e.preventDefault(); decide('on_topic'); }
  else if (k === 's' || k === 'arrowright') { e.preventDefault(); move(1); }
  else if (k === 'arrowleft') { e.preventDefault(); move(-1); }
  else if (k === 'z') { e.preventDefault(); undoReview(); }
  else if (CATEGORY_KEYS[k]) { e.preventDefault(); setCategory(CATEGORY_KEYS[k]); }
});

boot();
