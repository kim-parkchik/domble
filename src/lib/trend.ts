/**
 * 月次推移表・前年比較（純粋関数。残高試算表の画面）
 *  - 月次推移：期間（from〜to。13 = 決算整理）ごとの列。損益の科目は期間ごとの発生額（科目の残高の側を＋）と合計、
 *    貸借の科目は最初に繰越（期首・前月末の残高）、そのあと期間ごとに末の残高
 *  - 前年比較：表示中の期間（from〜to）の今年と前年。損益は期間の発生額、貸借は期間の末の残高。差額と増減率
 *  - 区分の見出し・科目・補助科目・区分の小計（残高試算表と同じく、期末商品棚卸高のように残高の側が逆の売上原価の科目は引く）、最後に所得金額
 *    （損益は期間ごとの所得、貸借は期間の末までの所得＝当期の利益）
 */
import type { Account, AccountCategory, OpeningBalances, SubAccount, SubOpeningBalances } from "./types";
import { ADJUSTMENT_PERIOD, buildTrialBalance, subTrialRow, summarizeIncome, type FlatLine, type TrialBalanceRow } from "./accounting";
import { BS_CATEGORIES, CATEGORY_LABEL, PL_CATEGORIES } from "../constants/accounts";

export type StatementView = "bs" | "pl";

/** 表の1行（values は列ごとの金額） */
export interface MultiLine {
  kind: "category" | "account" | "sub" | "subtotal" | "total";
  label: string;
  values: number[];
}

/** 1年分の帳簿（期首残高と明細） */
export interface BookData {
  opening: OpeningBalances;
  subOpening: SubOpeningBalances;
  lines: FlatLine[];
}

export interface StatementOptions {
  showSubs: boolean;
  /** 金額が全部 0 の科目・補助科目を隠す */
  hideZero: boolean;
}

const periodsOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const moved = (r: TrialBalanceRow) => r.balance - r.carried;

/** 区分の見出し・科目・補助科目・小計を並べ、最後に所得金額の行を足す */
const statementLines = (
  view: StatementView, accounts: Account[], subs: SubAccount[], opts: StatementOptions,
  valuesOf: (account: Account, subId?: number | null) => number[], income: number[], incomeLabel: string,
): MultiLine[] => {
  const out: MultiLine[] = [];
  const width = income.length;
  const zero = (v: number[]) => v.every((x) => x === 0);
  for (const cat of view === "bs" ? BS_CATEGORIES : PL_CATEGORIES) {
    out.push({ kind: "category", label: CATEGORY_LABEL[cat], values: [] });
    const subtotal = Array<number>(width).fill(0);
    for (const a of accounts.filter((x) => x.category === cat)) {
      const v = valuesOf(a);
      const sign = cat === "cogs" && a.normal_side === "credit" ? -1 : 1;
      v.forEach((x, i) => (subtotal[i] += sign * x));
      if (opts.hideZero && zero(v)) continue;
      out.push({ kind: "account", label: a.name, values: v });
      const mine = opts.showSubs ? subs.filter((s) => s.account_id === a.id) : [];
      if (!mine.length) continue;
      for (const [label, id] of [...mine.map((s) => [s.name, s.id] as const), ["補助なし", null] as const]) {
        const sv = valuesOf(a, id);
        if (!(opts.hideZero && zero(sv))) out.push({ kind: "sub", label, values: sv });
      }
    }
    out.push({ kind: "subtotal", label: `${CATEGORY_LABEL[cat as AccountCategory]}合計`, values: subtotal });
  }
  out.push({ kind: "total", label: incomeLabel, values: income });
  return out;
};

export const INCOME_LABEL: Record<StatementView, string> = { bs: "所得金額（当期の利益）", pl: "青色申告特別控除前の所得金額" };

/** 月次推移表の列の見出し（損益：期間ごと＋合計、貸借：繰越＋期間ごとの末） */
export const trendHeads = (view: StatementView, from: number, to: number): string[] => {
  const label = (p: number) => (p === ADJUSTMENT_PERIOD ? "決算整理" : `${p}月`);
  const end = (p: number) => (p === ADJUSTMENT_PERIOD ? "決算整理後" : `${p}月末`);
  return view === "pl" ? [...periodsOf(from, to).map(label), "合計"] : [from === 1 ? "期首" : end(from - 1), ...periodsOf(from, to).map(end)];
};

/** 月次推移表の行 */
export const trendLines = (view: StatementView, accounts: Account[], subs: SubAccount[], book: BookData, from: number, to: number, opts: StatementOptions): MultiLine[] => {
  const periods = periodsOf(from, to);
  // 期間ごとの試算表（科目ごとの繰越・末の残高）
  const byPeriod = periods.map((p) => new Map(buildTrialBalance(accounts, book.opening, book.lines, p, p).map((r) => [r.account.id, r])));
  const valuesOf = (a: Account, subId?: number | null) => {
    const rows = subId === undefined ? byPeriod.map((m) => m.get(a.id)!) : periods.map((p) => subTrialRow(a, subId, book.subOpening, book.lines, p, p));
    return view === "pl" ? [...rows.map(moved), rows.reduce((t, r) => t + moved(r), 0)] : [rows[0].carried, ...rows.map((r) => r.balance)];
  };
  const incomeOf = (m: Map<number, TrialBalanceRow>, pick: (r: TrialBalanceRow) => number) =>
    summarizeIncome(accounts, new Map([...m].map(([id, r]) => [id, pick(r)]))).income;
  const perPeriod = byPeriod.map((m) => incomeOf(m, moved));
  const income = view === "pl"
    ? [...perPeriod, perPeriod.reduce((t, x) => t + x, 0)]
    : [incomeOf(byPeriod[0], (r) => r.carried), ...byPeriod.map((m) => incomeOf(m, (r) => r.balance))];
  return statementLines(view, accounts, subs, opts, valuesOf, income, INCOME_LABEL[view]);
};

/** 前年比較の行（values = [今年, 前年, 差額]）。損益は期間の発生額、貸借は期間の末の残高 */
export const compareLines = (
  view: StatementView, accounts: Account[], subs: SubAccount[], current: BookData, previous: BookData, from: number, to: number, opts: StatementOptions,
): MultiLine[] => {
  const tb = (b: BookData) => new Map(buildTrialBalance(accounts, b.opening, b.lines, from, to).map((r) => [r.account.id, r]));
  const cur = tb(current);
  const prev = tb(previous);
  const pick = view === "pl" ? moved : (r: TrialBalanceRow) => r.balance;
  const pair = (c: number, p: number) => [c, p, c - p];
  const valuesOf = (a: Account, subId?: number | null) =>
    subId === undefined
      ? pair(pick(cur.get(a.id)!), pick(prev.get(a.id)!))
      : pair(pick(subTrialRow(a, subId, current.subOpening, current.lines, from, to)), pick(subTrialRow(a, subId, previous.subOpening, previous.lines, from, to)));
  const incomeOf = (m: Map<number, TrialBalanceRow>) => summarizeIncome(accounts, new Map([...m].map(([id, r]) => [id, pick(r)]))).income;
  return statementLines(view, accounts, subs, opts, valuesOf, pair(incomeOf(cur), incomeOf(prev)), INCOME_LABEL[view]);
};

/** 増減率（前年が 0 なら出さない）。前年がマイナスでも増えたら＋、減ったら ▲（金額と同じ書き方） */
export const changeRate = (current: number, previous: number): string => {
  if (previous === 0) return "";
  const rate = ((current - previous) / Math.abs(previous)) * 100;
  return `${rate < 0 ? "▲" : ""}${Math.abs(rate).toFixed(1)}%`;
};
