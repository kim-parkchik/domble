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

/**
 * 帳簿ファイルの形式の版。帳簿の形式（db/schema.ts のテーブル・列・トリガー、db/migrate.ts の作り直し）を変えたら上げる
 * （上げ忘れは src/db/migrate.test.ts で気づく）。帳簿のほうが新しければ、読み取り専用で開く（古い版で書き込むと新しい項目が消えるため）
 *  3 = 2026-10-30（形式の版を比べるようにした時点）
 *  4 = 2026-10-31（消費税の申告書で書き込む額、税抜経理の明細の消費税額）
 *  5 = 2026-10-31（明細のルールの分け方）
 */
export const SCHEMA_VERSION = 5;

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
