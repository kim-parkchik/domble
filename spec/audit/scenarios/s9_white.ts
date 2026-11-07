/**
 * 分野 F・例8（2026-11-04 に足した）：白色申告の小売店（令和7年分・消費税は免税・妻が事業専従者）
 * 何を確かめるか：
 *  - 申告の種類を年ごとに「白色」にする（saveFilingYear）
 *  - 収支内訳書（一般用）の数字：売上・売上原価（棚卸は決算整理の画面）・経費・⑲ 専従者控除前・⑳ 専従者控除・㉑ 所得金額
 *  - 帳簿に専従者給与を付けてしまっても、白色では経費にしない
 *  - 事業専従者控除（所法57③。国税庁 No.2075）：配偶者 86万円・ほか 50万円と、控除前の所得 ÷（専従者の数＋1）の低い方。6か月以下は対象外
 *  - 所得税：① は ㉑、(58) 専従者控除額、専従者の妻に配偶者控除を付けない、青色申告特別控除は無い
 *  - e-Tax のデータ（KOA020・KOA110）。第二表の事業専従者の欄は、白色は「従事月数・程度・仕事の内容」
 * 動かし方：bun s9_white.ts
 */
import { makeDb, makeBook, cashEntry, voucher, runInventory, incomeTaxScreen, incomeXtxScreen, setFiler, xtxVal, cmp, printTable, repo, YEAR, type Cmp } from "./common";
import { EMPTY_INCOME_TAX_INPUT, emptyRelative, type IncomeTaxInput } from "../../../src/lib/incomeTax";
import { familyDeductions } from "../../../src/lib/whiteStatement";

const { db } = makeDb("strict");
await repo.saveFilingYear(db, YEAR, "white");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const rates = await repo.getHomeUseRates(db, YEAR);
await repo.saveOpening(db, YEAR, { [`${b.acc("現金")}:0`]: 500_000, [`${b.acc("棚卸資産")}:0`]: 300_000, [`${b.acc("元入金")}:0`]: 800_000 });
const sWife = await b.sub("専従者給与", "山田 花子");
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: M(m, 28), book: "現金", counter: "売上高", dir: "in", amount: 500_000, memo: `売上 ${m}月`, tax: "none" });
  await cashEntry(db, b, rates, { date: M(m, 20), book: "現金", counter: "地代家賃", dir: "out", amount: 50_000, memo: "店舗家賃", tax: "none" });
  await cashEntry(db, b, rates, { date: M(m, 15), book: "現金", counter: "水道光熱費", dir: "out", amount: 20_000, memo: "電気", tax: "none" });
  // 白色申告なのに、妻への給与を「専従者給与」に付けてしまった（経費にならない）
  await cashEntry(db, b, rates, { date: M(m, 25), book: "現金", counter: "専従者給与", counterSub: sWife, dir: "out", amount: 80_000, memo: "妻の給与", tax: "none" });
}
for (const q of [1, 4, 7, 10]) await voucher(db, b, rates, M(q, 10), [{ dr: "仕入高", drAmt: 625_000, drTax: { tax: "none" }, cr: "現金", crAmt: 625_000, memo: "仕入" }]);
await cashEntry(db, b, rates, { date: M(5, 10), book: "現金", counter: "消耗品費", dir: "out", amount: 160_000, memo: "包装資材", tax: "none" });
await voucher(db, b, rates, M(4, 1), [{ dr: "工具器具備品", drAmt: 500_000, cr: "現金", crAmt: 500_000, memo: "陳列棚" }]);
await repo.saveAsset(db, null, { name: "陳列棚", account_id: b.acc("工具器具備品"), acquired_on: M(4, 1), used_on: M(4, 1), cost: 500_000, method: "straight", useful_life: 5, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });
const { depreciationLines } = await import("../../../src/lib/depreciation");
await repo.saveDepreciationRun(db, YEAR, depreciationLines(await repo.getAssets(db), YEAR, { expense: b.acc("減価償却費"), draw: b.acc("事業主貸") }));
await runInventory(db, b, 400_000);

const rows: Cmp[] = [];
const wife = { ...emptyRelative("妻"), name: "山田 花子", birthday: "1980-03-03", income: 0, familyEmployee: true, months: 12, work: "毎日・販売と経理" };
const input: IncomeTaxInput = { ...EMPTY_INCOME_TAX_INPUT, outside: "none", birthday: "1978-08-08", socialInsurance: [{ kind: "国民健康保険", amount: 250_000 }], spouse: wife, residentTax: "self" };
const it = await incomeTaxScreen(db, b, input);
await setFiler(db, { occupation: "小売業" });
const x = await incomeXtxScreen(db, b, input, it, YEAR, { self: "123456789018", family0: "123456789018" });
const w = x.whiteSt!;
cmp(rows, "申告の種類（2025年）", "white", await repo.filingTypeIn(db, YEAR));
cmp(rows, "収支内訳書 ④ 収入金額の計", 6_000_000, w.revenue.total);
cmp(rows, "収支内訳書 ⑨ 差引原価（300,000 ＋ 2,500,000 − 400,000）", 2_400_000, w.cogs.cost);
cmp(rows, "収支内訳書：減価償却費（500,000 × 0.200 × 9/12）", 75_000, w.mainExpenses.find((e) => e.label === "減価償却費")?.amount ?? null);
cmp(rows, "収支内訳書 ⑱ 経費計（専従者給与は入れない）", 1_075_000, w.expenseTotal);
cmp(rows, "収支内訳書：帳簿の専従者給与（経費にしない）", 960_000, w.familySalaryBooked);
cmp(rows, "収支内訳書 ⑲ 専従者控除前の所得金額", 2_525_000, w.beforeDeduction);
cmp(rows, "収支内訳書 ⑳ 専従者控除（86万円 と 2,525,000 ÷ 2 の低い方）", 860_000, w.familyDeduction);
cmp(rows, "収支内訳書 ㉑ 所得金額", 1_665_000, w.income);
cmp(rows, "所得税 ㋐ 収入金額", 6_000_000, it.v("㋐"));
cmp(rows, "所得税 ① 事業所得", 1_665_000, it.v("①"));
cmp(rows, "所得税 配偶者控除（専従者の妻は 0）", 0, it.v("㉑㉒"));
cmp(rows, "所得税 青色申告特別控除額", 0, it.r.rows.find((r) => r.label === "青色申告特別控除額")?.value ?? null);
cmp(rows, "所得税 (58) 専従者給与（控除）額の合計額", 860_000, it.r.rows.find((r) => r.label === "専従者給与（控除）額の合計額")?.value ?? null);
cmp(rows, "所得税 基礎控除（令和7年分 88万円）", 880_000, it.r.rows.find((r) => r.label === "基礎控除")?.value ?? null);
cmp(rows, "所得税 課税される所得金額（1,665,000 − 1,130,000）", 535_000, it.k("taxable"));
cmp(rows, "所得税 納める税金（26,750 ＋ 561 → 27,300）", 27_300, it.k("pay"));
cmp(rows, "e-Tax：書き出せる", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
cmp(rows, "e-Tax：XSD に合う（KOA020・KOA110）", "", x.invalid);
cmp(rows, "e-Tax：収支内訳書（KOA110）がある・青色申告決算書（KOA210）が無い", "KOA110", x.xml.includes("<KOA110") && !x.xml.includes("<KOA210") ? "KOA110" : "違う");
cmp(rows, "e-Tax：第二表 事業専従者の従事月数・程度・仕事の内容（白色）", "12月・毎日・販売と経理", xtxVal(x.xml, "ABE00060"));
cmp(rows, "e-Tax：第二表 専従者控除額（ABE00070）", "860000", xtxVal(x.xml, "ABE00070"));

// 事業専従者が2人（妻・20歳の子 10か月）と、6か月以下の人
const fl = familyDeductions(2_525_000, [
  { from: "spouse", name: "山田 花子", relation: "妻", birthday: "1980-03-03", spouse: true, months: 12, work: "" },
  { from: "dep0", name: "山田 一郎", relation: "子", birthday: "2005-04-01", spouse: false, months: 10, work: "" },
  { from: "dep1", name: "山田 次郎", relation: "子", birthday: "2007-04-01", spouse: false, months: 6, work: "" },
], YEAR);
cmp(rows, "専従者2人：妻（2,525,000 ÷ 3 = 841,666 が 86万円より低い）", 841_666, fl[0].deduction);
cmp(rows, "専従者2人：子（50万円）", 500_000, fl[1].deduction);
cmp(rows, "6か月の子は事業専従者にならない", 0, fl[2].deduction, fl[2].problem);

printTable("例8 白色申告の小売店（事業専従者控除）", rows);
console.log("\n収支内訳書の知らせ：", w.warnings.join(" / ") || "なし");
console.log("所得税のお知らせ：", it.r.notes.join(" / ") || "なし");
