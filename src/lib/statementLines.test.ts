/**
 * 勘定科目と青色申告決算書の欄の対応
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import { autoLine, EXTRA_LINE, lineOf, sectionOf, statementLayout } from "./statementLines";

const seeds: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const acc = (name: string) => seeds.find((a) => a.name === name)!;
const extraExpense = (id: number, name: string): Account => ({ ...acc("雑費"), id, code: String(630 + id), name, is_system: 0 });

describe("自動の欄", () => {
  test("初期の科目は名前の同じ欄。名前の違う科目は追加の欄", () => {
    expect(autoLine(acc("租税公課"))).toBe("租税公課");
    expect(autoLine(acc("普通預金"))).toBe("その他の預金");
    expect(autoLine(acc("工具器具備品"))).toBe("工具 器具 備品");
    expect(autoLine(acc("仕入高"))).toBe("仕入金額（製品製造原価）");
    expect(autoLine(acc("期末商品棚卸高"))).toBe("期末商品（製品）棚卸高");
    expect(autoLine(acc("専従者給与"))).toBe("専従者給与");
    expect(autoLine(acc("支払手数料"))).toBe(EXTRA_LINE);
    expect(autoLine(acc("敷金"))).toBe(EXTRA_LINE);
    expect(sectionOf(acc("売上高"))).toBeNull();
    expect(sectionOf(acc("元入金"))).toBe("liability");
  });
  test("初期の経費の追加科目はちょうど6つ", () => {
    const extras = seeds.filter((a) => sectionOf(a) === "expense" && lineOf(a) === EXTRA_LINE).map((a) => a.name);
    expect(extras).toEqual(["支払手数料", "車両費", "新聞図書費", "会議費", "研修費", "諸会費"]);
  });
  test("選んだ欄を使う（その部分に無い欄なら自動）", () => {
    expect(lineOf({ ...acc("車両費"), statement_line: "旅費交通費" })).toBe("旅費交通費");
    expect(lineOf({ ...acc("車両費"), statement_line: "現金" })).toBe(EXTRA_LINE);
  });
});

describe("欄ごとの金額", () => {
  test("経費の追加の欄が足りなければ、金額の小さい科目を雑費にまとめて知らせる", () => {
    const accounts = [...seeds, extraExpense(1, "保守料"), extraExpense(2, "ソフト利用料")];
    const amounts = new Map<number, number>([[acc("雑費").id, 1_000], [acc("支払手数料").id, 50_000], [acc("車両費").id, 40_000], [acc("新聞図書費").id, 3_000],
      [acc("会議費").id, 2_000], [acc("研修費").id, 30_000], [acc("諸会費").id, 10_000], [1, 20_000], [2, 60_000], [acc("通信費").id, 12_000]]);
    const amountOf = (a: Account) => amounts.get(a.id) ?? 0;
    const { sections, warnings } = statementLayout(accounts, amountOf);
    const extras = sections.expense.filter((r) => r.extra).map((r) => [r.label, r.amount]);
    expect(extras).toEqual([["ソフト利用料", 60_000], ["支払手数料", 50_000], ["車両費", 40_000], ["研修費", 30_000], ["保守料", 20_000], ["諸会費", 10_000]]);
    expect(sections.expense.find((r) => r.label === "雑費")!.amount).toBe(6_000);
    expect(sections.expense.find((r) => r.label === "通信費")!.amount).toBe(12_000);
    expect(warnings).toEqual(["経費の追加の欄（6つ）が足りないため、新聞図書費・会議費を雑費にまとめます"]);
  });
  test("決まった欄は金額が無くても並べ、追加の欄は金額のある科目だけ", () => {
    const { sections, warnings } = statementLayout(seeds, () => 0);
    expect(sections.expense.filter((r) => !r.extra)).toHaveLength(18);
    expect(sections.expense.some((r) => r.extra)).toBe(false);
    expect(sections.asset.map((r) => r.label)).toContain("事業主貸");
    expect(warnings).toEqual([]);
  });
});
