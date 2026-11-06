/**
 * 分野 F・例6（2026-11-04 に足した）：赤字の年（損失申告）と翌年以後の繰越控除
 * 何を確かめるか（青色65万円・消費税は免税事業者）：
 *  - 2024年（令和6年分）：売上 1,000,000円・経費 3,000,000円 → 純損失 2,000,000円（青色申告特別控除は 0）。第四表を使う
 *  - 2025年（令和7年分）：特別控除前 2,150,000円 → 事業所得 1,500,000円。繰越損失 2,000,000円のうち 1,500,000円を差し引き、500,000円が残る（第四表を使う）
 *      基礎控除は合計所得金額（繰越控除の前）1,500,000円で 88万円。源泉徴収 100,000円は全額還付
 *  - 2026年（令和8年分）：特別控除前 3,000,000円 → 事業所得 2,350,000円。2024年分の残り 500,000円を差し引いて終わり（第一表だけ）
 *  - 前の年の繰越損失を、保存した前の年の所得税の入力と帳簿から引き継ぐ（画面の carriedFromPast と同じ）
 *  - e-Tax のデータ（第四表を含む）が XSD に合うか
 * 動かし方：bun s7_loss.ts
 */
import { makeDb, makeBook, cashEntry, incomeTaxScreen, incomeXtxScreen, setFiler, xtxVal, cmp, printTable, repo, type Cmp } from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";

const { db } = makeDb("strict");
const b = await makeBook(db);
const D = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
await repo.saveFilingYear(db, 2024, "blue65");
const rates = await repo.getHomeUseRates(db, 2025);
for (const y of [2024, 2025, 2026]) await repo.saveOpening(db, y, { [`${b.acc("普通預金")}:0`]: 5_000_000, [`${b.acc("元入金")}:0`]: 5_000_000 });

// 2024年：赤字
await cashEntry(db, b, rates, { date: D(2024, 6, 30), book: "普通預金", counter: "売上高", dir: "in", amount: 1_000_000, memo: "売上", tax: "none" });
await cashEntry(db, b, rates, { date: D(2024, 3, 31), book: "普通預金", counter: "外注工賃", dir: "out", amount: 3_000_000, memo: "外注", tax: "none" });
// 2025年
await cashEntry(db, b, rates, { date: D(2025, 6, 30), book: "普通預金", counter: "売上高", dir: "in", amount: 3_000_000, memo: "売上", tax: "none" });
await cashEntry(db, b, rates, { date: D(2025, 3, 31), book: "普通預金", counter: "外注工賃", dir: "out", amount: 850_000, memo: "外注", tax: "none" });
// 2026年
await cashEntry(db, b, rates, { date: D(2026, 6, 30), book: "普通預金", counter: "売上高", dir: "in", amount: 4_000_000, memo: "売上", tax: "none" });
await cashEntry(db, b, rates, { date: D(2026, 3, 31), book: "普通預金", counter: "外注工賃", dir: "out", amount: 1_000_000, memo: "外注", tax: "none" });

const rows: Cmp[] = [];
const base: IncomeTaxInput = { ...EMPTY_INCOME_TAX_INPUT, birthday: "1985-01-01", socialInsurance: [{ kind: "国民健康保険", amount: 300_000 }] };

// ── 2024年（令和6年分） ──
const in24 = base;
await repo.saveIncomeTaxInput(db, 2024, in24);
const r24 = await incomeTaxScreen(db, b, in24, 2024);
cmp(rows, "2024年：青色申告特別控除前の所得金額", -2_000_000, r24.biz.incomeBeforeBlue);
cmp(rows, "2024年：青色申告特別控除額（赤字なので 0）", 0, r24.r.rows.find((r) => r.label === "青色申告特別控除額")?.value ?? null);
cmp(rows, "2024年：事業所得 ①", -2_000_000, r24.v("①"));
cmp(rows, "2024年：第四表を使う", true, r24.r.loss.fourth);
cmp(rows, "2024年：第四表 青色申告者の損失の金額（純損失）", 2_000_000, r24.r.loss.blueLoss);
cmp(rows, "2024年：⑫ は書かない（第四表）", "書かない", r24.v("⑫") === null ? "書かない" : String(r24.v("⑫")));
cmp(rows, "2024年：税額", 0, r24.r.rows.find((r) => r.label.startsWith("上の"))?.value ?? null);

// ── 2025年（令和7年分） ──
const in25: IncomeTaxInput = { ...base, businessWithholding: [{ item: "報酬", payer: "株式会社エー", payerId: "東京都港区港南1-1-1", income: 1_000_000, withheld: 102_100 }] };
await repo.saveIncomeTaxInput(db, 2025, in25);
const r25 = await incomeTaxScreen(db, b, in25, 2025);
cmp(rows, "2025年：前年から引き継いだ繰越損失（2024年分）", 2_000_000, r25.carried.find((c) => c.year === 2024)?.amount ?? null, "前の年の保存した入力と帳簿から");
cmp(rows, "2025年：事業所得 ①（2,150,000 − 650,000）", 1_500_000, r25.v("①"));
cmp(rows, "2025年：本年分で差し引く損失額 Ⓑ", 1_500_000, r25.r.loss.carry.find((c) => c.year === 2024)?.used ?? null);
cmp(rows, "2025年：翌年分以後に繰り越す損失額 Ⓒ", 500_000, r25.r.loss.carry.find((c) => c.year === 2024)?.after ?? null);
cmp(rows, "2025年：第四表を使う（繰越損失が残る）", true, r25.r.loss.fourth);
cmp(rows, "2025年：基礎控除（合計所得金額 1,500,000円・令和7年分 88万円）", 880_000, r25.r.rows.find((r) => r.label === "基礎控除")?.value ?? null);
cmp(rows, "2025年：所得税額", 0, r25.r.rows.find((r) => r.label.startsWith("上の"))?.value ?? null);
cmp(rows, "2025年：還付される税金（源泉徴収 102,100 を全額）", 102_100, r25.k("refund"));
await setFiler(db, { refund_mode: "bank", bank_name: "みずほ", branch_name: "渋谷", account_no: "1234567" });
const x25 = await incomeXtxScreen(db, b, in25, r25, 2025);
cmp(rows, "2025年：e-Tax のデータ（第四表つき）が書き出せる", "書き出せる", x25.problems.length ? "出せない" : "書き出せる", x25.problems.join(" / "));
cmp(rows, "2025年：e-Tax のデータが XSD に合う", "", x25.invalid);
cmp(rows, "2025年：e-Tax ⑫ を書かない（ABB00410）", "書かない", xtxVal(x25.xml, "ABB00410") ?? "書かない");

// ── 2026年（令和8年分） ──
const in26 = base;
const r26 = await incomeTaxScreen(db, b, in26, 2026);
cmp(rows, "2026年：引き継いだ繰越損失（2024年分の残り）", 500_000, r26.carried.find((c) => c.year === 2024)?.amount ?? null);
cmp(rows, "2026年：事業所得 ①（3,000,000 − 650,000）", 2_350_000, r26.v("①"));
cmp(rows, "2026年：第四表を使わない（使い切る）", false, r26.r.loss.fourth);
cmp(rows, "2026年：本年分で差し引く繰越損失額", 500_000, r26.r.rows.find((r) => r.label === "本年分で差し引く繰越損失額")?.value ?? null);
cmp(rows, "2026年：⑫（2,350,000 − 500,000）", 1_850_000, r26.v("⑫"));
cmp(rows, "2026年：基礎控除（合計所得金額 2,350,000円・令和8年分 104万円）", 1_040_000, r26.r.rows.find((r) => r.label === "基礎控除")?.value ?? null);
cmp(rows, "2026年：課税される所得金額（1,850,000 − 300,000 − 1,040,000）", 510_000, r26.k("taxable"));
cmp(rows, "2026年：納める税金（25,500 + 535 → 百円未満切捨て）", 26_000, r26.k("pay"));

// 3年を過ぎた損失：2024年分を2028年に残していたら引けない（手で入れた繰越損失で確かめる）
{
  const manual: IncomeTaxInput = { ...base, carry: { mode: "manual", amounts: [300_000, 0, 0] } }; // 3年前（2023年分）の残り
  const r = await incomeTaxScreen(db, b, manual, 2026); // 手で入れた [3年前=2023年分 300,000円, 0, 0]
  cmp(rows, "3年前の年分の損失は翌年に繰り越せない（Ⓒ は書かない）", "書かない", r.r.loss.carry[0].after === null ? "書かない" : String(r.r.loss.carry[0].after));
  cmp(rows, "3年前の年分の残り 300,000円を本年で差し引く", 300_000, r.r.loss.carry[0].used);
}

printTable("例6 赤字の年と翌年以後の繰越控除（青色65万円）", rows);
console.log("\n2024年のお知らせ：", r24.r.notes.join(" / ") || "なし");
console.log("2025年のお知らせ：", r25.r.notes.join(" / ") || "なし");
console.log("2026年のお知らせ：", r26.r.notes.join(" / ") || "なし");
