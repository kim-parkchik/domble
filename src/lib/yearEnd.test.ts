import { describe, expect, test } from "bun:test";
import { accruedTaxLines, closingInventory, inventoryIssues, inventoryLines, inventoryProblem, reversalLines, rowAmount } from "./yearEnd";

describe("決算整理の仕訳", () => {
  test("棚卸：棚卸表があれば合計（1円未満切り捨て）、無ければ入れた金額。期首・期末の振替を1本で", () => {
    expect(rowAmount({ name: "商品A", quantity: 3, unitPrice: 333.4 })).toBe(1000);
    expect(closingInventory({ amount: 99, rows: [{ name: "A", quantity: 10, unitPrice: 1500 }, { name: "B", quantity: 2, unitPrice: 25_000 }] })).toBe(65_000);
    expect(closingInventory({ amount: 250_000, rows: [] })).toBe(250_000);
    expect(closingInventory(null)).toBe(0);
    const ls = inventoryLines(200_000, 250_000, { openingAccount: 501, closingAccount: 503, stock: 113 });
    expect(ls.map((l) => [l.row_no, l.side, l.account_id, l.amount])).toEqual([
      [1, "debit", 501, 200_000], [1, "credit", 113, 200_000], [2, "debit", 113, 250_000], [2, "credit", 503, 250_000],
    ]);
    expect(inventoryLines(0, 0, { openingAccount: 501, closingAccount: 503, stock: 113 })).toEqual([]);
    expect(inventoryProblem({ amount: 0, rows: [{ name: " ", quantity: 1, unitPrice: 1 }] })).toMatch(/品名/);
  });

  test("棚卸の確かめ：期首の振替が無い（報告の例：期首 20万円を振り替えずに期末だけ入れた）", () => {
    expect(inventoryIssues({ openingStock: 200_000, openingTransferred: 0, closingStock: 450_000, closingCounted: 250_000 })).toEqual([
      expect.stringMatching(/期首商品棚卸高（0円）が、棚卸資産の期首残高（200,000円）と違います/),
      expect.stringMatching(/棚卸資産の期末残高（450,000円）が、期末商品棚卸高（250,000円）と違います/),
    ]);
    expect(inventoryIssues({ openingStock: 200_000, openingTransferred: 200_000, closingStock: 250_000, closingCounted: 250_000 })).toEqual([]);
  });

  test("未払消費税等：納付なら租税公課 / 未払消費税等、還付なら未収入金 / 雑収入（どちらも対象外）", () => {
    const ids = { taxes: 601, accrued: 260, receivable: 116, misc: 403 };
    expect(accruedTaxLines(214_600, ids).map((l) => [l.side, l.account_id, l.amount, l.tax_code])).toEqual([["debit", 601, 214_600, "none"], ["credit", 260, 214_600, "none"]]);
    expect(accruedTaxLines(-156_000, ids).map((l) => [l.side, l.account_id, l.amount])).toEqual([["debit", 116, 156_000], ["credit", 403, 156_000]]);
    expect(accruedTaxLines(0, ids)).toEqual([]);
  });

  test("振り戻し：貸借を入れ替え、税区分はそのまま", () => {
    const r = reversalLines([
      { row_no: 1, side: "debit", account_id: 616, sub_account_id: null, amount: 50_000, memo: "12月分の家賃", tax_code: "purchase10", invoice_kind: "qualified" },
      { row_no: 1, side: "credit", account_id: 204, sub_account_id: null, amount: 50_000, memo: "12月分の家賃", tax_code: "none" },
    ]);
    expect(r.map((l) => [l.side, l.account_id, l.memo, l.tax_code])).toEqual([["credit", 616, "振り戻し 12月分の家賃", "purchase10"], ["debit", 204, "振り戻し 12月分の家賃", "none"]]);
  });
});
