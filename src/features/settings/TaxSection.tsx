/**
 * 消費税の設定（事業者設定の中の節）
 *  - 課税区分・経理方式・簡易課税の事業区分・本則課税の控除の方式・年の途中から課税事業者になった日・任意の中間申告の届出は年度ごと（次の設定がある年まで引き継ぐ）
 *  - 適格請求書発行事業者の登録番号・登録日は帳簿に1つ
 *  - 課税事業者の期間で税区分の入っていない仕訳を、科目の初期値でまとめて埋める
 *  - 基準期間（前々年）・特定期間（前年1〜6月）の課税売上高。帳簿に無い年の基準期間は手で入れる
 */
import { useEffect, useState } from "react";
import { Save, Wand2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useBaseSales } from "../../context/AppContext";
import { yen } from "../../lib/format";
import { EXEMPT_LIMIT, mandatoryReason, SIMPLIFIED_LIMIT } from "../../lib/baseSales";
import { useToast } from "../../components/Toast";
import { BUSINESS_CLASSES, DEDUCTION_METHODS, TAX_METHOD_OPTIONS, TAX_STATUS_OPTIONS } from "../../constants/tax";
import { deductionProblem, statusProblem } from "../../lib/tax";
import type { DeductionMethod, TaxMethod, TaxStatus, TaxYear } from "../../lib/types";
import * as repo from "../../db/repo";

export const TaxSection = () => {
  const { db, year, settings, taxYear, taxYears, reloadTaxYears, reloadSettings, isClosed, strict, can, dataVersion, bump } = useAppContext();
  const toast = useToast();
  const [t, setT] = useState<TaxYear>(taxYear);
  const [error, setError] = useState("");
  const taxKey = JSON.stringify(taxYear);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setT(taxYear), [taxKey]);
  const set = <K extends keyof TaxYear>(k: K, v: TaxYear[K]) => setT((x) => ({ ...x, [k]: v }));
  const changed = t.status !== taxYear.status || t.method !== taxYear.method || t.business_class !== taxYear.business_class
    || t.taxable_from !== taxYear.taxable_from || t.deduction !== taxYear.deduction || !!t.voluntary_interim !== !!taxYear.voluntary_interim;
  const individualProblem = deductionProblem(taxYears, year, "individual");
  const admin = can("settings");
  const regOn = settings.invoice_registered_on;

  const changeStatus = (status: TaxStatus) => {
    // 免税事業者から課税事業者にするとき、その年に登録したなら登録日を「課税事業者になった日」に入れておく
    const fromReg = taxYear.status === "exempt" && status !== "exempt" && !t.taxable_from && regOn.startsWith(`${year}-`) && regOn > `${year}-01-01`;
    setT((x) => ({ ...x, status, taxable_from: status === "exempt" ? "" : fromReg ? regOn : x.taxable_from }));
  };

  const save = async () => {
    try {
      await repo.saveTaxYear(db, { ...t, from_year: year });
      await reloadTaxYears();
      bump();
      setError("");
      toast(`${year}年の消費税の設定を保存しました`);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };

  // 税区分の入っていない仕訳（課税事業者の期間）
  const [untaxed, setUntaxed] = useState<number | null>(null);
  useEffect(() => {
    repo.untaxedEntryIds(db, year).then((r) => setUntaxed(r.length)).catch(console.error);
  }, [db, year, dataVersion, taxKey]);

  const fill = async () => {
    const ok = await ask(
      `${year}年の課税事業者の期間で、税区分が入っていない仕訳 ${untaxed} 件に、科目の初期値で税区分を入れます（課税仕入のインボイス区分は取引先から）。\n` +
        (taxYear.status === "simplified" ? "簡易課税の売上には、事業区分も入れます（科目の初期値、無ければ主な事業区分）。\n" : "") +
        "すでに入っている税区分・事業区分はそのままです。締めた月の仕訳は変えません。" +
        (strict ? "\n1件ずつ訂正として保存し、「訂正・削除履歴」に残ります。" : ""),
      { title: "税区分の一括設定", kind: "info", okLabel: "入れる", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      const r = await repo.fillTaxCodes(db, year);
      bump();
      toast(`${r.updated} 件の仕訳に税区分${taxYear.status === "simplified" ? "・事業区分" : ""}を入れました${r.closed ? `（締めた月の ${r.closed} 件はそのままです）` : ""}`);
    } catch (e) {
      toast(`入れられませんでした：${String(e)}`, "error");
    }
  };

  // 登録番号（帳簿に1つ）
  const [reg, setReg] = useState({ no: settings.invoice_no, on: settings.invoice_registered_on });
  useEffect(() => setReg({ no: settings.invoice_no, on: settings.invoice_registered_on }), [settings.invoice_no, settings.invoice_registered_on]);
  const [regError, setRegError] = useState("");
  const saveReg = async () => {
    try {
      await repo.saveInvoiceRegistration(db, reg.no, reg.on);
      await reloadSettings();
      setRegError("");
      toast("登録番号を保存しました");
    } catch (e) {
      setRegError(String(e).replace(/^Error: /, ""));
    }
  };
  const regChanged = reg.no !== settings.invoice_no || reg.on !== settings.invoice_registered_on;
  // 登録しているのに免税事業者のまま
  const registeredButExempt = !!settings.invoice_no && taxYear.status === "exempt" && (!regOn || regOn <= `${year}-12-31`);

  return (
    <section className="sheet span-all">
      <h2 className="sheet-h">消費税（{year}年）</h2>
      <p className="prose">
        課税区分と経理方式は年度ごとに決めます。決めた設定は、次に設定を変える年まで引き継がれます。
        課税事業者の期間は、帳簿入力・振替伝票の明細ごとに税区分を持ちます（初期値は勘定科目の画面で科目ごとに決められます）。
        課税仕入では、インボイス（適格請求書）があるかどうかも選びます。取引先の画面で「適格請求書発行事業者ではない」にした取引先からの仕入れは、初期値が経過措置（令和8年9月までは80%、10月からは70%控除）になります。
      </p>
      {taxYear.inherited && taxYear.status !== "exempt" && !statusProblem(taxYear.status, year) && (
        <p className="field-note">前の年の設定を引き継いでいます。保存すると {year}年の設定になります。</p>
      )}
      {statusProblem(taxYear.status, year) && (
        <p className="notice">前の年の「{TAX_STATUS_OPTIONS.find((o) => o.value === taxYear.status)?.label}」を引き継いでいますが、{statusProblem(taxYear.status, year)}。{year}年の課税区分を選び直してください。</p>
      )}
      {registeredButExempt && (
        <p className="notice">適格請求書発行事業者の登録番号が入っています。登録日からは課税事業者です。課税区分を選んでください。</p>
      )}
      <form className="settings-form tax-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="field-row">
          <label className="field">
            <span>課税区分</span>
            <select className="input" value={t.status} onChange={(e) => changeStatus(e.target.value as TaxStatus)} disabled={!admin || isClosed}>
              {TAX_STATUS_OPTIONS.map((o) => {
                const p = statusProblem(o.value, year);
                return <option key={o.value} value={o.value} disabled={!!p} title={p ?? undefined}>{o.label}{p ? "（この年は選べません）" : ""}</option>;
              })}
            </select>
          </label>
          <label className="field">
            <span>経理方式</span>
            <select className="input" value={t.method} onChange={(e) => set("method", e.target.value as TaxMethod)} disabled={!admin || isClosed || t.status === "exempt"}>
              {TAX_METHOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={!o.enabled}>{o.label}{o.enabled ? "" : "（準備中）"}</option>
              ))}
            </select>
          </label>
        </div>
        {t.status !== "exempt" && t.method === "exclusive" && (
          <p className="field-note">
            税抜経理：仕訳は今までどおり税込の金額で入れます。明細ごとに消費税額を自動で計算し（税込の金額から割戻し・1円未満切り捨て。振替伝票で直せます）、
            帳簿・決算書では本体（税抜）と仮受消費税等・仮払消費税等に分けて出します。年末に決算整理の画面で、仮受・仮払消費税等を納める消費税と精算します。
            消費税の申告書は今までどおり税込の金額から計算します。この年に取得した固定資産の取得価額は税抜で台帳に入れてください。
          </p>
        )}
        {t.status !== "exempt" && (
          <div className="field-row">
            {t.status === "standard" && (
              <label className="field">
                <span>控除の方式（課税売上割合が95%未満のとき）</span>
                <select className="input" value={t.deduction} onChange={(e) => set("deduction", e.target.value as DeductionMethod)} disabled={!admin || isClosed}>
                  {DEDUCTION_METHODS.map((d) => (
                    <option key={d.value} value={d.value} disabled={d.value === "individual" && !!individualProblem} title={d.value === "individual" ? individualProblem ?? undefined : undefined}>
                      {d.label}{d.value === "individual" && individualProblem ? "（この年は選べません）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {t.status === "simplified" && (
              <label className="field">
                <span>主な事業区分（簡易課税）</span>
                <select className="input" value={t.business_class} onChange={(e) => set("business_class", Number(e.target.value))} disabled={!admin || isClosed}>
                  {BUSINESS_CLASSES.map((b) => <option key={b.value} value={b.value}>{b.label}　みなし仕入率 {b.rate}%</option>)}
                </select>
              </label>
            )}
            <label className="field" style={{ maxWidth: 220 }}>
              <span>課税事業者になった日（年の途中から）</span>
              <input
                className="input" type="date" value={t.taxable_from} min={`${year}-01-01`} max={`${year}-12-31`}
                onChange={(e) => set("taxable_from", e.target.value)} disabled={!admin || isClosed}
              />
            </label>
          </div>
        )}
        {t.status !== "exempt" && (
          <>
            <label className="check">
              <input type="checkbox" checked={!!t.voluntary_interim} onChange={(e) => set("voluntary_interim", e.target.checked ? 1 : 0)} disabled={!admin || isClosed} />
              任意の中間申告書を提出する旨の届出をしている
            </label>
            <p className="field-note">
              前年の確定消費税額が48万円以下で中間申告が要らない人も、届出をすれば年1回（1〜6月分）の中間申告ができます。
              届出をやめるまで次の年に引き継ぎます。期限までに中間申告書を出さなかったときは、届出をやめたものとみなされます。予定は消費税の画面の「中間申告」で見られます。
            </p>
          </>
        )}
        {t.status === "twenty" && year === 2026 && (
          <p className="field-note">
            2割特例は令和8年（2026年）分の申告が最後です。令和9年分からは、本則課税・簡易課税、または要件を満たせば3割特例（個人事業者の令和9年分・令和10年分）から選びます。
            2割特例の翌年から簡易課税にするときは、簡易課税制度選択届出書を出します（翌年分の申告期限まで）。
          </p>
        )}
        {t.status === "simplified" && (
          <p className="field-note">
            2種類以上の事業がある場合は、売上の科目ごと（勘定科目の画面の「事業区分」）や、売上の明細ごと（帳簿入力・振替伝票の税区分の欄）に事業区分を選べます。
            どちらも選んでいない売上は「主な事業区分」になります。業務用の固定資産の売却は第四種です。
          </p>
        )}
        {t.status === "standard" && (
          <p className="field-note">
            課税売上割合が 95% 以上（かつ課税売上高が5億円以下）なら、課税仕入の消費税は全額控除するので、控除の方式は使いません。
            個別対応方式では、課税仕入を課税対応・共通対応・非課税対応に分けます（帳簿入力・振替伝票の税区分の欄で選べます。初期値は勘定科目の画面の「用途区分」、無ければ共通対応）。
            一括比例配分方式にした年から2年は、個別対応方式に戻せません。{individualProblem ? `${individualProblem}。` : ""}
          </p>
        )}
        {t.status === "thirty" && <p className="field-note">3割特例は、登録によって課税事業者になった個人事業者で、基準期間（2年前）の課税売上高が1,000万円以下のときに使えます。</p>}
        {t.method === "inclusive" && t.status !== "exempt" && <p className="field-note">税込経理：帳簿・決算書の金額は税込のままです（納める消費税は租税公課）。税抜で出したいときは経理方式を税抜経理にします。</p>}
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        {isClosed && <p className="field-note">{year}年は締め済みのため変更できません。</p>}
        <div>
          <button className="btn primary" type="submit" disabled={!admin || isClosed || (!changed && !taxYear.inherited)}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>

      <BaseSalesBlock />

      {!!untaxed && (
        <div className="tax-fill" role="status">
          <span>
            {year}年の課税事業者の期間に、税区分{taxYear.status === "simplified" ? "（簡易課税の売上は事業区分）" : taxYear.status === "standard" ? "（課税仕入は用途区分）" : ""}が入っていない仕訳が <b>{untaxed}</b> 件あります
            （課税事業者{taxYear.status === "simplified" ? "・簡易課税" : ""}にする前に入れた仕訳など）。
          </span>
          <button className="btn ghost sm" onClick={fill} disabled={!can("entry")}><Wand2 size={14} /> 科目の初期値で入れる</button>
        </div>
      )}

      <h3 className="sheet-sub">適格請求書発行事業者の登録</h3>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); saveReg(); }}>
        <label className="field">
          <span>登録番号</span>
          <input className="input mono" value={reg.no} onChange={(e) => setReg((x) => ({ ...x, no: e.target.value }))} placeholder="例：T1234567890123" maxLength={20} disabled={!admin} />
        </label>
        <label className="field" style={{ maxWidth: 180 }}>
          <span>登録日</span>
          <input className="input" type="date" value={reg.on} onChange={(e) => setReg((x) => ({ ...x, on: e.target.value }))} disabled={!admin} />
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn primary" type="submit" disabled={!admin || !regChanged}><Save size={16} /> 保存する</button>
        </div>
      </form>
      {regError && <p className="form-error-inline" role="alert">{regError}</p>}
    </section>
  );
};

/** 基準期間・特定期間の課税売上高（帳簿から計算。帳簿に無い年は手で入れる） */
const BaseSalesBlock = () => {
  const { db, year, isClosed, can, bump } = useAppContext();
  const info = useBaseSales();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  useEffect(() => setDraft(info?.source === "manual" && info.base !== null ? String(info.base) : ""), [info?.source, info?.base]);
  if (!info) return null;
  const admin = can("settings") && !isClosed;
  const by = year - 2, py = year - 1;
  const save = async (amount: number | null) => {
    try {
      await repo.saveTaxBaseManual(db, year, amount);
      bump();
      toast(amount === null ? "帳簿から計算するようにしました" : "基準期間の課税売上高を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const mandatory = mandatoryReason(info);
  return (
    <div className="tax-base">
      <h3 className="sheet-sub">基準期間・特定期間の課税売上高</h3>
      <dl className="kv">
        <dt>基準期間（{by}年）の課税売上高</dt>
        <dd className="num">{info.base === null ? "分かりません" : `${yen(info.base)}（${info.source === "manual" ? "手で入力" : "帳簿から計算"}）`}</dd>
        {info.fromBooks && (
          <>
            <dt className="muted">　うち課税事業者の期間（税抜き）</dt><dd className="num muted">{yen(info.fromBooks.taxable)}</dd>
            <dt className="muted">　うち免税事業者の期間（税抜きしない）</dt><dd className="num muted">{yen(info.fromBooks.exemptPeriod)}</dd>
            <dt className="muted">　うち輸出免税</dt><dd className="num muted">{yen(info.fromBooks.exportSales)}</dd>
            {info.source === "manual" && <><dt className="muted">　帳簿から計算した額</dt><dd className="num muted">{yen(info.fromBooks.total)}</dd></>}
          </>
        )}
        {info.specific && (
          <>
            <dt>特定期間（{py}年1〜6月）の課税売上高</dt><dd className="num">{yen(info.specific.sales.total)}</dd>
            <dt className="muted">　同じ期間の給与等支払額</dt><dd className="num muted">{yen(info.specific.salaries)}</dd>
          </>
        )}
      </dl>
      {mandatory ? (
        <p className="notice">{mandatory}。{year}年は、登録と関係なく課税事業者です（免税事業者・2割特例・3割特例にはなれません）。</p>
      ) : info.base !== null && (
        <p className="field-note">
          {info.base <= EXEMPT_LIMIT ? "1,000万円以下です（登録していなければ免税事業者。登録していれば、要件を満たせば2割特例・3割特例が使えます）。" : ""}
          {info.base > SIMPLIFIED_LIMIT ? "5,000万円を超えているため、簡易課税は使えません。" : ""}
        </p>
      )}
      <p className="field-note">
        課税売上（税抜き）から売上の返還を差し引き、輸出などの免税売上を足した額です。{by}年に免税事業者だった期間の売上は税抜きしません。
        税区分の無い明細は、科目の税区分の初期値で売上かどうかを決めています。給与等支払額は給料賃金と専従者給与の合計です。
        {by}年の帳簿が domble に無いとき（または帳簿の計算と違うとき）は、手で入れてください。入れた額が帳簿の計算より優先します。
      </p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); save(draft === "" ? null : Number(draft)); }}>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>基準期間（{by}年）の課税売上高を手で入れる</span>
          <input className="input num" inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))} placeholder="空なら帳簿から計算" disabled={!admin} />
        </label>
        <div style={{ alignSelf: "flex-end", display: "flex", gap: 8 }}>
          <button className="btn primary" type="submit" disabled={!admin || draft === (info.source === "manual" ? String(info.base) : "")}><Save size={16} /> 保存する</button>
          {info.source === "manual" && <button type="button" className="btn ghost" onClick={() => save(null)} disabled={!admin}>帳簿から計算に戻す</button>}
        </div>
      </form>
    </div>
  );
};
