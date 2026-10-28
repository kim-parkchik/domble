/**
 * 分野 F・例3：飲食店＋専従者（令和7年分＝2025年の一年分）
 * 何を確かめるか：
 *  - 青色65万円、本則課税（課税売上割合 100%＝95%以上。全額控除 ⑱）、店内飲食 10%・テイクアウト 8%
 *  - 仕入：インボイスのある仕入（10%・8%）と、登録していない農家からの仕入（経過措置 80%：付表2-3 の ⑪⑫）
 *  - 専従者給与（妻。月8万円）、借入金の返済（元金＋利子。利子割引料）、減価償却（定額法：2022年7月の厨房設備・2025年6月の冷蔵庫）
 *  - カードの売上（売掛金）と、入金のときの加盟店手数料（非課税仕入）
 *  - 銀行明細の取り込み（src/lib/bankImport.ts の guessColumns・parseStatement → repo.addBankLines → ルールで推測 →
 *    重複の印 → registerBankLines）。元金と利子が1行になったローン返済は、明細の取り込みでは分けられない
 *  - 期首・期末の棚卸、未払消費税（手入力）、残高試算表・決算書・消費税（本則）・所得税（令和8年分の制度との違い。専従者の配偶者）
 * 動かし方：bun spec/audit/scenarios/s3_restaurant.ts（リポジトリの直下で）
 */
import {
  makeDb, makeBook, cashEntry, voucher, runDepreciation, yearFigures, taxReturnOf, incomeTaxOf, incomeXtxOf, setFiler, xtxVal, cmp, printTable, repo, YEAR,
  type Cmp,
} from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";
import { parseCsv } from "../../../src/lib/csv";
import { guessColumns, parseStatement, guessLine, learnFromBooks, findBookDuplicate } from "../../../src/lib/bankImport";
import { entryRateOf, splitLinesByHomeUse } from "../../../src/lib/homeUse";
import type { JournalLine } from "../../../src/lib/types";
import { carryForwardWithSubs, subClosingBalances } from "../../../src/lib/accounting";
import { prevTaxInfo, interimPlan } from "../../../src/lib/taxInterim";
import { baseSalesInfo } from "../../../src/lib/baseSales";

const { db } = makeDb("strict");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const last = (m: number) => M(m, new Date(YEAR, m, 0).getDate());

// ── 設定 ──
await repo.createAccount(db, { code: "208", name: "未払消費税等", kana: "みばらいしょうひぜいとう", category: "liability" });
await b.reload();
await repo.saveInvoiceRegistration(db, "T5555555555555", "2023-10-01");
await repo.saveTaxYear(db, { from_year: 2024, status: "standard", method: "inclusive", business_class: 4, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
await repo.saveTaxBaseManual(db, YEAR, 19_500_000);
await repo.saveTaxPrevManual(db, YEAR, 420_000); // 48万円以下なので中間申告なし
const rates = await repo.getHomeUseRates(db, YEAR);
const OWNER = await b.cp("株式会社テンポ", "T6666666666666");
const TONYA = await b.cp("食材問屋", "T7777777777777");
const SAKAYA = await b.cp("酒屋", "T8888888888888");
const FARMER = await b.cp("農家 鈴木", "", true);
const KOKO = await b.cp("日本政策金融公庫");
const sHanako = await b.sub("専従者給与", "山田 花子");
const sNhi = await b.sub("事業主貸", "国民健康保険");
const sPen = await b.sub("事業主貸", "国民年金");
const sTax = await b.sub("事業主貸", "所得税（予定納税）");

const op = (name: string) => `${b.acc(name)}:0`;
await repo.saveOpening(db, YEAR, {
  [op("現金")]: 300_000, [op("普通預金")]: 2_000_000, [op("売掛金")]: 550_000, [op("棚卸資産")]: 200_000, [op("機械装置")]: 1_512_500,
  [op("借入金")]: 3_000_000, [op("未払消費税等")]: 538_400, [op("元入金")]: 1_024_100,
});

// ── 帳簿入力・振替伝票（現金・カード売上・手数料・ローン） ──
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: last(m), book: "現金", counter: "売上高", dir: "in", amount: 1_100_000, memo: `店内飲食（現金）${m}月` });
  await cashEntry(db, b, rates, { date: last(m), book: "現金", counter: "売上高", dir: "in", amount: 90_000, memo: `テイクアウト ${m}月`, tax: "sales8" });
  await voucher(db, b, rates, last(m), [{ dr: "売掛金", drAmt: 550_000, cr: "売上高", crAmt: 550_000, memo: `カード売上 ${m}月` }]);
  await cashEntry(db, b, rates, { date: M(m, 18), book: "現金", counter: "消耗品費", dir: "out", amount: 27_500, memo: "厨房消耗品" });
  // カードの入金（前月分 550,000 − 手数料 3% 16,500）の手数料は振替伝票（非課税仕入）。入金そのものは銀行明細から
  await voucher(db, b, rates, M(m, 10), [{ dr: "支払手数料", drAmt: 16_500, drTax: { tax: "purchase_nontax" }, cr: "売掛金", crAmt: 16_500, memo: "カード加盟店手数料" }]);
  // 借入金の返済（元金 50,000＋利子 6,000）は振替伝票。明細の同じ行は「重複かも」になるはず
  await voucher(db, b, rates, M(m, 27), [
    { dr: "借入金", drAmt: 50_000, cr: "普通預金", crAmt: 56_000, memo: "公庫 返済（元金）" },
    { dr: "利子割引料", drAmt: 6_000, memo: "公庫 返済（利子）" },
  ], { cp: KOKO });
}

// ── 銀行明細（CSV）を作る ──
type T = { date: string; desc: string; out?: number; inc?: number };
const tx: T[] = [];
for (let m = 1; m <= 12; m++) {
  tx.push({ date: M(m, 10), desc: "ｶｰﾄﾞ ﾆｭｳｷﾝ ﾋﾞｰｶｰﾄﾞ", inc: 533_500 });
  tx.push({ date: M(m, 20), desc: "ﾃﾞﾝｷﾀﾞｲ", out: 60_000 });
  tx.push({ date: M(m, 20), desc: "ｶﾞｽﾀﾞｲ", out: 40_000 });
  tx.push({ date: M(m, 25), desc: "ｷｭｳﾖ ﾔﾏﾀﾞ ﾊﾅｺ", out: 80_000 });
  tx.push({ date: M(m, 25), desc: "ｼｮｸｻﾞｲ ﾄﾝﾔ", out: 522_000 });
  tx.push({ date: M(m, 25), desc: "ｻｶﾔ", out: 110_000 });
  tx.push({ date: M(m, 25), desc: "ﾉｳｶ ｽｽﾞｷ", out: 18_000 });
  if (![4, 5].includes(m)) tx.push({ date: M(m, 26), desc: "ｺｸﾎ", out: 70_000 });
  tx.push({ date: M(m, 26), desc: "ﾈﾝｷﾝ", out: 35_020 });
  tx.push({ date: M(m, 27), desc: "ﾔﾁﾝ ﾃﾝﾎﾟ", out: 200_000 });
  tx.push({ date: M(m, 27), desc: "ﾕｳｼ ﾍﾝｻｲ", out: 56_000 });
  tx.push({ date: M(m, 28), desc: "ATM ﾋｷﾀﾞｼ", out: 300_000 });
  tx.push({ date: last(m), desc: "ｹﾞﾝｷﾝ ﾆｭｳｷﾝ", inc: 1_150_000 });
}
tx.push({ date: M(3, 31), desc: "ｼｮｳﾋｾﾞｲ", out: 538_400 });
tx.push({ date: M(5, 1), desc: "ｿﾝﾎﾟ", out: 60_000 });
tx.push({ date: M(6, 15), desc: "ﾚｲｿﾞｳｺ", out: 440_000 });
tx.push({ date: M(7, 31), desc: "ｼｮﾄｸｾﾞｲ", out: 100_000 });
tx.push({ date: M(12, 1), desc: "ｼｮﾄｸｾﾞｲ", out: 100_000 });
tx.push({ date: M(9, 1), desc: "ｼﾞｷﾞｮｳｾﾞｲ", out: 75_000 });
tx.push({ date: M(12, 1), desc: "ｼﾞｷﾞｮｳｾﾞｲ", out: 75_000 });
tx.sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0));
let bal = 2_000_000;
const csvText = ["日付,摘要,お支払金額,お預り金額,差引残高", ...tx.map((t) => {
  bal += (t.inc ?? 0) - (t.out ?? 0);
  return `${t.date.replace(/-/g, "/")},${t.desc},${t.out ?? ""},${t.inc ?? ""},${bal}`;
})].join("\r\n");
await Bun.write(`${require("node:os").tmpdir()}/domble-audit-s3_bank_2025.csv`, csvText); // 確かめ用に書き出すだけ（リポジトリには置かない）

// ── 明細の取り込み（BankImportModal と同じ流れ） ──
const bankId = b.acc("普通預金");
const account = b.accounts.find((a) => a.id === bankId)!;
const map = guessColumns(parseCsv(csvText))!;
const parsed = parseStatement(csvText, map, account, YEAR);
await repo.saveBankFormat(db, bankId, null, map);
const added = await repo.addBankLines(db, bankId, null, parsed.lines, "s3_bank_2025.csv");
const again = await repo.addBankLines(db, bankId, null, parsed.lines, "s3_bank_2025.csv"); // もう一度読んでも入らない
const rule = async (keyword: string, accountName: string, o: { sub?: number; tax?: "purchase8" | "purchase10" | null; invoice?: "transitional" | null; cp?: number | null } = {}) =>
  repo.saveBankRule(db, { id: 0, keyword, direction: "any", target_account_id: bankId, account_id: b.acc(accountName), sub_account_id: o.sub ?? null, tax_code: o.tax ?? null, invoice_kind: o.invoice ?? null, counterparty_id: o.cp ?? null, memo: "" });
await rule("ｶｰﾄﾞ", "売掛金");
await rule("ｹﾞﾝｷﾝ", "現金");
await rule("ﾔﾁﾝ", "地代家賃", { cp: OWNER });
await rule("ﾃﾞﾝｷ", "水道光熱費");
await rule("ｶﾞｽ", "水道光熱費");
await rule("ｷｭｳﾖ", "専従者給与", { sub: sHanako });
await rule("ｼｮｸｻﾞｲ", "仕入高", { tax: "purchase8", cp: TONYA });
await rule("ｻｶﾔ", "仕入高", { tax: "purchase10", cp: SAKAYA });
await rule("ﾉｳｶ", "仕入高", { tax: "purchase8", invoice: "transitional", cp: FARMER });
await rule("ﾚｲｿﾞｳｺ", "工具器具備品");
await rule("ATM", "事業主貸");
await rule("ｺｸﾎ", "事業主貸", { sub: sNhi });
await rule("ﾈﾝｷﾝ", "事業主貸", { sub: sPen });
await rule("ｼｮﾄｸｾﾞｲ", "事業主貸", { sub: sTax });
await rule("ｼｮｳﾋｾﾞｲ", "未払消費税等");
await rule("ｼﾞｷﾞｮｳｾﾞｲ", "租税公課");
await rule("ｿﾝﾎﾟ", "損害保険料");
await rule("ﾕｳｼ", "借入金", { cp: KOKO });

const pending = (await repo.getBankLines(db, bankId, null)).filter((r) => r.status === "pending");
const rules = await repo.getBankRules(db);
const allLines = await repo.getLines(db, "1900-01-01", "2999-12-31");
const history = learnFromBooks(allLines, bankId, null, await repo.getBankHistory(db, bankId, null));
const used = new Set<number>();
const items: { lineId: number; date: string; lines: JournalLine[]; counterpartyId: number | null }[] = [];
const dupIds: number[] = [];
let unguessed = 0;
const hrates = await repo.getHomeUseRates(db, YEAR);
for (const r of pending) {
  const g = guessLine(r, account, rules, history);
  const dup = findBookDuplicate(r, allLines, bankId, null, used);
  if (dup) { used.add(dup); dupIds.push(r.id); continue; }
  if (!g.counterId) { unguessed++; continue; }
  const tax = { ...(g.taxCode ? { tax_code: g.taxCode } : {}), ...(g.invoice ? { invoice_kind: g.invoice } : {}) };
  const mine: JournalLine = { row_no: 1, side: r.side, account_id: bankId, sub_account_id: null, amount: r.amount, memo: g.memo };
  const other: JournalLine = { row_no: 1, side: r.side === "debit" ? "credit" : "debit", account_id: g.counterId, sub_account_id: g.counterSubId, amount: r.amount, memo: g.memo, ...tax };
  let lines = r.side === "debit" ? [mine, other] : [other, mine];
  lines = splitLinesByHomeUse(lines, entryRateOf(hrates, b.accounts), b.acc("事業主貸")).lines;
  items.push({ lineId: r.id, date: r.date, lines, counterpartyId: g.counterpartyId });
}
await repo.registerBankLines(db, items, "s3_bank_2025.csv");
await repo.setBankLinesStatus(db, dupIds, "skipped");

// 冷蔵庫・厨房設備の台帳
await repo.saveAsset(db, null, { name: "厨房設備一式", account_id: b.acc("機械装置"), acquired_on: "2022-07-01", used_on: "2022-07-01", cost: 2_200_000, method: "straight", useful_life: 8, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });
await repo.saveAsset(db, null, { name: "業務用冷蔵庫", account_id: b.acc("工具器具備品"), acquired_on: M(6, 15), used_on: M(6, 15), cost: 440_000, method: "straight", useful_life: 6, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });

// ── 決算整理 ──
await runDepreciation(db, b);
await voucher(db, b, rates, M(12, 31), [
  { dr: "期首商品棚卸高", drAmt: 200_000, cr: "棚卸資産", crAmt: 200_000, memo: "期首棚卸の振替" },
  { dr: "棚卸資産", drAmt: 240_000, cr: "期末商品棚卸高", crAmt: 240_000, memo: "期末棚卸（食材）" },
], { adjustment: true });
const pre = await taxReturnOf(db, b);
await voucher(db, b, rates, M(12, 31), [{ dr: "租税公課", drAmt: pre.r.total, cr: "未払消費税等", crAmt: pre.r.total, memo: "令和7年分 消費税等の未払計上" }], { adjustment: true });

// ── 数字を出す ──
const f = await yearFigures(db, b);
const rows: Cmp[] = [];
const ex = (label: string) => f.layout.sections.expense.find((r) => r.label === label)?.amount ?? 0;
const exExtra = (label: string) => f.layout.sections.expense.find((r) => r.extra && r.label === label)?.amount ?? null;
const lastCsv = parsed.lines[parsed.lines.length - 1];
cmp(rows, "明細：CSV から読んだ行数", tx.length, parsed.lines.length);
cmp(rows, "明細：同じ CSV をもう一度読んだときに足された行", 0, again.added);
cmp(rows, "明細：ローン返済の行が「重複かも」になった数", 12, dupIds.length);
cmp(rows, "明細：推測できなかった行", 0, unguessed);
cmp(rows, "明細：仕訳にした行", tx.length - 12, items.length);
cmp(rows, "明細：CSV の最後の残高 ＝ 帳簿の普通預金", lastCsv.balance, f.tbRow("普通預金").balance);
cmp(rows, "試算表：現金（期末）", 450_000, f.tbRow("現金").balance);
cmp(rows, "試算表：普通預金（期末）", 3_061_360, f.tbRow("普通預金").balance);
cmp(rows, "試算表：売掛金（期末）", 550_000, f.tbRow("売掛金").balance);
cmp(rows, "試算表：機械装置（期末）", 1_237_500, f.tbRow("機械装置").balance);
cmp(rows, "試算表：工具器具備品（期末）", 397_136, f.tbRow("工具器具備品").balance);
cmp(rows, "試算表：借入金（期末）", 2_400_000, f.tbRow("借入金").balance);
cmp(rows, "試算表：事業主貸（期末）", 4_920_240, f.tbRow("事業主貸").balance);
cmp(rows, "試算表：未払消費税等（期末）", 885_800, f.tbRow("未払消費税等").balance);
cmp(rows, "決算書：売上（収入）金額", 20_880_000, f.pl.revenue);
cmp(rows, "決算書：差引原価", 7_760_000, f.pl.cogs);
cmp(rows, "決算書：租税公課", 1_035_800, ex("租税公課"));
cmp(rows, "決算書：水道光熱費", 1_200_000, ex("水道光熱費"));
cmp(rows, "決算書：減価償却費", 317_864, ex("減価償却費"));
cmp(rows, "決算書：利子割引料", 72_000, ex("利子割引料"));
cmp(rows, "決算書：地代家賃", 2_400_000, ex("地代家賃"));
cmp(rows, "決算書：支払手数料（追加の欄）", 198_000, exExtra("支払手数料"));
cmp(rows, "決算書：経費計", 5_613_664, f.pl.expenses);
cmp(rows, "決算書：差引金額", 7_506_336, f.pl.beforeSpecial);
cmp(rows, "決算書：専従者給与", 960_000, f.pl.special);
cmp(rows, "決算書：青色申告特別控除前の所得金額", 6_546_336, f.pl.income);
cmp(rows, "決算書：所得金額", 5_896_336, f.pl.income - f.blue);
const fam = f.payee("専従者給与");
cmp(rows, "決算書2頁：専従者給与の内訳（山田 花子）", 960_000, fam.find((r) => r.subId === sHanako)?.gross ?? null);
const intr = f.payee("利子割引料");
cmp(rows, "決算書3頁：利子割引料の内訳（公庫）", 72_000, intr.find((r) => r.counterpartyId === KOKO)?.gross ?? null, "金融機関なので決算書には書かない（画面で「書く」を外す）");
const rentP = f.payee("地代家賃");
cmp(rows, "決算書3頁：地代家賃の内訳（株式会社テンポ）", 2_400_000, rentP.find((r) => r.counterpartyId === OWNER)?.gross ?? null);
const kit = f.deps.find((x) => x.a.name === "厨房設備一式")!.d!;
const fri = f.deps.find((x) => x.a.name === "業務用冷蔵庫")!.d!;
cmp(rows, "減価償却：厨房設備 期首の未償却残高", 1_512_500, kit.opening);
cmp(rows, "減価償却：厨房設備 本年分", 275_000, kit.depreciation);
cmp(rows, "減価償却：冷蔵庫 償却率", "0.167", fri.rate?.toFixed(3) ?? null);
cmp(rows, "減価償却：冷蔵庫 本年分（7/12。1円未満切上げ）", 42_864, fri.depreciation);
cmp(rows, "貸借対照表：資産合計", 10_856_236, f.bs.assets);
cmp(rows, "貸借対照表：貸借の差", 0, f.bs.difference);

// ── 消費税（本則） ──
const t = await taxReturnOf(db, b);
const r23 = (no: string) => t.row("2-3", no);
cmp(rows, "消費税：課税標準額（①）", 19_000_000, t.row("first", "①")?.c ?? null);
cmp(rows, "消費税：消費税額（②）", 1_466_400, t.row("first", "②")?.c ?? null);
cmp(rows, "付表2-3 ⑧ 課税売上割合", "100.00%", r23("⑧")?.note ?? null);
cmp(rows, "付表2-3 ⑨ 課税仕入れの支払対価（インボイスあり・C）", 11_954_000, r23("⑨")?.c ?? null);
cmp(rows, "付表2-3 ⑩ 課税仕入れに係る消費税額（C）", 765_392, r23("⑩")?.c ?? null);
cmp(rows, "付表2-3 ⑪ 経過措置の支払対価（C）", 216_000, r23("⑪")?.c ?? null);
cmp(rows, "付表2-3 ⑫ 経過措置の税額（80%・C）", 9_984, r23("⑫")?.c ?? null);
cmp(rows, "付表2-3 ⑱ 控除対象仕入税額（C）", 775_376, r23("⑱")?.c ?? null);
cmp(rows, "消費税：差引税額（⑨）", 691_000, t.row("first", "⑨")?.c ?? null);
cmp(rows, "消費税：譲渡割額（⑳）", 194_800, t.row("first", "⑳")?.c ?? null);
cmp(rows, "消費税：合計税額（㉖）", 885_800, t.r.total);
cmp(rows, "消費税：令和7年分の e-Tax データ（.xtx）", "書き出せる", t.xtx ? "出せない" : "書き出せる");

// ── 所得税 ──
const base: IncomeTaxInput = {
  ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-08-01",
  socialInsurance: [{ kind: "国民健康保険", amount: 700_000 }, { kind: "国民年金（本人・妻）", amount: 420_240 }],
  dependents: [{ name: "山田 一郎", relation: "子", birthday: "2008-05-01", income: 0, disability: "none", cohabiting: true, lineal: false }],
  prepaid: 200_000,
};
const it = await incomeTaxOf(db, b, base);
cmp(rows, "所得税：事業所得 ①", 5_896_336, it.v("①"));
cmp(rows, "所得税：社会保険料控除 ⑬", 1_120_240, it.v("⑬"));
cmp(rows, "所得税：扶養控除 ㉓（17歳の子）", 380_000, it.v("㉓"));
cmp(rows, "所得税：基礎控除 ㉕", 630_000, it.v("㉕"), "令和7年分：489万円超655万円以下 63万円（domble は令和8年分の67万円）");
cmp(rows, "所得税：課税される所得金額 ㉛", 3_766_000, it.v("㉛"));
cmp(rows, "所得税：税額 ㉜", 325_700, it.v("㉜"));
cmp(rows, "所得税：復興特別所得税 ㊺", 6_839, it.v("㊺"));
cmp(rows, "所得税：申告納税額 ㊿", 332_500, it.v("㊿"));
cmp(rows, "所得税：予定納税額 (51)", 200_000, it.v("(51)"));
cmp(rows, "所得税：第3期分の納める税金 (52)", 132_500, it.v("(52)"));
cmp(rows, "所得税：専従者給与の合計 (58)", 960_000, it.v("(58)"));
// 専従者の妻を「配偶者」に入れてしまったとき（青色事業専従者は控除対象配偶者にならない：所法2条1項33号）
const it2 = await incomeTaxOf(db, b, { ...base, spouse: { name: "山田 花子", relation: "妻", birthday: "1982-02-01", income: 310_000, disability: "none", cohabiting: true, lineal: false, familyEmployee: true } });
cmp(rows, "所得税：専従者の妻を配偶者に入れたときの配偶者控除", 0, it2.v("㉑㉒"), "専従者給与を受けている妻は控除対象配偶者にならない（「専従者」に印）");

// 所得税の e-Tax のデータ（申告書＋青色申告決算書）。専従者は決算書の書き込み（続柄・年齢・従事月数・仕事の内容）から
for (const [k, v] of [["relation", "妻"], ["age", "43"], ["months", "12"], ["work", "毎日・調理補助と会計"]]) await repo.saveStatementNote(db, YEAR, `family:sub:${sHanako}:${k}`, v);
await setFiler(db, { occupation: "飲食店", office_address: "東京都渋谷区道玄坂2-2-2", office_phone: "03-9999-0000", union_name: "渋谷飲食組合" });
const x = await incomeXtxOf(db, b, {
  ...base, residentTax: "special", businessTax: { otherPrefecture: false, change: "", changeDate: "" },
  spouse: { name: "山田 花子", relation: "妻", birthday: "1982-02-01", income: 310_000, disability: "none", cohabiting: true, lineal: false, familyEmployee: true },
}, { self: "123456789018", dep0: "123456789018", family0: "123456789018" });
cmp(rows, "所得税の e-Tax のデータ：書き出せるか", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
cmp(rows, "所得税の e-Tax のデータ：手続 RKO0010 の XSD に合う", "", x.invalid.slice(0, 300));
cmp(rows, "xtx：第3期分の納める税金 (52)（ABB00750）", "132500", xtxVal(x.xml, "ABB00750"));
cmp(rows, "xtx：専従者給与の合計 (58)（ABB00790）", "960000", xtxVal(x.xml, "ABB00790"));
cmp(rows, "xtx：第二表 事業専従者の氏名（ABE00020）", "山田 花子", xtxVal(x.xml, "ABE00020"));
cmp(rows, "xtx：第二表 従事月数・程度・仕事の内容（ABE00060）", "12月・毎日・調理補助と会計", xtxVal(x.xml, "ABE00060"));
cmp(rows, "xtx：第二表 配偶者の欄（専従者の妻は書かない）", "書かない", xtxVal(x.xml, "ABY00020") ?? "書かない");
cmp(rows, "xtx：第二表 事業専従者の生年月日（配偶者の欄に入れた生年月日から）", "昭和57年2月1日", /<ABE00030><gen:era>3<\/gen:era><gen:yy>57<\/gen:yy><gen:mm>2<\/gen:mm><gen:dd>1<\/gen:dd><\/ABE00030>/.test(x.xml) ? "昭和57年2月1日" : "書いていない");
cmp(rows, "xtx：第二表 親族（子）の氏名（ABY00160）", "山田 一郎", xtxVal(x.xml, "ABY00160"));
cmp(rows, "xtx：決算書 専従者給与の内訳の合計（AMF01480）", "960000", xtxVal(x.xml, "AMF01480"));
cmp(rows, "xtx：決算書 期末商品棚卸高（AMF00150）", String(f.layout.sections.cogs.find((r) => r.label === "期末商品（製品）棚卸高")?.amount ?? 0), xtxVal(x.xml, "AMF00150"));
cmp(rows, "xtx：決算書 利子割引料（AMF00330）", String(f.layout.sections.expense.find((r) => r.label === "利子割引料")?.amount ?? 0), xtxVal(x.xml, "AMF00330"));
cmp(rows, "xtx：貸借対照表 資産の期末合計（AMG00440）＝負債・資本の期末合計（AMG00760）", xtxVal(x.xml, "AMG00440"), xtxVal(x.xml, "AMG00760"));
cmp(rows, "所得税：画面で出せるか（令和7年分）", "出せる", "出せる", "年分ごとの決まりの表（令和7年分）で計算する");

// ── 翌年へ続ける（繰越・年の締め・2026年の中間申告・2027年の基準期間） ──
{
  const o = await repo.getOpening(db, YEAR);
  const next = carryForwardWithSubs(f.accounts, f.end, subClosingBalances(f.accounts, o.bySub, f.lines));
  await repo.carryForward(db, YEAR, next, true);
  const o26 = (await repo.getOpening(db, YEAR + 1)).byAccount;
  cmp(rows, "繰越：2026年の元入金（元入金＋所得＋事業主借−事業主貸）", 1_024_100 + 6_546_336 - 4_920_240, o26[b.acc("元入金")] ?? 0);
  cmp(rows, "繰越：2026年の事業主貸", 0, o26[b.acc("事業主貸")] ?? 0);
  cmp(rows, "繰越：2026年の未払消費税等", 885_800, o26[b.acc("未払消費税等")] ?? 0);
  let blocked = "";
  try { await cashEntry(db, b, rates, { date: M(12, 30), book: "現金", counter: "消耗品費", dir: "out", amount: 1_000, memo: "締めたあと" }); } catch (e) { blocked = "拒否"; }
  cmp(rows, "年の締め：締めた2025年に仕訳を足す", "拒否", blocked || "入った");
  const taxYears = await repo.getTaxYears(db);
  const prev = prevTaxInfo({ year: YEAR + 1, prevLines: f.lines, taxYears, manual: null });
  cmp(rows, "2026年の中間申告：前年（2025年）の確定消費税額（帳簿から）", 691_000, prev.amount);
  const plan = interimPlan({ year: YEAR + 1, prevTax: prev.amount, exempt: false, voluntary: false });
  cmp(rows, "2026年の中間申告：年1回・国税", 345_500, plan.national);
  cmp(rows, "2026年の中間申告：地方（×22/78・百円未満切捨て）", 97_400, plan.local);
  const bs27 = baseSalesInfo({ year: YEAR + 2, baseLines: f.lines, prevLines: [], accounts: f.accounts, taxYears, manual: null });
  cmp(rows, "2027年の基準期間（2025年）の課税売上高（帳簿から）", 19_000_000, bs27.base);
}

printTable("例3 飲食店＋専従者（本則課税・青色65万円・銀行明細の取り込み）", rows);
console.log("\n消費税の確認の一覧：", t.issues.map((i) => `[${i.level}] ${i.title}`).join(" / ") || "なし");
console.log("方式の比較：", t.all.map((x) => `${x.m}=${x.total}${x.problem ? `（${x.problem}）` : ""}`).join(" / "));
console.log("所得税のお知らせ（妻を入れたとき）：", it2.r.notes.join(" / ") || "なし");
console.log(`明細の取り込みで足された行： ${added.added}（前に読んでいた行 ${added.known}）／ 読み取りの問題： ${parsed.problems.length}`);
