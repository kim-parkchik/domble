/**
 * 祝日・休業日（純粋関数）
 *  - 祝日：ソフトに内蔵した一覧（constants/holidays.ts）に、利用者が「最新の祝日を取得」で内閣府から取得したものを足す
 *  - 休業日：事業者が自分で足す日（年末年始休業など）
 * 営業日は、土日・祝日・休業日を除いた日（スキャナ保存の入力期限などで使う）
 */

/** 内閣府が公開している祝日の一覧（CSV。Shift_JIS） */
export const CAO_HOLIDAYS_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

export interface Holiday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
}

/**
 * 内閣府の CSV（1行目は見出し。「1955/1/1,元日」の形）を読む。読めない行は飛ばす
 * 1件も読めなければ空（ページの形が変わったなど）
 */
export const parseHolidaysCsv = (text: string): Holiday[] => {
  const out: Holiday[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),(.+)$/);
    if (!m) continue;
    out.push({ date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, name: m[4].trim() });
  }
  return out;
};

/** 一覧にある最後の年（内蔵・取得した祝日がいつまであるか） */
export const lastHolidayYear = (list: Holiday[]) => list.reduce((y, h) => Math.max(y, Number(h.date.slice(0, 4))), 0);

/** 内蔵と取得した祝日を合わせる（同じ日は取得した方を使う）。日付順 */
export const mergeHolidays = (builtin: Holiday[], fetched: Holiday[]): Holiday[] => {
  const map = new Map(builtin.map((h) => [h.date, h]));
  for (const h of fetched) map.set(h.date, h);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
};
