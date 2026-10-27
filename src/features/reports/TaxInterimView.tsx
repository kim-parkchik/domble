/**
 * 消費税の中間申告（消費税の画面のタブ。計算は lib/taxInterim.ts）
 *  - 前年の確定消費税額（⑨）を前年の帳簿から計算する。帳簿に無い年・修正申告で変わった年は手で入れる
 *  - その年の中間申告の回数・対象期間・期限・額を出し、合計を申告書の「中間納付税額」に入れられる
 *  - 仮決算による中間申告と、中間申告書の e-Tax のデータは扱わない
 */
import { useEffect, useState } from "react";
import { Save, Wand2 } from "lucide-react";
import { useAppContext, useInterim, type InterimInfo } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { longDate, yen } from "../../lib/format";
import { INTERIM_KIND_LABEL, INTERIM_NONE_LIMIT } from "../../lib/taxInterim";
import { TAX_STATUS_OPTIONS } from "../../constants/tax";
import * as repo from "../../db/repo";

const WEEKDAY = "日月火水木金土";
const dateWithDay = (iso: string) => `${longDate(iso)}（${WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]}）`;
const monthSpan = (from: string, to: string) => {
  const [a, b] = [Number(from.slice(5, 7)), Number(to.slice(5, 7))];
  return a === b ? `${a}月分` : `${a}〜${b}月分`;
};

/** 中間申告の予定の合計を、申告書の「中間納付税額」に入れる */
export const InterimFillButton = ({ info }: { info: InterimInfo }) => {
  const { db, year, isClosed, can, bump } = useAppContext();
  const toast = useToast();
  const { plan, entered } = info;
  if (plan.periods.length === 0) return null;
  const same = entered.national === plan.national && entered.local === plan.local;
  const fill = async () => {
    try {
      await repo.saveTaxInterim(db, year, plan.national, plan.local);
      bump();
      toast("中間納付税額に、前年の実績で計算した額を入れました");
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

export const TaxInterimView = ({ onOpenReturn }: { onOpenReturn: () => void }) => {
  const { db, year, isClosed, can, bump } = useAppContext();
  const info = useInterim();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const manualKey = info?.prev.source === "manual" ? String(info.prev.amount) : "";
  useEffect(() => setDraft(manualKey), [manualKey]);
  if (!info) return <p className="empty-note">読み込み中…</p>;
  const { prev, plan, entered } = info;
  const admin = can("settings") && !isClosed;
  const py = year - 1;

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

      {plan.periods.length > 0 && (
        <>
          <table className="ledger tax-interim-table">
            <colgroup>
              <col style={{ width: 48 }} /><col style={{ width: 110 }} /><col /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 130 }} />
            </colgroup>
            <thead>
              <tr><th>回</th><th>対象期間</th><th>申告・納付の期限</th><th className="num">消費税</th><th className="num">地方消費税</th><th className="num">合計</th></tr>
            </thead>
            <tbody>
              {plan.periods.map((p) => (
                <tr key={p.no}>
                  <td className="num">{p.no}</td>
                  <td>{monthSpan(p.from, p.to)}</td>
                  <td>
                    {dateWithDay(p.payBy)}
                    {p.payBy !== p.due && <span className="muted">（{longDate(p.due)}が休みの日のため）</span>}
                  </td>
                  <td className="num">{yen(p.national)}</td>
                  <td className="num">{yen(p.local)}</td>
                  <td className="num">{yen(p.national + p.local)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>合計（確定申告の ⑩ 中間納付税額・㉑ 中間納付譲渡割額）</td>
                <td className="num"><b>{yen(plan.national)}</b></td>
                <td className="num"><b>{yen(plan.local)}</b></td>
                <td className="num"><b>{yen(plan.national + plan.local)}</b></td>
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
            1回の額は、前年の確定消費税額 × {plan.kind === "three" ? "3" : plan.kind === "monthly" ? "1" : "6"}/12（百円未満切り捨て）、地方消費税はその 22/78（百円未満切り捨て）です。
            期限が土日・祝日・年末年始（12月29日〜1月3日）にあたるときは、次の日が期限です。
            {plan.kind === "voluntary"
              ? "任意の中間申告書を期限までに出さなかったときは、届出をやめたものとみなされます（中間納付はしません）。"
              : "中間申告書を期限までに出さなくても、この額で申告したものとみなされます。仮決算で計算した額で申告することもできます（domble では計算しません。そのときは申告書の中間納付税額を手で直してください）。"}
          </p>
          {year >= 2027 && (
            <p className="field-note">
              令和9年4月1日から令和11年3月31日まで、飲食料品の消費税率の引下げに合わせて、中間申告の計算の特例が予定されています（国税庁の案内を確かめてください）。domble は前年の実績による額だけを出します。
            </p>
          )}
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
