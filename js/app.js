import * as M from './model.js';
import * as V from './crypto.js';
import * as Sync from './sync.js';

const VAULT_KEY = 'cashflow.vault.v1';
const SYNC_KEY = 'cashflow.sync.v1';     // 同期先とトークン（暗号化）
const SHA_KEY = 'cashflow.sync.sha';     // 最後に同期した版
const DIRTY_KEY = 'cashflow.sync.dirty'; // 未同期の変更があるか
const app = document.getElementById('app');

/* ---------- 小道具 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n || 0)).toLocaleString('ja-JP');
const fmt = d => d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : '—';
const fmtMD = d => `${d.getMonth() + 1}/${d.getDate()}`;
const fmtYM = d => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const uid = () => crypto.randomUUID().slice(0, 8);
const KIND = { income: '収入', bill: '確定した請求', recurring: '毎月の見込み', purchase: '大きい買い物', loan: 'ローン' };
const OFFSETS = [[0, '当月'], [1, '翌月'], [2, '翌々月']];
const COUNTS = [1, 2, 3, 5, 6, 10, 12, 24];

function getPath(o, p) { return p.split('.').reduce((a, k) => a?.[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};
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
const listOf = name => S[name];
let calMonth = null, selDate = null, lastTimes = { start: '17:00', end: '22:00' };
let syncCfg = null, syncBusy = false, pushTimer = null, remoteHold = null, saveRev = 0;
const sync = { status: 'off', msg: '', at: null };
const hrs = h => `${(Math.round((+h || 0) * 100) / 100).toLocaleString('ja-JP')}h`;

function seed() {
  return {
    v: 1,
    base: { date: M.iso(today()), balance: 0, months: 6, safe: 30000 },
    job: { wage: 1100, hours: 55, close: 31, pay: 15, offset: 1, dedPct: 0, transport: 0, paidThisYear: 0, wall: 1230000, months: {}, shifts: [], rules: { ...M.DEFAULT_RULES } },
    cards: [
      { id: uid(), name: 'メインカード', close: 15, pay: 13, offset: 1 },
      { id: uid(), name: '固定費カード', close: 31, pay: 26, offset: 1 },
      { id: uid(), name: 'その他カード', close: 5, pay: 4, offset: 1 },
    ],
    bills: [], recurring: [], purchases: [], loans: [],
    prefs: { lockMin: 5 },
  };
}
function migrate(d) {
  const s = seed();
  const o = { ...s, ...d, v: 1 };
  o.base = { ...s.base, ...(d.base || {}) };
  o.job = { ...s.job, ...(d.job || {}) };
  o.job.months = o.job.months || {};
  o.job.shifts = Array.isArray(o.job.shifts) ? o.job.shifts : [];
  o.job.rules = { ...M.DEFAULT_RULES, ...(o.job.rules || {}) };
  delete o.job.logs;
  o.prefs = { ...s.prefs, ...(d.prefs || {}) };
  for (const k of ['cards', 'bills', 'recurring', 'purchases', 'loans']) o[k] = Array.isArray(d[k]) ? d[k] : s[k];
  return o;
}

/* ---------- 保存（毎回暗号化） ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveState = '保存中…'; paintSave();
  saveTimer = setTimeout(saveNow, 300);
}
async function saveNow({ fromRemote = false } = {}) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!session || !S) return;
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(await V.seal(session.key, session.kdf, S)));
    const n = new Date();
    saveState = `暗号化して保存 ${M.pad(n.getHours())}:${M.pad(n.getMinutes())}`;
    if (syncCfg && !fromRemote) { saveRev++; ls.set(DIRTY_KEY, '1'); schedulePush(); }
  } catch {
    saveState = '保存できませんでした。ブラウザのサイトデータ設定を確認してください';
  }
  paintSave();
}
const hm = d => `${M.pad(d.getHours())}:${M.pad(d.getMinutes())}`;
const SYNC_LABEL = {
  syncing: () => '同期中…',
  idle: () => (sync.at ? `同期済み ${hm(sync.at)}` : '同期済み'),
  offline: () => 'オフライン（あとで同期）',
  error: () => '同期エラー',
  conflict: () => '同期：確認が必要',
  needpw: () => '同期：パスワードが必要',
};
function paintSave() {
  const el = document.getElementById('save-state');
  if (!el) return;
  el.textContent = syncCfg && SYNC_LABEL[sync.status] ? SYNC_LABEL[sync.status]() : saveState;
  const st = document.getElementById('sync-state');
  if (st) st.textContent = syncCfg ? (SYNC_LABEL[sync.status] ? SYNC_LABEL[sync.status]() : '') : 'オフ';
}

/* ---------- 端末間の同期 ---------- */
async function loadSyncCfg() {
  const raw = ls.get(SYNC_KEY);
  syncCfg = null; sync.status = 'off';
  if (!raw) return;
  try { syncCfg = await V.openWithKey(JSON.parse(raw), session.key); sync.status = 'idle'; } catch { /* 鍵が違う */ }
}
async function storeSyncCfg() {
  if (syncCfg) ls.set(SYNC_KEY, JSON.stringify(await V.seal(session.key, session.kdf, syncCfg)));
  else ls.del(SYNC_KEY);
}
function setSync(status, msg = '') {
  sync.status = status; sync.msg = msg;
  if (status === 'idle') sync.at = new Date();
  paintSave(); paintSyncBar();
}
function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), 3000); }

async function pushLocal(sha, opt = {}) {
  const rev = saveRev;
  const raw = ls.get(VAULT_KEY);
  if (!raw) return;
  const newSha = await Sync.put(syncCfg, JSON.parse(raw), sha, opt);
  ls.set(SHA_KEY, newSha);
  if (rev === saveRev) ls.set(DIRTY_KEY, '0'); else schedulePush();
  remoteHold = null;
  setSync('idle');
}
async function adoptRemote(remote, data) {
  S = migrate(data);
  ls.set(VAULT_KEY, JSON.stringify(remote.vault));
  ls.set(SHA_KEY, remote.sha); ls.set(DIRTY_KEY, '0');
  remoteHold = null;
  setSync('idle');
  if (document.getElementById('page')) rerender();
}

// 取ってきて比べる → 手元だけ変更：送る / 相手だけ変更：取り込む / 両方：選んでもらう
async function syncNow({ force = false } = {}) {
  if (!syncCfg || !session || !S || syncBusy) return;
  if (!force && (sync.status === 'conflict' || sync.status === 'needpw')) return;
  clearTimeout(pushTimer);
  syncBusy = true; setSync('syncing');
  let retry = false;
  try {
    if (saveTimer) await saveNow();
    const dirty = ls.get(DIRTY_KEY) === '1';
    const lastSha = ls.get(SHA_KEY);
    const remote = await Sync.get(syncCfg);
    if (!remote) await pushLocal(null);
    else if (remote.sha === lastSha) { if (dirty) await pushLocal(remote.sha); else setSync('idle'); }
    else if (remote.vault.kdf?.salt !== session.kdf.salt) {
      remoteHold = remote;
      setSync('needpw', '同期先のデータは別のパスワードで暗号化されています（別の端末でパスワードを変えた場合など）。同期先のパスワードを入力してください。');
    } else {
      const data = await V.openWithKey(remote.vault, session.key);
      if (dirty) { remoteHold = { ...remote, data }; setSync('conflict', 'この端末と別の端末の両方で変更があります。どちらの内容を残すか選んでください。'); }
      else await adoptRemote(remote, data);
    }
  } catch (e) {
    if (e.kind === 'conflict' && !force) retry = true;
    else setSync(e.kind === 'offline' ? 'offline' : 'error', Sync.message(e));
  } finally { syncBusy = false; }
  if (retry) syncNow({ force: true });
}

function paintSyncBar() {
  const el = document.getElementById('syncbar'); if (!el) return;
  const st = sync.status;
  if (!syncCfg || !['conflict', 'needpw', 'error'].includes(st)) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="syncbar-in"><p><strong>同期</strong>${esc(sync.msg)}</p>
    ${st === 'conflict' ? `<div class="actions">
      <button type="button" class="btn" data-act="sync-use-remote">別の端末の内容を使う</button>
      <button type="button" class="btn" data-act="sync-use-local">この端末の内容で上書き</button></div>` : ''}
    ${st === 'needpw' ? `<form id="syncpw-form" class="actions" autocomplete="off">
      <input type="text" name="username" autocomplete="username" value="cashflow" hidden>
      <input id="syncpw" type="password" autocomplete="current-password" placeholder="同期先のパスワード" required aria-label="同期先のパスワード">
      <button type="submit" class="btn primary">開いて使う</button>
      <button type="button" class="btn" data-act="sync-use-local">この端末の内容で上書き</button></form>
      <p class="note">「開いて使う」を選ぶと、この端末でまだ同期していない変更は消えて、パスワードも同期先のものに変わります。</p>` : ''}
    ${st === 'error' ? `<div class="actions"><button type="button" class="btn" data-act="sync-now">もう一度同期</button><button type="button" class="btn" data-act="goto-sync">同期の設定</button></div>` : ''}
  </div>`;
}

/* ---------- ロック ---------- */
async function lock(reason = '') {
  if (saveTimer) await saveNow();
  if (syncCfg && ls.get(DIRTY_KEY) === '1' && sync.status !== 'conflict' && sync.status !== 'needpw')
    await Promise.race([pushLocal(ls.get(SHA_KEY)).catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
  clearTimeout(pushTimer); syncCfg = null; remoteHold = null; sync.status = 'off';
  session = null; S = null; pendingImport = null; confirmKey = null; flash = {};
  renderLock(reason);
}
const idle = () => session && S && S.prefs.lockMin > 0 && Date.now() - lastActive > S.prefs.lockMin * 60000;
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(t => addEventListener(t, () => { lastActive = Date.now(); }, { passive: true }));
setInterval(() => { if (idle()) lock('しばらく操作がなかったのでロックしました。'); }, 15000);
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    if (saveTimer) await saveNow();
    if (syncCfg && ls.get(DIRTY_KEY) === '1' && sync.status === 'idle') pushLocal(ls.get(SHA_KEY), { keepalive: true }).catch(() => {});
  } else if (idle()) lock('しばらく操作がなかったのでロックしました。');
  else syncNow();
});
setInterval(() => { if (session && syncCfg && !document.hidden) syncNow(); }, 45000);
addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

let joinOpen = false;
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
    ${has ? '' : `
    <details class="lock-box join"${joinOpen ? ' open' : ''}>
      <summary>別の端末で使っているデータを読み込む</summary>
      <form id="join-form" class="join-form" autocomplete="off">
        <p class="note">別の端末の「設定 → 端末間の同期」で使っている同期先と、そのパスワードを入れます。</p>
        <div class="fields two">
          <label class="field" for="j-owner"><span>GitHub のユーザー名</span><input id="j-owner" type="text" value="Git-Ayase" required autocapitalize="off" spellcheck="false"></label>
          <label class="field" for="j-repo"><span>リポジトリ名</span><input id="j-repo" type="text" value="finance-sim-data" required autocapitalize="off" spellcheck="false"></label>
        </div>
        <label class="field" for="j-path"><span>ファイル名</span><input id="j-path" type="text" value="cashflow.json" required autocapitalize="off" spellcheck="false"></label>
        <label class="field" for="j-token"><span>アクセストークン</span><input id="j-token" type="password" autocomplete="off" required spellcheck="false"></label>
        <input type="text" name="username" autocomplete="username" value="cashflow" hidden>
        <label class="field" for="j-pw"><span>パスワード</span><input id="j-pw" type="password" autocomplete="current-password" required></label>
        <p class="msg" id="join-msg" role="alert"></p>
        <button class="btn primary" type="submit">読み込む</button>
      </form>
    </details>`}
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
    await loadSyncCfg();
    renderApp();
    syncNow();
  } catch {
    fails++;
    const wait = Math.min(10, fails);
    msg.textContent = `パスワードが違います。${wait}秒後にもう一度入力できます。`;
    await new Promise(r => setTimeout(r, wait * 1000));
    btn.disabled = false; btn.textContent = 'ロックを解除';
    form.querySelector('#pw').select();
  }
}

async function onJoin(form) {
  const v = id => form.querySelector(id).value.trim();
  const msg = form.querySelector('#join-msg');
  const btn = form.querySelector('button[type=submit]');
  const cfg = { owner: v('#j-owner'), repo: v('#j-repo'), path: v('#j-path'), token: v('#j-token') };
  btn.disabled = true; btn.textContent = '読み込み中…'; msg.textContent = '';
  try {
    await Sync.check(cfg);
    const remote = await Sync.get(cfg);
    if (!remote) throw Object.assign(new Error(), { mine: '同期先にまだデータがありません。先に元の端末で同期を設定してください。' });
    let r;
    try { r = await V.open(remote.vault, form.querySelector('#j-pw').value); }
    catch { throw Object.assign(new Error(), { mine: 'パスワードが違います。' }); }
    session = { key: r.key, kdf: r.kdf };
    S = migrate(r.data); lastActive = Date.now();
    ls.set(VAULT_KEY, JSON.stringify(remote.vault));
    syncCfg = cfg; await storeSyncCfg();
    ls.set(SHA_KEY, remote.sha); ls.set(DIRTY_KEY, '0');
    sync.status = 'idle'; sync.at = new Date();
    renderApp();
  } catch (e) {
    msg.textContent = e.mine || Sync.message(e);
    btn.disabled = false; btn.textContent = '読み込む';
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
  <div class="syncbar wrap" id="syncbar" hidden></div>
  <main class="page wrap" id="page"></main>`;
  renderPage();
  paintSyncBar();
  paintSave();
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
const SRC = { shift: 'シフト', planned: '予定', default: '標準' };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS = { work: '通常', off: '休み', early: '早退' };
const shiftOf = date => S.job.shifts.find(s => s.date === date);

function timeField(f, label, val, bound, note = '') {
  return `<label class="field" for="sh-${f}"><span>${label}</span>
    <input id="sh-${f}" class="hm" type="text" inputmode="numeric" autocomplete="off" placeholder="17:00" value="${esc(val)}" ${bound ? `data-shift="${f}"` : `data-draft="${f}"`}>
    ${note ? `<small>${note}</small>` : ''}</label>`;
}

function editorHTML(rules) {
  const d = M.parseDate(selDate), s = shiftOf(selDate);
  const title = `${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）`;
  const msg = flash.shift ? `<p class="msg" role="status">${esc(flash.shift)}</p>` : '';
  if (!s) return `<div class="editor" id="editor"><h3>${title}</h3>
    <p class="muted">シフトは入っていません。</p>
    <div class="fields two">${timeField('start', '出勤', lastTimes.start, false)}${timeField('end', '退勤', lastTimes.end, false)}</div>
    <div class="actions"><button type="button" class="btn primary" data-act="shift-add">シフトを登録</button></div>${msg}</div>`;
  const r = M.shiftMinutes(s, rules);
  const st = s.status || 'work';
  return `<div class="editor" id="editor"><h3>${title}</h3>
    <div class="fields two">${timeField('start', '出勤', s.start, true)}${timeField('end', '退勤', s.end, true)}</div>
    <div class="seg" role="group" aria-label="この日の記録">${Object.entries(STATUS).map(([k, l]) => `<button type="button" class="seg-b" data-act="shift-status" data-status="${k}" aria-pressed="${st === k}">${l}</button>`).join('')}</div>
    ${st === 'early' ? timeField('leftAt', '上がった時刻', s.leftAt || '', true, '早退した日だけ入力') : ''}
    <dl class="calc">
      <div><dt>拘束時間</dt><dd>${M.fmtHM(r.span)}</dd></div>
      <div><dt>休憩・上限で引く分</dt><dd>${r.span - r.planned ? '−' : ''}${M.fmtHM(r.span - r.planned)}</dd></div>
      <div><dt>予定の労働時間</dt><dd>${M.fmtHM(r.planned)}</dd></div>
      ${r.lost ? `<div><dt>${st === 'off' ? '休み' : '早退'}で減る分</dt><dd>−${M.fmtHM(r.lost)}</dd></div>` : ''}
      <div class="total"><dt>計算に使う時間</dt><dd>${M.fmtHM(r.worked)}</dd></div>
    </dl>
    <div class="actions">
      <button type="button" class="btn" data-act="shift-copy">次の4週の${DOW[d.getDay()]}曜日にもコピー</button>
      <button type="button" class="btn" data-act="shift-del">このシフトを消す</button>
    </div>${msg}</div>`;
}

function shiftSection() {
  const t = today();
  if (!calMonth) calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
  if (!selDate) selDate = M.iso(t);
  const rules = M.rulesOf(S.job);
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1), lead = first.getDay();
  const start = M.addDays(first, -lead);
  const weeks = Math.ceil((lead + M.lastDay(y, m)) / 7);
  const byDate = new Map(S.job.shifts.map(s => [s.date, s]));
  let planned = 0, worked = 0, days = 0;
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = M.addDays(start, i), k = M.iso(d), s = byDate.get(k);
    const inMonth = d.getMonth() === m;
    const cls = ['day'];
    if (!inMonth) cls.push('out');
    if (k === M.iso(t)) cls.push('today');
    if (k === selDate) cls.push('sel');
    if (d.getDay() === 0 || d.getDay() === 6) cls.push('we');
    const isClose = d.getDate() === Math.min(S.job.close, M.lastDay(d.getFullYear(), d.getMonth()));
    let inner = `<span class="dn">${d.getDate()}${isClose ? '<em class="cl">締</em>' : ''}</span>`;
    let label = `${d.getMonth() + 1}月${d.getDate()}日 ${DOW[d.getDay()]}曜日`;
    if (s) {
      const r = M.shiftMinutes(s, rules), st = s.status || 'work';
      if (inMonth) { planned += r.planned; worked += r.worked; days++; }
      cls.push('has', st);
      inner += `<span class="st"><b>${esc(s.start)}</b><i>–${esc(s.end)}</i></span>
        <span class="wh">${st === 'off' ? '休み' : M.fmtHM(r.worked)}${st === 'early' ? '<em>早退</em>' : ''}</span>`;
      label += ` ${s.start}から${s.end} ${STATUS[st]} 労働${M.fmtHM(r.worked)}`;
    } else label += ' シフトなし';
    cells.push(`<button type="button" class="${cls.join(' ')}" data-act="pick-day" data-date="${k}" aria-pressed="${k === selDate}" aria-label="${esc(label)}">${inner}</button>`);
  }
  return `<section class="block" id="shifts"><div class="head"><h2>シフト</h2>
      <span class="sub-h">${m + 1}月：${days}日・予定 ${M.fmtHM(planned)} → 実際 ${M.fmtHM(worked)}</span></div>
    <div class="cal-nav">
      <button type="button" class="btn small" data-act="cal-prev">‹ 前の月</button>
      <strong>${fmtYM(calMonth)}</strong>
      <button type="button" class="btn small" data-act="cal-next">次の月 ›</button>
      <button type="button" class="btn small" data-act="cal-today">今月</button>
    </div>
    <div class="cal-wrap">
      <div class="cal">${DOW.map((w, i) => `<span class="dow${i === 0 || i === 6 ? ' we' : ''}">${w}</span>`).join('')}${cells.join('')}</div>
      ${editorHTML(rules)}
    </div>
    <p class="note">日付を押すとシフトを登録・編集できます。シフトが変わったらいつでも書き換えてください。休んだ日と早退した日だけ「休み」「早退」を選びます。時刻は 17:00 のほか 1700 や 17 でも入れられます。「締」は締め日です。</p>
  </section>`;
}

function ruleField(k, label, unit, scale, note = '') {
  const v = M.rulesOf(S.job)[k] / scale;
  return `<label class="field" for="rule-${k}"><span>${label}<em>${unit}</em></span>
    <input id="rule-${k}" type="number" inputmode="decimal" min="0" step="${scale === 60 ? 0.25 : 5}" data-rule="${k}" data-scale="${scale}" value="${esc(Math.round(v * 100) / 100)}">
    ${note ? `<small>${note}</small>` : ''}</label>`;
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
      ${ruleField('breakOver', '休憩が入るシフトの長さ', '時間', 60, 'これを超えると休憩を引く')}
      ${ruleField('breakMin', '休憩の長さ', '分', 1)}
      ${ruleField('maxMin', '1日の労働時間の上限', '時間', 60, '0 = 上限なし')}
    </div>
    <p class="formula">1日の労働時間 ＝ min(拘束時間 − 休憩, 上限)　／　支給額 ＝ 時給 × 月の労働時間 × (1 − 控除率) ＋ 交通費・手当 ＋ 追加分</p>
  </section>
${shiftSection()}
  <section class="block"><div class="head"><h2>月ごとの労働時間</h2></div>
    <div class="tablewrap"><table>
      <thead><tr><th>勤務月（締め月）</th><th class="r">シフト</th><th class="r">休み・早退</th><th class="r">計算に使う時間</th><th class="r">シフトがない月の見込み</th><th class="r">追加の手当</th><th class="r">支給額</th><th>支給日</th></tr></thead>
      <tbody>${pays.map(p => { const k = M.ym(p.cm); const m = S.job.months[k] || {}; return `<tr class="${p.custom ? '' : 'auto'}">
        <td>${fmtYM(p.cm)}<small>${(w => `${fmtMD(w.start)}〜${fmtMD(w.end)}`)(M.jobWindow(p.cm, S.job))}</small></td>
        <td class="n">${p.shift ? `${M.fmtHM(p.shift.planned)}<small>${p.shift.days}日</small>` : '—'}</td>
        <td class="n">${p.shift && p.shift.lost ? `−${M.fmtHM(p.shift.lost)}<small>休み${p.shift.off}・早退${p.shift.early}</small>` : '—'}</td>
        <td class="n strong">${M.fmtHM(p.hours * 60)}<small>${SRC[p.source]}</small></td>
        <td class="n${p.shift ? ' unused' : ''}"><input id="jh-${k}" class="cell num" type="number" inputmode="decimal" min="0" step="0.25" data-month="${k}" data-mf="hours" value="${m.hours ?? ''}" placeholder="${esc(S.job.hours)}" aria-label="${fmtYM(p.cm)}のシフトがない場合の見込み（時間）"></td>
        <td class="n"><input id="je-${k}" class="cell num" type="number" inputmode="decimal" data-month="${k}" data-mf="extra" value="${m.extra ?? ''}" placeholder="0" aria-label="${fmtYM(p.cm)}の追加の手当"></td>
        <td class="n strong">${yen(p.amount)}</td><td class="d">${fmt(p.pay)}</td></tr>`; }).join('')}</tbody>
    </table></div>
    <p class="note">シフトを1日でも登録した月は、その月のシフトの合計（休み・早退の分を引いた時間）で計算します。シフトがまだない先の月は、「シフトがない月の見込み」の時間、空欄なら標準の労働時間で計算します。</p>
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
  </section>
  ${loanSection(base)}`;
}

const MONTHS = [[0, 'なし'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}月`])];
function loanSection(base) {
  const sel = (l, f) => `<select id="loans-${l.id}-${f}" class="cell" data-list="loans" data-id="${l.id}" data-f="${f}" data-type="num" aria-label="ボーナス月">${MONTHS.map(([k, t]) => `<option value="${k}"${k == (l[f] || 0) ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
  const rows = S.loans.map(l => {
    const st = M.loanStatus(l, base);
    const remain = (l.count | 0)
      ? (st.remainCount ? `${st.remainCount}回<small>${yen(st.remainTotal)}円</small>` : '<span class="chip ok">完済</span>')
      : '<small>回数未定</small>';
    return `<tr>
      <td>${cellText('loans', l, 'name', '例：奨学金、PC')}</td>
      <td class="n">${cellNum('loans', l, 'amount', 'min="0"')}</td>
      <td class="n">${cellNum('loans', l, 'day', 'min="1" max="31"')}</td>
      <td>${cell('loans', l, 'first', `type="month" value="${esc(l.first)}"`)}</td>
      <td class="n">${cellNum('loans', l, 'count', 'min="0"')}</td>
      <td class="n">${cellNum('loans', l, 'bonusAmount', 'min="0"')}</td>
      <td class="bm">${sel(l, 'bonusM1')}${sel(l, 'bonusM2')}</td>
      <td class="n">${remain}</td>
      <td class="d">${st.next ? fmt(st.next.date) : '—'}</td>
      <td class="d">${st.last ? fmt(st.last) : '—'}</td>
      <td>${delBtn('loans', l, l.name || 'ローン')}</td></tr>`;
  }).join('');
  const sum = S.loans.reduce((a, l) => { const st = M.loanStatus(l, base); return { m: a.m + (st.remainCount ? +l.amount || 0 : 0), r: a.r + ((l.count | 0) ? st.remainTotal : 0) }; }, { m: 0, r: 0 });
  return `<section class="block"><div class="head"><h2>ローン</h2>${S.loans.length ? `<span class="sub-h">毎月 ${yen(sum.m)}円・残り ${yen(sum.r)}円</span>` : ''}<button type="button" class="btn" data-act="add" data-list="loans">＋ ローンを追加</button></div>
    <div class="tablewrap"><table>
      <thead><tr><th>名前</th><th class="r">毎月の返済額</th><th class="r">引き落とし日</th><th>初回の月</th><th class="r">返済回数</th><th class="r">ボーナス月の加算</th><th>ボーナス月</th><th class="r">残り</th><th>次回</th><th>完済予定</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="empty">口座から引き落とされるローンや分割の返済を入れると、毎月の引き落としに加わります。</td></tr>'}</tbody>
    </table></div>
    <p class="note">口座から毎月引き落とされる返済です（カード払いの分割は「大きい買い物」で入れます）。返済回数は初回からの合計で、0 にすると計算期間の最後まで続きます。残りは基準日より後の回数と金額です。</p>
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
function syncSection() {
  const f = flash.sync ? `<p class="msg" role="status">${esc(flash.sync)}</p>` : '';
  if (syncCfg) {
    const label = SYNC_LABEL[sync.status] ? SYNC_LABEL[sync.status]() : '';
    return `<section class="block" id="sync-block"><div class="head"><h2>端末間の同期</h2><span class="sub-h" id="sync-state">${esc(label)}</span></div>
      <p class="kv"><span>同期先</span><code>${esc(syncCfg.owner)}/${esc(syncCfg.repo)}/${esc(syncCfg.path)}</code></p>
      <p class="note">変更は数秒後に自動で同期し、アプリを開き直したときと、開いている間は45秒ごとに別の端末の変更を取り込みます。別の端末で使い始めるときは、ロック画面の「別の端末で使っているデータを読み込む」から、同じ同期先・トークン・パスワードを入れます。</p>
      <div class="actions">
        <button type="button" class="btn" data-act="sync-now">今すぐ同期</button>
        <button type="button" class="btn${confirmKey === 'sync-off' ? ' danger' : ''}" data-act="sync-off">${confirmKey === 'sync-off' ? 'もう一度押すと同期をやめます' : 'この端末の同期をやめる'}</button>
      </div>
      <form id="token-form" class="fields" autocomplete="off">
        <label class="field" for="tk-new"><span>アクセストークンを入れ替える</span><input id="tk-new" type="password" autocomplete="off" required spellcheck="false"><small>期限が切れたときなど</small></label>
        <div class="field end"><button type="submit" class="btn">入れ替える</button></div>
      </form>${f}
    </section>`;
  }
  return `<section class="block" id="sync-block"><div class="head"><h2>端末間の同期</h2><span class="sub-h">オフ</span></div>
    <p class="note">暗号化したデータを、自分の非公開リポジトリに置いて、スマホと PC などで同じデータを使えるようにします。</p>
    <ol class="steps">
      <li>GitHub で <strong>非公開（Private）</strong> のリポジトリを作ります（例：<code>finance-sim-data</code>。中身は空のままで大丈夫です）。</li>
      <li>GitHub の Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong> で新しいトークンを作ります。Repository access は「Only select repositories」でそのリポジトリだけ、Permissions の <strong>Contents</strong> を「Read and write」にします。</li>
      <li>下にリポジトリとトークンを入れて「接続して同期」を押します。</li>
    </ol>
    <form id="sync-form" class="fields" autocomplete="off">
      <label class="field" for="sy-owner"><span>GitHub のユーザー名</span><input id="sy-owner" type="text" value="Git-Ayase" required autocapitalize="off" spellcheck="false"></label>
      <label class="field" for="sy-repo"><span>リポジトリ名</span><input id="sy-repo" type="text" value="finance-sim-data" required autocapitalize="off" spellcheck="false"></label>
      <label class="field" for="sy-path"><span>ファイル名</span><input id="sy-path" type="text" value="cashflow.json" required autocapitalize="off" spellcheck="false"></label>
      <label class="field" for="sy-token"><span>アクセストークン</span><input id="sy-token" type="password" autocomplete="off" required spellcheck="false"></label>
      <div class="field end"><button type="submit" class="btn primary">接続して同期</button></div>
    </form>${f}
  </section>`;
}

async function onSyncConnect(form) {
  const v = id => form.querySelector(id).value.trim();
  const cfg = { owner: v('#sy-owner'), repo: v('#sy-repo'), path: v('#sy-path'), token: v('#sy-token') };
  flash.sync = '確認中…'; rerender();
  try { await Sync.check(cfg); } catch (e) { flash.sync = Sync.message(e); return rerender(); }
  syncCfg = cfg; await storeSyncCfg();
  ls.del(SHA_KEY); ls.set(DIRTY_KEY, '1');
  flash.sync = '';
  await syncNow({ force: true });
  if (sync.status === 'idle') flash.sync = '接続しました。この端末のデータを同期先に保存しました。';
  rerender();
}
async function onTokenReplace(form) {
  const token = form.querySelector('#tk-new').value.trim();
  try { await Sync.check({ ...syncCfg, token }); } catch (e) { flash.sync = Sync.message(e); return rerender(); }
  syncCfg = { ...syncCfg, token }; await storeSyncCfg();
  flash.sync = 'トークンを入れ替えました。'; rerender();
  syncNow({ force: true });
}
async function onSyncPassword(form) {
  const pw = form.querySelector('#syncpw').value;
  try {
    const r = await V.open(remoteHold.vault, pw);
    session = { key: r.key, kdf: r.kdf };
    await adoptRemote(remoteHold, r.data);
    await storeSyncCfg();
  } catch { sync.msg = 'パスワードが違います。同期先のパスワードを入力してください。'; paintSyncBar(); }
}

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
  ${syncSection()}
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
      <li>外部のスクリプトやフォントは読み込みません。通信先は同期に使う GitHub の API（api.github.com）だけに制限しています（CSP）。</li>
      <li>同期するときも、GitHub に送るのは暗号化したデータだけです。同期先は非公開のリポジトリに限り、アクセストークンもこの端末に暗号化して保存します。</li>
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
  if (t.dataset.draft) lastTimes[t.dataset.draft] = t.value;
  if (t.dataset.shift) { const s = shiftOf(selDate); if (s) { s[t.dataset.shift] = t.value; return true; } }
  if (t.dataset.rule) { const r = { ...M.rulesOf(S.job) }; r[t.dataset.rule] = Math.round((Number(t.value) || 0) * +t.dataset.scale); S.job.rules = r; return true; }
  return false;
}

function addItem(list) {
  const base = M.parseDate(S.base.date) || today();
  const c0 = S.cards[0];
  const id = uid();
  if (list === 'cards') S.cards.push({ id, name: '新しいカード', close: 15, pay: 10, offset: 1 });
  if (list === 'bills') S.bills.push({ id, card: c0?.id || '', date: M.iso(c0 ? M.nextPayDate(c0, base) : base), amount: 0, memo: '' });
  if (list === 'loans') S.loans.push({ id, name: '', amount: 0, day: 27, first: M.ym(new Date(base.getFullYear(), base.getMonth() + (base.getDate() >= 27 ? 1 : 0), 1)), count: 12, bonusAmount: 0, bonusM1: 0, bonusM2: 0 });
  if (list === 'recurring') S.recurring.push({ id, card: c0?.id || '', amount: 0, from: M.ym(M.addDays(base, 1)), to: '', memo: '' });
  if (list === 'purchases') S.purchases.push({ id, label: '', amount: 0, card: c0?.id || '', payDate: c0 ? M.iso(M.payOptions(c0, purchaseFrom(), 1)[0].payDate) : '', count: 1, feePct: 0 });
  return id;
}

function arm(key) {
  confirmKey = key;
  setTimeout(() => { if (confirmKey === key) { confirmKey = null; S ? rerender() : renderLock(); } }, 4000);
}

async function wipe() {
  for (const k of [VAULT_KEY, SYNC_KEY, SHA_KEY, DIRTY_KEY]) ls.del(k);
  syncCfg = null; sync.status = 'off'; clearTimeout(pushTimer);
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
  await storeSyncCfg();
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
  if (!S || !t.matches('input,select') || t.type === 'file' || t.type === 'password' || t.closest('#pw-form,#import-form,#sync-form,#token-form,#syncpw-form')) return;
  if (applyInput(t)) { scheduleSave(); paintStatus(M.simulate(S)); }
});
app.addEventListener('change', e => {
  const t = e.target;
  if (!S) return;
  if (t.id === 'import-file') return onImportFile(t);
  if (t.dataset.shift) {
    const s = shiftOf(selDate), n = M.normHM(t.value);
    if (s && t.value.trim() === '' && t.dataset.shift === 'leftAt') s.leftAt = '';
    else if (s && n) { s[t.dataset.shift] = n; flash.shift = ''; }
    else flash.shift = '時刻は 17:00 のように入力してください。';
    scheduleSave(); setTimeout(rerender, 0); return;
  }
  if (t.dataset.draft) { const n = M.normHM(t.value); if (n) { lastTimes[t.dataset.draft] = n; t.value = n; } return; }
  if (t.matches('[data-bind],[data-list],[data-month],[data-rule]')) setTimeout(rerender, 0);
});
app.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'lock-form') onLockSubmit(f);
  else if (f.id === 'pw-form') onChangePassword(f);
  else if (f.id === 'import-form') onImportSubmit(f);
  else if (f.id === 'join-form') onJoin(f);
  else if (f.id === 'sync-form') onSyncConnect(f);
  else if (f.id === 'token-form') onTokenReplace(f);
  else if (f.id === 'syncpw-form') onSyncPassword(f);
});
app.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) {
    tab = b.dataset.tab; confirmKey = null; flash = {};
    document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-current', x.dataset.tab === tab ? 'page' : 'false'));
    renderPage(); scrollTo({ top: 0 });
    return;
  }
  const act = b.dataset.act; if (!act) return;
  if (act === 'wipe') { if (confirmKey === 'wipe') return wipe(); arm('wipe'); return S ? rerender() : renderLock(); }
  if (!S) return;
  if (act === 'lock') return lock();
  if (act === 'pick-day') {
    selDate = b.dataset.date; flash.shift = '';
    const d = M.parseDate(selDate);
    if (d.getMonth() !== calMonth.getMonth() || d.getFullYear() !== calMonth.getFullYear()) calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    rerender();
    const ed = document.getElementById('editor');
    if (ed && innerWidth < 900) ed.scrollIntoView({ block: 'nearest' });
    (document.getElementById('sh-start'))?.focus({ preventScroll: true });
    return;
  }
  if (act === 'cal-prev' || act === 'cal-next') { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + (act === 'cal-next' ? 1 : -1), 1); return rerender(); }
  if (act === 'cal-today') { const t = today(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); selDate = M.iso(t); return rerender(); }
  if (act === 'shift-add') {
    const st = M.normHM(lastTimes.start), en = M.normHM(lastTimes.end);
    if (!st || !en) { flash.shift = '出勤と退勤の時刻を 17:00 のように入力してください。'; return rerender(); }
    lastTimes = { start: st, end: en };
    S.job.shifts = S.job.shifts.filter(s => s.date !== selDate);
    S.job.shifts.push({ id: uid(), date: selDate, start: st, end: en, status: 'work' });
    flash.shift = ''; scheduleSave(); return rerender();
  }
  if (act === 'shift-status') {
    const s = shiftOf(selDate); if (!s) return;
    s.status = b.dataset.status;
    if (s.status !== 'early') delete s.leftAt;
    scheduleSave(); rerender();
    if (s.status === 'early') document.getElementById('sh-leftAt')?.focus();
    return;
  }
  if (act === 'shift-del') { S.job.shifts = S.job.shifts.filter(s => s.date !== selDate); scheduleSave(); return rerender(); }
  if (act === 'shift-copy') {
    const s = shiftOf(selDate); if (!s) return;
    let added = 0, skipped = 0;
    for (let w = 1; w <= 4; w++) {
      const k = M.iso(M.addDays(M.parseDate(selDate), 7 * w));
      if (shiftOf(k)) { skipped++; continue; }
      S.job.shifts.push({ id: uid(), date: k, start: s.start, end: s.end, status: 'work' }); added++;
    }
    flash.shift = `${added}日分コピーしました。${skipped ? `すでにシフトがある${skipped}日はそのままです。` : ''}`;
    scheduleSave(); return rerender();
  }
  if (act === 'sync-now') return syncNow({ force: true });
  if (act === 'goto-sync') { tab = 'settings'; renderApp(); document.getElementById('sync-block')?.scrollIntoView(); return; }
  if (act === 'sync-use-remote' && remoteHold?.data) return adoptRemote(remoteHold, remoteHold.data);
  if (act === 'sync-use-local' && remoteHold) {
    setSync('syncing');
    try { await pushLocal(remoteHold.sha); } catch (e) { setSync('error', Sync.message(e)); }
    return;
  }
  if (act === 'sync-off') {
    if (confirmKey !== 'sync-off') { arm('sync-off'); return rerender(); }
    confirmKey = null; syncCfg = null; remoteHold = null; clearTimeout(pushTimer);
    for (const k of [SYNC_KEY, SHA_KEY, DIRTY_KEY]) ls.del(k);
    setSync('off'); flash.sync = 'この端末の同期をやめました。同期先のファイルはそのまま残っています。';
    return rerender();
  }
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
