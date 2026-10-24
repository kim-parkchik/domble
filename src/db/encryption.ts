/**
 * 帳簿ファイルの暗号化（任意）。中身は Rust 側（src-tauri/src/db.rs・crypt.rs）
 *
 * 暗号化した帳簿は、パスワード（または回復キー）か、この PC に記憶した鍵がないと開けない。
 * 回復キーは鍵そのもので、パスワードを変えると新しくなる。履歴への記録は repo.changeEncryption で行う
 */
import { invoke } from "@tauri-apps/api/core";

export interface EncryptionStatus {
  encrypted: boolean;
  /** この PC に記憶しているか */
  remembered: boolean;
}

/** 暗号化した（パスワードを変えた）ときに返るもの */
export interface Encrypted {
  recovery_key: string;
  /** この PC に記憶できたか */
  remembered: boolean;
}

/** 開くときに渡すもの。secret はパスワードか回復キー */
export interface Unlock {
  secret?: string;
  remember?: boolean;
}

/** 暗号化した帳簿を鍵なしで開こうとした（パスワードを聞く） */
export const NEEDS_KEY = "DOMBLE_NEEDS_KEY";
/** パスワード（回復キー）が違う */
export const WRONG_KEY = "DOMBLE_WRONG_KEY";

/** ファイルを開くパスワードの長さの下限（ファイルを持ち出されたときの総当たりに耐えるよう、ユーザーのパスワードより長め） */
export const FILE_PASSWORD_MIN = 8;

export const validateFilePassword = (p: string): string | null =>
  p.length < FILE_PASSWORD_MIN ? `パスワードは ${FILE_PASSWORD_MIN} 文字以上にしてください` : null;

export const encryptionStatus = (path: string) => invoke<EncryptionStatus>("db_encryption_status", { path });
export const encrypt = (path: string, password: string, remember: boolean) => invoke<Encrypted>("db_encrypt", { path, password, remember });
export const changeFilePassword = (path: string, current: string, password: string) => invoke<Encrypted>("db_change_password", { path, current, password });
export const decrypt = (path: string, current: string) => invoke<void>("db_decrypt", { path, current });
export const setRemember = (path: string, remember: boolean) => invoke<EncryptionStatus>("db_set_remember", { path, remember });
