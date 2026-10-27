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

const r2 = x => Math.round(x * 100) / 100;
const todayDate = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };

// 勤務時間の記録を締め月ごとに集計 → Map('YYYY-MM' => { hours, days })
export function logTotals(job) {
  const map = new Map();
  for (const l of job.logs || []) {
    const d = parseDate(l.date), h = +l.hours;
    if (!d || !h) continue;
    const k = ym(closingMonth(d, job.close));
    const o = map.get(k) || { hours: 0, dates: new Set() };
    o.hours = r2(o.hours + h); o.dates.add(l.date);
    map.set(k, o);
  }
  for (const o of map.values()) { o.days = o.dates.size; delete o.dates; }
  return map;
}

// 締め月 cm の勤務期間
export function jobWindow(cm, job) { return windowForClosing(cm, { close: job.close }); }

// その月の計算に使う労働時間
//   締め日を過ぎた月で記録がある → 記録の合計（実績）
//   締め前の月で記録がある      → 予定と記録の少ない方（少なめに見積もる）
//   記録がない                  → 予定（空欄なら標準）
export function monthHours(job, cm, logs = logTotals(job), asOf = todayDate()) {
  const m = (job.months || {})[ym(cm)] || {};
  const planned = m.hours ?? (+job.hours || 0);
  const rec = logs.get(ym(cm));
  const closed = dayIn(cm.getFullYear(), cm.getMonth(), job.close) < asOf;
  if (rec && closed) return { hours: rec.hours, planned, recorded: rec.hours, days: rec.days, source: 'actual', closed };
  if (rec) return { hours: Math.min(planned, rec.hours), planned, recorded: rec.hours, days: rec.days, source: rec.hours < planned ? 'progress' : 'capped', closed };
  return { hours: planned, planned, recorded: 0, days: 0, source: m.hours != null ? 'planned' : 'default', closed };
}

// (start, end] に支給されるバイト代。勤務月 = 締め月
export function jobPayments(job, start, end, asOf = todayDate()) {
  const out = [];
  const off = job.offset ?? 1;
  const wage = +job.wage || 0;
  const logs = logTotals(job);
  for (let cm = new Date(start.getFullYear(), start.getMonth() - off - 1, 1);
       cm <= end;
       cm = new Date(cm.getFullYear(), cm.getMonth() + 1, 1)) {
    const pay = dayIn(cm.getFullYear(), cm.getMonth() + off, job.pay);
    if (!(pay > start && pay <= end)) continue;
    const m = (job.months || {})[ym(cm)] || {};
    const h = monthHours(job, cm, logs, asOf);
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
