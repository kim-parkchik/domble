/**
 * 収支内訳書（白色申告）と事業専従者控除
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import type { FlatLine } from "./accounting";
import type { FixedAsset } from "./depreciation";
import { emptyRelative, EMPTY_INCOME_TAX_INPUT } from "./incomeTax";
import { buildWhiteStatement, businessMonths, familyDeductions, familyMembers, whiteSummary, type FamilyMember } from "./whiteStatement";

const seeds: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const acc = (name: string) => seeds.find((a) => a.name === name)!;

let entry = 0;
/** 借方・貸方の1組の仕訳（取引先・補助科目は任意） */
const je = (date: string, debit: string, credit: string, amount: number, o: { cp?: number; sub?: number } = {}): FlatLine[] => {
  entry += 1;
  const base = { entry_id: entry, date, description: "", memo: "", amount, counterparty_id: o.cp ?? null };
  return [
    { ...base, row_no: 1, side: "debit", account_id: acc(debit).id, sub_account_id: acc(debit).category === "revenue" ? null : o.sub ?? null },
    { ...base, row_no: 1, side: "credit", account_id: acc(credit).id, sub_account_id: acc(credit).category === "revenue" ? o.sub ?? null : null },
  ];
};

const member = (o: Partial<FamilyMember> = {}): FamilyMember => ({
  from: "spouse", name: "山田 花子", relation: "妻", birthday: "1988-04-01", spouse: true, months: 12, work: "毎日・経理", ...o,
});

describe("事業専従者控除", () => {
  test("配偶者は 86万円と ⑲÷(人数＋1) の少ない方", () => {
    // 監査の例：専従者控除前の所得 300万円・配偶者1人 → 300万÷2＝150万円より 86万円が少ない
    expect(familyDeductions(3_000_000, [member()], 2025)[0].deduction).toBe(860_000);
    // 所得 100万円 → 100万÷2＝50万円
    expect(familyDeductions(1_000_000, [member()], 2025)[0].deduction).toBe(500_000);
  });
  test("専従者ごとに比べる（配偶者 86万円・子 50万円。⑵ は全員で同じ額）", () => {
    const lines = familyDeductions(2_400_000, [member(), member({ from: "dep0", name: "山田 一郎", relation: "長男", birthday: "2005-06-01", spouse: false })], 2025);
    // 240万÷3＝80万円 → 配偶者は 80万円（86万円より少ない）、子は 50万円
    expect(lines.map((l) => l.deduction)).toEqual([800_000, 500_000]);
  });
  test("1円未満は切り捨て。所得が 0 以下なら控除は 0", () => {
    expect(familyDeductions(1_000_001, [member(), member({ spouse: false })], 2025).map((l) => l.deduction)).toEqual([333_333, 333_333]);
    expect(familyDeductions(-50_000, [member()], 2025)[0].deduction).toBe(0);
  });
  test("15歳未満・従事6か月以下・入れていない人は対象にならず、人数にも数えない", () => {
    const lines = familyDeductions(3_000_000, [
      member(),
      member({ name: "山田 次郎", birthday: "2011-01-02", spouse: false }), // 2025年12月31日に14歳
      member({ name: "山田 三郎", birthday: "2000-01-01", spouse: false, months: 6 }),
      member({ name: "山田 四郎", birthday: "", spouse: false }),
      member({ name: "山田 五郎", birthday: "2000-01-01", spouse: false, months: null }),
    ], 2025);
    expect(lines.map((l) => l.deduction)).toEqual([860_000, 0, 0, 0, 0]);
    expect(lines[1].problem).toContain("15歳未満");
    expect(lines[2].problem).toContain("6か月以下");
    expect(lines[3].problem).toContain("生年月日");
    expect(lines[4].problem).toContain("従事月数");
  });
  test("1月1日生まれは前の年の12月31日に年齢が上がる（2010年1月1日生まれは 2025年に15歳）", () => {
    expect(familyDeductions(3_000_000, [member({ birthday: "2010-01-01", spouse: false })], 2025)[0].problem).toBe("");
  });
  test("年の中途の開業：事業の期間の2分の1を超えて従事していればよい", () => {
    const months = businessMonths({ otherPrefecture: false, change: "open", changeDate: "2025-07-10" }, 2025);
    expect(months).toBe(6);
    expect(familyDeductions(1_000_000, [member({ months: 4 })], 2025, months)[0].problem).toBe("");
    expect(familyDeductions(1_000_000, [member({ months: 3 })], 2025, months)[0].problem).toContain("2分の1");
    expect(businessMonths({ otherPrefecture: false, change: "close", changeDate: "2025-03-31" }, 2025)).toBe(3);
    expect(businessMonths({ otherPrefecture: false, change: "open", changeDate: "2024-07-10" }, 2025)).toBe(12);
  });
  test("所得税の入力のうち「専従者」に印のある人。配偶者の続柄が無ければ「配偶者」", () => {
    const x = {
      ...EMPTY_INCOME_TAX_INPUT,
      spouse: { ...emptyRelative(""), name: "山田 花子", familyEmployee: true, months: 12 },
      dependents: [{ ...emptyRelative("長男"), name: "山田 一郎" }, { ...emptyRelative("長女"), name: "山田 二子", familyEmployee: true, months: 10, work: "週3日・販売" }],
    };
    expect(familyMembers(x).map((m) => [m.from, m.name, m.relation, m.spouse, m.months, m.work])).toEqual([
      ["spouse", "山田 花子", "配偶者", true, 12, ""],
      ["dep1", "山田 二子", "長女", false, 10, "週3日・販売"],
    ]);
  });
});

describe("収支内訳書の1ページ", () => {
  // 売上 500万（うち取引先 A 300万・B 120万・補助科目なし 80万）、家事消費 2万、雑収入 3万、仕入 100万、
  // 経費：給料賃金 60万・地代家賃 24万・支払手数料 3万、専従者給与 100万（白色では経費にならない）
  const lines: FlatLine[] = [
    ...je("2025-03-31", "売掛金", "売上高", 3_000_000, { cp: 1 }),
    ...je("2025-06-30", "売掛金", "売上高", 1_200_000, { cp: 2 }),
    ...je("2025-09-30", "現金", "売上高", 800_000),
    ...je("2025-12-31", "事業主貸", "家事消費等", 20_000),
    ...je("2025-12-31", "普通預金", "雑収入", 30_000),
    ...je("2025-05-10", "仕入高", "買掛金", 1_000_000, { cp: 3 }),
    ...je("2025-12-25", "給料賃金", "普通預金", 600_000),
    ...je("2025-12-25", "地代家賃", "普通預金", 240_000),
    ...je("2025-12-25", "支払手数料", "普通預金", 30_000),
    ...je("2025-12-25", "専従者給与", "普通預金", 1_000_000),
  ];
  const s = buildWhiteStatement({
    year: 2025, accounts: seeds, opening: {}, lines, notes: { "sales:cp:1:address": "東京都渋谷区" }, assets: [], homeUseRates: [], excludeEntryIds: [],
    payeeName: (r) => (r.counterpartyId ? `取引先${r.counterpartyId}` : `補助${r.subId}`), invoiceNoOf: (id) => (id === 1 ? "T1234567890123" : ""),
    family: [member()], periodMonths: 12,
  });

  test("収入金額は①売上・②家事消費・③その他の収入に分ける", () => {
    expect(s.revenue).toEqual({ sales: 5_000_000, household: 20_000, other: 30_000, total: 5_050_000 });
    expect(s.cogs).toEqual({ opening: 0, purchases: 1_000_000, subtotal: 1_000_000, closing: 0, cost: 1_000_000 });
    expect(s.difference).toBe(4_050_000);
  });
  test("専従者給与は経費に入れず、知らせる。⑲・⑳・㉑", () => {
    expect(s.expenseTotal).toBe(870_000);
    expect(s.mainExpenses.filter((r) => r.amount).map((r) => [r.no, r.label, r.amount])).toEqual([["⑪", "給料賃金", 600_000], ["⑮", "地代家賃", 240_000]]);
    expect(s.otherExpenses.filter((r) => r.amount).map((r) => [r.no, r.label, r.amount])).toEqual([["㋾", "支払手数料", 30_000]]);
    expect(s.otherSubtotal).toBe(30_000);
    expect(s.familySalaryBooked).toBe(1_000_000);
    expect(s.warnings[0]).toContain("必要経費になりません");
    expect(s.beforeDeduction).toBe(3_180_000);
    expect(s.familyDeduction).toBe(860_000);
    expect(s.income).toBe(2_320_000);
    // 帳簿どおりの所得（専従者給与を経費にした額）より、専従者給与 100万 − 控除 86万 だけ多い
    expect(s.income - s.pl.income).toBe(140_000);
  });
  test("売上先の明細の計は①（家事消費・雑収入は入れない）。取引先の無い売上は上記以外", () => {
    expect(s.sales.rows.map((r) => [r.name, r.amount, r.invoiceNo, r.address])).toEqual([
      ["取引先1", 3_000_000, "1234567890123", "東京都渋谷区"],
      ["取引先2", 1_200_000, "", ""],
    ]);
    expect(s.sales.other).toBe(800_000);
    expect(s.sales.total).toBe(5_000_000);
    expect(s.purchases.rows.map((r) => [r.name, r.amount])).toEqual([["取引先3", 1_000_000]]);
    expect(s.purchases.total).toBe(1_000_000);
    expect(s.purchases.other).toBe(0);
  });
  test("減価償却費の計算：平成19年3月31日以前の取得は旧定額法。均等償却の年は償却の基礎が取得価額 × 5%、摘要に「均等償却」", () => {
    const shop: FixedAsset = {
      id: 7, name: "店舗", account_id: acc("建物").id, acquired_on: "2000-04-01", used_on: "2000-04-01", cost: 10_000_000, method: "straight", useful_life: 22,
      business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "",
    };
    const at = (year: number) => buildWhiteStatement({
      year, accounts: seeds, opening: {}, lines: [], notes: {}, assets: [shop], homeUseRates: [], excludeEntryIds: [], payeeName: () => "", family: [], periodMonths: 12,
    }).detail.depreciation[0];
    expect(at(2022)).toMatchObject({ method: "旧定額法", base: 9_000_000, rate: 0.046, depreciation: 414_000, memo: "" });
    expect(at(2025)).toMatchObject({ method: "旧定額法", base: 500_000, rate: 0.2, depreciation: 100_000, closing: 300_000, memo: "均等償却" });
  });
  test("白色の年の貸倒引当金（個別評価）：繰入は経費、戻入は経費から差し引く（追加の欄。知らせる）", () => {
    const amounts = new Map([[acc("貸倒引当金繰入").id, 30_000], [acc("貸倒引当金戻入").id, 20_000]]);
    const w = whiteSummary(seeds, (a) => amounts.get(a.id) ?? 0);
    expect(w.otherExpenses.filter((r) => r.extra).map((r) => [r.label, r.amount])).toEqual([["貸倒引当金繰入", 30_000], ["貸倒引当金戻入", -20_000]]);
    expect(w.expenseTotal).toBe(10_000);
    expect(w.warnings.join()).toMatch(/貸倒引当金繰入・貸倒引当金戻入は、収支内訳書に欄が無い/);
  });
  test("経費の追加の欄は 5 つ。多ければ金額の小さい科目を雑費にまとめて知らせる", () => {
    const names = ["支払手数料", "車両費", "新聞図書費", "会議費", "研修費", "諸会費"];
    const amounts = new Map(names.map((n, i) => [acc(n).id, (i + 1) * 1_000]));
    const w = whiteSummary(seeds, (a) => amounts.get(a.id) ?? 0);
    expect(w.expenses.filter((r) => r.extra).map((r) => r.label)).toEqual(["諸会費", "研修費", "会議費", "新聞図書費", "車両費"]);
    expect(w.expenses.find((r) => r.label === "雑費")?.amount).toBe(1_000);
    expect(w.warnings.join("")).toContain("支払手数料を雑費にまとめます");
  });
});
