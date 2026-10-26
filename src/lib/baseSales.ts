/**
 * 基準期間・特定期間の課税売上高（純粋関数）。個人事業者の場合
 *  - 基準期間 = その年の前々年。特定期間 = 前年の1月1日〜6月30日
 *  - 課税売上高 = 課税売上（税抜き）－ 売上の返還（税抜き）＋ 免税売上（輸出）
 *    基準期間に免税事業者だった期間の売上は税抜きしない（消費税が含まれていないため）。年の途中から課税事業者になった年は、その日の前後で分けて計算する
 *  - 明細の税区分が無い（免税事業者の期間など）ときは、科目の税区分の初期値で売上かどうかを決める
 *  - 判定（令和8年分の制度）
 *      免税事業者になれない：基準期間の課税売上高 1,000万円超、または特定期間の課税売上高と給与等支払額がどちらも 1,000万円超
 *      2割特例・3割特例が使えない：上の理由で課税事業者になる年（登録と関係なく課税事業者）
 *      簡易課税が使えない：基準期間の課税売上高 5,000万円超
 */
import type { Account, TaxCode, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { defaultTaxCode, taxActiveOn } from "./tax";
import { exclusive, type Rate } from "./taxReturn";
import { CODE } from "../constants/accounts";

export const EXEMPT_LIMIT = 10_000_000;
export const SIMPLIFIED_LIMIT = 50_000_000;

export interface PeriodSales {
  /** 課税事業者の期間の課税売上（税抜き。返還を差し引いた額） */
  taxable: number;
  /** 免税事業者の期間の課税売上（税抜きしない。返還を差し引いた額） */
  exemptPeriod: number;
  /** 免税売上（輸出。返還を差し引いた額） */
  exportSales: number;
  /** 課税売上高（合計） */
  total: number;
}

/** 期間 [from, to] の課税売上高 */
export const periodSales = (lines: FlatLine[], accounts: Account[], taxYears: TaxYear[], from: string, to: string): PeriodSales => {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const gross: Record<Rate, number> = { 8: 0, 10: 0 };
  const returns: Record<Rate, number> = { 8: 0, 10: 0 };
  let exemptPeriod = 0, exportSales = 0;
  for (const l of lines) {
    if (l.is_deleted || l.date < from || l.date > to) continue;
    const acc = accountMap.get(l.account_id);
    const code: TaxCode | null = l.tax_code ?? (acc ? defaultTaxCode(acc, l.side) : null);
    const sign = l.side === "credit" ? 1 : -1;
    if (code === "export") exportSales += sign * l.amount;
    if (code !== "sales10" && code !== "sales8") continue;
    if (!taxActiveOn(taxYears, l.date)) exemptPeriod += sign * l.amount;
    else (l.side === "credit" ? gross : returns)[code === "sales10" ? 10 : 8] += l.amount;
  }
  const taxable = ([8, 10] as Rate[]).reduce((s, r) => s + exclusive(gross[r], r) - exclusive(returns[r], r), 0);
  return { taxable, exemptPeriod, exportSales, total: taxable + exemptPeriod + exportSales };
};

/** 期間 [from, to] の給与等支払額（給料賃金・専従者給与の借方 － 貸方） */
export const periodSalaries = (lines: FlatLine[], accounts: Account[], from: string, to: string) => {
  const ids = new Set(accounts.filter((a) => a.code === CODE.SALARIES || a.code === CODE.FAMILY_SALARY).map((a) => a.id));
  return lines
    .filter((l) => !l.is_deleted && l.date >= from && l.date <= to && ids.has(l.account_id))
    .reduce((s, l) => s + (l.side === "debit" ? l.amount : -l.amount), 0);
};

export interface BaseSalesInfo {
  /** 申告する年 */
  year: number;
  /** 基準期間の課税売上高（分からなければ null） */
  base: number | null;
  /** books = 帳簿から計算、manual = 手で入れた額、none = 分からない */
  source: "books" | "manual" | "none";
  /** 帳簿から計算した内訳（基準期間の帳簿があるとき） */
  fromBooks: PeriodSales | null;
  /** 特定期間（前年1〜6月）。前年の帳簿が無ければ null */
  specific: { sales: PeriodSales; salaries: number } | null;
}

export interface BaseSalesInput {
  year: number;
  /** 前々年・前年の明細（削除済みを除く） */
  baseLines: FlatLine[];
  prevLines: FlatLine[];
  accounts: Account[];
  taxYears: TaxYear[];
  /** 手で入れた基準期間の課税売上高（無ければ null）。入っていれば帳簿の計算より優先する */
  manual: number | null;
}

export const baseSalesInfo = (x: BaseSalesInput): BaseSalesInfo => {
  const by = x.year - 2, py = x.year - 1;
  const fromBooks = x.baseLines.length ? periodSales(x.baseLines, x.accounts, x.taxYears, `${by}-01-01`, `${by}-12-31`) : null;
  const specific = x.prevLines.some((l) => l.date <= `${py}-06-30`)
    ? {
      sales: periodSales(x.prevLines, x.accounts, x.taxYears, `${py}-01-01`, `${py}-06-30`),
      salaries: periodSalaries(x.prevLines, x.accounts, `${py}-01-01`, `${py}-06-30`),
    }
    : null;
  if (x.manual !== null) return { year: x.year, base: x.manual, source: "manual", fromBooks, specific };
  if (fromBooks) return { year: x.year, base: fromBooks.total, source: "books", fromBooks, specific };
  return { year: x.year, base: null, source: "none", fromBooks: null, specific };
};

/** 登録と関係なく課税事業者になるか（なれば理由） */
export const mandatoryReason = (info: BaseSalesInfo): string | null => {
  if (info.base !== null && info.base > EXEMPT_LIMIT) {
    return `基準期間（${info.year - 2}年）の課税売上高が 1,000万円を超えています（${info.base.toLocaleString()}円）`;
  }
  if (info.specific && info.specific.sales.total > EXEMPT_LIMIT && info.specific.salaries > EXEMPT_LIMIT) {
    return `特定期間（${info.year - 1}年1〜6月）の課税売上高と給与等支払額がどちらも 1,000万円を超えています`;
  }
  return null;
};

/** 方式が使えないとき、その理由（使えるか分からないときは null） */
export const methodProblem = (method: "standard" | "simplified" | "twenty" | "thirty", info: BaseSalesInfo): string | null => {
  if (method === "twenty" || method === "thirty") {
    const r = mandatoryReason(info);
    return r ? `${r}。登録と関係なく課税事業者になるため使えません` : null;
  }
  if (method === "simplified" && info.base !== null && info.base > SIMPLIFIED_LIMIT) {
    return `基準期間（${info.year - 2}年）の課税売上高が 5,000万円を超えているため使えません`;
  }
  return null;
};
