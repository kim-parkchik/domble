/**
 * 税理士の確認：仕訳の付箋（質問・回答・解決済み）と、月ごとの確認済みの印。帳簿の操作は db/review.ts
 */
import { ADJUSTMENT_PERIOD } from "./accounting";

export interface NoteRow {
  id: number;
  entry_id: number;
  kind: "note" | "resolve";
  body: string;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
}

/** 仕訳ごとの付箋の状態：書いた数と、未解決か（最後が「解決済みにした」でなければ未解決） */
export interface NoteStatus {
  count: number;
  open: boolean;
  /** 最後に書いたこと */
  last: NoteRow | null;
}

/** 付箋（古い順）から、仕訳ごとの状態 */
export const noteStatuses = (rows: NoteRow[]): Map<number, NoteStatus> => {
  const m = new Map<number, NoteStatus>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const s = m.get(r.entry_id) ?? { count: 0, open: false, last: null };
    if (r.kind === "note") m.set(r.entry_id, { count: s.count + 1, open: true, last: r });
    else m.set(r.entry_id, { ...s, open: false });
  }
  return m;
};

/** 付箋の文の長さの上限 */
export const NOTE_MAX = 1000;

export const noteProblem = (body: string) =>
  !body.trim() ? "書くことを入れてください" : body.length > NOTE_MAX ? `${NOTE_MAX}文字までにしてください` : "";

export interface MonthCheck {
  year: number;
  /** 1〜12 = 月、13 = 決算整理 */
  month: number;
  user_id: number | null;
  user_name: string | null;
  checked_at: string;
  /** 確かめたあとに入れた・直した・消した仕訳の数 */
  changed: number;
}

/** 月のボタンに付ける印（checked = 確認済み、changed = 確認したあとに変わった） */
export const monthMarks = (checks: MonthCheck[]): Partial<Record<number, "checked" | "changed">> =>
  Object.fromEntries(checks.map((c) => [c.month, c.changed > 0 ? "changed" : "checked"]));

/** 仕訳の期間（1〜12 = 月、13 = 決算整理） */
export const periodOfEntry = (date: string, adjustment: boolean) => (adjustment ? ADJUSTMENT_PERIOD : Number(date.slice(5, 7)));
