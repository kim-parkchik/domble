/**
 * e-Tax の申告者の情報（事業者設定の中の節）
 *  消費税・所得税の申告書を e-Tax のデータ（xtx）で書き出すときに使う。氏名・屋号・郵便番号・住所は「事業者の情報」のもの
 *  還付される税金の受取場所（口座）もここで持つ。個人番号（マイナンバー）は domble には保存しない（書き出すときに入れる）
 */
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { TAX_BUREAUS } from "../../constants/taxOffices";
import { BANK_KINDS, BRANCH_KINDS, DEPOSIT_KINDS, ETAX_FIELDS, toKatakana, type EtaxInfo } from "../../lib/etax";
import type { RefundMode } from "../../lib/types";
import * as repo from "../../db/repo";

const pick = (s: EtaxInfo): EtaxInfo => Object.fromEntries(ETAX_FIELDS.map((k) => [k, s[k]])) as EtaxInfo;

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
        消費税・所得税の申告書を e-Tax のデータ（.xtx）で書き出すときに使います。氏名・屋号・住所は「事業者の情報」のものを使います。
        e-Taxソフト（WEB版）は読み込んだデータを直せないので、還付先の口座もここで入れておきます。
        個人番号（マイナンバー）は domble には保存しません。書き出すときに、その都度入れてください。
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

        <h3 className="sheet-sub">確定申告書（所得税）の申告者の欄</h3>
        <div className="field-row wrap">
          <label className="field" style={{ maxWidth: 220 }}>
            <span>職業</span>
            <input className="input" value={x.occupation} placeholder="例：デザイナー" maxLength={20} onChange={(e) => set("occupation", e.target.value)} disabled={!admin} />
          </label>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>世帯主の氏名</span>
            <input className="input" value={x.householder_name} maxLength={30} onChange={(e) => set("householder_name", e.target.value)} disabled={!admin} />
          </label>
          <label className="field" style={{ maxWidth: 140 }}>
            <span>世帯主との続柄</span>
            <input className="input" value={x.householder_relation} placeholder="例：本人" maxLength={5} onChange={(e) => set("householder_relation", e.target.value)} disabled={!admin} />
          </label>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>事業所の電話番号</span>
            <input className="input" value={x.office_phone} inputMode="tel" maxLength={20} onChange={(e) => set("office_phone", e.target.value)} disabled={!admin} />
          </label>
        </div>
        <label className="field">
          <span>1月1日の住所（今の住所と違うときだけ）</span>
          <input className="input" value={x.jan1_address} maxLength={100} onChange={(e) => set("jan1_address", e.target.value)} disabled={!admin} />
        </label>

        <h3 className="sheet-sub">還付される税金の受取場所</h3>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>受取場所</span>
          <select className="input" value={x.refund_mode} onChange={(e) => set("refund_mode", e.target.value as RefundMode)} disabled={!admin}>
            <option value="none">書かない</option>
            <option value="bank">銀行等の口座</option>
            <option value="yucho">ゆうちょ銀行の口座</option>
            <option value="public">公金受取口座（個人番号が要る）</option>
          </select>
        </label>
        {x.refund_mode === "bank" && (
          <div className="field-row wrap">
            <label className="field" style={{ maxWidth: 200 }}>
              <span>金融機関名</span>
              <input className="input" value={x.bank_name} placeholder="例：みずほ" maxLength={20} onChange={(e) => set("bank_name", e.target.value)} disabled={!admin} />
            </label>
            <label className="field" style={{ maxWidth: 100 }}>
              <span>区分</span>
              <select className="input" value={x.bank_kind} onChange={(e) => set("bank_kind", e.target.value)} disabled={!admin}>
                {BANK_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field" style={{ maxWidth: 200 }}>
              <span>支店名</span>
              <input className="input" value={x.branch_name} placeholder="例：渋谷" maxLength={20} onChange={(e) => set("branch_name", e.target.value)} disabled={!admin} />
            </label>
            <label className="field" style={{ maxWidth: 100 }}>
              <span>区分</span>
              <select className="input" value={x.branch_kind} onChange={(e) => set("branch_kind", e.target.value)} disabled={!admin}>
                {BRANCH_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field" style={{ maxWidth: 120 }}>
              <span>預金の種類</span>
              <select className="input" value={x.deposit_kind} onChange={(e) => set("deposit_kind", e.target.value)} disabled={!admin}>
                {DEPOSIT_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field" style={{ maxWidth: 160 }}>
              <span>口座番号</span>
              <input className="input mono" value={x.account_no} inputMode="numeric" maxLength={12} onChange={(e) => set("account_no", e.target.value)} disabled={!admin} />
            </label>
          </div>
        )}
        {x.refund_mode === "yucho" && (
          <div className="field-row wrap">
            <label className="field" style={{ maxWidth: 140 }}>
              <span>記号（5桁）</span>
              <input className="input mono" value={x.yucho_symbol} inputMode="numeric" maxLength={6} onChange={(e) => set("yucho_symbol", e.target.value)} disabled={!admin} />
            </label>
            <label className="field" style={{ maxWidth: 160 }}>
              <span>番号（8桁まで）</span>
              <input className="input mono" value={x.yucho_number} inputMode="numeric" maxLength={9} onChange={(e) => set("yucho_number", e.target.value)} disabled={!admin} />
            </label>
          </div>
        )}
        <p className="field-note">
          申告が還付になるときだけ、e-Tax 用のデータに書きます（所得税・消費税）。金融機関名・支店名は「銀行」「支店」などを除いて入れ、区分で選びます。
          公金受取口座を使うときは口座を書かず、書き出すときに個人番号を入れてください。
        </p>
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
