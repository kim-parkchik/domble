/**
 * グラフの数字（純粋関数。グラフの画面）
 *  - 月ごとの推移：月（1〜12）と決算整理ごとの売上・経費・所得（残高試算表の月次推移表と同じ分け方。経費は売上原価・経費・繰入額等から繰戻額等を引いた額）。累計にもする
 *  - 経費の内訳：売上原価（期首・仕入・期末をまとめて1つ）と、経費・繰入額等の科目ごとの額。大きい順に、上位のほかは「そのほか」。
 *    繰戻額等（貸倒引当金戻入など）は経費から引くマイナスの行。割合は経費の合計に対して
 *  - 売上の内訳：取引先ごと（取引先の無い売上は「取引先なし」）。どの売上にも取引先が無ければ、科目（補助科目）ごと
 *  - 現金・預金：科目ごとの月末残高と、月ごとの入金・出金。1つの仕訳の中の現金・預金どうしの動き（預け入れ・引き出し）は差し引いて、入金にも出金にも数えない
 * 明細は帳簿の明細（税抜経理の年は税抜き。lib/taxExclusive.ts の bookLines の後）を受け取る
 */
import type { Account, Counterparty, OpeningBalances, SubAccount } from "./types";
import { ADJUSTMENT_PERIOD, periodOfLine, signedAmount, summarizeIncome, type FlatLine } from "./accounting";

/** 現金・預金の科目（ホームの残高と同じ：現金・当座預金・普通預金・定期預金） */
export const MONEY_CODES = ["101", "102", "103", "104"];

// ────────────────────────────────────────────
// 月ごとの推移
// ────────────────────────────────────────────

export interface MonthPoint {
  /** 1〜12 = 月、13 = 決算整理 */
  period: number;
  revenue: number;
  /** 経費・原価（売上原価＋経費＋繰入額等−繰戻額等） */
  costs: number;
  income: number;
}

const periodBalances = (accounts: Account[], lines: FlatLine[]) => {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const maps = new Map<number, Map<number, number>>();
  for (const l of lines) {
    const a = byId.get(l.account_id);
    if (!a) continue;
    const p = periodOfLine(l);
    const m = maps.get(p) ?? new Map<number, number>();
    m.set(a.id, (m.get(a.id) ?? 0) + signedAmount(a, l.side, l.amount));
    maps.set(p, m);
  }
  return maps;
};

/** 月（1〜12）ごとの売上・経費・所得。決算整理の仕訳があれば 13（決算整理）も足す */
export const monthPoints = (accounts: Account[], lines: FlatLine[]): MonthPoint[] => {
  const maps = periodBalances(accounts, lines);
  const periods = [...Array.from({ length: 12 }, (_, i) => i + 1), ...(maps.has(ADJUSTMENT_PERIOD) ? [ADJUSTMENT_PERIOD] : [])];
  return periods.map((period) => {
    const s = summarizeIncome(accounts, maps.get(period) ?? new Map());
    return { period, revenue: s.revenue, costs: s.cogs + s.expenses + s.special, income: s.income };
  });
};

/** 累計（その月までの合計） */
export const cumulative = (points: MonthPoint[]): MonthPoint[] => {
  let r = 0, c = 0, i = 0;
  return points.map((p) => ({ period: p.period, revenue: (r += p.revenue), costs: (c += p.costs), income: (i += p.income) }));
};

export const periodLabel = (p: number) => (p === ADJUSTMENT_PERIOD ? "決算整理" : `${p}月`);

// ────────────────────────────────────────────
// 内訳（経費・売上）
// ────────────────────────────────────────────

export interface BreakdownItem {
  key: string;
  label: string;
  amount: number;
  /** 前年の額（前年の帳簿が無ければ null） */
  prev: number | null;
  /** 合計に対する割合（%。合計が 0 以下なら null） */
  share: number | null;
  /** まとめた「そのほか」の件数 */
  others?: number;
}

export interface Breakdown {
  items: BreakdownItem[];
  total: number;
  prevTotal: number | null;
}

/** 大きい順に並べ、top 件を超えた分（プラスのもの）を「そのほか」にまとめる。マイナスの行はそのまま最後に */
const rank = (rows: { key: string; label: string; amount: number; prev: number | null }[], top: number, hasPrev: boolean): Breakdown => {
  const total = rows.reduce((t, r) => t + r.amount, 0);
  const prevTotal = hasPrev ? rows.reduce((t, r) => t + (r.prev ?? 0), 0) : null;
  const share = (n: number) => (total > 0 ? (n / total) * 100 : null);
  const plus = rows.filter((r) => r.amount > 0 || (r.amount === 0 && (r.prev ?? 0) !== 0)).sort((a, b) => b.amount - a.amount || (b.prev ?? 0) - (a.prev ?? 0));
  const minus = rows.filter((r) => r.amount < 0).sort((a, b) => a.amount - b.amount);
  const shown = plus.slice(0, top);
  const rest = plus.slice(top);
  const items: BreakdownItem[] = shown.map((r) => ({ ...r, prev: hasPrev ? r.prev ?? 0 : null, share: share(r.amount) }));
  if (rest.length) {
    const amount = rest.reduce((t, r) => t + r.amount, 0);
    items.push({
      key: "_others", label: "そのほか", amount, prev: hasPrev ? rest.reduce((t, r) => t + (r.prev ?? 0), 0) : null, share: share(amount), others: rest.length,
    });
  }
  for (const r of minus) items.push({ ...r, prev: hasPrev ? r.prev ?? 0 : null, share: share(r.amount) });
  return { items, total, prevTotal };
};

/**
 * 経費の内訳。end・prevEnd は科目ごとの期末の残高（残高の側を＋。closingBalances）。前年が無ければ prevEnd は null
 * top：棒にする件数（ほかは「そのほか」）
 */
export const expenseBreakdown = (accounts: Account[], end: Map<number, number>, prevEnd: Map<number, number> | null, top = 10): Breakdown => {
  const cogs = (m: Map<number, number>) => summarizeIncome(accounts, m).cogs;
  const rows: { key: string; label: string; amount: number; prev: number | null }[] = [];
  const c = cogs(end), pc = prevEnd ? cogs(prevEnd) : null;
  if (c !== 0 || (pc ?? 0) !== 0) rows.push({ key: "_cogs", label: "売上原価", amount: c, prev: pc });
  for (const a of accounts.filter((x) => x.category === "expense" || x.category === "special")) {
    // 繰戻額等（貸方の繰入額等の科目）は経費から引く
    const sign = a.category === "special" && a.normal_side === "credit" ? -1 : 1;
    const amount = sign * (end.get(a.id) ?? 0) || 0;
    const prev = prevEnd ? sign * (prevEnd.get(a.id) ?? 0) || 0 : null;
    if (amount !== 0 || (prev ?? 0) !== 0) rows.push({ key: String(a.id), label: a.name, amount, prev });
  }
  return rank(rows, top, !!prevEnd);
};

/**
 * 売上の内訳（売上の区分の科目）。取引先ごと、どの売上にも取引先が無ければ科目（補助科目）ごと。
 * prevLines は前年の明細（前年の帳簿が無ければ null）
 */
export const revenueBreakdown = (
  accounts: Account[], subs: SubAccount[], counterparties: Counterparty[], lines: FlatLine[], prevLines: FlatLine[] | null, top = 10,
): Breakdown & { by: "counterparty" | "account" } => {
  const revenue = new Map(accounts.filter((a) => a.category === "revenue").map((a) => [a.id, a]));
  const mine = (ls: FlatLine[]) => ls.filter((l) => revenue.has(l.account_id));
  const cur = mine(lines);
  const prev = prevLines ? mine(prevLines) : null;
  const by = cur.some((l) => l.counterparty_id) ? "counterparty" : "account";
  const cpName = new Map(counterparties.map((c) => [c.id, c.name]));
  const subName = new Map(subs.map((s) => [s.id, s.name]));
  const keyOf = (l: FlatLine): [string, string] => {
    if (by === "counterparty") return l.counterparty_id ? [`c${l.counterparty_id}`, cpName.get(l.counterparty_id) ?? "（取引先）"] : ["c0", "取引先なし"];
    const a = revenue.get(l.account_id)!;
    return l.sub_account_id ? [`s${l.sub_account_id}`, `${a.name}・${subName.get(l.sub_account_id) ?? "補助科目"}`] : [`a${a.id}`, a.name];
  };
  const rows = new Map<string, { key: string; label: string; amount: number; prev: number | null }>();
  const add = (ls: FlatLine[], field: "amount" | "prev") => {
    for (const l of ls) {
      const [key, label] = keyOf(l);
      const r = rows.get(key) ?? { key, label, amount: 0, prev: prev ? 0 : null };
      r[field] = (r[field] ?? 0) + signedAmount(revenue.get(l.account_id)!, l.side, l.amount);
      rows.set(key, r);
    }
  };
  add(cur, "amount");
  if (prev) add(prev, "prev");
  return { ...rank([...rows.values()].filter((r) => r.amount !== 0 || (r.prev ?? 0) !== 0), top, !!prev), by };
};

// ────────────────────────────────────────────
// 現金・預金
// ────────────────────────────────────────────

export interface CashMonth {
  month: number;
  /** 入金・出金（現金・預金どうしの動きは除く） */
  inflow: number;
  outflow: number;
  /** 科目ごとの月末残高（accounts の順） */
  balances: number[];
  total: number;
}

export interface CashFlow {
  accounts: Account[];
  /** 科目ごとの期首残高と合計 */
  opening: number[];
  openingTotal: number;
  months: CashMonth[];
}

/** 現金・預金の科目ごとの月末残高と、月ごとの入金・出金。使っていない科目（残高も動きも無い）は出さない */
export const cashFlow = (accounts: Account[], opening: OpeningBalances, lines: FlatLine[]): CashFlow => {
  const money = accounts.filter((a) => MONEY_CODES.includes(a.code));
  const ids = new Set(money.map((a) => a.id));
  const moneyLines = lines.filter((l) => ids.has(l.account_id));
  const used = money.filter((a) => (opening[a.id] ?? 0) !== 0 || moneyLines.some((l) => l.account_id === a.id));
  const signed = (l: FlatLine) => signedAmount(money.find((a) => a.id === l.account_id)!, l.side, l.amount);
  // 仕訳ごとの現金・預金の増減（同じ仕訳の中の預け入れ・引き出しは差し引かれる）
  const byEntry = new Map<number, { month: number; net: number }>();
  for (const l of moneyLines) {
    const e = byEntry.get(l.entry_id) ?? { month: Number(l.date.slice(5, 7)), net: 0 };
    e.net += signed(l);
    byEntry.set(l.entry_id, e);
  }
  const openingBy = used.map((a) => opening[a.id] ?? 0);
  const running = [...openingBy];
  const months: CashMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const inMonth = moneyLines.filter((l) => Number(l.date.slice(5, 7)) === m);
    used.forEach((a, i) => {
      running[i] += inMonth.filter((l) => l.account_id === a.id).reduce((t, l) => t + signed(l), 0);
    });
    const nets = [...byEntry.values()].filter((e) => e.month === m).map((e) => e.net);
    months.push({
      month: m,
      inflow: nets.filter((n) => n > 0).reduce((t, n) => t + n, 0),
      outflow: nets.filter((n) => n < 0).reduce((t, n) => t - n, 0),
      balances: [...running],
      total: running.reduce((t, n) => t + n, 0),
    });
  }
  return { accounts: used, opening: openingBy, openingTotal: openingBy.reduce((t, n) => t + n, 0), months };
};

// ────────────────────────────────────────────
// 目盛り
// ────────────────────────────────────────────

/** 0 を含む、きりのよい目盛り（4〜6本）。min・max は表す値の範囲 */
export const niceTicks = (min: number, max: number): number[] => {
  const lo = Math.min(0, min), hi = Math.max(0, max);
  if (lo === hi) return [0, 1];
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
};

/** 目盛りの文字（1万円以上は「万」） */
export const tickLabel = (v: number, step: number) =>
  step >= 10_000 ? `${(v / 10_000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : v.toLocaleString("ja-JP");
