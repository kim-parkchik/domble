/**
 * 決算整理（決算でやることを順に並べ、状態を出す。決算・申告の手順の案内も兼ねる）
 *  - 手順：決算の前（未登録の明細・現金・預金の残高のマイナス・消費税の確認・期首残高）→ 決算整理 → 決算書・申告（期限）→ 年の締め（確認コードの控え）→ 翌年への繰越
 *  - 棚卸：期末の棚卸高（棚卸表から）を入れ、期首・期末の振替の決算整理仕訳を作る（lib/yearEnd.ts）
 *  - 未払消費税等：その年の課税区分の申告書の ㉖ から決算整理仕訳を作る（課税事業者の年。任意）
 *  - 家事按分・減価償却・貸倒引当金は、それぞれの画面で作る（ここでは状態と入口だけ）
 *  - 未払費用・前払費用などの振り戻しは、仕訳の訂正の画面の「翌年1月1日付で振り戻す」
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Plus, Printer, Save, Trash2, Wand2 } from "lucide-react";
import { useAppContext, useCarryForwardCheck, useMissingCarry, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { AmountInput } from "../../components/Inputs";
import { exportCsvFile } from "../../components/csvExport";
import { EntryEditModal } from "../entry/EntryEditModal";
import { closingBalances, openingDifference } from "../../lib/accounting";
import { longDate, todayIso, yen } from "../../lib/format";
import { negativeBalances, negativeLabel, negativeText } from "../../lib/cashbook";
import { consumptionTaxDeadline, daysUntil, incomeTaxDeadline } from "../../lib/deadlines";
import { CODE } from "../../constants/accounts";
import {
  accruedTaxLines, closingInventory, exclusiveSettlementLines, inventoryIssues, inventoryLines, rowAmount, type InventoryCount, type InventoryRow,
} from "../../lib/yearEnd";
import type { JournalLine } from "../../lib/types";
import * as repo from "../../db/repo";
import type { Page } from "../../App";
import { useYearReturn } from "./TaxReturnView";
import { useTaxIssues } from "./TaxPage";
import { useWithholding } from "../payroll/useWithholding";
import { fileLabel } from "../../lib/business";
import { ownerText } from "../../lib/printLayout";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
/** 仕訳の明細を比べるための文字列（作成済みの仕訳が今の計算と同じか） */
const lineKey = (ls: Pick<JournalLine, "side" | "account_id" | "amount">[]) => ls.map((l) => `${l.side}:${l.account_id}:${l.amount}`).sort().join("|");

type Status = { text: string; tone: "ok" | "todo" | "none" | "warn" };
const Chip = ({ s }: { s: Status }) => <span className={`yearend-chip ${s.tone}`}>{s.text}</span>;

/** goCarry：その年から翌年への繰越（事業者設定の「翌年への繰越」）を開く */
export const YearEndPage = ({ go, goCarry }: { go: (p: Page) => void; goCarry: (fromYear: number) => void }) => {
  const { db, year, accounts, taxYear, homeUseRates, isClosed, can, bump, dataVersion, filing, labelOf, subAccounts } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();
  const idOf = (code: string) => accounts.find((a) => a.code === code)?.id ?? 0;
  const end = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const [viewing, setViewing] = useState<number | null>(null);

  // 状態（作った仕訳と、その明細）
  const [runs, setRuns] = useState<{ depreciation: number | null; homeUse: number | null; allowance: number | null; assets: number; inventory: number | null; accrued: number | null; keys: Record<number, string> } | null>(null);
  const [count, setCount] = useState<InventoryCount | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [depreciation, homeUse, allowance, assets, inventory, accrued, c] = await Promise.all([
        repo.getDepreciationRun(db, year), repo.getHomeUseRun(db, year), repo.getAllowanceRun(db, year), repo.getAssets(db),
        repo.getYearEndRun(db, year, "inventory"), repo.getYearEndRun(db, year, "accrued_tax"), repo.getInventoryCount(db, year),
      ]);
      const keys: Record<number, string> = {};
      for (const id of [inventory, accrued]) if (id) keys[id] = lineKey((await repo.getEntry(db, id))?.lines ?? []);
      if (!alive) return;
      setRuns({ depreciation, homeUse, allowance, assets: assets.length, inventory, accrued, keys });
      setCount(c);
    })().catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);

  // 決算の前と後の手順の状態（未登録の明細・翌年の期首残高・祝日（申告の期限））
  const [around, setAround] = useState<{ pendingBank: number; nextOpening: boolean; holidays: Set<string> } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([repo.countPendingBankLines(db, year), repo.hasOpening(db, year + 1), repo.getHolidayData(db)])
      .then(([pendingBank, nextOpening, h]) => alive && setAround({ pendingBank, nextOpening, holidays: new Set(h.holidays.map((x) => x.date)) }))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  const { issues: taxIssues } = useTaxIssues();
  const carryChecks = useCarryForwardCheck();
  const withholding = useWithholding(year);
  const missingCarry = useMissingCarry();

  // 棚卸
  const stockId = idOf(CODE.STOCK);
  const openingStock = opening[stockId] ?? 0;
  const inventoryIds = { openingAccount: idOf(CODE.OPENING_STOCK), closingAccount: idOf(CODE.CLOSING_STOCK), stock: stockId };
  const counted = closingInventory(count);
  const plannedInventory = inventoryLines(openingStock, counted, inventoryIds);
  const hasStock = openingStock !== 0 || counted !== 0 || accounts.some((a) => a.code === CODE.PURCHASES && (end.get(a.id) ?? 0) !== 0);
  const invIssues = runs?.inventory || count ? inventoryIssues({
    openingStock, openingTransferred: end.get(inventoryIds.openingAccount) ?? 0, closingStock: end.get(stockId) ?? 0, closingCounted: end.get(inventoryIds.closingAccount) ?? 0,
  }) : [];

  // 未払消費税等
  const taxReturn = useYearReturn();
  const accruedIds = { taxes: idOf(CODE.TAXES), accrued: idOf(CODE.ACCRUED_CONSUMPTION_TAX), receivable: idOf(CODE.ACCRUED), misc: idOf(CODE.MISC_INCOME) };
  // 税抜経理の年は、仮受・仮払消費税等の年末の残高（作ってある精算の仕訳を除く）と精算する
  const exclusive = taxYear.status !== "exempt" && taxYear.method === "exclusive";
  const clearing = useMemo(() => {
    if (!exclusive) return null;
    const bal = closingBalances(accounts, opening, lines.filter((l) => l.entry_id !== runs?.accrued));
    return { received: bal.get(idOf(CODE.TAX_RECEIVED)) ?? 0, paid: bal.get(idOf(CODE.TAX_PAID)) ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exclusive, accounts, opening, lines, runs?.accrued]);
  const plannedAccrued = !taxReturn ? [] : clearing
    ? exclusiveSettlementLines(clearing.received, clearing.paid, taxReturn.total, {
      received: idOf(CODE.TAX_RECEIVED), paid: idOf(CODE.TAX_PAID), accrued: accruedIds.accrued, receivable: accruedIds.receivable, misc: accruedIds.misc, miscExpense: idOf(CODE.MISC_EXPENSE),
    })
    : accruedTaxLines(taxReturn.total, accruedIds);

  const runStatus = (id: number | null | undefined, planned?: JournalLine[]): Status =>
    id ? (planned && runs?.keys[id] !== undefined && runs.keys[id] !== lineKey(planned) ? { text: `作成済み（No.${id}）：計算と違う`, tone: "warn" } : { text: `作成済み（No.${id}）`, tone: "ok" })
      : { text: "未作成", tone: "todo" };
  const yearendAccounts = homeUseRates.filter((r) => r.method === "yearend" && r.rate < 100);

  const make = async (kind: repo.YearEndKind, planned: JournalLine[], label: string) => {
    try {
      const id = await repo.saveYearEndRun(db, year, kind, planned);
      bump();
      toast(id ? `${label}の仕訳（No.${id}）を作りました` : `${label}の金額が無いので、仕訳は作りませんでした（作成済みのものは削除）`);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const disabled = isClosed || !can("entry");

  // 決算の前に済ませること
  // 現金・預金の残高が一日の終わりにマイナスになった日（入力漏れ・日付の誤りの手がかり）
  const negatives = useMemo(() => negativeBalances(accounts, subOpening, lines), [accounts, subOpening, lines]);
  const exempt = taxYear.status === "exempt";
  const taxToFix = taxIssues.filter((i) => i.level !== "info").length;
  const openingStatus: Status = missingCarry ? { text: "繰越していない", tone: "todo" }
    : carryChecks.some((c) => c.to === year) ? { text: "前年の残高とずれ", tone: "warn" }
      : openingDifference(accounts, opening).difference !== 0 ? { text: "貸借が合わない", tone: "warn" }
        : { text: "問題なし", tone: "ok" };
  // 申告の期限（過ぎていて年を締めていなければ目立たせる）
  const deadlineStatus = (date: string | null): Status => {
    if (!date) return { text: "—", tone: "none" };
    const left = daysUntil(todayIso(), date);
    return { text: `期限 ${date.slice(5).replace("-", "/")}${left >= 0 && left <= 30 ? `（あと${left}日）` : ""}`, tone: left < 0 && !isClosed ? "warn" : "none" };
  };
  const incomeDue = around ? incomeTaxDeadline(year, around.holidays) : null;
  const consumptionDue = around && !exempt ? consumptionTaxDeadline(year, around.holidays) : null;

  const steps: { title: string; status: Status; note: string; page?: Page; pageLabel?: string; action?: { label: string; run: () => void } }[] = [
    {
      title: "銀行・カードの明細を仕訳にする",
      status: !around ? { text: "…", tone: "none" } : around.pendingBank > 0 ? { text: `未登録 ${around.pendingBank} 件`, tone: "todo" } : { text: "未登録なし", tone: "ok" },
      note: "取り込んだ明細のうち、その年の日付でまだ仕訳にしていないものです（帳簿入力の「明細の取り込み」）", page: "cashbook", pageLabel: "帳簿入力",
    },
    {
      title: "現金・預金の残高",
      status: negatives.length ? { text: `マイナスの日あり（${negatives.length} 件）`, tone: "warn" } : { text: "マイナスの日なし", tone: "ok" },
      note: negatives.length
        ? `残高がマイナスになっています（期首か一日の終わり）。${negatives.map((x) => negativeText(x, negativeLabel(x, labelOf, subAccounts))).join("、")}。` +
          "現金や口座の残高はマイナスにならないので、入金の入れ漏れ・日付の誤り・二重の登録がないか帳簿入力で、期首残高は前の年の残高と繰越を確かめます（当座預金は見ません）"
        : "現金・預金の残高が、期首や一日の終わりにマイナスになっていないかを確かめます（入金の入れ漏れ・日付の誤りの手がかり。当座預金は見ません）",
      page: "cashbook", pageLabel: "帳簿入力",
    },
    {
      title: "消費税の確認（課税事業者）",
      status: exempt ? { text: "免税事業者", tone: "none" } : taxToFix > 0 ? { text: `${taxToFix} 件`, tone: "warn" } : { text: "問題なし", tone: "ok" },
      note: "税区分の付け忘れ・インボイスの区分・課税区分の届出などを、消費税の画面の「確認」で直します", page: "tax", pageLabel: "消費税",
    },
    {
      title: "期首残高", status: openingStatus,
      note: "1月1日の残高が、前の年の年末の残高（繰越）と合っているか確かめます", page: "opening", pageLabel: "期首残高",
    },
    {
      title: "棚卸（在庫がある事業）", status: !hasStock ? { text: "在庫なし", tone: "none" } : runStatus(runs?.inventory, plannedInventory),
      note: "年末に在庫を数えて棚卸表を作り、期首・期末の振替の仕訳を作ります（この画面の下）",
    },
    {
      title: "家事按分（年末にまとめて振り替える科目）",
      status: yearendAccounts.length === 0 ? { text: "対象の科目なし", tone: "none" } : runs?.homeUse ? { text: `作成済み（No.${runs.homeUse}）`, tone: "ok" } : { text: "未作成", tone: "todo" },
      note: "按分の割合を確かめて、年末の振替の仕訳を作ります", page: "homeuse", pageLabel: "家事按分",
    },
    {
      title: "減価償却", status: runs && runs.assets === 0 ? { text: "資産なし", tone: "none" } : runStatus(runs?.depreciation),
      note: "固定資産台帳で、その年の減価償却費の仕訳を作ります（売却・除却した資産の仕訳も）", page: "assets", pageLabel: "固定資産台帳",
    },
    {
      title: "貸倒引当金（青色申告・任意）", status: filing.type === "white" ? { text: "白色申告は対象外", tone: "none" } : runs?.allowance ? { text: `作成済み（No.${runs.allowance}）`, tone: "ok" } : { text: "未作成（任意）", tone: "none" },
      note: "売掛金などの年末残高から繰入額を計算し、洗替の仕訳を作ります（決算書の2ページ）", page: "statements", pageLabel: "決算書",
    },
    {
      title: exclusive ? "消費税の精算（税抜経理）" : "未払消費税等（課税事業者・任意）",
      status: taxYear.status === "exempt" ? { text: "免税事業者", tone: "none" } : runs?.accrued ? runStatus(runs.accrued, plannedAccrued) : { text: "未作成（任意）", tone: "none" },
      note: exclusive ? "仮受・仮払消費税等を、納める消費税（未払消費税等）と精算します（この画面の下）" : "納める消費税を、その年の必要経費にするときに作ります（この画面の下）",
    },
    {
      title: "未払費用・前払費用など（あれば）", status: { text: "手で入れる", tone: "none" },
      note: "振替伝票の「決算整理」で入れます。翌年1月1日付の振り戻しは、仕訳を開いて「翌年1月1日付で振り戻す」で作れます", page: "voucher", pageLabel: "振替伝票",
    },
    {
      title: "給与：源泉所得税の納付・年末調整（給与を払った事業者）",
      status: !withholding ? { text: "…", tone: "none" } : !withholding.periods.some((p) => p.total > 0) ? { text: "預かった源泉所得税なし", tone: "none" }
        : withholding.periods.some((p) => p.total > 0 && p.status !== "paid")
          ? { text: `未納 ${withholding.periods.filter((p) => p.total > 0 && p.status !== "paid").length} 期間`, tone: "todo" } : { text: "納付済み", tone: "ok" },
      note: "給与の画面で、源泉所得税の納付（期限）と納付書の数字を確かめます。年末調整・源泉徴収票・法定調書合計表（翌年1月31日まで）は給与計算ソフトで作ります",
      page: "payroll", pageLabel: "給与",
    },
    { title: "確かめる", status: { text: "—", tone: "none" }, note: "残高試算表で残高を確かめます（月次推移表・前年比較で、おかしな月や科目が無いかも）", page: "trial", pageLabel: "残高試算表" },
    {
      title: filing.type === "white" ? "収支内訳書" : "青色申告決算書", status: { text: "—", tone: "none" },
      note: "書き込みの欄（地代家賃・税理士等の報酬の内訳など）を埋めて、印刷するか所得税と一緒に e-Tax 用に書き出します", page: "statements", pageLabel: "決算書",
    },
    {
      title: "消費税の申告（課税事業者）", status: exempt ? { text: "免税事業者", tone: "none" } : deadlineStatus(consumptionDue),
      note: `消費税の画面の「申告書」で数字を確かめ、e-Tax 用に書き出して申告・納付します${consumptionDue ? `（期限 ${longDate(consumptionDue)}）` : ""}`,
      page: "tax", pageLabel: "消費税",
    },
    {
      title: "所得税の確定申告", status: deadlineStatus(incomeDue),
      note: `所得税の画面で控除などを入れ、e-Tax 用に書き出して申告・納付します${incomeDue ? `（期限 ${longDate(incomeDue)}）` : ""}`,
      page: "incometax", pageLabel: "所得税",
    },
    {
      title: "年を締める", status: isClosed ? { text: "締め済み", tone: "ok" } : { text: "未", tone: "none" },
      note: "申告が済んだら、事業者設定の「締め」で年を締めます。締めたときに出る確認コードを、決算書の控えなど帳簿ファイルの外に残します",
      page: "settings", pageLabel: "事業者設定",
    },
    {
      title: `${year + 1}年への繰越`,
      status: !around ? { text: "…", tone: "none" } : !around.nextOpening ? { text: "未", tone: "todo" }
        : carryChecks.some((c) => c.from === year) ? { text: "やり直しが必要", tone: "warn" } : { text: "繰越済み", tone: "ok" },
      note: `${year}年末の残高を ${year + 1}年の期首残高にします（締める前でも繰り越せます。直したらやり直します）`,
      action: { label: "繰越を開く", run: () => goCarry(year) },
    },
  ];

  return (
    <div className="page">
      <PageHeader title="決算整理" note={`${year}年の決算と申告でやることを、順に並べています。この画面で作る仕訳はどれも12月31日付の決算整理仕訳です（作り直すと同じ仕訳を訂正します）。`} />

      <section className="sheet print-skip">
        <h2 className="sheet-h">決算・申告の進め方（{year}年）</h2>
        <ol className="yearend-steps">
          {steps.map((s) => (
            <li key={s.title}>
              <div className="yearend-step-head">
                <b>{s.title}</b>
                <Chip s={s.status} />
                {s.page && <button className="link-btn" onClick={() => go(s.page!)}>{s.pageLabel}を開く</button>}
                {s.action && <button className="link-btn" onClick={s.action.run}>{s.action.label}</button>}
              </div>
              <p className="field-note">{s.note}</p>
            </li>
          ))}
        </ol>
      </section>

      <InventorySection
        count={count} openingStock={openingStock} planned={plannedInventory} runId={runs?.inventory ?? null} issues={invIssues} disabled={disabled}
        onMake={() => make("inventory", plannedInventory, "棚卸の振替")} onView={setViewing}
      />

      <section className="sheet print-skip">
        <h2 className="sheet-h">{exclusive ? "消費税の精算（税抜経理）" : "未払消費税等"}（{year}年）</h2>
        {taxYear.status === "exempt" ? (
          <p className="muted">{year}年は免税事業者なので、消費税の仕訳は要りません。</p>
        ) : !taxReturn ? (
          <p className="muted">読み込んでいます…</p>
        ) : (
          <>
            <p className="prose">
              {taxReturn.total > 0
                ? <>申告書（{year}年の課税区分で計算）の納付税額は <b>{yen(taxReturn.total)}円</b>（消費税 {yen(taxReturn.national)}円・地方消費税 {yen(taxReturn.local)}円。中間納付を差し引いた後）です。</>
                : taxReturn.total < 0
                  ? <>申告書（{year}年の課税区分で計算）は <b>{yen(-taxReturn.total)}円の還付</b>です。</>
                  : <>申告書（{year}年の課税区分で計算）の納付税額は 0円です。</>}
              {" "}{clearing
                ? <>税抜経理では、年末に仮受消費税等（{yen(clearing.received)}円）と仮払消費税等（{yen(clearing.paid)}円）を、納める消費税（未払消費税等）と精算し、差額を雑収入（または雑費）にします。</>
                : "税込経理では、納める消費税は申告書を出した年（翌年）の必要経費にするのが原則ですが、年末に未払金に計上すれば、その年の必要経費にできます。"}
            </p>
            <div className="field-row wrap" style={{ alignItems: "center", gap: 10 }}>
              <span>
                {clearing
                  ? plannedAccrued.map((l) => `${l.side === "debit" ? "借" : "貸"} ${accounts.find((a) => a.id === l.account_id)?.name ?? ""} ${yen(l.amount)}`).join("　")
                  : taxReturn.total > 0 ? "租税公課 ／ 未払消費税等" : taxReturn.total < 0 ? "未収入金 ／ 雑収入（対象外）" : "仕訳にする額はありません"}
              </span>
              {runs?.accrued && <button className="link-btn" onClick={() => setViewing(runs.accrued!)}>{runStatus(runs.accrued, plannedAccrued).text}</button>}
              <button className="btn primary sm" onClick={() => make("accrued_tax", plannedAccrued, "未払消費税等")} disabled={disabled || (plannedAccrued.length === 0 && !runs?.accrued)}>
                <Wand2 size={14} /> {runs?.accrued ? "作り直す" : "仕訳を作る"}
              </button>
            </div>
            <p className="field-note">
              {clearing
                ? "税抜経理では、中間申告で納めた消費税は、納めたときに「仮払消費税等 ／ 普通預金」（対象外）で入れておきます（申告書の数字は中間納付を差し引いた後です）。"
                : "中間申告で納めた消費税は、納めたときに「租税公課 ／ 普通預金」（対象外）で入れておきます（申告書の数字は中間納付を差し引いた後です）。"}
              翌年に確定申告の消費税を納めたら「未払消費税等 ／ 普通預金」、還付を受けたら「普通預金 ／ 未収入金」（どちらも対象外）を入れます。
              申告書の数字（中間納付税額など）を直したら、作り直してください。
            </p>
          </>
        )}
      </section>

      {viewing && <EntryEditModal entryId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};

/** 棚卸：期末の棚卸高（棚卸表）と、期首・期末の振替の仕訳 */
const InventorySection = ({ count, openingStock, planned, runId, issues, disabled, onMake, onView }: {
  count: InventoryCount | null; openingStock: number; planned: JournalLine[]; runId: number | null; issues: string[]; disabled: boolean;
  onMake: () => void; onView: (id: number) => void;
}) => {
  const { db, year, settings, bump } = useAppContext();
  const toast = useToast();
  const saved: InventoryCount = count ?? { amount: 0, rows: [] };
  const [draft, setDraft] = useState<InventoryCount>(saved);
  useEffect(() => setDraft(saved), [count]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const total = closingInventory(draft);
  const setRow = (i: number, patch: Partial<InventoryRow>) => setDraft((d) => ({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(/[,\s]/g, "")));
  const saveIt = async () => {
    try {
      await repo.saveInventoryCount(db, year, draft);
      bump();
      toast("棚卸を保存しました");
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const exportCsv = () => exportCsvFile(
    `棚卸表_${fileLabel(settings)}_${year}.csv`, ["品名", "数量", "単価", "金額"],
    draft.rows.map((r) => [r.name, String(r.quantity), String(r.unitPrice), String(rowAmount(r))]), toast,
  );

  return (
    <section className="sheet yearend-inventory print-area">
      <div className="sheet-title">
        <h2 className="sheet-h" style={{ margin: 0 }}>棚卸（{year}年12月31日）</h2>
        <span className="print-only">{ownerText(settings.business_name, settings.owner_name)}</span>
        <div className="spacer" />
        <button className="btn ghost sm print-skip" onClick={exportCsv} disabled={draft.rows.length === 0}><Download size={14} /> CSV</button>
        <button className="btn ghost sm print-skip" onClick={() => window.print()} disabled={draft.rows.length === 0}><Printer size={14} /> 棚卸表を印刷</button>
      </div>
      <p className="field-note print-skip">
        年末に残っている商品・原材料などを数え、品名・数量・単価（取得価額。最終仕入原価法なら最後に仕入れたときの単価）を棚卸表に入れます。棚卸表は保存しておく決まりがあります（青色申告）。
        棚卸表を作らないときは、期末の棚卸高を金額で入れます。
      </p>
      <table className="ledger it-table yearend-count">
        <thead><tr><th>品名</th><th className="num" style={{ width: 110 }}>数量</th><th className="num" style={{ width: 140 }}>単価</th><th className="num" style={{ width: 140 }}>金額</th><th className="print-skip" style={{ width: 40 }} /></tr></thead>
        <tbody>
          {draft.rows.map((r, i) => (
            <tr key={i}>
              <td><input className="input" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} disabled={disabled} aria-label="品名" maxLength={60} /></td>
              <td><input className="input num" inputMode="decimal" value={String(r.quantity)} onChange={(e) => setRow(i, { quantity: num(e.target.value) })} disabled={disabled} aria-label="数量" /></td>
              <td><input className="input num" inputMode="decimal" value={String(r.unitPrice)} onChange={(e) => setRow(i, { unitPrice: num(e.target.value) })} disabled={disabled} aria-label="単価" /></td>
              <td className="num">{yen(rowAmount(r))}</td>
              <td className="print-skip"><button type="button" className="btn ghost sm icon" onClick={() => setDraft((d) => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }))} disabled={disabled} aria-label="行を消す" title="行を消す"><Trash2 size={14} /></button></td>
            </tr>
          ))}
          <tr className="st-strong"><td colSpan={3}>期末の棚卸高</td><td className="num">{draft.rows.length ? yen(total) : ""}</td><td className="print-skip" /></tr>
        </tbody>
      </table>
      <div className="field-row wrap print-skip yearend-actions">
        <button type="button" className="btn ghost sm" onClick={() => setDraft((d) => ({ ...d, rows: [...d.rows, { name: "", quantity: 1, unitPrice: 0 }] }))} disabled={disabled}><Plus size={14} /> 行を足す</button>
        {draft.rows.length === 0 && (
          <label className="field" style={{ maxWidth: 220 }}>
            <span>期末の棚卸高（棚卸表が無いとき）</span>
            <AmountInput value={draft.amount || null} onChange={(v) => setDraft((d) => ({ ...d, amount: v ?? 0 }))} disabled={disabled} aria-label="期末の棚卸高" />
          </label>
        )}
        <button type="button" className="btn ghost" onClick={saveIt} disabled={disabled || !changed}><Save size={15} /> 保存する</button>
      </div>
      <div className="yearend-transfer print-skip">
        <p>
          期首の棚卸高 <b>{yen(openingStock)}円</b>（帳簿の期首残高）・期末の棚卸高 <b>{yen(closingInventory(count))}円</b>（保存したもの）
          で、「期首商品棚卸高 ／ 棚卸資産」「棚卸資産 ／ 期末商品棚卸高」の仕訳を作ります。
        </p>
        <div className="field-row wrap" style={{ alignItems: "center", gap: 10 }}>
          {runId && <button className="link-btn" onClick={() => onView(runId)}>作成済みの仕訳（No.{runId}）を見る</button>}
          <button className="btn primary sm" onClick={onMake} disabled={disabled || changed || (planned.length === 0 && !runId)} title={changed ? "棚卸を保存してから作ります" : undefined}>
            <Wand2 size={14} /> {runId ? "仕訳を作り直す" : "振替の仕訳を作る"}
          </button>
        </div>
        {issues.length > 0 && <ul className="tax-return-notes">{issues.map((x) => <li key={x}>{x}</li>)}</ul>}
      </div>
    </section>
  );
};
