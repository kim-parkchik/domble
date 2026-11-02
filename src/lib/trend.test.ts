/**
 * 月次推移表・前年比較
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { FlatLine } from "./accounting";
import type { Account, SubAccount } from "./types";
import { subKey } from "./types";
import { changeRate, compareLines, counterpartyHeads, counterpartyLines, trendHeads, trendLines, type BookData, type MultiLine } from "./trend";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, income_kind: s.income_kind ?? "business", default_tax_code: null, default_business_class: null,
  default_purchase_use: null, statement_line: null,
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const subs: SubAccount[] = [{ id: 1, account_id: id("普通預金"), name: "A銀行", kana: "", sort_order: 1, is_active: 1 }];

let entry = 0;
/** 借方・貸方1行ずつの仕訳 */
const je = (date: string, dr: string, cr: string, amount: number, opts: { drSub?: number; crSub?: number; adjustment?: boolean } = {}): FlatLine[] => {
  entry++;
  const base = { entry_id: entry, date, description: "", memo: "", is_adjustment: opts.adjustment ? 1 : 0 };
  return [
    { ...base, row_no: 1, side: "debit", account_id: id(dr), sub_account_id: opts.drSub ?? null, amount },
    { ...base, row_no: 1, side: "credit", account_id: id(cr), sub_account_id: opts.crSub ?? null, amount },
  ];
};
const row = (ls: MultiLine[], label: string) => ls.find((l) => l.label === label && l.kind !== "category")!;
const opts = { showSubs: true, hideZero: true };

const book: BookData = {
  opening: { [id("現金")]: 100_000, [id("普通預金")]: 500_000, [id("元入金")]: 600_000 },
  subOpening: { [subKey(id("現金"), null)]: 100_000, [subKey(id("普通預金"), 1)]: 500_000, [subKey(id("元入金"), null)]: 600_000 },
  lines: [
    ...je("2026-01-10", "普通預金", "売上高", 300_000, { drSub: 1 }),
    ...je("2026-01-25", "地代家賃", "普通預金", 80_000, { crSub: 1 }),
    ...je("2026-02-25", "地代家賃", "普通預金", 80_000, { crSub: 1 }),
    ...je("2026-03-05", "消耗品費", "現金", 5_000),
    ...je("2026-12-31", "減価償却費", "工具器具備品", 20_000, { adjustment: true }),
  ],
};

describe("月次推移表", () => {
  test("損益：期間ごとの発生額と合計、所得は期間ごと（決算整理は別の列）", () => {
    const ls = trendLines("pl", accounts, subs, book, 1, 13, opts);
    expect(trendHeads("pl", 1, 13)).toEqual(["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "決算整理", "合計"]);
    const rent = row(ls, "地代家賃").values;
    expect([rent[0], rent[1], rent[2], rent[13]]).toEqual([80_000, 80_000, 0, 160_000]);
    expect(row(ls, "減価償却費").values.slice(12)).toEqual([20_000, 20_000]);
    const income = row(ls, "青色申告特別控除前の所得金額").values;
    expect([income[0], income[1], income[2], income[12], income[13]]).toEqual([220_000, -80_000, -5_000, -20_000, 115_000]);
    // 金額のない科目は隠す
    expect(ls.some((l) => l.label === "旅費交通費")).toBe(false);
  });
  test("貸借：期首と期間ごとの末の残高、補助科目も。所得は期間の末まで", () => {
    const ls = trendLines("bs", accounts, subs, book, 1, 13, opts);
    expect(trendHeads("bs", 1, 13).slice(0, 3)).toEqual(["期首", "1月末", "2月末"]);
    expect(trendHeads("bs", 1, 13).at(-1)).toBe("決算整理後");
    const bank = row(ls, "普通預金").values;
    expect([bank[0], bank[1], bank[2], bank[13]]).toEqual([500_000, 720_000, 640_000, 640_000]);
    expect(row(ls, "A銀行").values[2]).toBe(640_000);
    expect(row(ls, "工具器具備品").values.slice(12)).toEqual([0, -20_000]);
    const income = row(ls, "所得金額（当期の利益）").values;
    expect([income[0], income[1], income[3], income[13]]).toEqual([0, 220_000, 135_000, 115_000]);
  });
  test("期間を絞ると、その期間の列だけ（貸借の最初の列は前月末）", () => {
    expect(trendHeads("bs", 2, 3)).toEqual(["1月末", "2月末", "3月末"]);
    const bank = row(trendLines("bs", accounts, subs, book, 2, 3, opts), "普通預金").values;
    expect(bank).toEqual([720_000, 640_000, 640_000]);
    expect(row(trendLines("pl", accounts, subs, book, 2, 3, opts), "地代家賃").values).toEqual([80_000, 0, 80_000]);
  });
});

describe("前年比較", () => {
  const previous: BookData = {
    opening: {}, subOpening: {},
    lines: [...je("2025-01-10", "普通預金", "売上高", 200_000, { drSub: 1 }), ...je("2025-01-25", "地代家賃", "普通預金", 80_000, { crSub: 1 })],
  };
  test("今年・前年・差額。損益は期間の発生額、貸借は末の残高。増減率は前年を 100% として", () => {
    const pl = compareLines("pl", accounts, subs, book, previous, 1, 13, opts);
    expect(row(pl, "売上高").values).toEqual([300_000, 200_000, 100_000]);
    expect(row(pl, "地代家賃").values).toEqual([160_000, 80_000, 80_000]);
    expect(row(pl, "青色申告特別控除前の所得金額").values).toEqual([115_000, 120_000, -5_000]);
    const bs = compareLines("bs", accounts, subs, book, previous, 1, 1, opts);
    expect(row(bs, "普通預金").values).toEqual([720_000, 120_000, 600_000]);
    expect(changeRate(300_000, 200_000)).toBe("50.0%");
    expect(changeRate(-50, -100)).toBe("50.0%");
    expect(changeRate(0, 3_500)).toBe("▲100.0%");
    expect(changeRate(1, 0)).toBe("");
  });
});

describe("取引先別", () => {
  let n = 1000;
  const cpLine = (date: string, dr: string, cr: string, amount: number, cp: number | null, adj = false): FlatLine[] => {
    n++;
    const base = { entry_id: n, date, description: "", memo: "", row_no: 1, amount, counterparty_id: cp, is_adjustment: adj ? 1 : 0 };
    return [{ ...base, side: "debit", account_id: id(dr), sub_account_id: null }, { ...base, side: "credit", account_id: id(cr), sub_account_id: null }];
  };
  const cps = [{ id: 1, name: "A社" }, { id: 2, name: "B社" }];
  const lines = [
    ...cpLine("2026-01-10", "売掛金", "売上高", 300_000, 1),
    ...cpLine("2026-02-10", "売掛金", "売上高", 500_000, 2),
    ...cpLine("2026-02-20", "現金", "売上高", 20_000, null),
    ...cpLine("2026-02-28", "普通預金", "売掛金", 300_000, 1),
    ...cpLine("2026-03-10", "売上高", "売掛金", 10_000, 2), // 値引き
  ];
  const acc = (name: string) => accounts.find((a) => a.name === name)!;
  test("損益の科目：取引先ごとの期間の発生額（大きい順、取引先なしは最後）と合計", () => {
    const out = counterpartyLines(acc("売上高"), lines, 1, 13, cps, false);
    expect(counterpartyHeads(acc("売上高"), false, 1, 13)).toEqual(["金額"]);
    expect(out.map((l) => [l.label, l.values])).toEqual([["B社", [490_000]], ["A社", [300_000]], ["取引先なし", [20_000]], ["合計", [810_000]]]);
  });
  test("貸借の科目：増えた額・減った額・差引（期首残高は取引先ごとに持たない）", () => {
    const out = counterpartyLines(acc("売掛金"), lines, 1, 13, cps, false);
    expect(counterpartyHeads(acc("売掛金"), false, 1, 13)).toEqual(["増えた額", "減った額", "差引"]);
    expect(out.map((l) => [l.label, l.values])).toEqual([["B社", [500_000, 10_000, 490_000]], ["A社", [300_000, 300_000, 0]], ["合計", [800_000, 310_000, 490_000]]]);
  });
  test("月ごと：期間ごとの発生額と合計", () => {
    const out = counterpartyLines(acc("売上高"), lines, 1, 3, cps, true);
    expect(counterpartyHeads(acc("売上高"), true, 1, 3)).toEqual(["1月", "2月", "3月", "合計"]);
    expect(out.find((l) => l.label === "B社")!.values).toEqual([0, 500_000, -10_000, 490_000]);
    expect(out[out.length - 1].values).toEqual([300_000, 520_000, -10_000, 810_000]);
  });
});
