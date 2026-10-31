/**
 * 帳簿の CSV（純粋関数）。各帳簿の画面の「CSV 書き出し」と、事業者設定の「帳簿をまとめて書き出す」で同じものを使う
 *  - 仕訳日記帳：伝票ごとの行（振替伝票の行番号ごとに借方｜貸方を横に並べる）と CSV
 *  - 総勘定元帳：残高か動きのある科目すべて（科目ごとに繰越の行から）
 *  - 残高試算表：区分の見出し・科目・補助科目・区分の小計・所得金額の行と CSV
 *  - 固定資産台帳：その年に償却する資産の行
 */
import type { CsvValue } from "./csv";
import {
  buildLedger, buildTrialBalance, closingBalances, groupByEntry, subTrialRow, summarizeIncome, type FlatLine, type LedgerRow, type TrialBalanceRow,
} from "./accounting";
import type { Account, AccountCategory, Counterparty, OpeningBalances, SubAccount, SubOpeningBalances, TaxYear } from "./types";
import { subKey } from "./types";
import { inputDelayDays, isLateInput } from "./inputPeriod";
import { classLabel, displayClass, displayUse, invoiceCsvLabel, isPurchaseCode, taxLongLabel, taxShortLabel, useLabel } from "./tax";
import { yen } from "./format";
import { depreciationFor, methodLabel, type FixedAsset } from "./depreciation";
import { BS_CATEGORIES, CATEGORY_LABEL, isBalanceSheet, PL_CATEGORIES } from "../constants/accounts";
import { ledgerCsvRows, type AssetPrintLine, type TrialPrintLine } from "./printBooks";

/** 1年分の帳簿（科目・補助科目はその年の名前） */
export interface BookSource {
  accounts: Account[];
  subs: SubAccount[];
  counterparties: Counterparty[];
  taxYears: TaxYear[];
  opening: OpeningBalances;
  subOpening: SubOpeningBalances;
  /** 帳簿の明細（税抜経理の年は lib/taxExclusive.ts の bookLines を通したもの） */
  lines: FlatLine[];
}

/** 科目（補助科目）の名前。例：普通預金（A銀行） */
export const labelOfAccount = (accounts: Account[], subs: SubAccount[]) => {
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  return (id: number, subId?: number | null) => {
    const sub = subId ? sn.get(subId) : "";
    return sub ? `${an.get(id) ?? ""}（${sub}）` : an.get(id) ?? "";
  };
};

// ────────────────────────────────────────────
// 仕訳日記帳
// ────────────────────────────────────────────

/** 仕訳日記帳の1行（振替伝票の1行分の借方｜貸方） */
export interface JournalRow {
  entryId: number;
  date: string;
  /** 伝票の最初の行か */
  first: boolean;
  /** 伝票の行数 */
  span: number;
  dr?: FlatLine;
  cr?: FlatLine;
  memo: string;
  deleted: boolean;
  counterparty: string;
  /** 登録日時 */
  createdAt: string;
  /** 入力期間を過ぎて登録したか */
  late: boolean;
  /** 決算整理仕訳か */
  adjustment: boolean;
}

/** 1つの伝票の明細を、行番号ごとに借方｜貸方を横に並べた行にする */
export const journalRowsOf = (entryId: number, ls: FlatLine[], o: { counterparty: string; late: boolean }): JournalRow[] => {
  const byRow = new Map<number, { dr?: FlatLine; cr?: FlatLine }>();
  for (const l of ls) {
    const r = byRow.get(l.row_no) ?? {};
    if (l.side === "debit") r.dr = l;
    else r.cr = l;
    byRow.set(l.row_no, r);
  }
  const pairs = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
  return pairs.map(([, p], i) => ({
    entryId, date: ls[0].date, first: i === 0, span: pairs.length, dr: p.dr, cr: p.cr, memo: p.dr?.memo || p.cr?.memo || "",
    deleted: ls[0].is_deleted === 1, counterparty: o.counterparty, createdAt: ls[0].created_at ?? "", late: o.late, adjustment: ls[0].is_adjustment === 1,
  }));
};

/** 1年分の仕訳をすべて行にする（まとめての書き出し。入力期間を過ぎて登録したかも付ける） */
export const journalRowsAll = (lines: FlatLine[], counterparties: Counterparty[], inputDays: number | null): JournalRow[] => {
  const cp = new Map(counterparties.map((c) => [c.id, c.name]));
  return [...groupByEntry(lines)].flatMap(([id, ls]) => journalRowsOf(id, ls, {
    counterparty: ls[0].counterparty_id ? cp.get(ls[0].counterparty_id) ?? "" : "",
    late: inputDays != null && isLateInput(ls[0].date, ls[0].created_at, inputDays),
  }));
};

export const JOURNAL_CSV_HEADER = [
  "伝票No", "日付", "借方科目", "借方補助", "借方金額", "貸方科目", "貸方補助", "貸方金額", "摘要", "取引先", "登録番号", "状態", "登録日時", "登録までの日数", "入力期間", "決算整理",
  "借方税区分", "借方インボイス", "借方事業区分", "借方用途区分", "貸方税区分", "貸方インボイス", "貸方事業区分", "貸方用途区分",
];

/** 仕訳日記帳の CSV の行 */
export const journalCsvRows = (rows: JournalRow[], accounts: Account[], subs: SubAccount[], counterparties: Counterparty[]): CsvValue[][] => {
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const taxCols = (l?: FlatLine) => [
    l?.tax_code ? taxLongLabel(l.tax_code, null, l.date) : "", invoiceCsvLabel(l?.tax_code, l?.invoice_kind), l?.business_class ? classLabel(l.business_class) : "",
    isPurchaseCode(l?.tax_code) && l?.purchase_use ? useLabel(l.purchase_use) : "",
  ];
  const sub = (l?: FlatLine) => (l?.sub_account_id ? sn.get(l.sub_account_id) ?? "" : "");
  return rows.map((r) =>
    [r.entryId, r.date, r.dr ? an.get(r.dr.account_id) ?? "" : "", sub(r.dr), r.dr?.amount ?? "",
      r.cr ? an.get(r.cr.account_id) ?? "" : "", sub(r.cr), r.cr?.amount ?? "", r.memo, r.counterparty,
      r.counterparty ? counterparties.find((c) => c.name === r.counterparty)?.invoice_no ?? "" : "", r.deleted ? "削除済み" : "",
      r.createdAt, r.createdAt ? inputDelayDays(r.date, r.createdAt) : "", r.late ? "過ぎて登録" : "", r.adjustment ? "決算整理" : "",
      ...taxCols(r.dr), ...taxCols(r.cr)],
  );
};

// ────────────────────────────────────────────
// 総勘定元帳
// ────────────────────────────────────────────

/** 元帳に並べる科目の区分の順 */
export const LEDGER_ORDER: AccountCategory[] = ["asset", "liability", "equity", "revenue", "cogs", "expense", "special"];

/** 元帳の表示・印刷・CSV に使う関数（相手科目・税区分・補助科目・取引先の名前、科目の期首残高、対象の科目） */
export const ledgerHelpers = (b: BookSource) => {
  const labelOf = labelOfAccount(b.accounts, b.subs);
  const sn = new Map(b.subs.map((s) => [s.id, s.name]));
  const cpNames = new Map(b.counterparties.map((c) => [c.id, c.name]));
  const cpOfEntry = new Map<number, string>();
  for (const l of b.lines) if (l.counterparty_id) cpOfEntry.set(l.entry_id, cpNames.get(l.counterparty_id) ?? "");
  const used = new Set(b.lines.map((l) => l.account_id));
  const balances = closingBalances(b.accounts, b.opening, b.lines);
  return {
    labelOf,
    cpOfEntry,
    counterOf: (r: LedgerRow) => (r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter),
    taxOf: (r: LedgerRow) => {
      const lt = { date: r.date, tax_code: r.taxCode, business_class: r.businessClass, purchase_use: r.purchaseUse };
      return r.taxCode && r.taxCode !== "none" ? taxShortLabel(r.taxCode, r.invoiceKind, r.date, displayClass(b.taxYears, lt), displayUse(b.taxYears, lt)) : "";
    },
    subName: (id: number | null) => (id ? sn.get(id) ?? "" : ""),
    /** 科目（補助科目）の期首残高。損益の科目は 0 */
    baseOf: (a: Account, s?: number | null) => (!isBalanceSheet(a.category) ? 0 : s === undefined ? b.opening[a.id] ?? 0 : b.subOpening[subKey(a.id, s)] ?? 0),
    /** 残高か動きがある科目（区分の順） */
    targets: () => LEDGER_ORDER.flatMap((c) => b.accounts.filter((a) => a.category === c && (used.has(a.id) || (balances.get(a.id) ?? 0) !== 0))),
  };
};

/** 1つの科目の元帳の CSV の行（printBooks の ledgerCsvRows に、元帳の関数を渡す） */
const ledgerCsvRowsOf = (a: Account, h: ReturnType<typeof ledgerHelpers>, s: { rows: LedgerRow[]; opening: number; from: number; to: number }) =>
  ledgerCsvRows(a.name, { ...s, counterOf: h.counterOf, taxOf: h.taxOf }, (r) => h.subName(r.subId), (r) => h.cpOfEntry.get(r.entry_id) ?? "");

/** 総勘定元帳の CSV の行（残高か動きがある科目すべて。期間は 1〜13） */
export const ledgerCsvAll = (b: BookSource, from: number, to: number): CsvValue[][] => {
  const h = ledgerHelpers(b);
  const accountMap = new Map(b.accounts.map((a) => [a.id, a]));
  return h.targets().flatMap((a) =>
    ledgerCsvRowsOf(a, h, { rows: buildLedger(a, h.baseOf(a), b.lines, accountMap), opening: h.baseOf(a), from, to }));
};

// ────────────────────────────────────────────
// 残高試算表
// ────────────────────────────────────────────

export type StatementView = "bs" | "pl";
export const VIEW_LABEL: Record<StatementView, string> = { bs: "貸借対照表", pl: "損益計算書" };

/** 残高試算表の行（区分の見出し・科目・補助科目・小計、最後に所得金額）。期間は 1〜13 */
export const trialLines = (
  view: StatementView, b: Pick<BookSource, "accounts" | "subs" | "opening" | "subOpening" | "lines">, from: number, to: number,
  opts: { showSubs: boolean; hideZero: boolean },
): TrialPrintLine[] => {
  const rows = buildTrialBalance(b.accounts, b.opening, b.lines, from, to);
  const toBalances = (pick: (r: TrialBalanceRow) => number) => new Map(rows.map((r) => [r.account.id, pick(r)]));
  const incomeCarried = summarizeIncome(b.accounts, toBalances((r) => r.carried)).income;
  const incomeEnd = summarizeIncome(b.accounts, toBalances((r) => r.balance)).income;
  const isEmpty = (r: TrialBalanceRow) => r.carried === 0 && r.debit === 0 && r.credit === 0 && r.balance === 0;
  const amounts = (r: TrialBalanceRow) => ({ carried: r.carried, debit: r.debit, credit: r.credit, balance: r.balance });
  const subtotal = (cat: AccountCategory) =>
    rows.filter((r) => r.account.category === cat).reduce(
      (t, r) => {
        // 期末商品棚卸高は原価のマイナスとして集計
        const sign = cat === "cogs" && r.account.normal_side === "credit" ? -1 : 1;
        return { carried: t.carried + sign * r.carried, debit: t.debit + r.debit, credit: t.credit + r.credit, balance: t.balance + sign * r.balance };
      },
      { carried: 0, debit: 0, credit: 0, balance: 0 },
    );
  const out: TrialPrintLine[] = [];
  for (const cat of view === "bs" ? BS_CATEGORIES : PL_CATEGORIES) {
    out.push({ kind: "category", label: CATEGORY_LABEL[cat], carried: 0, debit: 0, credit: 0, balance: 0 });
    for (const r of rows.filter((x) => x.account.category === cat && !(opts.hideZero && isEmpty(x)))) {
      out.push({ kind: "account", label: r.account.name, ...amounts(r) });
      const subs = opts.showSubs ? b.subs.filter((x) => x.account_id === r.account.id) : [];
      if (subs.length === 0) continue;
      const sub = (id: number | null) => subTrialRow(r.account, id, b.subOpening, b.lines, from, to);
      for (const [label, row] of [...subs.map((x) => [x.name, sub(x.id)] as const), ["補助なし", sub(null)] as const])
        if (!(opts.hideZero && isEmpty(row))) out.push({ kind: "sub", label, ...amounts(row) });
    }
    out.push({ kind: "subtotal", label: `${CATEGORY_LABEL[cat]}合計`, ...subtotal(cat) });
  }
  out.push({
    kind: "total", label: view === "bs" ? "所得金額（当期の利益）" : "青色申告特別控除前の所得金額",
    carried: incomeCarried, debit: 0, credit: 0, balance: incomeEnd, middle: `期間中 ${yen(incomeEnd - incomeCarried)}`,
  });
  return out;
};

/** 残高試算表の CSV の行。区分は「貸借対照表・資産」など。補助科目の行は科目の名前も入れる */
export const trialCsvRows = (view: StatementView, lines: TrialPrintLine[]): CsvValue[][] => {
  let cat = "";
  let parent = "";
  return lines.flatMap((l) => {
    if (l.kind === "category") cat = l.label;
    if (l.kind === "account") parent = l.label;
    if (l.kind === "category") return [];
    if (l.kind === "total") return [[VIEW_LABEL[view], l.label, "", l.carried, "", "", l.balance]];
    return [[`${VIEW_LABEL[view]}・${cat}`, l.kind === "sub" ? parent : l.label, l.kind === "sub" ? l.label : "", l.carried, l.debit, l.credit, l.balance]];
  });
};

// ────────────────────────────────────────────
// 固定資産台帳
// ────────────────────────────────────────────

const ymd = (iso: string) => iso.replace(/-/g, "/");

/** その年に償却する（台帳に出す）資産と、その年の償却の計算 */
export const assetsOfYear = (assets: FixedAsset[], year: number) =>
  assets.map((a) => ({ a, d: depreciationFor(a, year) })).filter((r) => r.d && !(r.d.opening === 0 && r.d.depreciation === 0)) as
    { a: FixedAsset; d: NonNullable<ReturnType<typeof depreciationFor>> }[];

/** 固定資産台帳の印刷・CSV の1行 */
export const assetPrintLine = (a: FixedAsset, d: NonNullable<ReturnType<typeof depreciationFor>>, accountName: (id: number) => string): AssetPrintLine => ({
  name: a.name, account: accountName(a.account_id), acquired: a.acquired_on, used: a.used_on, cost: a.cost, method: methodLabel(a),
  life: a.method === "straight" || a.method === "declining" ? `${a.useful_life}年` : a.method === "lump3" ? "3年" : "—", rate: d.rate !== null ? d.rate.toFixed(3) : "—",
  months: d.months, opening: d.opening, depreciation: d.depreciation, businessRate: d.businessRate, business: d.business, closing: d.closing,
  memo: [d.disposed ? `${ymd(a.disposed_on!)} 売却・除却` : "", a.memo].filter(Boolean).join("　"),
});
