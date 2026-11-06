/**
 * 税理士との受け渡し（db/handoff.ts・lib/handoff.ts）。事業者の帳簿と、写し（税理士の手元・返ってきた帳簿）を bun:sqlite のメモリ上の DB で動かす
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA, SEED_ACCOUNT_SQL } from "./schema";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import * as repo from "./repo";
import * as handoff from "./handoff";
import { askBeforeUpgrade, diffRows, entryChanges, handoffFileName, holdMessage, receiveProblem, type BookState } from "../lib/handoff";
import type { JournalLine } from "../lib/types";

const wrap = (raw: Sqlite) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (params?: unknown[]) => (params ?? []) as any[];
  return {
    select: async (sql: string, params?: unknown[]) => raw.query(sql).all(...p(params)),
    execute: async (sql: string, params?: unknown[]) => {
      const r = raw.query(sql).run(...p(params));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  } as unknown as Database;
};

const makeBook = () => {
  const raw = new Sqlite(":memory:");
  raw.run("PRAGMA foreign_keys = ON");
  const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
  for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s);
  for (const [t, c, d] of COLUMN_MIGRATIONS) {
    const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
    if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  }
  for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
  raw.run("INSERT INTO settings (id, fiscal_year, e_book_mode, business_name, schema_version, book_id) VALUES (1, 2026, 'strict', 'テスト', 18, 'b00k1d')");
  ACCOUNT_SEEDS.forEach((a, i) => raw.run(SEED_ACCOUNT_SQL, [a.code, a.name, a.kana, a.category, a.normal_side, i, a.income_kind ?? "business", a.hidden ? 0 : 1]));
  return { raw, db: wrap(raw) };
};
/** 写し（書き出したファイル）を開く */
const openCopy = (bytes: Uint8Array) => {
  const raw = Sqlite.deserialize(bytes);
  raw.run("PRAGMA foreign_keys = ON");
  return { raw, db: wrap(raw) };
};

let master: ReturnType<typeof makeBook>;
let owner = 0;
let acc = 0;
let lines: JournalLine[];
const entry = (db: Database, memo: string) => repo.createEntry(db, "2026-05-10", lines.map((l) => ({ ...l, memo })));
const holder = async (db: Database) => (await db.select<{ holder: string }[]>("SELECT holder FROM settings"))[0].holder;

beforeEach(async () => {
  repo.setActor(null);
  repo.setHandoffHold(null);
  master = makeBook();
  await repo.ensureUsers(master.db, "事業 太郎");
  owner = (await repo.getUsers(master.db))[0].id;
  repo.setActor(owner, "admin");
  await repo.setUserPassword(master.db, owner, "", "pass1234");
  acc = await repo.createUser(master.db, "税理 一郎", "zeiri5678", "accountant");
  const accts = await repo.getAccounts(master.db, 2026);
  const id = (n: string) => accts.find((a) => a.name === n)!.id;
  lines = [
    { row_no: 1, side: "debit", account_id: id("消耗品費"), sub_account_id: null, amount: 3300, memo: "" },
    { row_no: 1, side: "credit", account_id: id("現金"), sub_account_id: null, amount: 3300, memo: "" },
  ];
  await entry(master.db, "文房具");
  // 渡す前に入れた仕訳（同じ秒のうちに渡したことにならないよう、前の日時にする）
  master.raw.run("UPDATE journal_entries SET created_at = '2026-01-01 09:00:00', updated_at = '2026-01-01 09:00:00'");
});
afterEach(() => {
  repo.setActor(null);
  repo.setHandoffHold(null);
});

/** 事業者が渡し、税理士が受け取った写しを開いて入る */
const sendAndOpen = async () => {
  let copy: Uint8Array | null = null;
  await handoff.sendToAccountant(master.db, "テスト_税理士へ_20261106.dmbl", "10月分まで", async () => {
    copy = master.raw.serialize();
  });
  const book = openCopy(copy!);
  handoff.applyHold((await repo.getSettings(book.db)).holder);
  repo.setActor(acc, "accountant");
  return book;
};
/** 税理士が返し、返ってきた写しを事業者が開く */
const returnAndOpen = async (book: ReturnType<typeof openCopy>) => {
  let back: Uint8Array | null = null;
  await handoff.returnToOwner(book.db, "テスト_事業者へ_20261110.dmbl", "", async () => {
    back = book.raw.serialize();
  });
  const returned = openCopy(back!);
  repo.setActor(owner, "admin");
  handoff.applyHold((await repo.getSettings(master.db)).holder);
  return returned;
};

describe("渡す・返す・受け取る", () => {
  test("渡すと、写しは税理士が受け取った帳簿、自分の帳簿は「渡している」になり、入力を止める", async () => {
    const book = await sendAndOpen();
    expect([await holder(master.db), await holder(book.db)]).toEqual(["sent", "accountant"]);
    // 税理士の手元では入力できる
    await entry(book.db, "税理士の訂正");
    // 事業者の帳簿は止める（「それでも入力する」まで）。止めたものは数えない
    repo.setActor(owner, "admin");
    handoff.applyHold("sent");
    await expect(entry(master.db, "事業者の入力")).rejects.toThrow(holdMessage("sent"));
    const hs = await handoff.getHandoffs(master.db);
    expect(hs.map((h) => [h.kind, h.memo, h.user_name, h.local_changes])).toEqual([["send", "10月分まで", "事業 太郎", 0]]);
    // ログイン・年の切り替えは止めない
    await repo.logAccess(master.db, owner, "login");
    await repo.setFiscalYear(master.db, 2026);
  });

  test("返ってきた帳簿を確かめる：最後に渡したものから続いていれば受け取れ、税理士が入れた仕訳を数える", async () => {
    const book = await sendAndOpen();
    await entry(book.db, "税理士が足した仕訳");
    const returned = await returnAndOpen(book);
    expect([await holder(book.db), await holder(returned.db)]).toEqual(["returned", "owner"]);
    const r = await handoff.inspectReturned(master.db, returned.db, 18);
    expect(r.problem).toBe("");
    expect(r.localCount).toBe(0);
    expect(r.entries).toEqual([{ id: 2, kind: "added", date: "2026-05-10", description: "税理士が足した仕訳", amount: 3300, user: "税理 一郎" }]);
    // 税理士が初めて入ったときの記録（受け渡しの記録・ログインの記録）は数えない
    expect(r.tables.map((t) => t.table)).toEqual([]);
    expect(r.back?.user_name).toBe("税理 一郎");
    // 置き換えて開き直したら、受け取ったことを記録する
    await handoff.noteReceived(returned.db, "テスト_事業者へ_20261110.dmbl", "/backup/テスト_受け取る前.dmbk");
    expect((await handoff.getHandoffs(returned.db)).map((h) => h.kind)).toEqual(["send", "return", "receive"]);
  });

  test("渡したあとに事業者が入れた分は、受け取る前に知らせる", async () => {
    const book = await sendAndOpen();
    const returned = await returnAndOpen(book);
    repo.ackHandoff();
    await entry(master.db, "渡したあとに入れた");
    const r = await handoff.inspectReturned(master.db, returned.db, 18);
    expect(r.localCount).toBe(1);
    expect(r.local.map((e) => [e.kind, e.description, e.user])).toEqual([["added", "渡したあとに入れた", "事業 太郎"]]);
    // 返ってきた帳簿には無いので、削除として数える
    expect(r.entries.map((e) => [e.kind, e.description])).toEqual([["deleted", "渡したあとに入れた"]]);
  });

  test("受け取れないもの：返していない帳簿・前に渡した帳簿・別の帳簿・新しい版の帳簿", async () => {
    const book = await sendAndOpen();
    // 返していない（税理士の作業中のファイルをそのまま送った）
    expect((await handoff.inspectReturned(master.db, book.db, 18)).problem).toContain("「事業者に返す」をしていない");
    const returned = await returnAndOpen(book);
    expect((await handoff.inspectReturned(master.db, returned.db, 17)).problem).toContain("新しい版");
    // 渡すのをやめたあとは、前に渡したものは受け取れない
    await handoff.cancelHandoff(master.db);
    expect(await holder(master.db)).toBe("owner");
    expect(repo.handoffState().hold).toBeNull();
    expect((await handoff.inspectReturned(master.db, returned.db, 18)).problem).toContain("税理士に渡していません");
    // もう一度渡すと合言葉が変わる
    await sendAndOpen();
    expect((await handoff.inspectReturned(master.db, returned.db, 18)).problem).toContain("最後に渡したものではありません");
    const other = makeBook();
    other.raw.run("UPDATE settings SET book_id = 'other', holder = 'owner'");
    expect((await handoff.inspectReturned(master.db, other.db, 18)).problem).toContain("別の帳簿");
  });

  test("写しを書き出せなければ、渡す前に戻す。税理士のユーザーがいなければ渡せない", async () => {
    await expect(handoff.sendToAccountant(master.db, "x.dmbl", "", async () => { throw new Error("ディスクがいっぱいです"); })).rejects.toThrow("ディスク");
    expect(await holder(master.db)).toBe("owner");
    expect(await handoff.getHandoffs(master.db)).toEqual([]);
    expect(repo.handoffState().hold).toBeNull();
    await repo.setUserActive(master.db, acc, false);
    await expect(handoff.sendToAccountant(master.db, "x.dmbl", "", async () => undefined)).rejects.toThrow("税理士のユーザーがいません");
  });

  test("税理士・入力担当は渡せず、渡している帳簿は返せない（税理士の手元の帳簿だけ）", async () => {
    repo.setActor(acc, "accountant");
    await expect(handoff.sendToAccountant(master.db, "x.dmbl", "", async () => undefined)).rejects.toThrow(/税理士/);
    repo.setActor(owner, "admin");
    await sendAndOpen();
    repo.setActor(owner, "admin");
    await expect(handoff.returnToOwner(master.db, "y.dmbl", "", async () => undefined)).rejects.toThrow("事業者から受け取った帳簿ではありません");
  });
});

describe("決まり（lib/handoff.ts）", () => {
  test("書き出すファイルの名前は、前の印を外して付け直す", () => {
    const d = new Date(2026, 10, 6);
    expect(handoffFileName("/x/2026年_帳簿.dmbl", "accountant", d, "dmbl")).toBe("2026年_帳簿_税理士へ_20261106.dmbl");
    expect(handoffFileName("C:\\x\\2026年_帳簿_税理士へ_20261101.dmbl", "owner", d, "dmbl")).toBe("2026年_帳簿_事業者へ_20261106.dmbl");
  });
  test("受け取れるか", () => {
    const send = { id: 1, kind: "send" as const, at: "", user_id: 1, user_name: "", token: "t", file: "", memo: "", local_changes: 0 };
    const m: BookState = { book_id: "b", holder: "sent", handoff_token: "t", schema_version: 18, handoffs: [send] };
    const r: BookState = { ...m, holder: "owner", handoffs: [send, { ...send, id: 2, kind: "return" }] };
    expect(receiveProblem(m, r, 18)).toBe("");
    expect(receiveProblem(m, { ...r, handoffs: [send] }, 18)).toContain("返した帳簿ではありません");
    expect(receiveProblem({ ...m, holder: "owner" }, r, 18)).toContain("渡していません");
  });
  test("古い形式の帳簿を新しくする前に聞くのは、税理士と受け渡す帳簿だけ", () => {
    expect([askBeforeUpgrade(18, 19, true), askBeforeUpgrade(18, 19, false), askBeforeUpgrade(19, 19, true), askBeforeUpgrade(0, 19, true)]).toEqual([true, false, false, false]);
  });
  test("表の比べ方：主キーで行を合わせ、比べない列は見ない", () => {
    const d = diffRows(["id"], [{ id: 1, a: 1, h: "x" }, { id: 2, a: 2, h: "x" }], [{ id: 1, a: 1, h: "y" }, { id: 3, a: 3, h: "x" }], ["h"]);
    expect([d.added.length, d.changed.length, d.removed.length]).toEqual([1, 0, 1]);
    const n = diffRows([], [{ a: 1 }], [{ a: 2 }]);
    expect([n.added.length, n.changed.length, n.removed.length]).toEqual([1, 0, 1]);
  });
  test("仕訳の比べ方：明細だけ変わったもの・通常モードで消したもの", () => {
    const e = (id: number, x: object = {}) => ({ id, date: "2026-01-01", description: `#${id}`, revision: 1, is_deleted: 0, created_by: 1, updated_by: null, ...x });
    const l = (id: number, entry_id: number, amount: number) => ({ id, entry_id, side: "debit", amount });
    const r = entryChanges(
      { entries: [e(1), e(2), e(3)], lines: [l(1, 1, 100), l(2, 2, 200), l(3, 3, 300)] },
      { entries: [e(1), e(2), e(4, { created_by: 2 })], lines: [l(1, 1, 100), l(5, 2, 250), l(6, 4, 400)] },
      (id) => (id === 2 ? "税理 一郎" : "事業 太郎"),
    );
    expect(r.map((x) => [x.id, x.kind, x.amount, x.user])).toEqual([[2, "changed", 250, "事業 太郎"], [3, "deleted", 300, ""], [4, "added", 400, "税理 一郎"]]);
  });
});
