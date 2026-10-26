import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { baseSalesInfo, mandatoryReason, methodProblem, periodSales } from "./baseSales";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
let seq = 0;
const line = (date: string, side: "debit" | "credit", name: string, amount: number, tax: FlatLine["tax_code"] = null): FlatLine => ({
  entry_id: ++seq, date, description: "", row_no: 1, side, account_id: id(name), sub_account_id: null, amount, memo: "", tax_code: tax,
});

describe("基準期間の課税売上高", () => {
  test("国税庁の手引きの計算例：免税事業者の期間はそのまま、課税事業者の期間は税抜き（7,500,000 ＋ 3,300,000 × 100/110）", () => {
    const years: TaxYear[] = [{ from_year: 2023, status: "twenty", method: "inclusive", business_class: 5, taxable_from: "2023-10-01" }];
    const s = periodSales([
      line("2023-05-01", "credit", "売上高", 7_500_000),
      line("2023-11-01", "credit", "売上高", 3_300_000, "sales10"),
    ], accounts, years, "2023-01-01", "2023-12-31");
    expect(s).toEqual({ taxable: 3_000_000, exemptPeriod: 7_500_000, exportSales: 0, total: 10_500_000 });
  });

  test("返還を差し引き、輸出を足す。税区分が無い明細は科目の初期値で決める（給料・預金などは数えない）", () => {
    const years: TaxYear[] = [{ from_year: 2024, status: "standard", method: "inclusive", business_class: 5, taxable_from: "" }];
    const s = periodSales([
      line("2024-02-01", "credit", "売上高", 1_100_000, "sales10"),
      line("2024-02-02", "debit", "売上高", 110_000, "sales10"),
      line("2024-02-03", "credit", "売上高", 1_080_000, "sales8"),
      line("2024-02-04", "credit", "売上高", 500_000, "export"),
      line("2024-02-05", "credit", "雑収入", 99_000, "sales_nontax"),
      line("2024-02-06", "credit", "家事消費等", 22_000), // 初期値は課税売上
      line("2024-02-07", "credit", "普通預金", 1_000_000),
      line("2023-12-31", "credit", "売上高", 9_999_999, "sales10"), // 期間外
    ], accounts, years, "2024-01-01", "2024-12-31");
    expect(s).toEqual({ taxable: 1_000_000 - 100_000 + 1_000_000 + 20_000, exemptPeriod: 0, exportSales: 500_000, total: 2_420_000 });
  });

  test("帳簿が無ければ手で入れた額、手で入れていれば帳簿より優先。特定期間は前年1〜6月", () => {
    const common = { year: 2026, accounts, taxYears: [] as TaxYear[] };
    expect(baseSalesInfo({ ...common, baseLines: [], prevLines: [], manual: null })).toMatchObject({ base: null, source: "none", specific: null });
    const baseLines = [line("2024-03-01", "credit", "売上高", 4_000_000)];
    expect(baseSalesInfo({ ...common, baseLines, prevLines: [], manual: null })).toMatchObject({ base: 4_000_000, source: "books" });
    expect(baseSalesInfo({ ...common, baseLines, prevLines: [], manual: 5_000_000 })).toMatchObject({ base: 5_000_000, source: "manual", fromBooks: { total: 4_000_000 } });
    const prevLines = [
      line("2025-06-30", "credit", "売上高", 12_000_000),
      line("2025-07-01", "credit", "売上高", 5_000_000),
      line("2025-03-25", "debit", "給料賃金", 11_000_000),
    ];
    const info = baseSalesInfo({ ...common, baseLines, prevLines, manual: null });
    expect(info.specific).toMatchObject({ sales: { total: 12_000_000 }, salaries: 11_000_000 });
    expect(mandatoryReason(info)).toMatch(/特定期間（2025年1〜6月）/);
  });

  test("判定：1,000万円超なら2割特例・3割特例は使えない。5,000万円超なら簡易課税は使えない。分からなければ判定しない", () => {
    const at = (base: number | null) => ({ year: 2026, base, source: "manual" as const, fromBooks: null, specific: null });
    expect(mandatoryReason(at(10_000_000))).toBeNull();
    expect(methodProblem("twenty", at(10_000_001))).toMatch(/2024年.*使えません/);
    expect(methodProblem("simplified", at(10_000_001))).toBeNull();
    expect(methodProblem("simplified", at(50_000_001))).toMatch(/5,000万円/);
    expect(methodProblem("twenty", at(null))).toBeNull();
    // 特定期間は、給与等支払額が 1,000万円以下なら課税事業者にならない
    expect(mandatoryReason({ ...at(0), specific: { sales: { taxable: 0, exemptPeriod: 20_000_000, exportSales: 0, total: 20_000_000 }, salaries: 3_000_000 } })).toBeNull();
  });
});
