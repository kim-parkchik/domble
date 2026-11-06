/**
 * 分野 F・例4（2026-11-04 に足した）：請求書で売上を立て、入金を記録し、源泉徴収される人（令和7年分）
 * 何を確かめるか：
 *  - 「請求書・見積書」の画面：請求書（税抜の単価・源泉徴収あり）を発行 → 売掛金＋事業主貸（源泉徴収税額）／売上高 の仕訳
 *  - 100万円を超える報酬の源泉徴収（100万円まで 10.21%、超える部分 20.42%）
 *  - 入金の記録（振込手数料を差し引かれた入金）・取消した請求書・源泉徴収の無い請求書（税込の単価）
 *  - 決算書（売上・売掛金・支払手数料）→ 消費税（2割特例）→ 所得税（「請求書から入れる」で第二表の所得の内訳と ㊾）→ e-Tax（所得税・消費税）
 * 動かし方：bun s5_invoice.ts
 */
import {
  makeDb, makeBook, cashEntry, yearFigures, taxReturnOf, incomeTaxScreen, incomeXtxOf, setFiler, taxXtxOf, xtxVal, cmp, printTable, repo, YEAR, type Cmp,
} from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";
import { salesDate, savedTotals, type SalesDoc } from "../../../src/lib/salesDoc";
import { twentyReturn } from "../../../src/lib/taxReturn";

const { db } = makeDb("strict");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const last = (m: number) => M(m, new Date(YEAR, m, 0).getDate());

// 法人番号（検査用数字つき）
const corpNo = (body12: string) => {
  const ds = body12.split("").reverse().map(Number);
  const s = ds.reduce((t, d, i) => t + d * (i % 2 === 0 ? 1 : 2), 0);
  return `${9 - (s % 9)}${body12}`;
};

// ── 設定 ──
await repo.saveInvoiceRegistration(db, "T1234567890123", "2023-10-01");
await repo.saveTaxYear(db, { from_year: 2023, status: "twenty", method: "inclusive", business_class: 5, taxable_from: "2023-10-01", deduction: "individual", voluntary_interim: 0 });
await repo.saveTaxBaseManual(db, YEAR, 3_000_000);
await repo.saveTaxPrevManual(db, YEAR, 50_000);
const rates = await repo.getHomeUseRates(db, YEAR);
const A = await repo.createCounterparty(db, { name: "株式会社エー", kana: "えー", invoice_no: "", corporate_no: corpNo("000000000011"), not_registered: false, memo: "" }) as number;
const B = await repo.createCounterparty(db, { name: "株式会社ビー出版", kana: "びー", invoice_no: "", corporate_no: corpNo("000000000022"), not_registered: false, memo: "" }) as number;
const C = await repo.createCounterparty(db, { name: "シー商店", kana: "しー", invoice_no: "", corporate_no: "", not_registered: false, memo: "" }) as number;
await repo.saveOpening(db, YEAR, { [`${b.acc("普通預金")}:0`]: 1_000_000, [`${b.acc("元入金")}:0`]: 1_000_000 });

const docBase = (o: Partial<SalesDoc>) => ({
  kind: "invoice" as const, doc_no: "", issue_date: "", delivery_date: null, due_date: null, counterparty_id: null, to_name: "", honorific: "御中", to_address: "",
  subject: "", items: [], price_mode: "exclusive" as const, withholding: 1, notes: "", bank_text: "", source_id: null, revenue_account_id: null, ...o,
});
const bank = b.acc("普通預金"), fee = b.acc("支払手数料");

// エー：毎月 デザイン料 200,000円（税抜）。翌月25日に、振込手数料 440円を差し引いて入金。12月分は年末に売掛金
const aDocs: number[] = [];
for (let m = 1; m <= 12; m++) {
  const id = await repo.saveSalesDoc(db, null, docBase({
    doc_no: `${YEAR}-${String(m).padStart(4, "0")}`, issue_date: last(m), counterparty_id: A, to_name: "株式会社エー", to_address: "東京都港区港南1-1-1",
    subject: `${m}月分 デザイン`, items: [{ name: "デザイン料", qty: 1, unit: "式", price: 200_000, tax: "10" }],
  }));
  await repo.issueSalesDoc(db, id);
  aDocs.push(id);
  if (m <= 11) await repo.addSalesPayment(db, id, { paid_on: M(m + 1, 25), amount: 200_000 + 20_000 - 20_420 - 440, fee: 440, bankAccountId: bank, feeAccountId: fee });
}
// ビー出版：100万円を超える報酬（6月）。源泉徴収 = 1,000,000 × 10.21% + 500,000 × 20.42% = 204,200
const bId = await repo.saveSalesDoc(db, null, docBase({
  doc_no: `${YEAR}-0101`, issue_date: M(6, 30), delivery_date: M(6, 20), counterparty_id: B, to_name: "株式会社ビー出版", to_address: "東京都千代田区神田1-1",
  subject: "書籍の装丁一式", items: [{ name: "装丁デザイン", qty: 1, unit: "式", price: 1_200_000, tax: "10" }, { name: "イラスト", qty: 6, unit: "点", price: 50_000, tax: "10" }],
}));
await repo.issueSalesDoc(db, bId);
await repo.addSalesPayment(db, bId, { paid_on: M(7, 31), amount: 1_650_000 - 204_200, fee: 0, bankAccountId: bank, feeAccountId: fee });
// シー商店：源泉徴収の無い請求書（税込の単価）
const cId = await repo.saveSalesDoc(db, null, docBase({
  doc_no: `${YEAR}-0102`, issue_date: M(9, 15), counterparty_id: C, to_name: "シー商店", price_mode: "inclusive", withholding: 0,
  subject: "ロゴ", items: [{ name: "ロゴ制作", qty: 1, unit: "式", price: 330_000, tax: "10" }],
}));
await repo.issueSalesDoc(db, cId);
await repo.addSalesPayment(db, cId, { paid_on: M(10, 15), amount: 330_000, fee: 0, bankAccountId: bank, feeAccountId: fee });
// 発行して取り消した請求書（金額の誤り）
const vId = await repo.saveSalesDoc(db, null, docBase({
  doc_no: `${YEAR}-0103`, issue_date: M(10, 1), counterparty_id: C, to_name: "シー商店", withholding: 0,
  subject: "名刺", items: [{ name: "名刺デザイン", qty: 1, unit: "式", price: 50_000, tax: "10" }],
}));
await repo.issueSalesDoc(db, vId);
await repo.voidSalesDoc(db, vId, "金額の誤り");

// 経費
const sNhi = await b.sub("事業主貸", "国民健康保険");
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: M(m, 10), book: "普通預金", counter: "通信費", dir: "out", amount: 11_000, memo: "回線" });
  await cashEntry(db, b, rates, { date: M(m, 26), book: "普通預金", counter: "事業主貸", counterSub: sNhi, dir: "out", amount: 25_000, memo: "国民健康保険" });
}
await cashEntry(db, b, rates, { date: M(5, 10), book: "普通預金", counter: "消耗品費", dir: "out", amount: 165_000, memo: "モニター" });

// ── 数字を出す ──
const f = await yearFigures(db, b);
const rows: Cmp[] = [];
const ex = (label: string) => f.layout.sections.expense.find((r) => r.label === label)?.amount ?? null;
const docs = await repo.getSalesDocs(db);
const voided = docs.find((d) => d.id === vId)!;
cmp(rows, "請求書：エー 1通の差引請求額（220,000 − 20,420）", 199_580, savedTotals(docs.find((d) => d.id === aDocs[0])!).billed);
cmp(rows, "請求書：ビー出版の源泉徴収税額（100万円超 20.42%）", 204_200, savedTotals(docs.find((d) => d.id === bId)!).withholding);
cmp(rows, "請求書：ビー出版の売上の日（取引日 6/20）", "2025-06-20", f.lines.find((l) => l.entry_id === docs.find((d) => d.id === bId)!.entry_id)?.date ?? null);
cmp(rows, "取消した請求書：仕訳が消える", "消える", voided.entry_id === null && voided.status === "void" ? "消える" : "残る");
cmp(rows, "試算表：売掛金（期末。12月分のエー）", 199_580, f.tbRow("売掛金").balance);
cmp(rows, "試算表：普通預金（期末）", 1_000_000 + (199_140 * 11) + 1_445_800 + 330_000 - 132_000 - 300_000 - 165_000, f.tbRow("普通預金").balance);
cmp(rows, "試算表：事業主貸（源泉徴収 449,240 ＋ 国保 300,000）", 749_240, f.tbRow("事業主貸").balance);
cmp(rows, "決算書：売上（収入）金額", 4_620_000, f.pl.revenue);
cmp(rows, "決算書：支払手数料（振込手数料 440 × 11）", 4_840, ex("支払手数料"));
cmp(rows, "決算書：経費計", 4_840 + 132_000 + 165_000, f.pl.expenses);
cmp(rows, "決算書：青色申告特別控除前の所得金額", 4_318_160, f.pl.income);
cmp(rows, "決算書2頁：12月の売上", 220_000, f.monthly.sales[11]);
cmp(rows, "決算書2頁：6月の売上（ビー出版）", 1_870_000, f.monthly.sales[5]);

// 消費税（2割特例）
const t = await taxReturnOf(db, b, "twenty");
cmp(rows, "消費税：課税標準額 ①（4,620,000 × 100/110）", 4_200_000, t.row("first", "①")?.c ?? null);
cmp(rows, "消費税：消費税額 ②", 327_600, t.row("first", "②")?.c ?? null);
cmp(rows, "消費税：差引税額 ⑨（327,600 × 20% → 百円未満切捨て）", 65_500, t.row("first", "⑨")?.c ?? null);
cmp(rows, "消費税：合計税額 ㉖（地方 18,400）", 83_900, t.r.total);
const tx = await taxXtxOf(db, twentyReturn(t.base, { businessClass: 5, interimNational: 0, interimLocal: 0, baseSales: 3_000_000, deduction: "individual" }, "一般用"));
cmp(rows, "消費税 xtx：XSD に合う", "", tx.error || tx.invalid);

// 所得税：「請求書から入れる」（IncomeTaxPage.pickInvoices と同じ組み立て）
const cps = await repo.getCounterparties(db);
const by = new Map<string, { payer: string; payerId: string; income: number; withheld: number }>();
for (const d of docs.filter((d) => d.kind === "invoice" && d.status === "issued" && d.withholding && salesDate(d).startsWith(String(YEAR)))) {
  const tt = savedTotals(d);
  const cp = cps.find((c) => c.id === d.counterparty_id);
  const payer = cp?.name ?? d.to_name;
  const row = by.get(payer) ?? { payer, payerId: cp?.corporate_no || d.to_address, income: 0, withheld: 0 };
  by.set(payer, { ...row, income: row.income + tt.total, withheld: row.withheld + tt.withholding });
}
const picked = [...by.values()].map((r) => ({ item: "報酬", ...r }));
cmp(rows, "請求書から入れる：支払者の数（源泉徴収ありだけ）", 2, picked.length);
cmp(rows, "請求書から入れる：エーの収入金額（税込・12通）", 2_640_000, picked.find((p) => p.payer === "株式会社エー")?.income ?? null);
cmp(rows, "請求書から入れる：エーの源泉徴収税額", 245_040, picked.find((p) => p.payer === "株式会社エー")?.withheld ?? null);
cmp(rows, "請求書から入れる：ビー出版の源泉徴収税額", 204_200, picked.find((p) => p.payer === "株式会社ビー出版")?.withheld ?? null);
const input: IncomeTaxInput = {
  ...EMPTY_INCOME_TAX_INPUT, birthday: "1990-04-01", businessWithholding: picked,
  socialInsurance: [{ kind: "国民健康保険", amount: 300_000 }], residentTax: "self",
};
const it = await incomeTaxScreen(db, b, input);
cmp(rows, "所得税：事業所得 ①（4,318,160 − 650,000）", 3_668_160, it.v("①"));
cmp(rows, "所得税：基礎控除（令和7年分・336万円超489万円以下）", 680_000, it.k("basic") ?? it.r.rows.find((r) => r.label === "基礎控除")?.value ?? null);
cmp(rows, "所得税：課税される所得金額", 2_688_000, it.k("taxable"));
cmp(rows, "所得税：税額（2,688,000 × 10% − 97,500）", 171_300, it.r.rows.find((r) => r.label.startsWith("上の"))?.value ?? null);
cmp(rows, "所得税：源泉徴収税額 ㊾", 449_240, it.k("withheld"));
cmp(rows, "所得税：還付される税金（174,897 − 449,240）", 274_343, it.k("refund"));
cmp(rows, "帳簿の事業主貸（源泉徴収税額）＝ ㊾", 449_240, f.lines.filter((l) => l.account_id === b.acc("事業主貸") && /源泉徴収税額/.test(l.memo ?? "")).reduce((s, l) => s + l.amount, 0));

await setFiler(db, { refund_mode: "bank", bank_name: "みずほ", branch_name: "渋谷", account_no: "1234567" });
const x = await incomeXtxOf(db, b, input, { self: "123456789018" });
cmp(rows, "所得税 xtx：書き出せる", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
cmp(rows, "所得税 xtx：XSD に合う", "", x.invalid.slice(0, 300));
cmp(rows, "所得税 xtx：源泉徴収税額の合計（ABD00070）", "449240", xtxVal(x.xml, "ABD00070"));
cmp(rows, "所得税 xtx：還付される税金（ABB00760）", "274343", xtxVal(x.xml, "ABB00760"));
cmp(rows, "所得税 xtx：所得の内訳1行目の支払者の法人番号又は所在地（ABD00030）", corpNo("000000000011"), xtxVal(x.xml, "ABD00030"));

printTable("例4 請求書で売上を立て、源泉徴収される人（2割特例・青色65万円）", rows);
console.log("\n消費税の確認の一覧：", t.issues.map((i) => `[${i.level}] ${i.title}`).join(" / ") || "なし");
console.log("所得税のお知らせ：", it.r.notes.join(" / ") || "なし");
