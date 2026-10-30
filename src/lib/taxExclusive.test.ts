/**
 * 税抜経理：明細の消費税額と、帳簿・決算書に使う明細（本体と仮受・仮払消費税等）、年末の精算
 */
import { describe, expect, test } from "bun:test";
import type { FlatLine } from "./accounting";
import { closingBalances, summarizeIncome } from "./accounting";
import type { Account, TaxYear } from "./types";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import { autoTaxAmount, bookLines, exclusiveAccountsOf, lineTaxAmount } from "./taxExclusive";
import { exclusiveSettlementLines } from "./yearEnd";
import { resolveLineTax } from "./tax";
import { depreciationFor, disposalLines, type FixedAsset } from "./depreciation";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, income_kind: s.income_kind ?? "business",
  default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const ty = (method: TaxYear["method"]): TaxYear[] => [{ from_year: 2026, status: "standard", method, business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 }];
let n = 0;
const fl = (entry_id: number, side: FlatLine["side"], name: string, amount: number, more: Partial<FlatLine> = {}): FlatLine =>
  ({ entry_id, date: "2026-05-01", description: "", row_no: ++n, side, account_id: id(name), sub_account_id: null, amount, memo: "", ...more });

describe("明細の消費税額", () => {
  test("自動：割戻し・切り捨て。経過措置は控除できる割合、控除しないは 0、輸入は金額そのもの", () => {
    const d = "2026-05-01";
    expect(autoTaxAmount({ amount: 1_100, tax_code: "purchase10", invoice_kind: "qualified", date: d })).toBe(100);
    expect(autoTaxAmount({ amount: 1_080, tax_code: "sales8", invoice_kind: null, date: d })).toBe(80);
    expect(autoTaxAmount({ amount: 1_100, tax_code: "purchase10", invoice_kind: "transitional", date: d })).toBe(80);
    expect(autoTaxAmount({ amount: 1_100, tax_code: "purchase10", invoice_kind: "none", date: d })).toBe(0);
    expect(autoTaxAmount({ amount: 1_100, tax_code: "purchase10", invoice_kind: "book_transport", date: d })).toBe(100);
    expect(autoTaxAmount({ amount: 7_800, tax_code: "import10", invoice_kind: null, date: d })).toBe(7_800);
    expect(autoTaxAmount({ amount: 50_000, tax_code: "reverse10", invoice_kind: null, date: d })).toBe(0);
  });
  test("税込経理の年は 0。手で直した額があればそれ", () => {
    const l = { amount: 1_100, tax_code: "purchase10" as const, invoice_kind: "qualified" as const, date: "2026-05-01", tax_amount: null };
    expect(lineTaxAmount(l, ty("inclusive"))).toBe(0);
    expect(lineTaxAmount(l, ty("exclusive"))).toBe(100);
    expect(lineTaxAmount({ ...l, tax_amount: 99 }, ty("exclusive"))).toBe(99);
  });
  test("保存するときは、税抜経理の年の分ける明細だけ手で直した額を残す", () => {
    const base = { row_no: 1, side: "debit" as const, account_id: id("消耗品費"), sub_account_id: null, amount: 1_100, memo: "", tax_code: "purchase10" as const, tax_amount: 99 };
    const acc = (x: number) => accounts.find((a) => a.id === x);
    expect(resolveLineTax([base], true, acc, null, null, null, true)[0].tax_amount).toBe(99);
    expect(resolveLineTax([base], true, acc, null, null, null, false)[0].tax_amount).toBeNull();
    expect(resolveLineTax([{ ...base, tax_code: "none" }], true, acc, null, null, null, true)[0].tax_amount).toBeNull();
  });
});

describe("帳簿・決算書に使う明細", () => {
  const ids = exclusiveAccountsOf(accounts)!;
  const lines = [
    fl(1, "debit", "普通預金", 110_000), fl(1, "credit", "売上高", 110_000, { tax_code: "sales10" }),
    fl(2, "debit", "消耗品費", 3_300, { tax_code: "purchase10", invoice_kind: "qualified" }), fl(2, "credit", "現金", 3_300),
    fl(3, "debit", "通信費", 1_100, { tax_code: "purchase10", invoice_kind: "qualified", tax_amount: 99 }), fl(3, "credit", "現金", 1_100),
  ];
  test("本体（税抜）と仮受・仮払消費税等に分ける。税込経理なら分けない", () => {
    expect(bookLines(lines, ty("inclusive"), ids)).toBe(lines);
    const b = bookLines(lines, ty("exclusive"), ids);
    const end = closingBalances(accounts, {}, b);
    expect([end.get(id("売上高")), end.get(id("仮受消費税等")), end.get(id("消耗品費")), end.get(id("通信費")), end.get(id("仮払消費税等"))])
      .toEqual([100_000, 10_000, 3_000, 1_001, 399]);
    expect(end.get(id("現金"))).toBe(-4_400);
    expect(summarizeIncome(accounts, end).income).toBe(100_000 - 3_000 - 1_001);
    expect(b.filter((l) => l.taxPart).map((l) => l.entry_id)).toEqual([1, 2, 3]);
  });
  test("年末の精算：仮受・仮払を消し、納める額を未払消費税等に、差額を雑収入・雑費に", () => {
    const e = { received: id("仮受消費税等"), paid: id("仮払消費税等"), accrued: id("未払消費税等"), receivable: id("未収入金"), misc: id("雑収入"), miscExpense: id("雑費") };
    const pay = exclusiveSettlementLines(10_000, 399, 9_500, e);
    expect(pay.map((l) => [l.side, l.account_id, l.amount])).toEqual([
      ["debit", e.received, 10_000], ["credit", e.paid, 399], ["credit", e.accrued, 9_500], ["credit", e.misc, 101],
    ]);
    const refund = exclusiveSettlementLines(1_000, 5_000, -4_100, e);
    expect(refund.map((l) => [l.side, l.account_id, l.amount])).toEqual([
      ["debit", e.received, 1_000], ["credit", e.paid, 5_000], ["debit", e.receivable, 4_100], ["credit", e.misc, 100],
    ]);
    expect(exclusiveSettlementLines(1_000, 0, 1_100, e).at(-1)).toMatchObject({ side: "debit", account_id: e.miscExpense, amount: 100 });
  });
  test("固定資産の売却：税抜経理の年は、税抜の売却額と帳簿価額の差を事業主借・事業主貸に（資産の科目が 0 になる）", () => {
    const asset: FixedAsset = {
      id: 1, name: "車", account_id: id("車両運搬具"), acquired_on: "2023-01-01", used_on: "2023-01-01", cost: 2_000_000, method: "straight", useful_life: 6, business_rate: 100,
      opening_year: null, opening_book_value: null, disposed_on: "2026-06-30", disposal_kind: "sale", sale_price: 1_100_000, memo: "",
    };
    const lines2 = disposalLines(asset, { receive: id("普通預金"), ownerLoan: id("事業主借"), ownerDraw: id("事業主貸"), loss: id("固定資産除却損") }, true)!;
    const flat = lines2.map((l) => ({ ...l, entry_id: 9, date: "2026-06-30", description: "" }));
    // 売却した日の帳簿価額から始めて、売却の仕訳のあと資産の科目が 0 になる。仮受消費税等は 100,000
    const book = depreciationFor(asset, 2026)!.closing;
    const end = closingBalances(accounts, { [id("車両運搬具")]: book }, bookLines(flat, ty("exclusive"), exclusiveAccountsOf(accounts)));
    expect(end.get(id("車両運搬具"))).toBe(0);
    expect(end.get(id("仮受消費税等"))).toBe(100_000);
    // 税込経理なら、税込の売却額で差額を出す（仮受消費税等は無い）
    const incl = disposalLines(asset, { receive: id("普通預金"), ownerLoan: id("事業主借"), ownerDraw: id("事業主貸"), loss: id("固定資産除却損") })!;
    const endIncl = closingBalances(accounts, { [id("車両運搬具")]: book }, incl.map((l) => ({ ...l, entry_id: 9, date: "2026-06-30", description: "" })));
    expect(endIncl.get(id("車両運搬具"))).toBe(0);
  });
});
