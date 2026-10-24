import { expect, test } from "bun:test";
import { lastHolidayYear, mergeHolidays, parseHolidaysCsv } from "./holidays";
import { BUILTIN_HOLIDAYS } from "../constants/holidays";

test("内閣府の CSV を読む（見出しと読めない行は飛ばす）", () => {
  const csv = "国民の祝日・休日月日,国民の祝日・休日名称\r\n2027/1/1,元日\r\n2027/11/3,文化の日\r\nこわれた行\r\n";
  expect(parseHolidaysCsv(csv)).toEqual([{ date: "2027-01-01", name: "元日" }, { date: "2027-11-03", name: "文化の日" }]);
  expect(parseHolidaysCsv("<html>見つかりません</html>")).toEqual([]);
});

test("内蔵と取得したものを合わせる（同じ日は取得した方）", () => {
  const merged = mergeHolidays([{ date: "2027-01-01", name: "元日" }], [{ date: "2027-01-01", name: "元日（新）" }, { date: "2028-01-01", name: "元日" }]);
  expect(merged).toEqual([{ date: "2027-01-01", name: "元日（新）" }, { date: "2028-01-01", name: "元日" }]);
  expect(lastHolidayYear(merged)).toBe(2028);
});

test("内蔵の祝日は2000年からあり、2026年の文化の日が入っている", () => {
  expect(BUILTIN_HOLIDAYS[0].date).toBe("2000-01-01");
  expect(BUILTIN_HOLIDAYS.some((h) => h.date === "2026-11-03" && h.name === "文化の日")).toBe(true);
  expect(lastHolidayYear(BUILTIN_HOLIDAYS)).toBeGreaterThanOrEqual(2027);
});
