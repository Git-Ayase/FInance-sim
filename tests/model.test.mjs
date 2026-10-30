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

// 時刻
assert.equal(M.parseHM('17:30'), 1050); assert.equal(M.parseHM('0:45'), 45); assert.equal(M.parseHM('9:75'), null);
assert.equal(M.parseHM('1730'), 1050); assert.equal(M.parseHM('9'), 540); assert.equal(M.parseHM('１７：３０'), 1050);
assert.equal(M.fmtHM(270), '4:30'); assert.equal(M.normHM('930'), '9:30');
// 休憩と上限：8時間を超えたら1時間休憩、上限7時間
const sm = (a, b, x = {}) => M.shiftMinutes({ start: a, end: b, ...x });
assert.equal(sm('17:00', '21:30').worked, 270);
assert.equal(sm('9:00', '16:00').worked, 420);   // 7h
assert.equal(sm('9:00', '16:30').worked, 420);   // 7.5h → 上限 7h
assert.equal(sm('9:00', '17:00').worked, 420);   // 8h → 上限 7h
assert.equal(sm('9:00', '18:00').worked, 420);   // 9h → 休憩1h → 8h → 上限 7h
assert.equal(sm('22:00', '2:00').worked, 240);   // 日付またぎ
// 休み・早退
assert.deepEqual(sm('17:00', '21:00', { status: 'off' }), { span: 240, planned: 240, worked: 0, lost: 240 });
assert.deepEqual(sm('10:00', '19:00', { status: 'early', leftAt: '14:00' }), { span: 540, planned: 420, worked: 240, lost: 180 });
assert.equal(sm('10:00', '19:00', { status: 'early', leftAt: '18:30' }).worked, 420); // 上限内なので減らない
assert.equal(sm('17:00', '21:00', { status: 'early' }).worked, 240); // 時刻未入力なら通常扱い
// ルールを変えた場合
assert.equal(M.shiftMinutes({ start: '9:00', end: '18:00' }, { breakOver: 360, breakMin: 45, maxMin: 0 }).worked, 495);

const J = { wage: 1000, hours: 60, close: 31, pay: 15, offset: 1, months: { '2026-12': { hours: 30 } },
  shifts: [
    { date: '2026-11-02', start: '17:00', end: '21:00' },
    { date: '2026-11-04', start: '17:00', end: '21:00', status: 'off' },
    { date: '2026-11-09', start: '10:00', end: '19:00', status: 'early', leftAt: '14:00' },
    { date: '2026-11-16', start: '17:00', end: '22:30' },
  ] };
const T = M.shiftTotals(J).get('2026-11');
assert.deepEqual(T, { planned: 240 + 240 + 420 + 330, worked: 240 + 0 + 240 + 330, lost: 240 + 180, days: 4, off: 1, early: 1 });
// 11月：シフトあり → 810分 = 13.5h。12月：シフトなし → 予定 30h。1月：標準 60h
const jp = M.jobPayments(J, d('2026-11-20'), d('2027-02-28'));
assert.deepEqual(jp.map(x => [M.iso(x.pay), x.source, x.amount]),
  [['2026-12-15', 'shift', 13500], ['2027-01-15', 'planned', 30000], ['2027-02-15', 'default', 60000]]);
// 15日締めなら 11/16 のシフトは 12月締めの勤務
const T15 = M.shiftTotals({ ...J, close: 15 });
assert.equal(T15.get('2026-12').worked, 330); assert.equal(T15.get('2026-11').worked, 480);

// 比較：給料日(2/15)の後に引き落とされる固定費カード 2/26 払いが最も余裕がある
const S4 = structuredClone(S); S4.purchases = S4.purchases.slice(0, 1);
const res = M.compare(S4, { label: 't', amount: 80000, count: 1 }, d('2026-12-06'), 3);
const best = res.filter(r => !r.outOfRange).sort((a, b) => b.min.balance - a.min.balance)[0];
assert.equal(best.card.id, 'f'); assert.equal(M.iso(best.payDate), '2027-02-26');
assert.equal(best.min.balance, 74077);
assert.equal(res.find(r => r.card.id === 'o' && M.iso(r.payDate) === '2027-02-04').min.balance, 61697);

// ローン：毎月27日、12回、ボーナス月(12月)に加算
const loan = { name: 'PC', amount: 10000, day: 27, first: '2026-10', count: 12, bonusAmount: 5000, bonusM1: 12 };
const sch = M.loanSchedule(loan);
assert.equal(sch.length, 12); assert.equal(M.iso(sch[0].date), '2026-10-27'); assert.equal(M.iso(sch[11].date), '2027-09-27');
assert.equal(sch[2].amount, 15000); // 12月
const ls = M.loanStatus(loan, d('2026-10-27'));
assert.deepEqual([ls.done, ls.remainCount, ls.remainTotal, M.iso(ls.last)], [1, 11, 115000, '2027-09-27']);
// 2月は28日までなので月末に寄せる（day 31）
assert.equal(M.iso(M.loanSchedule({ amount: 1, day: 31, first: '2027-02', count: 1 })[0].date), '2027-02-28');
// シミュレーションに入る
const SL = structuredClone(S); SL.loans = [loan];
const lr = M.simulate(SL).rows.filter(r => r.kind === 'loan');
assert.deepEqual(lr.map(r => [M.iso(r.date), r.amount]), [['2026-10-27', -10000], ['2026-11-27', -10000], ['2026-12-27', -15000], ['2027-01-27', -10000], ['2027-02-27', -10000]]);
// 回数未定は期間の終わりまで
assert.equal(M.loanSchedule({ amount: 1, day: 1, first: '2026-11' }, d('2027-01-31')).length, 3);

// 複数口座：カードごとに引き落とし口座、バイトは別口座
const SA = structuredClone(S);
SA.accounts = [{ id: 'm', name: 'メイン', balance: 100000 }, { id: 'y', name: 'ゆうちょ', balance: 20226 }];
SA.job.account = 'y';
SA.cards.find(c => c.id === 'o').account = 'y';
const sa = M.simulate(SA);
const fy = sa.byAccount.find(a => a.id === 'y'), fm = sa.byAccount.find(a => a.id === 'm');
assert.equal(fy.final + fm.final, sim.final);   // 合計は1口座のときと同じ
assert.equal(sa.rows.at(-1).balance, sim.rows.at(-1).balance);
assert.equal(sa.rows.find(r => r.kind === 'income').acct, 'y');
// メイン口座はバイト代が入らないので、引き落としが続くと最初に足りなくなる
assert.equal(sa.min.acct, 'm'); assert.ok(sa.min.balance < 0);
// 口座が未設定の古いデータは base.balance の1口座として扱う
assert.deepEqual(M.accountsOf({ base: { balance: 5 } }), [{ id: 'main', name: '口座', balance: 5 }]);

// サブスク：毎月10日にメインカード（15日締め翌月13日払い）
const SB = structuredClone(S); SB.bills = []; SB.recurring = []; SB.purchases = [];
SB.subs = [{ name: 'Spotify', amount: 980, cycle: 'monthly', day: 10, pay: 'card:a', from: '2026-01' },
           { name: 'iCloud', amount: 1300, cycle: 'yearly', month: 1, day: 20, pay: 'acct:main' }];
const sb = M.simulate(SB).rows.filter(r => r.kind === 'sub');
assert.deepEqual(sb.map(r => [M.iso(r.date), r.amount, r.label]), [
  ['2026-11-13', -980, 'Spotify（10/10課金）'], ['2026-12-13', -980, 'Spotify（11/10課金）'],
  ['2027-01-13', -980, 'Spotify（12/10課金）'], ['2027-01-20', -1300, 'iCloud'], ['2027-02-13', -980, 'Spotify（1/10課金）']]);
assert.equal(M.monthlyCost({ cycle: 'yearly', amount: 1200 }), 100);
// 確定した請求がある月のカード払いサブスクは請求額に含まれるので重ねない
SB.bills = [{ card: 'a', date: '2026-12-13', amount: 30000 }];
assert.equal(M.simulate(SB).rows.filter(r => r.kind === 'sub' && M.iso(r.date) === '2026-12-13').length, 0);
// 解約月（to）の後は課金しない
assert.equal(M.subCharges({ day: 10, from: '2026-10', to: '2026-11' }, d('2026-01-01'), d('2027-12-31')).length, 2);

// その他の入金：毎月25日のお小遣いと、1回だけの入金
const SC = structuredClone(S); SC.bills = []; SC.recurring = []; SC.purchases = []; SC.job.wage = 0;
SC.incomes = [{ name: 'お小遣い', amount: 10000, freq: 'monthly', day: 25, from: '2026-11', to: '2027-01' },
              { name: 'お年玉', amount: 30000, freq: 'once', date: '2027-01-01' }];
const sc = M.simulate(SC).rows.filter(r => r.kind === 'other');
assert.deepEqual(sc.map(r => [M.iso(r.date), r.amount]), [['2026-11-25', 10000], ['2026-12-25', 10000], ['2027-01-01', 30000], ['2027-01-25', 10000]]);

// 現金：入金を口座と現金に分ける・現金の支出・ATMでの引き出し
const SD = structuredClone(S); SD.bills = []; SD.recurring = []; SD.purchases = []; SD.job.wage = 0;
SD.accounts = [{ id: 'm', name: 'メイン', balance: 50000 }, { id: 'w', name: '財布', type: 'cash', balance: 3000 }];
SD.incomes = [{ name: '食事代', amount: 5000, cash: 2000, freq: 'once', date: '2026-11-01', account: 'm' }];
SD.cashOut = [{ memo: '昼ごはん', amount: 800, freq: 'once', date: '2026-11-02' }, { memo: '食費', amount: 3000, freq: 'monthly', day: 20, from: '2026-11', to: '2026-12' }];
SD.transfers = [{ memo: 'ATM', amount: 10000, freq: 'once', date: '2026-11-03', from: 'm', to: 'w' }];
const sd = M.simulate(SD);
const W = sd.byAccount.find(a => a.id === 'w'), Mn = sd.byAccount.find(a => a.id === 'm');
assert.equal(W.final, 3000 + 2000 - 800 + 10000 - 3000 - 3000);
assert.equal(Mn.final, 50000 + 5000 - 10000);
assert.equal(sd.final, 53000 + 7000 - 800 - 6000);           // 移動は合計を変えない
const nov = sd.monthly.find(m => M.ym(m.month) === '2026-11');
assert.deepEqual([nov.income, nov.outflow], [7000, 3800]);    // 移動は収入・支出に数えない
assert.equal(M.cashId(SD), 'w');
assert.equal(M.cashId({ base: {}, accounts: [{ id: 'm' }] }), null);

console.log('all tests passed');
