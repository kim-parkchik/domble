/**
 * 帳簿ファイルの暗号化（事業者設定・任意）
 *  - パスワードをかけると、ファイルを持ち出されても中身を読めず、アプリの外から書き換えることもできない
 *  - 回復キー：パスワードを忘れても、これがあれば開ける。パスワードを変えると新しくなる
 *  - この PC に記憶する：次からこの PC ではパスワードを聞かずに開く（鍵は OS の鍵の保管庫に預ける）
 * かける・外す・パスワードを変えたことは履歴に残す（repo.changeEncryption）
 * 暗号化したあとも、それまでのバックアップは暗号化されていないまま残るので、数を見せて消せるようにする
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Copy, FileDown, KeyRound, LockKeyhole, LockOpen, MonitorCheck, MonitorX, Trash2 } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { copyText } from "../../lib/clipboard";
import { saveAnchorFile } from "../books/IntegrityModal";
import * as enc from "../../db/encryption";
import * as repo from "../../db/repo";
import { backupNow, listBackups, removeBackups, type BackupEntry } from "../../db/database";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const EncryptionSection = () => {
  const { db, filePath, readOnly, can, bump } = useAppContext();
  const toast = useToast();
  const [status, setStatus] = useState<enc.EncryptionStatus | null>(null);
  const [dialog, setDialog] = useState<"on" | "password" | "off" | null>(null);
  const [recovery, setRecovery] = useState<{ result: enc.Encrypted; changed: boolean } | null>(null);
  /** 暗号化していないバックアップ（暗号化した帳簿のとき） */
  const [plain, setPlain] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    enc.encryptionStatus(filePath).then(setStatus).catch(console.error);
  }, [filePath]);

  useEffect(() => {
    if (!status?.encrypted || readOnly) return setPlain([]);
    listBackups(filePath).then((l) => setPlain(l.filter((b) => !b.encrypted))).catch(console.error);
  }, [filePath, status?.encrypted, readOnly]);

  if (!status) return null;
  const admin = can("settings") && !readOnly;
  const fileName = filePath.split(/[\\/]/).pop() ?? "";

  const toggleRemember = async () => {
    try {
      setStatus(await enc.setRemember(filePath, !status.remembered));
      toast(status.remembered ? "この PC の記憶を消しました。次からはパスワードを聞きます" : "この PC に記憶しました。次からはパスワードなしで開けます");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  /** 暗号化したバックアップを今作ってから、暗号化していないバックアップを消す */
  const removePlain = async () => {
    const ok = await ask(
      `暗号化していないバックアップ ${plain.length}件を消します（2か所目にあるものも）。消す前に、今の中身で暗号化したバックアップを作ります。\n\n` +
        "消したバックアップには戻せなくなります。よろしいですか？",
      { title: "暗号化していないバックアップを消す", kind: "warning", okLabel: "消す", cancelLabel: "やめる" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const { written, failed } = await repo.queuedRead(() => backupNow(filePath));
      if (written.length === 0) throw new Error(`暗号化したバックアップを作れなかったため、消すのをやめました（${failed.join("、")}）`);
      const left = await removeBackups(plain.map((b) => b.path));
      const now = (await listBackups(filePath)).filter((b) => !b.encrypted);
      setPlain(now);
      bump();
      if (left.length) toast(`消せなかったものがあります：${left.join("、")}`, "error");
      else toast("暗号化していないバックアップを消しました");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">帳簿ファイルの暗号化</h2>
      <p className="prose">
        帳簿ファイルにパスワードをかけて、中身を丸ごと暗号化します（任意）。ファイルを持ち出されたり、誤って送ってしまったりしても中身は読めず、
        このソフトの外から書き換えることもできません。バックアップも暗号化されたまま作られます。
      </p>
      <dl className="kv">
        <dt>暗号化</dt>
        <dd>{status.encrypted ? <><LockKeyhole size={14} /> あり（AES-256）</> : "なし"}</dd>
        {status.encrypted && (
          <>
            <dt>この PC に記憶</dt>
            <dd>{status.remembered ? "あり（パスワードなしで開けます）" : "なし（開くたびにパスワードを聞きます）"}</dd>
          </>
        )}
      </dl>
      {readOnly && <p className="field-note">読み取り専用で開いているため、変更できません。</p>}
      {plain.length > 0 && (
        <div className="notice plain-backups">
          <span>
            暗号化する前に作った、<b>暗号化していないバックアップが {plain.length}件</b> 残っています。持ち出されると中身を読まれるので、要らなければ消してください
            （書類フォルダ{plain.some((b) => b.second) ? "・2か所目" : ""}）。
          </span>
          <button className="btn danger-ghost" onClick={removePlain} disabled={!admin || busy}><Trash2 size={16} /> 消す</button>
        </div>
      )}
      <div className="field-row wrap">
        {!status.encrypted ? (
          <button className="btn primary" onClick={() => setDialog("on")} disabled={!admin}><LockKeyhole size={16} /> 暗号化する</button>
        ) : (
          <>
            <button className="btn ghost" onClick={() => setDialog("password")} disabled={!admin}><KeyRound size={16} /> パスワードを変える</button>
            <button className="btn ghost" onClick={toggleRemember} disabled={readOnly}>
              {status.remembered ? <><MonitorX size={16} /> この PC の記憶を消す</> : <><MonitorCheck size={16} /> この PC に記憶する</>}
            </button>
            <button className="btn danger-ghost" onClick={() => setDialog("off")} disabled={!admin}><LockOpen size={16} /> 暗号化をやめる</button>
          </>
        )}
      </div>

      {dialog && (
        <EncryptionDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onDone={async (r) => {
            const changed = dialog === "password";
            setDialog(null);
            setStatus(await enc.encryptionStatus(filePath));
            if (r) setRecovery({ result: r, changed });
            if (dialog === "on" || dialog === "password") repo.queuedRead(() => backupNow(filePath)).catch(console.warn);
            else toast("暗号化をやめました");
          }}
          run={(current, password, remember) =>
            repo.changeEncryption(db, dialog, async () => {
              if (dialog === "on") return enc.encrypt(filePath, password, remember);
              if (dialog === "password") return enc.changeFilePassword(filePath, current, password);
              await enc.decrypt(filePath, current);
              return null;
            })
          }
        />
      )}
      {recovery && <RecoveryKeyModal recovery={recovery.result} changed={recovery.changed} fileName={fileName} onClose={() => setRecovery(null)} />}
    </section>
  );
};

const TITLE = { on: "帳簿ファイルを暗号化する", password: "帳簿ファイルのパスワードを変える", off: "暗号化をやめる" } as const;

const EncryptionDialog = ({ mode, run, onClose, onDone }: {
  mode: "on" | "password" | "off";
  run: (current: string, password: string, remember: boolean) => Promise<enc.Encrypted | null>;
  onClose: () => void;
  onDone: (r: enc.Encrypted | null) => void;
}) => {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const needsNew = mode !== "off";

  const submit = async () => {
    setError("");
    if (needsNew) {
      const pe = enc.validateFilePassword(password);
      if (pe) return setError(pe);
      if (password !== confirm) return setError("確認のパスワードが一致しません");
    }
    setBusy(true);
    try {
      onDone(await run(current, password, remember));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={TITLE[mode]} onClose={busy ? () => undefined : onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {mode === "on" && (
          <p className="notice">
            パスワードを忘れると、回復キーがない限り<b>二度と開けなくなります</b>。帳簿は7年間の保存が必要です。
            このあと表示する回復キーは、必ず印刷するか、別の場所に保存してください。
          </p>
        )}
        {mode === "password" && (
          <p className="field-note">
            パスワードを変えると回復キーも新しくなります。これまでのバックアップは、そのときのパスワード（回復キー）で開きます。
          </p>
        )}
        {mode === "off" && (
          <p className="field-note">
            帳簿ファイルを暗号化していない形に戻します。ファイルを持ち出されると、中身を読まれるようになります。
            これまでに作られたバックアップは暗号化されたままです。
          </p>
        )}
        {mode !== "on" && (
          <label className="field">
            <span>今のパスワード（または回復キー）</span>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="off" autoFocus />
          </label>
        )}
        {needsNew && (
          <>
            <label className="field">
              <span>{mode === "on" ? "パスワード" : "新しいパスワード"}（{enc.FILE_PASSWORD_MIN}文字以上）</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus={mode === "on"} />
            </label>
            <label className="field">
              <span>確認のため、もう一度</span>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        {mode === "on" && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            この PC に記憶する（この PC ではパスワードなしで開けます。ほかの PC では聞かれます）
          </label>
        )}
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>やめる</button>
          <button className={`btn ${mode === "off" ? "danger-ghost" : "primary"}`} type="submit" disabled={busy || (mode !== "on" && !current)}>
            {busy ? "処理しています…" : mode === "on" ? "暗号化する" : mode === "password" ? "変える" : "暗号化をやめる"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

/** 回復キーを見せる。控えたことを確かめてから閉じる。changed：パスワードを変えたとき（前の回復キーは使えなくなった） */
const RecoveryKeyModal = ({ recovery, changed, fileName, onClose }: { recovery: enc.Encrypted; changed: boolean; fileName: string; onClose: () => void }) => {
  const toast = useToast();
  const [kept, setKept] = useState(false);
  const text =
    `domble 帳簿ファイルの回復キー\n\nファイル：${fileName}\n作成日時：${new Date().toLocaleString("ja-JP")}\n\n${recovery.recovery_key}\n\n` +
    "パスワードを忘れたときは、開くときの「パスワードを忘れたとき（回復キーで開く）」にこの回復キーを入れてください。\n" +
    "パスワードを変えると、この回復キーは使えなくなります（それまでのバックアップには使えます）。\n";

  return (
    <Modal title="回復キー" onClose={() => (kept ? onClose() : undefined)} width={560}>
      <div className="settings-form">
        <p className="prose">
          {changed
            ? "パスワードを変えました。前の回復キーはこの帳簿には使えなくなったので、新しい回復キーを控えてください。" +
              "これまでのバックアップは前のパスワード（前の回復キー）で開くので、前の回復キーも捨てずに残してください。"
            : "暗号化しました。"}
          パスワードを忘れたときは、この<b>回復キー</b>で開けます。回復キーがあれば誰でも開けるので、帳簿ファイルとは別の安全な場所に保管してください。
        </p>
        <code className="recovery-key">{recovery.recovery_key}</code>
        {!recovery.remembered && <p className="field-note">この PC には記憶していません。開くたびにパスワードを聞きます。</p>}
        <div className="field-row">
          <button className="btn ghost" onClick={async () => {
              if (await copyText(recovery.recovery_key)) toast("回復キーをコピーしました");
              else toast("コピーできませんでした", "error");
            }}>
            <Copy size={16} /> コピー
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                if (await saveAnchorFile(text, `${fileName.replace(/\.[^.]+$/, "")}_回復キー.txt`)) toast("回復キーを保存しました");
              } catch (e) {
                toast(`保存できませんでした：${errText(e)}`, "error");
              }
            }}
          >
            <FileDown size={16} /> ファイルに保存
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
          回復キーを控えました
        </label>
        <div className="voucher-actions">
          <div className="spacer" />
          <button className="btn primary" onClick={onClose} disabled={!kept}>閉じる</button>
        </div>
      </div>
    </Modal>
  );
};
