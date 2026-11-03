/**
 * 申告の控えと、修正申告・更正の請求：控えに残す数字・比べる表・判定・修正の欄・期限
 */
import { describe, expect, test } from "bun:test";
import {
  amendmentOf, claimDeadline, compareFilings, consumptionAmendment, consumptionFilingLines, filingDeadline, incomeAmendment, incomeFilingLines, latestFiling,
  type FilingLine, type TaxFiling,
} from "./amendment";
import { computeIncomeTax, EMPTY_INCOME_TAX_INPUT, type BusinessFigures } from "./incomeTax";
import { standardReturn, type TaxBase } from "./taxReturn";

const line = (key: string, value: number): FilingLine => ({ key, no: "", label: key, value });
const biz: BusinessFigures = { revenue: 5_000_000, incomeBeforeBlue: 4_000_000, filingType: "blue65", familySalary: 0 };

describe("控えに残す数字", () => {
  test("所得税：第一表の主な欄と、第3期分の税額（納める税金 − 還付される税金）", () => {
    const r = computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT, birthday: "1985-06-01" }, biz, 2025);
    const lines = incomeFilingLines(r);
    expect(lines.map((l) => l.key)).toEqual(["business", "total", "deductions", "taxable", "taxTotal", "withheld", "declared", "prepaid", "third"]);
    expect(lines.find((l) => l.key === "business")).toMatchObject({ no: "①", value: r.rows.find((x) => x.no === "①")!.value });
    expect(lines.at(-1)!.value).toBe(r.balance);
  });
  test("消費税：第一表の①②④⑨⑳と、消費税・地方消費税ごとの納付税額（還付は−）・合計 ㉖", () => {
    const zero = { 8: 0, 10: 0 };
    const b: TaxBase = {
      sales: { 8: 0, 10: 33_000_000 }, salesReturn: zero, badDebt: zero, badDebtRecovered: zero, exportSales: 0, nontaxSales: 0,
      purchase: { 8: 0, 10: 11_000_000 }, purchaseReturn: zero, transitional: [], byClass: {},
    };
    const r = standardReturn(b, { businessClass: 5, interimNational: 0, interimLocal: 0 });
    const lines = consumptionFilingLines(r);
    expect(lines.map((l) => l.key)).toEqual(["base", "tax", "deduct", "net", "localTax", "national", "local", "total"]);
    expect(lines.find((l) => l.key === "national")!.value).toBe(r.national);
    expect(lines.find((l) => l.key === "total")!.value).toBe(r.national + r.local);
  });
});

describe("比べる表と判定", () => {
  test("行ごとの修正前・今・差。修正前にしか無い行はあと", () => {
    expect(compareFilings([line("a", 10), line("old", 5)], [line("a", 15), line("b", 3)])).toEqual([
      { key: "a", no: "", label: "a", before: 10, after: 15, diff: 5 },
      { key: "b", no: "", label: "b", before: null, after: 3, diff: 3 },
      { key: "old", no: "", label: "old", before: 5, after: null, diff: -5 },
    ]);
  });
  test("所得税：第3期分の税額が増えれば修正申告（増加額は百円未満切り捨て）、減れば更正の請求", () => {
    expect(incomeAmendment([line("third", 50_000)], [line("third", 80_000)])).toEqual({
      status: "amend", increase: 30_000, decrease: 0, income: { before: 50_000, increase: 30_000 },
    });
    // 修正前が還付（端数のまま）：返す還付と納める税額の合計を百円未満切り捨て
    expect(incomeAmendment([line("third", -12_345)], [line("third", 5_000)]).income).toEqual({ before: -12_345, increase: 17_300 });
    expect(incomeAmendment([line("third", 80_000)], [line("third", 50_000)])).toMatchObject({ status: "claim", decrease: 30_000 });
    expect(incomeAmendment([line("third", 0), line("total", 100)], [line("third", 0), line("total", 200)]).status).toBe("other");
    expect(amendmentOf("income", [line("third", 0)], [line("third", 0)]).status).toBe("same");
  });
  test("消費税：⑬ 既確定税額・⑭ 差引納付税額（百円未満切り捨て）、㉔㉕、㉖ ＝ ⑭＋㉕", () => {
    const before = [line("national", 100_000), line("local", 28_200)];
    expect(consumptionAmendment(before, [line("national", 150_000), line("local", 42_300)]).consumption).toEqual({
      known: 100_000, pay: 50_000, knownLocal: 28_200, payLocal: 14_100, total: 64_100,
    });
    // 修正前が還付（控除不足還付税額は端数のまま）
    const refund = consumptionAmendment([line("national", -30_123), line("local", -8_496)], [line("national", 50_000), line("local", 14_100)]);
    expect(refund.consumption).toEqual({ known: -30_123, pay: 80_100, knownLocal: -8_496, payLocal: 22_500, total: 102_600 });
    expect(consumptionAmendment(before, [line("national", 60_000), line("local", 16_900)])).toMatchObject({ status: "claim", decrease: 51_300 });
  });
});

describe("控えと期限", () => {
  const f = (id: number, filed_on: string, tax: TaxFiling["tax"] = "income", fiscal_year = 2025): TaxFiling =>
    ({ id, fiscal_year, tax, kind: "original", filed_on, lines: [], memo: "" });
  test("いちばん新しい控え（申告した日、同じ日なら新しく登録したもの）が修正前", () => {
    const list = [f(1, "2026-03-01"), f(3, "2026-05-10"), f(2, "2026-05-10"), f(4, "2026-06-01", "consumption"), f(5, "2027-03-01", "income", 2026)];
    expect(latestFiling(list, "income", 2025)?.id).toBe(3);
    expect(latestFiling(list, "consumption", 2025)?.id).toBe(4);
    expect(latestFiling(list, "consumption", 2026)).toBeNull();
  });
  test("更正の請求の期限：法定申告期限（土日・祝日なら次の平日）から5年", () => {
    const none = new Set<string>();
    // 令和7年分の所得税：令和8年3月15日は日曜 → 3月16日。5年後の 2031-03-16 は日曜 → 17日
    expect([filingDeadline("income", 2025, none), claimDeadline("income", 2025, none)]).toEqual(["2026-03-16", "2031-03-17"]);
    expect([filingDeadline("consumption", 2025, none), claimDeadline("consumption", 2025, none)]).toEqual(["2026-03-31", "2031-03-31"]);
  });
});
