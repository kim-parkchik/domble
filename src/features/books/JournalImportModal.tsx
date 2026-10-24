/**
 * 仕訳の CSV 取り込み
 * ファイルを選ぶ → 中身を確かめて一覧で見せる → 問題が無ければ「取り込む」で全件を1つのトランザクションで登録
 * 形式は仕訳日記帳の CSV 書き出しと同じ（lib/journalImport.ts）
 */
import { useState } from "react";
import { FileUp, Upload } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { decodeText } from "../../lib/evidence";
import { importJournalCsv, type ImportResult } from "../../lib/journalImport";
import { shortDate, yen } from "../../lib/format";
import * as repo from "../../db/repo";

/** 画面に出す件数（全件は取り込む） */
const PREVIEW_ENTRIES = 100;
const PREVIEW_ISSUES = 200;

export const JournalImportModal = ({ onClose }: { onClose: () => void }) => {
  const { db, accounts, subAccounts, counterparties, isDateClosed, labelOf, bump, strict } = useAppContext();
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    setResult(null);
    setFileName("");
    if (!f) return;
    const text = decodeText(new Uint8Array(await f.arrayBuffer()));
    setFileName(f.name);
    setResult(importJournalCsv(text, { accounts, subs: subAccounts, counterparties, isDateClosed }));
  };

  const run = async () => {
    if (!result || result.issues.length > 0 || result.entries.length === 0) return;
    setBusy(true);
    try {
      await repo.importEntries(db, result.entries, fileName);
      bump();
      toast(`仕訳を ${result.entries.length.toLocaleString()} 件取り込みました`);
      onClose();
    } catch (e) {
      toast(`取り込めませんでした（1件も登録していません）：${String(e).replace(/^Error: /, "")}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const entries = result?.entries ?? [];
  const issues = result?.issues ?? [];
  const dates = entries.map((e) => e.date).sort();
  const total = entries.reduce((t, e) => t + e.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0), 0);

  return (
    <Modal title="仕訳の CSV 取り込み" onClose={onClose} width={860}>
      <div className="settings-form">
        <p className="prose">
          仕訳日記帳の「CSV 書き出し」と同じ形式のファイルを取り込みます（列は見出しの名前で探すので、順番は問いません）。
          同じ伝票No の行は1つの仕訳になり、伝票No が無ければ1行で1つの仕訳です。科目・補助科目・取引先は名前で探します。
          登録日時は取り込んだ日時になるので、取引日から入力期間を過ぎた仕訳は「遅れて登録」と表示されます。
          {strict && "取り込んだ仕訳の履歴には「CSV 取り込み」とファイル名が残ります。"}
        </p>
        <label className="field">
          <span>CSV ファイル（UTF-8 または Shift_JIS）</span>
          <input className="input file-input" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          {fileName && <span className="field-note"><FileUp size={13} /> {fileName}</span>}
        </label>

        {result && issues.length > 0 && (
          <div className="import-issues" role="alert">
            <p className="notice">
              {issues.length.toLocaleString()} か所に問題があるため、取り込めません。CSV を直してから、もう一度選んでください。
            </p>
            <div className="table-wrap scroll-y import-scroll">
              <table className="ledger">
                <colgroup><col style={{ width: 80 }} /><col /></colgroup>
                <thead><tr><th className="num">行</th><th>内容</th></tr></thead>
                <tbody>
                  {issues.slice(0, PREVIEW_ISSUES).map((x, i) => (
                    <tr key={i}><td className="num">{x.row}</td><td>{x.message}</td></tr>
                  ))}
                </tbody>
              </table>
              {issues.length > PREVIEW_ISSUES && <p className="muted small">ほか {(issues.length - PREVIEW_ISSUES).toLocaleString()} か所</p>}
            </div>
          </div>
        )}

        {result && issues.length === 0 && (
          <>
            <p className="import-summary">
              {entries.length === 0 ? "取り込む仕訳がありません。" : (
                <>
                  <b>{entries.length.toLocaleString()}</b> 件の仕訳（{dates[0].replace(/-/g, "/")}〜{dates[dates.length - 1].replace(/-/g, "/")}、借方合計 {yen(total)} 円）
                </>
              )}
              {result.skipped > 0 && <span className="muted">　削除済みの {result.skipped} 行は飛ばします</span>}
            </p>
            {entries.length > 0 && (
              <div className="table-wrap scroll-y import-scroll">
                <table className="ledger">
                  <colgroup>
                    <col style={{ width: 60 }} /><col style={{ width: 64 }} /><col style={{ width: "22%" }} /><col style={{ width: "22%" }} /><col style={{ width: 100 }} /><col />
                  </colgroup>
                  <thead><tr><th className="num">行</th><th>日付</th><th className="dr">借方</th><th className="cr">貸方</th><th className="num">金額</th><th>摘要</th></tr></thead>
                  <tbody>
                    {entries.slice(0, PREVIEW_ENTRIES).flatMap((e, i) =>
                      e.lines.map((l, j) => (
                        <tr key={`${i}-${j}`} className={j === 0 ? "entry-first" : ""}>
                          <td className="num muted">{j === 0 ? e.csvRows[0] : ""}</td>
                          <td>{j === 0 ? shortDate(e.date) : ""}</td>
                          <td>{l.side === "debit" ? labelOf(l.account_id, l.sub_account_id) : ""}</td>
                          <td>{l.side === "credit" ? labelOf(l.account_id, l.sub_account_id) : ""}</td>
                          <td className="num">{yen(l.amount)}</td>
                          <td className="memo">
                            {l.memo}
                            {j === 0 && e.counterpartyId && <span className="cp-tag">{counterparties.find((c) => c.id === e.counterpartyId)?.name}</span>}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
                {entries.length > PREVIEW_ENTRIES && <p className="muted small">ほか {(entries.length - PREVIEW_ENTRIES).toLocaleString()} 件</p>}
              </div>
            )}
          </>
        )}

        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="button" className="btn primary" onClick={run} disabled={busy || !result || issues.length > 0 || entries.length === 0}>
            <Upload size={16} /> {entries.length > 0 ? `${entries.length.toLocaleString()} 件を取り込む` : "取り込む"}
          </button>
        </div>
      </div>
    </Modal>
  );
};
