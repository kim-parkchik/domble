import Database from "./connection";
import { open, save } from "@tauri-apps/plugin-dialog";
import { copyFile, exists, mkdir, readDir, remove } from "@tauri-apps/plugin-fs";
import { basename, documentDir, join } from "@tauri-apps/api/path";
import { COLUMN_MIGRATIONS, SCHEMA } from "./schema";
import type { EncryptionStatus, Unlock } from "./encryption";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import { backupsToRemove } from "../lib/backup";
import { APP_DIR_NAME, BACKUP_DIR_NAME, EXT_BACKUP, EXT_MAIN, FILE_FILTER_NAME, SCHEMA_VERSION, isBackupFile, isBookFile } from "../constants/appConfig";

const appFolder = async () => {
  const dir = await join(await documentDir(), APP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  return dir;
};

/** 新しい帳簿ファイルの保存先を選ぶ */
export const pickNewFile = async (): Promise<string | null> => {
  const dir = await appFolder();
  const path = await save({
    filters: [{ name: FILE_FILTER_NAME, extensions: [EXT_MAIN] }],
    defaultPath: await join(dir, `${new Date().getFullYear()}年_帳簿.${EXT_MAIN}`),
  });
  return path ?? null;
};

/** 既存の帳簿ファイルを選ぶ */
export const pickExistingFile = async (): Promise<string | null> => {
  const dir = await appFolder();
  const path = await open({
    multiple: false,
    filters: [{ name: FILE_FILTER_NAME, extensions: [EXT_MAIN, EXT_BACKUP] }],
    defaultPath: dir,
  });
  return typeof path === "string" ? path : null;
};

/** 開く前に、ファイルを丸ごと Backup フォルダへコピーする */
const backup = async (path: string) => {
  if (!(await exists(path))) return;
  const dir = await join(await appFolder(), BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const name = (await basename(path)).replace(/\.[^.]+$/, "");
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  await copyFile(path, await join(dir, `${name}_${stamp}.${EXT_BACKUP}`));
};

/**
 * 古いバックアップを消して、新しいものから keep 世代だけ残す（帳簿ファイルごと）
 * 消せなかったファイルがあっても、帳簿を開く処理は止めない
 */
export const pruneBackups = async (path: string, keep: number) => {
  if (!isBookFile(path)) return;
  const dir = await join(await appFolder(), BACKUP_DIR_NAME);
  if (!(await exists(dir))) return;
  const name = (await basename(path)).replace(/\.[^.]+$/, "");
  const files = (await readDir(dir)).filter((e) => e.isFile).map((e) => e.name);
  for (const f of backupsToRemove(files, name, EXT_BACKUP, keep)) {
    try {
      await remove(await join(dir, f));
    } catch (e) {
      console.warn("古いバックアップを消せませんでした", f, e);
    }
  }
};

/**
 * 帳簿ファイルを開く（なければ作る）。テーブル作成と科目の初期投入もここで行う
 * triggersBefore：開く前からあったトリガーの名前（消されていないかの確認に使う。repo.checkTriggers）
 * readonly：ファイルのメモリ上の写しを開く（バックアップを見るとき）。古い形式の列の追加などは写しにだけ行い、元のファイルは変えない
 * unlock：暗号化した帳簿のパスワード（回復キー）。無くて開けなければ NEEDS_KEY で失敗する（パスワードを聞いてやり直す）
 */
export const openDatabase = async (
  path: string, readonly = false, unlock: Unlock = {},
): Promise<{ db: Database; triggersBefore: string[]; encryption: EncryptionStatus }> => {
  // 開く前に丸ごと複製しておく（暗号化した帳簿は暗号化されたまま複製される）。
  // パスワードを聞いて開き直すとき（unlock.secret あり）は、最初に試したときに複製済みなので重ねて作らない
  if (!readonly && isBookFile(path) && unlock.secret === undefined) {
    try {
      await backup(path);
    } catch (e) {
      console.warn("バックアップに失敗しました", e);
    }
  }

  const { db, encryption } = await Database.load(path, readonly, unlock);

  await db.execute("PRAGMA foreign_keys = ON;");
  // テーブル → 列の追加（古いファイル向け） → トリガー の順に作る
  // （トリガーが新しい列を参照するので、列追加より先に作るとエラーになる）
  const isTrigger = (sql: string) => sql.trimStart().startsWith("CREATE TRIGGER");
  for (const sql of SCHEMA.filter((x) => !isTrigger(x))) await db.execute(sql);
  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  // トリガーは作り直す前に、今あるものを控えておく（消されていたら、黙って元に戻さずに知らせるため）
  const triggersBefore = (await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'trigger'")).map((r) => r.name);
  for (const sql of SCHEMA.filter(isTrigger)) await db.execute(sql);

  // 設定の初期行
  const s = await db.select<{ id: number }[]>("SELECT id FROM settings WHERE id = 1");
  if (s.length === 0) {
    await db.execute("INSERT INTO settings (id, fiscal_year, schema_version) VALUES (1, ?, ?)", [
      new Date().getFullYear(),
      SCHEMA_VERSION,
    ]);
  }

  // 初期科目：コードが無いものだけ追加（将来科目を足しても既存ファイルに自動で入る）
  for (const [i, seed] of ACCOUNT_SEEDS.entries()) {
    await db.execute(
      `INSERT OR IGNORE INTO accounts (code, name, kana, category, normal_side, sort_order, is_system)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [seed.code, seed.name, seed.kana, seed.category, seed.normal_side, (i + 1) * 10],
    );
  }

  return { db, triggersBefore, encryption };
};

// ── 最近使ったファイル（Webview の localStorage に保存） ──
const RECENT_KEY = "domble.recent";

export const getRecentFiles = (): string[] => {
  try {
    // domble のファイル（帳簿・バックアップ）だけ
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).filter((p) => isBookFile(p) || isBackupFile(p));
  } catch {
    return [];
  }
};

export const pushRecentFile = (path: string) => {
  try {
    const list = [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
};

export const removeRecentFile = (path: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(getRecentFiles().filter((p) => p !== path)));
  } catch {
    /* noop */
  }
};
