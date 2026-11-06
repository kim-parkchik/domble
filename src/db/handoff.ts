/**
 * 税理士との受け渡し（バトン方式）の帳簿の操作。決まりは lib/handoff.ts
 *
 *  - 渡す・返す：記録を足して帳簿を持っている人を変えてから、写しを書き出し（writeCopy。db_backup）、
 *    書き出せたら手元の帳簿を「渡している」「返した」にする。書き出せなければ元に戻す
 *  - 受け取る：返ってきた帳簿を読み取り専用で開き（App.tsx）、inspectReturned で確かめて変わったものを見せ、
 *    置き換えて開き直したら noteReceived で記録する
 *  受け渡しの記録は handoffs に残す（いつもの操作なので、改ざんの確認の「検知の記録」integrity_events には入れない。
 *  仕訳などの訂正・削除の履歴は、写しにもそのまま入っているので、受け取ったあとも続いている）
 */
import type Database from "./connection";
import { getActor, queuedRead, setHandoffHold, tx } from "./repo";
import {
  diffRows, entryChanges, holdOf, IGNORED_COLUMNS, lastSend, receiveProblem, TABLE_LABEL,
  type BookState, type EntryChange, type EntryRow, type Handoff, type LineRow, type Row, type TableDiff,
} from "../lib/handoff";
import type { Holder } from "../lib/types";

export const getHandoffs = (db: Database) =>
  db.select<Handoff[]>("SELECT h.*, u.name AS user_name FROM handoffs h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id");

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

const stateOf = async (db: Database) =>
  (await db.select<{ holder: Holder | null; handoff_token: string | null; book_id: string | null; schema_version: number }[]>(
    "SELECT holder, handoff_token, book_id, schema_version FROM settings WHERE id = 1",
  ))[0];

/** 受け取るときに見る帳簿の状態 */
export const bookState = async (db: Database): Promise<BookState> => ({ ...(await stateOf(db)), handoffs: await getHandoffs(db) });

/** 帳簿を開いたとき：入れた分が正本に入らない帳簿なら、書き込みを止める（repo.tx） */
export const applyHold = (holder: Holder | null | undefined) => setHandoffHold(holdOf(holder));

/**
 * 写しを書き出して、手元の帳簿を持っている人を変える（渡す・返すで同じ流れ）。
 * 書き出せなければ、足した記録と持っている人を元に戻す
 */
const handOver = async (db: Database, o: {
  kind: "send" | "return"; from: Holder; mid: Holder; after: Holder; label: string; file: string; memo: string; perm: "owner" | "entry";
  newToken: boolean; check?: () => Promise<void>; writeCopy: () => Promise<void>;
}) => {
  const before = await stateOf(db);
  const id = await tx(db, o.label, async () => {
    const s = await stateOf(db);
    if ((s.holder ?? "owner") !== o.from) {
      throw new Error(o.kind === "send"
        ? "すでに税理士に渡しています（受け取るか、渡すのをやめてから渡してください）"
        : "事業者から受け取った帳簿ではありません（事業者が「税理士に渡す」で書き出した帳簿だけ返せます）");
    }
    await o.check?.();
    const token = o.newToken ? randomToken() : s.handoff_token ?? "";
    const r = await db.execute("INSERT INTO handoffs (kind, user_id, token, file, memo) VALUES (?, ?, ?, ?, ?)", [o.kind, getActor(), token, o.file, o.memo]);
    await db.execute("UPDATE settings SET holder = ?, handoff_token = ? WHERE id = 1", [o.mid, token]);
    return r.lastInsertId;
  }, { perm: o.perm, handoff: true });
  try {
    await queuedRead(o.writeCopy);
  } catch (e) {
    await tx(db, `${o.label}の取り消し`, async () => {
      await db.execute("DELETE FROM handoffs WHERE id = ?", [id]);
      await db.execute("UPDATE settings SET holder = ?, handoff_token = ? WHERE id = 1", [before.holder ?? "owner", before.handoff_token ?? ""]);
    }, { handoff: true });
    throw e;
  }
  await tx(db, o.label, () => db.execute("UPDATE settings SET holder = ? WHERE id = 1", [o.after]), { perm: o.perm, handoff: true });
  setHandoffHold(holdOf(o.after));
};

/**
 * 税理士に渡す（事業者）：渡すための写し（file）を書き出し、自分の帳簿は「渡している」にする（受け取るまで入力を止める）。
 * 税理士が入るための「税理士」の権限のユーザーが要る
 */
export const sendToAccountant = (db: Database, file: string, memo: string, writeCopy: () => Promise<void>) =>
  handOver(db, {
    kind: "send", from: "owner", mid: "accountant", after: "sent", label: "税理士に渡す", file, memo, perm: "owner", newToken: true,
    writeCopy,
    check: async () => {
      const n = await db.select<{ n: number }[]>("SELECT count(*) AS n FROM users WHERE is_active = 1 AND role = 'accountant'");
      if (!n[0].n) throw new Error("税理士のユーザーがいません。先に「ユーザー」の画面で、権限を「税理士」にしたユーザーを足してください");
    },
  });

/** 事業者に返す（税理士）：返すための写し（file）を書き出し、手元の帳簿は「返した」にする */
export const returnToOwner = (db: Database, file: string, memo: string, writeCopy: () => Promise<void>) =>
  handOver(db, {
    kind: "return", from: "accountant", mid: "owner", after: "returned", label: "事業者に返す", file, memo, perm: "entry", newToken: false,
    writeCopy,
  });

/**
 * 渡すのをやめる（事業者）：受け取らずに、この帳簿で続ける。合言葉を消すので、あとで前に渡した帳簿が返ってきても受け取れない。
 * 書き出しの途中で止まって「税理士が受け取った帳簿」のままになった帳簿も、これで戻せる
 */
export const cancelHandoff = (db: Database, memo = "") =>
  tx(db, "渡すのをやめる", async () => {
    const s = await stateOf(db);
    if (s.holder !== "sent" && s.holder !== "accountant") throw new Error("税理士に渡していません");
    await db.execute("INSERT INTO handoffs (kind, user_id, token, memo) VALUES ('cancel', ?, ?, ?)", [getActor(), s.handoff_token ?? "", memo]);
    await db.execute("UPDATE settings SET holder = 'owner', handoff_token = '' WHERE id = 1");
  }, { perm: "owner", handoff: true }).then(() => setHandoffHold(null));

/** 置き換えて開き直したあと（App.tsx）：受け取ったことを記録する */
export const noteReceived = (db: Database, file: string, before: string) =>
  tx(db, "税理士から受け取った記録", async () => {
    const s = await stateOf(db);
    await db.execute("INSERT INTO handoffs (kind, user_id, token, file, memo) VALUES ('receive', ?, ?, ?, ?)", [getActor(), s.handoff_token ?? "", file, before]);
  }, { handoff: true });

// ────────────────────────────────────────────
// 受け取る前の確認
// ────────────────────────────────────────────

const tableRows = async (db: Database, table: string): Promise<{ pk: string[]; rows: Row[] } | null> => {
  const cols = await db.select<{ name: string; pk: number }[]>(`PRAGMA table_info(${table})`);
  if (!cols.length) return null;
  return { pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), rows: await db.select<Row[]>(`SELECT * FROM ${table}`) };
};

/** その日時から後に入れた・直した・消した仕訳（渡したあとに事業者が入れたもの・受け取ってから税理士が直したもの） */
export const changedSince = async (db: Database, at: string): Promise<EntryChange[]> => {
  const users = new Map((await db.select<{ id: number; name: string }[]>("SELECT id, name FROM users")).map((u) => [u.id, u.name]));
  const since = await db.select<(EntryRow & { created_at: string })[]>(
    `SELECT id, date, description, revision, is_deleted, created_by, updated_by, created_at FROM journal_entries
      WHERE created_at >= ? OR updated_at >= ? OR COALESCE(deleted_at, '') >= ? ORDER BY id`, [at, at, at],
  );
  const lines = since.length
    ? await db.select<LineRow[]>(`SELECT entry_id, side, amount FROM journal_lines WHERE entry_id IN (${since.map(() => "?").join(",")})`, since.map((e) => e.id))
    : [];
  return since.map((e) => ({
    id: e.id, kind: e.is_deleted ? "deleted" : e.created_at >= at ? "added" : "changed", date: e.date, description: e.description,
    amount: lines.filter((l) => l.entry_id === e.id && l.side === "debit").reduce((n, l) => n + l.amount, 0),
    user: users.get((e.updated_by ?? e.created_by) as number) ?? "",
  }));
};

const ENTRY_SQL = "SELECT id, date, description, revision, is_deleted, created_by, updated_by FROM journal_entries";
const LINE_SQL = "SELECT * FROM journal_lines";

export interface Inspection {
  /** 受け取れないわけ（空 = 受け取れる） */
  problem: string;
  /** 最後に渡した記録と、税理士が返した記録 */
  send: Handoff | null;
  back: Handoff | null;
  /** 渡したあとに、この帳簿で入れた・直した数と、その仕訳（受け取ると消える） */
  localCount: number;
  local: EntryChange[];
  /** 返ってきた帳簿で変わったもの（仕訳と、そのほかの表） */
  entries: EntryChange[];
  tables: TableDiff[];
}

/**
 * 返ってきた帳簿（returned。読み取り専用で開いたもの）を、今の帳簿（master）の代わりに受け取れるか確かめ、変わったものを数える
 */
export const inspectReturned = async (master: Database, returned: Database, appVersion: number): Promise<Inspection> => {
  const [m, r] = await Promise.all([bookState(master), bookState(returned)]);
  const problem = receiveProblem(m, r, appVersion);
  const send = lastSend(m.handoffs, m.handoff_token);
  const back = [...r.handoffs].reverse().find((h) => h.kind === "return" && h.token === m.handoff_token) ?? null;
  const empty: Inspection = { problem, send, back, localCount: 0, local: [], entries: [], tables: [] };
  if (problem) return empty;

  // 渡したあとに、この帳簿で入れたもの（「それでも入力する」のあと）
  const localCount = send?.local_changes ?? 0;
  const local = send && localCount > 0 ? await changedSince(master, send.at) : [];

  // 仕訳
  const returnedUsers = new Map((await returned.select<{ id: number; name: string }[]>("SELECT id, name FROM users")).map((u) => [u.id, u.name]));
  const [be, bl, ae, al] = await Promise.all([master.select<EntryRow[]>(ENTRY_SQL), master.select<LineRow[]>(LINE_SQL), returned.select<EntryRow[]>(ENTRY_SQL), returned.select<LineRow[]>(LINE_SQL)]);
  const entries = entryChanges({ entries: be, lines: bl }, { entries: ae, lines: al }, (id) => (id === null ? "" : returnedUsers.get(id) ?? ""));

  // そのほかの表
  const tables: TableDiff[] = [];
  for (const [table, label] of Object.entries(TABLE_LABEL)) {
    const [b, a] = await Promise.all([tableRows(master, table), tableRows(returned, table)]);
    if (!b || !a) continue;
    const d = diffRows(a.pk, b.rows, a.rows, IGNORED_COLUMNS[table] ?? []);
    if (d.added.length || d.changed.length || d.removed.length) tables.push({ table, label, added: d.added.length, changed: d.changed.length, removed: d.removed.length });
  }
  return { problem, send, back, localCount, local, entries, tables };
};
