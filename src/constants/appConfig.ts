/** アプリ全体の設定値 */

export const APP_NAME = "domble";

/** 書類フォルダ内に作るフォルダ名 */
export const APP_DIR_NAME = "domble";
export const BACKUP_DIR_NAME = "Backup";

/** 帳簿データ（1ファイル = 1事業者） */
export const EXT_MAIN = "dmbl";
/** 帳簿ファイルか */
export const isBookFile = (path: string) => path.toLowerCase().endsWith(`.${EXT_MAIN}`);
/** 自動バックアップ */
export const EXT_BACKUP = "dmbk";
/** バックアップのファイルか（読み取り専用で開く） */
export const isBackupFile = (path: string) => path.toLowerCase().endsWith(`.${EXT_BACKUP}`);
export const FILE_FILTER_NAME = "domble 帳簿ファイル";

/** DBスキーマのバージョン（マイグレーション用） */
export const SCHEMA_VERSION = 2;

/** バックアップを残す世代数（帳簿ごとに事業者設定で変えられる） */
export const DEFAULT_BACKUP_GENERATIONS = 100;
export const MAX_BACKUP_GENERATIONS = 999;

/**
 * 入力期間（日）。取引日からこの日数を過ぎて登録した仕訳を「遅れて登録」として確認・抽出できる（lib/inputPeriod.ts）
 * 既定は業務処理サイクル方式の「最長2か月 + おおむね7営業日」の目安。帳簿ごとに事業者設定で変えられる
 */
export const DEFAULT_INPUT_PERIOD_DAYS = 70;
export const MAX_INPUT_PERIOD_DAYS = 365;

/** --- 上限 --- */
/** 証憑ファイル1件の上限（帳簿ファイルとバックアップが大きくなりすぎないように） */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
/** 補助科目は1科目あたりこの数まで（入力候補が多すぎると選びにくくなるため） */
export const MAX_SUB_ACCOUNTS_PER_ACCOUNT = 100;
/** 勘定科目は区分ごとにコードの範囲（100〜199 など）で区切るので、1区分あたり最大100科目 */
export const MAX_ACCOUNTS_PER_CATEGORY = 100;
