import * as M from './model.js';
import * as V from './crypto.js';

const VAULT_KEY = 'cashflow.vault.v1';
const app = document.getElementById('app');

/* ---------- 小道具 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n || 0)).toLocaleString('ja-JP');
const fmt = d => d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '—';
const fmtMD = d => `${d.getMonth() + 1}/${d.getDate()}`;
const fmtYM = d => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const uid = () => crypto.randomUUID().slice(0, 8);
const KIND = { income: '収入', bill: '確定した請求', recurring: '毎月の見込み', purchase: '大きい買い物' };
const OFFSETS = [[0, '当月'], [1, '翌月'], [2, '翌々月']];
const COUNTS = [1, 2, 3, 5, 6, 10, 12, 24];

function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

function readVault() { try { const t = localStorage.getItem(VAULT_KEY); return t ? JSON.parse(t) : null; } catch { return null; } }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => M.iso(new Date()).replace(/-/g, '');

/* ---------- 状態 ---------- */
let session = null;       // { key, kdf }  鍵はメモリ上だけ
let S = null;             // 復号したデータ
let tab = 'overview';
let saveTimer = null, saveState = '';
let lastActive = Date.now(), fails = 0;
let confirmKey = null;
let pendingImport = null;
let flash = {};
let cmp = { label: '', amount: 80000, count: 1, feePct: 0 };
let logDraft = { date: '', hours: '', memo: '' };
const listOf = name => (name === 'logs' ? S.job.logs : S[name]);
const hrs = h => `${(Math.round((+h || 0) * 100) / 100).toLocaleString('ja-JP')}h`;

function seed() {
  return {
    v: 1,
    base: { date: M.iso(today()), balance: 0, months: 6, safe: 30000 },
    job: { wage: 1100, hours: 55, close: 31, pay: 15, offset: 1, dedPct: 0, transport: 0, paidThisYear: 0, wall: 1230000, months: {}, logs: [] },
    cards: [
      { id: uid(), name: 'メインカード', close: 15, pay: 13, offset: 1 },
      { id: uid(), name: '固定費カード', close: 31, pay: 26, offset: 1 },
      { id: uid(), name: 'その他カード', close: 5, pay: 4, offset: 1 },
    ],
    bills: [], recurring: [], purchases: [],
    prefs: { lockMin: 5 },
  };
}
function migrate(d) {
  const s = seed();
  const o = { ...s, ...d, v: 1 };
  o.base = { ...s.base, ...(d.base || {}) };
  o.job = { ...s.job, ...(d.job || {}) };
  o.job.months = o.job.months || {};
  o.job.logs = Array.isArray(o.job.logs) ? o.job.logs : [];
  o.prefs = { ...s.prefs, ...(d.prefs || {}) };
  for (const k of ['cards', 'bills', 'recurring', 'purchases']) o[k] = Array.isArray(d[k]) ? d[k] : s[k];
  return o;
}

/* ---------- 保存（毎回暗号化） ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveState = '保存中…'; paintSave();
  saveTimer = setTimeout(saveNow, 300);
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!session || !S) return;
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(await V.seal(session.key, session.kdf, S)));
    const n = new Date();
    saveState = `暗号化して保存 ${M.pad(n.getHours())}:${M.pad(n.getMinutes())}`;
  } catch {
    saveState = '保存できませんでした。ブラウザのサイトデータ設定を確認してください';
  }
  paintSave();
}
function paintSave() { const el = document.getElementById('save-state'); if (el) el.textContent = saveState; }

/* ---------- ロック ---------- */
async function lock(reason = '') {
  if (saveTimer) await saveNow();
  session = null; S = null; pendingImport = null; confirmKey = null; flash = {};
  renderLock(reason);
}
const idle = () => session && S && S.prefs.lockMin > 0 && Date.now() - lastActive > S.prefs.lockMin * 60000;
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(t => addEventListener(t, () => { lastActive = Date.now(); }, { passive: true }));
setInterval(() => { if (idle()) lock('しばらく操作がなかったのでロックしました。'); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (saveTimer) saveNow(); }
  else if (idle()) lock('しばらく操作がなかったのでロックしました。');
});
addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

function renderLock(msg = '') {
  const has = !!readVault();
  app.innerHTML = `
  <div class="lock">
    <form id="lock-form" class="lock-box">
      <h1>キャッシュフロー</h1>
      <p class="sub">${has
        ? 'パスワードを入力してロックを解除します。'
        : '最初にパスワードを決めます。入力したデータはこのパスワードで暗号化して、この端末のブラウザにだけ保存します。'}</p>
      <input type="text" name="username" autocomplete="username" value="cashflow" hidden>
      <label class="field" for="pw"><span>パスワード</span>
        <input id="pw" type="password" autocomplete="${has ? 'current-password' : 'new-password'}" required minlength="8" autofocus></label>
      ${has ? '' : `
      <label class="field" for="pw2"><span>パスワード（確認）</span>
        <input id="pw2" type="password" autocomplete="new-password" required minlength="8"></label>
      <p class="note">8文字以上。忘れるとデータは元に戻せません。単語を4つ以上つなげた長いフレーズがおすすめです。</p>`}
      <p class="msg" id="lock-msg" role="alert">${esc(msg)}</p>
      <button class="btn primary" type="submit">${has ? 'ロックを解除' : 'はじめる'}</button>
      ${has ? `
      <details class="forgot">
        <summary>パスワードを忘れた場合</summary>
        <p class="note">この端末のデータを消して、最初からやり直せます。バックアップファイルがあれば、新しいパスワードを作った後に「設定」から読み込めます（読み込みには、バックアップを作ったときのパスワードが必要です）。</p>
        <button type="button" class="btn" data-act="wipe">${confirmKey === 'wipe' ? 'もう一度押すと消します' : 'この端末のデータを消す'}</button>
      </details>` : ''}
    </form>
  </div>`;
  document.getElementById('pw')?.focus();
}

async function onLockSubmit(form) {
  const pw = form.querySelector('#pw').value;
  const pw2 = form.querySelector('#pw2')?.value;
  const msg = form.querySelector('#lock-msg');
  const btn = form.querySelector('button[type=submit]');
  const vault = readVault();
  if (!vault) {
    if (pw.length < 8) { msg.textContent = 'パスワードは8文字以上にしてください。'; return; }
    if (pw !== pw2) { msg.textContent = '確認用のパスワードが一致しません。'; return; }
    btn.disabled = true; btn.textContent = '鍵を作成中…';
    session = await V.create(pw);
    S = seed(); lastActive = Date.now();
    await saveNow();
    renderApp();
    return;
  }
  btn.disabled = true; btn.textContent = '確認中…';
  try {
    const r = await V.open(vault, pw);
    session = { key: r.key, kdf: r.kdf };
    S = migrate(r.data); fails = 0; lastActive = Date.now(); saveState = '';
    renderApp();
  } catch {
    fails++;
    const wait = Math.min(10, fails);
    msg.textContent = `パスワードが違います。${wait}秒後にもう一度入力できます。`;
    await new Promise(r => setTimeout(r, wait * 1000));
    btn.disabled = false; btn.textContent = 'ロックを解除';
    form.querySelector('#pw').select();
  }
}

/* ---------- 画面の骨組み ---------- */
const TABS = [['overview', '概要'], ['job', 'バイト'], ['cards', 'カード・請求'], ['buy', '大きい買い物'], ['settings', '設定']];

function renderApp() {
  app.innerHTML = `
  <header class="top">
    <div class="bar wrap">
      <span class="brand">キャッシュフロー</span>
      <span class="save" id="save-state">${esc(saveState)}</span>
      <button type="button" class="btn" data-act="lock">ロック</button>
    </div>
    <nav class="tabs wrap" aria-label="画面の切り替え">
      ${TABS.map(([k, l]) => `<button type="button" class="tab" data-tab="${k}" aria-current="${k === tab ? 'page' : 'false'}">${l}</button>`).join('')}
    </nav>
  </header>
  <div class="status wrap" id="status"></div>
  <main class="page wrap" id="page"></main>`;
  renderPage();
}

function renderPage() {
  const sim = M.simulate(S);
  paintStatus(sim);
  const views = { overview: viewOverview, job: viewJob, cards: viewCards, buy: viewBuy, settings: viewSettings };
  document.getElementById('page').innerHTML = views[tab](sim);
}

function rerender() {
  const a = document.activeElement;
  const id = a && a.id;
  let sel = null;
  try { if (a && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch { /* number 入力 */ }
  renderPage();
  if (id) {
    const n = document.getElementById(id);
    if (n) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(...sel); } catch { /* */ } }
  }
}

function judge(min) {
  const safe = +S.base.safe || 0;
  if (min.balance < 0) return ['bad', '残高不足'];
  if (min.balance < safe) return ['warn', '安全ライン未満'];
  return ['ok', '余裕あり'];
}
const chip = j => `<span class="chip ${j[0]}">${j[1]}</span>`;

function paintStatus(sim) {
  const el = document.getElementById('status'); if (!el) return;
  el.innerHTML = `
    <div class="stat"><span class="k">基準日の残高</span><span class="v">${yen(S.base.balance)}<small>円</small></span><span class="s">${fmt(sim.start)}</span></div>
    <div class="stat"><span class="k">最低残高</span><span class="v">${yen(sim.min.balance)}<small>円</small></span><span class="s">${fmt(sim.min.date)} ${chip(judge(sim.min))}</span></div>
    <div class="stat"><span class="k">期間末の残高</span><span class="v">${yen(sim.final)}<small>円</small></span><span class="s">${fmt(sim.end)}</span></div>`;
}

/* ---------- 入力部品 ---------- */
function fieldNum(path, label, o = {}) {
  const id = o.id || 'f-' + path.replace(/\./g, '-');
  const v = getPath(S, path);
  return `<label class="field" for="${id}"><span>${label}${o.unit ? `<em>${o.unit}</em>` : ''}</span>
    <input id="${id}" type="number" inputmode="decimal" data-bind="${path}" data-type="num" value="${esc(v)}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''} step="${o.step || 1}">
    ${o.note ? `<small>${o.note}</small>` : ''}</label>`;
}
function fieldSelect(path, label, opts, o = {}) {
  const id = 'f-' + path.replace(/\./g, '-');
  const v = getPath(S, path);
  return `<label class="field" for="${id}"><span>${label}</span>
    <select id="${id}" data-bind="${path}" data-type="num">${opts.map(([k, l]) => `<option value="${k}"${k == v ? ' selected' : ''}>${l}</option>`).join('')}</select>
    ${o.note ? `<small>${o.note}</small>` : ''}</label>`;
}
const cardName = id => S.cards.find(c => c.id === id)?.name || '';
const cardOptions = sel => (sel && !S.cards.some(c => c.id === sel) ? '<option value="">（カード未選択）</option>' : '') +
  S.cards.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
const cell = (list, it, f, attrs = '') => `<input id="${list}-${it.id}-${f}" class="cell" data-list="${list}" data-id="${it.id}" data-f="${f}" ${attrs}>`;
const cellNum = (list, it, f, extra = '') => cell(list, it, f, `type="number" inputmode="decimal" data-type="num" value="${esc(it[f])}" ${extra}`);
const cellText = (list, it, f, ph = '') => cell(list, it, f, `type="text" value="${esc(it[f])}" placeholder="${esc(ph)}"`);
const delBtn = (list, it, label) => {
  const key = `del:${it.id}`;
  return `<button type="button" class="del${confirmKey === key ? ' armed' : ''}" data-act="del" data-list="${list}" data-id="${it.id}" aria-label="${esc(label)}を削除">${confirmKey === key ? '削除' : '×'}</button>`;
};
const purchaseFrom = () => { const t = today(), b = M.parseDate(S.base.date) || t; return b > t ? b : t; };

/* ---------- 概要 ---------- */
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function chart(sim) {
  const avail = (document.getElementById('page')?.clientWidth || 800) - 34;
  const W = Math.round(Math.max(340, Math.min(1080, avail))), H = W < 560 ? 200 : 240, L = 46, R = 10, T = 14, B = 28;
  const pts = [{ date: sim.start, balance: +S.base.balance || 0 }, ...sim.rows];
  const t0 = sim.start.getTime(), t1 = M.addDays(sim.end, 1).getTime(), span = t1 - t0;
  const safe = +S.base.safe || 0;
  const vals = pts.map(p => p.balance);
  let lo = Math.min(0, ...vals), hi = Math.max(safe, ...vals);
  if (hi === lo) hi = lo + 10000;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = t => L + (t - t0) / span * (W - L - R);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  let d = `M${x(t0).toFixed(1)},${y(pts[0].balance).toFixed(1)}`;
  for (const p of pts.slice(1)) d += ` H${x(p.date.getTime()).toFixed(1)} V${y(p.balance).toFixed(1)}`;
  d += ` H${x(t1).toFixed(1)}`;
  const area = `${d} V${y(lo).toFixed(1)} H${x(t0).toFixed(1)} Z`;
  const ticks = []; for (let v = lo; v <= hi + 1; v += step) ticks.push(v);
  const months = [];
  for (let m = new Date(sim.start.getFullYear(), sim.start.getMonth() + 1, 1); m.getTime() < t1; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(m);
  const man = v => { const n = v / 10000; return (Number.isInteger(n) ? n : n.toFixed(1)) + '万'; };
  const mx = x(sim.min.date.getTime()), my = y(sim.min.balance);
  const right = mx > W * 0.55;
  const ly = my + 18 > H - B ? my - 10 : my + 18;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="残高の推移。最低は${fmt(sim.min.date)}の${yen(sim.min.balance)}円">
    ${ticks.map(v => `<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ch-ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${man(v)}</text>`).join('')}
    ${months.map(m => `<line class="ch-grid dash" x1="${x(m.getTime())}" x2="${x(m.getTime())}" y1="${T}" y2="${H - B}"/><text class="ch-ax" x="${x(m.getTime()) + 4}" y="${H - 10}">${m.getMonth() === 0 ? m.getFullYear() + '/' : ''}${m.getMonth() + 1}月</text>`).join('')}
    <path class="ch-area" d="${area}"/>
    ${safe > lo && safe < hi ? `<line class="ch-safe" x1="${L}" x2="${W - R}" y1="${y(safe)}" y2="${y(safe)}"/><text class="ch-ax" x="${W - R}" y="${y(safe) - 5}" text-anchor="end">安全ライン ${man(safe)}</text>` : ''}
    ${lo < 0 ? `<line class="ch-zero" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>` : ''}
    <path class="ch-line" d="${d}"/>
    <rect class="ch-min" x="${mx - 4.5}" y="${my - 4.5}" width="9" height="9"/>
    <text class="ch-lbl" x="${right ? mx - 10 : mx + 10}" y="${ly}" text-anchor="${right ? 'end' : 'start'}">最低 ${yen(sim.min.balance)}円（${fmtMD(sim.min.date)}）</text>
  </svg></div>`;
}

function viewOverview(sim) {
  const hint = (!S.base.balance && !S.bills.length)
    ? `<div class="hint"><strong>はじめに</strong>「設定」で今の口座残高を、「カード・請求」で確定している請求を入力してください。バイトの時給と労働時間は「バイト」で変えられます。</div>` : '';
  const ledger = [
    `<tr class="base"><td class="d">${fmt(sim.start)}</td><td>基準日の残高</td><td></td><td></td><td class="n">${yen(S.base.balance)}</td></tr>`,
    ...sim.rows.map((r, i) => `<tr class="${i === sim.min.index ? 'min' : ''}">
      <td class="d">${fmt(r.date)}</td>
      <td>${esc(r.label)}<small>${esc([cardName(r.card), KIND[r.kind]].filter(Boolean).join(' · '))}</small></td>
      <td class="n">${r.amount < 0 ? yen(-r.amount) : ''}</td>
      <td class="n">${r.amount > 0 ? yen(r.amount) : ''}</td>
      <td class="n bal${r.balance < 0 ? ' neg' : ''}">${yen(r.balance)}</td></tr>`),
  ].join('');
  return `${hint}
  <section class="block"><div class="head"><h2>残高の推移</h2></div>${chart(sim)}</section>
  <section class="block"><div class="head"><h2>月ごとの集計</h2></div>
    <div class="tablewrap"><table>
      <thead><tr><th>月</th><th class="r">収入</th><th class="r">支出</th><th class="r">月内の最低</th><th class="r">月末の残高</th></tr></thead>
      <tbody>${sim.monthly.map(m => `<tr><td>${fmtYM(m.month)}</td><td class="n">${yen(m.income)}</td><td class="n">${yen(m.outflow)}</td><td class="n${m.low < 0 ? ' neg' : ''}">${yen(m.low)}</td><td class="n strong">${yen(m.endBalance)}</td></tr>`).join('')}</tbody>
    </table></div></section>
  <section class="block"><div class="head"><h2>入出金の明細</h2><button type="button" class="btn" data-act="csv">CSVで書き出す</button></div>
    <div class="tablewrap"><table class="ledger">
      <thead><tr><th>日付</th><th>内容</th><th class="r">出金</th><th class="r">入金</th><th class="r">残高</th></tr></thead>
      <tbody>${ledger}</tbody></table></div>
    <p class="note">網掛けの行が最低残高です。同じ日に入金と出金がある場合は、出金を先に計算します。土日祝で引き落とし日がずれる分は反映していません。</p>
  </section>`;
}

/* ---------- バイト ---------- */
const SRC = { recorded: '記録', planned: '予定', default: '標準' };

function logSection(sim) {
  const logs = S.job.logs;
  const totals = M.logTotals(S.job);
  const groups = new Map();
  for (const l of [...logs].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const d = M.parseDate(l.date); if (!d) continue;
    const k = M.ym(M.closingMonth(d, S.job.close));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const t = today();
  const curK = M.ym(M.closingMonth(t, S.job.close));
  const cur = M.parseDate(curK + '-01');
  const curH = M.monthHours(S.job, cur, totals);
  const w = M.jobWindow(cur, S.job);
  const keys = [...groups.keys()];
  const block = (k, i) => {
    const cm = M.parseDate(k + '-01'), tot = totals.get(k) || { hours: 0, days: 0 };
    const win = M.jobWindow(cm, S.job);
    const body = `<div class="tablewrap"><table class="logs">
      <thead><tr><th>日付</th><th class="r">時間</th><th>メモ</th><th></th></tr></thead>
      <tbody>${groups.get(k).map(l => `<tr>
        <td>${cell('logs', l, 'date', `type="date" value="${esc(l.date)}"`)}</td>
        <td class="n">${cellNum('logs', l, 'hours', 'min="0" step="0.25"')}</td>
        <td>${cellText('logs', l, 'memo', '')}</td>
        <td>${delBtn('logs', l, `${l.date} の記録`)}</td></tr>`).join('')}</tbody></table></div>`;
    const summary = `<span class="lg-m">${fmtYM(cm)}分</span><span class="lg-r">${fmtMD(win.start)}〜${fmtMD(win.end)}</span><span class="n lg-t">${hrs(tot.hours)} / ${tot.days}日</span>`;
    return `<details class="lg"${i < 2 ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;
  };
  return `<section class="block"><div class="head"><h2>勤務時間の記録</h2><span class="sub-h">今月（${fmtMD(w.start)}〜${fmtMD(w.end)}）${hrs(curH.recorded)} / 予定 ${hrs(curH.planned)}</span></div>
    <form id="log-form" class="logform" autocomplete="off">
      <label class="field" for="log-date"><span>日付</span><input id="log-date" type="date" data-draft="date" value="${esc(logDraft.date || M.iso(t))}" required></label>
      <label class="field" for="log-hours"><span>時間<em>h</em></span><input id="log-hours" type="number" inputmode="decimal" min="0.25" step="0.25" data-draft="hours" value="${esc(logDraft.hours)}" placeholder="例：4.5" required></label>
      <label class="field grow" for="log-memo"><span>メモ（任意）</span><input id="log-memo" type="text" data-draft="memo" value="${esc(logDraft.memo)}"></label>
      <div class="field end"><button type="submit" class="btn primary">記録する</button></div>
    </form>
    <p class="note">働いた日に、その日の労働時間だけを記録します（休憩を除いた時間。30分は 0.5）。休んだ日は何も入れなくて大丈夫です。</p>
    ${keys.length ? keys.map(block).join('') : '<p class="empty-line">まだ記録がありません。</p>'}
  </section>`;
}

function onAddLog(form) {
  const date = form.querySelector('#log-date').value;
  const hours = Number(form.querySelector('#log-hours').value);
  if (!date || !(hours > 0)) return;
  S.job.logs.push({ id: uid(), date, hours, memo: form.querySelector('#log-memo').value.trim() });
  // 次の入力に備えて日付を1日進め、時間は前回の値を残す
  const next = M.addDays(M.parseDate(date), 1);
  logDraft = { date: M.iso(next), hours: String(hours), memo: '' };
  scheduleSave(); rerender();
  document.getElementById('log-hours')?.focus();
}

function viewJob(sim) {
  const pays = M.jobPayments(S.job, sim.start, sim.end);
  const years = M.yearTotals(S, sim.start, sim.end);
  const wall = +S.job.wall || 0;
  return `
  <section class="block"><div class="head"><h2>時給と給料日</h2></div>
    <div class="fields">
      ${fieldNum('job.wage', '時給', { unit: '円', min: 0 })}
      ${fieldNum('job.hours', '標準の労働時間（月）', { unit: '時間', min: 0, step: 0.25 })}
      ${fieldNum('job.close', '締め日', { min: 1, max: 31, note: '31 = 月末締め' })}
      ${fieldNum('job.pay', '給料日', { min: 1, max: 31 })}
      ${fieldSelect('job.offset', '支給月', OFFSETS, { note: '締めた月から数えて' })}
      ${fieldNum('job.dedPct', '控除率', { unit: '%', min: 0, max: 100, step: 0.1, note: '所得税などの天引き' })}
      ${fieldNum('job.transport', '交通費・定額手当（月）', { unit: '円', min: 0 })}
    </div>
    <p class="formula">支給額 ＝ 時給 × 労働時間 × (1 − 控除率) ＋ 交通費・手当 ＋ その月の追加分</p>
  </section>
${logSection(sim)}
  <section class="block"><div class="head"><h2>月ごとの労働時間</h2></div>
    <div class="tablewrap"><table>
      <thead><tr><th>勤務月（締め月）</th><th class="r">予定</th><th class="r">記録</th><th class="r">計算に使う時間</th><th class="r">追加の手当</th><th class="r">支給額</th><th>支給日</th></tr></thead>
      <tbody>${pays.map(p => { const k = M.ym(p.cm); const m = S.job.months[k] || {}; return `<tr class="${p.custom ? '' : 'auto'}">
        <td>${fmtYM(p.cm)}</td>
        <td class="n"><input id="jh-${k}" class="cell num" type="number" inputmode="decimal" min="0" step="0.25" data-month="${k}" data-mf="hours" value="${m.hours ?? ''}" placeholder="${esc(S.job.hours)}" aria-label="${fmtYM(p.cm)}の予定の労働時間"></td>
        <td class="n">${p.recorded ? `${hrs(p.recorded)}<small>${p.days}日</small>` : '—'}</td>
        <td class="n strong">${hrs(p.hours)}<small>${SRC[p.source]}</small></td>
        <td class="n"><input id="je-${k}" class="cell num" type="number" inputmode="decimal" data-month="${k}" data-mf="extra" value="${m.extra ?? ''}" placeholder="0" aria-label="${fmtYM(p.cm)}の追加の手当"></td>
        <td class="n strong">${yen(p.amount)}</td><td class="d">${fmt(p.pay)}</td></tr>`; }).join('')}</tbody>
    </table></div>
    <p class="note">記録がある月は、記録した時間の合計で計算します（予定より少なくても多くても）。記録がない月は標準の労働時間で計算します。休みが分かっている月など、記録がない月の見込みだけ変えたいときは「予定」に入れてください。</p>
  </section>
  <section class="block"><div class="head"><h2>年間の給与収入</h2></div>
    <div class="fields">
      ${fieldNum('job.paidThisYear', `${sim.start.getFullYear()}年にすでに受け取った額`, { unit: '円', min: 0, note: '基準日までの支給分（控除前）' })}
      ${fieldNum('job.wall', '年収の上限の目安', { unit: '円', min: 0, note: '扶養などの基準。自分の条件で確認して設定' })}
    </div>
    <div class="years">${years.map(r => {
      const pct = wall ? r.total / wall * 100 : 0;
      return `<div class="year"><div class="year-head"><strong>${r.year}年</strong><span class="n">${yen(r.total)}円${wall ? ` / ${yen(wall)}円` : ''}</span>${wall ? (r.total > wall ? chip(['bad', '上限を超える見込み']) : chip(pct > 90 ? ['warn', `残り${yen(wall - r.total)}円`] : ['ok', `残り${yen(wall - r.total)}円`])) : ''}</div>
        ${wall ? `<svg class="meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="m-bg" width="100" height="6"/><rect class="m-fill" width="${Math.min(100, pct).toFixed(2)}" height="6"/></svg>` : ''}
        <small>受け取り済み ${yen(r.paid)}円 ＋ 計算期間内の見込み ${yen(r.forecast)}円</small></div>`;
    }).join('')}</div>
    <p class="note">支給日の年で集計し、交通費は含めません。計算期間の外の月は入っていないので、年末までを見るなら「設定」で計算する月数を増やしてください。</p>
  </section>`;
}

/* ---------- カード・請求 ---------- */
function viewCards(sim) {
  const base = sim.start;
  const bills = [...S.bills].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return `
  <section class="block"><div class="head"><h2>カード</h2><button type="button" class="btn" data-act="add" data-list="cards">＋ カードを追加</button></div>
    <div class="tablewrap"><table>
      <thead><tr><th>名前</th><th class="r">締め日</th><th class="r">支払日</th><th>支払月</th><th>次の引き落とし</th><th></th></tr></thead>
      <tbody>${S.cards.map(c => `<tr>
        <td>${cellText('cards', c, 'name')}</td>
        <td class="n">${cellNum('cards', c, 'close', 'min="1" max="31"')}</td>
        <td class="n">${cellNum('cards', c, 'pay', 'min="1" max="31"')}</td>
        <td><select id="cards-${c.id}-offset" class="cell" data-list="cards" data-id="${c.id}" data-f="offset" data-type="num">${OFFSETS.map(([k, l]) => `<option value="${k}"${k == (c.offset ?? 1) ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td class="d">${fmt(M.nextPayDate(c, base))}</td>
        <td>${delBtn('cards', c, c.name)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="note">締め日に 31 を入れると月末締めになります。カードの削除は × を2回押します。</p>
  </section>
  <section class="block"><div class="head"><h2>確定した請求</h2><button type="button" class="btn" data-act="add" data-list="bills">＋ 請求を追加</button></div>
    <div class="tablewrap"><table>
      <thead><tr><th>カード</th><th>引き落とし日</th><th class="r">請求額</th><th>メモ</th><th></th></tr></thead>
      <tbody>${bills.length ? bills.map(b => { const d = M.parseDate(b.date); const past = d && d <= base; return `<tr class="${past ? 'past' : ''}">
        <td><select id="bills-${b.id}-card" class="cell" data-list="bills" data-id="${b.id}" data-f="card">${cardOptions(b.card)}</select></td>
        <td>${cell('bills', b, 'date', `type="date" value="${esc(b.date)}"`)}${past ? '<small>基準日以前なので計算に入りません</small>' : ''}</td>
        <td class="n">${cellNum('bills', b, 'amount', 'min="0"')}</td>
        <td>${cellText('bills', b, 'memo', '例：11月分')}</td>
        <td>${delBtn('bills', b, '請求')}</td></tr>`; }).join('')
        : `<tr><td colspan="5" class="empty">まだありません。カードの明細で金額が確定したら追加してください。</td></tr>`}</tbody>
    </table></div>
    <p class="note">同じカード・同じ月に確定した請求があると、その月の「毎月の見込み」は使わずに確定額で計算します。大きい買い物の分も含んだ請求額を入れたときは、「大きい買い物」からその買い物を消してください。</p>
  </section>
  <section class="block"><div class="head"><h2>毎月の見込み</h2><button type="button" class="btn" data-act="add" data-list="recurring">＋ 見込みを追加</button></div>
    <div class="tablewrap"><table>
      <thead><tr><th>カード</th><th class="r">金額（月）</th><th>開始月</th><th>終了月</th><th>メモ</th><th></th></tr></thead>
      <tbody>${S.recurring.length ? S.recurring.map(r => `<tr>
        <td><select id="recurring-${r.id}-card" class="cell" data-list="recurring" data-id="${r.id}" data-f="card">${cardOptions(r.card)}</select></td>
        <td class="n">${cellNum('recurring', r, 'amount', 'min="0"')}</td>
        <td>${cell('recurring', r, 'from', `type="month" value="${esc(r.from)}"`)}</td>
        <td>${cell('recurring', r, 'to', `type="month" value="${esc(r.to)}"`)}</td>
        <td>${cellText('recurring', r, 'memo', '例：固定費、食費')}</td>
        <td>${delBtn('recurring', r, '見込み')}</td></tr>`).join('')
        : `<tr><td colspan="6" class="empty">固定費や、毎月だいたいこのくらい使う額を入れておくと、先の月まで予測できます。</td></tr>`}</tbody>
    </table></div>
    <p class="note">開始月・終了月は引き落としの月です。終了月が空欄なら計算期間の最後まで続きます。</p>
  </section>`;
}

/* ---------- 大きい買い物 ---------- */
function compareHTML() {
  const amount = +cmp.amount || 0;
  if (!amount) return '<p class="note">金額を入れると、カードと支払日の組み合わせごとに最低残高を比べます。</p>';
  if (!S.cards.length) return '<p class="note">先に「カード・請求」でカードを登録してください。</p>';
  const spec = { label: cmp.label || '買い物', amount, count: +cmp.count || 1, feePct: +cmp.feePct || 0 };
  const res = M.compare(S, spec, purchaseFrom(), 4);
  const ok = res.filter(r => !r.outOfRange);
  const best = ok.length ? ok.reduce((a, b) => (b.min.balance > a.min.balance ? b : a)) : null;
  return `<div class="tablewrap"><table>
    <thead><tr><th>カード</th><th>引き落とし日</th><th>この期間に買う</th><th class="r">最低残高</th><th>判定</th><th></th></tr></thead>
    <tbody>${res.map(r => `<tr class="${r === best ? 'best' : ''}${r.outOfRange ? ' past' : ''}">
      <td>${esc(r.card.name)}</td>
      <td class="d">${fmt(r.payDate)}${spec.count > 1 ? `<small>から${spec.count}回</small>` : ''}</td>
      <td class="d">${fmtMD(r.start)} 〜 ${fmtMD(r.end)}</td>
      <td class="n">${r.outOfRange ? '—' : `${yen(r.min.balance)}<small>${fmt(r.min.date)}</small>`}</td>
      <td>${r.outOfRange ? '<span class="chip">計算期間外</span>' : r === best ? '<span class="chip ok solid">最も余裕あり</span>' : chip(judge(r.min))}</td>
      <td><button type="button" class="btn small" data-act="adopt" data-card="${r.card.id}" data-pay="${M.iso(r.payDate)}">予定に追加</button></td></tr>`).join('')}</tbody>
  </table></div>
  <p class="note">「この期間に買う」の間に買うと、その引き落とし日になります。計算期間外の行を比べたいときは「設定」で計算する月数を増やしてください。</p>`;
}
function paintCompare() { const el = document.getElementById('cmp-results'); if (el) el.innerHTML = compareHTML(); }

function viewBuy() {
  const from = purchaseFrom();
  const rows = S.purchases.map(p => {
    const card = S.cards.find(c => c.id === p.card);
    const opts = card ? M.payOptions(card, from, 6) : [];
    const sel = M.parseDate(p.payDate);
    if (sel && !opts.some(o => M.iso(o.payDate) === p.payDate) && card) {
      const w = M.windowForPay(sel, card);
      opts.unshift({ payDate: sel, start: w.start, end: w.end, gone: w.end < from });
    }
    const cur = opts.find(o => M.iso(o.payDate) === p.payDate);
    return `<tr>
      <td>${cellText('purchases', p, 'label', '品名')}</td>
      <td class="n">${cellNum('purchases', p, 'amount', 'min="0"')}</td>
      <td><select id="purchases-${p.id}-card" class="cell" data-list="purchases" data-id="${p.id}" data-f="card">${cardOptions(p.card)}</select></td>
      <td><select id="purchases-${p.id}-payDate" class="cell" data-list="purchases" data-id="${p.id}" data-f="payDate">
        ${opts.map(o => `<option value="${M.iso(o.payDate)}"${M.iso(o.payDate) === p.payDate ? ' selected' : ''}>${fmt(o.payDate)}${o.gone ? '（購入済み/期間終了）' : ''}</option>`).join('')}</select></td>
      <td class="d">${cur ? `${fmtMD(cur.start)} 〜 ${fmtMD(cur.end)}` : '—'}</td>
      <td><select id="purchases-${p.id}-count" class="cell" data-list="purchases" data-id="${p.id}" data-f="count" data-type="num">${COUNTS.map(n => `<option value="${n}"${n == p.count ? ' selected' : ''}>${n === 1 ? '一括' : n + '回'}</option>`).join('')}</select></td>
      <td class="n">${cellNum('purchases', p, 'feePct', 'min="0" step="0.1"')}</td>
      <td>${delBtn('purchases', p, p.label || '買い物')}</td></tr>`;
  }).join('');
  return `
  <section class="block"><div class="head"><h2>どのカードで、いつ払うか比べる</h2></div>
    <div class="fields">
      <label class="field" for="cmp-label"><span>品名</span><input id="cmp-label" type="text" data-cmp="label" value="${esc(cmp.label)}" placeholder="例：トラッカー"></label>
      <label class="field" for="cmp-amount"><span>金額<em>円</em></span><input id="cmp-amount" type="number" inputmode="numeric" min="0" data-cmp="amount" data-type="num" value="${esc(cmp.amount)}"></label>
      <label class="field" for="cmp-count"><span>支払回数</span><select id="cmp-count" data-cmp="count" data-type="num">${COUNTS.map(n => `<option value="${n}"${n == cmp.count ? ' selected' : ''}>${n === 1 ? '一括' : n + '回'}</option>`).join('')}</select></label>
      <label class="field" for="cmp-fee"><span>分割手数料（合計）<em>%</em></span><input id="cmp-fee" type="number" inputmode="decimal" min="0" step="0.1" data-cmp="feePct" data-type="num" value="${esc(cmp.feePct)}"><small>一括なら 0</small></label>
    </div>
    <div id="cmp-results">${compareHTML()}</div>
  </section>
  <section class="block"><div class="head"><h2>予定している買い物</h2><button type="button" class="btn" data-act="add" data-list="purchases">＋ 買い物を追加</button></div>
    <div class="tablewrap"><table>
      <thead><tr><th>品名</th><th class="r">金額</th><th>カード</th><th>引き落とし日</th><th>この期間に買う</th><th>回数</th><th class="r">手数料%</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="empty">上の比較で「予定に追加」を押すか、「＋ 買い物を追加」から入力します。</td></tr>'}</tbody>
    </table></div>
    <p class="note">引き落とし日を選ぶと、その日に払うために買う期間が出ます。分割払いは毎月の支払日に均等に引き落とし、端数は初回に足します。</p>
  </section>`;
}

/* ---------- 設定 ---------- */
function viewSettings() {
  const f = k => flash[k] ? `<p class="msg" role="status">${esc(flash[k])}</p>` : '';
  return `
  <section class="block"><div class="head"><h2>口座と計算期間</h2></div>
    <div class="fields">
      <label class="field" for="f-base-date"><span>基準日</span><input id="f-base-date" type="date" data-bind="base.date" value="${esc(S.base.date)}"><small>この日の引き落とし後の残高を入れます</small></label>
      ${fieldNum('base.balance', '基準日の口座残高', { unit: '円' })}
      ${fieldNum('base.months', '計算する月数', { min: 1, max: 36, note: '基準日の月から数えて（最大36）' })}
      ${fieldNum('base.safe', '安全ライン', { unit: '円', min: 0, note: 'これを下回る日があると警告します' })}
    </div>
  </section>
  <section class="block"><div class="head"><h2>ロック</h2></div>
    <div class="fields">
      ${fieldNum('prefs.lockMin', '自動でロックするまで', { unit: '分', min: 0, max: 120, note: '0 にすると自動ロックしません' })}
    </div>
    <form id="pw-form" class="fields" autocomplete="off">
      <input type="text" name="username" autocomplete="username" value="cashflow" hidden>
      <label class="field" for="pw-cur"><span>今のパスワード</span><input id="pw-cur" type="password" autocomplete="current-password" required></label>
      <label class="field" for="pw-new"><span>新しいパスワード</span><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field" for="pw-new2"><span>新しいパスワード（確認）</span><input id="pw-new2" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="field end"><button type="submit" class="btn">パスワードを変更</button></div>
    </form>${f('pw')}
  </section>
  <section class="block"><div class="head"><h2>バックアップ</h2></div>
    <p class="note">データはこの端末のブラウザにだけあります。ブラウザのデータを消すと失われるので、ときどき書き出してください。書き出したファイルは暗号化されたままで、読み込むときは作ったときのパスワードが必要です。</p>
    <div class="actions">
      <button type="button" class="btn" data-act="backup">暗号化バックアップを書き出す</button>
      <label class="btn file" for="import-file">バックアップを読み込む<input id="import-file" type="file" accept="application/json,.json"></label>
    </div>
    ${pendingImport ? `<form id="import-form" class="fields">
      <label class="field" for="imp-pw"><span>バックアップのパスワード</span><input id="imp-pw" type="password" autocomplete="off" required></label>
      <div class="field end actions"><button type="submit" class="btn primary">読み込んで置き換える</button><button type="button" class="btn" data-act="cancel-import">やめる</button></div>
      <p class="note">今のデータはバックアップの内容で置き換わります。パスワードは今のものがそのまま使われます。</p>
    </form>` : ''}${f('backup')}
  </section>
  <section class="block"><div class="head"><h2>データの削除</h2></div>
    <p class="note">この端末に保存した暗号化データを消して、最初の画面に戻ります。元には戻せません。</p>
    <button type="button" class="btn${confirmKey === 'wipe' ? ' danger' : ''}" data-act="wipe">${confirmKey === 'wipe' ? 'もう一度押すと全て消します' : 'すべてのデータを消す'}</button>
  </section>
  <section class="block"><div class="head"><h2>このアプリの安全性</h2></div>
    <ul class="facts">
      <li>入力したデータはサーバーに送りません。GitHub Pages から届くのは画面のプログラムだけです。</li>
      <li>データは PBKDF2（SHA-256、${V.ITERATIONS.toLocaleString()}回）でパスワードから作った鍵で、AES-256-GCM で暗号化してから保存します。パスワードそのものは保存しません。</li>
      <li>ロック中やブラウザを閉じた後は、暗号化されたデータしか残りません。</li>
      <li>外部のスクリプトやフォントは読み込まず、通信もしない設定（CSP）にしています。</li>
      <li>CSV の書き出しは暗号化されません。取り扱いに注意してください。</li>
    </ul>
  </section>`;
}

/* ---------- 入力の反映 ---------- */
function applyInput(t) {
  const isNum = t.dataset.type === 'num';
  const v = isNum ? (t.value === '' ? 0 : Number(t.value)) : t.value;
  if (t.dataset.bind) { setPath(S, t.dataset.bind, v); return true; }
  if (t.dataset.list) {
    const it = listOf(t.dataset.list).find(x => x.id === t.dataset.id);
    if (!it) return false;
    it[t.dataset.f] = v;
    if (t.dataset.list === 'purchases' && t.dataset.f === 'card') {
      const card = S.cards.find(c => c.id === v);
      if (card) it.payDate = M.iso(M.payOptions(card, purchaseFrom(), 1)[0].payDate);
    }
    return true;
  }
  if (t.dataset.month) {
    const k = t.dataset.month, f = t.dataset.mf;
    const m = { ...(S.job.months[k] || {}) };
    if (t.value === '') delete m[f]; else m[f] = Number(t.value);
    if (Object.keys(m).length) S.job.months[k] = m; else delete S.job.months[k];
    return true;
  }
  if (t.dataset.cmp) { cmp[t.dataset.cmp] = v; paintCompare(); }
  if (t.dataset.draft) logDraft[t.dataset.draft] = t.value;
  return false;
}

function addItem(list) {
  const base = M.parseDate(S.base.date) || today();
  const c0 = S.cards[0];
  const id = uid();
  if (list === 'cards') S.cards.push({ id, name: '新しいカード', close: 15, pay: 10, offset: 1 });
  if (list === 'bills') S.bills.push({ id, card: c0?.id || '', date: M.iso(c0 ? M.nextPayDate(c0, base) : base), amount: 0, memo: '' });
  if (list === 'recurring') S.recurring.push({ id, card: c0?.id || '', amount: 0, from: M.ym(M.addDays(base, 1)), to: '', memo: '' });
  if (list === 'purchases') S.purchases.push({ id, label: '', amount: 0, card: c0?.id || '', payDate: c0 ? M.iso(M.payOptions(c0, purchaseFrom(), 1)[0].payDate) : '', count: 1, feePct: 0 });
  return id;
}

function arm(key) {
  confirmKey = key;
  setTimeout(() => { if (confirmKey === key) { confirmKey = null; S ? rerender() : renderLock(); } }, 4000);
}

async function wipe() {
  try { localStorage.removeItem(VAULT_KEY); } catch { /* */ }
  clearTimeout(saveTimer); saveTimer = null;
  session = null; S = null; confirmKey = null; saveState = '';
  renderLock('データを消しました。新しいパスワードを決めてください。');
}

function toCSV(sim) {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['日付', '内容', 'カード', '種類', '出金', '入金', '残高'], [M.iso(sim.start), '基準日の残高', '', '', '', '', S.base.balance]];
  for (const r of sim.rows) lines.push([M.iso(r.date), r.label, cardName(r.card), KIND[r.kind], r.amount < 0 ? -r.amount : '', r.amount > 0 ? r.amount : '', r.balance]);
  return '﻿' + lines.map(l => l.map(q).join(',')).join('\r\n');
}

async function onChangePassword(form) {
  const cur = form.querySelector('#pw-cur').value, n1 = form.querySelector('#pw-new').value, n2 = form.querySelector('#pw-new2').value;
  if (n1.length < 8) { flash.pw = '新しいパスワードは8文字以上にしてください。'; return rerender(); }
  if (n1 !== n2) { flash.pw = '確認用のパスワードが一致しません。'; return rerender(); }
  flash.pw = '確認中…'; rerender();
  try { await saveNow(); await V.open(readVault(), cur); }
  catch { flash.pw = '今のパスワードが違います。'; return rerender(); }
  session = await V.create(n1);
  await saveNow();
  flash.pw = 'パスワードを変更しました。以前のバックアップを読み込むときは、そのとき使っていたパスワードが必要です。';
  rerender();
}

async function onImportFile(input) {
  const file = input.files?.[0]; if (!file) return;
  try {
    const v = JSON.parse(await file.text());
    if (v.format !== 'cashflow-vault') throw new Error();
    pendingImport = v; flash.backup = '';
  } catch { pendingImport = null; flash.backup = 'このアプリのバックアップファイルではありません。'; }
  input.value = '';
  rerender();
  document.getElementById('imp-pw')?.focus();
}
async function onImportSubmit(form) {
  const pw = form.querySelector('#imp-pw').value;
  try {
    const r = await V.open(pendingImport, pw);
    S = migrate(r.data); pendingImport = null;
    await saveNow();
    flash.backup = 'バックアップを読み込みました。';
  } catch { flash.backup = 'バックアップのパスワードが違います。'; }
  rerender();
}

/* ---------- イベント ---------- */
app.addEventListener('input', e => {
  const t = e.target;
  if (!S || !t.matches('input,select') || t.type === 'file' || t.type === 'password' || t.closest('#pw-form,#import-form')) return;
  if (applyInput(t)) { scheduleSave(); paintStatus(M.simulate(S)); }
});
app.addEventListener('change', e => {
  const t = e.target;
  if (!S) return;
  if (t.id === 'import-file') return onImportFile(t);
  if (t.matches('[data-bind],[data-list],[data-month]')) setTimeout(rerender, 0);
});
app.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'lock-form') onLockSubmit(f);
  else if (f.id === 'pw-form') onChangePassword(f);
  else if (f.id === 'import-form') onImportSubmit(f);
  else if (f.id === 'log-form') onAddLog(f);
});
app.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) {
    tab = b.dataset.tab; confirmKey = null;
    document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-current', x.dataset.tab === tab ? 'page' : 'false'));
    renderPage(); scrollTo({ top: 0 });
    return;
  }
  const act = b.dataset.act; if (!act) return;
  if (act === 'wipe') { if (confirmKey === 'wipe') return wipe(); arm('wipe'); return S ? rerender() : renderLock(); }
  if (!S) return;
  if (act === 'lock') return lock();
  if (act === 'add') {
    const id = addItem(b.dataset.list); scheduleSave(); renderPage();
    const first = document.querySelector(`[data-id="${id}"]:is(input[type=text],input[type=number])`) || document.querySelector(`[data-id="${id}"]`);
    first?.focus();
    return;
  }
  if (act === 'del') {
    const key = `del:${b.dataset.id}`;
    if (b.dataset.list === 'cards' && confirmKey !== key) { arm(key); return rerender(); }
    const arr = listOf(b.dataset.list), i = arr.findIndex(x => x.id === b.dataset.id);
    if (i >= 0) arr.splice(i, 1);
    confirmKey = null; scheduleSave(); return rerender();
  }
  if (act === 'adopt') {
    S.purchases.push({ id: uid(), label: cmp.label || '買い物', amount: +cmp.amount || 0, card: b.dataset.card, payDate: b.dataset.pay, count: +cmp.count || 1, feePct: +cmp.feePct || 0 });
    scheduleSave(); rerender();
    return;
  }
  if (act === 'csv') return download(`cashflow-${stamp()}.csv`, toCSV(M.simulate(S)), 'text/csv;charset=utf-8');
  if (act === 'backup') { await saveNow(); flash.backup = 'バックアップを書き出しました。'; download(`cashflow-backup-${stamp()}.json`, localStorage.getItem(VAULT_KEY), 'application/json'); return rerender(); }
  if (act === 'cancel-import') { pendingImport = null; return rerender(); }
});

if (!window.isSecureContext || !crypto.subtle) {
  app.innerHTML = '<div class="lock"><div class="lock-box"><h1>キャッシュフロー</h1><p class="msg">暗号化機能が使えないため起動できません。https:// のアドレス（GitHub Pages）で開いてください。</p></div></div>';
} else {
  renderLock();
}
