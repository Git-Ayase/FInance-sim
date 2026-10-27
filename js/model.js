// model.js — キャッシュフローの計算（DOM に依存しない純粋関数）

export const pad = n => String(n).padStart(2, '0');
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

export function parseDate(s) {
  if (!s || typeof s !== 'string') return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m) return null;
  return new Date(y, m - 1, d || 1);
}

// y 年 m 月（0 始まり、範囲外も可）の day 日。月末を超える日は月末に丸める
export function dayIn(y, m, day) {
  const b = new Date(y, m, 1);
  const Y = b.getFullYear(), M = b.getMonth();
  return new Date(Y, M, Math.min(Math.max(1, day | 0), lastDay(Y, M)));
}

/* ---------- カード ---------- */

// 利用日が属する「締め月」（その月の 1 日で返す）
export function closingMonth(date, close) {
  const c = Math.min(close | 0 || 31, lastDay(date.getFullYear(), date.getMonth()));
  return new Date(date.getFullYear(), date.getMonth() + (date.getDate() > c ? 1 : 0), 1);
}

export function payDateOfClosing(cm, card) {
  return dayIn(cm.getFullYear(), cm.getMonth() + (card.offset ?? 1), card.pay);
}

export function payDateForPurchase(date, card) {
  return payDateOfClosing(closingMonth(date, card.close), card);
}

// 締め月 cm の利用期間（前回締め日の翌日〜今回の締め日）
export function windowForClosing(cm, card) {
  const end = dayIn(cm.getFullYear(), cm.getMonth(), card.close);
  const prevEnd = dayIn(cm.getFullYear(), cm.getMonth() - 1, card.close);
  return { start: addDays(prevEnd, 1), end };
}

// 引き落とし日から、その日に払うことになる購入期間
export function windowForPay(payDate, card) {
  const cm = new Date(payDate.getFullYear(), payDate.getMonth() - (card.offset ?? 1), 1);
  return windowForClosing(cm, card);
}

// from 以降に買える場合の、選べる引き落とし日 n 件
export function payOptions(card, from, n = 4) {
  const first = closingMonth(from, card.close);
  const out = [];
  for (let i = 0; i < n; i++) {
    const cm = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const w = windowForClosing(cm, card);
    out.push({ payDate: payDateOfClosing(cm, card), start: w.start < from ? from : w.start, end: w.end });
  }
  return out;
}

// after より後の最初の引き落とし日
export function nextPayDate(card, after) {
  for (let i = -3; i < 24; i++) {
    const cm = new Date(after.getFullYear(), after.getMonth() + i, 1);
    const p = payDateOfClosing(cm, card);
    if (p > after) return p;
  }
  return null;
}

/* ---------- バイト代 ---------- */

/* ---- 時刻・時間（H:MM） ---- */

// "17:30" / "1730" / "17" / "１７：３０" → 1050（分）。不正な値は null
export function parseHM(v) {
  const t = String(v ?? '').trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[：.]/g, ':');
  let h, m;
  let x = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (x) { h = +x[1]; m = +x[2]; }
  else if ((x = /^(\d{1,2})(\d{2})$/.exec(t))) { h = +x[1]; m = +x[2]; }
  else if ((x = /^(\d{1,2})$/.exec(t))) { h = +x[1]; m = 0; }
  else return null;
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  return h * 60 + m;
}
// 分 → "4:30"
export const fmtHM = min => { const t = Math.round(Math.abs(min || 0)); return `${min < 0 ? '−' : ''}${Math.floor(t / 60)}:${pad(t % 60)}`; };
// 入力を "H:MM" にそろえる（不正なら null）
export const normHM = v => { const m = parseHM(v); return m == null ? null : fmtHM(m); };

// 開始〜終了の分数。終了が開始以前なら日付をまたぐ勤務として扱う
export function spanMin(start, end) {
  const a = parseHM(start), b = parseHM(end);
  if (a == null || b == null) return 0;
  let d = b - a;
  if (d <= 0) d += 1440;
  return d;
}

// 休憩と上限のルール（分）。初期値：8時間を超えたら1時間休憩、1日の上限7時間
export const DEFAULT_RULES = { breakOver: 480, breakMin: 60, maxMin: 420 };
export function rulesOf(job) { return { ...DEFAULT_RULES, ...(job && job.rules || {}) }; }

// 拘束時間 → 労働時間
export function workedFromSpan(span, rules = DEFAULT_RULES) {
  let w = span;
  if (rules.breakOver > 0 && w > rules.breakOver) w -= rules.breakMin;
  if (rules.maxMin > 0) w = Math.min(w, rules.maxMin);
  return Math.max(0, w);
}

// 1回のシフト（分）：planned = 予定どおり働いた場合、worked = 実際、lost = 休み・早退で減った分
//   status: 'work'（通常）| 'off'（休み）| 'early'（早退。leftAt = 実際に上がった時刻）
export function shiftMinutes(s, rules = DEFAULT_RULES) {
  const span = spanMin(s.start, s.end);
  const planned = workedFromSpan(span, rules);
  if (s.status === 'off') return { span, planned, worked: 0, lost: planned };
  if (s.status === 'early' && parseHM(s.leftAt) != null) {
    const worked = Math.min(planned, workedFromSpan(Math.min(span, spanMin(s.start, s.leftAt)), rules));
    return { span, planned, worked, lost: planned - worked };
  }
  return { span, planned, worked: planned, lost: 0 };
}

// シフトを締め月ごとに集計 → Map('YYYY-MM' => { planned, worked, lost, days, off, early })
export function shiftTotals(job) {
  const map = new Map();
  const rules = rulesOf(job);
  for (const s of job.shifts || []) {
    const d = parseDate(s.date);
    if (!d) continue;
    const k = ym(closingMonth(d, job.close));
    const o = map.get(k) || { planned: 0, worked: 0, lost: 0, days: 0, off: 0, early: 0 };
    const m = shiftMinutes(s, rules);
    o.planned += m.planned; o.worked += m.worked; o.lost += m.lost; o.days++;
    if (s.status === 'off') o.off++;
    if (s.status === 'early') o.early++;
    map.set(k, o);
  }
  return map;
}

// 締め月 cm の勤務期間
export function jobWindow(cm, job) { return windowForClosing(cm, { close: job.close }); }

// その月の計算に使う労働時間（時間単位）
//   シフトを登録した月 → シフトの合計から休み・早退の分を引いた時間
//   シフトがない月     → その月の予定（空欄なら標準の労働時間）
export function monthHours(job, cm, totals = shiftTotals(job)) {
  const m = (job.months || {})[ym(cm)] || {};
  const t = totals.get(ym(cm));
  if (t) return { hours: t.worked / 60, source: 'shift', shift: t };
  return { hours: m.hours ?? (+job.hours || 0), source: m.hours != null ? 'planned' : 'default', shift: null };
}

// (start, end] に支給されるバイト代。勤務月 = 締め月
export function jobPayments(job, start, end) {
  const out = [];
  const off = job.offset ?? 1;
  const wage = +job.wage || 0;
  const totals = shiftTotals(job);
  for (let cm = new Date(start.getFullYear(), start.getMonth() - off - 1, 1);
       cm <= end;
       cm = new Date(cm.getFullYear(), cm.getMonth() + 1, 1)) {
    const pay = dayIn(cm.getFullYear(), cm.getMonth() + off, job.pay);
    if (!(pay > start && pay <= end)) continue;
    const m = (job.months || {})[ym(cm)] || {};
    const h = monthHours(job, cm, totals);
    const extra = m.extra ?? 0;
    const gross = Math.round(wage * h.hours);
    const amount = Math.round(gross * (1 - (+job.dedPct || 0) / 100)) + (+job.transport || 0) + extra;
    out.push({ cm, pay, ...h, extra, gross, taxable: gross + extra, amount, custom: h.source !== 'default' });
  }
  return out;
}

// 支給日の年ごとの給与収入（控除前・交通費を除く）
export function yearTotals(S, start, end) {
  const map = new Map();
  for (const p of jobPayments(S.job, start, end)) {
    const y = p.pay.getFullYear();
    map.set(y, (map.get(y) || 0) + p.taxable);
  }
  const y0 = start.getFullYear();
  const years = [...new Set([y0, ...map.keys()])].sort((a, b) => a - b);
  return years.map(y => {
    const paid = y === y0 ? (+S.job.paidThisYear || 0) : 0;
    const forecast = map.get(y) || 0;
    return { year: y, paid, forecast, total: paid + forecast };
  });
}

/* ---------- シミュレーション ---------- */

export function simRange(S) {
  const start = parseDate(S.base.date) || new Date();
  const months = Math.max(1, Math.min(36, (S.base.months | 0) || 6));
  const end = new Date(start.getFullYear(), start.getMonth() + months, 0);
  return { start, end, months };
}

export function purchaseEvents(p, card) {
  const first = parseDate(p.payDate);
  if (!card || !first || !p.amount) return [];
  const n = Math.max(1, p.count | 0 || 1);
  const total = Math.round(p.amount * (1 + (+p.feePct || 0) / 100));
  const each = Math.floor(total / n), rem = total - each * n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      date: dayIn(first.getFullYear(), first.getMonth() + i, card.pay),
      amount: -(each + (i === 0 ? rem : 0)),
      label: n > 1 ? `${p.label || '買い物'}（${i + 1}/${n}回）` : (p.label || '買い物'),
      card: card.id, kind: 'purchase',
    });
  }
  return out;
}

export function simulate(S, extraPurchases = []) {
  const { start, end, months } = simRange(S);
  const inRange = d => d > start && d <= end;
  const cards = new Map(S.cards.map(c => [c.id, c]));
  const ev = [];

  for (const p of jobPayments(S.job, start, end))
    if (p.amount) ev.push({ date: p.pay, amount: p.amount, label: `バイト代（${p.cm.getMonth() + 1}月分）`, kind: 'income' });

  // 確定した請求。同じカード・同じ月に確定請求があれば、その月の見込みは使わない
  const billed = new Set();
  for (const b of S.bills) {
    const d = parseDate(b.date);
    if (!d || !b.amount) continue;
    if (b.card) billed.add(`${b.card}|${ym(d)}`);
    if (inRange(d)) ev.push({ date: d, amount: -b.amount, label: b.memo || 'カードの請求', card: b.card, kind: 'bill' });
  }

  for (const r of S.recurring) {
    const card = cards.get(r.card);
    const f = parseDate(r.from ? r.from + '-01' : '');
    if (!card || !f || !r.amount) continue;
    const t = parseDate(r.to ? r.to + '-01' : '');
    for (let m = f; m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      if (t && m > t) break;
      const d = dayIn(m.getFullYear(), m.getMonth(), card.pay);
      if (!inRange(d) || billed.has(`${r.card}|${ym(d)}`)) continue;
      ev.push({ date: d, amount: -r.amount, label: r.memo || '毎月の見込み', card: r.card, kind: 'recurring' });
    }
  }

  for (const p of [...S.purchases, ...extraPurchases])
    for (const e of purchaseEvents(p, cards.get(p.card))) if (inRange(e.date)) ev.push(e);

  // 同じ日は出金を先に（低めに見積もる）
  ev.sort((a, b) => a.date - b.date || (a.amount > 0) - (b.amount > 0));

  const startBal = +S.base.balance || 0;
  let bal = startBal;
  let min = { balance: bal, date: start, index: -1 };
  const rows = ev.map((e, i) => {
    bal += e.amount;
    if (bal < min.balance) min = { balance: bal, date: e.date, index: i };
    return { ...e, balance: bal };
  });

  const monthly = [];
  let prev = startBal;
  for (let i = 0; i < months; i++) {
    const m = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = ym(m);
    const rs = rows.filter(r => ym(r.date) === key);
    const income = rs.filter(r => r.amount > 0).reduce((a, r) => a + r.amount, 0);
    const outflow = -rs.filter(r => r.amount < 0).reduce((a, r) => a + r.amount, 0);
    const endBalance = rs.length ? rs[rs.length - 1].balance : prev;
    const low = Math.min(prev, ...rs.map(r => r.balance));
    monthly.push({ month: m, income, outflow, low, endBalance });
    prev = endBalance;
  }

  return { start, end, rows, min, final: bal, monthly };
}

// 大きい買い物：カード × 引き落とし日 の組み合わせごとの最低残高
export function compare(S, spec, from, n = 4) {
  const out = [];
  for (const card of S.cards) {
    for (const o of payOptions(card, from, n)) {
      const sim = simulate(S, [{ ...spec, card: card.id, payDate: iso(o.payDate) }]);
      out.push({ card, ...o, min: sim.min, outOfRange: o.payDate > sim.end });
    }
  }
  return out;
}
