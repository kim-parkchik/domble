import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, RETIRED_TRIGGERS, SCHEMA } from "./schema";
import { rebuildTables, TABLE_REBUILDS } from "./migrate";
import { SCHEMA_VERSION } from "../constants/appConfig";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = (raw: Sqlite) => ({
  select: async (sql: string, params: unknown[] = []) => raw.query(sql).all(...(params as never[])),
  execute: async (sql: string, params: unknown[] = []) => {
    const r = raw.query(sql).run(...(params as never[]));
    return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
  },
}) as unknown as Database;

describe("テーブルの作り直し（列の追加ではできない変更）", () => {
  test("固定資産：古い CHECK（定額法・一括・少額だけ）の帳簿を作り直し、中身・参照・番号の続きを残す", async () => {
    const raw = new Sqlite(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
    // 古い形式：method の CHECK が狭い fixed_assets
    const old = SCHEMA.find((s) => s.includes("CREATE TABLE IF NOT EXISTS fixed_assets ("))!
      .replace("CHECK (method IN ('straight','declining','lump3','small','deferred'))", "CHECK (method IN ('straight','lump3','small'))");
    for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s.includes("CREATE TABLE IF NOT EXISTS fixed_assets (") ? old : s);
    for (const [t, c, d] of COLUMN_MIGRATIONS) {
      const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
      if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
    }
    for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
    raw.run("INSERT INTO accounts (id, code, name, kana, category, normal_side) VALUES (1, '134', '工具器具備品', '', 'asset', 'debit')");
    raw.run(`INSERT INTO fixed_assets (id, name, account_id, acquired_on, used_on, cost, method, useful_life, income_kind)
             VALUES (7, 'パソコン', 1, '2026-04-10', '2026-04-10', 240000, 'straight', 4, 'business')`);
    raw.run("INSERT INTO asset_rates (asset_id, from_year, rate) VALUES (7, 2027, 80)");
    // 番号の続きの確かめ用に、9 を使ってから消す
    raw.run(`INSERT INTO fixed_assets (id, name, account_id, acquired_on, used_on, cost, method, useful_life) VALUES (9, '消す', 1, '2026-04-10', '2026-04-10', 1000, 'small', 0)`);
    raw.run("DELETE FROM fixed_assets WHERE id = 9");
    expect(() => raw.run(`INSERT INTO fixed_assets (name, account_id, acquired_on, used_on, cost, method) VALUES ('x', 1, '2026-01-01', '2026-01-01', 1, 'declining')`)).toThrow(/CHECK/);

    await rebuildTables(wrap(raw));

    expect(raw.query("SELECT id, name, method, income_kind FROM fixed_assets").all()).toEqual([{ id: 7, name: "パソコン", method: "straight", income_kind: "business" }]);
    expect(raw.query("SELECT asset_id, rate FROM asset_rates").all()).toEqual([{ asset_id: 7, rate: 80 }]);
    // 定率法・繰延資産を入れられる。番号は消した 9 の続きから
    raw.run(`INSERT INTO fixed_assets (name, account_id, acquired_on, used_on, cost, method, useful_life) VALUES ('車', 1, '2026-01-01', '2026-01-01', 100, 'declining', 6)`);
    expect(raw.query("SELECT MAX(id) AS id FROM fixed_assets").get()).toEqual({ id: 10 });
    expect(raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    // もう一度開いても作り直さない
    const before = raw.query("SELECT sql FROM sqlite_master WHERE name = 'fixed_assets'").get();
    await rebuildTables(wrap(raw));
    expect(raw.query("SELECT sql FROM sqlite_master WHERE name = 'fixed_assets'").get()).toEqual(before);
  });
});

describe("テーブルの作り直し：取り込みの記録", () => {
  test("種類に給与（payroll）が無い帳簿を作り直し、記録と番号の続きを残す", async () => {
    const raw = new Sqlite(":memory:");
    const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
    const old = SCHEMA.find((s) => s.includes("CREATE TABLE IF NOT EXISTS import_batches ("))!.replace("'journal','bank','payroll'", "'journal','bank'");
    for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s.includes("CREATE TABLE IF NOT EXISTS import_batches (") ? old : s);
    raw.run("INSERT INTO import_batches (id, kind, source) VALUES (3, 'bank', 'a.csv')");
    expect(() => raw.run("INSERT INTO import_batches (kind, source) VALUES ('payroll', 'b.csv')")).toThrow(/CHECK/);
    await rebuildTables(wrap(raw));
    raw.run("INSERT INTO import_batches (kind, source) VALUES ('payroll', 'b.csv')");
    expect(raw.query("SELECT id, kind, source FROM import_batches ORDER BY id").all()).toEqual([{ id: 3, kind: "bank", source: "a.csv" }, { id: 4, kind: "payroll", source: "b.csv" }]);
  });
});

/**
 * 帳簿の形式（テーブル・列・トリガー・作り直し）の指紋と、そのときの形式の版。
 * 形式を変えてこのテストが落ちたら、constants/appConfig.ts の SCHEMA_VERSION を1つ上げ、ここの version と hash を新しい値にする
 * （古い版の domble で新しい帳簿を開いたときに、読み取り専用で開くようにするため）
 */
const SCHEMA_FINGERPRINT = { version: 7, hash: "d2589b1f2f478e82" };

test("帳簿の形式を変えたら、形式の版（SCHEMA_VERSION）を上げる", () => {
  const hash = createHash("sha256").update(JSON.stringify([SCHEMA, COLUMN_MIGRATIONS, RETIRED_TRIGGERS, TABLE_REBUILDS.map((t) => t.table)])).digest("hex").slice(0, 16);
  expect({ version: SCHEMA_VERSION, hash }).toEqual(SCHEMA_FINGERPRINT);
});
