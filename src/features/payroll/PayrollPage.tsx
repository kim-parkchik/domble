/**
 * 給与
 * 給与の計算（源泉徴収税額表・年末調整・源泉徴収票・法定調書）は給与計算ソフトで行い、ここではその結果を帳簿にして使う（lib/payroll.ts）
 *  - 給与の CSV の取り込み（PayrollImportModal）と、CSV のひな形
 *  - 源泉所得税の納付：期間（毎月／納期の特例）ごとの預かった額・期限・納めたか、納付書（所得税徴収高計算書）に書く数字
 *  - 人ごとの年間の集計（給与・賞与・源泉所得税。決算書の給料賃金・専従者給与の内訳と同じ数え方）
 *  - 給与の設定（預かる科目・支払う口座・通勤手当の科目・専従者・納期の特例）
 */
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { Copy, FileDown, Save, Upload, Wand2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { copyText } from "../../lib/clipboard";
import { longDate, todayIso, yen } from "../../lib/format";
import { toCsv } from "../../lib/csv";
import { daysUntil } from "../../lib/deadlines";
import { payeeBreakdown } from "../../lib/statements";
import {
  fiscalYearCode, PAYROLL_CSV_HEADER, payrollFigures, payrollSettingsProblem, type AccountRef, type PayrollSettings, type WithholdingClass, type WithholdingPeriod,
} from "../../lib/payroll";
import { CODE } from "../../constants/accounts";
import { usePayeeName } from "../reports/StatementPages";
import { PayrollImportModal } from "./PayrollImportModal";
import { periodLabel, SALARY_CODES, useWithholding } from "./useWithholding";
import * as repo from "../../db/repo";
import type { Page } from "../../App";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const ymd = (iso: string | null) => (iso ? iso.replace(/-/g, "/") : "");
const reiwa = (iso: string) => `令和${Number(iso.slice(0, 4)) - 2018}年`;

/** 期間の状態（期限を過ぎて納めていなければ目立たせる） */
const statusOf = (p: WithholdingPeriod, today: string): { text: string; tone: string } => {
  if (p.status === "none") return { text: "—", tone: "none" };
  if (p.status === "paid") return { text: "納付済み", tone: "ok" };
  const late = daysUntil(today, p.due) < 0;
  const text = p.status === "partial" ? `一部（残り ${yen(p.total - p.paid)}円）` : "未納";
  return { text: late ? `${text}・期限を過ぎています` : text, tone: late ? "warn" : "todo" };
};

/** 納付書（所得税徴収高計算書）に書く数字 */
const slipText = (p: WithholdingPeriod, special: boolean, year: number) => {
  const cls = (label: string, c: WithholdingClass) =>
    c.tax || c.amount
      ? `${label}：支払年月日 ${special && c.firstDate !== c.lastDate ? `${ymd(c.firstDate)}〜${ymd(c.lastDate)}` : ymd(c.lastDate)}　人員 ${c.people}人　支給額 ${yen(c.amount)}円　税額 ${yen(c.tax)}円`
      : `${label}：なし`;
  return [
    `給与所得・退職所得等の所得税徴収高計算書（${special ? "納期特例用" : "一般用"}）`,
    `年度：${fiscalYearCode(p.due)}`,
    `納期等の区分：${special ? `自 ${reiwa(`${year}-01-01`)}${p.fromMonth}月 至 ${reiwa(`${year}-01-01`)}${p.toMonth}月` : `${reiwa(`${year}-01-01`)}${p.fromMonth}月分`}`,
    cls("俸給・給料等", p.salary),
    cls("賞与", p.bonus),
    ...(p.other ? [`給与以外で預かった源泉所得税（報酬など）：${yen(p.other)}円`] : []),
    `本税：${yen(p.total)}円`,
    `納期限：${longDate(p.due)}`,
  ].join("\n");
};

export const PayrollPage = ({ go }: { go: (p: Page) => void }) => {
  const { year, accounts, can, readOnly } = useAppContext();
  const toast = useToast();
  const w = useWithholding(year);
  const payeeName = usePayeeName();
  const [importing, setImporting] = useState(false);
  const [slip, setSlip] = useState<number | null>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const today = todayIso();

  // 人ごとの集計（給料賃金・専従者給与。事業所得・不動産所得）
  const people = useMemo(() => {
    if (!w) return [];
    const lines = w.lines.filter((l) => l.date.startsWith(`${year}-`));
    const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)?.id ?? 0;
    return accounts.filter((a) => (SALARY_CODES as readonly string[]).includes(a.code)).flatMap((a) => {
      const figures = payrollFigures(lines, a.id, w.settings.tax, w.bonusEntryIds);
      return payeeBreakdown(a.id, lines, { drawId }).map((r) => ({ account: a.name, name: payeeName(r), gross: r.gross, ...(figures.get(r.key) ?? { bonus: 0, tax: 0, months: 0 }) }));
    });
  }, [w, year, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // 期限が来ている前の年の期間（7〜12月分・12月分）も、その年の画面に出す
  const shown = w ? [
    ...w.previous.filter((p) => p.due.startsWith(`${year}-`) && p.status !== "none").map((p) => ({ p, y: year - 1 })),
    ...w.periods.map((p) => ({ p, y: year })),
  ] : [];

  const saveTemplate = async () => {
    const path = await save({ defaultPath: "給与の取り込み_ひな形.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, toCsv(PAYROLL_CSV_HEADER, [["2026/01/25", "給与", "山田 太郎", 250000, 10000, 12475, 0, 0, 22875, 1500, "", 5000, 10000, 0, 198150]]));
      toast("ひな形を保存しました");
    } catch (e) {
      toast(`保存できませんでした：${errText(e)}`, "error");
    }
  };
  const openSettings = () => {
    setImporting(false);
    settingsRef.current?.scrollIntoView({ block: "start" });
  };

  return (
    <div className="page">
      <PageHeader
        title="給与"
        note="給与計算ソフトで計算した給与・賞与を取り込んで仕訳にし、源泉所得税の納付と決算書の給料賃金の内訳に使います。給与の計算・年末調整・源泉徴収票・法定調書は給与計算ソフトで行います。"
      >
        <button className="btn ghost" onClick={saveTemplate}><FileDown size={16} /> CSV のひな形</button>
        <button className="btn primary" onClick={() => setImporting(true)} disabled={!w || readOnly || !can("entry")}><Upload size={16} /> 給与の CSV を取り込む</button>
      </PageHeader>

      <section className="sheet">
        <h2 className="sheet-h">源泉所得税の納付（{year}年。{w?.settings.special ? "納期の特例" : "毎月"}）</h2>
        {!w ? <p className="muted">読み込んでいます…</p> : !w.settings.tax ? (
          <p className="warn-box">
            給与の設定で源泉所得税の科目（預り金の補助科目など）を決めると、預かった額と納付の期限・納付書に書く数字が出ます。
            <button className="link-btn" onClick={openSettings}>給与の設定へ</button>
          </p>
        ) : (
          <>
            <p className="prose">
              給料賃金・専従者給与の仕訳で預かった源泉所得税（{refName(accounts, w.settings.tax)}）を、支払った月で{w.settings.special ? "半年" : "月"}ごとにまとめます。
              納めた額（源泉所得税の科目の借方）は、前の年からの未納 → 古い期間から順に当てます。
              {w.carried > 0 && `${year}年の初めの未納は ${yen(w.carried)}円です。`}
            </p>
            <div className="table-wrap">
              <table className="ledger withholding-table">
                <thead>
                  <tr>
                    <th>支払った月</th><th>期限</th><th className="num">給与</th><th className="num">賞与</th><th className="num">給与以外</th>
                    <th className="num">預かった額</th><th className="num">納めた額</th><th>状態</th><th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ p, y }, i) => {
                    const st = statusOf(p, today);
                    return (
                      <tr key={`${y}-${p.fromMonth}`}>
                        <td>{y !== year ? `${y}年` : ""}{periodLabel(p)}</td>
                        <td>{ymd(p.due)}</td>
                        <td className="num">{yen(p.salary.tax, { blankZero: true })}</td>
                        <td className="num">{yen(p.bonus.tax, { blankZero: true })}</td>
                        <td className="num">{yen(p.other, { blankZero: true })}</td>
                        <td className="num">{yen(p.total, { blankZero: true })}</td>
                        <td className="num">{yen(p.paid, { blankZero: true })}</td>
                        <td><span className={`yearend-chip ${st.tone}`}>{st.text}</span></td>
                        <td>{p.total > 0 && <button className="link-btn" onClick={() => setSlip(slip === i ? null : i)}>納付書の数字</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {slip !== null && shown[slip] && (
              <div className="slip-box">
                <pre>{slipText(shown[slip].p, w.settings.special, shown[slip].y)}</pre>
                <button
                  className="btn ghost sm"
                  onClick={async () => toast(await copyText(slipText(shown[slip].p, w.settings.special, shown[slip].y)) ? "コピーしました" : "コピーできませんでした")}
                >
                  <Copy size={14} /> コピー
                </button>
              </div>
            )}
            <p className="field-note">
              人員は、支払った人の数です（納期の特例では、月ごとの人数の合計）。支給額は給料賃金・専従者給与の額で、非課税の通勤手当（別の科目）は入りません。
              給与以外で預かった源泉所得税のうち、税理士・弁護士・司法書士などの報酬は同じ納付書の「税理士等の報酬」の欄に書きます。
              それ以外の報酬・料金（原稿料・デザイン料など）は「報酬・料金等の所得税徴収高計算書」で、支払った月の翌月10日までに納めます（納期の特例はありません）。
            </p>
          </>
        )}
      </section>

      <section className="sheet">
        <h2 className="sheet-h">人ごとの集計（{year}年）</h2>
        {people.length === 0 ? <p className="muted">給料賃金・専従者給与の仕訳はありません。</p> : (
          <table className="ledger">
            <thead>
              <tr><th>氏名</th><th>科目</th><th className="num">支給額</th><th className="num">うち賞与</th><th className="num">源泉所得税</th><th className="num">給与を払った月</th></tr>
            </thead>
            <tbody>
              {people.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}</td><td>{r.account}</td><td className="num">{yen(r.gross)}</td><td className="num">{yen(r.bonus, { blankZero: true })}</td>
                  <td className="num">{yen(r.tax, { blankZero: true })}</td><td className="num">{r.months || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="field-note">
          決算書の給料賃金・専従者給与の内訳と同じ数え方です（人は仕訳の取引先、無ければ補助科目）。源泉所得税は、1つの仕訳に1人の給与だけがあるときに数えます。
          年末調整・源泉徴収票・給与支払報告書・法定調書合計表（翌年1月31日まで）は、給与計算ソフトで作ります。<button className="link-btn" onClick={() => go("statements")}>決算書を開く</button>
        </p>
      </section>

      <PayrollSettingsSection ref={settingsRef} settings={w?.settings ?? null} />

      {importing && w && <PayrollImportModal settings={w.settings} onClose={() => setImporting(false)} onSettings={openSettings} />}
    </div>
  );
};

const refName = (accounts: { id: number; name: string }[], r: AccountRef | null) => (r ? accounts.find((a) => a.id === r.account_id)?.name ?? "" : "");

/** 科目と補助科目を選ぶ */
const RefSelect = ({ label, value, onChange, disabled, allowNone = true }: {
  label: string; value: AccountRef | null; onChange: (v: AccountRef | null) => void; disabled: boolean; allowNone?: boolean;
}) => {
  const { activeAccounts, subAccounts } = useAppContext();
  const subs = value ? subAccounts.filter((s) => s.account_id === value.account_id && s.is_active) : [];
  return (
    <div className="field payroll-ref">
      <span>{label}</span>
      <div className="field-row">
        <select
          className="input" value={value?.account_id ?? 0} disabled={disabled} aria-label={`${label}の科目`}
          onChange={(e) => onChange(Number(e.target.value) ? { account_id: Number(e.target.value), sub_account_id: null } : null)}
        >
          {allowNone && <option value={0}>（使わない）</option>}
          {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {subs.length > 0 && (
          <select
            className="input" value={value?.sub_account_id ?? 0} disabled={disabled} aria-label={`${label}の補助科目`}
            onChange={(e) => onChange({ account_id: value!.account_id, sub_account_id: Number(e.target.value) || null })}
          >
            <option value={0}>補助なし</option>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
};

/** 給与の設定 */
const PayrollSettingsSection = ({ settings, ref }: { settings: PayrollSettings | null; ref: Ref<HTMLElement> }) => {
  const { db, activeAccounts, can, readOnly, bump, reloadAccounts } = useAppContext();
  const toast = useToast();
  const [s, setS] = useState<PayrollSettings | null>(settings);
  const [family, setFamily] = useState("");
  useEffect(() => {
    setS(settings);
    setFamily(settings?.family.join("、") ?? "");
  }, [settings]);
  const disabled = readOnly || !can("settings") || !s;
  const next = s ? { ...s, family: family.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) } : null;
  const changed = !!next && JSON.stringify(next) !== JSON.stringify(settings);
  const problem = next ? payrollSettingsProblem(next) : null;
  const set = <K extends keyof PayrollSettings>(k: K, v: PayrollSettings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));

  const saveIt = async () => {
    if (!next) return;
    try {
      await repo.savePayrollSettings(db, next);
      bump();
      toast("給与の設定を保存しました");
    } catch (e) {
      toast(`保存できませんでした：${errText(e)}`, "error");
    }
  };
  const setup = async () => {
    try {
      await repo.setupPayroll(db);
      await reloadAccounts(); // 足した補助科目を選べるように
      bump();
      toast("預り金に補助科目（源泉所得税・住民税・社会保険料）を用意し、給与の設定に入れました");
    } catch (e) {
      toast(`できませんでした：${errText(e)}`, "error");
    }
  };

  return (
    <section className="sheet" ref={ref}>
      <h2 className="sheet-h">給与の設定</h2>
      <p className="prose">
        給与の CSV を仕訳にするときの科目と、源泉所得税の納付の数え方です。源泉所得税は、住民税・社会保険料と別の科目（預り金の補助科目など）にしておきます。
      </p>
      <div className="field-row" style={{ marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={setup} disabled={disabled}>
          <Wand2 size={14} /> 預り金に補助科目（源泉所得税・住民税・社会保険料）を用意して入れる
        </button>
      </div>
      {s && (
        <div className="payroll-settings">
          <RefSelect label="源泉所得税" value={s.tax} onChange={(v) => set("tax", v)} disabled={disabled} />
          <RefSelect label="住民税" value={s.resident} onChange={(v) => set("resident", v)} disabled={disabled} />
          <RefSelect label="社会保険料（本人負担分）" value={s.social} onChange={(v) => set("social", v)} disabled={disabled} />
          <RefSelect label="その他の控除" value={s.other} onChange={(v) => set("other", v)} disabled={disabled} />
          <RefSelect label="支払う口座（差引支給額）" value={s.bank} onChange={(v) => set("bank", v)} disabled={disabled} />
          <label className="field payroll-ref">
            <span>通勤手当（非課税）の科目</span>
            <select className="input" value={s.commute ?? 0} disabled={disabled} onChange={(e) => set("commute", Number(e.target.value) || null)}>
              <option value={0}>（使わない）</option>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field payroll-wide">
            <span>専従者（専従者給与で記帳する人。氏名を「、」で区切る）</span>
            <input className="input" value={family} disabled={disabled} onChange={(e) => setFamily(e.target.value)} placeholder="例：山田 花子" />
          </label>
          <label className="check payroll-wide">
            <input type="checkbox" checked={s.special} disabled={disabled} onChange={(e) => set("special", e.target.checked)} />
            源泉所得税の納期の特例の承認を受けている（1〜6月分は7月10日、7〜12月分は翌年1月20日までに納める。給与を払う人が常に10人未満で、税務署に申請して承認を受けた事業者）
          </label>
        </div>
      )}
      {problem && <p className="warn-box">{problem}</p>}
      <div className="field-row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={saveIt} disabled={disabled || !changed || !!problem}><Save size={16} /> 保存する</button>
      </div>
    </section>
  );
};
