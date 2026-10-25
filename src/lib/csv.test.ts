import { expect, test } from "bun:test";
import { csvCell, parseCsv, toCsv, unguardCell } from "./csv";

test("読み込み：引用符・カンマ・改行・\"\"・BOM・CRLF", () => {
  expect(parseCsv('﻿"a","b,c"\r\n"x ""y""","複数\n行"\r\n1,2')).toEqual([["a", "b,c"], ['x "y"', "複数\n行"], ["1", "2"]]);
  expect(parseCsv("a,b\n\nc,")).toEqual([["a", "b"], [""], ["c", ""]]);
  expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
});

test("書き出して読み込むと元に戻る", () => {
  const rows = [["-返金", "=1+1", "A社 \"特急\"", "改行\nあり", "2026-01-05"]];
  const back = parseCsv(toCsv(["h1", "h2", "h3", "h4", "h5"], rows)).slice(1).map((r) => r.map(unguardCell));
  expect(back).toEqual(rows);
});

test("以前の書き出しでつけていた ' は、取り込みのときに外す（= + - @ の前の ' だけ）", () => {
  expect(["'-返金", "'=1+1", "'+1", "'@SUM(A1)"].map(unguardCell)).toEqual(["-返金", "=1+1", "+1", "@SUM(A1)"]);
  expect(unguardCell("'普通の文")).toBe("'普通の文");
});

test("引用符で囲み、中の \" は二重にする", () => {
  expect(csvCell('A社 "特急"')).toBe('"A社 ""特急"""');
  expect(csvCell("改行\nあり")).toBe('"改行\nあり"');
  expect(csvCell(null)).toBe('""');
});

test("摘要などは記録したとおりに書き出す（何も足さない）。数値もそのまま", () => {
  expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"=HYPERLINK(""http://x"")"');
  expect(csvCell("+1")).toBe('"+1"');
  expect(csvCell("-返金")).toBe('"-返金"');
  expect(csvCell("@SUM(A1)")).toBe('"@SUM(A1)"');
  expect(csvCell(-1200)).toBe('"-1200"');
  expect(csvCell("2026-01-05")).toBe('"2026-01-05"');
});

test("BOM つき・CRLF", () => {
  expect(toCsv(["a", "b"], [[1, "x"]])).toBe('﻿"a","b"\r\n"1","x"');
});
