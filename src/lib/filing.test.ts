/**
 * 申告の種類と青色申告特別控除の見直し（令和8年度税制改正。令和9年分から 75万円・65万円・10万円。財務省「令和8年度税制改正の大綱」）
 */
import { describe, expect, test } from "bun:test";
import { filingNotes, filingTypeProblem, filingTypesFor, isFilingType } from "./filing";
import { blueDeductionLimit, computeIncomeTax, EMPTY_INCOME_TAX_INPUT, type BusinessFigures, type IncomeTaxResult } from "./incomeTax";
import { realEstateDeductionLimit } from "./realEstateStatement";

const blueRow = (r: IncomeTaxResult) => r.rows.find((x) => x.label === "青色申告特別控除額")!.value;
const biz = (filingType: BusinessFigures["filingType"], incomeBeforeBlue = 3_000_000): BusinessFigures => ({ revenue: 8_000_000, incomeBeforeBlue, filingType, familySalary: 0 });

describe("選べる種類", () => {
  test("令和8年分までは 65万・55万・10万円、令和9年分からは 75万・65万・10万円（55万円は無くなる）", () => {
    expect(filingTypesFor(2026)).toEqual(["blue65", "blue55", "blue10", "white"]);
    expect(filingTypesFor(2027)).toEqual(["blue75", "blue65", "blue10", "white"]);
    expect([filingTypeProblem("blue75", 2026), filingTypeProblem("blue55", 2027), filingTypeProblem("blue65", 2027)]).toEqual([
      "75万円の青色申告特別控除は令和9年分からです", expect.stringContaining("55万円の青色申告特別控除は令和8年分まで"), "",
    ]);
    expect([isFilingType("blue75"), isFilingType("blue30"), isFilingType("toString")]).toEqual([true, false, false]);
  });
});

describe("控除の上限", () => {
  test("75万円は令和9年分から。55万円を引き継いだ令和9年分以後の年は、書面で申告したときの 10万円", () => {
    expect((["blue75", "blue65", "blue55", "blue10", "white"] as const).map((t) => blueDeductionLimit(t, 2026))).toEqual([650_000, 650_000, 550_000, 100_000, 0]);
    expect((["blue75", "blue65", "blue55", "blue10", "white"] as const).map((t) => blueDeductionLimit(t, 2027))).toEqual([750_000, 650_000, 100_000, 100_000, 0]);
  });
  test("確定申告書：令和9年分の 75万円控除。所得が少なければ所得まで", () => {
    expect(blueRow(computeIncomeTax(EMPTY_INCOME_TAX_INPUT, biz("blue75"), 2027))).toBe(750_000);
    expect(blueRow(computeIncomeTax(EMPTY_INCOME_TAX_INPUT, biz("blue75", 600_000), 2027))).toBe(600_000);
    expect(blueRow(computeIncomeTax(EMPTY_INCOME_TAX_INPUT, biz("blue55"), 2027))).toBe(100_000);
    expect(blueRow(computeIncomeTax(EMPTY_INCOME_TAX_INPUT, biz("blue55"), 2026))).toBe(550_000);
  });
  test("不動産所得：事業所得が無く事業的規模でない貸付けは、75万円の年も 10万円まで。不動産所得から先に差し引く", () => {
    expect([realEstateDeductionLimit("blue75", 2027, "small", false), realEstateDeductionLimit("blue75", 2027, "business", false), realEstateDeductionLimit("blue75", 2027, "small", true)])
      .toEqual([100_000, 750_000, 750_000]);
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, {
      ...biz("blue75", 1_000_000), realEstate: { revenue: 1_200_000, incomeBeforeBlue: 500_000, familySalary: 0, scale: "business", landInterest: 0 },
    }, 2027);
    expect(blueRow(r)).toBe(750_000);
  });
});

describe("知らせること", () => {
  const ok = { compliant: true, filed: true };
  test("令和8年分までは何も知らせない", () => {
    expect(filingNotes("blue55", 2026, ok)).toEqual([]);
  });
  test("55万円を引き継いだ年は 10万円で計算していること", () => {
    expect(filingNotes("blue55", 2027, ok)).toEqual([{ level: "warn", text: expect.stringContaining("10万円で計算しています") }]);
  });
  test("75万円：厳密モードの年でない・届出書のチェックが無ければ注意。そろっていれば e-Tax の条件だけ", () => {
    expect(filingNotes("blue75", 2027, { compliant: false, filed: true })[0]).toMatchObject({ level: "warn", text: expect.stringContaining("2027年は電子帳簿保存法の対応外") });
    expect(filingNotes("blue75", 2027, { compliant: true, filed: false })[0]).toMatchObject({ level: "warn", text: expect.stringContaining("届出書を出したことにチェックがありません") });
    expect(filingNotes("blue75", 2027, ok)).toEqual([{ level: "info", text: "75万円の控除は、e-Tax で期限内に申告することが条件です（書面で出すと10万円）。" }]);
  });
  test("65万円：条件がそろっていれば 75万円にできること", () => {
    expect(filingNotes("blue65", 2027, ok)[0].text).toContain("75万円にできます");
    expect(filingNotes("blue65", 2027, { compliant: true, filed: false })[0].text).not.toContain("75万円にできます");
    expect([filingNotes("blue10", 2027, ok), filingNotes("white", 2027, ok)]).toEqual([[], []]);
  });
});
