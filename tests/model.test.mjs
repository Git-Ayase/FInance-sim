// node tests/model.test.mjs
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const cards = [
  { id: 'a', name: 'メイン', close: 15, pay: 13, offset: 1 },
  { id: 'f', name: '固定費', close: 31, pay: 26, offset: 1 },
  { id: 'o', name: 'その他', close: 5, pay: 4, offset: 1 },
];
const S = {
  base: { date: '2026-10-19', balance: 120226, months: 5, safe: 30000 },
  job: { wage: 1000, hours: 60, close: 31, pay: 15, offset: 1, dedPct: 0, transport: 0, months: {} },
  cards,
  bills: [
    { card: 'f', date: '2026-10-26', amount: 8307 },
    { card: 'o', date: '2026-11-04', amount: 4224 },
    { card: 'a', date: '2026-11-13', amount: 25764 },
    { card: 'f', date: '2026-11-26', amount: 8307 },
    { card: 'o', date: '2026-12-04', amount: 5883 },
    { card: 'a', date: '2026-12-13', amount: 20000 },
  ],
  recurring: [
    { card: 'f', amount: 8307, from: '2026-12' },
    { card: 'o', amount: 5883, from: '2027-01' },
    { card: 'a', amount: 12000, from: '2027-01' },
  ],
  purchases: [
    { label: 'Amazon', amount: 33664, card: 'a', payDate: '2026-12-13', count: 1 },
    { label: 'トラッカー', amount: 80000, card: 'o', payDate: '2027-02-04', count: 1 },
  ],
};

const d = s => M.parseDate(s);
// 締め日・支払日
assert.equal(M.iso(M.payDateForPurchase(d('2026-10-19'), cards[0])), '2026-12-13');
assert.equal(M.iso(M.payDateForPurchase(d('2026-12-06'), cards[2])), '2027-02-04');
assert.equal(M.iso(M.payDateForPurchase(d('2026-12-05'), cards[2])), '2027-01-04');
assert.equal(M.iso(M.payDateForPurchase(d('2027-02-28'), cards[1])), '2027-03-26');
const w = M.windowForPay(d('2027-02-04'), cards[2]);
assert.equal(M.iso(w.start), '2026-12-06'); assert.equal(M.iso(w.end), '2027-01-05');

// 前回手計算した結果と一致するか
const sim = M.simulate(S);
assert.equal(sim.min.balance, 61697);
assert.equal(M.iso(sim.min.date), '2027-02-13');
const at = s => sim.rows.filter(r => M.iso(r.date) === s).at(-1).balance;
assert.equal(at('2026-12-13'), 74077);
assert.equal(at('2027-01-13'), 107887);

// 確定請求がある月は見込みを使わない
const S2 = structuredClone(S); S2.bills.push({ card: 'a', date: '2027-01-13', amount: 30000 });
const jan = M.simulate(S2).rows.filter(r => M.iso(r.date) === '2027-01-13');
assert.equal(jan.length, 1); assert.equal(jan[0].amount, -30000);

// 分割払い（3回・端数は初回）
const ev = M.purchaseEvents({ label: 'x', amount: 10000, payDate: '2027-02-04', count: 3 }, cards[2]);
assert.deepEqual(ev.map(e => [M.iso(e.date), e.amount]), [['2027-02-04', -3334], ['2027-03-04', -3333], ['2027-04-04', -3333]]);

// 月ごとの労働時間
const S3 = structuredClone(S); S3.job.months['2026-11'] = { hours: 80, extra: 2000 };
const p = M.jobPayments(S3.job, d('2026-10-19'), d('2027-01-31'));
assert.deepEqual(p.map(x => [M.iso(x.pay), x.amount]), [['2026-11-15', 60000], ['2026-12-15', 82000], ['2027-01-15', 60000]]);

// 勤務時間の記録
const J = { wage: 1000, hours: 60, close: 31, pay: 15, offset: 1, months: { '2026-11': { hours: 50 } },
  logs: [{ date: '2026-10-03', hours: 5 }, { date: '2026-10-10', hours: 4.5 }, { date: '2026-10-10', hours: 1 },
         { date: '2026-11-02', hours: 6 }, { date: '2026-12-01', hours: 70 }] };
const asOf = d('2026-11-05');
const L = M.logTotals(J);
assert.deepEqual(L.get('2026-10'), { hours: 10.5, days: 2 });
// 10月：締め済み → 記録の合計だけ（休んだ分は減る）
assert.deepEqual(M.monthHours(J, d('2026-10-01'), L, asOf).hours, 10.5);
assert.equal(M.monthHours(J, d('2026-10-01'), L, asOf).source, 'actual');
// 11月：締め前で記録 6h < 予定 50h → 少ない方の記録
assert.equal(M.monthHours(J, d('2026-11-01'), L, asOf).hours, 6);
assert.equal(M.monthHours(J, d('2026-11-01'), L, asOf).source, 'progress');
// 12月：締め前で記録 70h > 標準 60h → 少ない方の標準
assert.equal(M.monthHours(J, d('2026-12-01'), L, asOf).hours, 60);
assert.equal(M.monthHours(J, d('2026-12-01'), L, asOf).source, 'capped');
// 1月：記録なし → 標準
assert.equal(M.monthHours(J, d('2027-01-01'), L, asOf).source, 'default');
const jp = M.jobPayments(J, d('2026-11-05'), d('2027-02-28'), asOf);
assert.deepEqual(jp.map(x => [M.iso(x.pay), x.amount]), [['2026-11-15', 10500], ['2026-12-15', 6000], ['2027-01-15', 60000], ['2027-02-15', 60000]]);
// 15日締め：10/16 は 11月締めの勤務
assert.equal(M.ym(M.closingMonth(d('2026-10-16'), 15)), '2026-11');

// 比較：給料日(2/15)の後に引き落とされる固定費カード 2/26 払いが最も余裕がある
const S4 = structuredClone(S); S4.purchases = S4.purchases.slice(0, 1);
const res = M.compare(S4, { label: 't', amount: 80000, count: 1 }, d('2026-12-06'), 3);
const best = res.filter(r => !r.outOfRange).sort((a, b) => b.min.balance - a.min.balance)[0];
assert.equal(best.card.id, 'f'); assert.equal(M.iso(best.payDate), '2027-02-26');
assert.equal(best.min.balance, 74077);
assert.equal(res.find(r => r.card.id === 'o' && M.iso(r.payDate) === '2027-02-04').min.balance, 61697);

console.log('all tests passed');
