/**
 * バックアップ（事業者設定）
 *  - 自動：帳簿を開くとき（開く前の状態）と閉じるときに、書類フォルダと（あれば）2か所目へ丸ごと複製を作る
 *  - 今すぐバックアップ：今の中身で作る
 *  - 2か所目：外付けディスク・別のフォルダなど（この PC ごとの設定）
 *  - 残し方：直近の世代数 ＋ 日ごとに1つ（30日分）＋ 月ごとに1つ（7年分）。戻す前に作るものは消さない（lib/backup.ts）
 *  - 戻す：一覧から選ぶ。今の帳簿を「戻す前」の印つきでバックアップしてから置き換え、開き直す（App.tsx の restoreBackup）
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, FolderInput, FolderX, HardDriveDownload, LockKeyhole, Save } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import * as repo from "../../db/repo";
import { backupNow, getSecondBackupDir, listBackups, pickBackupDir, setSecondBackupDir, type BackupEntry } from "../../db/database";
import { BACKUP_DAYS, BACKUP_MONTHS, stampLabel } from "../../lib/backup";
import { APP_DIR_NAME, BACKUP_DIR_NAME, EXT_BACKUP, MAX_BACKUP_GENERATIONS } from "../../constants/appConfig";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** 一覧に最初に出す数 */
const FIRST_ROWS = 20;

const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const BackupSection = () => {
  const { db, filePath, readOnly, can, restoreBackup, dataVersion } = useAppContext();
  const toast = useToast();
  const admin = can("settings") && !readOnly;
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [second, setSecond] = useState(getSecondBackupDir());
  const [list, setList] = useState<BackupEntry[] | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = () => listBackups(filePath).then(setList).catch((e) => toast(`バックアップの一覧を読めませんでした：${errText(e)}`, "error"));

  useEffect(() => {
    repo.getBackupGenerations(db).then((n) => {
      setSaved(n);
      setValue(String(n));
    }).catch(console.error);
    if (!readOnly) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, filePath, readOnly, dataVersion]);

  const save = async () => {
    try {
      await repo.setBackupGenerations(db, Number(value));
      setSaved(Number(value));
      toast("直近の世代数を保存しました。次に帳簿を開いたときから適用されます");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const { written, failed } = await repo.queuedRead(() => backupNow(filePath));
      if (written.length) toast(`バックアップを作りました（${written.length}か所）`);
      if (failed.length) toast(`バックアップを作れませんでした：${failed.join("、")}`, "error");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const chooseSecond = async () => {
    const dir = await pickBackupDir();
    if (!dir) return;
    setSecondBackupDir(dir);
    setSecond(dir);
    toast("2か所目を設定しました。今の中身でバックアップを作ります");
    await runNow();
  };

  const clearSecond = async () => {
    if (!(await ask("2か所目へのバックアップをやめます（作ってあるバックアップは消しません）。よろしいですか？", { title: "2か所目をやめる", kind: "warning" }))) return;
    setSecondBackupDir(null);
    setSecond(null);
    await reload();
  };

  const restore = async (b: BackupEntry) => {
    const label = `${stampLabel(b.stamp)}${b.suffix ? `・${b.suffix}` : ""}`;
    const ok = await ask(
      `${label} のバックアップに戻します。\n\n` +
        "今の帳簿は「戻す前」の印をつけてバックアップしてから、このバックアップで置き換えます（戻したあとでも、そのバックアップに戻せます）。" +
        "このバックアップより後に入れた仕訳・証憑・設定は、今の帳簿から無くなります。" +
        (b.encrypted ? "\n\n暗号化したバックアップは、作ったときのパスワード（回復キー）で開きます。" : "") +
        "\n\nよろしいですか？",
      { title: "バックアップから戻す", kind: "warning", okLabel: "戻す", cancelLabel: "やめる" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await restoreBackup(b.path, label);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };

  const rows = list ? (all ? list : list.slice(0, FIRST_ROWS)) : [];

  return (
    <section className="sheet">
      <h2 className="sheet-h">バックアップ</h2>
      <p className="prose">
        帳簿を開くとき（開く前の状態）と閉じるときに、書類フォルダの「{APP_DIR_NAME}/{BACKUP_DIR_NAME}」へ丸ごと複製（.{EXT_BACKUP}）を作ります。
        2か所目を決めると、そこにも作ります（PC の故障に備えて、外付けディスクなど別の場所にしておくと安心です）。
        古いものは、直近の世代数に加えて、日ごとに1つ（{BACKUP_DAYS}日分）と月ごとに1つ（{BACKUP_MONTHS / 12}年分）を残して消します。
      </p>
      {readOnly ? (
        <p className="field-note">読み取り専用で開いているため、ここでは操作できません。</p>
      ) : (
        <>
          <div className="field-row wrap">
            <button className="btn primary" onClick={runNow} disabled={busy}><HardDriveDownload size={16} /> 今すぐバックアップ</button>
          </div>

          <h3 className="sheet-sub">2か所目（この PC の設定）</h3>
          <div className="field-row wrap backup-second">
            <span className={second ? "path-text" : "muted"}>{second ?? "決めていません"}</span>
            <button className="btn ghost" onClick={chooseSecond} disabled={busy || !admin}><FolderInput size={16} /> {second ? "変える" : "選ぶ"}</button>
            {second && <button className="btn ghost" onClick={clearSecond} disabled={busy || !admin}><FolderX size={16} /> やめる</button>}
          </div>

          <form className="field-row backup-gen" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="field">
              <span>直近の世代数（1〜{MAX_BACKUP_GENERATIONS}）</span>
              <input className="input" type="number" min={1} max={MAX_BACKUP_GENERATIONS} value={value} onChange={(e) => setValue(e.target.value)} disabled={!admin} />
            </label>
            <div style={{ alignSelf: "flex-end" }}>
              <button className="btn primary" type="submit" disabled={!admin || saved === null || String(saved) === value}>
                <Save size={16} /> 保存する
              </button>
            </div>
          </form>

          <h3 className="sheet-sub">バックアップの一覧{list ? `（${list.length}件）` : ""}</h3>
          {list && list.length === 0 && <p className="field-note">まだありません。</p>}
          {rows.length > 0 && (
            <table className="ledger backup-list">
              <thead>
                <tr><th>日時</th><th>場所</th><th className="num">大きさ</th><th /><th /></tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.path} title={b.path}>
                    <td>{stampLabel(b.stamp)}{b.suffix && <span className="badge badge-adjust">{b.suffix}</span>}</td>
                    <td>{b.second ? "2か所目" : "書類フォルダ"}</td>
                    <td className="num">{sizeLabel(b.size)}</td>
                    <td>{b.encrypted && <span className="muted"><LockKeyhole size={13} /> 暗号化</span>}</td>
                    <td className="row-actions">
                      <button className="link-btn" onClick={() => restore(b)} disabled={busy || !admin}><ArchiveRestore size={14} /> 戻す</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list && !all && list.length > FIRST_ROWS && (
            <div className="show-more"><button className="link-btn" onClick={() => setAll(true)}>残りの {list.length - FIRST_ROWS} 件も出す</button></div>
          )}
          {!admin && <p className="field-note">2か所目・世代数・戻すは、管理者だけができます。</p>}
        </>
      )}
    </section>
  );
};
