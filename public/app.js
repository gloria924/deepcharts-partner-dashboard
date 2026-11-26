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
    if (changed) { state.profile = null; state.list = null; state.payout = null; route(); }
  });
  window.addEventListener('hashchange', route);
  route();
}

async function ensureProfile() {
  if (state.profile) return state.profile;
  const { data, error } = await sb.from('app_users').select('role, partner_id, active, payout_access').eq('user_id', state.session.user.id).maybeSingle();
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
        <h1>Accedi <span class="muted" lang="en">· Log in</span></h1>
        ${codeStep
          ? `<p class="hint">Abbiamo inviato un codice a <strong>${esc(email)}</strong>. Controlla anche lo spam.<br><span lang="en">We sent a code to this address. Check your spam folder too.</span></p>
             <label>Codice ricevuto via email · Code from the email<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required autofocus></label>`
          : `<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>`}
        ${message ? `<p class="form-error" role="alert">${esc(message)}</p>` : ''}
        <button type="submit" class="btn btn-primary">${codeStep ? 'Accedi · Log in' : 'Invia il codice · Send code'}</button>
        ${codeStep
          ? '<button type="button" class="btn btn-ghost" id="change-email">Usa un\'altra email · Use another email</button>'
          : '<p class="hint">Riceverai un codice via email, come nella dashboard attuale.<br><span lang="en">You will receive a login code by email.</span></p>'}
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
  ['#/new', 'Nuovi iscritti'], ['#/attention', 'Da attenzionare'], ['#/report', 'Report'], ['#/upload', 'Carica dati'],
];
const isStaffRole = p => p && (p.role === 'admin' || p.role === 'staff');
const canPayout = p => p && (p.role === 'contabilita' || (isStaffRole(p) && p.payout_access));
function navItems() {
  const p = state.profile;
  if (p?.role === 'contabilita') return [['#/payout', 'Payout']];
  return canPayout(p) ? [...NAV, ['#/payout', 'Payout']] : NAV;
}
function currentSection() {
  const h = location.hash || '#/';
  if (h.startsWith('#/p/')) return '#/';
  return navItems().some(([k]) => k === h) ? h : '#/';
}
function shell(content, { back = false } = {}) {
  const staff = isStaffRole(state.profile) || state.profile?.role === 'contabilita';
  const active = currentSection();
  const home = state.profile?.role === 'contabilita' ? '#/payout' : '#/';
  return `
    <header class="topbar">
      <div class="topbar-left">
        <a class="brand" href="${home}"><span class="brand-mark" aria-hidden="true"></span>DeepCharts <span class="brand-sub">Partner</span></a>
        ${staff ? `<nav class="nav" aria-label="Sezioni">${navItems().map(([href, label]) =>
          `<a href="${href}" ${href === active ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>` : ''}
      </div>
      <div class="topbar-right">
        <span class="user">${esc(state.session.user.email)}</span>
        <button class="btn btn-ghost" id="logout">${state.profile?.role === 'contabilita' ? 'Log out' : 'Esci'}</button>
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
    if (profile.role === 'contabilita') return renderPayout();
    if (m) return renderDetail(m[1]);
    const section = currentSection();
    if (section === '#/payout') return renderPayout();
    if (section !== '#/report') state.report = null;
    if (section === '#/report') return renderReport();
    if (section === '#/upload') return renderUpload();
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
  const [rows, steps, bios] = await Promise.all([
    fetchAll(() => sb.from('partner_overview').select('*').order('id')),
    fetchAll(() => sb.from('partner_onboarding_status').select('partner_id, position, label, status').order('partner_id').order('position')),
    fetchAll(() => sb.from('partner_bio_latest').select('partner_id, channel_id, status').order('channel_id')),
  ]);
  // Link in bio: per partner, se almeno un canale controllato ha il link DeepCharts
  const bio = new Map();
  for (const b of bios) {
    const e = bio.get(b.partner_id) || { checked: false, link: false };
    if (b.status !== 'unreadable' && b.status !== 'not_found') e.checked = true;
    if (b.status === 'link' || b.status === 'link_with_code') e.link = true;
    bio.set(b.partner_id, e);
  }
  for (const r of rows) r.bio = bio.get(r.id) || null;
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
      (f.onboarding === 'review' && r.pending_review > 0) ||
      (f.onboarding === 'nobio' && r.bio?.checked && !r.bio.link)));
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
        <option value="nobio" ${f.onboarding === 'nobio' ? 'selected' : ''}>Senza link DeepCharts in bio</option>
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

  const [p, internal, metrics, steps, goals, targets, settings, pubs, channels, bios] = await Promise.all([
    sb.from('partners').select('*').eq('id', id).maybeSingle(),
    isStaff ? sb.from('partner_internal').select('*').eq('partner_id', id).maybeSingle() : Promise.resolve({ data: null }),
    sb.from('commercial_metrics').select('*').eq('partner_id', id).order('as_of'),
    sb.from('partner_onboarding_status').select('*').eq('partner_id', id).order('position'),
    sb.from('partner_monthly_goals').select('*').eq('partner_id', id).order('month', { ascending: false }).limit(6),
    sb.from('monthly_goal_targets').select('*').order('position'),
    sb.from('program_settings').select('*'),
    fetchAll(() => sb.from('publications').select('*').eq('partner_id', id).order('published_at', { ascending: false })),
    sb.from('social_channels').select('*').eq('partner_id', id).order('platform'),
    sb.from('partner_bio_latest').select('*').eq('partner_id', id),
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
      ${latest?.windows?.income ? `<div class="windows">${[['1m', 'Ultimo mese'], ['2w', 'Ultime 2 settimane'], ['1w', 'Ultima settimana'], ['3m', 'Ultimi 3 mesi']].map(([k, l]) =>
        `<div><span class="kpi-label">${l}</span><strong>${money(latest.windows.income[k], cur)}</strong><span class="muted">${nf.format(latest.windows.orders?.[k] ?? 0)} ordini</span></div>`).join('')}</div>` : ''}
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
          <span class="${c.monitored ? 'ok' : 'muted'}">${c.monitored ? 'Monitorato' : 'Non monitorato'}</span>
          ${bioLine((bios || []).find(b => b.channel_id === c.id))}</li>`).join('')}</ul>`
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

// ---------------------------------------------------------------- Report per periodo
// Periodi del report e colonna corrispondente del CSV affiliati (1S, 2S, 1M).
const REPORT_PERIODS = [['7', '1w', '7 giorni'], ['14', '2w', '14 giorni'], ['30', '1m', '30 giorni']];

async function renderReport() {
  await ensureList();
  const { rows: partners, asOf, ladders } = state.list;
  if (!state.report) {
    app.innerHTML = shell('<p class="loading">Preparazione del report…</p>');
    bindShell();
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [metrics, pubs] = await Promise.all([
      asOf ? fetchAll(() => sb.from('commercial_metrics').select('partner_id, currency, windows').eq('as_of', asOf).order('partner_id')) : [],
      fetchAll(() => sb.from('publications').select('id, partner_id, platform, format, category, published_at, title, url, review_status')
        .gte('published_at', since).order('published_at', { ascending: false }).order('id')),
    ]);
    state.report = { metrics: new Map(metrics.map(m => [m.partner_id, m])), pubs, period: state.reportPeriod || '30', open: new Set() };
  }
  const R = state.report;
  state.reportPeriod = R.period;
  const [days, win, periodLabel] = REPORT_PERIODS.find(p => p[0] === R.period);
  const byId = new Map(partners.map(p => [p.id, p]));
  const hasWindows = [...R.metrics.values()].some(m => m.windows);
  const w = (id, key) => Number(R.metrics.get(id)?.windows?.[key]?.[win] ?? 0);

  // Dati commerciali del periodo (dal CSV)
  const sales = partners
    .map(p => ({ ...p, p_income: w(p.id, 'income'), p_orders: w(p.id, 'orders'), p_comm: w(p.id, 'commissions'), p_users: w(p.id, 'users') }))
    .filter(p => p.p_income > 0 || p.p_orders > 0)
    .sort((a, b) => b.p_income - a.p_income || a.name.localeCompare(b.name, 'it'));
  const totals = {};
  for (const p of sales) {
    const t = totals[p.currency || 'UNSPECIFIED'] ||= { income: 0, orders: 0, comm: 0 };
    t.income += p.p_income; t.orders += p.p_orders; t.comm += p.p_comm;
  }
  const orders = sales.reduce((t, p) => t + p.p_orders, 0);

  // Nuove attivazioni: approvati negli N giorni fino alla data dei dati
  const activations = partners
    .filter(p => p.activation_date && asOf && daysBetween(p.activation_date, asOf) >= 0 && daysBetween(p.activation_date, asOf) < Number(days))
    .sort((a, b) => b.activation_date.localeCompare(a.activation_date) || a.name.localeCompare(b.name, 'it'));

  // Pubblicazioni negli ultimi N giorni fino a oggi
  const since = new Date(Date.now() - Number(days) * DAY).toISOString();
  const pubs = R.pubs.filter(x => x.published_at >= since);
  const count = (list, s) => list.filter(x => x.review_status === s).length;
  const confirmed = pubs.filter(x => x.review_status === 'confirmed');
  const perPartner = new Map();
  for (const x of pubs) {
    const e = perPartner.get(x.partner_id) || { confirmed: 0, on_topic: 0, pending: 0, not_relevant: 0, platforms: new Set() };
    e[x.review_status]++;
    if (x.review_status === 'confirmed' || x.review_status === 'on_topic') e.platforms.add(x.platform);
    perPartner.set(x.partner_id, e);
  }
  const pubRows = [...perPartner.entries()]
    .filter(([, e]) => e.confirmed || e.on_topic || e.pending)
    .map(([id, e]) => ({ ...(byId.get(id) || { id, name: '–' }), ...e, p_income: w(id, 'income') }))
    .sort((a, b) => b.confirmed - a.confirmed || b.on_topic - a.on_topic || b.pending - a.pending || a.name.localeCompare(b.name, 'it'));
  const pending = count(pubs, 'pending');
  const platforms = ['instagram', 'youtube', 'tiktok'].filter(p => p !== 'tiktok' || pubs.some(x => x.platform === 'tiktok'));

  const today = new Date().toISOString().slice(0, 10);
  const LIMIT = 20;
  const cut = (key, list) => (R.open.has(key) ? list : list.slice(0, LIMIT));
  const more = (key, list) => list.length > LIMIT
    ? `<button class="btn btn-ghost more" data-more="${key}">${R.open.has(key) ? 'Mostra solo i primi ' + LIMIT : 'Mostra tutti (' + nf.format(list.length) + ')'}</button>` : '';
  const pName = id => byId.get(id)?.name || '–';
  const moneyTotals = Object.entries(totals).filter(([c]) => c !== 'UNSPECIFIED');

  app.innerHTML = shell(`
    <section class="list-head">
      <div><h1>Report ultimi ${periodLabel}</h1>
        <p class="sub">Dati commerciali dal CSV al ${esc(date(asOf))}. Pubblicazioni dal ${esc(date(since))} a oggi.</p></div>
      <div class="actions">
        <div class="seg" role="group" aria-label="Periodo">
          ${REPORT_PERIODS.map(([v, , l]) => `<button data-rperiod="${v}" aria-pressed="${R.period === v}">${l}</button>`).join('')}
        </div>
        <button class="btn" id="print">Scarica PDF</button>
      </div>
    </section>
    ${hasWindows ? '' : `<p class="notice">Per i numeri commerciali del periodo serve un CSV caricato dalla pagina <a href="#/upload">Carica dati</a>: i dati attuali vengono dallo Sheet e non hanno le colonne per periodo.</p>`}

    <section class="kpis">
      ${moneyTotals.length ? moneyTotals.map(([c, t]) => `<div class="kpi"><span class="kpi-label">Fatturato ${c}</span><span class="kpi-value">${money(t.income, c)}</span></div>`).join('')
        : '<div class="kpi"><span class="kpi-label">Fatturato</span><span class="kpi-value">–</span></div>'}
      <div class="kpi"><span class="kpi-label">Ordini</span><span class="kpi-value">${nf.format(orders)}</span></div>
      <div class="kpi"><span class="kpi-label">Nuove attivazioni</span><span class="kpi-value">${nf.format(activations.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Pubblicazioni confermate</span><span class="kpi-value">${nf.format(confirmed.length)}</span></div>
      <div class="kpi"><span class="kpi-label">In tema, senza prodotto</span><span class="kpi-value">${nf.format(count(pubs, 'on_topic'))}</span></div>
      <p class="kpi-note">${nf.format(sales.length)} partner con vendite · ${nf.format(new Set(confirmed.map(x => x.partner_id)).size)} partner con pubblicazioni confermate${pending ? ` · <strong>${nf.format(pending)} pubblicazioni ancora da verificare</strong>: i conteggi possono salire` : ''}</p>
    </section>

    <section class="report-block">
      <div class="panel-head"><h2>Dati commerciali</h2><button class="btn" data-csv="sales">Esporta CSV</button></div>
      <p class="sub">Fatturato, ordini e commissioni degli ultimi ${periodLabel} secondo il CSV (colonna ${{ '1w': '1S', '2w': '2S', '1m': '1M' }[win]}). Solo partner con almeno una vendita.</p>
      <div class="table-wrap"><table class="grid" id="r-sales"></table></div>${more('sales', sales)}
    </section>

    <section class="report-block">
      <div class="panel-head"><h2>Nuove attivazioni</h2><button class="btn" data-csv="activations">Esporta CSV</button></div>
      <p class="sub">Affiliati e partner approvati negli ultimi ${periodLabel} prima del ${esc(date(asOf))}.</p>
      <div class="table-wrap"><table class="grid" id="r-act"></table></div>${more('act', activations)}
    </section>

    <section class="report-block">
      <div class="panel-head"><h2>Pubblicazioni</h2><button class="btn" data-csv="pubs">Esporta CSV</button></div>
      <p class="sub">Contenuti pubblicati negli ultimi ${periodLabel}. Le confermate contano per goal e onboarding; quelle in tema contano come attività.</p>
      <div class="table-wrap"><table class="grid compact" id="r-plat"></table></div>
      <div class="table-wrap"><table class="grid" id="r-pubp"></table></div>${more('pubp', pubRows)}
      <h3>Pubblicazioni confermate</h3>
      <div class="table-wrap"><table class="grid" id="r-pubs"></table></div>${more('pubs', confirmed)}
    </section>
  `);
  bindShell();

  simpleTable(document.getElementById('r-sales'), [
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Fatturato', num: true, cell: r => money(r.p_income, r.currency) },
    { label: 'Ordini', num: true, cell: r => num(r.p_orders) },
    { label: 'Commissioni', num: true, cell: r => money(r.p_comm, r.currency) },
    { label: 'Nuovi utenti', num: true, cell: r => num(r.p_users) },
    { label: 'Pubblicazioni confermate', num: true, cell: r => num(perPartner.get(r.id)?.confirmed || 0) },
  ], cut('sales', sales), hasWindows ? `Nessuna vendita negli ultimi ${periodLabel}.` : 'Dati per periodo non disponibili.');

  simpleTable(document.getElementById('r-act'), [
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Approvato il', cell: r => esc(date(r.activation_date)), cls: 'nowrap' },
    { label: 'Fatturato', num: true, cell: r => money(w(r.id, 'income'), r.currency) },
    { label: 'Ordini', num: true, cell: r => num(w(r.id, 'orders')) },
    { label: 'Pubblicazioni confermate', num: true, cell: r => num(perPartner.get(r.id)?.confirmed || 0) },
    { label: 'Onboarding', cell: r => ladder([...(ladders.get(r.id) || [])]) + `<span class="ladder-count">${r.onboarding_done}/${r.onboarding_total}</span>` },
  ], cut('act', activations), `Nessuna nuova attivazione negli ultimi ${periodLabel}.`);

  simpleTable(document.getElementById('r-plat'), [
    { label: 'Social', cell: p => esc(PLATFORM_LABEL[p]) },
    { label: 'Confermate', num: true, cell: p => num(count(pubs.filter(x => x.platform === p), 'confirmed')) },
    { label: 'In tema', num: true, cell: p => num(count(pubs.filter(x => x.platform === p), 'on_topic')) },
    { label: 'Da verificare', num: true, cell: p => num(count(pubs.filter(x => x.platform === p), 'pending')) },
    { label: 'Non pertinenti', num: true, cell: p => num(count(pubs.filter(x => x.platform === p), 'not_relevant')) },
  ], platforms, '');

  simpleTable(document.getElementById('r-pubp'), [
    { label: 'Partner', cell: partnerCell },
    { label: 'Tipo', cell: typeCell },
    { label: 'Confermate', num: true, cell: r => num(r.confirmed) },
    { label: 'In tema', num: true, cell: r => num(r.on_topic) },
    { label: 'Da verificare', num: true, cell: r => r.pending ? `<span class="pill-warn">${r.pending}</span>` : '0' },
    { label: 'Social', cell: r => esc([...r.platforms].map(p => PLATFORM_LABEL[p]).join(', ') || '–') },
    { label: 'Fatturato nel periodo', num: true, cell: r => money(r.p_income, r.currency) },
  ], cut('pubp', pubRows), `Nessuna pubblicazione negli ultimi ${periodLabel}.`);

  simpleTable(document.getElementById('r-pubs'), [
    { label: 'Data', cell: x => esc(date(x.published_at)), cls: 'nowrap' },
    { label: 'Partner', cell: x => `<a class="pname" href="#/p/${esc(x.partner_id)}">${esc(pName(x.partner_id))}</a>` },
    { label: 'Social', cell: x => esc(PLATFORM_LABEL[x.platform]) },
    { label: 'Formato', cell: x => esc(FORMAT_LABEL[x.format]) + (x.category ? `<span class="pmeta">${esc(CATEGORY_LABEL[x.category] || x.category)}</span>` : '') },
    { label: 'Contenuto', cls: 'title-cell', cell: x => safeUrl(x.url) ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'Apri contenuto')}</a>` : esc(x.title) },
  ], cut('pubs', confirmed), `Nessuna pubblicazione confermata negli ultimi ${periodLabel}.`);

  ['r-sales', 'r-act', 'r-pubp'].forEach(clickable);
  document.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.more;
    R.open.has(k) ? R.open.delete(k) : R.open.add(k);
    const y = scrollY; renderReport(); scrollTo(0, y);
  }));
  document.querySelectorAll('[data-rperiod]').forEach(b => b.addEventListener('click', () => { R.period = b.dataset.rperiod; renderReport(); }));
  document.getElementById('print').addEventListener('click', () => window.print());
  const tag = `${days}gg-${asOf || today}`;
  const csv = {
    sales: () => downloadCsv(`report-commerciale-${tag}.csv`,
      ['Nome', 'Email', 'Codice', 'Tipo', 'Valuta', `Fatturato ${periodLabel}`, `Ordini ${periodLabel}`, `Commissioni ${periodLabel}`, `Nuovi utenti ${periodLabel}`, 'Pubblicazioni confermate', 'Data dati'],
      sales.map(r => [r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], r.currency, r.p_income, r.p_orders, r.p_comm, r.p_users, perPartner.get(r.id)?.confirmed || 0, asOf])),
    activations: () => downloadCsv(`report-attivazioni-${tag}.csv`,
      ['Nome', 'Email', 'Codice', 'Tipo', 'Approvato il', 'Valuta', `Fatturato ${periodLabel}`, `Ordini ${periodLabel}`, 'Pubblicazioni confermate', 'Onboarding completati', 'Onboarding totali', 'Data dati'],
      activations.map(r => [r.name, r.email, r.affiliate_code, TYPE_LABEL[r.type], r.activation_date, r.currency, w(r.id, 'income'), w(r.id, 'orders'),
        perPartner.get(r.id)?.confirmed || 0, r.onboarding_done, r.onboarding_total, asOf])),
    pubs: () => downloadCsv(`report-pubblicazioni-${days}gg-${today}.csv`,
      ['Data', 'Partner', 'Email', 'Codice', 'Tipo partner', 'Social', 'Formato', 'Tipo di contenuto', 'Titolo', 'URL', 'Stato'],
      pubs.map(x => { const p = byId.get(x.partner_id) || {}; return [x.published_at.slice(0, 10), p.name, p.email, p.affiliate_code, TYPE_LABEL[p.type],
        PLATFORM_LABEL[x.platform], FORMAT_LABEL[x.format], CATEGORY_LABEL[x.category] || '', x.title, x.url, REVIEW_LABEL[x.review_status]]; })),
  };
  document.querySelectorAll('[data-csv]').forEach(b => b.addEventListener('click', () => csv[b.dataset.csv]()));
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
    // Lettore di Drive: mostra immagini e video, serve la cartella condivisa con chiunque abbia il link.
    return `<div class="frames">
      <iframe class="frame-story" src="https://drive.google.com/file/d/${encodeURIComponent(x.media_drive_file_id)}/preview" title="Storia archiviata" allow="autoplay" loading="lazy"></iframe>
      <p class="frame-note">Se la storia non si vede, usa Apri contenuto.</p>
    </div>`;
  }
  return '<p class="frame-note">Anteprima non disponibile per questo contenuto. Usa Apri contenuto.</p>';
}

// Esito dell'ultimo controllo della bio/descrizione del canale
const BIO_LABEL = {
  link_with_code: ['ok', 'Link DeepCharts in bio, con il suo codice'],
  link: ['warn', 'Link DeepCharts in bio, ma senza il suo codice'],
  mention: ['warn', 'DeepCharts citato in bio, senza link'],
  none: ['bad', 'Nessun link DeepCharts in bio'],
  unreadable: ['warn', 'Pagina dei link non leggibile in automatico: da controllare a mano'],
  not_found: ['muted', 'Canale non trovato al controllo'],
};
function bioLine(b) {
  if (!b) return '';
  const [cls, label] = BIO_LABEL[b.status] || ['muted', b.status];
  const removed = ['link', 'link_with_code'].includes(b.previous_status) && !['link', 'link_with_code'].includes(b.status);
  const links = (b.links || []).map(l => { const u = safeUrl(/^https?:/i.test(l) ? l : 'https://' + l);
    return u ? `<a href="${u}" target="_blank" rel="noopener">${esc(l)}</a>` : esc(l); }).join(', ');
  return `<div class="bio-line"><span class="bio-${cls}">${label}</span>${removed ? ' <strong class="bio-bad">· link tolto dopo l\'ultimo controllo</strong>' : ''}
    <span class="pmeta">controllo del ${esc(date(b.checked_at))}${links ? ' · ' + links : ''}</span></div>`;
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

// ---------------------------------------------------------------- Carica dati commerciali (CSV)
const CSV_REQUIRED = ['Email', 'Name', 'Manager', 'Creation', 'Code', 'Type', 'Currency', 'Disabled', 'Clicks',
  'Users Tot', 'Orders Tot', 'Demo Tot', 'Demo 3M', 'Income Tot', 'Commissions Tot', 'Pending commissions Tot'];
const WINDOW_SUFFIX = { '3M': '3m', '1M': '1m', '2S': '2w', '1S': '1w' };
const WINDOW_METRICS = { users: 'Users', orders: 'Orders', demos: 'Demo', income: 'Income', commissions: 'Commissions', pending: 'Pending commissions' };

function parseDelimited(text) {
  text = text.replace(/^﻿/, '');
  const delim = (text.split(/\r?\n/)[0].match(/;/g) || []).length >= (text.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

function buildImport(text) {
  const rows = parseDelimited(text);
  const errors = [], warnings = [];
  if (rows.length < 2) return { errors: ['Il file è vuoto o non è un CSV.'], warnings, records: [] };
  const header = rows[0].map(h => h.trim());
  const missing = CSV_REQUIRED.filter(h => !header.includes(h));
  if (missing.length) return { errors: [`Mancano queste colonne: ${missing.join(', ')}. È l'export affiliati di DeepCharts?`], warnings, records: [] };
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const records = [], seen = new Set();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.length !== header.length) { errors.push(`Riga ${line}: ${r.length} colonne invece di ${header.length}.`); return; }
    const get = h => (r[col[h]] ?? '').trim();
    const email = get('Email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push(`Riga ${line}: email non valida (${get('Email') || 'vuota'}).`); return; }
    if (seen.has(email)) { errors.push(`Riga ${line}: email ripetuta (${email}).`); return; }
    seen.add(email);
    const int = h => {
      const v = get(h);
      if (v === '') return 0;
      if (!/^-?\d+(\.\d+)?$/.test(v)) { errors.push(`Riga ${line}: valore non numerico in ${h} (${v}).`); return 0; }
      return Number(v);
    };
    const windows = {};
    for (const [key, prefix] of Object.entries(WINDOW_METRICS)) {
      windows[key] = {};
      for (const [suffix, w] of Object.entries(WINDOW_SUFFIX)) if (col[`${prefix} ${suffix}`] !== undefined) windows[key][w] = int(`${prefix} ${suffix}`);
    }
    const creation = get('Creation');
    const cur = get('Currency').toUpperCase();
    records.push({
      email, name: get('Name'), manager: get('Manager'), code: get('Code'),
      type: get('Type'), currency: ['USD', 'EUR'].includes(cur) ? cur : 'UNSPECIFIED',
      account_status: get('Disabled') === '1' ? 'Disabled' : 'Enabled',
      activation_date: /^\d{4}-\d{2}-\d{2}$/.test(creation) && creation > '2001-01-01' ? creation : null,
      clicks: int('Clicks'), users: int('Users Tot'), orders: int('Orders Tot'), demos: int('Demo Tot'), demos_3m: int('Demo 3M'),
      income: int('Income Tot'), commissions: int('Commissions Tot'), pending: int('Pending commissions Tot'), windows,
    });
  });
  const noCurrency = records.filter(x => x.currency === 'UNSPECIFIED').length;
  if (noCurrency) warnings.push(`${noCurrency} ${noCurrency === 1 ? 'profilo' : 'profili'} senza valuta nel file: ${noCurrency === 1 ? 'resta' : 'restano'} con valuta non definita, come oggi.`);
  return { errors, warnings, records };
}

function dateFromFileName(name) {
  const m = String(name).match(/(20\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
}

async function renderUpload() {
  await ensureList();
  const { data: runs } = await sb.from('sync_runs').select('id, started_at, data_as_of, status, details').eq('source', 'csv_upload').order('id', { ascending: false }).limit(10);
  const latest = state.list.asOf;
  app.innerHTML = shell(`
    <section class="list-head">
      <div><h1>Carica dati commerciali</h1>
      <p class="sub">Trascina l'export affiliati (CSV) così come lo scarichi. Prima di salvare vedi un'anteprima con i controlli. Ultimo caricamento: ${esc(date(latest))}.</p></div>
    </section>
    <label class="dropzone" id="dropzone">
      <input type="file" id="csv-file" accept=".csv,text/csv" hidden>
      <strong>Trascina qui il file CSV</strong>
      <span>oppure clicca per sceglierlo dal computer</span>
    </label>
    <section id="preview"></section>
    <section class="panel">
      <h2>Ultimi caricamenti</h2>
      ${runs?.length ? `<div class="table-wrap"><table class="grid compact"><thead><tr><th>Quando</th><th>Data dei dati</th><th>File</th><th class="num">Profili</th><th class="num">Nuovi</th></tr></thead><tbody>
        ${runs.map(r => `<tr><td class="nowrap">${esc(new Date(r.started_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }))}</td><td>${esc(date(r.data_as_of))}</td>
          <td>${esc(r.details?.file || '')}</td><td class="num">${nf.format(r.details?.righe ?? 0)}</td><td class="num">${nf.format(r.details?.partner_nuovi ?? 0)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nessun caricamento dalla dashboard finora: i dati attuali arrivano dallo Sheet.</p>'}
    </section>
  `);
  bindShell();
  const input = document.getElementById('csv-file');
  const zone = document.getElementById('dropzone');
  const handle = file => file && file.text().then(text => previewImport(file.name, text));
  input.addEventListener('change', () => handle(input.files[0]));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); handle(e.dataTransfer.files[0]); });
}

function previewImport(fileName, text) {
  const { errors, warnings, records } = buildImport(text);
  const el = document.getElementById('preview');
  const { rows: current, asOf: latest } = state.list;
  const byEmail = new Map(current.map(r => [r.email, r]));
  const fileEmails = new Set(records.map(r => r.email));
  const added = records.filter(r => !byEmail.has(r.email));
  const gone = current.filter(r => r.metrics_as_of === latest && !fileEmails.has(r.email));
  const dropped = records.filter(r => {
    const old = byEmail.get(r.email);
    return old && old.currency === r.currency && old.income != null && r.income < Number(old.income);
  });
  const totals = (list, f) => list.reduce((t, r) => { const c = f(r).cur; if (c !== 'UNSPECIFIED') t[c] = (t[c] || 0) + Number(f(r).v || 0); return t; }, {});
  const tNew = totals(records, r => ({ cur: r.currency, v: r.income }));
  const tOld = totals(current.filter(r => r.metrics_as_of === latest), r => ({ cur: r.currency, v: r.income }));
  const asOfGuess = dateFromFileName(fileName);
  const lastCount = current.filter(r => r.metrics_as_of === latest).length;
  const blockedByCount = lastCount > 0 && records.length < lastCount * 0.8;
  if (gone.length) warnings.push(gone.length === 1 ? `1 profilo presente nell'ultimo caricamento non è nel file: resta in dashboard con i dati precedenti.` : `${gone.length} profili presenti nell'ultimo caricamento non sono nel file: restano in dashboard con i dati precedenti.`);
  if (dropped.length) warnings.push(dropped.length === 1 ? `1 profilo ha il fatturato totale più basso di prima (di solito per un rimborso): controlla sotto.` : `${dropped.length} profili hanno il fatturato totale più basso di prima (di solito per rimborsi): controlla l'elenco sotto.`);
  if (blockedByCount) errors.push('Il file ha oltre il 20% di profili in meno dell\'ultimo caricamento: probabilmente è un export parziale.');

  el.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Anteprima: ${esc(fileName)}</h2><span class="panel-figure">${nf.format(records.length)}<small> profili</small></span></div>
      ${errors.length ? `<div class="notice notice-err"><strong>Il file non si può caricare</strong><ul>${errors.slice(0, 12).map(e => `<li>${esc(e)}</li>`).join('')}</ul>${errors.length > 12 ? `<p>e altri ${errors.length - 12} errori.</p>` : ''}</div>` : ''}
      ${warnings.length ? `<div class="notice"><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="kpis kpis-compact">
        <div class="kpi"><span class="kpi-label">Nuovi profili</span><span class="kpi-value">${nf.format(added.length)}</span></div>
        <div class="kpi"><span class="kpi-label">Non più nel file</span><span class="kpi-value">${nf.format(gone.length)}</span></div>
        ${['USD', 'EUR'].map(c => `<div class="kpi"><span class="kpi-label">Fatturato totale ${c}</span><span class="kpi-value">${money(tNew[c] || 0, c)}</span>
          ${tOld[c] != null ? `<span class="delta ${(tNew[c] || 0) >= tOld[c] ? 'up' : 'down'}">${(tNew[c] || 0) >= tOld[c] ? '+' : ''}${money((tNew[c] || 0) - tOld[c], c)} dal ${esc(date(latest))}</span>` : ''}</div>`).join('')}
      </div>
      ${added.length ? `<details><summary>Nuovi profili (${added.length})</summary><p>${added.map(r => esc(r.name || r.email) + ' (' + esc(r.type) + ')').join(', ')}</p></details>` : ''}
      ${gone.length ? `<details><summary>Non più nel file (${gone.length})</summary><p>${gone.map(r => esc(r.name)).join(', ')}</p></details>` : ''}
      ${dropped.length ? `<details><summary>Fatturato in calo (${dropped.length})</summary><p>${dropped.map(r => `${esc(r.name || r.email)}: ${money(byEmail.get(r.email).income, r.currency)} → ${money(r.income, r.currency)}`).join(', ')}</p></details>` : ''}
      <div class="upload-confirm">
        <label>Data dei dati <input type="date" id="asof" value="${esc(asOfGuess)}" max="${new Date().toISOString().slice(0, 10)}"></label>
        <p class="muted" id="asof-note"></p>
        <button class="btn btn-primary" id="do-import" ${errors.length ? 'disabled' : ''}>Salva ${nf.format(records.length)} profili</button>
      </div>
    </section>`;
  const asofInput = document.getElementById('asof');
  const note = () => {
    const v = asofInput.value;
    const n = document.getElementById('asof-note');
    if (latest && v < latest) { n.textContent = `Data precedente all'ultimo caricamento (${date(latest)}): non si può salvare.`; n.className = 'form-error'; }
    else if (v === latest) { n.textContent = `Stessa data dell'ultimo caricamento: i nuovi valori lo sostituiscono.`; n.className = 'muted'; }
    else { n.textContent = `Diventa un nuovo punto nello storico: le variazioni si calcolano rispetto al ${date(latest)}.`; n.className = 'muted'; }
  };
  asofInput.addEventListener('change', note); note();
  document.getElementById('do-import').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Salvataggio in corso…';
    const { data, error } = await sb.rpc('import_commercial_csv', { p_as_of: asofInput.value, p_file_name: fileName, p_rows: records });
    if (error) { btn.disabled = false; btn.textContent = `Salva ${nf.format(records.length)} profili`; return toast('Caricamento non riuscito: ' + error.message, 'err'); }
    state.list = null; state.social = null; state.payout = null;
    toast(`Dati del ${date(data.data_as_of)} salvati: ${nf.format(data.metriche_scritte)} profili, ${nf.format(data.partner_nuovi)} nuovi`);
    renderUpload();
  });
}

// ---------------------------------------------------------------- Payout
// Sezione in inglese: la usa anche la contabilità (Shiny).
// Pratiche di payout: una riga per richiesta, con la fase, chi deve fare la prossima mossa e il giro del martedì.
// Le regole di accesso stanno nel database (permesso payout: owner e contabilità).
const PAYOUT_PREAVVISO = 800;
const PAYOUT_SOGLIA = 1000;
const STAGES = {
  requested:    { label: 'Request received',       owner: 'us',        next: 'Send the Deel invite',                         action: ['deel_invited', 'Deel invite sent'] },
  deel_invited: { label: 'Deel invite sent',       owner: 'affiliate', next: 'Sign the contract on Deel',                    action: ['deel_signed', 'Contract signed'] },
  deel_signed:  { label: 'Contract signed',        owner: 'affiliate', next: 'Complete the Deel profile',                    action: ['ready', 'Profile active'] },
  ready:        { label: 'Ready for payment run',  owner: 'us',        next: 'Create the payment request on Deel',           action: ['payment_sent', 'Request sent'] },
  payment_sent: { label: 'Payment request sent',   owner: 'affiliate', next: 'Approve the request in Deel notifications',    action: ['to_approve', 'Approved by affiliate'] },
  to_approve:   { label: 'To approve',             owner: 'us',        next: 'Final approval by accounting',                 action: ['paid', 'Paid'] },
  paid:         { label: 'Paid',                   owner: null,        next: '' },
  paused:       { label: 'On hold',                owner: 'affiliate', next: 'Resumes when the affiliate completes the step' },
  cancelled:    { label: 'Cancelled',              owner: null,        next: '' },
};
const STAGE_ORDER = ['requested', 'deel_invited', 'deel_signed', 'ready', 'payment_sent', 'to_approve', 'paid', 'paused', 'cancelled'];
const OPEN = s => s !== 'paid' && s !== 'cancelled';
const IN_QUEUE = s => s === 'ready' || s === 'payment_sent' || s === 'to_approve';
const DEEL_LABEL = { none: 'Not on Deel yet', invited: 'Invited', signed: 'Contract signed', active: 'Active', paused: 'On hold', terminated: 'Contract ended' };
const TYPE_EN = { Partner: 'Partner', Affiliate: 'Affiliate', Unspecified: 'Not set' };

const enNum = new Intl.NumberFormat('en-GB');
const moneyEn = (v, cur) => {
  if (v == null) return '–';
  const c = cur === 'EUR' || cur === 'USD' ? cur : null;
  return c ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v) : enNum.format(v);
};
const dateEn = v => (v ? new Date(String(v).length === 10 ? v + 'T12:00:00' : v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const typeEnCell = r => `<span class="tag tag-${esc(r.type)}">${esc(TYPE_EN[r.type] || r.type)}</span>`;

const romeToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const isoDow = iso => ((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
const upcomingTuesday = () => { const d = romeToday(); return addDays(d, (2 - isoDow(d) + 7) % 7); };
const daysInStage = r => Math.max(0, Math.floor((Date.now() - Date.parse(r.stage_since)) / DAY));
const sumByCurrency = rows => rows.reduce((t, r) => { const c = r.currency || r.person?.currency || '?'; t[c] = (t[c] || 0) + Number(r.amount || 0); return t; }, {});
const totalsText = t => Object.entries(t).map(([c, v]) => moneyEn(v, c)).join(' + ') || '–';

function waitBadge(r) {
  const d = daysInStage(r);
  const st = STAGES[r.stage];
  if (!OPEN(r.stage)) return '';
  const waitingOnAffiliate = st.owner === 'affiliate' && r.stage !== 'paused';
  let cls = '';
  if (waitingOnAffiliate) cls = d >= 21 ? 'wait-crit' : d >= 9 ? 'wait-high' : d >= 5 ? 'wait-mid' : '';
  if (st.owner === 'us') cls = d >= 2 ? 'wait-high' : '';
  const hint = waitingOnAffiliate && d >= 21 ? ' · put on hold' : waitingOnAffiliate && d >= 14 ? ' · tell the manager' : '';
  return `<span class="wait ${cls}">${d === 0 ? 'today' : d === 1 ? '1 day' : d + ' days'}${hint}</span>`;
}
const ownerTag = st => st.owner === 'us' ? '<span class="owner owner-noi">Our move</span>'
  : st.owner === 'affiliate' ? '<span class="owner owner-aff">Affiliate\'s move</span>' : '';
const personCell = p => `<span class="pname">${esc(p?.name || 'Affiliate')}</span><span class="pmeta">${esc(p?.email || '')}</span>`;

async function loadPayout() {
  const [payouts, people] = await Promise.all([
    fetchAll(() => sb.from('payouts').select('*').order('created_at')),
    sb.rpc('payout_people'),
  ]);
  if (people.error) throw people.error;
  const byId = new Map(people.data.map(p => [p.partner_id, p]));
  for (const r of payouts) r.person = byId.get(r.partner_id);
  const asOf = people.data.reduce((m, p) => (p.as_of && p.as_of > m ? p.as_of : m), '');
  state.payout = { payouts, people: people.data, byId, asOf };
}

async function renderPayout() {
  state.payoutView ||= { tab: 'us', q: '' };
  const v = state.payoutView;
  if (!state.payout) {
    app.innerHTML = shell('<p class="loading">Loading payouts…</p>');
    bindShell();
    await loadPayout();
  }
  const { payouts, people, asOf } = state.payout;
  const tuesday = upcomingTuesday();
  const open = payouts.filter(r => OPEN(r.stage));
  const openIds = new Set(open.map(r => r.partner_id));
  const us = open.filter(r => STAGES[r.stage].owner === 'us');
  const aff = open.filter(r => STAGES[r.stage].owner === 'affiliate');
  const batch = open.filter(r => IN_QUEUE(r.stage) && r.batch_date && r.batch_date <= tuesday);
  const stuck = aff.filter(r => r.stage !== 'paused' && daysInStage(r) >= 9);
  const eligible = people.filter(p => !openIds.has(p.partner_id) && Number(p.pending) >= PAYOUT_SOGLIA);
  const near = people.filter(p => !openIds.has(p.partner_id) && Number(p.pending) >= PAYOUT_PREAVVISO && Number(p.pending) < PAYOUT_SOGLIA);

  const TABS = [
    ['us', `Our move (${us.length})`], ['affiliate', `Affiliate's move (${aff.length})`],
    ['run', `Run of ${dateEn(tuesday)} (${batch.length})`], ['thresholds', `Thresholds (${eligible.length + near.length})`],
    ['paid', 'Paid'], ['all', 'All'],
  ];
  app.innerHTML = shell(`
    <section class="list-head" lang="en">
      <div>
        <h1>Payouts</h1>
        <p class="sub">Weekly payment run every Tuesday: anyone ready by Friday is paid the following Tuesday. Unpaid commissions from the CSV of ${esc(dateEn(asOf))}.</p>
      </div>
      <div class="actions">
        <button class="btn" id="export">Export CSV</button>
        <button class="btn btn-primary" id="new-payout">Log request</button>
      </div>
    </section>
    <section class="kpis kpis-compact" lang="en">
      <div class="kpi"><span class="kpi-label">Our move</span><span class="kpi-value">${enNum.format(us.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Affiliate's move</span><span class="kpi-value">${enNum.format(aff.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Stuck 9+ days</span><span class="kpi-value ${stuck.length ? 'warn' : ''}">${enNum.format(stuck.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Run of ${esc(dateEn(tuesday))}</span><span class="kpi-value">${enNum.format(batch.length)}</span></div>
      <div class="kpi"><span class="kpi-label">Run amount</span><span class="kpi-value kpi-small">${esc(totalsText(sumByCurrency(batch)))}</span></div>
      <div class="kpi"><span class="kpi-label">Eligible, no request</span><span class="kpi-value">${enNum.format(eligible.length)}</span></div>
    </section>
    <section class="filters" lang="en">
      <div class="seg" role="group" aria-label="View">
        ${TABS.map(([k, l]) => `<button data-ptab="${k}" aria-pressed="${v.tab === k}">${esc(l)}</button>`).join('')}
      </div>
      <input type="search" id="pq" placeholder="Search by name or email" value="${esc(v.q)}" aria-label="Search">
    </section>
    <div id="payout-body" lang="en"></div>
    <dialog id="pdialog" class="pdialog" aria-labelledby="pdialog-title" lang="en"></dialog>
  `);
  bindShell();
  const groups = { us, aff, batch, eligible, near, tuesday };
  drawPayoutBody(groups);
  document.querySelectorAll('[data-ptab]').forEach(b => b.addEventListener('click', () => { v.tab = b.dataset.ptab; renderPayout(); }));
  document.getElementById('pq').addEventListener('input', e => { v.q = e.target.value; drawPayoutBody(groups); });
  document.getElementById('new-payout').addEventListener('click', () => openNewPayout());
  document.getElementById('export').addEventListener('click', () => exportPayout(groups));
}

function payoutRowsFor(tab, groups) {
  const { payouts } = state.payout;
  if (tab === 'us') return groups.us.sort((a, b) => STAGE_ORDER.indexOf(b.stage) - STAGE_ORDER.indexOf(a.stage) || Date.parse(a.stage_since) - Date.parse(b.stage_since));
  if (tab === 'affiliate') return groups.aff.sort((a, b) => (a.stage === 'paused') - (b.stage === 'paused') || Date.parse(a.stage_since) - Date.parse(b.stage_since));
  if (tab === 'run') return groups.batch.sort((a, b) => Date.parse(a.ready_at) - Date.parse(b.ready_at));
  if (tab === 'paid') return payouts.filter(r => r.stage === 'paid').sort((a, b) => Date.parse(b.paid_at) - Date.parse(a.paid_at));
  return [...payouts].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function drawPayoutBody(groups) {
  const v = state.payoutView;
  const el = document.getElementById('payout-body');
  const q = v.q.trim().toLowerCase();
  const match = p => !q || [p?.name, p?.email].some(x => (x || '').toLowerCase().includes(q));

  if (v.tab === 'thresholds') {
    const elig = groups.eligible.filter(match).sort((a, b) => Number(b.pending) - Number(a.pending));
    const near = groups.near.filter(match).sort((a, b) => Number(b.pending) - Number(a.pending));
    el.innerHTML = `
      <section class="report-block">
        <div class="panel-head"><h2>Over ${enNum.format(PAYOUT_SOGLIA)} in unpaid commissions, no open request</h2></div>
        <p class="muted panel-note">They can request a payout. When the request comes in, log it with the button: the amount starts from the unpaid commissions.</p>
        <div class="table-wrap"><table class="grid" id="elig-table"></table></div>
      </section>
      <section class="report-block">
        <div class="panel-head"><h2>Close to the threshold (${enNum.format(PAYOUT_PREAVVISO)}–${enNum.format(PAYOUT_SOGLIA - 1)})</h2></div>
        <p class="muted panel-note">To be given notice: what happens at ${enNum.format(PAYOUT_SOGLIA)} and which details to prepare. No Deel cost until they sign.</p>
        <div class="table-wrap"><table class="grid" id="near-table"></table></div>
      </section>`;
    const cols = [
      { label: 'Affiliate', cell: personCell },
      { label: 'Type', cell: typeEnCell },
      { label: 'Unpaid commissions', num: true, cell: p => moneyEn(p.pending, p.currency) },
      { label: 'Total commissions', num: true, cell: p => moneyEn(p.commissions, p.currency) },
      { label: 'Deel', cell: p => esc(DEEL_LABEL[p.deel_status] || p.deel_status) },
      { label: '', cell: p => `<button class="btn btn-small" data-register="${esc(p.partner_id)}">Log request</button>` },
    ];
    simpleTable(document.getElementById('elig-table'), cols, elig, 'Nobody over the threshold without an open request.');
    simpleTable(document.getElementById('near-table'), cols, near, 'Nobody close to the threshold.');
    el.querySelectorAll('[data-register]').forEach(b => b.addEventListener('click', () => openNewPayout(b.dataset.register)));
    return;
  }

  const rows = payoutRowsFor(v.tab, groups).filter(r => match(r.person));
  const note = {
    us: 'Requests waiting on us: Deel invites to send, payment requests to create, Tuesday approvals.',
    affiliate: 'Requests waiting on the affiliate, oldest first. From day 14 tell their manager, from day 21 put them on hold.',
    run: `Ready by Friday, first come first served. Total: ${totalsText(sumByCurrency(rows))}.`,
    paid: 'Completed payouts.',
    all: 'All requests, including cancelled ones.',
  }[v.tab];
  el.innerHTML = `<p class="muted panel-note">${esc(note)}</p><div class="table-wrap"><table class="grid rows-link" id="payout-table"></table></div>`;
  const table = document.getElementById('payout-table');
  const columns = [
    { label: 'Affiliate', cell: r => personCell(r.person) },
    { label: 'Type', cell: r => r.person ? typeEnCell(r.person) : '' },
    { label: 'Amount', num: true, cell: r => r.amount ? moneyEn(r.amount, r.currency) : '<span class="muted">To be set</span>' },
    { label: 'Stage', cell: r => `<span class="stage stage-${r.stage}">${esc(STAGES[r.stage].label)}</span>${ownerTag(STAGES[r.stage])}` },
    { label: 'Waiting', cell: r => waitBadge(r), cls: 'nowrap' },
    { label: 'Next step', cell: r => esc(STAGES[r.stage].next) },
    { label: v.tab === 'paid' ? 'Paid on' : 'Run', cell: r => esc(dateEn(v.tab === 'paid' ? r.paid_at : r.batch_date)), cls: 'nowrap' },
    { label: '', cell: r => {
      const st = STAGES[r.stage];
      if (r.stage === 'paused') return `<button class="btn btn-small" data-move="${esc(r.id)}" data-to="${esc(r.previous_stage || 'requested')}">Resume</button>`;
      return st.action ? `<button class="btn btn-small btn-step" data-move="${esc(r.id)}" data-to="${st.action[0]}">${esc(st.action[1])}</button>` : '';
    } },
  ];
  table.innerHTML = `<thead><tr>${columns.map(c => `<th scope="col" class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr data-pid="${esc(r.id)}" tabindex="0">${columns.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="empty-row">No requests here.</td></tr>`}</tbody>`;
  table.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); movePayout(b.dataset.move, b.dataset.to); }));
  table.querySelectorAll('tr[data-pid]').forEach(tr => {
    tr.addEventListener('click', () => openPayoutDetail(tr.dataset.pid));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') openPayoutDetail(tr.dataset.pid); });
  });
}

async function movePayout(id, to, extra = {}) {
  const r = state.payout.payouts.find(x => x.id === id);
  const { error } = await sb.from('payouts').update({ stage: to, ...extra }).eq('id', id);
  if (error) return toast('Not saved: ' + error.message, 'err');
  toast(`${r?.person?.name || 'Request'}: ${STAGES[to].label}`);
  state.payout = null;
  document.getElementById('pdialog')?.close();
  renderPayout();
}

function openNewPayout(partnerId = null) {
  const dlg = document.getElementById('pdialog');
  const { people, payouts } = state.payout;
  const openIds = new Set(payouts.filter(r => OPEN(r.stage)).map(r => r.partner_id));
  const options = people.filter(p => !openIds.has(p.partner_id)).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  dlg.innerHTML = `
    <form method="dialog" class="pform" id="new-form">
      <h2 id="pdialog-title">Log a payout request</h2>
      <label>Affiliate
        <select name="partner" required>
          <option value="">Choose…</option>
          ${options.map(p => `<option value="${esc(p.partner_id)}" ${p.partner_id === partnerId ? 'selected' : ''}>${esc(p.name)} · ${esc(p.email)} · ${moneyEn(p.pending, p.currency)}</option>`).join('')}
        </select>
      </label>
      <p class="muted hint">The list only shows profiles with at least ${enNum.format(PAYOUT_PREAVVISO)} in unpaid commissions in the latest CSV, or with an existing request.</p>
      <div class="two-fields">
        <label>Amount requested<input type="number" name="amount" min="1" step="0.01"></label>
        <label>Currency<select name="currency"><option value="USD">USD</option><option value="EUR">EUR</option></select></label>
      </div>
      <label>Request date<input type="date" name="requested_at" value="${romeToday()}" max="${romeToday()}"></label>
      <label>Note (optional)<textarea name="notes" rows="2"></textarea></label>
      <p class="muted hint" id="deel-hint"></p>
      <div class="actions">
        <button type="button" class="btn btn-ghost" id="cancel-new">Cancel</button>
        <button type="submit" class="btn btn-primary">Log request</button>
      </div>
    </form>`;
  const form = dlg.querySelector('form');
  const sync = () => {
    const p = state.payout.byId.get(form.partner.value);
    if (!p) return (document.getElementById('deel-hint').textContent = '');
    form.amount.value = p.pending ?? '';
    form.currency.value = p.currency === 'EUR' ? 'EUR' : 'USD';
    document.getElementById('deel-hint').textContent = p.deel_status === 'active'
      ? 'Already active on Deel: the request starts at "Ready for payment run".'
      : 'First payout: the request starts at "Request received", then the Deel invite.';
  };
  form.partner.addEventListener('change', sync); sync();
  document.getElementById('cancel-new').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.partner.value) return toast('Choose the affiliate', 'err');
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    const { error } = await sb.from('payouts').insert({
      partner_id: form.partner.value,
      amount: form.amount.value ? Number(form.amount.value) : null,
      currency: form.currency.value,
      requested_at: form.requested_at.value || romeToday(),
      notes: form.notes.value.trim() || null,
    });
    btn.disabled = false;
    if (error) return toast(/one_open/.test(error.message) ? 'This affiliate already has an open request.' : 'Not saved: ' + error.message, 'err');
    toast('Request logged');
    dlg.close();
    state.payout = null;
    state.payoutView.tab = 'us';
    renderPayout();
  });
  dlg.showModal();
}

async function openPayoutDetail(id) {
  const r = state.payout.payouts.find(x => x.id === id);
  if (!r) return;
  const dlg = document.getElementById('pdialog');
  const p = r.person || {};
  const st = STAGES[r.stage];
  dlg.innerHTML = `<div class="pform"><h2 id="pdialog-title">${esc(p.name || 'Affiliate')}</h2><p class="loading">Loading…</p></div>`;
  dlg.showModal();
  const { data: events, error } = await sb.from('payout_events').select('*').eq('payout_id', id).order('at', { ascending: false });
  if (error) { toast(error.message, 'err'); return dlg.close(); }
  const evText = e => e.kind === 'created' ? `Request logged · ${STAGES[e.to_stage]?.label}`
    : e.kind === 'stage' ? `${STAGES[e.from_stage]?.label} → ${STAGES[e.to_stage]?.label}`
    : e.kind === 'email' ? `Email: ${e.note}` : `Note: ${e.note}`;
  const when = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  dlg.innerHTML = `
    <form class="pform" id="detail-form">
      <div class="pform-head">
        <div>
          <h2 id="pdialog-title">${esc(p.name || 'Affiliate')}</h2>
          <p class="muted">${esc(p.email || '')} · ${esc(TYPE_EN[p.type] || p.type || '')}</p>
        </div>
        <button type="button" class="btn btn-ghost" id="close-detail" aria-label="Close">✕</button>
      </div>
      <dl class="notes">
        <dt>Stage</dt><dd><span class="stage stage-${r.stage}">${esc(st.label)}</span> ${ownerTag(st)} ${waitBadge(r)}</dd>
        <dt>Next step</dt><dd>${esc(st.next || '–')}</dd>
        <dt>Deel</dt><dd>${esc(DEEL_LABEL[p.deel_status] || '–')}</dd>
        <dt>Requested on</dt><dd>${esc(dateEn(r.requested_at))}</dd>
        <dt>Ready since</dt><dd>${esc(dateEn(r.ready_at))}</dd>
        <dt>Unpaid commissions</dt><dd>${moneyEn(p.pending, p.currency)} <span class="muted">(CSV of ${esc(dateEn(p.as_of))}; total ${moneyEn(p.commissions, p.currency)})</span></dd>
        ${p.manager_email ? `<dt>Manager</dt><dd>${esc(p.manager_email)}</dd>` : ''}
      </dl>
      <div class="two-fields">
        <label>Amount<input type="number" name="amount" min="1" step="0.01" value="${esc(r.amount ?? '')}"></label>
        <label>Currency<select name="currency"><option value="USD" ${r.currency !== 'EUR' ? 'selected' : ''}>USD</option><option value="EUR" ${r.currency === 'EUR' ? 'selected' : ''}>EUR</option></select></label>
        <label>Payment run<input type="date" name="batch_date" value="${esc(r.batch_date || '')}"></label>
      </div>
      <label>Stage
        <select name="stage">${STAGE_ORDER.map(s => `<option value="${s}" ${s === r.stage ? 'selected' : ''}>${esc(STAGES[s].label)}</option>`).join('')}</select>
      </label>
      <label>Note<textarea name="notes" rows="2" placeholder="E.g. reminded on WhatsApp, wants to be paid in EUR…">${esc(r.notes || '')}</textarea></label>
      <div class="actions">
        ${OPEN(r.stage) && r.stage !== 'paused' ? '<button type="button" class="btn btn-ghost" id="pause">Put on hold</button>' : ''}
        ${OPEN(r.stage) ? '<button type="button" class="btn btn-ghost" id="cancel-payout">Cancel request</button>' : ''}
        <span class="spacer"></span>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
      <h3>History</h3>
      <ol class="history">${events.map(e => `<li><span class="muted">${esc(when(e.at))}</span> ${esc(evText(e))}</li>`).join('') || '<li class="muted">No events</li>'}</ol>
    </form>`;
  const form = dlg.querySelector('form');
  document.getElementById('close-detail').addEventListener('click', () => dlg.close());
  document.getElementById('pause')?.addEventListener('click', () => movePayout(id, 'paused'));
  document.getElementById('cancel-payout')?.addEventListener('click', () => {
    if (confirmInline(form, 'Cancel this request? It stays in the history but leaves the lists.')) movePayout(id, 'cancelled');
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const patch = {
      amount: form.amount.value ? Number(form.amount.value) : null,
      currency: form.currency.value,
      batch_date: form.batch_date.value || null,
      notes: form.notes.value.trim() || null,
    };
    if (form.stage.value !== r.stage) patch.stage = form.stage.value;
    const { error: err } = await sb.from('payouts').update(patch).eq('id', id);
    if (err) return toast('Not saved: ' + err.message, 'err');
    toast('Saved');
    dlg.close();
    state.payout = null;
    renderPayout();
  });
}

// Conferma in due clic senza finestre del browser: il primo clic arma il pulsante, il secondo conferma.
function confirmInline(form, msg) {
  const btn = form.querySelector('#cancel-payout');
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  btn.textContent = 'Confirm cancellation';
  btn.classList.add('btn-reject');
  toast(msg);
  return false;
}

function exportPayout({ us, aff, batch, tuesday }) {
  const v = state.payoutView;
  const { payouts, asOf } = state.payout;
  const rows = v.tab === 'run' ? batch : v.tab === 'us' ? us : v.tab === 'affiliate' ? aff
    : v.tab === 'paid' ? payouts.filter(r => r.stage === 'paid') : payouts;
  const name = v.tab === 'run' ? `payout-run-${tuesday}.csv` : `payouts-${v.tab}-${romeToday()}.csv`;
  downloadCsv(name,
    ['Name', 'Email', 'Type', 'Currency', 'Amount', 'Stage', 'Next step', 'Days in stage', 'Requested on', 'Ready since', 'Payment run', 'Paid on', 'Unpaid commissions (CSV)', 'CSV date', 'Notes'],
    rows.map(r => [r.person?.name, r.person?.email, TYPE_EN[r.person?.type] || '', r.currency, r.amount, STAGES[r.stage].label, STAGES[r.stage].next,
      daysInStage(r), r.requested_at, r.ready_at?.slice(0, 10) || '', r.batch_date || '', r.paid_at?.slice(0, 10) || '', r.person?.pending ?? '', asOf, r.notes || '']));
}

boot();
