/**
 * 新しい帳簿の初期設定
 *  - 事業者の情報（屋号は任意）・帳簿を始める年・申告の種類（あとから変更できる）
 *  - 消費税の課税区分（その年の設定。免税事業者でなければ保存する。経理方式・登録番号などは事業者設定の消費税で）
 *  - 電子帳簿保存法モード（あとから変更できない）
 */
import { useState } from "react";
import { ShieldCheck, NotebookPen } from "lucide-react";
import type Database from "../../db/connection";
import { Logo } from "./StartScreen";
import { SettingsForm } from "../settings/BusinessSettingsPage";
import type { EBookMode, Settings, TaxStatus } from "../../lib/types";
import * as repo from "../../db/repo";
import { displayName } from "../../lib/business";
import { EXEMPT_YEAR, statusProblem } from "../../lib/tax";
import { BUSINESS_CLASSES, TAX_STATUS_OPTIONS } from "../../constants/tax";

export const MODE_LABEL: Record<EBookMode, string> = {
  strict: "電子帳簿保存法に対応（優良な電子帳簿）",
  standard: "通常",
};

interface Props {
  db: Database;
  settings: Settings;
  onDone: (s: Settings) => void;
  onBack: () => void;
}

export const SetupScreen = ({ db, settings, onDone, onBack }: Props) => {
  const [mode, setMode] = useState<EBookMode>(settings.e_book_mode ?? "strict");
  const [taxStatus, setTaxStatus] = useState<TaxStatus>("exempt");
  const [businessClass, setBusinessClass] = useState(5);
  const needsInfo = !displayName(settings);
  const needsMode = !settings.e_book_mode;

  const finish = async (s: Settings) => {
    if (needsInfo) {
      const problem = statusProblem(taxStatus, s.fiscal_year);
      if (problem) throw new Error(problem);
      await repo.saveSettings(db, s);
      if (taxStatus !== "exempt") await repo.saveTaxYear(db, { ...EXEMPT_YEAR(s.fiscal_year), status: taxStatus, business_class: businessClass });
    }
    if (needsMode) {
      await repo.setEBookMode(db, mode);
      await repo.initChain(db); // 厳密モードなら、ここから記録の連鎖を始める
    }
    onDone(await repo.getSettings(db));
  };

  const modePicker = (
    <fieldset className="mode-picker">
      <legend>帳簿の保存方式<span className="mode-warn">対応 → 通常 には戻せません</span></legend>
      <label className={`mode-card${mode === "strict" ? " on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "strict"} onChange={() => setMode("strict")} />
        <ShieldCheck size={22} />
        <div>
          <strong>{MODE_LABEL.strict}<span className="rec">おすすめ</span></strong>
          <p>仕訳・勘定科目・期首残高の訂正や削除をすべて履歴に残します。削除した仕訳も「削除済み」として記録され、消えません。勘定科目の名前を変えても、過去の年度は元の名前のままです。</p>
        </div>
      </label>
      <label className={`mode-card${mode === "standard" ? " on" : ""}`}>
        <input type="radio" name="mode" checked={mode === "standard"} onChange={() => setMode("standard")} />
        <NotebookPen size={22} />
        <div>
          <strong>{MODE_LABEL.standard}</strong>
          <p>履歴を残しません。削除した仕訳は完全に消え、科目名の変更はすべての年度に反映されます。練習用や、とりあえず試したいとき向けです。翌年への繰越のときに、翌年から「電子帳簿保存法に対応」へ切り替えられます。</p>
        </div>
      </label>
    </fieldset>
  );

  // 消費税の課税区分（帳簿を始める年に選べるものだけ）
  const taxPicker = (year: number) => (
    <fieldset className="setup-tax">
      <legend>消費税（{year}年）</legend>
      <p className="field-note">
        前々年の課税売上高が1,000万円以下で、インボイス（適格請求書発行事業者）の登録をしていなければ、ふつうは免税事業者です。
        登録している人や、前々年の課税売上高が1,000万円を超える人は課税事業者です。経理方式・登録番号などは、あとで事業者設定の「消費税」で決めます。
      </p>
      {TAX_STATUS_OPTIONS.filter((o) => !statusProblem(o.value, year)).map((o) => (
        <label key={o.value} className="check">
          <input type="radio" name="tax-status" checked={taxStatus === o.value} onChange={() => setTaxStatus(o.value)} /> {o.label}
        </label>
      ))}
      {taxStatus === "simplified" && (
        <label className="field">
          <span>主な事業区分</span>
          <select className="input" value={businessClass} onChange={(e) => setBusinessClass(Number(e.target.value))}>
            {BUSINESS_CLASSES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </label>
      )}
    </fieldset>
  );

  return (
    <div className="start">
      <div className="start-card setup-card">
        <Logo size={64} />
        <h1 className="start-title">はじめに</h1>
        <p className="start-sub">
          {needsInfo ? "帳簿の持ち主の情報と、保存方式を決めてください。事業者の情報はあとから「事業者設定」で変えられます。" : "この帳簿の保存方式を決めてください。"}
        </p>
        {needsInfo ? (
          <SettingsForm initial={settings} submitLabel="帳簿をはじめる" onSubmit={finish} setup extra={(s) => <>{taxPicker(s.fiscal_year)}{modePicker}</>} />
        ) : (
          <>
            {modePicker}
            <button className="btn primary" onClick={() => finish(settings)}>この方式で決定する</button>
          </>
        )}
        <button className="link-btn" onClick={onBack}>戻る</button>
      </div>
    </div>
  );
};
