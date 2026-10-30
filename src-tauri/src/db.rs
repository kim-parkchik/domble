//! 帳簿ファイル（SQLite）へのアクセス
//!
//! 以前は tauri-plugin-sql を使っていたが、内部が接続プールのため BEGIN / COMMIT が同じ接続で
//! 実行される保証がなく、トランザクションが使えなかった。ここでは帳簿ファイルごとに接続を1本だけ持ち、
//! 画面側（src/db/repo.ts）から BEGIN / COMMIT / ROLLBACK を送れるようにしている。
//!
//! この層は SQL をそのまま実行するだけ。SQL はすべて src/db/repo.ts と src/db/schema.ts にある。
//!
//! 読み取り専用（バックアップ .dmbk を開くとき）は、ファイルの中身をメモリに写し、その写しに接続する。
//! 画面側が古い形式の列を足したりしても、元のファイルには一切書き込まれない。
//!
//! 暗号化（任意）：帳簿ごとにパスワードをかけられる。鍵の作り方などは crypt.rs。
//! かける・外すときは、暗号化した（外した）写しを同じフォルダに作ってから置き換える（途中で止まっても元のファイルは残る）

use crate::crypt::{self, Key, Salt};
use rusqlite::backup::Backup;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Number, Value as Json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// 暗号化した帳簿を、鍵なしで開こうとした（画面側はパスワードを聞く）
pub const NEEDS_KEY: &str = "DOMBLE_NEEDS_KEY";
/// パスワード（回復キー）が違う
pub const WRONG_KEY: &str = "DOMBLE_WRONG_KEY";

/// 開いている帳簿
pub struct Book {
    pub conn: Connection,
    /// 暗号化しているときの鍵とソルト
    pub key: Option<(Key, Salt)>,
    pub readonly: bool,
}

/// 開いている帳簿ファイル（パス → 接続）
#[derive(Default)]
pub struct Databases(pub Mutex<HashMap<String, Book>>);

/// 暗号化した（パスワードを変えた）ときに返すもの
#[derive(Serialize, Debug)]
pub struct Encrypted {
    pub recovery_key: String,
    pub remembered: bool,
}

/// 開くときに渡すもの（暗号化した帳簿のとき）。secret はパスワードか回復キー
#[derive(Default)]
pub struct Unlock {
    pub secret: Option<String>,
    /// 開けたら、この PC に記憶する
    pub remember: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct EncryptionStatus {
    pub encrypted: bool,
    /// この PC に記憶しているか
    pub remembered: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// 画面から来た値（JSON）を SQLite の値に変える
fn to_sql(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

/// SQLite の値を JSON に変える（BLOB は使っていないが、来たら数値の配列にする）
fn to_json(v: ValueRef) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Json::Array(b.iter().map(|x| Json::Number((*x).into())).collect()),
    }
}

pub fn open_connection(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(err)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(err)?;
    Ok(conn)
}

/// 暗号化した帳簿を鍵で開く。鍵が違えば WRONG_KEY
pub fn open_encrypted(path: &str, key: &Key) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(err)?;
    conn.execute_batch(&format!("PRAGMA key = \"{}\";", crypt::sqlcipher_key(key, None))).map_err(err)?;
    // 鍵が違うと、ここで「file is not a database」になる
    if conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).is_err() {
        return Err(WRONG_KEY.to_string());
    }
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(err)?;
    Ok(conn)
}

/** ファイルを読み取り専用で開き、中身をメモリ上の接続に写す（元のファイルには書き込まない） */
pub fn open_readonly_copy(path: &str) -> Result<Connection, String> {
    let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(err)?;
    let mut dst = Connection::open_in_memory().map_err(err)?;
    Backup::new(&src, &mut dst).map_err(err)?.run_to_completion(1000, Duration::ZERO, None).map_err(err)?;
    drop(src);
    dst.execute_batch("PRAGMA foreign_keys = ON;").map_err(err)?;
    Ok(dst)
}

/// 暗号化したファイルを読み取り専用で写す。いったん一時フォルダに（暗号化されたまま）コピーしてから、
/// その写しを読んでメモリに移し、コピーは消す（元のファイルは開きもしない）
pub fn open_readonly_encrypted_copy(path: &str, key: &Key) -> Result<Connection, String> {
    let tmp = std::env::temp_dir().join(format!("domble-ro-{}-{}.tmp", std::process::id(), unique()));
    std::fs::copy(path, &tmp).map_err(err)?;
    let res = (|| {
        let dst = Connection::open_in_memory().map_err(err)?;
        // 鍵が違うと、ATTACH か最初の読み出しで「file is not a database」になる
        let attached = dst.execute("ATTACH DATABASE ?1 AS src KEY ?2", [tmp.to_string_lossy().as_ref(), crypt::sqlcipher_key(key, None).as_str()]);
        if attached.is_err() || dst.query_row("SELECT count(*) FROM src.sqlite_master", [], |_| Ok(())).is_err() {
            return Err(WRONG_KEY.to_string());
        }
        dst.query_row("SELECT sqlcipher_export('main', 'src')", [], |_| Ok(())).map_err(err)?;
        dst.execute_batch("DETACH DATABASE src; PRAGMA foreign_keys = ON;").map_err(err)?;
        Ok(dst)
    })();
    let _ = std::fs::remove_file(&tmp);
    res
}

/// 一時ファイルの名前が重ならないように
fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// 開いている接続の中身を、暗号化して（key が None なら暗号化せずに）同じフォルダの一時ファイルへ書き出す
fn export_to(conn: &Connection, path: &str, key: Option<(&Key, &Salt)>) -> Result<String, String> {
    let tmp = format!("{path}.domble-tmp");
    let _ = std::fs::remove_file(&tmp);
    let keystr = key.map(|(k, s)| crypt::sqlcipher_key(k, Some(s))).unwrap_or_default();
    let res = (|| {
        conn.execute("ATTACH DATABASE ?1 AS dst KEY ?2", [tmp.as_str(), keystr.as_str()]).map_err(err)?;
        let r = conn.query_row("SELECT sqlcipher_export('dst')", [], |_| Ok(())).map_err(err);
        conn.execute_batch("DETACH DATABASE dst;").map_err(err)?;
        r
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

fn bind(stmt: &mut rusqlite::Statement, params: &[Json]) -> Result<(), String> {
    let expected = stmt.parameter_count();
    if expected != params.len() {
        return Err(format!("SQL のパラメータの数が合いません（必要 {}、渡された数 {}）", expected, params.len()));
    }
    for (i, p) in params.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, to_sql(p)).map_err(err)?;
    }
    Ok(())
}

/// 1文を実行する（INSERT / UPDATE / DELETE / BEGIN / COMMIT / PRAGMA など）
pub fn execute(conn: &Connection, sql: &str, params: &[Json]) -> Result<ExecResult, String> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    bind(&mut stmt, params)?;
    if stmt.column_count() > 0 {
        // 行を返す文（PRAGMA など）は最後まで読み捨てる
        let mut rows = stmt.raw_query();
        while rows.next().map_err(err)?.is_some() {}
    } else {
        stmt.raw_execute().map_err(err)?;
    }
    Ok(ExecResult { rows_affected: conn.changes(), last_insert_id: conn.last_insert_rowid() })
}

/// 1文を実行して、行を「列名 → 値」の形で返す
pub fn select(conn: &Connection, sql: &str, params: &[Json]) -> Result<Vec<Map<String, Json>>, String> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    bind(&mut stmt, params)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            m.insert(name.clone(), to_json(row.get_ref(i).map_err(err)?));
        }
        out.push(m);
    }
    Ok(out)
}

impl Databases {
    /**
     * readonly = true なら、ファイルの写しをメモリに作って開く（バックアップを見るとき）
     * 暗号化した帳簿は、unlock のパスワード（回復キー）か、この PC に記憶した鍵で開く。どちらも無ければ NEEDS_KEY
     */
    pub fn open(&self, path: &str, readonly: bool, unlock: Unlock) -> Result<EncryptionStatus, String> {
        let mut map = self.0.lock().map_err(err)?;
        if let Some(b) = map.get(path) {
            return Ok(status(b));
        }
        let book = match crypt::encrypted_salt(path) {
            None => Book { conn: if readonly { open_readonly_copy(path)? } else { open_connection(path)? }, key: None, readonly },
            Some(salt) => {
                let key = match &unlock.secret {
                    Some(s) => crypt::key_from_secret(s, &salt)?,
                    None => crypt::remembered_key(&salt).ok_or_else(|| NEEDS_KEY.to_string())?,
                };
                let conn = match if readonly { open_readonly_encrypted_copy(path, &key) } else { open_encrypted(path, &key) } {
                    Ok(c) => c,
                    // 記憶した鍵が古い（ほかの PC でパスワードを変えたなど）ときは、パスワードを聞く
                    Err(e) if e == WRONG_KEY && unlock.secret.is_none() => return Err(NEEDS_KEY.to_string()),
                    Err(e) => return Err(e),
                };
                if unlock.remember {
                    crypt::remember_key(&salt, &key)?;
                }
                Book { conn, key: Some((key, salt)), readonly }
            }
        };
        let st = status(&book);
        map.insert(path.to_string(), book);
        Ok(st)
    }

    pub fn close(&self, path: &str) -> Result<(), String> {
        let mut map = self.0.lock().map_err(err)?;
        if let Some(book) = map.remove(path) {
            close_conn(book.conn)?;
        }
        Ok(())
    }

    pub fn with<T>(&self, path: &str, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let map = self.0.lock().map_err(err)?;
        let book = map.get(path).ok_or_else(|| "帳簿ファイルが開かれていません".to_string())?;
        f(&book.conn)
    }

    pub fn status(&self, path: &str) -> Result<EncryptionStatus, String> {
        let map = self.0.lock().map_err(err)?;
        map.get(path).map(status).ok_or_else(|| "帳簿ファイルが開かれていません".to_string())
    }

    /// 暗号化する（パスワードをかける）。回復キーを返す
    /// （この PC に記憶できなくても、暗号化はできているので失敗にはしない。remembered で知らせる）
    pub fn encrypt(&self, path: &str, password: &str, remember: bool) -> Result<Encrypted, String> {
        if password.is_empty() {
            return Err("パスワードを入れてください".into());
        }
        let salt = crypt::random_salt()?;
        let key = crypt::derive_key(password, &salt)?;
        self.replace_file(path, |book| {
            if book.key.is_some() {
                return Err("この帳簿はすでに暗号化しています".into());
            }
            Ok(Some((key, salt)))
        })?;
        let remembered = remember && crypt::remember_key(&salt, &key).is_ok();
        Ok(Encrypted { recovery_key: crypt::recovery_key(&key), remembered })
    }

    /// 暗号化をやめる。current は今のパスワードか回復キー
    pub fn decrypt(&self, path: &str, current: &str) -> Result<(), String> {
        let mut salt = None;
        self.replace_file(path, |book| {
            let (key, s) = book.key.ok_or("この帳簿は暗号化していません")?;
            check_current(current, &key, &s)?;
            salt = Some(s);
            Ok(None)
        })?;
        if let Some(s) = salt {
            crypt::forget_key(&s)?;
        }
        Ok(())
    }

    /// パスワードを変える（鍵が変わるので、新しい回復キーを返す）。current は今のパスワードか回復キー
    pub fn change_password(&self, path: &str, current: &str, password: &str) -> Result<Encrypted, String> {
        if password.is_empty() {
            return Err("新しいパスワードを入れてください".into());
        }
        let mut map = self.0.lock().map_err(err)?;
        let book = map.get_mut(path).ok_or("帳簿ファイルが開かれていません")?;
        writable(book)?;
        let (key, salt) = book.key.ok_or("この帳簿は暗号化していません")?;
        check_current(current, &key, &salt)?;
        let new_key = crypt::derive_key(password, &salt)?;
        // ソルトはそのまま、鍵だけ変えて全体を暗号化し直す
        book.conn.execute_batch(&format!("PRAGMA rekey = \"{}\";", crypt::sqlcipher_key(&new_key, None))).map_err(err)?;
        book.key = Some((new_key, salt));
        // 記憶していたら、新しい鍵に置き換える（できなくても、次に開くときにパスワードを聞くだけ）
        let remembered = crypt::remembered_key(&salt).is_some() && crypt::remember_key(&salt, &new_key).is_ok();
        Ok(Encrypted { recovery_key: crypt::recovery_key(&new_key), remembered })
    }

    /// この PC に記憶する・記憶を消す
    pub fn set_remember(&self, path: &str, remember: bool) -> Result<EncryptionStatus, String> {
        let map = self.0.lock().map_err(err)?;
        let book = map.get(path).ok_or("帳簿ファイルが開かれていません")?;
        let (key, salt) = book.key.ok_or("この帳簿は暗号化していません")?;
        if remember {
            crypt::remember_key(&salt, &key)?;
        } else {
            crypt::forget_key(&salt)?;
        }
        Ok(status(book))
    }

    /// 帳簿ファイルを、暗号化した（外した）写しに置き換えて開き直す。decide が新しい鍵（None なら暗号化しない）を決める
    /// 開いている帳簿を、そのまま（暗号化した帳簿は同じ鍵で暗号化したまま）dest へ書き出す（今すぐバックアップ・閉じるときのバックアップ）。
    /// 保存の途中なら断る。書き出しは一時ファイルに書いてから名前を変えるので、途中で止まっても壊れた dest は残らない
    pub fn backup_to(&self, path: &str, dest: &str) -> Result<(), String> {
        let map = self.0.lock().map_err(err)?;
        let book = map.get(path).ok_or("帳簿ファイルが開かれていません")?;
        if !book.conn.is_autocommit() {
            return Err("保存の途中です。少し待ってからもう一度お試しください".into());
        }
        let tmp = export_to(&book.conn, dest, book.key.as_ref().map(|(k, s)| (k, s)))?;
        std::fs::rename(&tmp, dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("バックアップを書き出せませんでした：{e}")
        })
    }

    fn replace_file(&self, path: &str, decide: impl FnOnce(&Book) -> Result<Option<(Key, Salt)>, String>) -> Result<(), String> {
        let mut map = self.0.lock().map_err(err)?;
        let book = map.get(path).ok_or("帳簿ファイルが開かれていません")?;
        writable(book)?;
        let new_key = decide(book)?;
        let tmp = export_to(&book.conn, path, new_key.as_ref().map(|(k, s)| (k, s)))?;
        // 置き換える前に接続を閉じる（Windows では開いたままだと置き換えられない）
        let old = map.remove(path).unwrap();
        let old_key = old.key;
        let reopen = |key: Option<(Key, Salt)>| -> Result<Connection, String> {
            match key {
                Some((k, _)) => open_encrypted(path, &k),
                None => open_connection(path),
            }
        };
        if let Err(e) = close_conn(old.conn) {
            let _ = std::fs::remove_file(&tmp);
            map.insert(path.to_string(), Book { conn: reopen(old_key)?, key: old_key, readonly: false });
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            map.insert(path.to_string(), Book { conn: reopen(old_key)?, key: old_key, readonly: false });
            return Err(format!("帳簿ファイルを置き換えられませんでした：{e}"));
        }
        map.insert(path.to_string(), Book { conn: reopen(new_key)?, key: new_key, readonly: false });
        Ok(())
    }
}

fn status(b: &Book) -> EncryptionStatus {
    EncryptionStatus { encrypted: b.key.is_some(), remembered: b.key.is_some_and(|(_, s)| crypt::remembered_key(&s).is_some()) }
}

fn writable(b: &Book) -> Result<(), String> {
    if b.readonly {
        return Err("バックアップを読み取り専用で開いているため、変更できません".into());
    }
    if !b.conn.is_autocommit() {
        return Err("保存の途中です。少し待ってからもう一度お試しください".into());
    }
    Ok(())
}

fn check_current(current: &str, key: &Key, salt: &Salt) -> Result<(), String> {
    if crypt::key_from_secret(current, salt)? != *key {
        return Err("今のパスワード（または回復キー）が違います".into());
    }
    Ok(())
}

fn close_conn(conn: Connection) -> Result<(), String> {
    // 途中のトランザクションが残っていたら取り消してから閉じる
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    conn.close().map_err(|(_, e)| err(e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        execute(&c, "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n INTEGER, x REAL)", &[]).unwrap();
        c
    }

    #[test]
    fn insert_and_select() {
        let c = mem();
        let r = execute(&c, "INSERT INTO t (name, n, x) VALUES (?, ?, ?)", &[json!("現金"), json!(1000), json!(1.5)]).unwrap();
        assert_eq!(r, ExecResult { rows_affected: 1, last_insert_id: 1 });
        let rows = select(&c, "SELECT * FROM t WHERE n >= ?", &[json!(500)]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("現金"));
        assert_eq!(rows[0]["n"], json!(1000));
        assert_eq!(rows[0]["x"], json!(1.5));
        let empty = select(&c, "SELECT * FROM t WHERE name IS ?", &[Json::Null]).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn transaction_rolls_back() {
        let c = mem();
        execute(&c, "BEGIN IMMEDIATE", &[]).unwrap();
        execute(&c, "INSERT INTO t (name) VALUES (?)", &[json!("a")]).unwrap();
        execute(&c, "ROLLBACK", &[]).unwrap();
        assert!(select(&c, "SELECT * FROM t", &[]).unwrap().is_empty());
    }

    #[test]
    fn trigger_message_reaches_caller() {
        let c = mem();
        execute(&c, "CREATE TRIGGER no_del BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, '削除できません'); END;", &[]).unwrap();
        execute(&c, "INSERT INTO t (name) VALUES ('a')", &[]).unwrap();
        let e = execute(&c, "DELETE FROM t", &[]).unwrap_err();
        assert!(e.contains("削除できません"), "{}", e);
    }

    #[test]
    fn pragma_and_param_count() {
        let c = mem();
        execute(&c, "PRAGMA foreign_keys = ON;", &[]).unwrap();
        let cols = select(&c, "PRAGMA table_info(t)", &[]).unwrap();
        assert_eq!(cols.len(), 4);
        assert!(execute(&c, "INSERT INTO t (name) VALUES (?)", &[]).is_err());
    }

    #[test]
    fn open_twice_and_close_with_open_transaction() {
        let dir = std::env::temp_dir().join(format!("domble_db_test_{}.dmbl", std::process::id()));
        let path = dir.to_string_lossy().to_string();
        let dbs = Databases::default();
        dbs.open(&path, false, Unlock::default()).unwrap();
        dbs.open(&path, false, Unlock::default()).unwrap();
        dbs.with(&path, |c| execute(c, "CREATE TABLE IF NOT EXISTS t (a)", &[])).unwrap();
        dbs.with(&path, |c| execute(c, "BEGIN", &[])).unwrap();
        dbs.with(&path, |c| execute(c, "INSERT INTO t VALUES (1)", &[])).unwrap();
        dbs.close(&path).unwrap(); // 途中のトランザクションは取り消される
        dbs.open(&path, false, Unlock::default()).unwrap();
        let n = dbs.with(&path, |c| select(c, "SELECT COUNT(*) AS n FROM t", &[])).unwrap();
        assert_eq!(n[0]["n"], json!(0));
        dbs.close(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn readonly_copy_never_touches_the_file() {
        let path = std::env::temp_dir().join(format!("domble_db_ro_{}.dmbk", std::process::id())).to_string_lossy().to_string();
        {
            let c = open_connection(&path).unwrap();
            execute(&c, "CREATE TABLE t (a)", &[]).unwrap();
            execute(&c, "INSERT INTO t VALUES (1)", &[]).unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        let dbs = Databases::default();
        dbs.open(&path, true, Unlock::default()).unwrap();
        // 写しには書ける（古い形式の列を足すなど）が、元のファイルは変わらない
        dbs.with(&path, |c| execute(c, "ALTER TABLE t ADD COLUMN b", &[])).unwrap();
        dbs.with(&path, |c| execute(c, "INSERT INTO t VALUES (2, 3)", &[])).unwrap();
        let n = dbs.with(&path, |c| select(c, "SELECT COUNT(*) AS n FROM t", &[])).unwrap();
        assert_eq!(n[0]["n"], json!(2));
        dbs.close(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn readonly_open_of_missing_file_fails_without_creating_it() {
        let path = std::env::temp_dir().join(format!("domble_db_missing_{}.dmbk", std::process::id())).to_string_lossy().to_string();
        let dbs = Databases::default();
        assert!(dbs.open(&path, true, Unlock::default()).is_err());
        assert!(!std::path::Path::new(&path).exists());
    }

    fn tmp_path(name: &str) -> String {
        std::env::temp_dir().join(format!("domble_{}_{}_{}.dmbl", name, std::process::id(), unique())).to_string_lossy().to_string()
    }

    fn cleanup(path: &str) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{path}-journal"));
    }

    /// 暗号化していない帳簿を作り、トリガーつきの表に1行入れる
    fn plain_book(path: &str) -> Databases {
        let dbs = Databases::default();
        dbs.open(path, false, Unlock::default()).unwrap();
        dbs.with(path, |c| {
            c.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT);
                 CREATE TRIGGER no_del BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, '削除できません'); END;
                 INSERT INTO t (a) VALUES ('現金');",
            )
            .map_err(err)
        })
        .unwrap();
        dbs
    }

    fn count(dbs: &Databases, path: &str) -> Json {
        dbs.with(path, |c| select(c, "SELECT COUNT(*) AS n FROM t", &[])).unwrap()[0]["n"].clone()
    }

    fn unlock(secret: &str) -> Unlock {
        Unlock { secret: Some(secret.into()), remember: false }
    }

    #[test]
    fn encrypt_open_change_and_decrypt() {
        let path = tmp_path("enc");
        let dbs = plain_book(&path);
        assert!(crypt::encrypted_salt(&path).is_none());
        let first = dbs.encrypt(&path, "himitsu", false).unwrap();
        // 暗号化した後もそのまま使え、ファイルの先頭はもう SQLite の形ではない
        assert_eq!(dbs.status(&path).unwrap(), EncryptionStatus { encrypted: true, remembered: false });
        assert_eq!(count(&dbs, &path), json!(1));
        dbs.with(&path, |c| execute(c, "INSERT INTO t (a) VALUES (?)", &[json!("売上")])).unwrap();
        let salt = crypt::encrypted_salt(&path).expect("暗号化されている");
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows("現金".len()).any(|w| w == "現金".as_bytes()), "中身が読めてしまう");
        dbs.close(&path).unwrap();

        // 鍵なし → パスワードを聞く。違うパスワード → 違う。正しいパスワード・回復キーなら開ける
        assert_eq!(dbs.open(&path, false, Unlock::default()).unwrap_err(), NEEDS_KEY);
        assert_eq!(dbs.open(&path, false, unlock("chigau")).unwrap_err(), WRONG_KEY);
        dbs.open(&path, false, unlock("himitsu")).unwrap();
        assert_eq!(count(&dbs, &path), json!(2));
        // トリガーも引き継がれている
        assert!(dbs.with(&path, |c| execute(c, "DELETE FROM t", &[])).unwrap_err().contains("削除できません"));
        dbs.close(&path).unwrap();
        dbs.open(&path, false, unlock(&first.recovery_key.to_lowercase())).unwrap();

        // パスワードを変える：ソルトは同じまま、回復キーは新しくなる。古いパスワード・回復キーでは開けない
        assert!(dbs.change_password(&path, "chigau", "atarashii").is_err());
        let second = dbs.change_password(&path, "himitsu", "atarashii").unwrap();
        assert_ne!(first.recovery_key, second.recovery_key);
        assert_eq!(crypt::encrypted_salt(&path), Some(salt));
        dbs.close(&path).unwrap();
        assert_eq!(dbs.open(&path, false, unlock("himitsu")).unwrap_err(), WRONG_KEY);
        assert_eq!(dbs.open(&path, false, unlock(&first.recovery_key)).unwrap_err(), WRONG_KEY);
        dbs.open(&path, false, unlock(&second.recovery_key)).unwrap();

        // 暗号化をやめる（今のパスワードが要る）
        assert!(dbs.decrypt(&path, "himitsu").is_err());
        dbs.decrypt(&path, "atarashii").unwrap();
        assert!(crypt::encrypted_salt(&path).is_none());
        assert_eq!(dbs.status(&path).unwrap(), EncryptionStatus { encrypted: false, remembered: false });
        dbs.close(&path).unwrap();
        dbs.open(&path, false, Unlock::default()).unwrap();
        assert_eq!(count(&dbs, &path), json!(2));
        dbs.close(&path).unwrap();
        assert!(!std::path::Path::new(&format!("{path}.domble-tmp")).exists());
        cleanup(&path);
    }

    #[test]
    fn backup_to_keeps_contents_and_encryption() {
        let path = tmp_path("backup-src");
        let dest = tmp_path("backup-dest");
        let dbs = plain_book(&path);
        dbs.backup_to(&path, &dest).unwrap();
        assert!(crypt::encrypted_salt(&dest).is_none());
        let copy = Databases::default();
        copy.open(&dest, true, Unlock::default()).unwrap();
        assert_eq!(count(&copy, &dest), count(&dbs, &path));
        copy.close(&dest).unwrap();
        // 暗号化した帳簿のバックアップは、同じパスワードで開ける暗号化したファイル
        dbs.encrypt(&path, "correct horse", false).unwrap();
        dbs.backup_to(&path, &dest).unwrap();
        assert!(crypt::encrypted_salt(&dest).is_some());
        assert_eq!(copy.open(&dest, true, Unlock::default()).unwrap_err(), NEEDS_KEY);
        copy.open(&dest, true, unlock("correct horse")).unwrap();
        assert_eq!(count(&copy, &dest), count(&dbs, &path));
        copy.close(&dest).unwrap();
        dbs.close(&path).unwrap();
        cleanup(&path);
        cleanup(&dest);
    }

    #[test]
    fn encrypted_backup_opens_readonly_without_touching_the_file() {
        let path = tmp_path("encro");
        let dbs = plain_book(&path);
        let r = dbs.encrypt(&path, "himitsu", false).unwrap();
        dbs.close(&path).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(dbs.open(&path, true, unlock("x")).unwrap_err(), WRONG_KEY);
        dbs.open(&path, true, unlock(&r.recovery_key)).unwrap();
        dbs.with(&path, |c| execute(c, "ALTER TABLE t ADD COLUMN b", &[])).unwrap();
        assert_eq!(count(&dbs, &path), json!(1));
        // 読み取り専用では暗号化の変更はできない
        assert!(dbs.change_password(&path, "himitsu", "y").is_err());
        assert!(dbs.decrypt(&path, "himitsu").is_err());
        dbs.close(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        cleanup(&path);
    }

    #[test]
    fn cannot_encrypt_twice_or_during_a_transaction() {
        let path = tmp_path("enc2");
        let dbs = plain_book(&path);
        dbs.with(&path, |c| execute(c, "BEGIN", &[])).unwrap();
        assert!(dbs.encrypt(&path, "a", false).is_err());
        dbs.with(&path, |c| execute(c, "ROLLBACK", &[])).unwrap();
        assert!(dbs.encrypt(&path, "", false).is_err());
        dbs.encrypt(&path, "a", false).unwrap();
        assert!(dbs.encrypt(&path, "b", false).is_err());
        assert!(dbs.change_password(&path, "a", "").is_err());
        dbs.close(&path).unwrap();
        cleanup(&path);
    }

    /// OS の鍵の保管庫を使うので普段は動かさない（cargo test -- --ignored で動かす）
    #[test]
    #[ignore]
    fn remember_on_this_pc() {
        let path = tmp_path("remember");
        let dbs = plain_book(&path);
        let r = dbs.encrypt(&path, "himitsu", true).unwrap();
        assert!(r.remembered);
        dbs.close(&path).unwrap();
        assert_eq!(dbs.open(&path, false, Unlock::default()).unwrap(), EncryptionStatus { encrypted: true, remembered: true });
        assert_eq!(dbs.set_remember(&path, false).unwrap(), EncryptionStatus { encrypted: true, remembered: false });
        dbs.close(&path).unwrap();
        assert_eq!(dbs.open(&path, false, Unlock::default()).unwrap_err(), NEEDS_KEY);
        cleanup(&path);
    }
}
