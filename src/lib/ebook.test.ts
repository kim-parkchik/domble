import { describe, expect, test } from "bun:test";
import type { FlatLine } from "./accounting";
import {
  electronicRule, filingDeadline, filingFormName, inputTimeliness, isBeforeStrict, isYearCompliant, percentOf, processingManual, scanStorageRule, timelinessCaution,
} from "./ebook";

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
    // タイムスタンプを付けないので、読み取った書類も紙の原本を保存する
    expect(m).toContain("紙の原本を保存する");
  });
});

describe("電子取引データの事務処理規程（ひな形）", () => {
  test("国税庁の個人事業者の例に沿い、訂正・削除は domble の訂正・無効で行う。施行日は令和の年", () => {
    const r = electronicRule({ businessName: "テスト商店", ownerName: "山田 太郎", year: 2026, fileName: "a.dmbl" });
    expect(r).toContain("電子取引データの訂正及び削除の防止に関する事務処理規程");
    expect(r).toContain("（訂正削除の原則禁止）");
    expect(r).toContain("正当な理由がある場合に限る。");
    expect(r).toContain("「無効」にする");
    expect(r).toContain("a.dmbl");
    expect(r).toContain("令和8年1月1日から施行する");
  });
});

describe("入力の時期（年末や年が明けてからまとめて入力した年）", () => {
  /** 借方・貸方1行ずつの仕訳 */
  const entry = (id: number, date: string, createdAt: string, opts: { adjustment?: boolean; deleted?: boolean } = {}): FlatLine[] =>
    (["debit", "credit"] as const).map((side) => ({
      entry_id: id, date, description: "", row_no: 1, side, account_id: 1, sub_account_id: null, amount: 1_000, memo: "",
      created_at: createdAt, is_adjustment: opts.adjustment ? 1 : 0, is_deleted: opts.deleted ? 1 : 0,
    }));

  test("遅れて登録・年が明けてから登録（決算整理を除く）・最初の登録日。遅れて登録が半分未満なら注意しない", () => {
    const t = inputTimeliness([
      ...entry(1, "2026-01-10", "2026-01-12 10:00:00"),
      ...entry(2, "2026-03-01", "2026-06-30 10:00:00"), // 121日後：遅れて登録
      ...entry(3, "2026-12-20", "2027-01-08 09:00:00"), // 年が明けてから（期間内）
      ...entry(4, "2026-12-31", "2027-02-20 09:00:00", { adjustment: true }), // 決算整理は「年が明けてから」に数えない
      ...entry(5, "2026-02-01", "2026-12-28 09:00:00", { deleted: true }), // 削除済みは数えない
    ], 70, 2026);
    expect(t).toEqual({ total: 4, late: 1, afterYearEnd: 1, firstRecorded: "2026-01-12", caution: false });
  });

  test("年が明けてからまとめて入れた年は注意（半分以上）。文に件数と割合", () => {
    const lines = [
      ...entry(1, "2026-03-10", "2027-02-01 09:00:00"),
      ...entry(2, "2026-11-10", "2027-02-01 09:00:00"),
      ...entry(3, "2026-12-15", "2026-12-20 09:00:00"),
      ...entry(4, "2026-12-25", "2027-01-05 09:00:00"),
    ];
    const t = inputTimeliness(lines, 70, 2026);
    expect(t).toMatchObject({ total: 4, late: 2, afterYearEnd: 3, firstRecorded: "2026-12-20", caution: true });
    expect(percentOf(2, 4)).toBe("50.0%");
    expect(timelinessCaution(t, 70, 2026)).toContain("2026年の仕訳 4 件のうち 2 件（50.0%）");
    expect(inputTimeliness([], 70, 2026)).toEqual({ total: 0, late: 0, afterYearEnd: 0, firstRecorded: null, caution: false });
  });
});

describe("スキャナによる電子化保存規程（ひな形）", () => {
  test("国税庁のサンプルの章立てに沿う。入力の時期は方式とサイクルの月数で変わり、原本は保存する", () => {
    const o = { businessName: "テスト商店", ownerName: "山田 太郎", year: 2026, fileName: "a.dmbl" };
    const cycle = scanStorageRule({ ...o, method: "cycle1" });
    expect(cycle).toContain("スキャナによる電子化保存規程");
    expect(cycle).toContain("受け取った日から1か月以内");
    expect(cycle).toContain("業務処理サイクル方式");
    expect(cycle).toContain("原本は廃棄せず");
    expect(cycle).toContain("令和8年1月1日から施行する");
    expect(scanStorageRule({ ...o, method: "cycle" })).toContain("受け取った日から2か月以内");
    const early = scanStorageRule({ ...o, method: "early" });
    expect(early).toContain("おおむね７営業日以内）に取り込む（早期入力方式）");
    expect(early).not.toContain("か月以内");
  });
});
