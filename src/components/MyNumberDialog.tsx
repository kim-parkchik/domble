/**
 * e-Tax のデータ（xtx）を書き出すときに、個人番号（マイナンバー）を入れてもらう画面
 *  - 入れた番号はこの画面の中だけで使い、domble には保存しない（閉じれば消える）
 *  - 検査用数字（12桁目）で打ち間違いを確かめる。required の人は空にできない
 */
import { useState } from "react";
import { FileDown } from "lucide-react";
import { Modal } from "./Modal";
import { isValidMyNumber } from "../lib/etax";

export interface MyNumberPerson {
  key: string;
  label: string;
  required?: boolean;
}

export const MyNumberDialog = ({ persons, note, onSubmit, onClose }: {
  persons: MyNumberPerson[];
  note?: string;
  onSubmit: (numbers: Record<string, string>) => void;
  onClose: () => void;
}) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const clean = (s: string) => s.normalize("NFKC").replace(/[\s-]/g, "");
  const problem = (p: MyNumberPerson) => {
    const v = clean(values[p.key] ?? "");
    if (!v) return p.required ? "入れてください" : "";
    return isValidMyNumber(v) ? "" : "12桁の個人番号として正しくありません（打ち間違いがないか確かめてください）";
  };
  const blocked = persons.some((p) => problem(p));
  const submit = () => {
    if (blocked) return;
    onSubmit(Object.fromEntries(persons.map((p) => [p.key, clean(values[p.key] ?? "")])));
  };
  return (
    <Modal title="個人番号を入れて書き出す" onClose={onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }} autoComplete="off">
        <p className="prose">
          e-Taxソフト（WEB版）は読み込んだデータを直せないので、個人番号は書き出すときに入れます。入れた番号は domble には保存しません。
          {note && <><br />{note}</>}
        </p>
        {persons.map((p) => {
          const err = values[p.key] ? problem(p) : "";
          return (
            <label key={p.key} className="field">
              <span>{p.label}の個人番号{p.required ? "" : "（任意）"}</span>
              <input
                className={`input mono${err ? " invalid" : ""}`} inputMode="numeric" maxLength={16} placeholder="12桁" spellCheck={false}
                value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              />
              {err && <span className="form-error-inline">{err}</span>}
            </label>
          );
        })}
        <div className="voucher-actions">
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button type="submit" className="btn primary" disabled={blocked}><FileDown size={16} /> 書き出す</button>
        </div>
      </form>
    </Modal>
  );
};
