/**
 * 税抜経理（純粋関数）。課税事業者の年に、事業者設定の「消費税」の経理方式を税抜経理にしたとき
 *  - 明細は今までどおり税込の金額で入れ、明細ごとに消費税額（国税＋地方消費税）を持つ。手で直していなければ自動：
 *    課税売上・課税仕入・貸倒れは税込の金額 × 10/110・8/108（1円未満切り捨て）、経過措置の仕入れはその額 × 控除できる割合、
 *    控除しない仕入れは 0、輸入の消費税は金額そのもの。特定課税仕入れ・対象外・非課税・輸出免税は 0
 *  - 帳簿・決算書では、明細を本体（税抜）と仮受消費税等（売上・貸倒れの側）・仮払消費税等（仕入の側）に分けて見せる（bookLines）
 *  - 消費税の申告書は、今までどおり税込の金額から割戻しで計算する（明細の消費税額は使わない）
 *  - 年末に、仮受消費税等と仮払消費税等を未払消費税等（納める額）と精算し、差額を雑収入・雑費にする（決算整理の画面。lib/yearEnd.ts）
 */
import type { FlatLine } from "./accounting";
import { CODE } from "../constants/accounts";
import type { TaxYear } from "./types";
import { isFullyDeductible, isImportCode, isPurchaseCode, splitsTax, taxActiveOn, taxCodeDef, taxYearOf, transitionalRate } from "./tax";

export { splitsTax };

/** その日が税抜経理の期間か（課税事業者の期間で、その年の経理方式が税抜経理） */
export const isExclusiveOn = (taxYears: TaxYear[], date: string) =>
  taxActiveOn(taxYears, date) && taxYearOf(taxYears, Number(date.slice(0, 4))).method === "exclusive";

/** 自動の消費税額（手で直していないとき） */
export const autoTaxAmount = (l: Pick<FlatLine, "amount" | "tax_code" | "invoice_kind" | "date">): number => {
  const code = l.tax_code;
  if (!splitsTax(code)) return 0;
  if (isImportCode(code)) return l.amount;
  const rate = taxCodeDef(code!).rate;
  const full = Math.floor((l.amount * rate) / (100 + rate));
  if (!isPurchaseCode(code)) return full;
  if (isFullyDeductible(l.invoice_kind)) return full;
  if (l.invoice_kind === "transitional") return Math.floor((full * transitionalRate(l.date)) / 100);
  return 0; // 控除しない
};

/** 明細の消費税額（手で直した額か自動。税抜経理の期間でなければ 0） */
export const lineTaxAmount = (l: Pick<FlatLine, "amount" | "tax_code" | "invoice_kind" | "date" | "tax_amount">, taxYears: TaxYear[]) =>
  !isExclusiveOn(taxYears, l.date) || !splitsTax(l.tax_code) ? 0 : l.tax_amount ?? autoTaxAmount(l);

/** 手で直した消費税額が正しいか（直せないものは理由） */
export const taxAmountProblem = (amount: number, taxAmount: number) =>
  !Number.isInteger(taxAmount) || taxAmount < 0 ? "消費税額は 0 以上の整数で入れてください"
    : taxAmount > amount ? "消費税額が金額より大きくなっています" : null;

/** 仮受・仮払消費税等の科目（無ければ分けない） */
export interface ExclusiveAccounts {
  /** 仮払消費税等（資産） */
  paid: number;
  /** 仮受消費税等（負債） */
  received: number;
}

/** 科目から仮受・仮払消費税等を探す（無ければ null） */
export const exclusiveAccountsOf = (accounts: { id: number; code: string }[]): ExclusiveAccounts | null => {
  const paid = accounts.find((a) => a.code === CODE.TAX_PAID)?.id;
  const received = accounts.find((a) => a.code === CODE.TAX_RECEIVED)?.id;
  return paid && received ? { paid, received } : null;
};

/**
 * 帳簿・決算書に使う明細：税抜経理の期間の明細を、本体（税抜）と仮受・仮払消費税等の行に分ける。
 * 売上・貸倒れの側は仮受消費税等、仕入・輸入の側は仮払消費税等（貸借は元の明細と同じ側）。分けた行は taxPart
 */
export const bookLines = (lines: FlatLine[], taxYears: TaxYear[], accounts: ExclusiveAccounts | null): FlatLine[] => {
  if (!accounts || !taxYears.some((t) => t.method === "exclusive")) return lines;
  const out: FlatLine[] = [];
  for (const l of lines) {
    const tax = l.taxPart ? 0 : lineTaxAmount(l, taxYears);
    if (!tax) {
      out.push(l);
      continue;
    }
    const sales = taxCodeDef(l.tax_code!).group === "sales";
    out.push({ ...l, amount: l.amount - tax });
    out.push({
      ...l, account_id: sales ? accounts.received : accounts.paid, sub_account_id: null, amount: tax,
      tax_code: null, invoice_kind: null, business_class: null, purchase_use: null, tax_amount: null, taxPart: true,
    });
  }
  return out;
};
