/**
 * グラフの数字（月ごとの推移・経費と売上の内訳・現金と預金・目盛り）
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, Counterparty, SubAccount } from "./types";
import { closingBalances, type FlatLine } from "./accounting";
import { cashFlow, cumulative, expenseBreakdown, monthPoints, niceTicks, revenueBreakdown, tickLabel } from "./charts";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
let seq = 0;
/** 1つの仕訳（借方・貸方の組を並べる） */
const entry = (date: string, pairs: [string, string, number][], o: { adjustment?: boolean; counterparty?: number | null; sub?: number | null } = {}): FlatLine[] => {
  const e = ++seq;
  return pairs.flatMap(([dr, cr, amount], i) => [
    { entry_id: e, date, description: "", row_no: i + 1, side: "debit" as const, account_id: id(dr), sub_account_id: null, amount, memo: "", is_adjustment: o.adjustment ? 1 : 0, counterparty_id: o.counterparty ?? null },
    { entry_id: e, date, description: "", row_no: i + 1, side: "credit" as const, account_id: id(cr), sub_account_id: cr === "売上高" ? o.sub ?? null : null, amount, memo: "", is_adjustment: o.adjustment ? 1 : 0, counterparty_id: o.counterparty ?? null },
  ]);
};

describe("月ごとの推移", () => {
  const lines = [
    ...entry("2026-01-10", [["普通預金", "売上高", 300_000]]),
    ...entry("2026-01-20", [["通信費", "普通預金", 10_000]]),
    ...entry("2026-02-05", [["仕入高", "普通預金", 120_000]]),
    ...entry("2026-12-31", [["減価償却費", "工具器具備品", 50_000]], { adjustment: true }),
  ];
  test("月ごとの売上・経費・所得。決算整理の仕訳は 13（決算整理）に分ける", () => {
    const p = monthPoints(accounts, lines);
    expect(p).toHaveLength(13);
    expect(p[0]).toEqual({ period: 1, revenue: 300_000, costs: 10_000, income: 290_000 });
    expect(p[1]).toEqual({ period: 2, revenue: 0, costs: 120_000, income: -120_000 });
    expect(p[11]).toEqual({ period: 12, revenue: 0, costs: 0, income: 0 });
    expect(p[12]).toEqual({ period: 13, revenue: 0, costs: 50_000, income: -50_000 });
    expect(monthPoints(accounts, lines.filter((l) => !l.is_adjustment))).toHaveLength(12);
  });
  test("累計", () => {
    const c = cumulative(monthPoints(accounts, lines));
    expect([c[0].income, c[1].income, c[12].income]).toEqual([290_000, 170_000, 120_000]);
  });
});

describe("経費の内訳", () => {
  const lines = [
    ...entry("2026-03-01", [["仕入高", "普通預金", 500_000]]),
    ...entry("2026-03-02", [["通信費", "普通預金", 60_000], ["減価償却費", "工具器具備品", 90_000], ["専従者給与", "普通預金", 30_000]]),
    ...entry("2026-12-31", [["貸倒引当金", "貸倒引当金戻入", 5_000]], { adjustment: true }),
  ];
  // 期末商品棚卸高 200,000（売上原価から引く）
  lines.push(...entry("2026-12-31", [["棚卸資産", "期末商品棚卸高", 200_000]], { adjustment: true }));
  const end = closingBalances(accounts, {}, lines);

  test("売上原価を1つにまとめ、大きい順に。繰戻額等はマイナスの行で最後。割合は経費の合計に対して", () => {
    const b = expenseBreakdown(accounts, end, null);
    expect(b.items.map((i) => [i.label, i.amount])).toEqual([["売上原価", 300_000], ["減価償却費", 90_000], ["通信費", 60_000], ["専従者給与", 30_000], ["貸倒引当金戻入", -5_000]]);
    expect(b.total).toBe(475_000);
    expect(b.items[0].share).toBeCloseTo((300_000 / 475_000) * 100);
    expect(b.prevTotal).toBeNull();
  });
  test("上位のほかは「そのほか」にまとめる。前年の額も並べる", () => {
    const prevEnd = closingBalances(accounts, {}, entry("2025-05-01", [["通信費", "普通預金", 40_000], ["旅費交通費", "普通預金", 7_000]]));
    const b = expenseBreakdown(accounts, end, prevEnd, 2);
    expect(b.items.map((i) => [i.label, i.amount, i.prev, i.others])).toEqual([
      ["売上原価", 300_000, 0, undefined], ["減価償却費", 90_000, 0, undefined], ["そのほか", 90_000, 47_000, 3], ["貸倒引当金戻入", -5_000, 0, undefined],
    ]);
    expect(b.prevTotal).toBe(47_000);
  });
});

describe("売上の内訳", () => {
  const cps = [{ id: 1, name: "株式会社エー" }, { id: 2, name: "ビー商店" }] as Counterparty[];
  const subs = [{ id: 7, account_id: id("売上高"), name: "ネット販売" }] as SubAccount[];
  test("取引先ごと。取引先の無い売上は「取引先なし」。返品は差し引く。前年も同じ取引先で", () => {
    const lines = [
      ...entry("2026-01-10", [["売掛金", "売上高", 500_000]], { counterparty: 1 }),
      ...entry("2026-02-10", [["売掛金", "売上高", 200_000]], { counterparty: 2 }),
      ...entry("2026-02-20", [["売上高", "売掛金", 20_000]], { counterparty: 2 }),
      ...entry("2026-03-01", [["現金", "雑収入", 3_000]]),
    ];
    const prev = entry("2025-06-01", [["売掛金", "売上高", 100_000]], { counterparty: 2 });
    const b = revenueBreakdown(accounts, subs, cps, lines, prev);
    expect(b.by).toBe("counterparty");
    expect(b.items.map((i) => [i.label, i.amount, i.prev])).toEqual([["株式会社エー", 500_000, 0], ["ビー商店", 180_000, 100_000], ["取引先なし", 3_000, 0]]);
    expect(b.total).toBe(683_000);
  });
  test("取引先を使っていなければ、科目（補助科目）ごと", () => {
    const lines = [...entry("2026-01-10", [["普通預金", "売上高", 80_000]], { sub: 7 }), ...entry("2026-01-11", [["普通預金", "売上高", 20_000]])];
    const b = revenueBreakdown(accounts, subs, cps, lines, null);
    expect(b.by).toBe("account");
    expect(b.items.map((i) => [i.label, i.amount, i.prev])).toEqual([["売上高・ネット販売", 80_000, null], ["売上高", 20_000, null]]);
  });
});

describe("現金・預金", () => {
  test("月末残高と入金・出金。預け入れ（現金 → 普通預金）は入金にも出金にも数えない。使っていない科目は出さない", () => {
    const opening = { [id("現金")]: 50_000, [id("普通預金")]: 1_000_000 };
    const lines = [
      ...entry("2026-01-10", [["普通預金", "売上高", 300_000]]),
      ...entry("2026-01-15", [["普通預金", "現金", 40_000]]),
      ...entry("2026-02-01", [["通信費", "現金", 5_000]]),
      // 同じ仕訳で、預金から引き出して一部を経費に払う
      ...entry("2026-03-01", [["現金", "普通預金", 100_000], ["消耗品費", "現金", 30_000]]),
    ];
    const c = cashFlow(accounts, opening, lines);
    expect(c.accounts.map((a) => a.name)).toEqual(["現金", "普通預金"]);
    expect([c.opening, c.openingTotal]).toEqual([[50_000, 1_000_000], 1_050_000]);
    expect(c.months[0]).toEqual({ month: 1, inflow: 300_000, outflow: 0, balances: [10_000, 1_340_000], total: 1_350_000 });
    expect(c.months[1]).toMatchObject({ inflow: 0, outflow: 5_000, balances: [5_000, 1_340_000] });
    expect(c.months[2]).toMatchObject({ inflow: 0, outflow: 30_000, balances: [75_000, 1_240_000], total: 1_315_000 });
    expect(c.months[11].total).toBe(1_315_000);
  });
});

describe("目盛り", () => {
  test("0 を含む、きりのよい間隔", () => {
    expect(niceTicks(0, 1_234_567)).toEqual([0, 250_000, 500_000, 750_000, 1_000_000, 1_250_000]);
    expect(niceTicks(-120_000, 300_000)).toEqual([-200_000, -100_000, 0, 100_000, 200_000, 300_000]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect([tickLabel(1_250_000, 250_000), tickLabel(2_500, 500)]).toEqual(["125万", "2,500"]);
  });
});
