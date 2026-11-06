/**
 * 分野 F・例5（2026-11-04 に足した）：前年の消費税が48万円を超え、中間申告がある人（令和7年分・本則課税）
 * 何を確かめるか：
 *  - 前年の確定消費税額（⑨ 1,200,000円・手で入れた額）から、年1回・国 600,000円・地方 169,200円・期限 9/1（8/31 は日曜）
 *  - 上半期の売上が少ないので「仮決算」で申告（1〜6月の帳簿だけで計算：国 234,000円・地方 66,000円）→ 保存 → 「判定した額を入れる」
 *  - 確定申告の ⑩・㉑ が仮決算の額になり、⑪・㉒・㉖ が手計算と合うか。確認の一覧
 *  - 仮決算の e-Tax のデータ（申告の種類 2:中間）が XSD に合うか
 *  - 年3回（前年 ⑨ 4,800,000円）の予定と期限（5/31 土 → 6/2、8/31 日 → 9/1、11/30 日 → 12/1）
 * 動かし方：bun s6_interim.ts
 */
import { makeDb, makeBook, cashEntry, voucher, taxReturnOf, taxXtxOf, cmp, printTable, repo, YEAR, type Cmp } from "./common";
import { interimPlan, interimRows, interimTotal, prevTaxInfo, provisionalReturn } from "../../../src/lib/taxInterim";
import { buildTaxSummary, taxChecks } from "../../../src/lib/taxSummary";
import { yearEnd, yearStart } from "../../../src/lib/accounting";

const { db } = makeDb("strict");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

await repo.saveInvoiceRegistration(db, "T1234567890123", "2023-10-01");
await repo.saveTaxYear(db, { from_year: 2023, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
await repo.saveTaxBaseManual(db, YEAR, 18_000_000);
await repo.saveTaxPrevManual(db, YEAR, 1_200_000);
const rates = await repo.getHomeUseRates(db, YEAR);
const SUP = await b.cp("仕入先", "T2222222222222");
await repo.saveOpening(db, YEAR, { [`${b.acc("普通預金")}:0`]: 3_000_000, [`${b.acc("元入金")}:0`]: 3_000_000 });
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: M(m, 25), book: "普通預金", counter: "売上高", dir: "in", amount: m <= 6 ? 1_100_000 : 2_200_000, memo: `売上 ${m}月` });
  await voucher(db, b, rates, M(m, 20), [{ dr: "外注工賃", drAmt: 550_000, cr: "普通預金", crAmt: 550_000, memo: `外注 ${m}月` }], { cp: SUP });
}

const rows: Cmp[] = [];
const holidays = new Set((await repo.getHolidayData(db)).holidays.map((h) => h.date));
const taxYears = await repo.getTaxYears(db);
const prevLines = await repo.getLines(db, yearStart(YEAR - 1), yearEnd(YEAR - 1));
const prev = prevTaxInfo({ year: YEAR, prevLines, taxYears, manual: await repo.getTaxPrevManual(db, YEAR) });
const plan = interimPlan({ year: YEAR, prevTax: prev.amount, exempt: false, voluntary: false, holidays });
cmp(rows, "中間申告：回数（前年 ⑨ 1,200,000円）", "once", plan.kind);
cmp(rows, "中間申告：前年の実績・国（× 6/12）", 600_000, plan.national);
cmp(rows, "中間申告：前年の実績・地方（× 22/78・百円未満切捨て）", 169_200, plan.local);
cmp(rows, "中間申告：期限（8/31 は日曜）", "2025-09-01", plan.periods[0]?.payBy ?? null);

// 仮決算（TaxInterimView の ProvisionalSection と同じ）
const lines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
const p = provisionalReturn({ period: plan.periods[0], lines, taxYears, method: "standard", options: { businessClass: 5, baseSales: 18_000_000, deduction: "individual" } });
cmp(rows, "仮決算：課税標準額（1〜6月 6,600,000 × 100/110）", 6_000_000, p.r.forms.find((f) => f.id === "first")?.rows.find((r) => r.no === "①")?.c ?? null);
cmp(rows, "仮決算：控除対象仕入税額（3,300,000 × 7.8/110）", 234_000, p.r.forms.find((f) => f.id === "first")?.rows.find((r) => r.no === "④")?.c ?? null);
cmp(rows, "仮決算：中間納付税額（国）", 234_000, p.national);
cmp(rows, "仮決算：中間納付譲渡割額（地方。234,000 × 22/78）", 66_000, p.local);
const ix = await taxXtxOf(db, p.r, { interim: { from: plan.periods[0].from, to: plan.periods[0].to } });
cmp(rows, "仮決算の e-Tax のデータ（申告の種類 2:中間）：XSD に合う", "", ix.error || ix.invalid);
cmp(rows, "仮決算の e-Tax：申告の種類（中間）", true, /<AAI00170>|<AAI00180>/.test(ix.xml), "第一表 中間申告の場合の対象期間の欄がある");

await repo.saveInterimProvisional(db, YEAR, { from: plan.periods[0].from, to: plan.periods[0].to, method: "standard", national: p.national, local: p.local, filed_on: "2025-08-25" });
await cashEntry(db, b, rates, { date: "2025-08-25", book: "普通預金", counter: "租税公課", dir: "out", amount: 300_000, memo: "消費税の中間納付（仮決算）" });
const irows = interimRows(plan, await repo.getInterimProvisionals(db, YEAR));
const total = interimTotal(irows);
cmp(rows, "中間申告の合計（仮決算の額）：国", 234_000, total.national);
cmp(rows, "中間申告の合計（仮決算の額）：地方", 66_000, total.local);
// 確認の一覧（「判定した額を入れる」の前）：入っていなければ知らせる
{
  const allLines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
  const issues = taxChecks({
    year: YEAR, lines: allLines, accounts: b.accounts, counterparties: await repo.getCounterparties(db), taxYears, invoiceNo: "T1234567890123", registeredOn: "2023-10-01",
    summary: buildTaxSummary(allLines, b.accounts, taxYears), interim: { plan, entered: await repo.getTaxInterim(db, YEAR), total },
  } as Parameters<typeof taxChecks>[0]);
  cmp(rows, "確認の一覧：中間納付税額が入っていないことを知らせる", "知らせる", issues.some((i) => i.title.includes("中間納付税額が入っていません")) ? "知らせる" : "知らせない");
}
await repo.saveTaxInterim(db, YEAR, total.national, total.local); // 「判定した額を入れる」
const t = await taxReturnOf(db, b);
const first = (no: string) => t.row("first", no)?.c ?? null;
cmp(rows, "確定申告：課税標準額 ①（19,800,000 × 100/110）", 18_000_000, first("①"));
cmp(rows, "確定申告：消費税額 ②", 1_404_000, first("②"));
cmp(rows, "確定申告：控除対象仕入税額 ④（6,600,000 × 7.8/110）", 468_000, first("④"));
cmp(rows, "確定申告：差引税額 ⑨", 936_000, first("⑨"));
cmp(rows, "確定申告：中間納付税額 ⑩（仮決算）", 234_000, first("⑩"));
cmp(rows, "確定申告：納付税額 ⑪", 702_000, first("⑪"));
cmp(rows, "確定申告：譲渡割額 ⑳（936,000 × 22/78）", 264_000, first("⑳"));
cmp(rows, "確定申告：中間納付譲渡割額 ㉑", 66_000, first("㉑"));
cmp(rows, "確定申告：納付譲渡割額 ㉒", 198_000, first("㉒"));
cmp(rows, "確定申告：合計 ㉖", 900_000, t.r.total);
{
  const allLines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
  const issues = taxChecks({
    year: YEAR, lines: allLines, accounts: b.accounts, counterparties: await repo.getCounterparties(db), taxYears, invoiceNo: "T1234567890123", registeredOn: "2023-10-01",
    summary: buildTaxSummary(allLines, b.accounts, taxYears), interim: { plan, entered: await repo.getTaxInterim(db, YEAR), total },
  } as Parameters<typeof taxChecks>[0]);
  cmp(rows, "確認の一覧：入れたあとは中間申告の知らせなし", "なし", issues.filter((i) => i.fix === "return" || i.fix === "interim").map((i) => i.title).join(" / ") || "なし");
}
const fx = await taxXtxOf(db, t.r);
cmp(rows, "確定申告の e-Tax のデータ：XSD に合う", "", fx.error || fx.invalid);
cmp(rows, "確定申告の e-Tax：中間納付税額の欄に 234000", true, fx.xml.includes(">234000<"));

// 翌年（2026年）の中間申告：2025年の ⑨ 936,000円 → 年1回 468,000円・地方 132,000円（468,000 × 22/78 = 132,000）
{
  const p26 = prevTaxInfo({ year: YEAR + 1, prevLines: await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR)), taxYears, manual: null });
  const plan26 = interimPlan({ year: YEAR + 1, prevTax: p26.amount, exempt: false, voluntary: false, holidays });
  cmp(rows, "翌年：前年（2025年）の ⑨（帳簿から）", 936_000, p26.amount);
  cmp(rows, "翌年：中間申告 国（× 6/12）", 468_000, plan26.national);
  cmp(rows, "翌年：中間申告 地方", 132_000, plan26.local);
  cmp(rows, "翌年：期限（2026-08-31 は月曜）", "2026-08-31", plan26.periods[0]?.payBy ?? null);
}

// 年3回（前年 ⑨ 4,800,000円）の予定と期限
{
  const p3 = interimPlan({ year: YEAR, prevTax: 4_800_000, exempt: false, voluntary: false, holidays });
  cmp(rows, "年3回：回数", "three", p3.kind);
  cmp(rows, "年3回：1回分 国（× 3/12）", 1_200_000, p3.periods[0]?.national ?? null);
  cmp(rows, "年3回：1回分 地方（× 22/78）", 338_400, p3.periods[0]?.local ?? null);
  cmp(rows, "年3回：1回目の期限（5/31 は土曜）", "2025-06-02", p3.periods[0]?.payBy ?? null);
  cmp(rows, "年3回：2回目の期限（8/31 は日曜）", "2025-09-01", p3.periods[1]?.payBy ?? null);
  cmp(rows, "年3回：3回目の期限（11/30 は日曜）", "2025-12-01", p3.periods[2]?.payBy ?? null);
  // 400万円ちょうどは年1回、4,800万円超は年11回（1月分・2月分の期限は 5/31）
  cmp(rows, "前年 ⑨ 4,000,000円ちょうどは年1回", "once", interimPlan({ year: YEAR, prevTax: 4_000_000, exempt: false, voluntary: false }).kind);
  cmp(rows, "前年 ⑨ 480,000円ちょうどは要らない", "none", interimPlan({ year: YEAR, prevTax: 480_000, exempt: false, voluntary: false }).kind);
  const p11 = interimPlan({ year: YEAR, prevTax: 60_000_000, exempt: false, voluntary: false, holidays });
  cmp(rows, "年11回：1月分の期限（5/31 土 → 6/2）", "2025-06-02", p11.periods[0]?.payBy ?? null);
  cmp(rows, "年11回：11月分の期限（1/31 土 → 2026-02-02）", "2026-02-02", p11.periods[10]?.payBy ?? null);
}

printTable("例5 中間申告がある人（前年の実績と仮決算・本則課税）", rows);
console.log("\n確定申告の確認の一覧：", t.issues.map((i) => `[${i.level}] ${i.title}`).join(" / ") || "なし");
