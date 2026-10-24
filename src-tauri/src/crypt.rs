//! 帳簿ファイルの暗号化（任意）で使う鍵
//!
//! 暗号化した帳簿は SQLCipher の形式（ページごとに AES-256 で暗号化し、改ざん検知の HMAC をつける）。
//! ファイルの先頭 16 バイトだけは暗号化されない「ソルト」で、帳簿ごとにランダムに決まる。
//!
//! 鍵（32 バイト）は、パスワードとこのソルトから Argon2id で作る。SQLCipher には鍵そのもの（raw key）を渡す。
//! - 回復キー：鍵そのものを 16 進で書いたもの。パスワードを忘れても、これがあれば開ける
//!   （SQLCipher に対応したほかの道具でも PRAGMA key = "x'回復キー'" で開ける）
//! - パスワードを変えると鍵も変わるので、回復キーも新しくなる
//! - 「この PC に記憶する」：鍵を OS の鍵の保管庫（macOS のキーチェーン、Windows の資格情報マネージャー）に、
//!   ソルトを名前にして預ける。ソルトはバックアップ（ファイルの写し）とも同じ

use argon2::{Algorithm, Argon2, Params, Version};

pub type Key = [u8; 32];
pub type Salt = [u8; 16];

/// 暗号化していない SQLite のファイルの先頭
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// パスワードから鍵を作るときの重さ（64 MiB・3 回）。総当たりを遅くするため
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_PASSES: u32 = 3;

/// 鍵の保管庫での名前
const KEYRING_SERVICE: &str = "domble";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// ファイルの先頭 16 バイト（暗号化していれば、それがソルト）。16 バイトに満たなければ None
fn head(path: &str) -> Option<[u8; 16]> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut b = [0u8; 16];
    f.read_exact(&mut b).ok()?;
    Some(b)
}

/// 暗号化した帳簿なら、そのソルトを返す（無いファイル・空のファイル・暗号化していないファイルは None）
pub fn encrypted_salt(path: &str) -> Option<Salt> {
    head(path).filter(|h| h != SQLITE_MAGIC)
}

pub fn random_salt() -> Result<Salt, String> {
    let mut s = [0u8; 16];
    getrandom::getrandom(&mut s).map_err(err)?;
    Ok(s)
}

pub fn derive_key(password: &str, salt: &Salt) -> Result<Key, String> {
    let params = Params::new(KDF_MEMORY_KIB, KDF_PASSES, 1, Some(32)).map_err(err)?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(err)?;
    Ok(key)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02X}", x)).collect()
}

/// SQLCipher に渡す鍵の書き方（x'…'）。salt を渡すと、新しく作るファイルのソルトもこれにする
pub fn sqlcipher_key(key: &Key, salt: Option<&Salt>) -> String {
    format!("x'{}{}'", hex(key), salt.map(|s| hex(s)).unwrap_or_default())
}

/// 回復キー（鍵を 16 進で 8 文字ずつ区切ったもの）
pub fn recovery_key(key: &Key) -> String {
    hex(key).as_bytes().chunks(8).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

/// 回復キーを読む（区切りや空白・大文字小文字は気にしない）。形が違えば None
pub fn parse_recovery_key(s: &str) -> Option<Key> {
    let digits: Vec<u8> = s.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_digit(16).map(|d| d as u8)).collect::<Option<_>>()?;
    if digits.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, k) in key.iter_mut().enumerate() {
        *k = digits[i * 2] << 4 | digits[i * 2 + 1];
    }
    Some(key)
}

/// 入れられたもの（パスワードか回復キー）から鍵を作る。回復キーの形をしていれば回復キーとして読む
pub fn key_from_secret(secret: &str, salt: &Salt) -> Result<Key, String> {
    match parse_recovery_key(secret) {
        Some(k) => Ok(k),
        None => derive_key(secret, salt),
    }
}

// ── この PC に記憶する（OS の鍵の保管庫） ──

fn entry(salt: &Salt) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &hex(salt)).map_err(err)
}

pub fn remembered_key(salt: &Salt) -> Option<Key> {
    entry(salt).ok()?.get_password().ok().and_then(|s| parse_recovery_key(&s))
}

pub fn remember_key(salt: &Salt, key: &Key) -> Result<(), String> {
    entry(salt)?.set_password(&hex(key)).map_err(|e| format!("この PC に記憶できませんでした：{e}"))
}

/// 記憶を消す（もともと無ければ何もしない）
pub fn forget_key(salt: &Salt) -> Result<(), String> {
    match entry(salt)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("記憶を消せませんでした：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_round_trip() {
        let key: Key = std::array::from_fn(|i| (i * 7 + 3) as u8);
        let r = recovery_key(&key);
        assert_eq!(r.len(), 64 + 7);
        assert_eq!(parse_recovery_key(&r), Some(key));
        assert_eq!(parse_recovery_key(&r.to_lowercase().replace('-', " ")), Some(key));
        assert_eq!(parse_recovery_key("abc"), None);
        assert_eq!(parse_recovery_key(&format!("{r}0")), None);
    }

    #[test]
    fn derive_key_depends_on_password_and_salt() {
        let s1 = [1u8; 16];
        let s2 = [2u8; 16];
        let a = derive_key("pass", &s1).unwrap();
        assert_eq!(a, derive_key("pass", &s1).unwrap());
        assert_ne!(a, derive_key("pass", &s2).unwrap());
        assert_ne!(a, derive_key("pasS", &s1).unwrap());
        assert_eq!(key_from_secret(&recovery_key(&a), &s2).unwrap(), a);
    }
}
