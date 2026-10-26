/**
 * 消費税の設定（事業者設定の中の節）
 *  - 課税区分・経理方式・簡易課税の事業区分・年の途中から課税事業者になった日は年度ごと（次の設定がある年まで引き継ぐ）
 *  - 適格請求書発行事業者の登録番号・登録日は帳簿に1つ
 *  - 課税事業者の期間で税区分の入っていない仕訳を、科目の初期値でまとめて埋める
 */
import { useEffect, useState } from "react";
import { Save, Wand2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { BUSINESS_CLASSES, TAX_METHOD_OPTIONS, TAX_STATUS_OPTIONS } from "../../constants/tax";
import { statusProblem } from "../../lib/tax";
import type { TaxMethod, TaxStatus, TaxYear } from "../../lib/types";
import * as repo from "../../db/repo";

export const TaxSection = () => {
  const { db, year, settings, taxYear, reloadTaxYears, reloadSettings, isClosed, strict, can, dataVersion, bump } = useAppContext();
  const toast = useToast();
  const [t, setT] = useState<TaxYear>(taxYear);
  const [error, setError] = useState("");
  const taxKey = JSON.stringify(taxYear);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setT(taxYear), [taxKey]);
  const set = <K extends keyof TaxYear>(k: K, v: TaxYear[K]) => setT((x) => ({ ...x, [k]: v }));
  const changed = t.status !== taxYear.status || t.method !== taxYear.method || t.business_class !== taxYear.business_class
    || t.taxable_from !== taxYear.taxable_from;
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
        "すでに入っている税区分はそのままです。締めた月の仕訳は変えません。" +
        (strict ? "\n1件ずつ訂正として保存し、「訂正・削除履歴」に残ります。" : ""),
      { title: "税区分の一括設定", kind: "info", okLabel: "入れる", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      const r = await repo.fillTaxCodes(db, year);
      bump();
      toast(`${r.updated} 件の仕訳に税区分を入れました${r.closed ? `（締めた月の ${r.closed} 件はそのままです）` : ""}`);
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
        {t.status !== "exempt" && (
          <div className="field-row">
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
        {t.status === "twenty" && year === 2026 && (
          <p className="field-note">
            2割特例は令和8年（2026年）分の申告が最後です。令和9年分からは、本則課税・簡易課税、または要件を満たせば3割特例（個人事業者の令和9年分・令和10年分）から選びます。
            2割特例の翌年から簡易課税にするときは、簡易課税制度選択届出書を出します（翌年分の申告期限まで）。
          </p>
        )}
        {t.status === "thirty" && <p className="field-note">3割特例は、登録によって課税事業者になった個人事業者で、基準期間（2年前）の課税売上高が1,000万円以下のときに使えます。</p>}
        {t.method === "inclusive" && t.status !== "exempt" && <p className="field-note">税込経理：帳簿の金額は税込のままです。税抜経理には今後対応します。</p>}
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        {isClosed && <p className="field-note">{year}年は締め済みのため変更できません。</p>}
        <div>
          <button className="btn primary" type="submit" disabled={!admin || isClosed || (!changed && !taxYear.inherited)}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>

      {!!untaxed && (
        <div className="tax-fill" role="status">
          <span>{year}年の課税事業者の期間に、税区分が入っていない仕訳が <b>{untaxed}</b> 件あります（課税事業者にする前に入れた仕訳など）。</span>
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
