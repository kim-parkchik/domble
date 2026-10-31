import { describe, expect, test } from "bun:test";
import { consumptionTaxDeadline, daysUntil, incomeTaxDeadline, nextWeekday } from "./deadlines";

describe("申告の期限", () => {
  test("所得税は翌年3月15日、消費税は3月31日。土日・祝日なら次の平日", () => {
    expect(incomeTaxDeadline(2026, new Set())).toBe("2027-03-15"); // 月曜
    expect(incomeTaxDeadline(2025, new Set())).toBe("2026-03-16"); // 15日が日曜
    expect(consumptionTaxDeadline(2026, new Set())).toBe("2027-03-31"); // 水曜
    expect(consumptionTaxDeadline(2027, new Set())).toBe("2028-03-31"); // 金曜
    expect(consumptionTaxDeadline(2029, new Set())).toBe("2030-04-01"); // 31日が日曜
    expect(nextWeekday("2027-03-15", new Set(["2027-03-15"]))).toBe("2027-03-16");
  });
  test("残りの日数", () => {
    expect(daysUntil("2027-03-01", "2027-03-15")).toBe(14);
    expect(daysUntil("2027-03-16", "2027-03-15")).toBe(-1);
  });
});
