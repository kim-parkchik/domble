/**
 * 帳簿から出す、所得税の事業所得（営業等）の数字（純粋関数）
 *  青色申告：決算書の青色申告特別控除前の所得金額と専従者給与
 *  白色申告：収支内訳書の所得金額（専従者給与を経費にせず、事業専従者控除を差し引く）
 * 不動産所得：不動産所得の科目の損益（専従者給与は事業的規模の青色申告のときだけ必要経費。白色の事業専従者控除は扱わない）
 * 所得税の画面と、前の年の申告から繰越損失を引き継ぐ計算（incomeTax.ts の carriedFromPast）で使う
 */
import { summarizeIncome } from "./accounting";
import { accountsOfKind, hasRealEstate } from "./incomeKind";
import { realEstateStatement } from "./realEstateStatement";
import { businessMonths, familyDeductions, familyMembers, whiteSummary, type FamilyLine } from "./whiteStatement";
import type { BusinessFigures, IncomeTaxInput, RealEstateFigures } from "./incomeTax";
import type { Account, FilingType, RealEstateScale } from "./types";
import { CODE } from "../constants/accounts";

/** 不動産所得の数字（不動産所得の科目に金額が無く、事業者設定も「なし」なら undefined） */
export const realEstateFigures = (
  accounts: Account[], end: Map<number, number>, filingType: FilingType, re: { scale: RealEstateScale; landInterest: number },
): RealEstateFigures | undefined => {
  const amount = (a: Account) => end.get(a.id) ?? 0;
  if (re.scale === "none" && !hasRealEstate(accounts, amount)) return undefined;
  // 不動産所得用の決算書と同じ計算（専従者給与は事業的規模の青色申告のときだけ必要経費）
  const st = realEstateStatement(accounts, amount, filingType === "white" ? "white" : "blue", {
    familyAllowed: filingType !== "white" && re.scale === "business", deductionLimit: 0,
  });
  return { revenue: st.revenue.total, incomeBeforeBlue: st.beforeDeduction, familySalary: st.family, scale: re.scale, landInterest: Math.max(0, re.landInterest) };
};

/** end = 期末残高（closingBalances）。familyLines は白色の事業専従者（青色は空）。re を渡せば不動産所得も入れる */
export const businessFigures = (
  accounts: Account[], end: Map<number, number>, filingType: FilingType, input: IncomeTaxInput, year: number,
  re?: { scale: RealEstateScale; landInterest: number },
): { biz: BusinessFigures; familyLines: FamilyLine[] } => {
  const realEstate = re ? realEstateFigures(accounts, end, filingType, re) : undefined;
  if (filingType === "white") {
    const w = whiteSummary(accounts, (a) => end.get(a.id) ?? 0);
    const familyLines = familyDeductions(w.beforeDeduction, familyMembers(input), year, businessMonths(input.businessTax, year));
    const deduction = familyLines.reduce((t, l) => t + l.deduction, 0);
    return { biz: { revenue: w.revenue.total, incomeBeforeBlue: w.beforeDeduction - deduction, filingType, familySalary: deduction, realEstate }, familyLines };
  }
  const pl = summarizeIncome(accountsOfKind(accounts, "business"), end);
  const family = accounts.find((a) => a.code === CODE.FAMILY_SALARY);
  return { biz: { revenue: pl.revenue, incomeBeforeBlue: pl.income, filingType, familySalary: family ? end.get(family.id) ?? 0 : 0, realEstate }, familyLines: [] };
};
