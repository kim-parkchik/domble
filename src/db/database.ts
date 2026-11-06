import Database from "./connection";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir } from "@tauri-apps/plugin-fs";
import { basename, documentDir, join } from "@tauri-apps/api/path";
import { COLUMN_MIGRATIONS, SCHEMA, SEED_ACCOUNT_SQL } from "./schema";
import { rebuildTables } from "./migrate";
import type { EncryptionStatus, Unlock } from "./encryption";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import { backupName, backupsToRemove, parseBackupName, parseLock, type LockInfo } from "../lib/backup";
import { askBeforeUpgrade } from "../lib/handoff";
import pkg from "../../package.json";
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

/** 税理士との受け渡し：書き出す写しの保存先を選ぶ（defaultPath：今の帳簿と同じフォルダの、決まった名前） */
export const pickHandoffDest = async (defaultPath: string): Promise<string | null> => {
  const path = await save({ filters: [{ name: FILE_FILTER_NAME, extensions: [EXT_MAIN] }], defaultPath });
  if (!path) return null;
  return isBookFile(path) ? path : `${path}.${EXT_MAIN}`;
};
/** 税理士との受け渡し：返ってきた帳簿を選ぶ（dir：最初に開くフォルダ） */
export const pickReturnedFile = async (dir: string): Promise<string | null> => {
  const path = await open({ multiple: false, filters: [{ name: FILE_FILTER_NAME, extensions: [EXT_MAIN] }], defaultPath: dir, title: "税理士から返ってきた帳簿" });
  return typeof path === "string" ? path : null;
};
/** 開いている帳簿の写しを書き出す（暗号化した帳簿は同じ鍵で暗号化したまま。呼ぶ側で書き込みの待ち行列に並べる） */
export const writeBookCopy = (path: string, dest: string) => invoke<void>("db_backup", { path, dest });
/** 帳簿ファイルのあるフォルダ */
export const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

// ────────────────────────────────────────────
// バックアップ（ファイルの操作は Rust 側 src-tauri/src/files.rs。名前と世代は lib/backup.ts）
//  - 置き場所は2か所：既定（書類/domble/Backup）と、この PC ごとに選べる2か所目（外付けディスク・別のフォルダなど）
//  - 作るとき：開くとき（開く前の状態）・閉じるとき・「今すぐバックアップ」・戻す前（印つき。整理で消さない）
// ────────────────────────────────────────────
const SECOND_DIR_KEY = "domble.backupDir2";
/** 2か所目のバックアップ先（この PC だけの設定。無ければ null） */
export const getSecondBackupDir = (): string | null => {
  try {
    return localStorage.getItem(SECOND_DIR_KEY) || null;
  } catch {
    return null;
  }
};
export const setSecondBackupDir = (dir: string | null) => {
  try {
    if (dir) localStorage.setItem(SECOND_DIR_KEY, dir);
    else localStorage.removeItem(SECOND_DIR_KEY);
  } catch {
    /* 保存できなくても続ける */
  }
};
/** 2か所目のバックアップ先を選ぶ */
export const pickBackupDir = async (): Promise<string | null> => {
  const dir = await open({ directory: true, multiple: false, title: "バックアップの2か所目（外付けディスクなど）" });
  return typeof dir === "string" ? dir : null;
};

/** 既定のバックアップ先（書類/domble/Backup） */
const defaultBackupDir = async () => {
  const dir = await join(await appFolder(), BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  return dir;
};
/** バックアップ先（既定と、あれば2か所目） */
const backupDirs = async (): Promise<{ dir: string; second: boolean }[]> => {
  const second = getSecondBackupDir();
  return [{ dir: await defaultBackupDir(), second: false }, ...(second ? [{ dir: second, second: true }] : [])];
};
const bookNameOf = async (path: string) => (await basename(path)).replace(/\.[^.]+$/, "");

/**
 * 開いた帳簿の識別子（パス → settings.book_id の先頭8文字。openDatabase で控える）。
 * バックアップの名前を「帳簿名_識別子_日時」にして、同じ名前のほかの帳簿（税理士の PC のほかの事業者など）のバックアップと混ざらないようにする
 */
const bookIds = new Map<string, string>();
/** バックアップの名前の前の部分（識別子が分からない帳簿は帳簿名だけ。以前の形） */
const backupKeyOf = async (path: string) => {
  const name = await bookNameOf(path);
  const id = bookIds.get(path);
  return id ? `${name}_${id}` : name;
};

/** 開く前の帳簿ファイルを、バックアップ先へ丸ごと写す（暗号化した帳簿は暗号化したまま）。失敗したところを返す */
const backupOnOpen = async (path: string): Promise<string[]> => {
  const name = await backupKeyOf(path);
  const failed: string[] = [];
  for (const { dir, second } of await backupDirs()) {
    try {
      await invoke("file_copy", { src: path, dest: await join(dir, backupName(name, new Date(), EXT_BACKUP)) });
    } catch (e) {
      failed.push(`${second ? "2か所目" : "書類フォルダ"}：${String(e).replace(/^Error: /, "")}`);
    }
  }
  return failed;
};

/**
 * 開いている帳簿を、今の中身のままバックアップ先へ書き出す（今すぐバックアップ・閉じるとき・戻す前）。書き出したファイルを返す。
 * 保存の途中に書き出さないよう、呼ぶ側で書き込みの待ち行列に並べる（repo.queuedRead）
 */
export const backupNow = async (path: string, suffix = ""): Promise<{ written: string[]; failed: string[] }> => {
  const name = await backupKeyOf(path);
  const written: string[] = [];
  const failed: string[] = [];
  for (const { dir, second } of await backupDirs()) {
    const dest = await join(dir, backupName(name, new Date(), EXT_BACKUP, suffix));
    try {
      await invoke("db_backup", { path, dest });
      written.push(dest);
    } catch (e) {
      failed.push(`${second ? "2か所目" : "書類フォルダ"}：${String(e).replace(/^Error: /, "")}`);
    }
  }
  return { written, failed };
};

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  /** 更新日時（UNIX 時間・秒） */
  modified: number;
  encrypted: boolean;
  /** 名前の日時（YYYYMMDD-HHMMSS）と印（戻す前など） */
  stamp: string;
  suffix: string;
  /** 2か所目にあるもの */
  second: boolean;
  /** 帳簿の識別子の入っていない以前の名前のもの（同じ名前のほかの帳簿のバックアップが混ざることがある） */
  legacy: boolean;
}

/** その帳簿のバックアップ（2か所。新しい順）。識別子の入った名前のものと、以前の名前（帳簿名だけ）のもの */
export const listBackups = async (path: string): Promise<BackupEntry[]> => {
  const key = await backupKeyOf(path);
  const name = await bookNameOf(path);
  const keys: [string, boolean][] = key === name ? [[name, false]] : [[key, false], [name, true]];
  const out: BackupEntry[] = [];
  for (const { dir, second } of await backupDirs()) {
    for (const [k, legacy] of keys) {
      try {
        const files = await invoke<Omit<BackupEntry, "stamp" | "suffix" | "second" | "legacy">[]>("backup_list", { dir, prefix: `${k}_`, ext: EXT_BACKUP });
        for (const f of files) {
          const p = parseBackupName(f.name, k, EXT_BACKUP);
          if (p) out.push({ ...f, ...p, second, legacy });
        }
      } catch (e) {
        console.warn("バックアップの一覧を読めませんでした", dir, e);
      }
    }
  }
  return out.sort((a, b) => (a.stamp === b.stamp ? Number(a.second) - Number(b.second) : a.stamp < b.stamp ? 1 : -1));
};

/** バックアップを消す。消せなかったものを返す */
export const removeBackups = (paths: string[]) => invoke<string[]>("files_remove", { paths });

/** バックアップを帳簿ファイルに戻す（帳簿は閉じてから。開き直すのは呼ぶ側） */
export const restoreBackupFile = (backup: string, path: string) => invoke<void>("file_restore", { backup, book: path });

/**
 * 古いバックアップを消す（2か所とも。帳簿ファイルごと。lib/backup.ts の backupsToRemove：直近の keep 世代・日ごと・月ごとを残す）
 * 消せなかったファイルがあっても、帳簿を開く処理は止めない
 */
export const pruneBackups = async (path: string, keep: number) => {
  if (!isBookFile(path)) return;
  // 識別子の入った名前のものだけを整理する（以前の名前のものは、ほかの帳簿のものかもしれないので消さない）
  const name = await backupKeyOf(path);
  const d = new Date();
  const today = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  for (const { dir } of await backupDirs()) {
    try {
      const files = await invoke<{ name: string; path: string }[]>("backup_list", { dir, prefix: `${name}_`, ext: EXT_BACKUP });
      const drop = new Set(backupsToRemove(files.map((f) => f.name), name, EXT_BACKUP, keep, today));
      const left = await removeBackups(files.filter((f) => drop.has(f.name)).map((f) => f.path));
      if (left.length) console.warn("古いバックアップを消せませんでした", left);
    } catch (e) {
      console.warn("バックアップの整理に失敗しました", dir, e);
    }
  }
};

// ────────────────────────────────────────────
// 使用中の目印（帳簿ファイル.lock。同じ帳簿を2か所で開かないように。lib/backup.ts の LockInfo）
// ────────────────────────────────────────────
const DEVICE_KEY = "domble.deviceId";
/** この PC のアプリを見分ける番号（初めて使うときに作る） */
export const deviceId = () => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
};
export const readLock = async (path: string): Promise<LockInfo | null> => parseLock(await invoke<string | null>("lock_read", { path }));
export const writeLock = async (path: string) => {
  const host = await invoke<string>("host_name").catch(() => "");
  const info: LockInfo = { host, device: deviceId(), openedAt: new Date().toISOString(), app: pkg.version };
  await invoke("lock_write", { path, content: JSON.stringify(info) });
};
export const removeLock = (path: string) => invoke("lock_remove", { path }).catch(() => undefined);

/** ソフトより新しい形式の帳簿（新しい版の domble で使った帳簿）。読み取り専用で開き直す */
export const NEWER_SCHEMA = "DOMBLE_NEWER_SCHEMA";
/** 古い形式の、税理士と受け渡している帳簿。この版の形式にしてよいか聞く（lib/handoff.ts の askBeforeUpgrade） */
export const OLDER_SCHEMA = "DOMBLE_OLDER_SCHEMA";

/**
 * 帳簿ファイルを開く（なければ作る）。テーブル作成と科目の初期投入もここで行う
 * triggersBefore：開く前からあったトリガーの名前（消されていないかの確認に使う。repo.checkTriggers）
 * readonly：ファイルのメモリ上の写しを開く（バックアップを見るとき）。古い形式の列の追加などは写しにだけ行い、元のファイルは変えない
 * unlock：暗号化した帳簿のパスワード（回復キー）。無くて開けなければ NEEDS_KEY で失敗する（パスワードを聞いてやり直す）
 * allowUpgrade：税理士と受け渡している古い形式の帳簿も、聞かずにこの版の形式にする（聞いてよいと言われたとき）
 */
export const openDatabase = async (
  path: string, readonly = false, unlock: Unlock = {}, allowUpgrade = false,
): Promise<{ db: Database; triggersBefore: string[]; encryption: EncryptionStatus; backupError: string }> => {
  const { db, encryption } = await Database.load(path, readonly, unlock);

  // 列の追加などの前に、丸ごと複製しておく（暗号化した帳簿は暗号化されたまま複製される）。
  // 前回、保存の途中でソフトが止まっていると、本体に書きかけが残り、元に戻す内容が -journal に残っている。
  // SQLite は開いて最初に読んだときに元に戻すので、一度読んでから複製する（開く前に本体だけを複製すると、壊れた複製になる）
  let backupError = "";
  if (!readonly && isBookFile(path)) {
    try {
      await db.select("SELECT count(*) AS n FROM sqlite_master");
      // 帳簿の識別子（以前の形式の帳簿には列が無いので、無ければ以前の名前でバックアップする）
      const id = await db.select<{ b: string | null }[]>("SELECT book_id AS b FROM settings WHERE id = 1").catch(() => []);
      if (id[0]?.b) bookIds.set(path, id[0].b.slice(0, 8));
      backupError = (await backupOnOpen(path)).join("、");
    } catch (e) {
      backupError = String(e).replace(/^Error: /, "");
      console.warn("バックアップに失敗しました", e);
    }
    // 新しい版の domble で使った帳簿は、この版で書き込むと新しい項目が消えるので、読み取り専用で開き直してもらう
    const version = await db.select<{ v: number }[]>("SELECT schema_version AS v FROM settings WHERE id = 1").catch(() => []);
    if ((version[0]?.v ?? 0) > SCHEMA_VERSION) {
      await db.close();
      throw new Error(`${NEWER_SCHEMA}:${version[0].v}`);
    }
    // 税理士と受け渡している帳簿を古い形式から新しくすると、古い版の domble を使っている相手は読み取り専用でしか開けなくなるので、先に聞く
    if (!allowUpgrade) {
      const count = async (sql: string) => (await db.select<{ n: number }[]>(sql).catch(() => []))[0]?.n ?? 0;
      const shared = (await count("SELECT count(*) AS n FROM users WHERE role = 'accountant'")) + (await count("SELECT count(*) AS n FROM handoffs")) > 0;
      if (askBeforeUpgrade(version[0]?.v ?? 0, SCHEMA_VERSION, shared)) {
        await db.close();
        throw new Error(`${OLDER_SCHEMA}:${version[0].v}`);
      }
    }
  }

  await db.execute("PRAGMA foreign_keys = ON;");
  // テーブル → 列の追加（古いファイル向け） → トリガー の順に作る
  // （トリガーが新しい列を参照するので、列追加より先に作るとエラーになる）
  const isTrigger = (sql: string) => sql.trimStart().startsWith("CREATE TRIGGER");
  for (const sql of SCHEMA.filter((x) => !isTrigger(x))) await db.execute(sql);
  // トリガーは作り直す前に、今あるものを控えておく（消されていたら、黙って元に戻さずに知らせるため）。
  // テーブルの作り直し（migrate.ts）でそのテーブルのトリガーが消えるので、その前に控える
  const triggersBefore = (await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'trigger'")).map((r) => r.name);
  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  // 列の追加ではできない変更（CHECK 制約を広げるなど）
  await rebuildTables(db);
  for (const sql of SCHEMA.filter(isTrigger)) await db.execute(sql);

  // 設定の初期行。形式の版は、この版で開いたら（古ければ）この版にする（古い版のソフトで開いたときに止めるため）
  const s = await db.select<{ id: number }[]>("SELECT id FROM settings WHERE id = 1");
  if (s.length === 0) {
    await db.execute("INSERT INTO settings (id, fiscal_year, schema_version) VALUES (1, ?, ?)", [
      new Date().getFullYear(),
      SCHEMA_VERSION,
    ]);
  } else if (!readonly) {
    await db.execute("UPDATE settings SET schema_version = ? WHERE id = 1 AND schema_version < ?", [SCHEMA_VERSION, SCHEMA_VERSION]);
  }
  // 帳簿の識別子（帳簿ごとに1つ。写しやバックアップも同じ識別子。バックアップの名前・税理士との受け渡しで使う）
  if (!readonly) {
    await db.execute("UPDATE settings SET book_id = lower(hex(randomblob(16))) WHERE id = 1 AND (book_id IS NULL OR book_id = '')");
    const id = await db.select<{ b: string | null }[]>("SELECT book_id AS b FROM settings WHERE id = 1");
    if (id[0]?.b && isBookFile(path)) bookIds.set(path, id[0].b.slice(0, 8));
  }

  // 初期科目：コードも名前も無いものだけ追加
  for (const [i, seed] of ACCOUNT_SEEDS.entries()) {
    await db.execute(SEED_ACCOUNT_SQL, [seed.code, seed.name, seed.kana, seed.category, seed.normal_side, (i + 1) * 10, seed.income_kind ?? "business", seed.hidden ? 0 : 1]);
  }

  return { db, triggersBefore, encryption, backupError };
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

/** label：屋号（無ければ氏名）。最近開いた帳簿に出して、同じファイル名の帳簿（税理士の PC のほかの事業者など）を見分ける */
export const pushRecentFile = (path: string, label = "") => {
  try {
    const list = [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    if (label) {
      const labels = getRecentLabels();
      labels[path] = label;
      // 一覧から外れたものの名前は残さない
      localStorage.setItem(RECENT_LABEL_KEY, JSON.stringify(Object.fromEntries(Object.entries(labels).filter(([p]) => list.includes(p)))));
    }
  } catch {
    /* 保存できなくても動作には影響しない */
  }
};
const RECENT_LABEL_KEY = "domble.recentLabels";

// ── この PC で開いたことのある帳簿（識別子）。初めて開く帳簿は、ユーザーを自動で選ばない（税理士が事業者の名前で入らないように） ──
const KNOWN_BOOKS_KEY = "domble.knownBooks";
const knownBooks = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_BOOKS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};
export const isKnownBook = (bookId: string | null | undefined) => !bookId || knownBooks().includes(bookId);
export const rememberBook = (bookId: string | null | undefined) => {
  if (!bookId || isKnownBook(bookId)) return;
  try {
    localStorage.setItem(KNOWN_BOOKS_KEY, JSON.stringify([...knownBooks(), bookId].slice(-200)));
  } catch {
    /* 控えられなくても動作には影響しない */
  }
};
/** 最近開いた帳簿の事業者の名前（パス → 屋号・氏名） */
export const getRecentLabels = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_LABEL_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

export const removeRecentFile = (path: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(getRecentFiles().filter((p) => p !== path)));
  } catch {
    /* noop */
  }
};
