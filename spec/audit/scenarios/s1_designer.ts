/**
 * 分野 F・例1：フリーランスのデザイナー（令和7年分＝2025年の一年分）
 * 何を確かめるか：
 *  - 青色65万円、令和5年10月1日にインボイス登録して2割特例（tax_years 2023 から twenty。2025 は引き継ぎ）
 *  - 報酬の源泉徴収（10.21%。本体 30万円 × 10.21% = 30,630円）を振替伝票で「普通預金＋事業主貸 / 売上高」
 *  - 家事按分：地代家賃 30%（入力のたびに：帳簿入力）、通信費 60%（年末にまとめて：家事按分の年末の振替）
 *  - 減価償却：ノートPC 330,000円（4月取得・定額法4年・事業専用90%）、タブレット 165,000円（少額減価償却資産・措法28の2）
 *  - 国保・国民年金・小規模企業共済・ふるさと納税（事業主貸の補助科目）、配偶者（給与収入125万円 → 合計所得金額60万円）
 *  - 残高試算表（buildTrialBalance）・決算書（summarizeIncome・statementLayout・payeeBreakdown・depreciationFor）
 *  - 消費税（buildTaxBase・computeReturn の 2割特例）と、令和7年分の e-Tax データ（xtxProblem）
 *  - 所得税（computeIncomeTax。令和8年分の制度で作られている）と、令和7年分の正しい額の違い
 * 動かし方：bun spec/audit/scenarios/s1_designer.ts（リポジトリの直下で）
 */
import {
  makeDb, makeBook, cashEntry, voucher, runDepreciation, runHomeUseYearEnd, yearFigures, taxReturnOf, incomeTaxOf, incomeXtxOf, setFiler, xtxVal, cmp, printTable, repo,
  YEAR, type Cmp,
} from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";

const { db } = makeDb("strict");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ── 設定 ──
await repo.saveInvoiceRegistration(db, "T1234567890123", "2023-10-01");
await repo.saveTaxYear(db, { from_year: 2023, status: "twenty", method: "inclusive", business_class: 5, taxable_from: "2023-10-01", deduction: "individual", voluntary_interim: 0 });
await repo.saveTaxBaseManual(db, YEAR, 3_500_000); // 基準期間（2023年）の課税売上高
await repo.saveTaxPrevManual(db, YEAR, 56_000); // 2024年の ⑨ 差引税額（中間申告なし）
await repo.saveHomeUseRate(db, YEAR, { account_id: b.acc("地代家賃"), rate: 30, method: "entry", basis: "自宅の床面積のうち仕事部屋" });
await repo.saveHomeUseRate(db, YEAR, { account_id: b.acc("通信費"), rate: 60, method: "yearend", basis: "使用時間" });
const rates = await repo.getHomeUseRates(db, YEAR);

const X = await b.cp("株式会社エックス", "T9876543210987");
const Y = await b.cp("ワイ商店");
const LANDLORD = await b.cp("大家 太郎");
const ILL = await b.cp("イラスト 花子", "", true);
const sWith = await b.sub("事業主貸", "源泉所得税");
const sNhi = await b.sub("事業主貸", "国民健康保険");
const sPen = await b.sub("事業主貸", "国民年金");
const sKyo = await b.sub("事業主貸", "小規模企業共済");
const sFuru = await b.sub("事業主貸", "寄附金（ふるさと納税）");

// ── 期首残高 ──
await repo.saveOpening(db, YEAR, { [`${b.acc("普通預金")}:0`]: 1_500_000, [`${b.acc("元入金")}:0`]: 1_500_000 });

// ── 売上 ──
for (let m = 1; m <= 12; m++) {
  // 本体 300,000・消費税 30,000。源泉徴収は本体 × 10.21% = 30,630（請求書で本体と消費税を分けているので本体だけに掛ける）
  await voucher(db, b, rates, M(m, 25), [
    { dr: "普通預金", drAmt: 299_370, cr: "売上高", crAmt: 330_000, memo: `デザイン料 ${m}月分` },
    { dr: "事業主貸", drSub: sWith, drAmt: 30_630, memo: `源泉所得税 ${m}月分` },
  ], { cp: X });
}
await cashEntry(db, b, rates, { date: M(3, 20), book: "普通預金", counter: "売上高", dir: "in", amount: 220_000, memo: "ロゴ制作", cp: Y });
await voucher(db, b, rates, M(12, 20), [{ dr: "売掛金", drAmt: 110_000, cr: "売上高", crAmt: 110_000, memo: "チラシ制作" }], { cp: Y });

// ── 経費 ──
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: M(m, 27), book: "普通預金", counter: "地代家賃", dir: "out", amount: 120_000, memo: `家賃 ${m}月分`, cp: LANDLORD, tax: "purchase_nontax" });
  await cashEntry(db, b, rates, { date: M(m, 10), book: "普通預金", counter: "通信費", dir: "out", amount: 11_000, memo: `携帯・光回線 ${m}月分` });
  await cashEntry(db, b, rates, { date: M(m, 25), book: "普通預金", counter: "支払手数料", dir: "out", amount: 550, memo: "振込手数料" });
  await cashEntry(db, b, rates, { date: M(m, 5), book: "普通預金", counter: "事業主貸", counterSub: sPen, dir: "out", amount: 17_510, memo: "国民年金" });
  await cashEntry(db, b, rates, { date: M(m, 5), book: "普通預金", counter: "事業主貸", counterSub: sKyo, dir: "out", amount: 30_000, memo: "小規模企業共済" });
  await cashEntry(db, b, rates, { date: M(m, 28), book: "普通預金", counter: "事業主貸", dir: "out", amount: 150_000, memo: "生活費" });
}
for (const m of [1, 2, 3, 7, 8, 9, 10, 11]) {
  await cashEntry(db, b, rates, { date: M(m, 30 > 28 && m === 2 ? 28 : 30), book: "普通預金", counter: "事業主貸", counterSub: sNhi, dir: "out", amount: 45_000, memo: "国民健康保険" });
}
for (const [m, d, a] of [[2, 5, 22_000], [5, 12, 33_000], [8, 20, 11_000], [11, 15, 22_000]] as const) {
  await cashEntry(db, b, rates, { date: M(m, d), book: "普通預金", counter: "消耗品費", dir: "out", amount: a, memo: "画材・周辺機器" });
}
for (const [m, d] of [[4, 3], [7, 14], [10, 21]] as const) {
  // 自分のカードで払った交通費（事業主借の帳簿で入力）
  await cashEntry(db, b, rates, { date: M(m, d), book: "事業主借", counter: "旅費交通費", dir: "out", amount: 22_000, memo: "打合せの交通費" });
}
await cashEntry(db, b, rates, { date: M(6, 1), book: "普通預金", counter: "新聞図書費", dir: "out", amount: 33_000, memo: "資料・書籍" });
await cashEntry(db, b, rates, { date: M(6, 30), book: "普通預金", counter: "外注工賃", dir: "out", amount: 220_000, memo: "イラスト制作", cp: ILL });
await cashEntry(db, b, rates, { date: M(3, 31), book: "普通預金", counter: "租税公課", dir: "out", amount: 71_700, memo: "令和6年分 消費税及び地方消費税" });
await cashEntry(db, b, rates, { date: M(9, 1), book: "普通預金", counter: "租税公課", dir: "out", amount: 5_000, memo: "個人事業税 第1期" });
await cashEntry(db, b, rates, { date: M(12, 1), book: "普通預金", counter: "租税公課", dir: "out", amount: 5_000, memo: "個人事業税 第2期" });
await cashEntry(db, b, rates, { date: M(12, 10), book: "普通預金", counter: "事業主貸", counterSub: sFuru, dir: "out", amount: 50_000, memo: "ふるさと納税" });

// ── 固定資産 ──
await voucher(db, b, rates, M(4, 10), [{ dr: "工具器具備品", drAmt: 330_000, cr: "普通預金", crAmt: 330_000, memo: "ノートPC" }]);
await voucher(db, b, rates, M(7, 20), [{ dr: "工具器具備品", drAmt: 165_000, cr: "普通預金", crAmt: 165_000, memo: "タブレット" }]);
await repo.saveAsset(db, null, { name: "ノートPC", account_id: b.acc("工具器具備品"), acquired_on: M(4, 10), used_on: M(4, 10), cost: 330_000, method: "straight", useful_life: 4, business_rate: 90, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });
await repo.saveAsset(db, null, { name: "タブレット", account_id: b.acc("工具器具備品"), acquired_on: M(7, 20), used_on: M(7, 20), cost: 165_000, method: "small", useful_life: 0, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });

// ── 決算整理 ──
await runDepreciation(db, b);
const hu = await runHomeUseYearEnd(db, b);

// ── 数字を出す ──
const f = await yearFigures(db, b);
const rows: Cmp[] = [];
const plLine = (label: string) => f.layout.sections.expense.find((r) => r.label === label)?.amount ?? 0;
const extra = (label: string) => f.layout.sections.expense.find((r) => r.extra && r.label === label)?.amount ?? null;

cmp(rows, "試算表：普通預金（期末）", 36_020, f.tbRow("普通預金").balance);
cmp(rows, "試算表：売掛金（期末）", 110_000, f.tbRow("売掛金").balance);
cmp(rows, "試算表：工具器具備品（期末）", 268_125, f.tbRow("工具器具備品").balance);
cmp(rows, "試算表：事業主貸（期末）", 4_214_668, f.tbRow("事業主貸").balance);
cmp(rows, "試算表：事業主借（期末）", 66_000, f.tbRow("事業主借").balance);
cmp(rows, "決算書①：売上（収入）金額", 4_290_000, f.pl.revenue);
cmp(rows, "決算書：租税公課", 81_700, plLine("租税公課"));
cmp(rows, "決算書：旅費交通費", 66_000, plLine("旅費交通費"));
cmp(rows, "決算書：通信費（年末の家事按分後）", 79_200, plLine("通信費"));
cmp(rows, "決算書：消耗品費", 88_000, plLine("消耗品費"));
cmp(rows, "決算書：減価償却費", 220_687, plLine("減価償却費"));
cmp(rows, "決算書：外注工賃", 220_000, plLine("外注工賃"));
cmp(rows, "決算書：地代家賃（入力のたびの家事按分後）", 432_000, plLine("地代家賃"));
cmp(rows, "決算書：新聞図書費（追加の欄）", 33_000, extra("新聞図書費"));
cmp(rows, "決算書：支払手数料（追加の欄）", 6_600, extra("支払手数料"));
cmp(rows, "決算書：経費計", 1_227_187, f.pl.expenses);
cmp(rows, "決算書：青色申告特別控除前の所得金額", 3_062_813, f.pl.income);
cmp(rows, "決算書：青色申告特別控除額", 650_000, f.blue);
cmp(rows, "決算書：所得金額", 2_412_813, f.pl.income - f.blue);
cmp(rows, "決算書2頁：月別売上の計（1〜12月＋家事消費・雑収入）", 4_290_000, f.monthly.sales.reduce((s, x) => s + x, 0) + f.monthly.householdUse + f.monthly.miscIncome);
cmp(rows, "決算書2頁：3月の売上", 550_000, f.monthly.sales[2]);
cmp(rows, "決算書2頁：12月の売上", 440_000, f.monthly.sales[11]);
const rent = f.payee("地代家賃");
cmp(rows, "決算書3頁：地代家賃の内訳・本年中の賃借料", 1_440_000, rent.reduce((s, r) => s + r.gross, 0));
cmp(rows, "決算書3頁：地代家賃の内訳・必要経費算入額", 432_000, rent.reduce((s, r) => s + r.business, 0));
const pc = f.deps.find((x) => x.a.name === "ノートPC")!.d!;
const tab = f.deps.find((x) => x.a.name === "タブレット")!.d!;
cmp(rows, "減価償却：ノートPC 本年中の償却期間（月）", 9, pc.months);
cmp(rows, "減価償却：ノートPC 償却費合計", 61_875, pc.depreciation);
cmp(rows, "減価償却：ノートPC 必要経費算入額（90%・1円未満切捨て）", 55_687, pc.business);
cmp(rows, "減価償却：ノートPC 未償却残高", 268_125, pc.closing);
cmp(rows, "減価償却：タブレット（少額）必要経費算入額", 165_000, tab.business);
cmp(rows, "貸借対照表：資産合計", 4_628_813, f.bs.assets);
cmp(rows, "貸借対照表：貸借の差", 0, f.bs.difference);
cmp(rows, "家事按分の年末の振替：通信費の家事分", 52_800, hu?.privateTotal ?? null);

// ── 消費税（2割特例） ──
const t = await taxReturnOf(db, b, "twenty");
cmp(rows, "消費税：課税標準額（第一表①）", 3_900_000, t.row("first", "①")?.c ?? null);
cmp(rows, "消費税：消費税額（②）", 304_200, t.row("first", "②")?.c ?? null);
cmp(rows, "消費税：控除対象仕入税額＝特別控除税額（④）", 243_360, t.row("first", "④")?.c ?? null);
cmp(rows, "消費税：差引税額（⑨）", 60_800, t.row("first", "⑨")?.c ?? null);
cmp(rows, "消費税：納付譲渡割額（㉒）", 17_100, t.row("first", "㉒")?.c ?? null);
cmp(rows, "消費税：合計税額（㉖）", 77_900, t.r.total);
cmp(rows, "消費税：令和7年分の e-Tax データ（.xtx）", "書き出せる", t.xtx ? "出せない" : "書き出せる", t.xtx ?? "");
cmp(rows, "消費税：中間申告（前年 ⑨ 56,000円）", "不要", t.plan.kind === "none" ? "不要" : t.plan.kind);

// ── 所得税 ──
const input: IncomeTaxInput = {
  ...EMPTY_INCOME_TAX_INPUT,
  birthday: "1985-06-01",
  businessWithholding: [{ item: "デザイン料", payer: "株式会社エックス", payerId: "", income: 3_960_000, withheld: 367_560 }],
  socialInsurance: [{ kind: "国民健康保険", amount: 360_000 }, { kind: "国民年金", amount: 210_120 }],
  smallBusiness: [{ kind: "小規模企業共済", amount: 360_000 }],
  donations: [{ name: "ふるさと納税（〇〇市）", amount: 50_000, local: "furusato" }],
  spouse: { name: "山田 花子", relation: "妻", birthday: "1987-01-10", income: 600_000, disability: "none", cohabiting: true, lineal: false },
};
const it = await incomeTaxOf(db, b, input);
const v = it.v;
cmp(rows, "所得税：事業（営業等）収入 ㋐", 4_290_000, v("㋐"));
cmp(rows, "所得税：事業所得 ①", 2_412_813, v("①"));
cmp(rows, "所得税：合計所得金額 ⑫", 2_412_813, v("⑫"));
cmp(rows, "所得税：社会保険料控除 ⑬", 570_120, v("⑬"));
cmp(rows, "所得税：小規模企業共済等掛金控除 ⑭", 360_000, v("⑭"));
cmp(rows, "所得税：配偶者（特別）控除 ㉑㉒（区分）", "配偶者特別控除", it.r.rows.find((r) => r.no === "㉑㉒")!.label, "配偶者の合計所得金額60万円：令和7年分は58万円超なので配偶者特別控除");
cmp(rows, "所得税：配偶者（特別）控除 ㉑㉒（額）", 380_000, v("㉑㉒"));
cmp(rows, "所得税：基礎控除 ㉕", 880_000, v("㉕"), "令和7年分：132万円超336万円以下は88万円（domble は令和8年分の104万円）");
cmp(rows, "所得税：寄附金控除 ㉙", 48_000, v("㉙"));
cmp(rows, "所得税：所得控除の合計 ㉚", 2_238_120, v("㉚"));
cmp(rows, "所得税：課税される所得金額 ㉛", 174_000, v("㉛"));
cmp(rows, "所得税：税額 ㉜", 8_700, v("㉜"));
cmp(rows, "所得税：復興特別所得税 ㊺", 182, v("㊺"));
cmp(rows, "所得税：源泉徴収税額 ㊾", 367_560, v("㊾"));
cmp(rows, "所得税：還付される税金", 358_678, v(`(53)`));
cmp(rows, "所得税：画面で出せるか（令和7年分）", "出せる", "出せる", "年分ごとの決まりの表（令和7年分）で計算する");

// 所得税の e-Tax のデータ（申告書＋青色申告決算書）
await setFiler(db, { refund_mode: "bank", bank_name: "みずほ", branch_name: "渋谷", account_no: "1234567", office_address: "東京都渋谷区神南1-1-1" });
const xin: IncomeTaxInput = {
  ...input, residentTax: "self",
  businessWithholding: input.businessWithholding.map((r) => ({ ...r, payerId: "東京都港区港南1-1-1" })),
};
const x = await incomeXtxOf(db, b, xin, { self: "123456789018", spouse: "123456789018" });
cmp(rows, "所得税の e-Tax のデータ：書き出せるか", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
cmp(rows, "所得税の e-Tax のデータ：手続 RKO0010 の XSD に合う", "", x.invalid.slice(0, 300));
cmp(rows, "xtx：事業所得 ①（ABB00300）", "2412813", xtxVal(x.xml, "ABB00300"));
cmp(rows, "xtx：還付される税金 (53)（ABB00760）", "358678", xtxVal(x.xml, "ABB00760"));
cmp(rows, "xtx：源泉徴収税額の合計（ABD00070 = ㊾）", "367560", xtxVal(x.xml, "ABD00070"));
cmp(rows, "xtx：配偶者特別控除の区分1（ABB00515）", "1", xtxVal(x.xml, "ABB00515"));
cmp(rows, "xtx：住民税 都道府県・市区町村への寄附（ABI00240）", "50000", xtxVal(x.xml, "ABI00240"));
cmp(rows, "xtx：決算書 売上（収入）金額（AMF00100）", String(f.pl.revenue), xtxVal(x.xml, "AMF00100"));
cmp(rows, "xtx：決算書 青色申告特別控除前の所得金額（AMF00500）", String(f.pl.income), xtxVal(x.xml, "AMF00500"));
cmp(rows, "xtx：決算書 減価償却費（AMF00290 = 3ページの必要経費算入額の計 AMF01840）", xtxVal(x.xml, "AMF01840"), xtxVal(x.xml, "AMF00290"));
cmp(rows, "xtx：貸借対照表 資産の期末合計（AMG00440）＝負債・資本の期末合計（AMG00760）", xtxVal(x.xml, "AMG00440"), xtxVal(x.xml, "AMG00760"));

// 源泉徴収税額を帳簿（事業主貸の補助科目「源泉所得税」）から拾えるか
const withheldBooks = f.lines.filter((l) => l.sub_account_id === sWith).reduce((s, l) => s + (l.side === "debit" ? l.amount : -l.amount), 0);
cmp(rows, "帳簿の源泉所得税（事業主貸の補助科目）", 367_560, withheldBooks, "所得税の画面は社会保険料・共済だけを補助科目から拾い、源泉徴収税額は拾わない（手で入れる）");

printTable("例1 フリーランスのデザイナー（2割特例・青色65万円）", rows);
console.log("\n消費税の確認の一覧：", t.issues.map((i) => `[${i.level}] ${i.title}`).join(" / ") || "なし");
console.log("方式の比較：", t.all.map((x) => `${x.m}=${x.total}${x.problem ? `（${x.problem}）` : ""}`).join(" / "));
console.log("決算書の欄の知らせ：", f.layout.warnings.join(" / ") || "なし");
console.log("所得税のお知らせ：", it.r.notes.join(" / ") || "なし");
