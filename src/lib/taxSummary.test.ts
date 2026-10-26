import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, Counterparty, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { buildTaxSummary, codeMismatch, includedTax, taxChecks, taxKindOf } from "./taxSummary";
import { privateTaxSplit } from "./homeUse";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const acc = (name: string) => accounts.find((a) => a.name === name)!;
const twenty: TaxYear[] = [{ from_year: 2026, status: "twenty", method: "inclusive", business_class: 5, taxable_from: "2026-04-01" }];

let seq = 0;
const line = (date: string, side: "debit" | "credit", name: string, amount: number, tax: FlatLine["tax_code"], invoice: FlatLine["invoice_kind"] = null, extra: Partial<FlatLine> = {}): FlatLine => ({
  entry_id: ++seq, date, description: "", row_no: 1, side, account_id: id(name), sub_account_id: null, amount, memo: "",
  tax_code: tax, invoice_kind: invoice, ...extra,
});

describe("集計表", () => {
  test("区分は貸借の側で判定する", () => {
    expect(taxKindOf("sales10", "credit")).toBe("sales");
    expect(taxKindOf("sales10", "debit")).toBe("salesReturn");
    expect(taxKindOf("purchase8", "credit")).toBe("purchaseReturn");
    expect(taxKindOf("baddebt10", "debit")).toBe("badDebt");
    expect(taxKindOf("baddebt10", "credit")).toBe("badDebtRecovered");
    expect(taxKindOf("none", "debit")).toBe("other");
    expect(includedTax(11000, 10)).toBe(1000);
    expect(includedTax(1080, 8)).toBe(80);
    expect(includedTax(999, 10)).toBe(90);
  });

  test("課税事業者の期間だけ集計し、経過措置は日付の割合ごとに分ける。対象外は損益の科目だけ", () => {
    const lines = [
      line("2026-03-31", "credit", "売上高", 99999, "sales10"), // 課税事業者になる前
      line("2026-04-10", "credit", "売上高", 110000, "sales10"),
      line("2026-04-20", "debit", "売上高", 11000, "sales10"), // 値引き
      line("2026-05-01", "debit", "消耗品費", 1100, "purchase10", "qualified"),
      line("2026-09-30", "debit", "外注工賃", 33000, "purchase10", "transitional"),
      line("2026-10-01", "debit", "外注工賃", 22000, "purchase10", "transitional"),
      line("2026-06-01", "debit", "給料賃金", 200000, "none"),
      line("2026-06-01", "credit", "現金", 200000, "none"),
      line("2026-07-01", "debit", "消耗品費", 500, "purchase10", "qualified", { is_deleted: 1 }),
    ];
    const s = buildTaxSummary(lines, accounts, twenty);
    expect(s.rows.map((r) => [r.kind, r.code, r.invoice, r.transitional, r.amount, r.tax])).toEqual([
      ["sales", "sales10", null, null, 110000, 10000],
      ["salesReturn", "sales10", null, null, 11000, 1000],
      ["purchase", "purchase10", "qualified", null, 1100, 100],
      ["purchase", "purchase10", "transitional", 80, 33000, 3000],
      ["purchase", "purchase10", "transitional", 70, 22000, 2000],
      ["other", "none", null, null, 200000, 0],
    ]);
    expect(s.rows[0].accounts).toEqual([{ account_id: id("売上高"), amount: 110000, lines: 1 }]);
  });

  test("課税売上割合は税抜・返還を差し引いて計算する", () => {
    const s = buildTaxSummary([
      line("2026-05-01", "credit", "売上高", 110000, "sales10"),
      line("2026-05-02", "debit", "売上高", 11000, "sales10"),
      line("2026-05-03", "credit", "雑収入", 10000, "sales_nontax"),
      line("2026-05-04", "credit", "売上高", 5000, "export"),
    ], accounts, twenty);
    expect(s.ratio).toMatchObject({ taxable: 90000, exportSales: 5000, nontax: 10000 });
    expect(s.ratio.value).toBeCloseTo(95000 / 105000);
  });
});

describe("確認の一覧", () => {
  const cps: Counterparty[] = [
    { id: 1, name: "登録なしの外注先", kana: "", invoice_no: "", not_registered: 1, memo: "", is_active: 1 },
    { id: 2, name: "登録ありの店", kana: "", invoice_no: "T1234567890123", not_registered: 0, memo: "", is_active: 1 },
    { id: 3, name: "番号未入力の店", kana: "", invoice_no: "", not_registered: 0, memo: "", is_active: 1 },
  ];
  const run = (lines: FlatLine[], taxYears = twenty, extra: { invoiceNo?: string; registeredOn?: string } = {}) =>
    taxChecks({
      year: 2026, lines, accounts, counterparties: cps, taxYears, invoiceNo: extra.invoiceNo ?? "", registeredOn: extra.registeredOn ?? "",
      summary: buildTaxSummary(lines, accounts, taxYears),
    });

  test("科目と税区分の組み合わせ", () => {
    expect(codeMismatch(acc("売上高"), "purchase10")).toMatch(/収益/);
    expect(codeMismatch(acc("消耗品費"), "sales10")).toMatch(/経費/);
    expect(codeMismatch(acc("貸倒金"), "baddebt10")).toBeNull();
    expect(codeMismatch(acc("工具器具備品"), "sales10")).toBeNull(); // 資産の売却
    expect(codeMismatch(acc("借入金"), "purchase10")).toMatch(/負債/);
  });

  test("未設定・組み合わせ・インボイス区分と取引先を見つける（期間の外と削除済みは見ない）", () => {
    const untaxed = line("2026-05-01", "debit", "消耗品費", 1000, null);
    const before = line("2026-03-01", "debit", "消耗品費", 1000, null);
    const wrong = line("2026-05-02", "credit", "売上高", 1000, "purchase10", "qualified");
    const q1 = line("2026-05-03", "debit", "外注工賃", 1000, "purchase10", "qualified", { counterparty_id: 1 });
    const t2 = line("2026-05-04", "debit", "消耗品費", 1000, "purchase10", "transitional", { counterparty_id: 2 });
    const q3 = line("2026-05-05", "debit", "消耗品費", 1000, "purchase10", "qualified", { counterparty_id: 3 });
    const deleted = line("2026-05-06", "debit", "消耗品費", 1000, null, null, { is_deleted: 1 });
    const issues = run([untaxed, before, wrong, q1, t2, q3, deleted]);
    expect(issues.map((i) => [i.level, i.entryIds])).toEqual([
      ["error", [untaxed.entry_id]],
      ["warn", [wrong.entry_id]],
      ["warn", [q1.entry_id]],
      ["warn", [t2.entry_id]],
      ["info", [q3.entry_id]],
    ]);
    expect(issues[4].detail).toMatch(/番号未入力の店/);
  });

  test("設定：引き継いだ2割特例が使えない年、登録番号があるのに免税事業者。免税事業者の年は明細を見ない", () => {
    const y2027 = taxChecks({
      year: 2027, lines: [], accounts, counterparties: cps, taxYears: twenty, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, twenty),
    });
    expect(y2027[0]).toMatchObject({ level: "error", fix: "settings" });
    expect(y2027[0].detail).toMatch(/令和8年/);
    const exempt = run([line("2026-05-01", "debit", "消耗品費", 1000, null)], [], { invoiceNo: "T1234567890123", registeredOn: "2026-10-01" });
    expect(exempt.map((i) => i.title)).toEqual(["登録番号があるのに免税事業者になっています"]);
  });

  test("本則課税で課税売上割合が 95% 未満なら知らせる", () => {
    const standard: TaxYear[] = [{ ...twenty[0], status: "standard", taxable_from: "" }];
    const lines = [line("2026-05-01", "credit", "売上高", 110000, "sales10"), line("2026-05-02", "credit", "雑収入", 10000, "sales_nontax")];
    expect(run(lines, standard).map((i) => i.title)).toEqual([expect.stringMatching(/90\.90%/)]);
    expect(run(lines)).toEqual([]); // 2割特例では関係ない
  });
});

describe("年末一括の家事分の税区分", () => {
  const utl = acc("水道光熱費");
  test("年間の計上額の割合で分け、端数は大きい余りから配る", () => {
    const lines = [
      line("2026-01-10", "debit", "水道光熱費", 7000, "purchase10", "qualified"),
      line("2026-02-10", "debit", "水道光熱費", 2000, "purchase10", "transitional"),
      line("2026-03-10", "debit", "水道光熱費", 1000, "purchase8", "qualified"),
      line("2026-03-20", "credit", "水道光熱費", 1000, "purchase8", "qualified"), // 返金で 0
    ];
    expect(privateTaxSplit(utl, lines, 1001)).toEqual([
      { tax_code: "purchase10", invoice_kind: "qualified", amount: 779 },
      { tax_code: "purchase10", invoice_kind: "transitional", amount: 222 },
    ]);
  });

  test("税区分の無い明細の分は対象外。税区分がまったく無ければ1つ（初期値）。作り直す仕訳は除く", () => {
    const a = line("2026-01-10", "debit", "水道光熱費", 3000, null);
    const b = line("2026-06-10", "debit", "水道光熱費", 1000, "purchase10", "qualified");
    expect(privateTaxSplit(utl, [a, b], 400)).toEqual([
      { tax_code: "none", invoice_kind: null, amount: 300 },
      { tax_code: "purchase10", invoice_kind: "qualified", amount: 100 },
    ]);
    expect(privateTaxSplit(utl, [a], 400)).toEqual([{ tax_code: null, invoice_kind: null, amount: 400 }]);
    expect(privateTaxSplit(utl, [a, b], 400, [a.entry_id])).toEqual([{ tax_code: "purchase10", invoice_kind: "qualified", amount: 400 }]);
  });
});
