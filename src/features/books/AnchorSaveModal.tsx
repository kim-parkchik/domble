/**
 * 年の締めの確認コードを控える（厳密モード。年を締めた直後・事業者設定の締め・決算整理・ホームから開く）
 *  - 控え方：メールソフトで送る（mailto: で、宛先・件名・本文を入れたメールソフトを開く。domble からは送らない）・
 *    ファイルに保存・コピー。控えたら「控えた」で記録する（ファイルに保存したときは、それで記録する）
 *  - 記録は締めたときの連鎖の先頭と一緒に持つので、締め直すと控え直しになる（lib/closing.ts の anchorSaveOf）
 *  - 送り先のメールアドレスは帳簿に1つ（自分あて。毎回入れなくてよいように）
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, FileDown, Mail } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { copyText } from "../../lib/clipboard";
import { fileLabel } from "../../lib/business";
import { ANCHOR_HOW_LABEL, anchorSaveOf, isMailAddress, mailtoUrl, type AnchorSaveHow } from "../../lib/closing";
import { anchorText, saveAnchorFile } from "./IntegrityModal";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const AnchorSaveModal = ({ year, onClose }: { year: number; onClose: () => void }) => {
  const { db, settings, filePath, closings, bump, reloadSettings, can } = useAppContext();
  const toast = useToast();
  const closing = closings.find((c) => c.fiscal_year === year);
  const saved = anchorSaveOf(closing);
  const [email, setEmail] = useState(settings.anchor_email ?? "");
  /** この画面でメールソフトを開いたか（「控えた」の方法をメールにする） */
  const [mailed, setMailed] = useState(false);
  if (!closing?.chain_head) return null;
  const code = repo.anchorCode(closing.chain_head);
  const label = `${year}年の締め`;
  const text = anchorText({ business: settings.business_name, file: filePath.split(/[\\/]/).pop() ?? "", head: { row_hash: closing.chain_head, recorded_at: closing.closed_at }, label });
  const admin = can("settings");

  const mark = async (how: AnchorSaveHow) => {
    try {
      await repo.markAnchorSaved(db, year, how);
      bump();
      toast(`${year}年の確認コードを控えたことを記録しました（${ANCHOR_HOW_LABEL[how]}）`);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const sendMail = async () => {
    if (!isMailAddress(email)) return toast("メールアドレスの形が正しくありません（例：name@example.com）", "error");
    try {
      if (email.trim() !== (settings.anchor_email ?? "")) {
        await repo.setAnchorEmail(db, email);
        await reloadSettings();
      }
      const body = text.replace("このファイルは帳簿ファイルとは別の場所に保管してください。", "このメールは消さずに残しておいてください（帳簿ファイルとは別の控えになります）。");
      await invoke("open_mail", { url: mailtoUrl(email, `domble 確認コード ${year}年（${fileLabel(settings)}）`, body) });
      setMailed(true);
      toast("メールソフトを開きました。送ったら「控えた」を押してください");
    } catch (e) {
      toast(`メールソフトを開けませんでした：${errText(e)}（コピーかファイルに保存で控えてください）`, "error");
    }
  };
  const saveFile = async () => {
    if (await saveAnchorFile(text, `確認コード_${fileLabel(settings)}_${year}年締め.txt`)) await mark("file");
  };

  return (
    <Modal title={`${year}年の確認コードを控える`} onClose={onClose} width={620}>
      <div className="settings-form">
        <p className="prose">
          年を締めたときの確認コードです。帳簿ファイルをまるごと作り直されると帳簿の中だけでは見抜けないので、このコードを帳簿ファイルの外
          （自分あてのメール・別の場所のファイル・決算書の控えなど）に残しておきます。あとで「改ざんの確認」にコードを入れると、
          この時点から帳簿が作り直されていないかを確かめられます。
        </p>
        <div className="anchor-box">
          <code className="anchor-code">{code}</code>
          <span className={saved ? "status-closed" : "status-open"}>
            {saved ? `控え：済み（${saved.at.slice(0, 10).replace(/-/g, "/")}・${ANCHOR_HOW_LABEL[saved.how]}）` : "控え：まだ"}
          </span>
        </div>
        <label className="field">
          <span>送り先のメールアドレス（自分あて。メールソフトが開くだけで、domble からは送りません）</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" disabled={!admin} />
        </label>
        <div className="anchor-actions">
          <button className="btn ghost" onClick={sendMail} disabled={!admin}><Mail size={16} /> メールソフトで送る</button>
          <button className="btn ghost" onClick={saveFile} disabled={!admin}><FileDown size={16} /> ファイルに保存</button>
          <button className="btn ghost" onClick={async () => (await copyText(code)) ? toast("確認コードをコピーしました。控えたら「控えた」を押してください") : toast("コピーできませんでした", "error")}>
            <Copy size={16} /> コピー
          </button>
        </div>
        <p className="field-note">
          Gmail などをブラウザだけで使っていてメールソフトが開かないときは、コピーして自分あてに送るか、ファイルに保存して帳簿ファイルとは別の場所に置いてください。
        </p>
        <div className="voucher-actions">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>{saved ? "閉じる" : "あとで"}</button>
          <button className="btn primary" onClick={() => mark(mailed ? "mail" : "manual")} disabled={!admin}>
            <Check size={16} /> 控えた{mailed ? "（メールで送った）" : "（書き写した・印刷した・送った）"}
          </button>
        </div>
      </div>
    </Modal>
  );
};
