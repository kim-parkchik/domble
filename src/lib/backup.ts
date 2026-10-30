/**
 * バックアップの名前・世代管理・使用中の目印（純粋関数）
 * バックアップ名は「帳簿名_YYYYMMDD-HHMMSS.拡張子」。日時の部分は文字列の順に並べると古い順になる。
 * 戻す前に作るものは「帳簿名_YYYYMMDD-HHMMSS_戻す前.拡張子」（世代の整理で消さない）
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 日ごとに1つ残す日数・月ごとに1つ残す月数（帳簿の保存期間の7年） */
export const BACKUP_DAYS = 30;
export const BACKUP_MONTHS = 84;
/** 戻す前に作るバックアップの名前の印 */
export const BEFORE_RESTORE = "戻す前";

const two = (n: number) => String(n).padStart(2, "0");
/** バックアップ名の日時の部分（YYYYMMDD-HHMMSS） */
export const backupStamp = (d: Date) =>
  `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
/** バックアップのファイル名 */
export const backupName = (bookName: string, d: Date, ext: string, suffix = "") => `${bookName}_${backupStamp(d)}${suffix ? `_${suffix}` : ""}.${ext}`;

/** 名前の日時（YYYYMMDD-HHMMSS）を画面に出す形（2026/10/30 12:00:00）に */
export const stampLabel = (stamp: string) =>
  `${stamp.slice(0, 4)}/${Number(stamp.slice(4, 6))}/${Number(stamp.slice(6, 8))} ${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;

/** その帳簿のバックアップの名前か。日時（YYYYMMDD-HHMMSS）と印（戻す前など）を返す（違えば null） */
export const parseBackupName = (fileName: string, bookName: string, ext: string): { stamp: string; suffix: string } | null => {
  // 「帳簿_2」の帳簿に「帳簿」のバックアップが混ざらないよう、日時の形まで見て判定する
  const m = new RegExp(`^${escapeRe(bookName)}_(\\d{8}-\\d{6})(?:_([^.]+))?\\.${escapeRe(ext)}$`).exec(fileName);
  return m ? { stamp: m[1], suffix: m[2] ?? "" } : null;
};

const dayIndex = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 86_400_000;
const monthIndex = (ymd: string) => Number(ymd.slice(0, 4)) * 12 + Number(ymd.slice(4, 6)) - 1;

/**
 * 消すべきバックアップのファイル名（古いもの）。次のどれかに当たるものは残す：
 *  - 新しいものから keep 世代
 *  - 日ごとにその日のいちばん新しいもの（today から BACKUP_DAYS 日以内）
 *  - 月ごとにその月のいちばん新しいもの（today から BACKUP_MONTHS か月以内）
 *  印のついたもの（戻す前など）と、ほかの帳簿のバックアップには触れない。today（YYYYMMDD）を省くと、いちばん新しいバックアップの日
 */
export const backupsToRemove = (fileNames: string[], bookName: string, ext: string, keep: number, today?: string): string[] => {
  const mine = fileNames
    .map((f) => ({ f, p: parseBackupName(f, bookName, ext) }))
    .filter((x) => x.p && !x.p.suffix)
    .sort((a, b) => (a.p!.stamp < b.p!.stamp ? -1 : 1));
  if (mine.length === 0) return [];
  const n = Math.max(1, Math.floor(keep));
  const kept = new Set(mine.slice(-n).map((x) => x.f));
  const ref = today ?? mine[mine.length - 1].p!.stamp.slice(0, 8);
  const byDay = new Map<string, string>();
  const byMonth = new Map<string, string>();
  for (const x of mine) {
    byDay.set(x.p!.stamp.slice(0, 8), x.f);
    byMonth.set(x.p!.stamp.slice(0, 6), x.f);
  }
  for (const [ymd, f] of byDay) if (dayIndex(ref) - dayIndex(ymd) < BACKUP_DAYS) kept.add(f);
  for (const [ym, f] of byMonth) if (monthIndex(ref) - monthIndex(`${ym}01`) < BACKUP_MONTHS) kept.add(f);
  return mine.filter((x) => !kept.has(x.f)).map((x) => x.f);
};

/** 同期フォルダ（iCloud Drive・Dropbox・OneDrive・Google ドライブなど）の中か（同時に開いたときの食い違いが起きやすいので知らせる） */
export const isSyncedPath = (path: string) =>
  /\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|[\\/](Dropbox|OneDrive|Google ?Drive|iCloudDrive|Box)[\\/]/i.test(path);

/** 使用中の目印（帳簿ファイル.lock の中身） */
export interface LockInfo {
  /** 開いた PC の名前 */
  host: string;
  /** この PC のアプリを見分ける番号（同じ PC の前回の分か、ほかの PC か） */
  device: string;
  /** 開いた日時（ISO） */
  openedAt: string;
  /** domble の版 */
  app: string;
}

/** 目印の読み取り（壊れていれば null） */
export const parseLock = (text: string | null): LockInfo | null => {
  if (!text) return null;
  try {
    const x = JSON.parse(text);
    return typeof x?.device === "string" && typeof x?.openedAt === "string" ? { host: String(x.host ?? ""), device: x.device, openedAt: x.openedAt, app: String(x.app ?? "") } : null;
  } catch {
    return null;
  }
};

/** 目印から：none = 開いていない ／ self = この PC で開いたまま（前回、正しく閉じられなかった・もう1つ起動している） ／ other = ほかの PC */
export const lockState = (lock: LockInfo | null, device: string): "none" | "self" | "other" => (!lock ? "none" : lock.device === device ? "self" : "other");
