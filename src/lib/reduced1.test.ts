/**
 * 飲食料品の税率の引下げ（令和9年4月1日〜令和11年3月31日。軽減税率 8% → 1%）
 * 税区分の切り替え（科目の初期値・ルール・前の仕訳・定型仕訳）、税抜経理・基準期間・集計表、申告書に入れないこと、確かめ
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { defaultTaxCode, inReduced1, isReduced1, reducedOn, resolveLineTax, taxShortLabel } from "./tax";
import { autoTaxAmount } from "./taxExclusive";
import { periodSales } from "./baseSales";
import { buildTaxBase } from "./taxReturn";
import { buildTaxSummary, taxChecks, taxKindOf } from "./taxSummary";
import { guessLine, type BankRule } from "./bankImport";
import { usableSide } from "./memoFill";
import { applyTemplate } from "./templates";
import { emptyRow } from "./accounting";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const food = { ...accounts.find((a) => a.name === "売上高")!, default_tax_code: "sales8" as const };
const standard: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "" }];
let seq = 0;
const line = (date: string, side: "debit" | "credit", name: string, amount: number, tax: FlatLine["tax_code"]): FlatLine => ({
  entry_id: ++seq, date, description: "", row_no: 1, side, account_id: id(name), sub_account_id: null, amount, memo: "", tax_code: tax, invoice_kind: null,
});

describe("期間と税区分の切り替え", () => {
  test("1% は令和9年4月1日から令和11年3月31日まで", () => {
    expect([inReduced1("2027-03-31"), inReduced1("2027-04-01"), inReduced1("2029-03-31"), inReduced1("2029-04-01")]).toEqual([false, true, true, false]);
    expect([isReduced1("sales1"), isReduced1("purchase1"), isReduced1("baddebt1"), isReduced1("import1"), isReduced1("sales8")]).toEqual([true, true, true, true, false]);
  });
  test("軽減税率の売上・仕入・輸入は、日付で 8% と 1% を切り替える。貸倒れ・10%・対象外は変えない", () => {
    expect(["sales8", "purchase8", "import8", "baddebt8", "sales10", "none"].map((c) => reducedOn(c as "sales8", "2027-04-01")))
      .toEqual(["sales1", "purchase1", "import1", "baddebt8", "sales10", "none"]);
    expect(["sales1", "purchase1", "import1", "baddebt1"].map((c) => reducedOn(c as "sales1", "2029-04-01"))).toEqual(["sales8", "purchase8", "import8", "baddebt1"]);
    expect(reducedOn(null, "2027-04-01")).toBeNull();
  });
  test("科目の初期値：8%（軽減）の科目は、期間中の取引では 1% で入る（日付が無ければ科目の初期値のまま）", () => {
    expect([defaultTaxCode(food, "credit", "2027-03-31"), defaultTaxCode(food, "credit", "2027-04-01"), defaultTaxCode(food, "credit")]).toEqual(["sales8", "sales1", "sales8"]);
    const lines = [{ row_no: 1, side: "credit" as const, account_id: food.id, sub_account_id: null, amount: 1_010, memo: "" }];
    const of = (date: string) => resolveLineTax(lines, true, () => food, null, null, null, false, date)[0].tax_code;
    expect([of("2027-03-31"), of("2027-04-01")]).toEqual(["sales8", "sales1"]);
    // 手で選んだ 8%（経過措置など）は、期間中でもそのまま
    expect(resolveLineTax([{ ...lines[0], tax_code: "sales8" as const }], true, () => food, null, null, null, false, "2027-05-01")[0].tax_code).toBe("sales8");
    expect(taxShortLabel("purchase1", "transitional", "2027-04-01")).toBe("課仕1%軽 経過70%");
  });
  test("明細の取り込み：ルール・前の仕訳の 8% は、明細の日付で 1% に（分け方も）", () => {
    const rule: BankRule = {
      id: 1, keyword: "ヤオヤ", direction: "decrease", target_account_id: null, account_id: 502, sub_account_id: null, tax_code: "purchase8", invoice_kind: "qualified",
      counterparty_id: null, memo: "", sort_order: 0, splits: [{ account_id: 610, sub_account_id: null, tax_code: "purchase8", invoice_kind: null, amount: 100, memo: "" }],
    };
    const bank = { id: 3, normal_side: "debit" as const };
    const g = guessLine({ description: "ヤオヤ", side: "credit", date: "2027-04-02" }, bank, [rule], new Map());
    expect([g.taxCode, g.splits[0].tax_code]).toEqual(["purchase1", "purchase1"]);
    expect(guessLine({ description: "ヤオヤ", side: "credit", date: "2027-03-31" }, bank, [rule], new Map()).taxCode).toBe("purchase8");
    const history = new Map([["credit|ヤオヤ", { counterId: 502, counterSubId: null, taxCode: "purchase1" as const, invoice: null, counterpartyId: null, memo: "", dept: null }]]);
    expect(guessLine({ description: "ヤオヤ", side: "credit", date: "2029-04-01" }, bank, [], history).taxCode).toBe("purchase8");
  });
  test("前の仕訳・定型仕訳から入れるときも、入れる仕訳の日付に合わせる", () => {
    const f = { accountId: id("仕入高"), subId: null, tax: "purchase8" as const, invoice: null, cls: null, use: null, dept: null };
    expect(usableSide(f, accounts, [], "2027-04-01")!.tax).toBe("purchase1");
    expect(usableSide(f, accounts, [])!.tax).toBe("purchase8");
    const rows = [{ ...emptyRow(), debitAccountId: id("仕入高"), debitTax: "purchase1" as const, creditAccountId: id("現金"), creditTax: "none" as const }];
    expect(applyTemplate(rows, accounts, [], "2027-03-01").rows[0]).toMatchObject({ debitTax: "purchase8", creditTax: "none" });
    expect(applyTemplate(rows, accounts, [], "2028-03-01").rows[0].debitTax).toBe("purchase1");
  });
});

describe("税抜経理・基準期間・集計表", () => {
  test("税抜経理の消費税額：税込 × 1/101（1円未満切り捨て）。輸入は金額そのもの", () => {
    expect(autoTaxAmount({ amount: 10_100, tax_code: "sales1", invoice_kind: null, date: "2027-04-01" })).toBe(100);
    expect(autoTaxAmount({ amount: 5_000, tax_code: "purchase1", invoice_kind: "qualified", date: "2027-04-01" })).toBe(49);
    expect(autoTaxAmount({ amount: 10_100, tax_code: "purchase1", invoice_kind: "transitional", date: "2027-04-01" })).toBe(70);
    expect(autoTaxAmount({ amount: 780, tax_code: "import1", invoice_kind: null, date: "2027-04-01" })).toBe(780);
  });
  test("基準期間の課税売上高：1% の売上は 100/101 で税抜きする", () => {
    const s = periodSales([
      line("2027-03-31", "credit", "売上高", 1_080_000, "sales8"),
      line("2027-04-01", "credit", "売上高", 2_020_000, "sales1"),
      line("2027-04-02", "debit", "売上高", 101_000, "sales1"),
    ], accounts, standard, "2027-01-01", "2027-12-31");
    expect(s.taxable).toBe(1_000_000 + 2_000_000 - 100_000);
  });
  test("集計表：1% の行を分けて出し、消費税等（参考）は 1/101。課税売上割合にも入る。貸倒れ 1% は貸倒れ", () => {
    const sum = buildTaxSummary([
      line("2027-04-01", "credit", "売上高", 2_020_000, "sales1"),
      line("2027-04-01", "credit", "売上高", 1_100_000, "sales10"),
      line("2027-04-03", "debit", "仕入高", 505_000, "purchase1"),
    ], accounts, standard);
    expect(sum.rows.map((r) => [r.code, r.kind, r.amount, r.tax])).toEqual([
      ["sales10", "sales", 1_100_000, 100_000], ["sales1", "sales", 2_020_000, 20_000], ["purchase1", "purchase", 505_000, 5_000],
    ]);
    expect(sum.ratio.taxable).toBe(3_000_000);
    expect(taxKindOf("baddebt1", "debit")).toBe("badDebt");
  });
});

describe("申告書と確かめ", () => {
  test("申告書の数字には入れず、件数と金額を数える（0.78% の欄がある様式がまだドラフト版のため）", () => {
    const b = buildTaxBase([
      line("2027-03-31", "credit", "売上高", 1_080, "sales8"),
      line("2027-04-01", "credit", "売上高", 1_010, "sales1"),
      line("2027-04-01", "debit", "仕入高", 505, "purchase1"),
    ], standard);
    expect(b.sales).toEqual({ 8: 1_080, 10: 0 });
    expect(b.purchase).toEqual({ 8: 0, 10: 0 });
    expect(b.reduced1).toEqual({ lines: 2, amount: 1_515 });
  });
  test("確かめ：期間の外の 1% は直す、期間中の 8% は念のため、1% があれば申告書にまだ入らないこと", () => {
    const lines = [
      line("2027-03-31", "credit", "売上高", 1_010, "sales1"), // 期間の外
      line("2027-04-01", "credit", "売上高", 1_080, "sales8"), // 経過措置かも
      line("2027-04-02", "debit", "売上高", 1_080, "sales8"), // 3月の売上の返品かも
      line("2027-04-02", "credit", "売上高", 2_020, "sales1"),
    ];
    const issues = taxChecks({ year: 2027, lines, accounts, counterparties: [], taxYears: standard, invoiceNo: "", registeredOn: "", summary: buildTaxSummary(lines, accounts, standard) });
    const pick = (re: RegExp) => issues.find((i) => re.test(i.title));
    expect(pick(/期間の外の取引が 1%/)).toMatchObject({ level: "error", entryIds: [lines[0].entry_id] });
    expect(pick(/8%（軽減）になっています/)).toMatchObject({ level: "info", entryIds: [lines[1].entry_id, lines[2].entry_id] });
    expect(pick(/まだ申告書の数字に入りません/)).toMatchObject({ level: "warn", fix: "return" });
    expect(pick(/まだ申告書の数字に入りません/)!.detail).toContain("2 件（税込 3,030円）");
  });
});
