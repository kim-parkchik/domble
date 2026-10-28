/**
 * 所得税の申告書の数字（令和8年分の制度。国税庁「源泉所得税の改正のあらまし（令和8年4月）」、タックスアンサー No.1140・1171、令和7年分の確定申告の手引きの税額の計算）
 */
import { describe, expect, test } from "bun:test";
import {
  ageAt, basicDeduction, computeIncomeTax, dependentDeduction, donationDeduction, emptyRelative, EMPTY_INCOME_TAX_INPUT, incomeTaxOn, lifeInsuranceDeduction,
  medicalDeduction, normalizeIncomeTaxInput, pensionIncome, quakeDeduction, salaryIncome, spouseDeduction, type BusinessFigures, type IncomeTaxInput, type IncomeTaxResult,
} from "./incomeTax";

const cell = (r: IncomeTaxResult, no: string) => r.rows.find((x) => x.no === no)!.value;

describe("所得の計算", () => {
  test("給与所得（令和8・9年分：最低保障 74万円と 190万円超 220万円以下の特例、660万円未満は表の計算）", () => {
    expect(salaryIncome(740_000)).toBe(0);
    expect(salaryIncome(741_000)).toBe(1_000);
    expect(salaryIncome(1_900_000)).toBe(1_160_000);
    expect(salaryIncome(2_190_999)).toBe(1_450_999);
    expect(salaryIncome(2_191_000)).toBe(1_451_000);
    expect(salaryIncome(2_195_999)).toBe(1_453_000);
    expect(salaryIncome(2_196_000)).toBe(1_456_000);
    expect(salaryIncome(2_200_000)).toBe(1_460_000);
    expect(salaryIncome(3_000_000)).toBe(2_020_000);
    expect(salaryIncome(3_001_234)).toBe(2_020_000);
    expect(salaryIncome(5_000_000)).toBe(3_560_000);
    expect(salaryIncome(7_000_000)).toBe(5_200_000);
    expect(salaryIncome(10_000_000)).toBe(8_050_000);
  });
  test("公的年金等に係る雑所得（65歳以上・未満、公的年金等以外の所得が1,000万円超）", () => {
    expect(pensionIncome(1_100_000, true, 0)).toBe(0);
    expect(pensionIncome(2_000_000, true, 0)).toBe(900_000);
    expect(pensionIncome(2_000_000, false, 0)).toBe(1_225_000);
    expect(pensionIncome(2_000_000, true, 12_000_000)).toBe(1_000_000);
    expect(pensionIncome(500_000, false, 0)).toBe(0);
  });
  test("年齢はその年12月31日現在（1月1日生まれは12月31日に1つ上がる）", () => {
    expect(ageAt("1961-12-31", 2026)).toBe(65);
    expect(ageAt("1962-01-01", 2026)).toBe(65);
    expect(ageAt("1962-01-02", 2026)).toBe(64);
    expect(ageAt("", 2026)).toBeNull();
  });
});

describe("所得控除", () => {
  test("基礎控除（令和8・9年分）", () => {
    expect(basicDeduction(4_890_000)).toBe(1_040_000);
    expect(basicDeduction(4_890_001)).toBe(670_000);
    expect(basicDeduction(6_550_001)).toBe(620_000);
    expect(basicDeduction(23_500_001)).toBe(480_000);
    expect(basicDeduction(30_000_000)).toBe(0);
  });
  test("生命保険料控除（新旧の組み合わせ、23歳未満の扶養親族がいる場合の特例、合計12万円まで）", () => {
    const l = { newLife: 0, oldLife: 0, newPension: 0, oldPension: 0, care: 0 };
    expect(lifeInsuranceDeduction({ ...l, newLife: 100_000 }, false)).toBe(40_000);
    expect(lifeInsuranceDeduction({ ...l, newLife: 100_000 }, true)).toBe(55_000);
    expect(lifeInsuranceDeduction({ ...l, newLife: 200_000 }, true)).toBe(60_000);
    expect(lifeInsuranceDeduction({ ...l, oldLife: 70_000 }, false)).toBe(42_500);
    expect(lifeInsuranceDeduction({ ...l, newLife: 30_000, oldLife: 30_000 }, false)).toBe(40_000);
    expect(lifeInsuranceDeduction({ ...l, newLife: 10_000, oldLife: 120_000 }, false)).toBe(50_000);
    expect(lifeInsuranceDeduction({ newLife: 200_000, oldLife: 0, newPension: 200_000, oldPension: 0, care: 200_000 }, true)).toBe(120_000);
  });
  test("地震保険料控除・医療費控除・セルフメディケーション税制・寄附金控除", () => {
    expect(quakeDeduction({ quake: 60_000, oldLong: 0 })).toBe(50_000);
    expect(quakeDeduction({ quake: 10_000, oldLong: 30_000 })).toBe(25_000);
    expect(medicalDeduction({ kind: "normal", paid: 300_000, reimbursed: 50_000 }, 1_500_000)).toBe(175_000);
    expect(medicalDeduction({ kind: "normal", paid: 300_000, reimbursed: 0 }, 3_000_000)).toBe(200_000);
    expect(medicalDeduction({ kind: "self", paid: 50_000, reimbursed: 0 }, 3_000_000)).toBe(38_000);
    expect(donationDeduction(50_000, 3_000_000)).toBe(48_000);
    expect(donationDeduction(2_000_000, 3_000_000)).toBe(1_198_000);
  });
  test("配偶者控除・配偶者特別控除（本人の合計所得金額で3段階）", () => {
    const s = (income: number, birthday = "1986-05-01") => ({ ...emptyRelative("妻"), income, birthday });
    expect(spouseDeduction(s(500_000), 5_000_000, 2026)).toMatchObject({ kind: "spouse", amount: 380_000 });
    expect(spouseDeduction(s(500_000, "1950-01-01"), 5_000_000, 2026)).toMatchObject({ kind: "spouse", amount: 480_000, elderly: true });
    expect(spouseDeduction(s(620_001), 5_000_000, 2026)).toMatchObject({ kind: "special", amount: 380_000 });
    expect(spouseDeduction(s(1_000_000), 5_000_000, 2026)).toMatchObject({ kind: "special", amount: 360_000 });
    expect(spouseDeduction(s(1_000_000), 9_200_000, 2026)).toMatchObject({ amount: 240_000 });
    expect(spouseDeduction(s(1_330_001), 5_000_000, 2026).amount).toBe(0);
    expect(spouseDeduction(s(0), 10_000_001, 2026).amount).toBe(0);
  });
  test("扶養控除・特定親族特別控除（所得要件は62万円）", () => {
    const d = (birthday: string, income = 0, extra: Partial<ReturnType<typeof emptyRelative>> = {}) => ({ ...emptyRelative("子"), birthday, income, ...extra });
    expect(dependentDeduction(d("2006-04-01"), 2026)).toMatchObject({ kind: "specific", amount: 630_000 });
    expect(dependentDeduction(d("2006-04-01", 1_000_000), 2026)).toMatchObject({ kind: "specificRelative", amount: 410_000 });
    expect(dependentDeduction(d("2006-04-01", 1_230_001), 2026)).toMatchObject({ kind: "none", amount: 0 });
    expect(dependentDeduction(d("2016-04-01"), 2026)).toMatchObject({ kind: "minor", amount: 0 });
    expect(dependentDeduction(d("2009-04-01"), 2026)).toMatchObject({ kind: "general", amount: 380_000 });
    expect(dependentDeduction(d("1950-04-01", 0, { lineal: true, cohabiting: true }), 2026)).toMatchObject({ kind: "elderlyParent", amount: 580_000 });
    expect(dependentDeduction(d("1950-04-01", 0, { lineal: true, cohabiting: false }), 2026)).toMatchObject({ kind: "elderly", amount: 480_000 });
    expect(dependentDeduction(d("1990-04-01", 700_000), 2026)).toMatchObject({ kind: "none", amount: 0 });
  });
});

describe("税額", () => {
  test("税率表（手引きの例：課税される所得金額 2,960,000円 → 198,500円）", () => {
    expect(incomeTaxOn(2_960_000)).toBe(198_500);
    expect(incomeTaxOn(1_000)).toBe(50);
    expect(incomeTaxOn(9_000_000)).toBe(1_434_000);
    expect(incomeTaxOn(0)).toBe(0);
  });
});

describe("申告書（第一表）", () => {
  const biz = (incomeBeforeBlue: number, revenue = 8_000_000): BusinessFigures => ({ revenue, incomeBeforeBlue, filingType: "blue65", familySalary: 0 });

  test("事業所得だけ：配偶者控除・16歳未満の子（生命保険料の特例）・源泉徴収で還付", () => {
    const input: IncomeTaxInput = {
      ...EMPTY_INCOME_TAX_INPUT,
      businessWithholding: [{ item: "原稿料", payer: "株式会社A", payerId: "", income: 1_000_000, withheld: 102_100 }],
      socialInsurance: [{ kind: "国民健康保険", amount: 400_000 }, { kind: "国民年金", amount: 200_000 }],
      smallBusiness: [{ kind: "小規模企業共済", amount: 120_000 }],
      life: { ...EMPTY_INCOME_TAX_INPUT.life, newLife: 100_000 },
      spouse: { ...emptyRelative("妻"), birthday: "1986-05-01" },
      dependents: [{ ...emptyRelative("子"), birthday: "2016-05-01" }],
    };
    const r = computeIncomeTax(input, biz(3_650_000), 2026);
    expect(cell(r, "①")).toBe(3_000_000);
    expect(cell(r, "⑫")).toBe(3_000_000);
    expect(cell(r, "⑬")).toBe(600_000);
    expect(cell(r, "⑮")).toBe(55_000);
    expect(cell(r, "㉑㉒")).toBe(380_000);
    expect(cell(r, "㉓")).toBe(0);
    expect(cell(r, "㉕")).toBe(1_040_000);
    expect(cell(r, "㉚")).toBe(2_195_000);
    expect(cell(r, "㉛")).toBe(805_000);
    expect(cell(r, "㉜")).toBe(40_250);
    expect(cell(r, "㊺")).toBe(845);
    expect(cell(r, "㊻")).toBe(41_095);
    expect(cell(r, "㊾")).toBe(102_100);
    expect(cell(r, "㊿")).toBe(-61_005);
    expect([cell(r, "(52)"), cell(r, "(53)")]).toEqual([0, 61_005]);
    expect(r.balance).toBe(-61_005);
    expect(cell(r, "(59)")).toBe(650_000);
    expect(r.second.withholding).toHaveLength(1);
  });

  test("事業・給与・公的年金等（65歳以上）：予定納税を差し引いて納める", () => {
    const input: IncomeTaxInput = {
      ...EMPTY_INCOME_TAX_INPUT,
      birthday: "1960-03-01",
      salaries: [{ item: "給料", payer: "B社", payerId: "", income: 3_000_000, withheld: 50_000 }],
      pensions: [{ item: "老齢年金", payer: "日本年金機構", payerId: "", income: 2_500_000, withheld: 20_000 }],
      socialInsurance: [{ kind: "国民健康保険", amount: 400_000 }],
      prepaid: 30_000,
    };
    const r = computeIncomeTax(input, biz(1_000_000), 2026);
    expect([cell(r, "①"), cell(r, "⑥"), cell(r, "⑦"), cell(r, "⑫")]).toEqual([350_000, 2_020_000, 1_400_000, 3_770_000]);
    expect(cell(r, "㉛")).toBe(2_330_000);
    expect(cell(r, "㉜")).toBe(135_500);
    expect(cell(r, "㊺")).toBe(2_845);
    expect(cell(r, "㊿")).toBe(68_300);
    expect(cell(r, "(52)")).toBe(38_300);
    expect(cell(r, "(56)")).toBe(2_370_000);
    expect(cell(r, "(60)")).toBe(20_000);
  });

  test("雑所得の損失はほかの所得から引かない。事業の損失は差し引く。所得の要件を超えた控除は受けられない", () => {
    const input: IncomeTaxInput = {
      ...EMPTY_INCOME_TAX_INPUT,
      widow: "single_parent", student: true,
      salaries: [{ item: "給料", payer: "B社", payerId: "", income: 8_000_000, withheld: 0 }],
      misc: [{ kind: "business", item: "講演", payer: "", payerId: "", income: 100_000, expenses: 300_000, withheld: 0 }],
    };
    const r = computeIncomeTax(input, biz(-500_000), 2026);
    expect([cell(r, "①"), cell(r, "⑧"), cell(r, "⑩"), cell(r, "⑫")]).toEqual([-500_000, -200_000, 0, 5_600_000]);
    expect([cell(r, "⑰⑱"), cell(r, "⑲⑳")]).toEqual([0, 0]);
    expect(r.notes.join()).toMatch(/ひとり親控除は受けられません.*勤労学生控除は受けられません/);
  });

  test("白色申告は青色申告特別控除なしで、対応していないことを知らせる", () => {
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { ...biz(1_000_000), filingType: "white" }, 2026);
    expect(cell(r, "①")).toBe(1_000_000);
    expect(r.notes.join()).toMatch(/白色申告/);
  });
});

describe("事業専従者・勤労学生", () => {
  const biz = (familySalary: number): BusinessFigures => ({ revenue: 8_000_000, incomeBeforeBlue: 3_650_000, filingType: "blue65", familySalary });

  test("事業専従者は配偶者控除・扶養控除・障害者控除の対象にならない。生命保険料の23歳未満の特例にも数えない", () => {
    const input: IncomeTaxInput = {
      ...EMPTY_INCOME_TAX_INPUT,
      life: { ...EMPTY_INCOME_TAX_INPUT.life, newLife: 100_000 },
      spouse: { ...emptyRelative("妻"), birthday: "1986-05-01", disability: "normal", familyEmployee: true },
      dependents: [{ ...emptyRelative("子"), birthday: "2006-05-01", familyEmployee: true }],
    };
    const r = computeIncomeTax(input, biz(1_200_000), 2026);
    expect([cell(r, "㉑㉒"), cell(r, "㉓"), cell(r, "⑲⑳"), cell(r, "⑮"), cell(r, "(57)")]).toEqual([0, 0, 0, 40_000, 0]);
    expect(r.second.relatives.map((x) => x.kind)).toEqual(["対象外（事業専従者）", "対象外（事業専従者）"]);
    expect(r.notes.join()).not.toMatch(/専従者」に印/);
  });
  test("専従者給与があるのに、配偶者・扶養親族に専従者の印が無ければ知らせる", () => {
    const input = { ...EMPTY_INCOME_TAX_INPUT, spouse: { ...emptyRelative("妻"), birthday: "1986-05-01" } };
    expect(computeIncomeTax(input, biz(1_200_000), 2026).notes.join()).toMatch(/専従者」に印/);
    expect(computeIncomeTax(input, biz(0), 2026).notes.join()).not.toMatch(/専従者」に印/);
  });
  test("勤労学生の所得要件は 89万円（令和8年分）", () => {
    const input = (income: number): IncomeTaxInput => ({ ...EMPTY_INCOME_TAX_INPUT, student: true, salaries: [{ item: "", payer: "", payerId: "", income, withheld: 0 }] });
    // 給与 163万円 → 給与所得 89万円（受けられる）、163万1千円 → 89万1千円（受けられない）
    const none: BusinessFigures = { revenue: 0, incomeBeforeBlue: 0, filingType: "blue65", familySalary: 0 };
    expect(cell(computeIncomeTax(input(1_630_000), none, 2026), "⑲⑳")).toBe(270_000);
    expect(cell(computeIncomeTax(input(1_631_000), none, 2026), "⑲⑳")).toBe(0);
  });
});

describe("入力の確かめ", () => {
  test("形を整え、おかしな金額・日付は理由を返す", () => {
    const n = normalizeIncomeTaxInput({ birthday: " 1980-01-01 ", socialInsurance: [{ kind: " 国民年金 ", amount: "200000" }] });
    expect(n).toMatchObject({ birthday: "1980-01-01", socialInsurance: [{ kind: "国民年金", amount: 200_000 }], widow: "none", spouse: null });
    expect(normalizeIncomeTaxInput({ prepaid: -1 })).toMatch(/予定納税額/);
    expect(normalizeIncomeTaxInput({ dependents: [{ birthday: "2020-13-01" }] })).toMatch(/扶養親族 1人目の生年月日/);
  });
});
