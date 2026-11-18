/**
 * 償却資産申告（固定資産税）の資料（固定資産台帳の画面のタブ。考え方は lib/depTax.ts）
 *  - 年 Y の画面では、Y+1 年1月1日現在の分（令和(Y+1−2018)年度。1月31日までに資産のある市区町村へ）
 *  - 申告書に書く数字（種類ごとの取得価額のイ・ロ・ハ・ニと評価額）、課税標準額・免税点・固定資産税の見込み
 *  - 資産ごとの種類・対象外（科目からの初期値を変えられる）と、少額減価償却資産などの耐用年数。その年から、あとの年へ引き継ぐ
 *  - 印刷（申告書に書く数字・種類別明細書の全資産用・増加資産用・減少資産用・対象外の資産）と CSV
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { PrintPreview } from "../../components/PrintPreview";
import { exportCsvFile } from "../../components/csvExport";
import { longDate, todayIso, yen } from "../../lib/format";
import { ownerText, type PrintDoc } from "../../lib/printLayout";
import { fileLabel } from "../../lib/business";
import {
  DEP_TAX_CSV_HEADER, DEP_TAX_EXCLUSION_LABEL, DEP_TAX_KINDS, DEP_TAX_KIND_LABEL, DEP_TAX_STATUS_LABEL, depTaxCsvRows, depTaxPrintSections, depTaxReport, FIXED_EXCLUSIONS,
  warekiMonth, type DepTaxRow, type DepTaxSetting,
} from "../../lib/depTax";
import type { FixedAsset } from "../../lib/depreciation";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const DepTaxView = ({ assets }: { assets: FixedAsset[] }) => {
  const { db, year, accounts, settings, bump, dataVersion, isClosed, readOnly, can } = useAppContext();
  const toast = useToast();
  const [conf, setConf] = useState<Map<number, DepTaxSetting>>(new Map());
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    repo.getDepTaxSettings(db, year).then(setConf).catch(console.error);
  }, [db, year, dataVersion]);

  const codeOf = (id: number) => accounts.find((a) => a.id === id)?.code ?? "";
  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? "（科目なし）";
  const report = useMemo(() => depTaxReport(assets, year, codeOf, nameOf, conf), [assets, year, accounts, conf]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = !isClosed && !readOnly && can("master");
  const listed = [...report.held, ...report.decreased, ...report.excluded];

  const save = async (r: DepTaxRow, next: DepTaxSetting) => {
    try {
      await repo.saveDepTaxSetting(db, year, r.asset.id, next);
      bump();
    } catch (e) {
      toast(`保存できませんでした：${errText(e)}`, "error");
    }
  };
  const current = (r: DepTaxRow) => conf.get(r.asset.id) ?? {};

  const printDoc = useMemo((): PrintDoc | null => printing
    ? {
      title: "償却資産申告の資料", owner: ownerText(settings.business_name, settings.owner_name),
      period: `${report.label}（${longDate(report.date)}現在）`, printedOn: todayIso(), sections: depTaxPrintSections(report),
    }
    : null, [printing, report, settings]);
  const exportCsv = () => exportCsvFile(`償却資産申告_${fileLabel(settings)}_${report.label}.csv`, DEP_TAX_CSV_HEADER, depTaxCsvRows(report), toast);

  const defaultText = (r: DepTaxRow) => ("kind" in r.def ? DEP_TAX_KIND_LABEL[r.def.kind] : "対象外");

  return (
    <>
      <section className="sheet">
        <div className="sheet-title">
          <h2 className="sheet-h" style={{ margin: 0 }}>{report.label}の償却資産申告（{longDate(report.date)}現在）</h2>
          <span className="spacer" />
          <button className="btn ghost" onClick={exportCsv} disabled={listed.length === 0}><Download size={16} /> CSV 書き出し</button>
          <button className="btn ghost" onClick={() => setPrinting(true)}><Printer size={16} /> 印刷</button>
        </div>
        <p className="prose">
          {longDate(report.date)}に持っている事業用の償却資産（構築物・機械・備品など）を、{report.year + 1}年1月31日までに資産のある市区町村へ申告します（固定資産税。地方税法383条）。
          固定資産税がかからない額（免税点 150万円未満）でも申告は要ります。固定資産台帳から、申告書と種類別明細書に書く数字を作るので、市区町村の用紙や eLTAX（地方税の電子申告）に書き写してください。
          前の年に申告していれば増加資産用・減少資産用を、初めての申告なら全資産用を使います。評価額は市区町村が決めるので、ここの額は見込みです。
        </p>
        {report.issues.length > 0 && (
          <ul className="tax-issues" style={{ marginTop: 12 }}>
            {report.issues.map((i) => (
              <li key={i.text} className={`tax-issue level-${i.level}`}><p className="tax-issue-detail" style={{ margin: 0 }}>{i.text}</p></li>
            ))}
          </ul>
        )}
      </section>

      <section className="sheet">
        <h2 className="sheet-h">申告書に書く数字（取得価額）</h2>
        <div className="table-wrap">
          <table className="ledger asset-table">
            <thead>
              <tr>
                <th>資産の種類</th><th className="num">前年前に<br />取得したもの（イ）</th><th className="num">前年中に<br />減少したもの（ロ）</th>
                <th className="num">前年中に<br />取得したもの（ハ）</th><th className="num">計（ニ）<br />（イ − ロ ＋ ハ）</th><th className="num">評価額<br />（見込み）</th>
              </tr>
            </thead>
            <tbody>
              {report.summary.map((s) => (
                <tr key={s.kind}>
                  <td>{s.kind} {DEP_TAX_KIND_LABEL[s.kind]}</td>
                  <td className="num">{yen(s.before)}</td><td className="num">{yen(s.decreased)}</td><td className="num">{yen(s.added)}</td>
                  <td className="num">{yen(s.total)}</td><td className="num">{yen(s.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="total-label">合計</td>
                <td className="num">{yen(report.sum.before)}</td><td className="num">{yen(report.sum.decreased)}</td><td className="num">{yen(report.sum.added)}</td>
                <td className="num">{yen(report.sum.total)}</td><td className="num">{yen(report.sum.value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>課税標準額（見込み）</dt><dd>{yen(report.standard)} 円<span className="hint">評価額の合計の 1,000円未満を切り捨て</span></dd>
          <dt>固定資産税（見込み）</dt>
          <dd>{report.exempt ? "かかりません（免税点 150万円未満）" : `${yen(report.tax)} 円`}<span className="hint">標準税率 1.4%。市区町村によって違うことがあります</span></dd>
        </dl>
      </section>

      <section className="sheet">
        <h2 className="sheet-h">資産ごとの種類と評価額</h2>
        <p className="field-note">
          種類は科目から決めた初期値です。違うときは資産ごとに選び直してください（{year}年から、あとの年へ引き継ぎます）。
          少額減価償却資産など台帳に耐用年数の無い資産は、ここで耐用年数を入れます。評価額は、前年中に取得したものは取得価額 ×（1 − 減価率 ÷ 2）、
          前年前に取得したものは前の年度の評価額 ×（1 − 減価率）で、取得価額の 5% を下回るときは 5% です。
          {!editable && (isClosed ? `${year}年は締めてあるので、種類と耐用年数は変えられません。` : "この帳簿では、種類と耐用年数は変えられません。")}
        </p>
        {listed.length === 0 ? (
          <p className="muted">{longDate(report.date)}に持っている資産と、{year}年に減少した資産はありません。</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger asset-table">
              <thead>
                <tr>
                  <th>名称</th><th>科目</th><th>取得年月</th><th className="num">取得価額</th><th>区分</th><th>資産の種類</th>
                  <th className="num">耐用年数</th><th className="num">減価残存率</th><th className="num">評価額<br />（見込み）</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((r) => {
                  const fixed = r.exclusion !== null && FIXED_EXCLUSIONS.includes(r.exclusion);
                  const s = current(r);
                  return (
                    <tr key={r.asset.id}>
                      <td>
                        {r.asset.name}
                        {r.mixed && r.kind !== null && <span className="hint">家事と兼用（取得価額の全額で載せています）</span>}
                        {r.memo && <span className="hint">{r.memo}</span>}
                      </td>
                      <td>{r.account}</td>
                      <td>{warekiMonth(r.asset.acquired_on)}</td>
                      <td className="num">{yen(r.asset.cost)}</td>
                      <td>{DEP_TAX_STATUS_LABEL[r.status]}</td>
                      <td>
                        {fixed ? (
                          <span className="muted">対象外：{DEP_TAX_EXCLUSION_LABEL[r.exclusion!]}</span>
                        ) : (
                          <select
                            className="input" style={{ minWidth: "13em" }} value={s.kind === undefined ? "" : String(s.kind)} disabled={!editable}
                            aria-label={`${r.asset.name}の資産の種類`}
                            onChange={(e) => save(r, { ...s, kind: e.target.value === "" ? undefined : (Number(e.target.value) as DepTaxSetting["kind"]) })}
                          >
                            <option value="">初期値（{defaultText(r)}）</option>
                            {DEP_TAX_KINDS.map((k) => <option key={k} value={k}>{k} {DEP_TAX_KIND_LABEL[k]}</option>)}
                            <option value="0">対象外</option>
                          </select>
                        )}
                        {!fixed && r.exclusion && <span className="hint">対象外：{DEP_TAX_EXCLUSION_LABEL[r.exclusion]}</span>}
                      </td>
                      <td className="num">
                        {r.kind === null ? "" : r.ledgerLife ? (r.life ? `${r.life}年` : "—") : (
                          <LifeInput value={s.life} disabled={!editable} label={`${r.asset.name}の耐用年数`} onSave={(life) => save(r, { ...s, life })} />
                        )}
                      </td>
                      <td className="num">{r.residual}</td>
                      <td className="num">{r.value === null ? "" : yen(r.value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {printing && <PrintPreview doc={printDoc} onClose={() => setPrinting(false)} />}
    </>
  );
};

/** 耐用年数の入力（離れたときに保存。空にすると消す） */
const LifeInput = ({ value, disabled, label, onSave }: { value: number | undefined; disabled: boolean; label: string; onSave: (life: number | undefined) => void }) => {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    const n = text.trim() === "" ? undefined : Number(text.normalize("NFKC"));
    if (n === value) return;
    onSave(n);
  };
  return (
    <input
      className="input" style={{ width: 64, textAlign: "right" }} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); }} inputMode="numeric" placeholder="年" disabled={disabled} aria-label={label}
    />
  );
};
