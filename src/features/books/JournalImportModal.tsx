/**
 * 仕訳の CSV 取り込み
 * ファイルを選ぶ → 中身を確かめて一覧で見せる → 問題が無ければ「取り込む」で全件を1つのトランザクションで登録
 * 形式は仕訳日記帳の CSV 書き出しと同じ（lib/journalImport.ts）。ほかの会計ソフトの CSV は、列の対応を選び直せる
 * 帳簿にある仕訳と同じもの・ファイルの中で重なるものは「重複かも」として、初めは取り込まない側にする（選び直せる）
 * 家事按分（入力のたびに分ける科目）は、仕訳の年度の割合で事業分と事業主貸に分けて取り込む（分けないこともできる）
 */
import { useState } from "react";
import { FileUp, Upload } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { decodeText } from "../../lib/evidence";
import {
  COLUMN_LABELS, COLUMNS, findDuplicates, importJournalCsv, REQUIRED_COLUMNS, type ImportResult, type JournalCol, type JournalColumnMap,
} from "../../lib/journalImport";
import { shortDate, yen } from "../../lib/format";
import * as repo from "../../db/repo";
import { entryRateOf, splitLinesByHomeUse } from "../../lib/homeUse";
import { CODE } from "../../constants/accounts";
import type { HomeUseRate } from "../../lib/types";
import type { FlatLine } from "../../lib/accounting";

/** 画面に出す件数（全件は取り込む） */
const PREVIEW_ENTRIES = 100;
const PREVIEW_ISSUES = 200;

export const JournalImportModal = ({ onClose }: { onClose: () => void }) => {
  const { db, accounts, subAccounts, counterparties, isDateClosed, labelOf, bump, strict } = useAppContext();
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** 仕訳の年度ごとの家事按分の設定 */
  const [rates, setRates] = useState<Map<number, HomeUseRate[]>>(new Map());
  const [noSplit, setNoSplit] = useState(false);
  const [text, setText] = useState("");
  /** 帳簿にある、取り込む期間の仕訳（重複の確かめに使う） */
  const [existing, setExisting] = useState<FlatLine[]>([]);
  /** 重複かもの仕訳のうち、取り込むことにしたもの（番号） */
  const [keepDup, setKeepDup] = useState<Set<number>>(new Set());
  const [showMap, setShowMap] = useState(false);

  const load = async (t: string, map?: JournalColumnMap) => {
    const r = importJournalCsv(t, { accounts, subs: subAccounts, counterparties, isDateClosed }, map);
    const years = [...new Set(r.entries.map((e) => Number(e.date.slice(0, 4))))];
    setRates(new Map(await Promise.all(years.map(async (y) => [y, await repo.getHomeUseRates(db, y)] as const))));
    const ds = r.entries.map((e) => e.date).sort();
    setExisting(ds.length ? await repo.getLines(db, ds[0], ds[ds.length - 1]) : []);
    setKeepDup(new Set());
    setResult(r);
    // 必須の列が見つからなければ、列の対応を開いておく
    if (REQUIRED_COLUMNS.some((k) => !(r.map[k] >= 0))) setShowMap(true);
  };

  const pick = async (f: File | undefined) => {
    setResult(null);
    setFileName("");
    if (!f) return;
    const t = decodeText(new Uint8Array(await f.arrayBuffer()));
    setFileName(f.name);
    setText(t);
    setShowMap(false);
    await load(t);
  };
  const remap = (k: JournalCol, v: number) => result && load(text, { ...result.map, [k]: v });

  const run = async () => {
    if (!result || result.issues.length > 0 || result.entries.length === 0) return;
    setBusy(true);
    try {
      await repo.importEntries(db, entries, fileName);
      bump();
      toast(`仕訳を ${entries.length.toLocaleString()} 件取り込みました${dups.size - keepDup.size > 0 ? `（重複かもの ${(dups.size - keepDup.size).toLocaleString()} 件は取り込んでいません）` : ""}`);
      onClose();
    } catch (e) {
      toast(`取り込めませんでした（1件も登録していません）：${String(e).replace(/^Error: /, "")}`, "error");
    } finally {
      setBusy(false);
    }
  };

  // 家事按分：仕訳ごとに、その年度の割合で分ける
  const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)?.id;
  const split = (result?.entries ?? []).map((e) =>
    drawId ? splitLinesByHomeUse(e.lines, entryRateOf(rates.get(Number(e.date.slice(0, 4))) ?? [], accounts), drawId) : { lines: e.lines, splits: [] },
  );
  const splitCount = split.filter((x) => x.splits.length > 0).length;
  const all = (result?.entries ?? []).map((e, i) => (noSplit ? e : { ...e, lines: split[i].lines }));
  // 重複かも（帳簿にある仕訳・ファイルの中の重なり）。初めは取り込まない
  const dups = findDuplicates(result?.entries ?? [], existing, (i) => split[i].lines);
  const entries = all.filter((_, i) => !dups.has(i) || keepDup.has(i));
  const issues = result?.issues ?? [];
  const dates = entries.map((e) => e.date).sort();
  const total = entries.reduce((t, e) => t + e.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0), 0);

  return (
    <Modal title="仕訳の CSV 取り込み" onClose={onClose} width={860}>
      <div className="settings-form">
        <p className="prose">
          仕訳日記帳の「CSV 書き出し」と同じ形式のファイルを取り込みます（列は見出しの名前で探すので、順番は問いません）。
          ほかの会計ソフトの CSV は「列の対応」で列を選び直せます。日付は和暦（R8.1.5・令和8年1月5日）も読めます。
          同じ伝票No の行は1つの仕訳になり、伝票No が無ければ1行で1つの仕訳です。科目・補助科目・取引先は名前で探します。
          登録日時は取り込んだ日時になるので、取引日から入力期間を過ぎた仕訳は「遅れて登録」と表示されます。
          {strict && "取り込んだ仕訳の履歴には「CSV 取り込み」とファイル名が残ります。"}
        </p>
        <label className="field">
          <span>CSV ファイル（UTF-8 または Shift_JIS）</span>
          <input className="input file-input" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          {fileName && <span className="field-note"><FileUp size={13} /> {fileName}</span>}
        </label>

        {result && result.header.length > 0 && (
          <div className="import-map">
            <button type="button" className="link-btn" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
              {showMap ? "▾" : "▸"} 列の対応（ほかの会計ソフトの CSV のとき）
            </button>
            {showMap && (
              <div className="import-map-grid">
                {(Object.keys(COLUMNS) as JournalCol[]).filter((k) => k !== "state").map((k) => (
                  <label key={k} className="field">
                    <span>{COLUMN_LABELS[k]}{REQUIRED_COLUMNS.includes(k) ? "（必須）" : ""}</span>
                    <select className="input" value={result.map[k]} onChange={(e) => remap(k, Number(e.target.value))}>
                      <option value={-1}>（使わない）</option>
                      {result.header.map((h, i) => <option key={i} value={i}>{h || `${i + 1}列目`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

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
            {splitCount > 0 && (
              <div className="homeuse-split" role="status">
                <span className={noSplit ? "muted" : "homeuse-hint"}>
                  家事按分：{splitCount.toLocaleString()} 件の仕訳に「入力のたびに分ける」科目があります。
                  {noSplit ? "分けずに、CSV のとおり取り込みます。" : "事業分と事業主貸に分けて取り込みます（下の一覧は分けたあとの形）。"}
                </span>
                <span className="muted small">借方に事業主貸がすでにある仕訳は、分け済みとみなしてそのまま取り込みます。</span>
                <label className="check">
                  <input type="checkbox" checked={noSplit} onChange={(e) => setNoSplit(e.target.checked)} />
                  按分しない（CSV のとおりに取り込む）
                </label>
              </div>
            )}
            {dups.size > 0 && (
              <div className="import-dups" role="status">
                <p className="notice">
                  重複かもの仕訳が <b>{dups.size.toLocaleString()}</b> 件あります（帳簿にある仕訳か、ファイルの中の前の仕訳と、日付・科目・金額が同じ）。
                  初めは取り込みません。取り込むものにチェックを入れてください。
                </p>
                <div className="table-wrap scroll-y import-scroll">
                  <table className="ledger">
                    <colgroup><col style={{ width: 70 }} /><col style={{ width: 60 }} /><col style={{ width: 64 }} /><col /><col style={{ width: 100 }} /><col style={{ width: "34%" }} /></colgroup>
                    <thead><tr><th>取り込む</th><th className="num">行</th><th>日付</th><th>仕訳</th><th className="num">金額</th><th>わけ</th></tr></thead>
                    <tbody>
                      {[...dups.entries()].slice(0, PREVIEW_ENTRIES).map(([i, why]) => {
                        const e = all[i];
                        const dr = e.lines.filter((l) => l.side === "debit");
                        const cr = e.lines.filter((l) => l.side === "credit");
                        return (
                          <tr key={i}>
                            <td>
                              <input type="checkbox" checked={keepDup.has(i)} aria-label={`${e.csvRows[0]}行目を取り込む`}
                                onChange={(ev) => setKeepDup((s) => { const n = new Set(s); if (ev.target.checked) n.add(i); else n.delete(i); return n; })} />
                            </td>
                            <td className="num muted">{e.csvRows[0]}</td>
                            <td>{shortDate(e.date)}</td>
                            <td>{dr.map((l) => labelOf(l.account_id, l.sub_account_id)).join("・")} ／ {cr.map((l) => labelOf(l.account_id, l.sub_account_id)).join("・")}</td>
                            <td className="num">{yen(dr.reduce((s, l) => s + l.amount, 0))}</td>
                            <td className="muted">{why}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {dups.size > PREVIEW_ENTRIES && <p className="muted small">ほか {(dups.size - PREVIEW_ENTRIES).toLocaleString()} 件（取り込みません）</p>}
                </div>
              </div>
            )}
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
