import { useEffect, useState } from "react";
import { Copy, Undo2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { VoucherForm } from "./VoucherForm";
import { EntryHistoryList } from "../books/HistoryView";
import { useAppContext } from "../../context/AppContext";
import { copyDate, linesToRows } from "../../lib/accounting";
import { todayIso } from "../../lib/format";
import type { HistoryRecord, JournalEntry } from "../../lib/types";
import * as repo from "../../db/repo";
import { EntryEvidenceSection } from "../evidence/EntryEvidenceSection";

/**
 * 既存の仕訳を振替伝票の形で開いて訂正・削除する。下に履歴を表示
 * 決算整理仕訳（台帳などから作ったものを除く）は、翌年1月1日付で振り戻せる（未払費用・前払費用など）
 * コピー：明細・摘要・取引先・税区分を写した新しい仕訳を、直してから登録する（日付は今日。証憑のひも付けは写さない）
 */
export const EntryEditModal = ({ entryId, onClose }: { entryId: number; onClose: () => void }) => {
  const { db, strict, bump, can, year, readOnly } = useAppContext();
  const toast = useToast();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // 振り戻し：できるか（決算整理仕訳で、台帳などから作ったものでない）と、作成済みの振り戻し
  const [reversal, setReversal] = useState<{ allowed: boolean; id: number | null }>({ allowed: false, id: null });
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    repo.getEntry(db, entryId).then(setEntry).catch(console.error);
    repo.getHistory(db, entryId).then(setHistory).catch(console.error);
    Promise.all([repo.getRunEntryIds(db), repo.getReversal(db, entryId)])
      .then(([runs, id]) => setReversal({ allowed: !runs.has(entryId), id }))
      .catch(console.error);
  }, [db, entryId]);

  const deleted = entry?.is_deleted === 1;
  const reverse = async () => {
    if (!entry) return;
    const next = `${Number(entry.date.slice(0, 4)) + 1}年1月1日`;
    if (!(await ask(`この決算整理仕訳の貸借を入れ替えた仕訳を、${next}付で作ります（未払費用・前払費用などの振り戻し）。`, { title: "振り戻し", okLabel: "作る", cancelLabel: "やめる" }))) return;
    try {
      const id = await repo.createReversal(db, entry.id);
      setReversal((r) => ({ ...r, id }));
      bump();
      toast(`振り戻しの仕訳（No.${id}・${next}）を作りました`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  if (entry && copying) {
    return (
      <Modal title={`仕訳のコピー（No.${entryId} から）`} onClose={onClose} width={1080}>
        <p className="field-note">No.{entryId} の明細・摘要・取引先・税区分を写しました。日付や金額を直して登録してください（証憑のひも付けは写しません）。</p>
        <VoucherForm
          key="copy"
          initialDate={copyDate(entry.date, todayIso(), year, entry.is_adjustment === 1)}
          initialRows={linesToRows(entry.lines)}
          initialCounterpartyId={entry.counterparty_id}
          initialAdjustment={entry.is_adjustment === 1}
          onSaved={onClose}
          onCancel={() => setCopying(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal title={deleted ? `削除済みの仕訳（No.${entryId}）` : strict ? `仕訳の訂正（No.${entryId}）` : `仕訳の修正（No.${entryId}）`} onClose={onClose} width={1080}>
      {!entry ? (
        <p className="muted">読み込んでいます…</p>
      ) : deleted ? (
        <p className="notice">この仕訳は削除されています。削除済みの仕訳は変更できません。経緯は下の履歴で確認できます。</p>
      ) : (
        <VoucherForm
          entryId={entry.id}
          initialDate={entry.date}
          initialRows={linesToRows(entry.lines)}
          initialCounterpartyId={entry.counterparty_id}
          initialAdjustment={entry.is_adjustment === 1}
          onSaved={onClose}
          onDeleted={onClose}
          onCancel={onClose}
        />
      )}

      {entry && (
        <p className="field-note entry-by">
          {(entry.created_by_name || entry.updated_by_name) && <>
            登録：{entry.created_by_name ?? "（記録なし）"}（{entry.created_at}）
            {entry.updated_at !== entry.created_at && <>　最終更新：{entry.updated_by_name ?? "（記録なし）"}（{entry.updated_at}）</>}
          </>}
          <button className="btn ghost sm entry-copy" onClick={() => setCopying(true)} disabled={!can("entry") || readOnly}><Copy size={14} /> コピーして新しい仕訳</button>
        </p>
      )}
      {entry && !deleted && entry.is_adjustment === 1 && reversal.allowed && (
        <p className="field-note entry-reversal">
          {reversal.id
            ? <>この決算整理仕訳の振り戻し（No.{reversal.id}・翌年1月1日付）は作成済みです。</>
            : <>未払費用・前払費用などの決算整理仕訳は、翌年の初めに振り戻します。
              <button className="btn ghost sm" onClick={reverse} disabled={!can("entry")}><Undo2 size={14} /> 翌年1月1日付で振り戻す</button></>}
        </p>
      )}
      {entry && <EntryEvidenceSection entry={entry} />}

      {strict && history.length > 0 && (
        <section className="history-section">
          <button className="link-btn" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory || deleted}>
            {showHistory || deleted ? "▾" : "▸"} この仕訳の履歴（{history.length}件
            {history.length > 1 ? `・訂正 ${history.filter((h) => h.action === "update").length}回` : ""}）
          </button>
          {(showHistory || deleted) && <EntryHistoryList records={history} />}
        </section>
      )}
    </Modal>
  );
};
