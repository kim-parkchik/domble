import { expect, test } from "bun:test";
import { inputDelayDays, isLateInput } from "./inputPeriod";

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
