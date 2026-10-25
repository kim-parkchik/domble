/**
 * CSV の書き出し（純粋関数）
 *
 * - Excel で文字化けしないよう BOM をつけ、改行は CRLF
 * - 摘要などは記録したとおりに書き出す（市販の会計ソフトと同じく、何も足さない）。
 *   以前は = + - @ で始まる文字列の先頭に ' をつけていた（Excel が数式として実行しないように）が、
 *   書き出した内容が記録と1文字ずれるため、やめた。取り込み（unguardCell）では、以前の CSV のために ' を外して読む
 */
export type CsvValue = string | number | null | undefined;

export const csvCell = (v: CsvValue) => {
  if (v == null) return '""';
  const s = typeof v === "number" ? String(v) : v;
  return `"${s.replace(/"/g, '""')}"`;
};

export const toCsv = (header: string[], rows: CsvValue[][]) =>
  "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

/**
 * CSV を行・列に分ける（RFC 4180：" で囲んだ中のカンマ・改行・"" を扱う）。BOM は除く。
 * 空の行は飛ばさずに残す（行番号をファイルと合わせるため）
 */
export const parseCsv = (text: string): string[][] => {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

/**
 * 以前の書き出しでつけていた ' を外す（= + - @ などの前についた ' だけ）。
 * いまの書き出しは ' をつけないが、前に書き出した CSV を取り込めるように残している
 */
export const unguardCell = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
