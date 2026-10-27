/**
 * 消費税の中間申告の判定（国税庁 タックスアンサー No.6609「中間申告の方法」・No.6611「任意の中間申告制度」）
 */
import { describe, expect, test } from "bun:test";
import type { TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { interimKind, interimPlan, nextOpenDay, prevTaxInfo } from "./taxInterim";
import { buildTaxBase, standardReturn } from "./taxReturn";

const plan = (prevTax: number | null, x: { voluntary?: boolean; exempt?: boolean; holidays?: string[] } = {}) =>
  interimPlan({ year: 2026, prevTax, exempt: x.exempt ?? false, voluntary: x.voluntary ?? false, holidays: new Set(x.holidays ?? []) });

describe("回数の判定（前年の確定消費税額）", () => {
  test("48万円以下は要らない・400万円以下は年1回・4,800万円以下は年3回・超えたら年11回", () => {
    expect(interimKind(480_000, false, false)).toBe("none");
    expect(interimKind(480_001, false, false)).toBe("once");
    expect(interimKind(4_000_000, false, false)).toBe("once");
    expect(interimKind(4_000_001, false, false)).toBe("three");
    expect(interimKind(48_000_000, false, false)).toBe("three");
    expect(interimKind(48_000_001, false, false)).toBe("monthly");
  });
  test("その年が免税事業者なら無い。前年の税額が分からなければ判定しない", () => {
    expect(interimKind(10_000_000, true, false)).toBe("exempt");
    expect(interimKind(null, false, false)).toBe("unknown");
  });
  test("任意の中間申告：48万円以下で届出をしていれば年1回（前年の税額が 0 なら無い）", () => {
    expect(interimKind(400_000, false, true)).toBe("voluntary");
    expect(interimKind(0, false, true)).toBe("none");
    expect(interimKind(1_000_000, false, true)).toBe("once");
  });
});

describe("中間納付税額と期限", () => {
  test("年1回：6/12 を百円未満切り捨て。地方消費税はその 22/78 を百円未満切り捨て", () => {
    const p = plan(1_234_567);
    expect(p.periods).toEqual([{ no: 1, from: "2026-01-01", to: "2026-06-30", due: "2026-08-31", payBy: "2026-08-31", national: 617_200, local: 174_000 }]);
    expect([p.national, p.local]).toEqual([617_200, 174_000]);
  });
  test("年3回：3/12 ずつ。期限が日曜なら次の日", () => {
    const p = plan(6_000_000);
    expect(p.periods.map((x) => [x.from, x.to, x.due, x.payBy])).toEqual([
      ["2026-01-01", "2026-03-31", "2026-05-31", "2026-06-01"],
      ["2026-04-01", "2026-06-30", "2026-08-31", "2026-08-31"],
      ["2026-07-01", "2026-09-30", "2026-11-30", "2026-11-30"],
    ]);
    expect(p.periods.every((x) => x.national === 1_500_000 && x.local === 423_000)).toBe(true);
    expect([p.national, p.local]).toEqual([4_500_000, 1_269_000]);
  });
  test("年11回：1/12 ずつ。1月分・2月分は5月31日、年末年始と土日は次の日", () => {
    const p = plan(60_000_000);
    expect(p.periods).toHaveLength(11);
    expect(p.periods.map((x) => x.due)).toEqual([
      "2026-05-31", "2026-05-31", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31",
    ]);
    expect(p.periods[7].payBy).toBe("2026-11-02");
    expect(p.periods[9].payBy).toBe("2027-01-04");
    expect(p.periods[10].payBy).toBe("2027-02-01");
    expect([p.periods[0].national, p.periods[0].local]).toEqual([5_000_000, 1_410_200]);
    expect(p.national).toBe(55_000_000);
  });
  test("任意の中間申告は年1回（6/12）", () => {
    const p = plan(400_000, { voluntary: true });
    expect(p.kind).toBe("voluntary");
    expect(p.periods.map((x) => [x.national, x.local])).toEqual([[200_000, 56_400]]);
  });
  test("要らない・免税事業者・分からないときは予定が無い", () => {
    for (const p of [plan(480_000), plan(5_000_000, { exempt: true }), plan(null)]) expect([p.periods.length, p.national, p.local]).toEqual([0, 0, 0]);
  });
  test("期限が祝日なら次の日", () => {
    expect(nextOpenDay("2026-08-31", new Set(["2026-08-31"]))).toBe("2026-09-01");
    expect(nextOpenDay("2026-12-29")).toBe("2027-01-04");
  });
});

describe("前年の確定消費税額", () => {
  const line = (date: string, side: FlatLine["side"], amount: number, tax_code: FlatLine["tax_code"]): FlatLine => ({
    entry_id: 1, date, description: "", row_no: 1, side, account_id: 1, sub_account_id: null, amount, memo: "", tax_code, invoice_kind: tax_code === "purchase10" ? "qualified" : null,
  });
  const lines = [line("2025-05-01", "credit", 22_000_000, "sales10"), line("2025-05-02", "debit", 5_500_000, "purchase10")];
  const standard: TaxYear[] = [{ from_year: 2025, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" }];

  test("前年の帳簿と前年の課税区分で ⑨ を計算する", () => {
    const info = prevTaxInfo({ year: 2026, prevLines: lines, taxYears: standard, manual: null });
    const opts = { businessClass: 5, interimNational: 0, interimLocal: 0 };
    expect(info).toMatchObject({ year: 2025, source: "books", method: "standard", amount: standardReturn(buildTaxBase(lines, standard), opts).net });
    expect(info.amount).toBe(1_170_000);
  });
  test("前年が簡易課税なら簡易課税で計算する", () => {
    const simplified: TaxYear[] = [{ ...standard[0], status: "simplified", business_class: 5 }];
    // 課税標準額 20,000,000 × 7.8% = 1,560,000、みなし仕入率 50% → 780,000
    expect(prevTaxInfo({ year: 2026, prevLines: lines, taxYears: simplified, manual: null }).amount).toBe(780_000);
  });
  test("手で入れた額が帳簿の計算より優先する", () => {
    expect(prevTaxInfo({ year: 2026, prevLines: lines, taxYears: standard, manual: 300_000 })).toMatchObject({ amount: 300_000, source: "manual", fromBooks: 1_170_000 });
  });
  test("前年が免税事業者なら 0。前年の帳簿も設定も無ければ分からない", () => {
    const from2026: TaxYear[] = [{ ...standard[0], from_year: 2026 }];
    expect(prevTaxInfo({ year: 2026, prevLines: lines, taxYears: from2026, manual: null })).toMatchObject({ amount: 0, source: "exempt" });
    expect(prevTaxInfo({ year: 2026, prevLines: [], taxYears: from2026, manual: null })).toMatchObject({ amount: null, source: "none" });
    expect(prevTaxInfo({ year: 2026, prevLines: [], taxYears: [{ ...standard[0], from_year: 2024, status: "exempt" }, ...from2026], manual: null }))
      .toMatchObject({ amount: 0, source: "exempt" });
  });
});
