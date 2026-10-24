/**
 * CSV の書き出し（純粋関数）
 *
 * - Excel で文字化けしないよう BOM をつけ、改行は CRLF
 * - 文字列が = + - @ やタブ・改行で始まると、Excel が数式として実行してしまう（CSV インジェクション）。
 *   その場合は先頭に ' をつけて文字として扱わせる。数値（金額など）はそのまま
 *   → 書き出した摘要などが元の文字列と 1 文字ずれる点は、README の「足りていないところ」に記載
 */
export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export const csvCell = (v: CsvValue) => {
  if (v == null) return '""';
  const s = typeof v === "number" ? String(v) : FORMULA_START.test(v) ? `'${v}` : v;
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

/** 書き出しのときにつけた ' を外す（csvCell の逆） */
export const unguardCell = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
