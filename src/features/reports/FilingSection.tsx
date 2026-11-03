/**
 * 申告の控えと、修正申告・更正の請求（所得税の「申告の控え・修正」タブ、消費税の「申告書」タブの下。計算は lib/amendment.ts）
 *  - 「申告した」で控え（申告した日・種類・申告書の主な数字）を残す。数字は今の帳簿の計算を初めに入れ、出した申告書の控えに合わせて直せる
 *  - 控えがあれば、いちばん新しい控え（修正前）と今の帳簿の数字を並べ、税額が増えれば修正申告、減れば更正の請求と知らせる
 *  - 修正申告：修正の欄に書く額と、e-Tax のデータを修正申告で書き出すかのチェック（法定申告期限を過ぎていれば初めから付ける）
 *  - 更正の請求：申告した額・正しい額と、請求できる期限（法定申告期限から5年）。延滞税・加算税は計算せず知らせるだけ
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileCheck2, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { longDate, todayIso, yen } from "../../lib/format";
import {
  amendmentOf, AMEND_STEPS, amendNotes, claimDeadline, claimNotes, compareFilings, FILING_KIND_LABEL, FILING_TAX_LABEL, filingDeadline, latestFiling,
  withinDeadlineNote, type Amendment, type FilingKind, type FilingLine, type FilingTax, type TaxFiling,
} from "../../lib/amendment";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const signed = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n));

export interface FilingState {
  /** この年の、この税の控え（申告した日の古い順） */
  filings: TaxFiling[];
  /** 修正前（いちばん新しい控え） */
  latest: TaxFiling | null;
  /** 修正前と今の帳簿を比べた判定（控えが無いか、今の数字が出せなければ null） */
  amendment: Amendment | null;
  /** 法定申告期限・更正の請求の期限（祝日を読むまでは null） */
  due: string | null;
  claimDue: string | null;
  /** e-Tax のデータを修正申告で書き出すか */
  amendExport: boolean;
  setAmendExport: (on: boolean) => void;
  reload: () => void;
}

/** 控えを読み、今の帳簿の数字（current）と比べる */
export const useFilings = (tax: FilingTax, current: FilingLine[] | null): FilingState => {
  const { db, year, dataVersion } = useAppContext();
  const [all, setAll] = useState<TaxFiling[]>([]);
  const [holidays, setHolidays] = useState<ReadonlySet<string> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([repo.getFilings(db, year), repo.getHolidayData(db)])
      .then(([f, h]) => {
        if (!alive) return;
        setAll(f);
        setHolidays(new Set(h.holidays.map((x) => x.date)));
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion, tick]);
  const filings = useMemo(() => all.filter((f) => f.tax === tax), [all, tax]);
  const latest = latestFiling(filings, tax, year);
  const amendment = useMemo(() => (latest && current ? amendmentOf(tax, latest.lines, current) : null), [latest, current, tax]);
  const due = holidays ? filingDeadline(tax, year, holidays) : null;
  const claimDue = holidays ? claimDeadline(tax, year, holidays) : null;
  // 修正申告で書き出すか：法定申告期限を過ぎていれば初めから付ける（期限までなら確定申告の出し直しが先）
  const [choice, setChoice] = useState<boolean | null>(null);
  useEffect(() => setChoice(null), [year, tax]);
  const amendExport = amendment?.status === "amend" && (choice ?? (due !== null && todayIso() > due));
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { filings, latest, amendment, due, claimDue, amendExport, setAmendExport: setChoice, reload };
};

export const FilingSection = ({ tax, current, state }: { tax: FilingTax; current: FilingLine[] | null; state: FilingState }) => {
  const { db, year, can } = useAppContext();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { filings, latest, amendment: a, due, claimDue } = state;
  const admin = can("settings");
  const diffs = latest && current ? compareFilings(latest.lines, current) : [];
  const within = due !== null && todayIso() <= due;

  const remove = async (f: TaxFiling) => {
    if (!(await ask(`${f.filed_on} の${FILING_KIND_LABEL[f.kind]}の控えを削除します。`, { title: "申告の控えの削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    try {
      await repo.deleteFiling(db, f.id);
      state.reload();
      toast("申告の控えを削除しました");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  return (
    <div className="filing print-skip">
      <h3 className="sheet-sub">申告の控え・修正申告（{year}年分の{FILING_TAX_LABEL[tax]}）</h3>
      <p className="field-note">
        申告したら「申告した」で控えを残してください。あとで帳簿を直したとき、控え（修正前）と今の数字を比べて、修正申告・更正の請求の額を出します。
      </p>
      <div className="filing-list">
        {filings.length === 0 ? (
          <p className="muted">まだ控えがありません。</p>
        ) : (
          <table className="ledger filing-table">
            <colgroup><col style={{ width: 170 }} /><col style={{ width: 150 }} /><col style={{ width: 140 }} /><col /><col style={{ width: 80 }} /></colgroup>
            <thead>
              <tr><th>申告した日</th><th>種類</th><th className="num">{tax === "income" ? "第3期分の税額" : "合計税額（㉖）"}</th><th>メモ</th><th /></tr>
            </thead>
            <tbody>
              {filings.map((f) => (
                <tr key={f.id}>
                  <td>{f.filed_on.replace(/-/g, "/")}{f === latest && <span className="badge">修正前</span>}</td>
                  <td>{FILING_KIND_LABEL[f.kind]}</td>
                  <td className="num">{signed(f.lines.find((l) => l.key === (tax === "income" ? "third" : "total"))?.value ?? 0)}</td>
                  <td className="muted">{f.memo}</td>
                  <td className="row-actions">
                    {admin && <button className="link-btn danger" onClick={() => remove(f)}><Trash2 size={14} /> 削除</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="btn ghost sm" onClick={() => setAdding(true)} disabled={!admin || !current}>
          <FileCheck2 size={14} /> 申告した（控えを残す）
        </button>
      </div>

      {latest && !current && <p className="field-note">今の数字を出せません（保存していない変更があれば、保存すると比べられます）。</p>}
      {latest && current && (
        <>
          <h4 className="filing-h">修正前（{latest.filed_on.replace(/-/g, "/")} の{FILING_KIND_LABEL[latest.kind]}）と今の帳簿</h4>
          <table className="ledger filing-compare">
            <colgroup><col style={{ width: 56 }} /><col /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /></colgroup>
            <thead>
              <tr><th>欄</th><th>項目</th><th className="num">修正前</th><th className="num">今の帳簿</th><th className="num">差</th></tr>
            </thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.key} className={d.diff ? "filing-changed" : ""}>
                  <td className="muted">{d.no}</td>
                  <td>{d.label}</td>
                  <td className="num">{d.before === null ? "—" : signed(d.before)}</td>
                  <td className="num">{d.after === null ? "—" : signed(d.after)}</td>
                  <td className="num">{d.diff ? signed(d.diff) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a && <AmendmentBox tax={tax} a={a} due={due} claimDue={claimDue} within={within} state={state} />}
          <details className="filing-steps">
            <summary>申告したあとに帳簿を直すときの手順</summary>
            <ol>{AMEND_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          </details>
        </>
      )}

      {adding && current && <FilingForm tax={tax} current={current} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); state.reload(); }} />}
    </div>
  );
};

/** 判定と、修正の欄・期限・知らせること */
const AmendmentBox = ({ tax, a, due, claimDue, within, state }: {
  tax: FilingTax; a: Amendment; due: string | null; claimDue: string | null; within: boolean; state: FilingState;
}) => {
  if (a.status === "same") return <p className="filing-box">申告した数字と同じです。</p>;
  if (a.status === "other") {
    return <p className="filing-box">税額は変わりません（所得金額などが違います）。税額や純損失の金額が変わらなければ、修正申告・更正の請求は要りません。</p>;
  }
  if (a.status === "claim") {
    return (
      <div className="filing-box claim">
        <p><b>税額が {yen(a.decrease)}円 減ります。</b>更正の請求で、納めすぎた税金を戻してもらえます（期限 {claimDue ? longDate(claimDue) : "—"}）。</p>
        {within && due && <p>{withinDeadlineNote(due)}</p>}
        <ul>{claimDue && claimNotes(claimDue).map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className="filing-box amend">
      <p><b>税額が {yen(a.increase)}円 増えます。</b>修正申告をして納めます。</p>
      {within && due && <p>{withinDeadlineNote(due)}</p>}
      {a.income && (
        <table className="ledger filing-fields">
          <tbody>
            <tr><td>第一表の上の「修正」</td><td className="num">○</td></tr>
            <tr><td>修正申告：修正前の第3期分の税額（還付は △）</td><td className="num">{a.income.before < 0 ? `△${yen(-a.income.before)}` : yen(a.income.before)}</td></tr>
            <tr><td>修正申告：第3期分の税額の増加額</td><td className="num">{yen(a.income.increase)}</td></tr>
          </tbody>
        </table>
      )}
      {a.consumption && (
        <table className="ledger filing-fields">
          <tbody>
            <tr><td>⑬ 既確定税額（修正前の納付税額。還付は −）</td><td className="num">{signed(a.consumption.known)}</td></tr>
            <tr><td>⑭ 差引納付税額</td><td className="num">{yen(a.consumption.pay)}</td></tr>
            <tr><td>㉔ 既確定譲渡割額</td><td className="num">{signed(a.consumption.knownLocal)}</td></tr>
            <tr><td>㉕ 差引納付譲渡割額</td><td className="num">{yen(a.consumption.payLocal)}</td></tr>
            <tr><td>㉖ 消費税及び地方消費税の合計税額（⑭＋㉕）</td><td className="num">{yen(a.consumption.total)}</td></tr>
          </tbody>
        </table>
      )}
      <label className="check">
        <input type="checkbox" checked={state.amendExport} onChange={(e) => state.setAmendExport(e.target.checked)} />
        e-Tax 用のデータを修正申告で書き出す（申告の種類を「修正」にし、上の修正の欄を入れます）
      </label>
      <ul>{due && amendNotes(tax, due).map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
};

/** 「申告した」：申告した日・種類と申告書の数字（今の帳簿の計算を初めに入れる。申告書の控えに合わせて直せる） */
const FilingForm = ({ tax, current, onClose, onSaved }: { tax: FilingTax; current: FilingLine[]; onClose: () => void; onSaved: () => void }) => {
  const { db, year } = useAppContext();
  const toast = useToast();
  const [filedOn, setFiledOn] = useState(todayIso());
  const [kind, setKind] = useState<FilingKind>("original");
  const [values, setValues] = useState<(number | null)[]>(current.map((l) => l.value));
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (values.some((v) => v === null)) return setError("数字をすべて入れてください（0 のときは 0）");
    try {
      await repo.addFiling(db, { fiscal_year: year, tax, kind, filed_on: filedOn, lines: current.map((l, i) => ({ ...l, value: values[i]! })), memo });
      toast("申告の控えを残しました");
      onSaved();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Modal title={`申告した（${year}年分の${FILING_TAX_LABEL[tax]}）`} onClose={onClose} width={600}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field-row">
          <label className="field">
            <span>申告した日</span>
            <FullDateInput value={filedOn} onChange={setFiledOn} year={year + 1} aria-label="申告した日" />
          </label>
          <label className="field">
            <span>種類</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FilingKind)}>
              {(Object.keys(FILING_KIND_LABEL) as FilingKind[]).map((k) => <option key={k} value={k}>{FILING_KIND_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        <p className="field-note">
          今の帳簿で計算した数字を入れています。出した申告書（domble の外で作ったものも）と違えば、申告書の控えに合わせて直してください（還付はマイナス）。
          更正は、税務署から届いた更正の通知書の数字です。
        </p>
        <table className="ledger filing-input">
          <tbody>
            {current.map((l, i) => (
              <tr key={l.key}>
                <td className="muted" style={{ width: 60 }}>{l.no}</td>
                <td>{l.label}</td>
                <td style={{ width: 170 }}>
                  <AmountInput value={values[i]} onChange={(v) => setValues((xs) => xs.map((x, j) => (j === i ? v : x)))} aria-label={l.label} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field">
          <span>メモ（任意）</span>
          <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={100} placeholder="例：e-Tax で送信（受付番号）" />
        </label>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit">控えを残す</button>
        </div>
      </form>
    </Modal>
  );
};
