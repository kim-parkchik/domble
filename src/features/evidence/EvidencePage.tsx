/**
 * 証憑の一覧
 * 取引年月日・取引金額（範囲指定）と取引先を組み合わせて検索できる（電子取引データの検索要件）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FilePlus2, FolderDown, Search, ShieldCheck } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { FullDateInput } from "../../components/Inputs";
import { EvidenceAddModal, EvidenceModal } from "./EvidenceModals";
import { EntryEditModal } from "../entry/EntryEditModal";
import { evidenceCsv, exportAll } from "./evidenceIO";
import { EVIDENCE_DOC_TYPES } from "../../constants/evidence";
import { filterEvidences } from "../../lib/evidence";
import { yearEnd, yearStart } from "../../lib/accounting";
import { parseAmount, yen } from "../../lib/format";
import type { Evidence } from "../../lib/types";
import * as repo from "../../db/repo";
import { DOC_CLASS_LABEL, scanStatusOf, type DocClass, type ScanInputMethod } from "../../lib/scan";

export const EvidencePage = () => {
  const { db, year, settings, dataVersion, counterparties, daysOff } = useAppContext();
  const toast = useToast();
  const [all, setAll] = useState<Evidence[]>([]);
  const [dateFrom, setDateFrom] = useState(yearStart(year));
  const [dateTo, setDateTo] = useState(yearEnd(year));
  const [minAmt, setMinAmt] = useState("");
  const [maxAmt, setMaxAmt] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [docType, setDocType] = useState("");
  const [kind, setKind] = useState("");
  const [scanMethod, setScanMethod] = useState<ScanInputMethod>("early");
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [adding, setAdding] = useState(false);
  /** 画面にドラッグ＆ドロップしたファイル（取り込みの画面に入れて開く） */
  const [droppedFile, setDroppedFile] = useState<File | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  // 子の要素に出入りするたびに dragenter / dragleave が来るので、数えて 0 になったら外れたとみなす
  const dragDepth = useRef(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const [openEntry, setOpenEntry] = useState<number | null>(null);
  const [check, setCheck] = useState<repo.EvidenceCheckResult[] | null>(null);
  /** 本当に削除した証憑の記録（通常モード） */
  const [deletions, setDeletions] = useState<repo.EvidenceDeletion[]>([]);

  useEffect(() => {
    repo.getEvidences(db).then(setAll).catch(console.error);
    repo.getEvidenceDeletions(db).then(setDeletions).catch(console.error);
    repo.getScanInputMethod(db).then(setScanMethod).catch(console.error);
  }, [db, dataVersion]);

  // 年度を切り替えたら、日付の範囲もその年度にする
  useEffect(() => {
    setDateFrom(yearStart(year));
    setDateTo(yearEnd(year));
  }, [year]);

  const list = useMemo(
    () => filterEvidences(all, {
      dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
      amountMin: parseAmount(minAmt), amountMax: parseAmount(maxAmt),
      counterparty, docType, unlinkedOnly, includeVoid, kind,
    }),
    [all, dateFrom, dateTo, minAmt, maxAmt, counterparty, docType, unlinkedOnly, includeVoid, kind],
  );
  const total = list.filter((e) => !e.is_void).reduce((t, e) => t + e.amount, 0);

  const exportCsv = async () => {
    const path = await save({ defaultPath: `証憑一覧_${settings.business_name || "帳簿"}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, evidenceCsv(list, counterparties, scanMethod, daysOff));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const exportFiles = async () => {
    try {
      const n = await exportAll(db, list, counterparties, scanMethod, daysOff);
      if (n !== null) toast(`${n}件のファイルと一覧（CSV）を書き出しました`);
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const verify = async () => {
    try {
      setCheck(await repo.verifyEvidences(db));
    } catch (e) {
      toast(`確認できませんでした：${String(e)}`, "error");
    }
  };

  return (
    <div
      className={`page page-drop${dragging ? " dragging" : ""}`}
      onDragEnter={(e) => {
        if (adding || !e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (adding || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (adding) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        setDroppedFile(f);
        setAdding(true);
      }}
    >
      {dragging && <div className="drop-overlay">ここに離すと、このファイルを証憑として取り込みます</div>}
      <PageHeader
        title="証憑"
        note="受け取った請求書・領収書などのファイルを保存し、仕訳とひも付けます。取引年月日・金額・取引先を組み合わせて検索できます。ファイルをこの画面にドラッグ＆ドロップしても取り込めます。電子取引データは、訂正・削除の防止に関する事務処理規程を定めて保存します（ひな形は電子帳簿保存法の画面）。"
      >
        <button className="btn ghost" onClick={verify} disabled={all.length === 0}><ShieldCheck size={16} /> 改ざんの確認</button>
        <button className="btn ghost" onClick={exportCsv} disabled={list.length === 0}><Download size={16} /> CSV</button>
        <button className="btn ghost" onClick={exportFiles} disabled={list.length === 0}><FolderDown size={16} /> ファイルを書き出す</button>
        <button className="btn primary" onClick={() => setAdding(true)}><FilePlus2 size={16} /> 取り込む</button>
      </PageHeader>

      <div className="filters">
        <span className="filter-label">取引年月日</span>
        <FullDateInput value={dateFrom} onChange={setDateFrom} year={year} aria-label="取引年月日（から）" />
        <span>〜</span>
        <FullDateInput value={dateTo} onChange={setDateTo} year={year} aria-label="取引年月日（まで）" />
        <span className="filter-label">金額</span>
        <input className="input amount-filter" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} placeholder="下限" inputMode="numeric" aria-label="金額の下限" />
        <span>〜</span>
        <input className="input amount-filter" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="上限" inputMode="numeric" aria-label="金額の上限" />
        <label className="search">
          <Search size={15} />
          <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="取引先" aria-label="取引先" />
        </label>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="区分">
          <option value="">電子取引とスキャナ保存</option>
          <option value="electronic">電子取引だけ</option>
          <option value="scan">スキャナ保存だけ</option>
        </select>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="書類の種類">
          <option value="">すべての書類</option>
          {EVIDENCE_DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} /> 仕訳にひも付いていないもの</label>
        <label className="check"><input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} /> 無効も表示</label>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {list.length === 0 ? (
            <p className="empty-note">{all.length === 0 ? "まだ証憑がありません。「取り込む」から追加してください。" : "条件に合う証憑がありません。"}</p>
          ) : (
            <table className="ledger">
              <colgroup>
                <col style={{ width: 48 }} /><col style={{ width: 112 }} /><col style={{ width: 112 }} /><col style={{ width: 64 }} /><col />
                <col style={{ width: 110 }} /><col style={{ width: "18%" }} /><col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr><th>No</th><th>取引年月日</th><th>受領日</th><th>書類</th><th>取引先</th><th className="num">取引金額</th><th>ファイル</th><th>伝票No</th></tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className={`clickable${e.is_void ? " deleted" : ""}`} onClick={() => setViewing(e.id)} title="クリックで表示">
                    <td>{e.id}</td>
                    <td>{e.txn_date.replace(/-/g, "/")}</td>
                    <td className="muted">{e.received_date ? e.received_date.replace(/-/g, "/") : ""}</td>
                    <td>{e.doc_type}</td>
                    <td>
                      {e.is_void ? <span className="badge badge-delete">無効</span> : null}
                      {(() => {
                        const st = scanStatusOf(e, scanMethod, daysOff);
                        if (!st) return null;
                        return (
                          <>
                            <span className="badge badge-scan" title={`スキャナ保存（${DOC_CLASS_LABEL[e.doc_class as DocClass] ?? ""}）。タイムスタンプが無いので、紙の原本も保存してください`}>スキャナ</span>
                            {st.late && <span className="badge badge-delete" title={`入力期限 ${st.deadline}（参考。PC の時計で判定）を過ぎて取り込みました`}>入力期間外</span>}
                            {st.needsLink && !e.is_void && <span className="badge badge-update" title="重要書類は仕訳とのひも付けが必要です（帳簿との相互関連性）">要ひも付け</span>}
                          </>
                        );
                      })()}
                      {e.counterparty}
                    </td>
                    <td className="num">{yen(e.amount)}</td>
                    <td className="muted ellipsis" title={e.file_name}>{e.file_name}</td>
                    <td>{e.entry_ids.length ? e.entry_ids.join("・") : <span className="muted">未</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="dock-foot">
          <span />
          <span className="dock-totals">{list.length}件　合計 <b>{yen(total)}</b></span>
        </div>
      </section>

      {deletions.length > 0 && (
        <section className="sheet">
          <details className="asset-others">
            <summary>削除した証憑（{deletions.length}件：ファイルと履歴は残っていません）</summary>
            <table className="ledger">
              <thead>
                <tr><th>削除した日時</th><th className="num">No.</th><th>書類</th><th>取引年月日</th><th className="num">取引金額</th><th>取引先</th><th>ファイル</th><th>理由</th><th>操作した人</th></tr>
              </thead>
              <tbody>
                {deletions.map((d) => (
                  <tr key={d.id}>
                    <td>{d.deleted_at}</td>
                    <td className="num">{d.evidence_id}</td>
                    <td>{d.doc_type}{d.is_void ? "（無効）" : ""}</td>
                    <td>{d.txn_date.replace(/-/g, "/")}</td>
                    <td className="num">{yen(d.amount)}</td>
                    <td>{d.counterparty}</td>
                    <td title={`SHA-256 ${d.sha256}`}>{d.file_name}</td>
                    <td>{d.reason}</td>
                    <td>{d.user_name ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      {adding && (
        <EvidenceAddModal
          initialFile={droppedFile}
          onClose={() => {
            setAdding(false);
            setDroppedFile(undefined);
          }}
          onAdded={() => {}}
        />
      )}
      {viewing !== null && <EvidenceModal evidenceId={viewing} onClose={() => setViewing(null)} onOpenEntry={setOpenEntry} />}
      {openEntry !== null && <EntryEditModal entryId={openEntry} onClose={() => setOpenEntry(null)} />}
      {check && (
        <Modal title="改ざんの確認" onClose={() => setCheck(null)} width={640}>
          <p className="prose">
            保存しているファイルの中身からハッシュ（SHA-256）を計算し、登録したときの記録と、書き換えられない登録時の履歴（あるもの）の両方と照らし合わせました。
          </p>
          {check.every((c) => c.status === "ok") ? (
            <p className="balance-banner ok">{check.length}件すべて、登録したときのまま変わっていません。</p>
          ) : (
            <>
              <p className="balance-banner ng">{check.filter((c) => c.status !== "ok").length}件で、登録したときの記録と一致しませんでした。</p>
              <ul className="check-list">
                {check.filter((c) => c.status !== "ok").map((c) => <li key={c.id}>No.{c.id}：{c.detail}</li>)}
              </ul>
            </>
          )}
        </Modal>
      )}
    </div>
  );
};
