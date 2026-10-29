/**
 * 帳簿から出す、所得税の事業所得（営業等）の数字（純粋関数）
 *  青色申告：決算書の青色申告特別控除前の所得金額と専従者給与
 *  白色申告：収支内訳書の所得金額（専従者給与を経費にせず、事業専従者控除を差し引く）
 * 所得税の画面と、前の年の申告から繰越損失を引き継ぐ計算（incomeTax.ts の carriedFromPast）で使う
 */
import { summarizeIncome } from "./accounting";
import { businessMonths, familyDeductions, familyMembers, whiteSummary, type FamilyLine } from "./whiteStatement";
import type { BusinessFigures, IncomeTaxInput } from "./incomeTax";
import type { Account, FilingType } from "./types";
import { CODE } from "../constants/accounts";

/** end = 期末残高（closingBalances）。familyLines は白色の事業専従者（青色は空） */
export const businessFigures = (
  accounts: Account[], end: Map<number, number>, filingType: FilingType, input: IncomeTaxInput, year: number,
): { biz: BusinessFigures; familyLines: FamilyLine[] } => {
  if (filingType === "white") {
    const w = whiteSummary(accounts, (a) => end.get(a.id) ?? 0);
    const familyLines = familyDeductions(w.beforeDeduction, familyMembers(input), year, businessMonths(input.businessTax, year));
    const deduction = familyLines.reduce((t, l) => t + l.deduction, 0);
    return { biz: { revenue: w.revenue.total, incomeBeforeBlue: w.beforeDeduction - deduction, filingType, familySalary: deduction }, familyLines };
  }
  const pl = summarizeIncome(accounts, end);
  const family = accounts.find((a) => a.code === CODE.FAMILY_SALARY);
  return { biz: { revenue: pl.revenue, incomeBeforeBlue: pl.income, filingType, familySalary: family ? end.get(family.id) ?? 0 : 0 }, familyLines: [] };
};
