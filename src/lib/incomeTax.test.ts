/**
 * 所得税の申告書の数字（令和8年分の制度。国税庁「源泉所得税の改正のあらまし（令和8年4月）」、タックスアンサー No.1140・1171、令和7年分の確定申告の手引きの税額の計算）
 */
import { describe, expect, test } from "bun:test";
import {
  ageAt, basicDeduction, carriedFromPast, carriedLosses, computeIncomeTax, dependentDeduction, donationDeduction, emptyRelative, EMPTY_INCOME_TAX_INPUT, fieldNo, incomeTaxOn, lifeInsuranceDeduction,
  medicalDeduction, normalizeIncomeTaxInput, pensionIncome, quakeDeduction, rulesFor, salaryIncome, spouseDeduction, type BusinessFigures, type IncomeTaxInput, type IncomeTaxResult,
  type PastIncomeTax, businessPeriod, incomeAdjustment } from "./incomeTax";

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
    // 給与所得と公的年金等の雑所得の両方があるので、所得金額調整控除 10万円（10万円 ＋ 10万円 − 10万円）を ⑥ から差し引く（区分 2）
    expect([cell(r, "①"), cell(r, "⑥"), cell(r, "⑦"), cell(r, "⑫")]).toEqual([350_000, 1_920_000, 1_400_000, 3_670_000]);
    expect(r.incomeAdjust).toEqual({ first: 0, second: 100_000, total: 100_000, kubun: 2 });
    expect(cell(r, "㉛")).toBe(2_230_000);
    expect(cell(r, "㉜")).toBe(125_500);
    expect(cell(r, "㊺")).toBe(2_635);
    expect(cell(r, "㊿")).toBe(58_100);
    expect(cell(r, "(52)")).toBe(28_100);
    // 公的年金等以外の合計所得金額は、所得金額調整控除 (2) の前の給与所得で
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

  test("白色申告は青色申告特別控除なし。①は収支内訳書の所得金額（事業専従者控除の後）、(58)は事業専従者控除の合計", () => {
    // 監査の例：専従者給与 100万円を経費にした所得 200万円 → 専従者控除前 300万円、配偶者の控除 86万円 → ① 2,140,000
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { revenue: 5_000_000, incomeBeforeBlue: 2_140_000, filingType: "white", familySalary: 860_000 }, 2026);
    expect(cell(r, "①")).toBe(2_140_000);
    expect(cell(r, fieldNo(58))).toBe(860_000);
    expect(cell(r, fieldNo(59))).toBe(0);
    expect(r.notes.join()).not.toMatch(/白色申告/);
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

describe("年分の切り替え（令和7年分と令和8年分）", () => {
  const none: BusinessFigures = { revenue: 0, incomeBeforeBlue: 0, filingType: "blue65", familySalary: 0 };
  test("給与所得控除：令和7年分は最低 65万円、令和8年分は 74万円と特例の段", () => {
    expect(salaryIncome(1_000_000, 2025)).toBe(350_000);
    expect(salaryIncome(651_000, 2025)).toBe(1_000);
    expect(salaryIncome(650_999, 2025)).toBe(0);
    expect(salaryIncome(1_899_999, 2025)).toBe(1_249_999);
    expect(salaryIncome(1_900_000, 2025)).toBe(1_250_000);
    expect(salaryIncome(2_195_000, 2025)).toBe(1_454_400); // 4千円単位の表：548,000 × 2.8 − 80,000
    expect(salaryIncome(1_000_000, 2026)).toBe(260_000);
    expect(salaryIncome(5_000_000, 2025)).toBe(salaryIncome(5_000_000, 2026));
  });
  test("基礎控除：令和7年分は 95万・88万・68万・63万・58万円", () => {
    expect([1_320_000, 1_320_001, 3_360_001, 4_890_001, 6_550_001].map((x) => basicDeduction(x, 2025))).toEqual([950_000, 880_000, 680_000, 630_000, 580_000]);
    expect(basicDeduction(3_000_000, 2026)).toBe(1_040_000);
  });
  test("所得要件：令和7年分は 58万円（60万円の配偶者は配偶者特別控除、親は扶養控除なし）", () => {
    const wife = { ...emptyRelative("妻"), birthday: "1986-05-01", income: 600_000 };
    expect(spouseDeduction(wife, 5_000_000, 2025)).toMatchObject({ kind: "special", amount: 380_000 });
    expect(spouseDeduction(wife, 5_000_000, 2026)).toMatchObject({ kind: "spouse", amount: 380_000 });
    const parent = { ...emptyRelative("父"), birthday: "1960-05-01", income: 600_000 };
    expect(dependentDeduction(parent, 2025).kind).toBe("none");
    expect(dependentDeduction(parent, 2026).kind).toBe("general");
  });
  test("令和7年分の申告書：勤労学生 85万円、生命保険料控除の23歳未満の特例なし", () => {
    const student = { ...EMPTY_INCOME_TAX_INPUT, student: true, salaries: [{ item: "", payer: "", payerId: "", income: 1_510_000, withheld: 0 }] };
    // 給与 151万円 → 給与所得 86万円：令和7年分は受けられない、令和8年分（151万 − 74万 = 77万）は受けられる
    expect(cell(computeIncomeTax(student, none, 2025), "⑲⑳")).toBe(0);
    expect(cell(computeIncomeTax(student, none, 2026), "⑲⑳")).toBe(270_000);
    const life = { ...EMPTY_INCOME_TAX_INPUT, life: { ...EMPTY_INCOME_TAX_INPUT.life, newLife: 100_000 }, dependents: [{ ...emptyRelative("子"), birthday: "2016-05-01" }] };
    expect(cell(computeIncomeTax(life, none, 2025), "⑮")).toBe(40_000);
    expect(cell(computeIncomeTax(life, none, 2026), "⑮")).toBe(55_000);
    expect(computeIncomeTax(life, none, 2025).rows.find((r) => r.no === "㉕")!.note).toMatch(/令和7年分/);
  });
  test("表に無い年分は、いちばん近い年分の決まりで計算して知らせる", () => {
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, none, 2027);
    expect(r.notes.join()).toMatch(/令和9年分の決まりはまだ.*令和8年分の決まり/);
    expect(cell(r, "㉕")).toBe(1_040_000);
    expect(computeIncomeTax(EMPTY_INCOME_TAX_INPUT, none, 2022).notes.join()).toMatch(/令和4年分の決まりはまだ.*令和5年分の決まり/);
    expect(rulesFor(2026)).toMatchObject({ fallback: false, rules: { year: 2026 } });
  });
});

describe("令和5年分・令和6年分（定額減税）", () => {
  const none: BusinessFigures = { revenue: 0, incomeBeforeBlue: 0, filingType: "blue65", familySalary: 0 };
  test("給与所得：令和6年分までの表（55万円、1,619,000円からの段、180万円未満は A × 2.4 ＋ 10万円）", () => {
    // 国税庁「令和6年分の年末調整等のための給与所得控除後の給与等の金額の表」
    expect([550_999, 551_000, 1_000_000, 1_618_999].map((x) => salaryIncome(x, 2024))).toEqual([0, 1_000, 450_000, 1_068_999]);
    expect([1_619_000, 1_621_999, 1_622_000, 1_624_000, 1_627_999].map((x) => salaryIncome(x, 2024))).toEqual([1_069_000, 1_070_000, 1_072_000, 1_074_000, 1_074_000]);
    expect([1_628_000, 1_631_999, 1_799_999, 1_800_000, 2_171_999].map((x) => salaryIncome(x, 2024))).toEqual([1_076_800, 1_076_800, 1_177_600, 1_180_000, 1_437_600]);
    expect(salaryIncome(1_000_000, 2023)).toBe(450_000);
  });
  test("基礎控除 48万円（2,400万円以下）、所得要件 48万円、勤労学生 75万円、特定親族特別控除なし", () => {
    expect([24_000_000, 24_000_001, 24_500_001, 25_000_001].map((x) => basicDeduction(x, 2024))).toEqual([480_000, 320_000, 160_000, 0]);
    expect(spouseDeduction({ ...emptyRelative("妻"), income: 480_000 }, 5_000_000, 2024)).toMatchObject({ kind: "spouse", amount: 380_000 });
    expect(spouseDeduction({ ...emptyRelative("妻"), income: 500_000 }, 5_000_000, 2024)).toMatchObject({ kind: "special", amount: 380_000 });
    expect(dependentDeduction({ ...emptyRelative("父"), birthday: "1960-05-01", income: 500_000 }, 2024).kind).toBe("none");
    const student20 = { ...emptyRelative("子"), birthday: "2004-05-01", income: 600_000 };
    expect(dependentDeduction(student20, 2024).kind).toBe("none");
    expect(dependentDeduction(student20, 2025).kind).toBe("specificRelative");
    const work = (income: number) => cell(computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT, student: true, salaries: [{ item: "", payer: "", payerId: "", income, withheld: 0 }] }, none, 2023), "⑲⑳");
    expect([work(1_300_000), work(1_301_000)]).toEqual([270_000, 0]);
  });
  test("令和6年分：定額減税（本人＋同一生計配偶者・扶養親族 1人3万円。事業専従者を除く）を基準所得税額の前に差し引き、欄番号は令和6年分の様式", () => {
    const input: IncomeTaxInput = {
      ...EMPTY_INCOME_TAX_INPUT,
      spouse: { ...emptyRelative("妻"), income: 0 },
      dependents: [
        { ...emptyRelative("長男"), birthday: "2010-05-01" }, { ...emptyRelative("長女"), birthday: "2015-05-01" },
        { ...emptyRelative("母"), birthday: "1950-05-01", familyEmployee: true },
      ],
      salaries: [{ item: "", payer: "", payerId: "", income: 0, withheld: 0 }],
    };
    const biz: BusinessFigures = { revenue: 8_000_000, incomeBeforeBlue: 5_650_000, filingType: "blue65", familySalary: 0 };
    const r = computeIncomeTax(input, biz, 2024);
    expect(r.rows.some((x) => x.label === "特定親族特別控除")).toBe(false);
    expect(cell(r, "㉔")).toBe(480_000); // 基礎控除
    const tax = cell(r, "㉛")!; // ㉚ に対する税額
    expect(cell(r, "㊸")).toBe(tax); // 再差引所得税額
    expect(cell(r, "㊹")).toBe(120_000); // 4人 × 3万円
    expect(cell(r, "㊺")).toBe(Math.max(tax - 120_000, 0)); // 基準所得税額
    expect(cell(r, "㊻")).toBe(Math.floor((cell(r, "㊺")! * 21) / 1000));
    expect(r.rows.find((x) => x.key === "refund")?.no).toBe("(54)");
    expect(r.rows.find((x) => x.label === "本年分で差し引く繰越損失額")?.no).toBe("(63)");
  });
  test("定額減税：合計所得金額 1,805万円超は受けられない。所得税額より多ければ引ききれない分を知らせる", () => {
    const big = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { ...none, incomeBeforeBlue: 18_700_001 }, 2024);
    expect(cell(big, "㊹")).toBe(0);
    expect(big.notes.join()).toMatch(/1,805万円を超えている/);
    const small = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { ...none, incomeBeforeBlue: 1_500_000 }, 2024);
    expect([cell(small, "㊹"), cell(small, "㊺")]).toEqual([30_000, 0]);
    expect(small.notes.join()).toMatch(/引ききれません/);
  });
  test("令和5年分：定額減税なし。基準所得税額は ㊸、源泉徴収税額は ㊽、繰越損失は (61)", () => {
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, { ...none, incomeBeforeBlue: 3_000_000 }, 2023);
    expect(r.rows.find((x) => x.label.startsWith("再差引所得税額（基準所得税額）"))?.no).toBe("㊸");
    expect(r.rows.find((x) => x.label === "源泉徴収税額")?.no).toBe("㊽");
    expect(r.rows.find((x) => x.label === "本年分で差し引く繰越損失額")?.no).toBe("(61)");
    expect(r.rows.some((x) => x.label.includes("特別税額控除"))).toBe(false);
  });
});

describe("入力の確かめ", () => {
  test("形を整え、おかしな金額・日付は理由を返す", () => {
    const n = normalizeIncomeTaxInput({ birthday: " 1980-01-01 ", socialInsurance: [{ kind: " 国民年金 ", amount: "200000" }] });
    expect(n).toMatchObject({ birthday: "1980-01-01", socialInsurance: [{ kind: "国民年金", amount: 200_000 }], widow: "none", spouse: null });
    expect(normalizeIncomeTaxInput({ prepaid: -1 })).toMatch(/予定納税額/);
    expect(normalizeIncomeTaxInput({ dependents: [{ birthday: "2020-13-01" }] })).toMatch(/扶養親族 1人目の生年月日/);
  });
  test("繰越損失：ふだんは前の年の申告から引き継ぐ。手で入れる額は 0 以上の整数", () => {
    expect(normalizeIncomeTaxInput({})).toMatchObject({ carry: { mode: "auto", amounts: [0, 0, 0] } });
    expect(normalizeIncomeTaxInput({ carry: { mode: "manual", amounts: [0, "300000"] } })).toMatchObject({ carry: { mode: "manual", amounts: [0, 300_000, 0] } });
    expect(normalizeIncomeTaxInput({ carry: { mode: "manual", amounts: [0, 0, -1] } })).toMatch(/前年の年分の繰越損失/);
  });
});

describe("損失申告（第四表）と純損失の繰越控除", () => {
  // 青色申告特別控除は所得が上限（赤字なら 0）。給与・雑所得なし
  const biz = (incomeBeforeBlue: number, filingType: BusinessFigures["filingType"] = "blue65"): BusinessFigures => ({ revenue: 3_000_000, incomeBeforeBlue, filingType, familySalary: 0 });
  const tax = (incomeBeforeBlue: number, carried: { year: number; amount: number }[] = [], input: Partial<IncomeTaxInput> = {}, year = 2025) =>
    computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT, ...input }, biz(incomeBeforeBlue), year, carried);

  test("青色の年の純損失は第四表で翌年に繰り越す。第一表の ⑫・㉛ は書かず ㉜ は 0", () => {
    const r = tax(-800_000);
    expect(r.loss).toMatchObject({ fourth: true, income: -800_000, blueLoss: 800_000, used: 0, forDeductions: 0, next: [{ year: 2025, amount: 800_000 }] });
    expect([cell(r, "①"), cell(r, "⑫"), cell(r, "㉛"), cell(r, "㉜"), cell(r, fieldNo(62))]).toEqual([-800_000, null, null, 0, 0]);
    expect(r.totalIncome).toBe(-800_000);
    expect(r.notes.join()).toMatch(/第四表を使います.*純損失 800,000円を翌年以後3年間に繰り越せます/);
  });
  test("損益の通算で赤字が残らなければ、第四表は使わない", () => {
    const r = tax(-500_000, [], { salaries: [{ item: "給料", payer: "A社", payerId: "", income: 3_000_000, withheld: 0 }] });
    expect(r.loss.fourth).toBe(false);
    expect(cell(r, "⑫")).toBe(2_020_000 - 500_000);
  });
  test("繰越損失を使い切る年は第四表を使わず、(62) に書いて ⑫ から差し引く。合計所得金額は繰越控除の前、医療費控除は後の所得で", () => {
    // 所得 2,000,000 − 青色 650,000 = 1,350,000、前年の純損失 500,000 → ⑫ 850,000
    const r = tax(2_000_000, [{ year: 2024, amount: 500_000 }], { medical: { kind: "normal", paid: 150_000, reimbursed: 0 } });
    expect(r.loss).toMatchObject({ fourth: false, used: 500_000, forDeductions: 850_000, next: [] });
    expect([cell(r, "⑫"), cell(r, fieldNo(62))]).toEqual([850_000, 500_000]);
    expect(r.totalIncome).toBe(1_350_000);
    // 基礎控除は合計所得金額 1,350,000（令和7年分：132万円超 336万円以下は 88万円）。繰越控除後の 850,000 なら 95万円
    expect(cell(r, "㉕")).toBe(basicDeduction(1_350_000, 2025));
    expect(cell(r, "㉕")).not.toBe(basicDeduction(850_000, 2025));
    // 医療費控除：150,000 − 850,000 × 5%（42,500）
    expect(cell(r, "㉘")).toBe(107_500);
    expect(cell(r, "㉛")).toBe(Math.max(Math.floor((850_000 - cell(r, "㉚")!) / 1000) * 1000, 0));
  });
  test("古い年分から順に差し引き、引ききれない分は第四表で翌年に繰り越す", () => {
    // 所得 1,450,000 − 650,000 = 800,000。2022年分 300,000 → 2023年分 1,000,000 のうち 500,000
    const r = tax(1_450_000, [{ year: 2022, amount: 300_000 }, { year: 2023, amount: 1_000_000 }], {}, 2025);
    expect(r.loss.carry).toEqual([
      { year: 2022, before: 300_000, used: 300_000, after: null },
      { year: 2023, before: 1_000_000, used: 500_000, after: 500_000 },
      { year: 2024, before: 0, used: 0, after: 0 },
    ]);
    expect(r.loss).toMatchObject({ fourth: true, used: 800_000, forDeductions: 0, next: [{ year: 2023, amount: 500_000 }] });
    expect([cell(r, "⑫"), cell(r, "㉛"), cell(r, "㉜"), cell(r, fieldNo(62))]).toEqual([null, null, 0, 0]);
  });
  test("3年前の年分の残りは繰り越せない（第四表は使わず、知らせる）", () => {
    const r = tax(1_050_000, [{ year: 2022, amount: 1_000_000 }]);
    expect(r.loss).toMatchObject({ fourth: false, used: 400_000, next: [] });
    expect([cell(r, "⑫"), cell(r, fieldNo(62))]).toEqual([0, 400_000]);
    expect(r.notes.join()).toMatch(/2022年分の純損失のうち 600,000円は、繰り越せる3年を過ぎる/);
  });
  test("白色申告の年の純損失は繰り越さない（第四表を使わず、⑫ は赤字のまま）", () => {
    const r = computeIncomeTax(EMPTY_INCOME_TAX_INPUT, biz(-300_000, "white"), 2025);
    expect(r.loss).toMatchObject({ fourth: false, blueLoss: 0, next: [] });
    expect(cell(r, "⑫")).toBe(-300_000);
    expect(r.notes.join()).toMatch(/白色申告の年の純損失は/);
  });
  test("繰越損失は手で入れた額か、前の年の申告から引き継いだ額（3年より前・本年の分は使わない）", () => {
    const manual: IncomeTaxInput = { ...EMPTY_INCOME_TAX_INPUT, carry: { mode: "manual", amounts: [100, 0, 300] } };
    expect(carriedLosses(manual, 2026, [{ year: 2025, amount: 9 }])).toEqual([{ year: 2023, amount: 100 }, { year: 2025, amount: 300 }]);
    expect(carriedLosses(EMPTY_INCOME_TAX_INPUT, 2026, [{ year: 2022, amount: 1 }, { year: 2024, amount: 2 }, { year: 2026, amount: 3 }])).toEqual([{ year: 2024, amount: 2 }]);
    expect(carriedLosses(EMPTY_INCOME_TAX_INPUT, 2026, null)).toEqual([]);
  });
  test("前の年の申告から引き継ぐ：手で入れた年までさかのぼって計算する", async () => {
    const past: Record<number, PastIncomeTax> = {
      // 2024年分：2023年分の純損失 700,000 を手で入れた。所得 850,000 − 650,000 = 200,000 を差し引き、500,000 が残る
      2024: { input: { ...EMPTY_INCOME_TAX_INPUT, carry: { mode: "manual", amounts: [0, 0, 700_000] } }, biz: biz(850_000) },
      // 2025年分：前の年から引き継ぐ。赤字 350,000
      2025: { input: EMPTY_INCOME_TAX_INPUT, biz: biz(-350_000) },
    };
    const load = async (y: number) => past[y] ?? null;
    expect(await carriedFromPast(2026, load)).toEqual([{ year: 2023, amount: 500_000 }, { year: 2025, amount: 350_000 }]);
    expect(await carriedFromPast(2025, load)).toEqual([{ year: 2023, amount: 500_000 }]);
    expect(await carriedFromPast(2027, load)).toBeNull();
  });
});

describe("決算書の事業期間", () => {
  test("その年の中途の開業は開業の日から、廃業は廃業の日まで。ほかの年の日付は通年", () => {
    const b = (change: "" | "open" | "close", changeDate: string) => ({ otherPrefecture: false, change, changeDate });
    expect(businessPeriod(b("", ""), 2026)).toEqual({ from: "1月1日", to: "12月31日" });
    expect(businessPeriod(b("open", "2026-04-15"), 2026)).toEqual({ from: "4月15日", to: "12月31日" });
    expect(businessPeriod(b("close", "2026-09-30"), 2026)).toEqual({ from: "1月1日", to: "9月30日" });
    expect(businessPeriod(b("open", "2025-04-15"), 2026)).toEqual({ from: "1月1日", to: "12月31日" });
  });
});

describe("所得金額調整控除", () => {
  test("(1) 給与 850万円超で 23歳未満の扶養親族・特別障害者がいる：（収入（1,000万円まで）− 850万円）× 10%。(2) 給与と年金の両方：それぞれ 10万円まで − 10万円", () => {
    expect(incomeAdjustment(9_000_000, 7_050_000, 0, true)).toEqual({ first: 50_000, second: 0, total: 50_000, kubun: 1 });
    expect(incomeAdjustment(12_000_000, 10_050_000, 0, true).first).toBe(150_000);
    expect(incomeAdjustment(9_000_000, 7_050_000, 0, false).total).toBe(0);
    expect(incomeAdjustment(9_000_005, 7_050_000, 0, true).first).toBe(50_001); // 1円未満切り上げ
    expect(incomeAdjustment(1_000_000, 50_000, 80_000, false)).toEqual({ first: 0, second: 30_000, total: 30_000, kubun: 2 });
    expect(incomeAdjustment(9_000_000, 7_050_000, 500_000, true)).toEqual({ first: 50_000, second: 100_000, total: 150_000, kubun: 3 });
  });
  test("23歳未満の扶養親族（16歳未満も）がいれば (1)。事業専従者・所得の多い親族は数えない", () => {
    const biz = (n: number): BusinessFigures => ({ revenue: 0, incomeBeforeBlue: n, filingType: "blue65", familySalary: 0 });
    const base: IncomeTaxInput = { ...EMPTY_INCOME_TAX_INPUT, salaries: [{ item: "給料", payer: "C社", payerId: "", income: 9_000_000, withheld: 0 }] };
    const child = { ...emptyRelative("子"), name: "子", birthday: "2015-04-01" };
    expect(computeIncomeTax({ ...base, dependents: [child] }, biz(0), 2026).incomeAdjust.first).toBe(50_000);
    expect(computeIncomeTax({ ...base, dependents: [{ ...child, familyEmployee: true }] }, biz(0), 2026).incomeAdjust.first).toBe(0);
    expect(computeIncomeTax({ ...base, dependents: [{ ...child, birthday: "1990-01-01" }] }, biz(0), 2026).incomeAdjust.first).toBe(0);
    expect(computeIncomeTax({ ...base, disability: "special" }, biz(0), 2026).incomeAdjust.first).toBe(50_000);
  });
});
