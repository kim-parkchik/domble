/**
 * 帳簿入力のタブの編集
 * よく使う帳簿（資産・負債・資本の科目）だけをタブに並べる。追加・外す・並べ替え。帳簿ファイルに保存する
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, X } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { CATEGORY_LABEL } from "../../constants/accounts";
import { cashbookCandidates, cashbookTabs } from "../../lib/cashbook";
import type { Account } from "../../lib/types";
import * as repo from "../../db/repo";

export const CashbookTabsModal = ({ tabs, onClose, onSaved }: { tabs: Account[]; onClose: () => void; onSaved: (ids: number[]) => void }) => {
  const { db, accounts } = useAppContext();
  const toast = useToast();
  const [ids, setIds] = useState(tabs.map((a) => a.id));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rest = cashbookCandidates(accounts).filter((a) => !ids.includes(a.id));

  const move = (i: number, d: -1 | 1) =>
    setIds((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      await repo.setCashbookAccounts(db, ids);
      toast("帳簿のタブを保存しました");
      onSaved(ids);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="帳簿のタブの編集" onClose={onClose} width={560}>
      <div className="settings-form">
        <p className="prose">
          帳簿入力の上に並べる帳簿を選びます。よく使うものだけを並べてください。タブにできるのは資産・負債・資本の科目です
          （勘定科目で非表示にした科目は出ません）。この設定は帳簿ファイルに保存されます。
        </p>

        <div>
          <div className="tabs-edit-label">タブに出す帳簿（上から順に左から並びます）</div>
          <ul className="tabs-edit-list">
            {ids.map((id, i) => (
              <li key={id}>
                <span className="tabs-edit-name">{byId.get(id)?.name ?? `#${id}`}</span>
                <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上へ"><ArrowUp size={14} /></button>
                <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === ids.length - 1} aria-label="下へ"><ArrowDown size={14} /></button>
                <button className="link-btn danger" onClick={() => setIds((xs) => xs.filter((x) => x !== id))} disabled={ids.length === 1} title={ids.length === 1 ? "タブは1つ以上必要です" : undefined}>
                  <X size={14} /> 外す
                </button>
              </li>
            ))}
          </ul>
        </div>

        {rest.length > 0 && (
          <div>
            <div className="tabs-edit-label">追加できる帳簿</div>
            <ul className="tabs-edit-list">
              {rest.map((a) => (
                <li key={a.id}>
                  <span className="tabs-edit-name">{a.name}<span className="muted small">　{CATEGORY_LABEL[a.category]}</span></span>
                  <button className="link-btn" onClick={() => setIds((xs) => [...xs, a.id])}><Plus size={14} /> 追加</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="form-error-inline" role="alert">{error}</p>}
        <div className="voucher-actions">
          <button type="button" className="btn ghost" onClick={() => setIds(cashbookTabs(accounts, null).map((a) => a.id))}>
            <RotateCcw size={15} /> 最初の並びに戻す
          </button>
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="button" className="btn primary" onClick={save} disabled={busy || ids.length === 0}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </div>
    </Modal>
  );
};
