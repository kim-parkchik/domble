/**
 * 列の追加ではできない変更（CHECK 制約を広げるなど）のための、テーブルの作り直し（帳簿を開いたとき。schema.ts の COLUMN_MIGRATIONS のあと）
 * SQLite の決まった手順（https://www.sqlite.org/lang_altertable.html の「Making Other Kinds Of Table Schema Changes」）：
 *  外部キーを止め、新しい定義のテーブルを作って中身を写し、古いテーブルを消して名前を戻す。1つのトランザクションで行い、失敗したら元に戻す。
 *  テーブルのトリガーは消えるが、開くたびに作り直す（openDatabase はトリガーの控えを、作り直しの前に取る）
 */
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA } from "./schema";

type Db = Pick<Database, "select" | "execute">;

/** 作り直すテーブルと、作り直しが要るか（今の CREATE 文から判定） */
export const TABLE_REBUILDS: { table: string; needed: (sql: string) => boolean }[] = [
  // 固定資産の償却方法に、200%定率法（declining）と繰延資産（deferred）を足した（method の CHECK）
  { table: "fixed_assets", needed: (sql) => !sql.includes("'declining'") },
  // 取り込みの記録の種類に、給与の CSV（payroll）を足した（kind の CHECK）
  { table: "import_batches", needed: (sql) => !sql.includes("'payroll'") },
];

const createSqlOf = (table: string) => {
  const sql = SCHEMA.find((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (!sql) throw new Error(`テーブル ${table} の定義がありません`);
  return sql;
};

const columnsOf = async (db: Db, table: string) => (await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`)).map((c) => c.name);

export const rebuildTables = async (db: Db) => {
  for (const r of TABLE_REBUILDS) {
    const row = await db.select<{ sql: string }[]>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [r.table]);
    if (!row[0] || !r.needed(row[0].sql)) continue;
    const tmp = `${r.table}__rebuild`;
    const oldColumns = await columnsOf(db, r.table);
    const seq = (await db.select<{ seq: number }[]>("SELECT seq FROM sqlite_sequence WHERE name = ?", [r.table]))[0]?.seq ?? null;
    await db.execute("PRAGMA foreign_keys = OFF");
    // 名前を戻すときに、ほかのテーブルのトリガー（このテーブルを参照するもの）を読み直さない（途中で一時的にテーブルが無いため）
    await db.execute("PRAGMA legacy_alter_table = ON");
    await db.execute("BEGIN");
    try {
      await db.execute(createSqlOf(r.table).replace(`CREATE TABLE IF NOT EXISTS ${r.table} (`, `CREATE TABLE ${tmp} (`));
      for (const [t, column, def] of COLUMN_MIGRATIONS) {
        if (t === r.table && !(await columnsOf(db, tmp)).includes(column)) await db.execute(`ALTER TABLE ${tmp} ADD COLUMN ${column} ${def}`);
      }
      const newColumns = await columnsOf(db, tmp);
      const cols = oldColumns.filter((c) => newColumns.includes(c)).join(", ");
      await db.execute(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${r.table}`);
      await db.execute(`DROP TABLE ${r.table}`);
      await db.execute(`ALTER TABLE ${tmp} RENAME TO ${r.table}`);
      // 番号を使い回さない（AUTOINCREMENT）ように、前の続きの番号を引き継ぐ
      if (seq !== null) await db.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?", [seq, r.table]);
      const broken = await db.select<unknown[]>("PRAGMA foreign_key_check");
      if (broken.length) throw new Error(`テーブル ${r.table} を作り直したあと、参照の合わない行があります`);
      await db.execute("COMMIT");
    } catch (e) {
      await db.execute("ROLLBACK");
      throw e;
    } finally {
      await db.execute("PRAGMA legacy_alter_table = OFF");
      await db.execute("PRAGMA foreign_keys = ON");
    }
  }
};
