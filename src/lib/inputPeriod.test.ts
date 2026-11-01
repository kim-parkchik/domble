import { expect, test } from "bun:test";
import { inputDeadline, inputDelayDays, inputPeriodProblem, inputPeriodText, isLateInput, parseInputPeriod, usesBusinessDays } from "./inputPeriod";

test("取引日から登録日までの日数（時刻は見ない・月や年をまたいでも数える）", () => {
  expect(inputDelayDays("2026-04-15", "2026-04-15 23:59:59")).toBe(0);
  expect(inputDelayDays("2026-01-31", "2026-03-01 08:00:00")).toBe(29);
  expect(inputDelayDays("2025-12-31", "2026-01-01 00:00:00")).toBe(1);
  expect(inputDelayDays("2024-02-28", "2024-03-01")).toBe(2); // うるう年
  expect(inputDelayDays("2026-05-10", "2026-05-01 10:00:00")).toBe(-9); // 先の日付で登録
});

test("入力期間を過ぎたか（ちょうど期限の日はまだ期間内）", () => {
  expect(isLateInput("2026-01-01", "2026-03-12 10:00:00", 70)).toBe(false); // 70日後
  expect(isLateInput("2026-01-01", "2026-03-13 10:00:00", 70)).toBe(true); // 71日後
  expect(isLateInput("2026-05-10", "2026-05-01", 70)).toBe(false);
  expect(isLateInput("2026-01-01", null, 70)).toBe(false);
});

test("営業日：土日と祝日・休業日を除いて数える", () => {
  const p = { kind: "business" as const, days: 5 };
  expect(inputDeadline("2026-04-24", p)).toBe("2026-05-01"); // 金曜から5営業日（土日を除く）
  expect(inputDeadline("2026-04-24", p, new Set(["2026-04-29"]))).toBe("2026-05-04"); // 祝日も除く
  expect(isLateInput("2026-04-24", "2026-05-01 09:00:00", p)).toBe(false);
  expect(isLateInput("2026-04-24", "2026-05-04", p)).toBe(true);
});

test("月末：取引の月の翌月末・翌々月末まで、さらに営業日", () => {
  expect(inputDeadline("2026-01-15", { kind: "monthEnd", months: 1, extra: 0 })).toBe("2026-02-28");
  expect(inputDeadline("2026-01-31", { kind: "monthEnd", months: 2, extra: 0 })).toBe("2026-03-31");
  expect(inputDeadline("2026-11-03", { kind: "monthEnd", months: 2, extra: 0 })).toBe("2027-01-31"); // 年をまたぐ
  // 2026-02-28 は土曜：そこから7営業日は 3/10（3/2〜3/6・3/9・3/10）
  expect(inputDeadline("2026-01-15", { kind: "monthEnd", months: 1, extra: 7 })).toBe("2026-03-10");
  expect(isLateInput("2026-01-15", "2026-03-10", { kind: "monthEnd", months: 1, extra: 7 })).toBe(false);
  expect(isLateInput("2026-01-15", "2026-03-11", { kind: "monthEnd", months: 1, extra: 7 })).toBe(true);
});

test("文・営業日を使うか・問題・保存した値の読み込み（読めなければ日数）", () => {
  expect(inputPeriodText({ kind: "days", days: 70 })).toBe("取引日から 70 日");
  expect(inputPeriodText({ kind: "business", days: 50 })).toBe("取引日から 50 営業日");
  expect(inputPeriodText({ kind: "monthEnd", months: 1, extra: 7 })).toBe("取引の月の翌月末から 7 営業日");
  expect(inputPeriodText({ kind: "monthEnd", months: 2, extra: 0 })).toBe("取引の月の翌々月末まで");
  expect(usesBusinessDays({ kind: "monthEnd", months: 1, extra: 0 })).toBe(false);
  expect(usesBusinessDays({ kind: "monthEnd", months: 1, extra: 3 })).toBe(true);
  expect(inputPeriodProblem({ kind: "days", days: 0 })).toMatch(/1〜365 日/);
  expect(inputPeriodProblem({ kind: "monthEnd", months: 3, extra: 0 })).toMatch(/翌月末か翌々月末/);
  expect(parseInputPeriod("", 60)).toEqual({ kind: "days", days: 60 });
  expect(parseInputPeriod(JSON.stringify({ kind: "monthEnd", months: 1, extra: 7 }), 70)).toEqual({ kind: "monthEnd", months: 1, extra: 7 });
  expect(parseInputPeriod("壊れた", 70)).toEqual({ kind: "days", days: 70 });
  expect(parseInputPeriod(JSON.stringify({ kind: "business", days: 0 }), 70)).toEqual({ kind: "days", days: 70 });
});
