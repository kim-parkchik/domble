/**
 * 消費税の中間申告（消費税の画面のタブ。計算は lib/taxInterim.ts）
 *  - 前年の確定消費税額（⑨）を前年の帳簿から計算する。帳簿に無い年・修正申告で変わった年は手で入れる
 *  - その年の中間申告の回数・対象期間・期限・額を出し、合計を申告書の「中間納付税額」に入れられる
 *  - 期ごとに仮決算の申告書（その期の帳簿だけで計算）を出し、「仮決算で申告した」で額を保存する。保存した期は、前年の実績の代わりにその額を合計に入れる
 *  - 仮決算の申告書を e-Tax のデータ（申告の種類 2:中間）で書き出す（作るのは lib/taxXtx.ts）
 */
import { useEffect, useMemo, useState } from "react";
import { FileDown, Save, Undo2, Wand2 } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext, useBaseSales, useInterim, useYearData, type InterimInfo } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { MyNumberDialog } from "../../components/MyNumberDialog";
import { longDate, todayIso, yen } from "../../lib/format";
import { INTERIM_KIND_LABEL, INTERIM_NONE_LIMIT, provisionalMethods, provisionalReturn, type InterimKind, type InterimRow } from "../../lib/taxInterim";
import { METHOD_LABEL, type ReturnMethod } from "../../lib/taxReturn";
import { buildTaxXtx, interimXtxProblem, XTX_NEW_FORMS_YEAR, xtxProblem } from "../../lib/taxXtx";
import { filerFromSettings, filerProblems } from "../../lib/etax";
import { TAX_STATUS_OPTIONS } from "../../constants/tax";
import { FormTable } from "./TaxFormTable";
import * as repo from "../../db/repo";

const WEEKDAY = "日月火水木金土";
const dateWithDay = (iso: string) => `${longDate(iso)}（${WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]}）`;
const monthSpan = (from: string, to: string) => {
  const [a, b] = [Number(from.slice(5, 7)), Number(to.slice(5, 7))];
  return a === b ? `${a}月分` : `${a}〜${b}月分`;
};

/** 中間申告の額（前年の実績・仮決算）の合計を、申告書の「中間納付税額」に入れる */
export const InterimFillButton = ({ info }: { info: InterimInfo }) => {
  const { db, year, isClosed, can, bump } = useAppContext();
  const toast = useToast();
  const { rows, total, entered } = info;
  if (rows.length === 0) return null;
  const same = entered.national === total.national && entered.local === total.local;
  const fill = async () => {
    try {
      await repo.saveTaxInterim(db, year, total.national, total.local);
      bump();
      toast("中間納付税額に、中間申告の額（前年の実績・仮決算）の合計を入れました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  return (
    <button type="button" className="btn ghost" onClick={fill} disabled={!can("settings") || isClosed || same} title={same ? "入っている額と同じです" : undefined}>
      <Wand2 size={16} /> 判定した額を入れる
    </button>
  );
};

/** 期限を過ぎて仮決算で申告できないときの、みなされる申告 */
const lateText = (kind: InterimKind, row: InterimRow) =>
  kind === "voluntary"
    ? "任意の中間申告は、期限までに出さなかったときは中間納付をしません（届出をやめたものとみなされます）。"
    : `期限までに出さなかったときは、前年の実績の額（${yen(row.national + row.local)}円）で申告したものとみなされます。`;

/** 1つの期の仮決算（その期の帳簿だけで計算した申告書と、申告した額の保存・e-Tax のデータ） */
const ProvisionalSection = ({ row, kind }: { row: InterimRow; kind: InterimKind }) => {
  const { db, year, settings, taxYear, taxYears, isClosed, can, bump } = useAppContext();
  const { rawLines: lines } = useYearData(); // 消費税は入れたとおりの明細（税込）から
  const baseSales = useBaseSales();
  const toast = useToast();
  const status = taxYear.status as ReturnMethod;
  const methods = provisionalMethods(status);
  const saved = row.provisional;
  const [method, setMethod] = useState(saved?.method ?? methods[0]);
  const [filedOn, setFiledOn] = useState(saved?.filed_on ?? todayIso());
  useEffect(() => {
    setMethod(saved?.method ?? methods[0]);
    setFiledOn(saved?.filed_on ?? todayIso());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.from, saved?.method, saved?.filed_on]);
  const calc = useMemo(
    () => provisionalReturn({
      period: row, lines, taxYears, method, options: { businessClass: taxYear.business_class, baseSales: baseSales?.base ?? null, deduction: taxYear.deduction },
    }),
    [row, lines, taxYears, method, taxYear.business_class, taxYear.deduction, baseSales],
  );
  const admin = can("settings") && !isClosed;
  const prevTotal = row.national + row.local;
  const calcTotal = calc.national + calc.local;
  const unchanged = !!saved && saved.method === method && saved.national === calc.national && saved.local === calc.local && saved.filed_on === filedOn;
  const late = filedOn > row.payBy;

  const store = async () => {
    try {
      await repo.saveInterimProvisional(db, year, { from: row.from, to: row.to, method, national: calc.national, local: calc.local, filed_on: filedOn });
      bump();
      toast(`${monthSpan(row.from, row.to)}の中間申告を、仮決算の額で保存しました`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const remove = async () => {
    try {
      await repo.deleteInterimProvisional(db, year, row.from);
      bump();
      toast(`${monthSpan(row.from, row.to)}の中間申告を、前年の実績に戻しました`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  // e-Tax のデータ（申告の種類 2:中間）。個人番号は書き出すときに入れてもらう（保存しない）
  const filer = filerFromSettings(settings);
  const missing = filerProblems(filer);
  const blocked = xtxProblem(calc.r, year) ?? interimXtxProblem(calc.r) ?? (missing.length ? `事業者設定の e-Tax の欄：${missing.join("、")}` : null);
  const [askNumber, setAskNumber] = useState(false);
  const exportXtx = async (myNumber: string) => {
    setAskNumber(false);
    try {
      const xml = buildTaxXtx(calc.r, { ...filer, myNumber }, {
        from: taxYear.taxable_from || `${year}-01-01`, to: `${year}-12-31`, createdOn: todayIso(), interim: { from: row.from, to: row.to },
      });
      const path = await saveDialog({
        defaultPath: `消費税中間申告_${year}年分_${monthSpan(row.from, row.to)}_仮決算.xtx`,
        filters: [{ name: "e-Tax のデータ", extensions: ["xtx"] }],
      });
      if (!path) return;
      await writeTextFile(path, xml);
      toast("e-Tax のデータを書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };

  return (
    <section className="tax-provisional">
      {askNumber && (
        <MyNumberDialog
          persons={[{ key: "self", label: settings.owner_name || "本人", required: false }]}
          note="入れないと、個人番号の欄が空の申告書になります。"
          onSubmit={(n) => exportXtx(n.self)} onClose={() => setAskNumber(false)}
        />
      )}
      <h3 className="sheet-sub">仮決算（{row.no}回目・{monthSpan(row.from, row.to)}）</h3>
      <p className="field-note">
        {longDate(row.from)}から{longDate(row.to)}までを1つの課税期間として、この期間の帳簿だけで計算します（課税売上割合や簡易課税の事業区分の割合も、この期間の数字）。
        申告・納付の期限は{dateWithDay(row.payBy)}です。
      </p>
      {methods.length > 1 && (
        <>
          <label className="field tax-provisional-method">
            <span>仮決算の方式</span>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} disabled={!admin}>
              <option value="standard">本則課税</option>
              <option value="simplified">簡易課税（簡易課税制度選択届出書を出しているとき）</option>
            </select>
          </label>
          <p className="field-note">
            {METHOD_LABEL[status]}は確定申告で使う特例として扱い、仮決算は本則課税（簡易課税の届出があれば簡易課税）で計算します。
            中間申告で納めすぎた分は、確定申告で差し引かれます（引ききれなければ還付）。
          </p>
        </>
      )}
      <table className="ledger tax-provisional-compare">
        <thead>
          <tr><th /><th className="num">消費税</th><th className="num">地方消費税</th><th className="num">合計</th></tr>
        </thead>
        <tbody>
          <tr><td>前年の実績</td><td className="num">{yen(row.national)}</td><td className="num">{yen(row.local)}</td><td className="num">{yen(prevTotal)}</td></tr>
          <tr>
            <td>仮決算（今の帳簿で計算）</td>
            <td className="num">{yen(calc.national)}</td><td className="num">{yen(calc.local)}</td><td className="num"><b>{yen(calcTotal)}</b></td>
          </tr>
          {saved && (
            <tr>
              <td>仮決算で申告した額（{longDate(saved.filed_on)}に申告・保存）</td>
              <td className="num">{yen(saved.national)}</td><td className="num">{yen(saved.local)}</td><td className="num">{yen(saved.national + saved.local)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="field-note">
        {calcTotal === prevTotal ? "仮決算と前年の実績は同じ額です。"
          : `仮決算のほうが ${yen(Math.abs(calcTotal - prevTotal))}円${calcTotal < prevTotal ? "少なく" : "多く"}なります。`}
        {saved && (saved.national !== calc.national || saved.local !== calc.local) && " 申告したあとに帳簿を直したため、保存した額と今の帳簿の計算が違います。中間納付税額は、申告して保存した額です。"}
      </p>
      {calc.shortfall && <p className="warn-box">仮決算の税額がマイナス（控除不足）です。中間申告では還付を受けられないので、中間納付税額は 0円です。</p>}
      {late && <p className="warn-box">申告した日が期限（{dateWithDay(row.payBy)}）を過ぎています。期限を過ぎてから仮決算の中間申告書は出せません。{lateText(kind, row)}</p>}
      {(year >= XTX_NEW_FORMS_YEAR || !!calc.base.reduced1?.lines) && (
        <p className="warn-box">
          <span>
            {year >= XTX_NEW_FORMS_YEAR && "令和9年4月1日から令和11年3月31日まで、飲食料品の税率の引下げに合わせて中間申告の計算の特例が設けられます。ここの数字は今の様式（6.24%・7.8% だけ）の形です。"}
            {!!calc.base.reduced1?.lines && <b> 1%（軽減）の明細 {calc.base.reduced1.lines} 件（税込 {yen(calc.base.reduced1.amount)}円）は、まだこの数字に入っていません。</b>}
          </span>
        </p>
      )}
      <div className="field-row tax-provisional-actions">
        <label className="field">
          <span>申告した日</span>
          <input className="input" type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} disabled={!admin} />
        </label>
        <button type="button" className="btn primary" onClick={store} disabled={!admin || !filedOn || unchanged}>
          <Save size={16} /> 仮決算で申告した（この額を保存）
        </button>
        {saved && <button type="button" className="btn ghost" onClick={remove} disabled={!admin}><Undo2 size={16} /> 前年の実績に戻す</button>}
        <button type="button" className="btn ghost" onClick={() => setAskNumber(true)} disabled={!!blocked} title={blocked ?? undefined}>
          <FileDown size={16} /> e-Tax 用のデータを書き出す
        </button>
      </div>
      {blocked && <p className="field-note">e-Tax 用のデータ：{blocked}。</p>}
      {calc.r.notes.length > 0 && <ul className="tax-return-notes">{calc.r.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {calc.r.forms.map((f) => <FormTable key={f.id} form={f} />)}
      <p className="field-note">
        仮決算の中間申告書には、この期間の売上げ（資産の譲渡等の対価の額）と課税仕入れ等の税額の明細を添付します（e-Tax 用のデータには付表を入れます）。
        保存した額は、前年の実績の代わりに中間納付税額の合計に入ります。
      </p>
    </section>
  );
};

export const TaxInterimView = ({ onOpenReturn }: { onOpenReturn: () => void }) => {
  const { db, year, isClosed, can, bump } = useAppContext();
  const info = useInterim();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [openFrom, setOpenFrom] = useState<string | null>(null);
  const manualKey = info?.prev.source === "manual" ? String(info.prev.amount) : "";
  useEffect(() => setDraft(manualKey), [manualKey]);
  useEffect(() => setOpenFrom(null), [year]);
  if (!info) return <p className="empty-note">読み込み中…</p>;
  const { prev, plan, entered, rows, total, stray } = info;
  const admin = can("settings") && !isClosed;
  const py = year - 1;
  const open = rows.find((r) => r.from === openFrom) ?? null;

  const save = async (amount: number | null) => {
    try {
      await repo.saveTaxPrevManual(db, year, amount);
      bump();
      toast(amount === null ? "帳簿から計算するようにしました" : "前年の確定消費税額を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  const sourceText = prev.source === "books" ? `帳簿から計算（${py}年の${TAX_STATUS_OPTIONS.find((o) => o.value === prev.method)?.label.replace(/^課税事業者（(.+)）$/, "$1") ?? ""}で）`
    : prev.source === "manual" ? "手で入力"
      : prev.source === "exempt" ? `${py}年は免税事業者` : "";

  return (
    <div className="tax-interim-view">
      <h3 className="sheet-sub">中間申告の判定（{year}年）</h3>
      <dl className="kv">
        <dt>前年（{py}年）の確定消費税額（第一表の ⑨ 差引税額）</dt>
        <dd className="num">{prev.amount === null ? "分かりません" : `${yen(prev.amount)}円（${sourceText}）`}</dd>
        {prev.source === "manual" && prev.fromBooks !== null && (
          <><dt className="muted">　帳簿から計算した額</dt><dd className="num muted">{yen(prev.fromBooks)}円</dd></>
        )}
        <dt>{year}年の中間申告</dt>
        <dd><b>{INTERIM_KIND_LABEL[plan.kind]}</b></dd>
      </dl>

      {plan.kind === "unknown" && (
        <p className="notice">{py}年の帳簿が domble に無いため判定できません。{py}年分の確定申告書の ⑨ 差引税額を、下で入れてください。</p>
      )}
      {plan.kind === "none" && (
        <p className="field-note">
          前年の確定消費税額が{INTERIM_NONE_LIMIT / 10_000}万円以下のため、中間申告は要りません。
          届出をすれば年1回の中間申告（任意の中間申告）ができます。届出をしたときは、事業者設定の「消費税」で印を付けてください。
        </p>
      )}
      {stray.length > 0 && (
        <p className="warn-box">
          保存した仮決算の中間申告（{stray.map((f) => monthSpan(f.from, f.to)).join("・")}）が、今の中間申告の期と合いません。前年の確定消費税額が変わって回数が変わったときは、確かめてください（合計には入れていません）。
        </p>
      )}

      {rows.length > 0 && (
        <>
          <table className="ledger tax-interim-table">
            <colgroup>
              <col style={{ width: 36 }} /><col style={{ width: 100 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 100 }} /><col style={{ width: 108 }} /><col style={{ width: 76 }} />
            </colgroup>
            <thead>
              <tr><th>回</th><th>対象期間</th><th>申告・納付の期限</th><th className="num">消費税</th><th className="num">地方消費税</th><th className="num">合計</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.no} className={p.from === openFrom ? "on" : undefined}>
                  <td className="num">{p.no}</td>
                  <td>
                    {monthSpan(p.from, p.to)}
                    <br /><span className={p.provisional ? "badge badge-create" : "muted"} title={p.provisional ? `${METHOD_LABEL[p.provisional.method]}で計算` : undefined}>
                      {p.provisional ? "仮決算" : "前年の実績"}
                    </span>
                  </td>
                  <td>
                    {dateWithDay(p.payBy)}
                    {p.payBy !== p.due && <span className="muted">（{longDate(p.due)}が休みの日のため）</span>}
                  </td>
                  <td className="num">{yen(p.payNational)}</td>
                  <td className="num">{yen(p.payLocal)}</td>
                  <td className="num">{yen(p.payNational + p.payLocal)}</td>
                  <td>
                    <button type="button" className="btn ghost sm" onClick={() => setOpenFrom(p.from === openFrom ? null : p.from)} aria-expanded={p.from === openFrom}>
                      {p.from === openFrom ? "閉じる" : "仮決算"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>合計（確定申告の ⑩ 中間納付税額・㉑ 中間納付譲渡割額）</td>
                <td className="num"><b>{yen(total.national)}</b></td>
                <td className="num"><b>{yen(total.local)}</b></td>
                <td className="num"><b>{yen(total.national + total.local)}</b></td>
                <td />
              </tr>
            </tfoot>
          </table>
          <div className="field-row tax-interim-fill">
            <p className="field-note">
              申告書に入れてある中間納付税額：消費税 {yen(entered.national)}円・地方消費税 {yen(entered.local)}円
            </p>
            <InterimFillButton info={info} />
            <button type="button" className="btn ghost" onClick={onOpenReturn}>申告書を開く</button>
          </div>
          <p className="field-note">
            前年の実績の1回の額は、前年の確定消費税額 × {plan.kind === "three" ? "3" : plan.kind === "monthly" ? "1" : "6"}/12（百円未満切り捨て）、地方消費税はその 22/78（百円未満切り捨て）です。
            期限が土日・祝日・年末年始（12月29日〜1月3日）にあたるときは、次の日が期限です。
            {plan.kind === "voluntary"
              ? "任意の中間申告書を期限までに出さなかったときは、届出をやめたものとみなされます（中間納付はしません）。"
              : "中間申告書を期限までに出さなくても、前年の実績の額で申告したものとみなされます。"}
            期ごとに、その期の帳簿で計算した仮決算の額で申告することもできます（「仮決算」で申告書を出し、申告したら額を保存します）。
          </p>
          {open && <ProvisionalSection row={open} kind={plan.kind} />}
        </>
      )}

      <h3 className="sheet-sub">前年の確定消費税額を手で入れる</h3>
      <p className="field-note">
        {py}年の帳簿が domble に無いとき、または修正申告・更正で税額が変わったときは、{py}年分の確定申告書（第一表）の ⑨ 差引税額を入れてください。入れた額が帳簿の計算より優先します。
      </p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); save(draft === "" ? null : Number(draft)); }}>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>前年（{py}年）の確定消費税額</span>
          <input className="input num" inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))} placeholder="空なら帳簿から計算" disabled={!admin} />
        </label>
        <div style={{ alignSelf: "flex-end", display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={!admin || draft === manualKey}><Save size={16} /> 保存する</button>
          {prev.source === "manual" && <button type="button" className="btn ghost" onClick={() => save(null)} disabled={!admin}>帳簿から計算に戻す</button>}
        </div>
      </form>
    </div>
  );
};
