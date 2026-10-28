/**
 * 消費税の申告書の数字（「消費税」の画面の「申告書」タブ。計算は lib/taxReturn.ts）
 *  - 方式の比較：その年に使える方式（本則・簡易・2割特例・3割特例）の納付税額を並べる
 *  - 選んだ方式の付表・第二表・第一表を、欄の番号つきで出す（確定申告書等作成コーナーや e-Tax に書き写す）
 *  - 中間納付税額は年度ごとに入れる（前年の実績で計算した中間申告の額を「判定した額を入れる」で入れられる）
 *  - 選んだ方式の申告書を e-Tax のデータ（.xtx）で書き出す（作るのは lib/taxXtx.ts。申告者の情報は事業者設定から）
 */
import { useEffect, useMemo, useState } from "react";
import { FileDown, Printer, Save } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext, useBaseSales, useInterim, useYearData } from "../../context/AppContext";
import { InterimFillButton } from "./TaxInterimView";
import { methodProblem } from "../../lib/baseSales";
import { useToast } from "../../components/Toast";
import { todayIso, yen } from "../../lib/format";
import { filerFromSettings, filerProblems } from "../../lib/etax";
import { buildTaxXtx, xtxProblem, xtxVersionFor } from "../../lib/taxXtx";
import { buildTaxBase, computeReturn, methodsFor, METHOD_LABEL, thirtyReturn, twentyReturn, type ReturnMethod, type TaxForm } from "../../lib/taxReturn";
import * as repo from "../../db/repo";
import { MyNumberDialog } from "../../components/MyNumberDialog";

/** 方式ごとの、使うための主な条件 */
const METHOD_NOTE: Record<ReturnMethod, string> = {
  standard: "帳簿とインボイスなどの請求書の保存が要ります",
  simplified: "簡易課税制度選択届出書が要ります（基準期間の課税売上高が5,000万円以下）",
  twenty: "登録によって課税事業者になった方（基準期間の課税売上高が1,000万円以下など）。届出は不要",
  thirty: "登録によって課税事業者になった個人事業者（基準期間の課税売上高が1,000万円以下など）。届出は不要",
};

const signed = (n: number) => (n < 0 ? `△${yen(-n)}` : yen(n));

export const TaxReturnView = () => {
  const { db, year, settings, taxYears, taxYear, isClosed, can, dataVersion, bump } = useAppContext();
  const { lines } = useYearData();
  const toast = useToast();
  const available = methodsFor(year);
  const current = (taxYear.status === "exempt" ? null : taxYear.status) as ReturnMethod | null;
  const [method, setMethod] = useState<ReturnMethod>(current && available.includes(current) ? current : "standard");
  useEffect(() => {
    if (current && available.includes(current)) setMethod(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, year]);
  const [firstKind, setFirstKind] = useState<"一般用" | "簡易課税用">("一般用");

  // 中間納付税額
  const [interim, setInterim] = useState({ national: 0, local: 0 });
  const [draft, setDraft] = useState({ national: "", local: "" });
  const interimInfo = useInterim();
  useEffect(() => {
    repo.getTaxInterim(db, year).then((x) => {
      setInterim(x);
      setDraft({ national: String(x.national), local: String(x.local) });
    }).catch(console.error);
  }, [db, year, dataVersion]);
  const saveInterim = async () => {
    try {
      await repo.saveTaxInterim(db, year, Number(draft.national || 0), Number(draft.local || 0));
      bump();
      toast("中間納付税額を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  // 簡易課税の事業区分は、明細に記録した区分（登録したときに 明細 → 科目の初期値 → 主な事業区分 で決まる。無ければ不明）
  const base = useMemo(() => buildTaxBase(lines, taxYears), [lines, taxYears]);
  const baseSales = useBaseSales();
  const options = {
    businessClass: taxYear.business_class, interimNational: interim.national, interimLocal: interim.local, baseSales: baseSales?.base ?? null, deduction: taxYear.deduction,
  };
  const results = useMemo(
    () => available.map((m) => ({ m, r: computeReturn(m, base, options), problem: baseSales ? methodProblem(m, baseSales) : null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, interim, taxYear.business_class, taxYear.deduction, year, baseSales],
  );
  // 2割・3割特例の第一表は、簡易課税の届出があれば簡易課税用、無ければ一般用
  const shown = method === "twenty" ? twentyReturn(base, options, firstKind)
    : method === "thirty" ? thirtyReturn(base, options, firstKind)
      : results.find((x) => x.m === method)?.r ?? computeReturn(method, base, options);
  const forms = shown.forms;
  // 使えない方式は比べない
  const usable = results.filter((x) => !x.problem);
  const best = Math.min(...usable.map((x) => x.r.total));
  // どれも同じ額なら「いちばん有利」は出さない
  const showBest = new Set(usable.map((x) => x.r.total)).size > 1;
  const admin = can("settings");

  // e-Tax のデータ（.xtx）
  const filer = filerFromSettings(settings);
  const xtxBlocked = xtxProblem(shown, year);
  const missing = filerProblems(filer);
  // 個人番号は書き出すときに入れてもらう（保存しない）。公金受取口座で還付を受けるときは必須
  const [askNumber, setAskNumber] = useState(false);
  const publicRefund = shown.total < 0 && filer.refund?.kind === "public";
  const exportXtx = async (myNumber: string) => {
    setAskNumber(false);
    try {
      const xml = buildTaxXtx(shown, { ...filer, myNumber }, { from: taxYear.taxable_from || `${year}-01-01`, to: `${year}-12-31`, createdOn: todayIso() });
      const path = await save({
        defaultPath: `消費税申告_${year}年分_${METHOD_LABEL[method]}.xtx`,
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
    <div className="tax-return">
      {askNumber && (
        <MyNumberDialog
          persons={[{ key: "self", label: settings.owner_name || "本人", required: publicRefund }]}
          note={publicRefund ? "公金受取口座で還付を受けるので、個人番号が要ります。" : "入れないと、個人番号の欄が空の申告書になります。"}
          onSubmit={(n) => exportXtx(n.self)} onClose={() => setAskNumber(false)}
        />
      )}
      <div className="tax-return-head print-skip">
        <h3 className="sheet-sub">方式の比較（{year}年）</h3>
        <table className="ledger tax-compare">
          <colgroup>
            <col style={{ width: "20%" }} /><col style={{ width: "13%" }} /><col style={{ width: "13%" }} /><col style={{ width: "16%" }} /><col />
          </colgroup>
          <thead>
            <tr><th>方式</th><th className="num">消費税</th><th className="num">地方消費税</th><th className="num">合計（納付・△還付）</th><th>使うための主な条件</th></tr>
          </thead>
          <tbody>
            {results.map(({ m, r, problem }) => (
              <tr key={m} className={`clickable${m === method ? " on" : ""}${problem ? " unusable" : ""}`} onClick={() => setMethod(m)}>
                <td>
                  {METHOD_LABEL[m]}
                  {m === current && <span className="badge badge-adjust">この年の設定</span>}
                  {!problem && showBest && r.total === best && <span className="tax-best">いちばん有利</span>}
                </td>
                <td className="num">{signed(r.national)}</td>
                <td className="num">{signed(r.local)}</td>
                <td className="num"><b>{signed(r.total)}</b></td>
                <td className="muted">
                  {problem && <span className="tax-unusable">{problem}。</span>}
                  {METHOD_NOTE[m]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-note">
          簡易課税は、売上の明細に記録した事業区分ごとに計算しています（区分の分からない売上は、その年の売上に出てくる区分のうち、みなし仕入率がいちばん低い区分）。
          基準期間（{year - 2}年）の課税売上高：
          {baseSales === null ? "読み込み中" : baseSales.base === null ? "分かりません（事業者設定の「消費税」で入れられます）" : `${yen(baseSales.base)}円（${baseSales.source === "manual" ? "手で入力" : "帳簿から計算"}）`}。
          税込経理・割戻し計算で、中間納付税額を差し引いた額です。課税区分は事業者設定の「消費税」で決めます（ここで選んだ方式は表示だけです）。
        </p>

        <form className="field-row tax-interim" onSubmit={(e) => { e.preventDefault(); saveInterim(); }}>
          <label className="field">
            <span>中間納付税額（消費税）</span>
            <input className="input num" inputMode="numeric" value={draft.national} onChange={(e) => setDraft((d) => ({ ...d, national: e.target.value.replace(/[^\d]/g, "") }))} disabled={!admin || isClosed} />
          </label>
          <label className="field">
            <span>中間納付譲渡割額（地方消費税）</span>
            <input className="input num" inputMode="numeric" value={draft.local} onChange={(e) => setDraft((d) => ({ ...d, local: e.target.value.replace(/[^\d]/g, "") }))} disabled={!admin || isClosed} />
          </label>
          <div style={{ alignSelf: "flex-end", display: "flex", gap: 8 }}>
            <button className="btn ghost" type="submit" disabled={!admin || isClosed || (String(interim.national) === draft.national && String(interim.local) === draft.local)}>
              <Save size={15} /> 保存する
            </button>
            {interimInfo && <InterimFillButton info={interimInfo} />}
          </div>
          <p className="field-note">
            納付した額ではなく、中間申告書に書いた「納付すべき税額」の合計です。
            {interimInfo && interimInfo.plan.periods.length > 0 && `前年の実績で計算した額は、消費税 ${yen(interimInfo.plan.national)}円・地方消費税 ${yen(interimInfo.plan.local)}円です（「中間申告」で回数と期限を見られます）。`}
          </p>
        </form>
      </div>

      <div className="tax-return-forms print-area">
        <div className="tax-return-title">
          <h3>{year}年分 消費税及び地方消費税の申告書の数字（{METHOD_LABEL[method]}）</h3>
          {(method === "twenty" || method === "thirty") && (
            <select className="input sm print-skip" value={firstKind} onChange={(e) => setFirstKind(e.target.value as typeof firstKind)} aria-label="第一表の種類" style={{ width: "auto" }}>
              <option value="一般用">第一表は一般用（簡易課税の届出なし）</option>
              <option value="簡易課税用">第一表は簡易課税用（簡易課税の届出あり）</option>
            </select>
          )}
          <button className="btn ghost sm print-skip" onClick={() => window.print()}><Printer size={14} /> 印刷</button>
          <button className="btn primary sm print-skip" onClick={() => setAskNumber(true)} disabled={!!xtxBlocked || missing.length > 0}>
            <FileDown size={14} /> e-Tax 用に書き出す
          </button>
        </div>
        <div className="tax-xtx print-skip">
          {xtxBlocked ? (
            <span>{xtxBlocked}。</span>
          ) : missing.length > 0 ? (
            <span>e-Tax 用に書き出すには、事業者設定で次のものを入れてください：{missing.join("、")}。</span>
          ) : (
            <span>
              e-Tax 用のデータ（.xtx）は、e-Taxソフト（WEB版）の「作成済みデータの利用」で読み込み、内容を確かめて送信します。個人番号は書き出すときに入れます。
              {shown.total < 0 && (filer.refund ? "還付になるので、事業者設定の還付先も書きます。" : "還付になりますが、事業者設定に還付先が入っていません。")}
              {current && method !== current && <b> この年の設定（{METHOD_LABEL[current]}）とは違う方式です。</b>}
              {xtxVersionFor(year).fallback && (
                <b> 令和{year - 2018}年分の e-Tax の版はまだ domble に入っていないため、いちばん新しい版（{xtxVersionFor(year).version}）で書き出します。e-Tax で読み込めないときは、ソフトの更新を待ってください。</b>
              )}
            </span>
          )}
        </div>
        {shown.deduction && (
          <div className="tax-xtx print-skip">
            控除する課税仕入れ等の税額：個別対応方式 <b>{yen(shown.deduction.amounts.individual)}円</b>・一括比例配分方式 <b>{yen(shown.deduction.amounts.lump)}円</b>
            {shown.deduction.amounts.individual !== shown.deduction.amounts.lump && (
              <>（{shown.deduction.amounts.individual > shown.deduction.amounts.lump ? "個別対応方式" : "一括比例配分方式"}が有利）</>
            )}。
            今は{shown.deduction.method === "individual" ? "個別対応方式" : "一括比例配分方式"}で計算しています（事業者設定の「消費税」の控除の方式。一括比例配分方式は2年続けて使う決まり）。
          </div>
        )}
        {shown.notes.length > 0 && (
          <ul className="tax-return-notes">{shown.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        )}
        {forms.map((f) => <FormTable key={f.id} form={f} />)}
        <p className="field-note">
          確定申告書等作成コーナーや e-Tax に書き写すときの数字です。e-Tax 用のデータに書き出すこともできます（送信は e-Tax で行います）。
          申告の前に、集計表と「確認」の内容を確かめてください。
        </p>
      </div>
    </div>
  );
};

const FormTable = ({ form }: { form: TaxForm }) => (
  <section className="tax-form-block">
    <h4>{form.title}</h4>
    <table className="ledger tax-form-table">
      <colgroup>
        <col style={{ width: 52 }} />
        <col />
        {form.abc && <><col style={{ width: 130 }} /><col style={{ width: 130 }} /></>}
        <col style={{ width: 140 }} />
        <col style={{ width: "22%" }} />
      </colgroup>
      <thead>
        <tr>
          <th>欄</th><th>項目</th>
          {form.abc && <><th className="num">6.24% 適用分 A</th><th className="num">7.8% 適用分 B</th></>}
          <th className="num">{form.abc ? "合計 C" : "金額"}</th><th>備考</th>
        </tr>
      </thead>
      <tbody>
        {form.rows.map((r, i) => (
          <tr key={`${r.no}-${i}`}>
            <td className="tax-form-no">{r.no}</td>
            <td>{r.label}</td>
            {form.abc && <><td className="num">{r.a === undefined ? "" : yen(r.a)}</td><td className="num">{r.b === undefined ? "" : yen(r.b)}</td></>}
            <td className="num"><b>{r.c === null ? "" : signed(r.c)}</b></td>
            <td className="muted">{r.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);
