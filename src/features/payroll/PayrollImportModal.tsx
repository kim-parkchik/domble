/**
 * 給与の CSV の取り込み（給与の画面）
 * 給与計算ソフトで計算した給与・賞与（1行 = 1人の1回の支給）を読み、1行を1つの仕訳にする（lib/payroll.ts）。
 *  - 列は見出しの名前で探す（ほかの給与ソフトの CSV は「列の対応」で選び直せる）
 *  - 氏名は取引先として持つ（無い人は取引先に足す）。給与の設定の専従者は専従者給与
 *  - 同じ人・同じ支給日・同じ総支給額の給与が帳簿にあるものは「重複かも」とし、初めは取り込まない
 *  - 締めた月の支給日の行は取り込めない。1つのトランザクションなので、途中で失敗したら1件も登録しない
 */
import { useState } from "react";
import { FileUp, Upload } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { yen } from "../../lib/format";
import { decodeText } from "../../lib/evidence";
import { yearEnd, yearStart, type FlatLine } from "../../lib/accounting";
import {
  counterpartyOfName, PAY_KIND_LABEL, PAYROLL_COLUMN_LABELS, PAYROLL_COLUMNS, PAYROLL_REQUIRED, parsePayrollCsv, payrollDuplicate, payrollEntryLines,
  salaryAccountIdsOf, sameName, type PayrollCol, type PayrollColumnMap, type PayrollParse, type PayrollSettings,
} from "../../lib/payroll";
import { SALARY_CODES } from "./useWithholding";
import * as repo from "../../db/repo";

export const PayrollImportModal = ({ settings, onClose, onSettings }: { settings: PayrollSettings; onClose: () => void; onSettings: () => void }) => {
  const { db, accounts, counterparties, isDateClosed, bump, strict, reloadCounterparties } = useAppContext();
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<PayrollParse | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [existing, setExisting] = useState<FlatLine[]>([]);
  /** 重複かもの行のうち、取り込むことにしたもの（行番号） */
  const [keepDup, setKeepDup] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = async (t: string, map?: PayrollColumnMap) => {
    const r = parsePayrollCsv(t, map);
    const years = r.rows.map((x) => Number(x.date.slice(0, 4)));
    setExisting(years.length ? await repo.getLines(db, yearStart(Math.min(...years)), yearEnd(Math.max(...years))) : []);
    setKeepDup(new Set());
    setResult(r);
    if (PAYROLL_REQUIRED.some((k) => !(r.map[k] >= 0))) setShowMap(true);
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
  const remap = (k: PayrollCol, v: number) => result && load(text, { ...result.map, [k]: v });

  const salaryIds = salaryAccountIdsOf(accounts, SALARY_CODES);
  const rows = result?.rows ?? [];
  const isFamily = (name: string) => settings.family.some((f) => sameName(f, name));
  const dups = new Set(rows.filter((r) => payrollDuplicate(r, counterpartyOfName(counterparties, r.name)?.id ?? null, existing, salaryIds, settings.commute)).map((r) => r.row));
  const closedRows = rows.filter((r) => isDateClosed(r.date));
  // 給与の設定が足りない（科目が決まっていない）とき
  const settingProblem = rows.map((r) => payrollEntryLines(r, settings, 1)).find((x): x is string => typeof x === "string") ?? null;
  const chosen = rows.filter((r) => !dups.has(r.row) || keepDup.has(r.row));
  const newNames = [...new Set(chosen.filter((r) => !counterpartyOfName(counterparties, r.name)).map((r) => r.name))];
  const issues = [...(result?.issues ?? []), ...closedRows.map((r) => ({ row: r.row, message: `支給日 ${r.date.replace(/-/g, "/")} は締めた月です` }))];
  const total = chosen.reduce((t, r) => t + r.gross, 0);

  const run = async () => {
    if (!chosen.length || issues.length || settingProblem) return;
    setBusy(true);
    try {
      await repo.importPayroll(db, chosen, fileName);
      if (newNames.length) await reloadCounterparties(); // 足した取引先の名前を出すため
      bump();
      toast(`給与 ${chosen.length} 件を仕訳にしました${newNames.length ? `（取引先に ${newNames.join("・")} を足しました）` : ""}`);
      onClose();
    } catch (e) {
      toast(`取り込めませんでした（1件も登録していません）：${String(e).replace(/^Error: /, "")}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="給与の CSV の取り込み" onClose={onClose} width={980}>
      <div className="settings-form">
        <p className="prose">
          給与計算ソフトで計算した給与・賞与を、1行 = 1人の1回の支給の CSV で取り込み、1行を1つの仕訳にします（給料賃金 ／ 預り金・普通預金）。
          列は見出しの名前で探します。ほかの給与ソフトの CSV は「列の対応」で選び直せます。氏名は取引先として持ち、無い人は取引先に足します。
          {strict && "取り込んだ仕訳の履歴には「給与の取り込み」とファイル名が残ります。"}
        </p>
        <label className="field">
          <span>CSV ファイル（UTF-8 または Shift_JIS）</span>
          <input className="input file-input" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          {fileName && <span className="field-note"><FileUp size={13} /> {fileName}</span>}
        </label>

        {result && result.header.length > 0 && (
          <div className="import-map">
            <button type="button" className="link-btn" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap}>
              {showMap ? "▾" : "▸"} 列の対応（ほかの給与ソフトの CSV のとき）
            </button>
            {showMap && (
              <div className="import-map-grid">
                {(Object.keys(PAYROLL_COLUMNS) as PayrollCol[]).map((k) => (
                  <label key={k} className="field">
                    <span>{PAYROLL_COLUMN_LABELS[k]}{PAYROLL_REQUIRED.includes(k) ? "（必須）" : ""}</span>
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

        {settingProblem && (
          <p className="warn-box">
            {settingProblem}。
            <button type="button" className="link-btn" onClick={onSettings}>給与の設定を開く</button>
          </p>
        )}

        {issues.length > 0 && (
          <div className="import-issues" role="alert">
            <p className="notice">{issues.length} か所に問題があるため、取り込めません。CSV を直してから、もう一度選んでください。</p>
            <ul className="import-issue-list">
              {issues.slice(0, 50).map((x, i) => <li key={i}>{x.row}行目：{x.message}</li>)}
            </ul>
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="table-wrap scroll-y import-scroll">
              <table className="ledger payroll-preview">
                <thead>
                  <tr>
                    <th aria-label="取り込む" /><th>支給日</th><th>区分</th><th>氏名</th><th className="num">総支給額</th><th className="num">通勤手当</th>
                    <th className="num">社会保険料</th><th className="num">所得税</th><th className="num">住民税</th><th className="num">その他</th><th className="num">差引支給額</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const dup = dups.has(r.row);
                    const on = !dup || keepDup.has(r.row);
                    return (
                      <tr key={r.row} className={on ? undefined : "muted"}>
                        <td>
                          <input
                            type="checkbox" checked={on} disabled={!dup} aria-label={`${r.row}行目を取り込む`}
                            title={dup ? "同じ人・同じ支給日・同じ総支給額の給与が帳簿にあります" : undefined}
                            onChange={(e) => setKeepDup((s) => { const n = new Set(s); if (e.target.checked) n.add(r.row); else n.delete(r.row); return n; })}
                          />
                        </td>
                        <td>{r.date.replace(/-/g, "/")}</td>
                        <td>{PAY_KIND_LABEL[r.kind]}</td>
                        <td>
                          {r.name}
                          {!counterpartyOfName(counterparties, r.name) && <span className="badge">新しい取引先</span>}
                          {isFamily(r.name) && <span className="badge">専従者</span>}
                          {dup && <span className="badge badge-late">重複かも</span>}
                        </td>
                        <td className="num">{yen(r.gross)}</td>
                        <td className="num">{yen(r.commute, { blankZero: true })}</td>
                        <td className="num">{yen(r.social, { blankZero: true })}</td>
                        <td className="num">{yen(r.tax, { blankZero: true })}</td>
                        <td className="num">{yen(r.resident, { blankZero: true })}</td>
                        <td className="num">{yen(r.other, { blankZero: true })}</td>
                        <td className="num">{yen(r.net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="field-note">
              {chosen.length} 件・総支給額 {yen(total)}円を仕訳にします
              {dups.size > 0 && `（重複かもの ${dups.size - [...keepDup].filter((x) => dups.has(x)).length} 件は取り込みません。取り込むときはチェックを入れます）`}。
              {newNames.length > 0 && `取引先に ${newNames.join("・")} を足します。`}
            </p>
          </>
        )}

        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="button" className="btn primary" onClick={run} disabled={busy || !chosen.length || issues.length > 0 || !!settingProblem}>
            <Upload size={16} /> {chosen.length} 件を仕訳にする
          </button>
        </div>
      </div>
    </Modal>
  );
};
