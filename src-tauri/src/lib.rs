mod crypt;
mod db;
mod files;

use db::{Databases, Encrypted, EncryptionStatus, ExecResult, Unlock};
use serde_json::{Map, Value as Json};
use tauri::State;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Manager, Runtime,
};

// ── 帳簿ファイル（SQLite）。中身は db.rs ──
/// 暗号化した帳簿は secret（パスワードか回復キー）か、この PC に記憶した鍵で開く。
/// どちらも無ければ "DOMBLE_NEEDS_KEY"、違えば "DOMBLE_WRONG_KEY" で失敗する（画面側がパスワードを聞く）
#[tauri::command(async)]
fn db_open(dbs: State<'_, Databases>, path: String, readonly: Option<bool>, secret: Option<String>, remember: Option<bool>) -> Result<EncryptionStatus, String> {
    dbs.open(&path, readonly.unwrap_or(false), Unlock { secret, remember: remember.unwrap_or(false) })
}

#[tauri::command(async)]
fn db_close(dbs: State<'_, Databases>, path: String) -> Result<(), String> {
    dbs.close(&path)
}

#[tauri::command(async)]
fn db_execute(dbs: State<'_, Databases>, path: String, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    dbs.with(&path, |c| db::execute(c, &sql, &params))
}

#[tauri::command(async)]
fn db_select(dbs: State<'_, Databases>, path: String, sql: String, params: Vec<Json>) -> Result<Vec<Map<String, Json>>, String> {
    dbs.with(&path, |c| db::select(c, &sql, &params))
}

// ── 暗号化（任意）。中身は db.rs と crypt.rs ──
#[tauri::command(async)]
fn db_encryption_status(dbs: State<'_, Databases>, path: String) -> Result<EncryptionStatus, String> {
    dbs.status(&path)
}

#[tauri::command(async)]
fn db_encrypt(dbs: State<'_, Databases>, path: String, password: String, remember: bool) -> Result<Encrypted, String> {
    dbs.encrypt(&path, &password, remember)
}

#[tauri::command(async)]
fn db_change_password(dbs: State<'_, Databases>, path: String, current: String, password: String) -> Result<Encrypted, String> {
    dbs.change_password(&path, &current, &password)
}

#[tauri::command(async)]
fn db_decrypt(dbs: State<'_, Databases>, path: String, current: String) -> Result<(), String> {
    dbs.decrypt(&path, &current)
}

#[tauri::command(async)]
fn db_set_remember(dbs: State<'_, Databases>, path: String, remember: bool) -> Result<EncryptionStatus, String> {
    dbs.set_remember(&path, remember)
}

// ── バックアップ・戻す・使用中の目印。中身は files.rs（開いている帳簿の書き出しは db.rs） ──
/// 開いている帳簿を dest へ書き出す（暗号化した帳簿は暗号化したまま）
#[tauri::command(async)]
fn db_backup(dbs: State<'_, Databases>, path: String, dest: String) -> Result<(), String> {
    dbs.backup_to(&path, &dest)
}

/// 閉じている（開く前の）ファイルを写す（開くときのバックアップ）
#[tauri::command(async)]
fn file_copy(src: String, dest: String) -> Result<(), String> {
    files::copy_file(&src, &dest)
}

#[tauri::command(async)]
fn backup_list(dir: String, prefix: String, ext: String) -> Result<Vec<files::BackupFile>, String> {
    files::list_backups(&dir, &prefix, &ext)
}

#[tauri::command(async)]
fn files_remove(paths: Vec<String>) -> Vec<String> {
    files::remove_files(&paths)
}

/// バックアップを帳簿に戻す（帳簿を閉じてから呼ぶ）
#[tauri::command(async)]
fn file_restore(backup: String, book: String) -> Result<(), String> {
    files::restore_file(&backup, &book)
}

#[tauri::command(async)]
fn lock_read(path: String) -> Option<String> {
    files::read_lock(&path)
}

#[tauri::command(async)]
fn lock_write(path: String, content: String) -> Result<(), String> {
    files::write_lock(&path, &content)
}

#[tauri::command(async)]
fn lock_remove(path: String) {
    files::remove_lock(&path)
}

#[tauri::command(async)]
fn host_name() -> String {
    files::host_name()
}

/// macOS のメニュー。既定の「終了」（⌘Q）はウィンドウに知らせずにすぐ終わってしまい、画面側でログアウトを
/// 記録できないので、自前の「domble を終了」に差し替える。押すとウィンドウを閉じる（画面側が記録してから閉じる）
#[cfg(target_os = "macos")]
const QUIT_ID: &str = "domble-quit";

#[cfg(target_os = "macos")]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItemBuilder::with_id(QUIT_ID, "domble を終了").accelerator("CmdOrCtrl+Q").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "domble")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "編集").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "表示").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "ウインドウ").minimize().maximize().separator().close_window().build()?;
    MenuBuilder::new(app).item(&app_menu).item(&edit).item(&view).item(&window).build()
}

/// 内閣府の祝日の一覧（CSV・Shift_JIS）。取得先はここに決め打ちにする（画面から任意の URL へは通信させない）
const CAO_HOLIDAYS_URL: &str = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

/// 祝日の一覧を取得する（利用者が事業者設定の「最新の祝日を取得」を押したときだけ呼ばれる）。中身はそのまま返す
#[tauri::command(async)]
fn fetch_holidays_csv() -> Result<Vec<u8>, String> {
    use std::io::Read;
    let res = ureq::get(CAO_HOLIDAYS_URL)
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("祝日の一覧を取得できませんでした：{e}"))?;
    let mut buf = Vec::new();
    // 1MB を超えるものは祝日の一覧ではないので読まない
    res.into_reader().take(1_000_000).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == QUIT_ID {
            // ウィンドウを閉じる → 画面側がログアウトを記録して閉じる → ウィンドウが無くなりアプリも終わる
            match app.get_webview_window("main") {
                Some(w) => {
                    let _ = w.close();
                }
                None => app.exit(0),
            }
        }
    });
    builder
        .manage(Databases::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            db_open, db_close, db_execute, db_select, db_encryption_status, db_encrypt, db_change_password, db_decrypt, db_set_remember, fetch_holidays_csv,
            db_backup, file_copy, backup_list, files_remove, file_restore, lock_read, lock_write, lock_remove, host_name
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// 通信するので普段は動かさない（cargo test -- --ignored で動かす）
    #[test]
    #[ignore]
    fn fetch_holidays_csv_from_cao() {
        let bytes = super::fetch_holidays_csv().unwrap();
        assert!(bytes.len() > 10_000);
        assert!(bytes.starts_with(&[0x8d, 0x91])); // Shift_JIS の「国」
    }
}
