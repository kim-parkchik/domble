import { describe, expect, test } from "bun:test";
import { filingDeadline, filingFormName, isBeforeStrict, isYearCompliant, processingManual } from "./ebook";

describe("年ごとの電子帳簿保存法への対応", () => {
  test("最初から厳密：全部の年。途中から：その年から。通常：どの年も対応外", () => {
    const strict = { e_book_mode: "strict" as const, strict_from_year: null };
    const switched = { e_book_mode: "strict" as const, strict_from_year: 2027 };
    const standard = { e_book_mode: "standard" as const, strict_from_year: null };
    expect([isYearCompliant(strict, 2020), isYearCompliant(switched, 2026), isYearCompliant(switched, 2027), isYearCompliant(standard, 2027)]).toEqual([true, false, true, false]);
    expect([isBeforeStrict(switched, 2026), isBeforeStrict(switched, 2027), isBeforeStrict(standard, 2026), isBeforeStrict(strict, 2026)]).toEqual([true, false, false, false]);
  });
});

describe("届出", () => {
  test("提出期限は翌年3月15日。土日・祝日なら次の平日", () => {
    expect(filingDeadline(2026, new Set())).toBe("2027-03-15"); // 月曜
    expect(filingDeadline(2025, new Set())).toBe("2026-03-16"); // 15日が日曜
    expect(filingDeadline(2026, new Set(["2027-03-15"]))).toBe("2027-03-16");
  });

  test("青色申告なら65万円控除と一体の様式。ひな形には事業者名と入力期間が入る", () => {
    expect(filingFormName(true, 2026)).toContain("65万円の青色申告特別控除");
    expect(filingFormName(true, 2027)).toContain("75万円の青色申告特別控除");
    expect(filingFormName(false, 2027)).not.toContain("万円");
    const m = processingManual({ businessName: "テスト商店", ownerName: "山田 太郎", year: 2027, inputDays: 70, fileName: "a.dmbl" });
    expect(m).toContain("テスト商店");
    expect(m).toContain("70日以内");
    expect(m).toContain("2027年1月1日");
  });
});
