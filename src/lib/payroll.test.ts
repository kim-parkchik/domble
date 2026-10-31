/**
 * 給与：給与の CSV、仕訳、決算書の内訳、源泉所得税の納付
 */
import { describe, expect, test } from "bun:test";
import type { FlatLine } from "./accounting";
import { toCsv } from "./csv";
import { payLinesOf } from "./blueStatement";
import {
  fiscalYearCode, parsePayrollCsv, parsePayrollSettings, PAYROLL_CSV_HEADER, payrollDuplicate, payrollEntryLines, payrollFigures, payrollSettingsProblem,
  withholdingPeriods, type PayrollSettings,
} from "./payroll";

// 科目の番号（テスト用）
const SALARY = 613;
const FAMILY = 701;
const COMMUTE = 619;
const DEPOSIT = 206;
const BANK = 103;
const settings: PayrollSettings = {
  tax: { account_id: DEPOSIT, sub_account_id: 1 }, resident: { account_id: DEPOSIT, sub_account_id: 2 }, social: { account_id: DEPOSIT, sub_account_id: 3 },
  other: { account_id: DEPOSIT, sub_account_id: null }, bank: { account_id: BANK, sub_account_id: null }, commute: COMMUTE, family: ["山田 花子"], special: false,
};

describe("給与の CSV", () => {
  test("domble の形をそのまま読む。社会保険料は内訳の合計、区分の空欄は給与", () => {
    const text = toCsv(PAYROLL_CSV_HEADER, [
      ["2026/01/25", "給与", "佐藤 一郎", "250,000", "10,000", "12,000", "", "", "22,000", "1,500", "", "5,000", "10,000", "", "199,500"],
      ["R8.7.10", "賞与", "佐藤 一郎", "300000", "", "15000", "", "", "27000", "1800", "", "12000", "", "", "244200"],
      ["2026-02-25", "", "鈴木 二郎", "150000", "", "", "", "", "", "", "", "3000", "", "", "147000"],
    ]);
    const r = parsePayrollCsv(text);
    expect(r.issues).toEqual([]);
    expect(r.rows.map((x) => [x.date, x.kind, x.name, x.gross, x.commute, x.social, x.tax, x.resident, x.net])).toEqual([
      ["2026-01-25", "salary", "佐藤 一郎", 250_000, 10_000, 35_500, 5_000, 10_000, 199_500],
      ["2026-07-10", "bonus", "佐藤 一郎", 300_000, 0, 43_800, 12_000, 0, 244_200],
      ["2026-02-25", "salary", "鈴木 二郎", 150_000, 0, 0, 3_000, 0, 147_000],
    ]);
  });
  test("ほかの給与ソフトの見出しも読む（社会保険料は合計の列）。合わない行・読めない区分は問題", () => {
    const text = toCsv(["支払日", "従業員名", "総支給", "社会保険料合計", "源泉所得税", "住民税", "手取り"], [
      ["2026/03/25", "鈴木 二郎", "150000", "0", "3000", "0", "147000"],
      ["2026/04/25", "鈴木 二郎", "150000", "0", "3000", "0", "140000"],
    ]);
    const r = parsePayrollCsv(text);
    expect(r.rows).toHaveLength(1);
    expect(r.issues).toEqual([{ row: 3, message: "差引支給額 140,000円が、総支給額 − 控除の合計（147,000円）と合いません" }]);
    expect(parsePayrollCsv(toCsv(["支給日", "区分", "氏名", "総支給額", "差引支給額"], [["2026/1/25", "退職金", "A", "1", "1"]])).issues[0].message).toMatch(/区分/);
    expect(parsePayrollCsv(toCsv(["日付", "氏名"], [["2026/1/25", "A"]])).issues[0].message).toMatch(/総支給額・差引支給額の列が見つかりません/);
  });
});

describe("給与の仕訳", () => {
  const row = { row: 2, date: "2026-01-25", kind: "salary" as const, name: "佐藤 一郎", gross: 250_000, commute: 10_000, social: 35_500, tax: 5_000, resident: 10_000, other: 0, net: 199_500 };
  test("給料賃金（通勤手当は別の科目）／社会保険料・源泉所得税・住民税・口座", () => {
    const lines = payrollEntryLines(row, settings, SALARY);
    expect(lines).toEqual([
      { side: "debit", account_id: SALARY, sub_account_id: null, amount: 240_000, memo: "給与（佐藤 一郎）", row_no: 1 },
      { side: "debit", account_id: COMMUTE, sub_account_id: null, amount: 10_000, memo: "通勤手当（佐藤 一郎）", invoice_kind: "book_travel", row_no: 2 },
      { side: "credit", account_id: DEPOSIT, sub_account_id: 3, amount: 35_500, memo: "給与（佐藤 一郎）", row_no: 1 },
      { side: "credit", account_id: DEPOSIT, sub_account_id: 1, amount: 5_000, memo: "給与（佐藤 一郎）", row_no: 2 },
      { side: "credit", account_id: DEPOSIT, sub_account_id: 2, amount: 10_000, memo: "給与（佐藤 一郎）", row_no: 3 },
      { side: "credit", account_id: BANK, sub_account_id: null, amount: 199_500, memo: "給与（佐藤 一郎）", row_no: 4 },
    ]);
    expect(payrollEntryLines(row, { ...settings, tax: null }, SALARY)).toMatch(/源泉所得税の科目/);
  });
  test("設定の確かめと読み込み。源泉所得税はほかの控除と別の科目", () => {
    expect(payrollSettingsProblem(settings)).toBeNull();
    expect(payrollSettingsProblem({ ...settings, resident: settings.tax })).toMatch(/別の科目/);
    expect(parsePayrollSettings(JSON.stringify(settings))).toEqual(settings);
    expect(parsePayrollSettings("壊れた")).toMatchObject({ tax: null, special: false });
  });
  test("同じ人・同じ日・同じ総支給額の給与が帳簿にあれば重複かも", () => {
    const existing: FlatLine[] = [
      { entry_id: 9, date: "2026-01-25", description: "", row_no: 1, side: "debit", account_id: SALARY, sub_account_id: null, amount: 240_000, memo: "", counterparty_id: 5 },
      { entry_id: 9, date: "2026-01-25", description: "", row_no: 2, side: "debit", account_id: COMMUTE, sub_account_id: null, amount: 10_000, memo: "", counterparty_id: 5 },
    ];
    expect(payrollDuplicate(row, 5, existing, [SALARY, FAMILY], COMMUTE)).toBe(true);
    expect(payrollDuplicate(row, 6, existing, [SALARY, FAMILY], COMMUTE)).toBe(false);
  });
});

/** 給与の仕訳（取引先・給料賃金・源泉所得税・口座） */
let n = 100;
const pay = (date: string, cp: number, gross: number, tax: number, account = SALARY): FlatLine[] => {
  n++;
  const base = { entry_id: n, date, description: "", memo: "", counterparty_id: cp };
  return [
    { ...base, row_no: 1, side: "debit", account_id: account, sub_account_id: null, amount: gross },
    { ...base, row_no: 1, side: "credit", account_id: DEPOSIT, sub_account_id: 1, amount: tax },
    { ...base, row_no: 2, side: "credit", account_id: BANK, sub_account_id: null, amount: gross - tax },
  ];
};
const payTax = (date: string, amount: number): FlatLine[] => {
  n++;
  const base = { entry_id: n, date, description: "", memo: "", counterparty_id: null };
  return [
    { ...base, row_no: 1, side: "debit", account_id: DEPOSIT, sub_account_id: 1, amount },
    { ...base, row_no: 1, side: "credit", account_id: BANK, sub_account_id: null, amount },
  ];
};

describe("決算書の内訳（帳簿から）", () => {
  test("人ごとの賞与・源泉徴収税額・給与を払った月の数", () => {
    const jan = pay("2026-01-25", 1, 150_000, 3_000);
    const feb = pay("2026-02-25", 1, 150_000, 3_000);
    const bonus = pay("2026-07-10", 1, 200_000, 8_000);
    const other = pay("2026-01-25", 2, 100_000, 0);
    const f = payrollFigures([...jan, ...feb, ...bonus, ...other], SALARY, settings.tax, new Set([bonus[0].entry_id]));
    expect(f.get("cp:1")).toEqual({ bonus: 200_000, tax: 14_000, months: 2 });
    expect(f.get("cp:2")).toEqual({ bonus: 0, tax: 0, months: 1 });
  });
});

describe("決算書の内訳：書き込みが無ければ帳簿から", () => {
  test("賞与・源泉徴収税額・従事月数。書き込みがあればそちら", () => {
    const rows = [{ key: "cp:1", counterpartyId: 1, subId: null, gross: 500_000, business: 500_000 }];
    const figures = new Map([["cp:1", { bonus: 200_000, tax: 14_000, months: 2 }]]);
    expect(payLinesOf(rows, "salary", {}, () => "佐藤", figures)[0]).toMatchObject({ salary: 300_000, bonus: 200_000, total: 500_000, tax: 14_000, months: 2 });
    expect(payLinesOf(rows, "salary", { "salary:cp:1:tax": "15,000", "salary:cp:1:months": "12", "salary:cp:1:bonus": " " }, () => "佐藤", figures)[0])
      .toMatchObject({ bonus: 200_000, tax: 15_000, months: 12 });
    expect(payLinesOf(rows, "salary", {}, () => "佐藤")[0]).toMatchObject({ bonus: 0, tax: 0, months: null });
  });
});

describe("源泉所得税の納付", () => {
  const holidays = new Set<string>();
  test("納期の特例：1〜6月分は7月10日、7〜12月分は翌年1月20日。人員は月ごとの実人員の合計。納めた額は期首の未納から順に当てる", () => {
    const lines = [
      ...pay("2026-01-25", 1, 150_000, 3_000), ...pay("2026-01-25", 2, 100_000, 1_000), ...pay("2026-02-25", 1, 150_000, 3_000),
      ...pay("2026-06-30", 1, 200_000, 8_000),
      ...pay("2026-07-25", 1, 150_000, 3_000),
      ...payTax("2026-01-20", 5_000), // 前の年の7〜12月分
      ...payTax("2026-07-10", 15_000),
      ...payTax("2027-01-20", 3_000), // 翌年に納めた7〜12月分
    ];
    const bonusIds = new Set([lines.find((l) => l.date === "2026-06-30")!.entry_id]);
    const [h1, h2] = withholdingPeriods(lines, 2026, [SALARY, FAMILY], settings.tax!, bonusIds, true, holidays, 5_000);
    expect(h1).toMatchObject({
      fromMonth: 1, toMonth: 6, due: "2026-07-10", total: 15_000, paid: 15_000, status: "paid",
      salary: { firstDate: "2026-01-25", lastDate: "2026-02-25", people: 3, amount: 400_000, tax: 7_000 },
      bonus: { firstDate: "2026-06-30", lastDate: "2026-06-30", people: 1, amount: 200_000, tax: 8_000 },
    });
    expect(h2).toMatchObject({ fromMonth: 7, toMonth: 12, due: "2027-01-20", total: 3_000, paid: 3_000, status: "paid" });
  });
  test("毎月：翌月10日まで（土日なら次の平日）。納めていない月は未納", () => {
    const lines = [...pay("2026-01-25", 1, 150_000, 3_000), ...pay("2026-02-25", 1, 150_000, 3_000), ...payTax("2026-02-10", 3_000)];
    const ps = withholdingPeriods(lines, 2026, [SALARY], settings.tax!, new Set(), false, holidays);
    expect(ps).toHaveLength(12);
    expect(ps[0]).toMatchObject({ due: "2026-02-10", status: "paid" });
    expect(ps[1]).toMatchObject({ due: "2026-03-10", status: "unpaid", paid: 0 });
    expect(ps[4].due).toBe("2026-06-10");
    expect(ps[9].due).toBe("2026-11-10");
    expect(ps[11]).toMatchObject({ due: "2027-01-11", status: "none" }); // 1/10 が日曜なので次の平日
    expect(fiscalYearCode("2027-01-20")).toBe("508");
    expect(fiscalYearCode("2026-07-10")).toBe("508");
    expect(fiscalYearCode("2026-03-10")).toBe("507");
  });
});
