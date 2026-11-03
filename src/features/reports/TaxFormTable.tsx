/**
 * 消費税の申告書の1つの表（付表・第二表・第一表）を、欄の番号つきで出す（確定申告の申告書タブと、中間申告の仮決算で使う）
 */
import { yen } from "../../lib/format";
import type { TaxForm } from "../../lib/taxReturn";

export const signed = (n: number) => (n < 0 ? `△${yen(-n)}` : yen(n));

export const FormTable = ({ form }: { form: TaxForm }) => (
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
