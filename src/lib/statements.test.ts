import { describe, expect, test } from "bun:test";
import { monthlySales, payeeBreakdown } from "./statements";
import type { FlatLine } from "./accounting";
import type { Account } from "./types";

const acc = (id: number, code: string, category: Account["category"]) => ({ id, code, category }) as Account;
const accounts = [acc(1, "101", "asset"), acc(2, "401", "revenue"), acc(3, "402", "revenue"), acc(4, "403", "revenue"), acc(5, "502", "cogs"), acc(6, "616", "expense"), acc(9, "190", "asset"), acc(7, "405", "revenue")];
let n = 0;
const fl = (entry_id: number, date: string, side: FlatLine["side"], account_id: number, amount: number, more: Partial<FlatLine> = {}): FlatLine =>
  ({ entry_id, date, description: "", row_no: ++n, side, account_id, sub_account_id: null, amount, memo: "", counterparty_id: null, ...more });

describe("月別の売上・仕入", () => {
  test("売上は家事消費等・雑収入を除く収益（追加した収益の科目も含む）。返品は差し引く。仕入は仕入高", () => {
    const r = monthlySales(accounts, [
      fl(1, "2026-01-10", "credit", 2, 10_000), fl(1, "2026-01-10", "debit", 1, 10_000),
      fl(2, "2026-01-20", "debit", 2, 1_000), fl(3, "2026-03-05", "credit", 7, 500),
      fl(4, "2026-12-31", "credit", 3, 2_000), fl(5, "2026-06-01", "credit", 4, 300),
      fl(6, "2026-02-01", "debit", 5, 4_000),
    ]);
    expect(r.sales.slice(0, 3)).toEqual([9_000, 0, 500]);
    expect(r.purchases[1]).toBe(4_000);
    expect([r.householdUse, r.miscIncome]).toEqual([2_000, 300]);
  });
});

describe("支払先ごとの内訳", () => {
  test("取引先 → 補助科目 → 指定なし の順にまとめる", () => {
    const rows = payeeBreakdown(6, [
      fl(1, "2026-01-31", "debit", 6, 50_000, { counterparty_id: 3 }), fl(2, "2026-02-28", "debit", 6, 50_000, { counterparty_id: 3, sub_account_id: 8 }),
      fl(3, "2026-03-31", "debit", 6, 20_000, { sub_account_id: 8 }), fl(4, "2026-04-30", "debit", 6, 5_000),
    ], { drawId: 9 });
    expect(rows.map((r) => [r.key, r.gross, r.business])).toEqual([["cp:3", 100_000, 100_000], ["sub:8", 20_000, 20_000], ["none", 5_000, 5_000]]);
  });

  test("入力のたびに分けた家事分は支払額に足し戻す。年末にまとめる科目は割合で分け、振替の仕訳は数えない", () => {
    const entry = payeeBreakdown(6, [
      fl(1, "2026-01-31", "debit", 6, 60_000, { counterparty_id: 3, memo: "家賃" }), fl(1, "2026-01-31", "debit", 9, 40_000, { counterparty_id: 3, memo: "家賃（家事分）" }),
      fl(1, "2026-01-31", "credit", 1, 100_000, { counterparty_id: 3, memo: "家賃" }),
    ], { drawId: 9 });
    expect(entry.map((r) => [r.gross, r.business])).toEqual([[100_000, 60_000]]);
    const yearEnd = payeeBreakdown(6, [
      fl(1, "2026-01-31", "debit", 6, 100_001, { counterparty_id: 3 }),
      fl(99, "2026-12-31", "credit", 6, 40_000), fl(99, "2026-12-31", "debit", 9, 40_000),
    ], { drawId: 9, yearEndRate: 60, excludeEntryIds: [99] });
    expect(yearEnd.map((r) => [r.gross, r.business])).toEqual([[100_001, 60_000]]);
  });
});
