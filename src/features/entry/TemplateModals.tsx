/**
 * 定型仕訳の呼び出し・登録
 *  - 呼び出し：一覧から選んで振替伝票に入れる（帳簿入力では、この帳簿の科目と相手科目1つのものを入力の行に）。名前の変更・削除もここで
 *  - 登録：今の振替伝票を名前をつけて保存。同じ名前があれば、その中身を置き換える
 */
import { useEffect, useState } from "react";
import { Check, Pencil, Save, Trash2, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { yen } from "../../lib/format";
import { validateTemplateName, type JournalTemplate } from "../../lib/templates";
import type { VoucherRow } from "../../lib/types";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** 一覧での中身の見え方（1行目の科目と金額、ほかに何行あるか） */
const Summary = ({ t }: { t: JournalTemplate }) => {
  const { labelOf, counterparties } = useAppContext();
  const first = t.rows[0];
  const side = (acc: number | null, sub: number | null, amt: number | null) =>
    acc ? `${labelOf(acc, sub)}${amt ? ` ${yen(amt)}` : ""}` : "—";
  const cp = t.counterparty_id ? counterparties.find((c) => c.id === t.counterparty_id)?.name : "";
  return (
    <span className="muted small">
      {first ? `${side(first.debitAccountId, first.debitSubId, first.debitAmount)} ／ ${side(first.creditAccountId, first.creditSubId, first.creditAmount)}` : ""}
      {t.rows.length > 1 && `（ほか ${t.rows.length - 1} 行）`}
      {cp && `　取引先：${cp}`}
    </span>
  );
};

export const TemplatePickModal = ({ onPick, onClose }: { onPick: (t: JournalTemplate) => void; onClose: () => void }) => {
  const { db } = useAppContext();
  const toast = useToast();
  const [list, setList] = useState<JournalTemplate[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState("");

  const reload = () => repo.getTemplates(db).then(setList).catch(console.error);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  const rename = async () => {
    if (!renaming || !list) return;
    const err = validateTemplateName(list, renaming.name, renaming.id);
    if (err) return setError(err);
    try {
      await repo.renameTemplate(db, renaming.id, renaming.name);
      setRenaming(null);
      setError("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const remove = async (t: JournalTemplate) => {
    if (!(await ask(`定型仕訳「${t.name}」を削除します。`, { title: "定型仕訳の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    try {
      await repo.deleteTemplate(db, t.id);
      await reload();
      toast("定型仕訳を削除しました");
    } catch (e) {
      toast(`削除できませんでした：${errText(e)}`, "error");
    }
  };

  return (
    <Modal title="定型仕訳から呼び出す" onClose={onClose} width={680}>
      <div className="settings-form">
        {list === null ? (
          <p className="muted">読み込んでいます…</p>
        ) : list.length === 0 ? (
          <p className="empty-note">まだ定型仕訳がありません。振替伝票に入力して「定型仕訳に登録」で保存できます。</p>
        ) : (
          <ul className="template-list">
            {list.map((t) => (
              <li key={t.id}>
                {renaming?.id === t.id ? (
                  <form className="template-rename" onSubmit={(e) => { e.preventDefault(); rename(); }}>
                    <input className="input" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} maxLength={40} autoFocus aria-label="新しい名前" />
                    <button className="icon-btn" type="submit" aria-label="名前を保存"><Check size={15} /></button>
                    <button className="icon-btn" type="button" onClick={() => { setRenaming(null); setError(""); }} aria-label="やめる"><X size={15} /></button>
                  </form>
                ) : (
                  <button className="template-pick" onClick={() => onPick(t)} title="この定型仕訳を伝票に入れる">
                    <strong>{t.name}</strong>
                    <Summary t={t} />
                  </button>
                )}
                <div className="row-actions">
                  <button className="link-btn" onClick={() => { setRenaming({ id: t.id, name: t.name }); setError(""); }}><Pencil size={14} /> 名前</button>
                  <button className="link-btn danger" onClick={() => remove(t)}><Trash2 size={14} /> 削除</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </Modal>
  );
};

export const TemplateSaveModal = ({ rows, counterpartyId, onClose }: { rows: VoucherRow[]; counterpartyId: number | null; onClose: () => void }) => {
  const { db } = useAppContext();
  const toast = useToast();
  const [list, setList] = useState<JournalTemplate[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    repo.getTemplates(db).then(setList).catch(console.error);
  }, [db]);

  // 同じ名前があれば、その中身を置き換える
  const existing = list.find((t) => t.name === name.trim());

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      if (existing) await repo.overwriteTemplate(db, existing.id, rows, counterpartyId);
      else await repo.createTemplate(db, name, rows, counterpartyId);
      toast(existing ? `定型仕訳「${existing.name}」を置き換えました` : "定型仕訳に登録しました");
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="定型仕訳に登録" onClose={onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <p className="prose">今の伝票の科目・金額・摘要・取引先を保存します（日付は保存しません）。毎回金額が変わるものは、金額を空にしてから登録してください。</p>
        <label className="field">
          <span>名前</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} list="template-names" maxLength={40} placeholder="例：事務所の家賃" autoFocus />
          <datalist id="template-names">
            {list.map((t) => <option key={t.id} value={t.name} />)}
          </datalist>
          {existing && <span className="field-note warn-text">同じ名前の定型仕訳があります。登録すると、その中身を今の伝票で置き換えます。</span>}
        </label>
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            <Save size={16} /> {existing ? "置き換える" : "登録する"}
          </button>
        </div>
      </form>
    </Modal>
  );
};
