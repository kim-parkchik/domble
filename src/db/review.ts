/**
 * 税理士の確認の帳簿の操作：仕訳の付箋（質問・回答・解決済み）と、月ごとの確認済みの印。決まりは lib/review.ts
 *  - 付箋：入力できる人（管理者・税理士・入力担当）が書ける。帳簿そのものではないので、締めた年の仕訳にも書け、履歴には残さない
 *  - 確認済みの印：管理者・税理士が付け外しする。付けたあとに入れた・直した・消した仕訳は、数えて知らせる
 */
import type Database from "./connection";
import { getActor, tx } from "./repo";
import { noteProblem, type MonthCheck, type NoteRow } from "../lib/review";
import { ADJUSTMENT_PERIOD } from "../lib/accounting";

const NOTE_SQL = "SELECT n.*, u.name AS user_name FROM entry_notes n LEFT JOIN users u ON u.id = n.user_id";

/** その仕訳の付箋（古い順） */
export const getNotes = (db: Database, entryId: number) => db.select<NoteRow[]>(`${NOTE_SQL} WHERE n.entry_id = ? ORDER BY n.id`, [entryId]);

/** その年の仕訳の付箋（全部。仕訳ごとの状態は lib/review.ts の noteStatuses） */
export const getYearNotes = (db: Database, year: number) =>
  db.select<(NoteRow & { date: string; description: string; is_deleted: number })[]>(
    `SELECT n.*, u.name AS user_name, e.date, e.description, e.is_deleted FROM entry_notes n
       JOIN journal_entries e ON e.id = n.entry_id LEFT JOIN users u ON u.id = n.user_id
      WHERE e.date BETWEEN ? AND ? ORDER BY n.id`,
    [`${year}-01-01`, `${year}-12-31`],
  );

/** 付箋に書く（解決済みの付箋に書くと、また未解決になる） */
export const addNote = (db: Database, entryId: number, body: string) => {
  const p = noteProblem(body);
  if (p) return Promise.reject(new Error(p));
  return tx(db, `伝票 No.${entryId} の付箋`, async () => {
    const e = await db.select<{ id: number }[]>("SELECT id FROM journal_entries WHERE id = ?", [entryId]);
    if (!e.length) throw new Error("仕訳が見つかりません");
    await db.execute("INSERT INTO entry_notes (entry_id, kind, body, user_id) VALUES (?, 'note', ?, ?)", [entryId, body.trim(), getActor()]);
  }, { perm: "entry" });
};

/** 付箋を解決済みにする */
export const resolveNotes = (db: Database, entryId: number) =>
  tx(db, `伝票 No.${entryId} の付箋を解決済みに`, async () => {
    const last = await db.select<{ kind: string }[]>("SELECT kind FROM entry_notes WHERE entry_id = ? ORDER BY id DESC LIMIT 1", [entryId]);
    if (last[0]?.kind !== "note") throw new Error("未解決の付箋はありません");
    await db.execute("INSERT INTO entry_notes (entry_id, kind, user_id) VALUES (?, 'resolve', ?)", [entryId, getActor()]);
  }, { perm: "entry" });

/** その年の確認済みの月と、確かめたあとに変わった仕訳の数 */
export const getMonthChecks = (db: Database, year: number) =>
  db.select<MonthCheck[]>(
    `SELECT c.year, c.month, c.user_id, u.name AS user_name, c.checked_at,
            (SELECT count(*) FROM journal_entries e
              WHERE e.date BETWEEN ? AND ?
                AND (CASE WHEN e.is_adjustment = 1 THEN ${ADJUSTMENT_PERIOD} ELSE CAST(substr(e.date, 6, 2) AS INTEGER) END) = c.month
                AND (e.created_at > c.checked_at OR e.updated_at > c.checked_at OR COALESCE(e.deleted_at, '') > c.checked_at)) AS changed
       FROM month_checks c LEFT JOIN users u ON u.id = c.user_id WHERE c.year = ? ORDER BY c.month`,
    [`${year}-01-01`, `${year}-12-31`, year],
  );

/** 確認したあとに変わった仕訳（その月。伝票番号） */
export const changedSinceCheck = async (db: Database, year: number, month: number) => {
  const c = await db.select<{ checked_at: string }[]>("SELECT checked_at FROM month_checks WHERE year = ? AND month = ?", [year, month]);
  if (!c.length) return [];
  const at = c[0].checked_at;
  return (await db.select<{ id: number }[]>(
    `SELECT id FROM journal_entries WHERE date BETWEEN ? AND ?
        AND (CASE WHEN is_adjustment = 1 THEN ${ADJUSTMENT_PERIOD} ELSE CAST(substr(date, 6, 2) AS INTEGER) END) = ?
        AND (created_at > ? OR updated_at > ? OR COALESCE(deleted_at, '') > ?) ORDER BY id`,
    [`${year}-01-01`, `${year}-12-31`, month, at, at, at],
  )).map((r) => r.id);
};

const monthLabel = (m: number) => (m === ADJUSTMENT_PERIOD ? "決算整理" : `${m}月`);

/** 確認済みにする（もう付いていれば、今の日時で付け直す） */
export const checkMonth = (db: Database, year: number, month: number) =>
  tx(db, `${year}年${monthLabel(month)}の確認済み`, async () => {
    if (!Number.isInteger(month) || month < 1 || month > ADJUSTMENT_PERIOD) throw new Error("月が正しくありません");
    await db.execute(
      `INSERT INTO month_checks (year, month, user_id) VALUES (?, ?, ?)
         ON CONFLICT (year, month) DO UPDATE SET user_id = excluded.user_id, checked_at = DATETIME('now','localtime')`,
      [year, month, getActor()],
    );
  }, { perm: "settings" });

/** 確認済みを外す */
export const uncheckMonth = (db: Database, year: number, month: number) =>
  tx(db, `${year}年${monthLabel(month)}の確認済みを外す`, () => db.execute("DELETE FROM month_checks WHERE year = ? AND month = ?", [year, month]), { perm: "settings" });
