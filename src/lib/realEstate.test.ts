/**
 * 不動産所得（科目ごとの所得の区分、青色申告特別控除の順序、土地等の負債の利子、第一表 ㋒・③）
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import { closingBalances, summarizeIncome, type FlatLine } from "./accounting";
import { accountsOfKind, kindOf } from "./incomeKind";
import { buildBlueStatement } from "./blueStatement";
import { businessFigures, realEstateFigures } from "./incomeTaxBooks";
import { computeIncomeTax, EMPTY_INCOME_TAX_INPUT, type BusinessFigures, type IncomeTaxResult } from "./incomeTax";
import { depreciationLines, type FixedAsset } from "./depreciation";

const seeds: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: s.hidden ? 0 : 1, is_system: 1, default_tax_code: null, default_business_class: null, default_purchase_use: null,
  statement_line: null, income_kind: s.income_kind ?? "business",
}));
const acc = (name: string) => seeds.find((a) => a.name === name)!;
const cell = (r: IncomeTaxResult, no: string) => r.rows.find((x) => x.no === no)?.value;

let n = 0;
const je = (debit: string, credit: string, amount: number): FlatLine[] => {
  n++;
  const base = { entry_id: n, row_no: 1, date: "2026-06-30", description: "", memo: "", amount, counterparty_id: null, sub_account_id: null };
  return [{ ...base, side: "debit", account_id: acc(debit).id }, { ...base, side: "credit", account_id: acc(credit).id }];
};

describe("科目ごとの所得の区分", () => {
  test("不動産所得の初期科目は非表示で入り、損益の科目だけ区分で分ける（貸借対照表の科目は共通）", () => {
    const re = seeds.filter((a) => kindOf(a) === "realestate");
    expect(re.map((a) => a.name)).toContain("賃貸料");
    expect(re.every((a) => a.is_active === 0)).toBe(true);
    const biz = accountsOfKind(seeds, "business");
    expect(biz.some((a) => a.name === "賃貸料")).toBe(false);
    expect(biz.some((a) => a.name === "普通預金")).toBe(true);
    expect(accountsOfKind(seeds, "realestate").some((a) => a.name === "普通預金")).toBe(true);
  });
});

describe("決算書（一般用）と不動産所得", () => {
  // 事業：売上 300万・経費 100万 → 200万。不動産：賃貸料 120万・租税公課 20万 → 100万
  const lines = [
    ...je("普通預金", "売上高", 3_000_000), ...je("消耗品費", "普通預金", 1_000_000),
    ...je("普通預金", "賃貸料", 1_200_000), ...je("租税公課（不動産）", "普通預金", 200_000),
  ];
  const st = buildBlueStatement({
    year: 2026, accounts: seeds, opening: {}, lines, notes: {}, assets: [], homeUseRates: [], excludeEntryIds: [], payeeName: () => "", deductionLimit: 650_000,
  });
  test("一般用は事業所得の科目だけ。青色申告特別控除は不動産所得から先（⑥ 100万 → ⑧ 65万、⑨ 0）。貸借対照表の所得は帳簿全体", () => {
    expect([st.pl.revenue, st.pl.income]).toEqual([3_000_000, 2_000_000]);
    expect([st.realEstateIncome, st.realEstateDeduction, st.deduction]).toEqual([1_000_000, 650_000, 0]);
    expect(st.totalIncome).toBe(3_000_000);
    expect(st.layout.sections.expense.some((r) => r.label.includes("不動産"))).toBe(false);
  });
});

describe("所得税：不動産所得", () => {
  const re = (incomeBeforeBlue: number, o: Partial<NonNullable<BusinessFigures["realEstate"]>> = {}) =>
    ({ revenue: 1_200_000, incomeBeforeBlue, familySalary: 0, scale: "business" as const, landInterest: 0, ...o });
  const tax = (biz: number, realEstate: BusinessFigures["realEstate"]) =>
    computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { revenue: biz ? 3_000_000 : 0, incomeBeforeBlue: biz, filingType: "blue65", familySalary: 0, realEstate }, 2026);

  test("㋒・③ を出し、青色申告特別控除は不動産所得から先に差し引く", () => {
    const r = tax(2_000_000, re(400_000));
    expect([cell(r, "㋒"), cell(r, "③"), cell(r, "①")]).toEqual([1_200_000, 0, 1_750_000]);
    expect(cell(r, "⑫")).toBe(1_750_000);
    expect(r.blueRealEstate).toBe(400_000);
    expect(r.rows.find((x) => x.label === "青色申告特別控除額")?.value).toBe(650_000);
  });
  test("事業所得が無く、事業的規模でない貸付けは 10万円まで。事業所得があれば 65万円", () => {
    expect(cell(tax(0, re(1_000_000, { scale: "small" })), "③")).toBe(900_000);
    expect(cell(tax(0, re(1_000_000, { scale: "business" })), "③")).toBe(350_000);
    expect(cell(tax(500_000, re(1_000_000, { scale: "small" })), "③")).toBe(350_000);
  });
  test("赤字のうち土地等を取得するために要した負債の利子の額までは損益通算しない（③ は 0 か差額）", () => {
    expect(cell(tax(2_000_000, re(-500_000, { landInterest: 600_000 })), "③")).toBe(0);
    const r = tax(2_000_000, re(-500_000, { landInterest: 200_000 }));
    expect(cell(r, "③")).toBe(-300_000);
    expect(r.notes.join()).toMatch(/土地等を取得するために要した負債の利子/);
  });
  test("帳簿から：専従者給与（不動産）は事業的規模の青色だけ必要経費。不動産所得が無ければ ㋒・③ を出さない", () => {
    const lines = [...je("普通預金", "賃貸料", 1_200_000), ...je("専従者給与（不動産）", "普通預金", 300_000)];
    const end = closingBalances(seeds, {}, lines);
    expect(realEstateFigures(seeds, end, "blue65", { scale: "business", landInterest: 0 })).toMatchObject({ incomeBeforeBlue: 900_000, familySalary: 300_000 });
    expect(realEstateFigures(seeds, end, "blue65", { scale: "small", landInterest: 0 })).toMatchObject({ incomeBeforeBlue: 1_200_000, familySalary: 0 });
    expect(realEstateFigures(seeds, end, "white", { scale: "business", landInterest: 0 })).toMatchObject({ incomeBeforeBlue: 1_200_000, familySalary: 0 });
    const none = closingBalances(seeds, {}, je("普通預金", "売上高", 1_000_000));
    const { biz } = businessFigures(seeds, none, "blue65", EMPTY_INCOME_TAX_INPUT, 2026, { scale: "none", landInterest: 0 });
    expect(biz.realEstate).toBeUndefined();
    expect(summarizeIncome(accountsOfKind(seeds, "business"), none).income).toBe(1_000_000);
  });
});

describe("固定資産：不動産所得の資産", () => {
  test("年末の減価償却の仕訳は減価償却費（不動産）にする", () => {
    const a: FixedAsset = {
      id: 1, name: "アパート", account_id: acc("建物").id, acquired_on: "2026-01-10", used_on: "2026-01-10", cost: 22_000_000, method: "straight", useful_life: 22,
      business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", income_kind: "realestate",
    };
    const lines = depreciationLines([a], 2026, { expense: acc("減価償却費").id, draw: acc("事業主貸").id, expenseRealEstate: acc("減価償却費（不動産）").id });
    expect(lines[0]).toMatchObject({ side: "debit", account_id: acc("減価償却費（不動産）").id, amount: 1_012_000 });
  });
});
