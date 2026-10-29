/**
 * 貸倒引当金（一括評価の繰入限度額・個別評価の額・洗替の仕訳）と、決算書の繰戻額等・繰入額等
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import { closingBalances, summarizeIncome, type FlatLine } from "./accounting";
import { allowanceAccounts, allowanceCalc, allowanceLines } from "./allowance";
import { statementLayout } from "./statementLines";

const seeds: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const acc = (name: string) => seeds.find((a) => a.name === name)!;
const balances = (m: Record<string, number>) => (a: Account) => m[a.name] ?? 0;

describe("貸倒引当金繰入額の計算", () => {
  const end = balances({ 売掛金: 1_000_000, 受取手形: 200_000, 貸付金: 0, 未収入金: 50_001 });
  test("② 貸金は売掛金・受取手形・貸付金・未収入金の残高に調整を足し引き、③ はその 5.5%（1円未満切り捨て）", () => {
    const c = allowanceCalc(seeds, end, 0, { "allowance:adjust": "△100,000" }, true);
    expect(c.receivables.map((r) => r.name)).toEqual(["受取手形", "売掛金", "貸付金", "未収入金"]);
    expect([c.base, c.limit, c.bulk, c.total]).toEqual([1_150_001, 63_250, 63_250, 63_250]);
  });
  test("金融業は 3.3%。④ は限度額まで（空なら限度額、超えれば限度額にして知らせる）。⑤ は ① 個別評価＋④", () => {
    expect(allowanceCalc(seeds, end, 0, { "allowance:finance": "1" }, true).limit).toBe(41_250);
    const less = allowanceCalc(seeds, end, 0, { "allowance:amount": "50,000", "allowance:individual": "20000" }, true);
    expect([less.individual, less.bulk, less.total, less.problems]).toEqual([20_000, 50_000, 70_000, []]);
    const over = allowanceCalc(seeds, end, 0, { "allowance:amount": "90000" }, true);
    expect(over.bulk).toBe(over.limit);
    expect(over.problems[0]).toMatch(/限度額を超えている/);
  });
  test("白色申告の年は一括評価を使えない（限度額 0。個別評価の額だけ）", () => {
    const c = allowanceCalc(seeds, end, 0, { "allowance:individual": "30000" }, false);
    expect([c.limit, c.bulk, c.total]).toEqual([0, 0, 30_000]);
  });
  test("洗替の仕訳：期首の貸倒引当金を戻し入れ、本年分を繰り入れる", () => {
    const c = allowanceCalc(seeds, end, 55_000, { "allowance:amount": "44000" }, true);
    expect(c.reversal).toBe(55_000);
    const ids = allowanceAccounts(seeds);
    expect(allowanceLines(seeds, c)!.map((l) => [l.row_no, l.side, l.account_id, l.amount])).toEqual([
      [1, "debit", ids.allowance!.id, 55_000], [1, "credit", ids.back!.id, 55_000],
      [2, "debit", ids.add!.id, 44_000], [2, "credit", ids.allowance!.id, 44_000],
    ]);
    expect(allowanceLines(seeds, allowanceCalc(seeds, balances({}), 0, {}, true))).toEqual([]);
    expect(allowanceLines(seeds.filter((a) => a.name !== "貸倒引当金戻入"), c)).toBeNull();
  });
});

describe("決算書：繰戻額等・繰入額等（全体の確認の例 A-02）", () => {
  // 売上 300万・経費 100万、期首の貸倒引当金 55,000 を戻し入れ、44,000 を繰り入れる
  let n = 0;
  const je = (debit: string, credit: string, amount: number): FlatLine[] => {
    n++;
    const base = { entry_id: n, row_no: 1, date: "2026-12-31", description: "", memo: "", amount, counterparty_id: null, sub_account_id: null };
    return [{ ...base, side: "debit", account_id: acc(debit).id }, { ...base, side: "credit", account_id: acc(credit).id }];
  };
  const lines = [
    ...je("売掛金", "売上高", 3_000_000), ...je("消耗品費", "普通預金", 1_000_000),
    ...je("貸倒引当金", "貸倒引当金戻入", 55_000), ...je("貸倒引当金繰入", "貸倒引当金", 44_000),
  ];
  const end = closingBalances(seeds, { [acc("貸倒引当金").id]: 55_000, [acc("普通預金").id]: 1_000_000, [acc("元入金").id]: 945_000 }, lines);
  test("戻入は繰戻額等、繰入は繰入額等の「貸倒引当金」の欄（相殺しない）。所得は戻入を足し、繰入を引く", () => {
    const layout = statementLayout(seeds, (a) => end.get(a.id) ?? 0);
    const row = (s: "addition" | "reversal") => layout.sections[s].find((r) => r.label === "貸倒引当金")!.amount;
    expect([row("reversal"), row("addition")]).toEqual([55_000, 44_000]);
    const pl = summarizeIncome(seeds, end);
    expect([pl.beforeSpecial, pl.income]).toEqual([2_000_000, 2_011_000]);
    expect(end.get(acc("貸倒引当金").id)).toBe(44_000);
  });
});
