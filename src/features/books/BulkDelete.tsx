/**
 * 仕訳のまとめての削除（仕訳日記帳）
 *  - DeleteReasonDialog：選んだ仕訳・1回の取り込みの仕訳を、理由を1つ入れて削除する（厳密モードは理由が要り、1件ずつ履歴に残る）
 *  - ImportBatchesModal：取り込みの記録（仕訳の CSV 取り込み・明細の登録ごと）の一覧。その取り込みの仕訳をまとめて削除できる
 * どちらも1つのトランザクションなので、締めた月の仕訳が混ざっていたら1件も消さない（db/repo.ts の deleteEntries）
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** 削除の理由を入れて、まとめて削除する。onDelete は削除した数を返す */
export const DeleteReasonDialog = ({ title, count, note, onDelete, onClose }: {
  title: string;
  count: number;
  note?: string;
  onDelete: (reason: string) => Promise<number>;
  onClose: () => void;
}) => {
  const { strict, bump } = useAppContext();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const n = await onDelete(reason);
      bump();
      toast(`${n} 件の仕訳を削除しました`);
      onClose();
    } catch (e) {
      toast(`削除できませんでした：${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={520}>
      <p className="prose">
        {count.toLocaleString()} 件の仕訳を削除します。
        {strict ? "帳簿や集計からは外れますが、削除した事実と内容は「訂正・削除履歴」に1件ずつ残ります。" : "元に戻せません。"}
        締めた月の仕訳が混ざっているときは、1件も削除しません。
      </p>
      {note && <p className="field-note">{note}</p>}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>削除の理由{strict ? "（必須）" : "（任意）"}</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：同じ CSV を2回取り込んだため" maxLength={200} autoFocus />
        </label>
        <div className="voucher-actions" style={{ marginTop: 12 }}>
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="submit" className="btn danger-ghost" disabled={busy || (strict && !reason.trim())}>
            <Trash2 size={16} /> {count.toLocaleString()} 件を削除
          </button>
        </div>
      </form>
    </Modal>
  );
};

/** 取り込みの記録の一覧 */
export const ImportBatchesModal = ({ onClose, canDelete }: { onClose: () => void; canDelete: boolean }) => {
  const { db, dataVersion } = useAppContext();
  const [batches, setBatches] = useState<repo.ImportBatch[] | null>(null);
  const [target, setTarget] = useState<repo.ImportBatch | null>(null);
  useEffect(() => {
    repo.getImportBatches(db).then(setBatches).catch(console.error);
  }, [db, dataVersion]);
  const range = (b: repo.ImportBatch) =>
    b.first_date ? `${b.first_date.replace(/-/g, "/")}${b.last_date !== b.first_date ? `〜${b.last_date!.replace(/-/g, "/")}` : ""}` : "";

  return (
    <Modal title="取り込みの記録" onClose={onClose} width={860}>
      <p className="prose">
        仕訳の CSV 取り込みと、銀行・カードの明細の登録を、1回ごとに記録しています。同じファイルを2回取り込んだときなどは、その回の仕訳をまとめて削除できます
        （明細の登録を削除すると、明細は未登録に戻ります）。
      </p>
      {batches === null ? <p className="muted">読み込んでいます…</p> : batches.length === 0 ? <p className="muted">まだ取り込みはありません。</p> : (
        <div className="table-wrap import-batches">
          <table className="ledger">
            <thead>
              <tr><th className="num">No.</th><th>日時・操作した人</th><th>種類</th><th>ファイル</th><th className="num">登録した数</th><th className="num">残っている数</th><th>取引日</th><th /></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="num muted">{b.id}</td>
                  <td>
                    {b.created_at.slice(0, 16).replace(/-/g, "/")}
                    {b.user_name && <div className="muted small">{b.user_name}</div>}
                  </td>
                  <td>{repo.IMPORT_KIND_LABEL[b.kind]}</td>
                  <td className="wrap">{b.source}</td>
                  <td className="num">{b.total.toLocaleString()}</td>
                  <td className="num">{b.live.toLocaleString()}</td>
                  <td>{range(b)}</td>
                  <td>
                    {canDelete && b.live > 0 && (
                      <button className="btn ghost sm danger-ghost" onClick={() => setTarget(b)}><Trash2 size={14} /> 削除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target && (
        <DeleteReasonDialog
          title={`取り込み No.${target.id} の仕訳の削除`}
          count={target.live}
          note={`${repo.IMPORT_KIND_LABEL[target.kind]}（${target.source}）で登録した仕訳のうち、残っている ${target.live} 件を削除します。${target.kind === "bank" ? "明細は未登録に戻ります。" : ""}`}
          onDelete={(reason) => repo.deleteImportBatch(db, target.id, reason)}
          onClose={() => setTarget(null)}
        />
      )}
    </Modal>
  );
};
