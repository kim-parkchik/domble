/**
 * 一覧の CSV 取り込みの確かめ（勘定科目・補助科目・取引先の画面。読み方は lib/masterCsv.ts）
 *  - 足すもの・書き換えるもの（変わる欄の前 → 後）・変わらないものの数を出す
 *  - 書き換えは行ごとに外せる（初めはすべて書き換える）
 *  - 1つのトランザクションなので、途中で失敗したら1件も変えない
 */
import { useState } from "react";
import { Upload } from "lucide-react";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import type { ListPlan, ListUpdate } from "../../lib/masterCsv";
import type { ListImportResult } from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const ListImportModal = <A, U>({ what, plan, nameOf, onImport, onClose }: {
  /** 取引先・科目・補助科目 */
  what: string;
  plan: ListPlan<A, U>;
  /** 足すものの表示名 */
  nameOf: (a: A) => string;
  onImport: (rows: A[], updates: ListUpdate<U>[]) => Promise<ListImportResult>;
  onClose: () => void;
}) => {
  const toast = useToast();
  const [off, setOff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const chosen = plan.updates.filter((u) => !off.has(u.row));
  const toggle = (row: number, on: boolean) => setOff((s) => {
    const n = new Set(s);
    if (on) n.delete(row);
    else n.add(row);
    return n;
  });

  const run = async () => {
    setBusy(true);
    try {
      const r = await onImport(plan.rows, chosen);
      toast([r.added && `${what}を ${r.added} 件足しました`, r.updated && `${r.updated} 件を書き換えました`].filter(Boolean).join("。"));
      onClose();
    } catch (e) {
      toast(`取り込めませんでした（1件も変えていません）：${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${what}の CSV 取り込み`} onClose={onClose} width={760}>
      <div className="settings-form">
        <p className="prose">
          足す {plan.rows.length} 件・書き換え {plan.updates.length} 件・変わらない {plan.skipped} 件です。
          今ある{what}は名前で突き合わせ、CSV に書いてある欄だけを書き換えます（空欄・無い列は今のまま。名前は変えません）。
          書き換えたくないものは、チェックを外してください。
        </p>
        {plan.rows.length > 0 && (
          <>
            <h3 className="sheet-h small">足す{what}（{plan.rows.length} 件）</h3>
            <p className="list-import-adds">{plan.rows.map(nameOf).join("、")}</p>
          </>
        )}
        {plan.updates.length > 0 && (
          <>
            <h3 className="sheet-h small">書き換える{what}（{chosen.length} / {plan.updates.length} 件）</h3>
            <div className="table-wrap scroll-y list-import-updates">
              <table className="ledger">
                <colgroup><col style={{ width: 36 }} /><col style={{ width: "30%" }} /><col /></colgroup>
                <thead><tr><th aria-label="書き換える" /><th>{what}</th><th>変わる欄（前 → 後）</th></tr></thead>
                <tbody>
                  {plan.updates.map((u) => (
                    <tr key={u.row} className={off.has(u.row) ? "muted" : undefined}>
                      <td><input type="checkbox" checked={!off.has(u.row)} onChange={(e) => toggle(u.row, e.target.checked)} aria-label={`${u.name}を書き換える`} /></td>
                      <td>{u.name}</td>
                      <td>
                        {u.changes.map((c) => (
                          <div key={c.label} className="list-import-change">
                            <span className="muted">{c.label}：</span>{c.before || "（空）"} → <b>{c.after || "（空）"}</b>
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="button" className="btn primary" onClick={run} disabled={busy || (plan.rows.length === 0 && chosen.length === 0)}>
            <Upload size={16} /> {[plan.rows.length && `${plan.rows.length} 件を足す`, chosen.length && `${chosen.length} 件を書き換える`].filter(Boolean).join("・") || "取り込む"}
          </button>
        </div>
      </div>
    </Modal>
  );
};
