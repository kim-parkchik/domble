/**
 * 青色申告決算書の2〜3ページの集計（純粋関数）
 *  - 月別の売上（収入）金額と仕入金額
 *  - 支払先ごとの内訳（給料賃金・専従者給与・利子割引料・地代家賃・税理士等の報酬）
 * 支払先は、仕訳の取引先 → 明細の補助科目 → どちらも無ければ「支払先の指定なし」の順で決める
 */
import type { FlatLine } from "./accounting";
import type { Account } from "./types";
import { splitByRate } from "./homeUse";
import { CODE } from "../constants/accounts";

export interface MonthlySales {
  /** 1〜12月（添字 0 = 1月） */
  sales: number[];
  purchases: number[];
  /** 家事消費等・雑収入（年間） */
  householdUse: number;
  miscIncome: number;
}

const net = (l: FlatLine, normal: "debit" | "credit") => (l.side === normal ? l.amount : -l.amount);

/** 月別の売上（収入）金額と仕入金額。売上は家事消費等・雑収入を除く収益の科目、仕入は仕入高 */
export const monthlySales = (accounts: Account[], lines: FlatLine[]): MonthlySales => {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const r: MonthlySales = { sales: Array(12).fill(0), purchases: Array(12).fill(0), householdUse: 0, miscIncome: 0 };
  for (const l of lines) {
    const a = byId.get(l.account_id);
    if (!a) continue;
    const m = Number(l.date.slice(5, 7)) - 1;
    if (a.code === CODE.HOUSEHOLD_USE) r.householdUse += net(l, "credit");
    else if (a.code === CODE.MISC_INCOME) r.miscIncome += net(l, "credit");
    else if (a.category === "revenue") r.sales[m] += net(l, "credit");
    else if (a.code === CODE.PURCHASES) r.purchases[m] += net(l, "debit");
  }
  return r;
};

export interface PayeeRow {
  /** cp:取引先ID / sub:補助科目ID / none */
  key: string;
  counterpartyId: number | null;
  subId: number | null;
  /** 本年中の支払額（家事分を含む） */
  gross: number;
  /** 左のうち必要経費に入れる額 */
  business: number;
}

/**
 * 科目ごとの支払先の内訳
 * 家事按分：
 *  - 入力のたびに分ける科目は、同じ仕訳の「事業主貸（〜家事分）」を支払額に足し戻す（必要経費は分けたあとの額）
 *  - 年末にまとめる科目は、支払先ごとに割合で分ける（年末の振替の仕訳そのものは数えない）
 * @param excludeEntryIds 数えない仕訳（家事按分の年末の振替・減価償却の仕訳）
 */
export const payeeBreakdown = (
  accountId: number,
  lines: FlatLine[],
  opts: { drawId: number; yearEndRate?: number | null; excludeEntryIds?: number[] },
): PayeeRow[] => {
  const exclude = new Set(opts.excludeEntryIds ?? []);
  const byEntry = new Map<number, FlatLine[]>();
  for (const l of lines) {
    if (exclude.has(l.entry_id)) continue;
    byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  }
  const rows = new Map<string, PayeeRow>();
  for (const ls of byEntry.values()) {
    for (const l of ls) {
      if (l.account_id !== accountId) continue;
      const cp = l.counterparty_id ?? null;
      const key = cp ? `cp:${cp}` : l.sub_account_id ? `sub:${l.sub_account_id}` : "none";
      const row = rows.get(key) ?? { key, counterpartyId: cp, subId: cp ? null : l.sub_account_id, gross: 0, business: 0 };
      const amount = net(l, "debit");
      row.gross += amount;
      row.business += amount;
      // 入力のたびに分けた家事分（同じ仕訳の事業主貸。摘要は元の摘要＋「（家事分）」）
      if (l.side === "debit") {
        const privateMemo = l.memo ? `${l.memo}（家事分）` : "家事分";
        const priv = ls.find((x) => x.account_id === opts.drawId && x.side === "debit" && x.memo === privateMemo);
        if (priv) row.gross += priv.amount;
      }
      rows.set(key, row);
    }
  }
  const out = [...rows.values()].filter((r) => r.gross !== 0);
  if (opts.yearEndRate != null && opts.yearEndRate < 100) {
    for (const r of out) r.business = splitByRate(Math.max(0, r.gross), opts.yearEndRate).business;
  }
  return out.sort((a, b) => b.gross - a.gross);
};

export interface PartnerRow {
  /** cp:取引先ID / sub:補助科目ID */
  key: string;
  counterpartyId: number | null;
  subId: number | null;
  amount: number;
}

/**
 * 売上先・仕入先ごとの金額（決算書の「売上（収入）金額の明細」「仕入金額の明細」）。多い順
 * 相手は、仕訳の取引先 → 明細の補助科目の順で決める。どちらも無い明細は数えない（明細の「上記以外」に入る）
 * @param side 売上は貸方（credit）、仕入は借方（debit）を足し、反対側は引く
 */
export const partnerTotals = (accountIds: number[], lines: FlatLine[], side: "debit" | "credit"): PartnerRow[] => {
  const ids = new Set(accountIds);
  const rows = new Map<string, PartnerRow>();
  for (const l of lines) {
    if (!ids.has(l.account_id)) continue;
    const cp = l.counterparty_id ?? null;
    if (!cp && !l.sub_account_id) continue;
    const key = cp ? `cp:${cp}` : `sub:${l.sub_account_id}`;
    const row = rows.get(key) ?? { key, counterpartyId: cp, subId: cp ? null : l.sub_account_id, amount: 0 };
    row.amount += net(l, side);
    rows.set(key, row);
  }
  return [...rows.values()].filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
};
