/**
 * e-Tax の申告者の情報（事業者設定の中の節）
 *  消費税の申告書を e-Tax のデータ（xtx）で書き出すときに使う。氏名・屋号・郵便番号・住所は「事業者の情報」のもの
 *  個人番号（マイナンバー）は domble には保存しない（e-Tax で読み込んだあとに入れる）
 */
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { TAX_BUREAUS } from "../../constants/taxOffices";
import { toKatakana, type EtaxInfo } from "../../lib/etax";
import * as repo from "../../db/repo";

const pick = (s: EtaxInfo): EtaxInfo => ({
  etax_user_id: s.etax_user_id, tax_office: s.tax_office, phone: s.phone, owner_kana: s.owner_kana, business_kana: s.business_kana,
});

export const EtaxSection = () => {
  const { db, settings, reloadSettings, can } = useAppContext();
  const toast = useToast();
  const saved = pick(settings);
  const savedKey = JSON.stringify(saved);
  const [x, setX] = useState<EtaxInfo>(saved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setX(saved), [savedKey]);
  const [error, setError] = useState("");
  const set = <K extends keyof EtaxInfo>(k: K, v: string) => setX((p) => ({ ...p, [k]: v }));
  const admin = can("settings");
  const changed = JSON.stringify(x) !== savedKey;

  const save = async () => {
    try {
      await repo.saveEtaxInfo(db, x);
      await reloadSettings();
      setError("");
      toast("e-Tax の申告者の情報を保存しました");
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">e-Tax の申告者の情報</h2>
      <p className="prose">
        消費税の申告書を e-Tax のデータ（.xtx）で書き出すときに使います。氏名・屋号・住所は「事業者の情報」のものを使います。
        個人番号（マイナンバー）は domble には保存しません。e-Tax で読み込んだあとに入れてください。
      </p>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="field-row">
          <label className="field">
            <span>利用者識別番号（16桁）</span>
            <input
              className="input mono" value={x.etax_user_id} inputMode="numeric" maxLength={24} placeholder="例：1234567890123456"
              onChange={(e) => set("etax_user_id", e.target.value)} disabled={!admin}
            />
          </label>
          <label className="field">
            <span>提出先の税務署</span>
            <select className="input" value={x.tax_office} onChange={(e) => set("tax_office", e.target.value)} disabled={!admin}>
              <option value="">選んでください</option>
              {TAX_BUREAUS.map((b) => (
                <optgroup key={b.bureau} label={b.bureau}>
                  {b.offices.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>氏名のフリガナ</span>
            <input
              className="input" value={x.owner_kana} placeholder="例：ヤマダ タロウ" maxLength={60}
              onChange={(e) => set("owner_kana", e.target.value)} onBlur={(e) => set("owner_kana", toKatakana(e.target.value))} disabled={!admin}
            />
          </label>
          <label className="field">
            <span>屋号のフリガナ</span>
            <input
              className="input" value={x.business_kana} placeholder="例：ヤマダデザインジムショ" maxLength={60}
              onChange={(e) => set("business_kana", e.target.value)} onBlur={(e) => set("business_kana", toKatakana(e.target.value))} disabled={!admin}
            />
          </label>
        </div>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>電話番号</span>
          <input
            className="input" value={x.phone} inputMode="tel" placeholder="例：03-1234-5678" maxLength={20}
            onChange={(e) => set("phone", e.target.value)} disabled={!admin}
          />
        </label>
        <p className="field-note">利用者識別番号は、e-Tax の開始届出をしたときに通知された16桁の番号です（e-Tax のマイページで確かめられます）。</p>
        {error && <p className="form-error-inline" role="alert">{error}</p>}
        <div>
          <button className="btn primary" type="submit" disabled={!admin || !changed}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>
    </section>
  );
};
