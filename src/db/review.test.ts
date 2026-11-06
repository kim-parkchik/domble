/**
 * 税理士の確認（db/review.ts・lib/review.ts）：仕訳の付箋と、月ごとの確認済みの印
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA, SEED_ACCOUNT_SQL } from "./schema";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import * as repo from "./repo";
import * as review from "./review";
import { monthMarks, noteStatuses } from "../lib/review";
import type { JournalLine } from "../lib/types";

const makeBook = (mode: "strict" | "standard" = "strict") => {
  const raw = new Sqlite(":memory:");
  raw.run("PRAGMA foreign_keys = ON");
  const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
  for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s);
  for (const [t, c, d] of COLUMN_MIGRATIONS) {
    const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
    if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  }
  for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
  raw.run("INSERT INTO settings (id, fiscal_year, e_book_mode, business_name) VALUES (1, 2026, ?, 'テスト')", [mode]);
  ACCOUNT_SEEDS.forEach((a, i) => raw.run(SEED_ACCOUNT_SQL, [a.code, a.name, a.kana, a.category, a.normal_side, i, a.income_kind ?? "business", a.hidden ? 0 : 1]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (params?: unknown[]) => (params ?? []) as any[];
  const db = {
    select: async (sql: string, params?: unknown[]) => raw.query(sql).all(...p(params)),
    execute: async (sql: string, params?: unknown[]) => {
      const r = raw.query(sql).run(...p(params));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  } as unknown as Database;
  return { raw, db };
};

let book: ReturnType<typeof makeBook>;
let owner = 0;
let acc = 0;
let editor = 0;
let viewer = 0;
let lines: JournalLine[];
const entry = (date = "2026-05-10") => repo.createEntry(book.db, date, lines);

const setup = async (mode: "strict" | "standard" = "strict") => {
  repo.setActor(null);
  book = makeBook(mode);
  await repo.ensureUsers(book.db, "事業 太郎");
  owner = (await repo.getUsers(book.db))[0].id;
  repo.setActor(owner, "admin");
  await repo.setUserPassword(book.db, owner, "", "pass1234");
  acc = await repo.createUser(book.db, "税理 一郎", "zeiri5678", "accountant");
  editor = await repo.createUser(book.db, "入力 花子", "", "editor");
  viewer = await repo.createUser(book.db, "見る 次郎", "", "viewer");
  const accts = await repo.getAccounts(book.db, 2026);
  const id = (n: string) => accts.find((a) => a.name === n)!.id;
  lines = [
    { row_no: 1, side: "debit", account_id: id("消耗品費"), sub_account_id: null, amount: 3300, memo: "文房具" },
    { row_no: 1, side: "credit", account_id: id("現金"), sub_account_id: null, amount: 3300, memo: "文房具" },
  ];
};
beforeEach(() => setup());
afterEach(() => repo.setActor(null));

describe("付箋", () => {
  test("質問・回答・解決済み。解決済みのあとに書くと、また未解決になる", async () => {
    const e = await entry();
    repo.setActor(acc, "accountant");
    await review.addNote(book.db, e, "この消耗品は何ですか？");
    repo.setActor(owner, "admin");
    await review.addNote(book.db, e, "  コピー用紙です  ");
    let s = noteStatuses(await review.getYearNotes(book.db, 2026)).get(e)!;
    expect([s.count, s.open, s.last?.body, s.last?.user_name]).toEqual([2, true, "コピー用紙です", "事業 太郎"]);
    repo.setActor(acc, "accountant");
    await review.resolveNotes(book.db, e);
    expect(noteStatuses(await review.getYearNotes(book.db, 2026)).get(e)!.open).toBe(false);
    await expect(review.resolveNotes(book.db, e)).rejects.toThrow("未解決の付箋はありません");
    await review.addNote(book.db, e, "やはり 10 月分も見せてください");
    expect(noteStatuses(await review.getNotes(book.db, e)).get(e)).toMatchObject({ count: 3, open: true });
    expect((await review.getNotes(book.db, e)).map((n) => [n.kind, n.user_name])).toEqual([
      ["note", "税理 一郎"], ["note", "事業 太郎"], ["resolve", "税理 一郎"], ["note", "税理 一郎"],
    ]);
  });

  test("入力担当も書ける。閲覧のみは書けない。空は書けない。締めた年の仕訳にも書ける", async () => {
    const e = await entry("2025-12-01");
    await repo.closeYear(book.db, 2025);
    repo.setActor(editor, "editor");
    await review.addNote(book.db, e, "12月分の領収書は箱にあります");
    repo.setActor(viewer, "viewer");
    await expect(review.addNote(book.db, e, "見ました")).rejects.toThrow(/閲覧のみ/);
    repo.setActor(owner, "admin");
    await expect(review.addNote(book.db, e, "   ")).rejects.toThrow("書くことを入れてください");
    expect((await review.getYearNotes(book.db, 2025)).length).toBe(1);
  });

  test("通常モードで仕訳を消すと、付箋も消える", async () => {
    await setup("standard");
    const e = await entry();
    await review.addNote(book.db, e, "確認してください");
    await repo.deleteEntry(book.db, e);
    expect(book.raw.query("SELECT count(*) AS n FROM entry_notes").get()).toEqual({ n: 0 });
  });
});

describe("月ごとの確認済み", () => {
  test("税理士・管理者が付け外しする（入力担当はできない）。付けたあとに変わった仕訳を数える", async () => {
    const e1 = await entry("2026-05-10");
    repo.setActor(acc, "accountant");
    await review.checkMonth(book.db, 2026, 5);
    // 確かめたのは少し前のことにする（同じ秒のうちに入れた仕訳を「あと」と数えないよう）
    book.raw.run("UPDATE month_checks SET checked_at = '2026-01-01 00:00:00'");
    book.raw.run("UPDATE journal_entries SET created_at = '2025-12-31 00:00:00', updated_at = '2025-12-31 00:00:00'");
    let [c] = await review.getMonthChecks(book.db, 2026);
    expect([c.month, c.user_name, c.changed]).toEqual([5, "税理 一郎", 0]);
    repo.setActor(owner, "admin");
    const e2 = await entry("2026-05-20");
    await entry("2026-06-01");
    [c] = await review.getMonthChecks(book.db, 2026);
    expect(c.changed).toBe(1);
    expect(await review.changedSinceCheck(book.db, 2026, 5)).toEqual([e2]);
    expect(monthMarks(await review.getMonthChecks(book.db, 2026))).toEqual({ 5: "changed" });
    // 付け直すと、その時からの数え直し
    await review.checkMonth(book.db, 2026, 5);
    expect((await review.getMonthChecks(book.db, 2026))[0]).toMatchObject({ user_name: "事業 太郎", changed: 0 });
    repo.setActor(editor, "editor");
    await expect(review.checkMonth(book.db, 2026, 6)).rejects.toThrow(/入力担当/);
    await expect(review.uncheckMonth(book.db, 2026, 5)).rejects.toThrow(/入力担当/);
    repo.setActor(acc, "accountant");
    await review.checkMonth(book.db, 2026, 13);
    await review.uncheckMonth(book.db, 2026, 5);
    expect((await review.getMonthChecks(book.db, 2026)).map((x) => x.month)).toEqual([13]);
    await expect(review.checkMonth(book.db, 2026, 14)).rejects.toThrow("月が正しくありません");
    void e1;
  });
});
