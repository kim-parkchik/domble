//! 帳簿ファイルのバックアップ・戻す・使用中の目印（画面側は src/db/database.ts と src/lib/backup.ts）
//!  - 書き出しと置き換えは、一時ファイルに書いてから名前を変える（途中で止まっても、壊れたファイルが残らない）
//!  - バックアップの保存先は、利用者が選んだ別のディスクなどでもよい（画面側のファイル操作の範囲（書類・ホーム）の外も扱う）
//!  - 使用中の目印は「帳簿ファイル.lock」（どの PC で・いつ開いたか。中身は画面側が決める JSON の文字列）

use crate::crypt;
use serde::Serialize;
use std::path::Path;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn tmp_of(dest: &str) -> String {
    format!("{dest}.domble-tmp")
}

/// src を dest に写す（dest があれば置き換える）
pub fn copy_file(src: &str, dest: &str) -> Result<(), String> {
    if let Some(dir) = Path::new(dest).parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = tmp_of(dest);
    std::fs::copy(src, &tmp).map_err(|e| format!("ファイルを写せませんでした：{e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("ファイルを置き換えられませんでした：{e}")
    })
}

/// バックアップを帳簿ファイルに戻す（帳簿は閉じてから）。書きかけを元に戻すための -journal が残っていれば消す（戻したファイルに当てないため）
pub fn restore_file(backup: &str, book: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(format!("{book}-journal"));
    copy_file(backup, book)
}

#[derive(Serialize)]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// 更新日時（UNIX 時間・秒）
    pub modified: u64,
    pub encrypted: bool,
}

/// dir の中の、prefix で始まり .ext で終わるファイル（バックアップの一覧）。フォルダが無ければ空
pub fn list_backups(dir: &str, prefix: &str, ext: &str) -> Result<Vec<BackupFile>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(err(e)),
    };
    let suffix = format!(".{ext}");
    let mut out = vec![];
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(prefix) || !name.ends_with(&suffix) {
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let path = e.path().to_string_lossy().to_string();
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(BackupFile { encrypted: crypt::encrypted_salt(&path).is_some(), name, path, size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// ファイルを消す（無ければ何もしない）。消せなかったものの名前を返す
pub fn remove_files(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| match std::fs::remove_file(p) {
            Ok(_) => false,
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        })
        .cloned()
        .collect()
}

fn lock_path(book: &str) -> String {
    format!("{book}.lock")
}

/// 使用中の目印を読む（無ければ None）
pub fn read_lock(book: &str) -> Option<String> {
    std::fs::read_to_string(lock_path(book)).ok()
}

pub fn write_lock(book: &str, content: &str) -> Result<(), String> {
    std::fs::write(lock_path(book), content).map_err(|e| format!("使用中の目印を書けませんでした：{e}"))
}

pub fn remove_lock(book: &str) {
    let _ = std::fs::remove_file(lock_path(book));
}

/// この PC の名前（使用中の目印に書く。分からなければ空）
pub fn host_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("domble_files_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().to_string()
    }

    #[test]
    fn copy_list_restore_and_remove() {
        let dir = tmp_dir("copy");
        let book = format!("{dir}/帳簿.dmbl");
        std::fs::write(&book, b"SQLite format 3\0 first").unwrap();
        let backup_dir = format!("{dir}/Backup");
        let b1 = format!("{backup_dir}/帳簿_20261030-120000.dmbk");
        copy_file(&book, &b1).unwrap();
        std::fs::write(format!("{backup_dir}/帳簿_2_20261030-120000.dmbk"), b"x").unwrap();
        std::fs::write(format!("{backup_dir}/ほか.dmbk"), b"x").unwrap();
        let list = list_backups(&backup_dir, "帳簿_", "dmbk").unwrap();
        // 「帳簿_2」も「帳簿_」で始まるので一覧には出る（世代の判定は画面側で日時の形まで見る）
        assert_eq!(list.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["帳簿_20261030-120000.dmbk", "帳簿_2_20261030-120000.dmbk"]);
        assert!(!list[0].encrypted);
        assert_eq!(list[0].size, 22);
        // 戻す：今の帳簿を置き換え、残っていた -journal は消す
        std::fs::write(&book, b"SQLite format 3\0 second").unwrap();
        std::fs::write(format!("{book}-journal"), b"j").unwrap();
        restore_file(&b1, &book).unwrap();
        assert_eq!(std::fs::read(&book).unwrap(), b"SQLite format 3\0 first");
        assert!(!Path::new(&format!("{book}-journal")).exists());
        assert!(!Path::new(&tmp_of(&book)).exists());
        assert!(remove_files(&[b1.clone(), format!("{backup_dir}/無い.dmbk")]).is_empty());
        assert!(!Path::new(&b1).exists());
        assert!(list_backups(&format!("{dir}/無いフォルダ"), "帳簿_", "dmbk").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lock_roundtrip() {
        let dir = tmp_dir("lock");
        let book = format!("{dir}/帳簿.dmbl");
        assert_eq!(read_lock(&book), None);
        write_lock(&book, "{\"host\":\"a\"}").unwrap();
        assert_eq!(read_lock(&book).as_deref(), Some("{\"host\":\"a\"}"));
        remove_lock(&book);
        assert_eq!(read_lock(&book), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
