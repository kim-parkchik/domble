/**
 * 青色申告決算書（一般用）の1〜4ページの数字をまとめる（純粋関数。e-Tax のデータ（incomeTaxXtx.ts）に使う）
 * 決算書の画面（StatementsPage・StatementPages）と同じ集計を使う：
 *  - 1ページ・4ページ：勘定科目と決算書の欄の対応（statementLayout）。売上（収入）金額・差引金額・所得金額は summarizeIncome
 *  - 2ページ：月別の売上・仕入（monthlySales）、給料賃金・専従者給与の内訳（payeeBreakdown と書き込み）
 *  - 3ページ：売上（収入）金額・仕入金額の明細（partnerTotals と書き込み）、減価償却費の計算（固定資産台帳）、
 *    利子割引料・税理士等の報酬・地代家賃の内訳（payeeBreakdown と書き込み）、特殊事情
 * 収支内訳書（白色申告。whiteStatement.ts）も、明細はここで作ったものを使う
 * 書き込み（statement_notes）の鍵は画面と同じ（salary:<支払先>:age など）
 */
import { closingBalances, summarizeIncome, type FlatLine, type IncomeSummary } from "./accounting";
import { monthlySales, partnerTotals, payeeBreakdown, type MonthlySales, type PayeeRow } from "./statements";
import { lineOf, sectionOf, statementLayout, type StatementLayout } from "./statementLines";
import { depreciationFor, isOldStraight, type FixedAsset } from "./depreciation";
import type { Account, HomeUseRate, OpeningBalances } from "./types";
import { CODE } from "../constants/accounts";

export interface BlueStatementSource {
  year: number;
  accounts: Account[];
  opening: OpeningBalances;
  lines: FlatLine[];
  /** 決算書の書き込み（年度ごと） */
  notes: Record<string, string>;
  assets: FixedAsset[];
  homeUseRates: HomeUseRate[];
  /** 支払先の内訳に数えない仕訳（家事按分の年末の振替・減価償却の仕訳） */
  excludeEntryIds: number[];
  /** 支払先の名前（取引先 → 補助科目 → 指定なし） */
  payeeName: (r: Pick<PayeeRow, "counterpartyId" | "subId">) => string;
  /** 取引先の登録番号（無ければ空） */
  invoiceNoOf?: (counterpartyId: number) => string;
  /** 青色申告特別控除の上限（申告の種類から） */
  deductionLimit: number;
}

/** 給料賃金・専従者給与の1人分 */
export interface PayLine {
  name: string;
  relation: string;
  /** 年齢・従事月数（書き込みが読めなければ null） */
  age: number | null;
  months: number | null;
  /** 従事の程度・仕事の内容（専従者） */
  work: string;
  salary: number;
  bonus: number;
  total: number;
  tax: number;
}

export interface PayeeLine {
  name: string;
  address: string;
  gross: number;
  business: number;
  /** 利子割引料：期末現在の借入金等の金額 ／ 税理士等：源泉徴収税額 */
  extra: number;
  /** 地代家賃：賃借物件 */
  property: string;
}

export interface DepreciationLine {
  name: string;
  quantity: string;
  /** 取得年月（YYYY-MM） */
  acquired: string;
  cost: number;
  /** 償却の基礎になる金額（旧定額法は取得価額 × 90%、均等償却の年は取得価額 × 5%） */
  base: number;
  method: string;
  /** 耐用年数（定額法・一括償却資産。無ければ null） */
  life: number | null;
  /** 償却率（定額法。無ければ null） */
  rate: number | null;
  /** 本年中の償却期間（月） */
  months: number;
  depreciation: number;
  businessRate: number;
  business: number;
  closing: number;
  memo: string;
}

/** 売上先・仕入先の明細の1行 */
export interface PartnerLine {
  key: string;
  name: string;
  /** 所在地（決算書の書き込み） */
  address: string;
  /** 登録番号（取引先の。T を除いた13桁） */
  invoiceNo: string;
  amount: number;
}

/** 売上（収入）金額・仕入金額の明細（様式は4行）。other = 上記以外の計（total − 4行の計） */
export interface PartnerTable {
  rows: PartnerLine[];
  other: number;
  total: number;
}

/** 明細の行数 */
export const PARTNER_ROWS = 4;

/** 売上先の明細に数える科目（収益のうち、相手の無い家事消費等・雑収入を除く） */
export const salesAccountIds = (accounts: Account[]) =>
  accounts.filter((a) => a.category === "revenue" && a.code !== CODE.HOUSEHOLD_USE && a.code !== CODE.MISC_INCOME).map((a) => a.id);
/** 仕入先の明細に数える科目（決算書の「仕入金額（製品製造原価）」の欄に書く科目） */
export const purchaseAccountIds = (accounts: Account[]) =>
  accounts.filter((a) => sectionOf(a) === "cogs" && lineOf(a) === "仕入金額（製品製造原価）").map((a) => a.id);

/** 売上先・仕入先ごとの行（多い順。所在地は書き込み sales:<相手>:address ／ purchase:<相手>:address） */
export const partnerLines = (
  kind: "sales" | "purchase", accounts: Account[], lines: FlatLine[], notes: Record<string, string>,
  payeeName: BlueStatementSource["payeeName"], invoiceNoOf?: BlueStatementSource["invoiceNoOf"],
): PartnerLine[] =>
  partnerTotals(kind === "sales" ? salesAccountIds(accounts) : purchaseAccountIds(accounts), lines, kind === "sales" ? "credit" : "debit").map((r) => ({
    key: r.key, name: payeeName(r), address: notes[`${kind}:${r.key}:address`] ?? "",
    invoiceNo: r.counterpartyId ? (invoiceNoOf?.(r.counterpartyId) ?? "").replace(/^T/, "") : "", amount: r.amount,
  }));

/** 明細の計を total にした表（上記以外 = total − 載せた行） */
export const partnerTable = (lines: PartnerLine[], total: number): PartnerTable => {
  const rows = lines.slice(0, PARTNER_ROWS);
  return { rows, other: total - rows.reduce((s, r) => s + r.amount, 0), total };
};

export interface BlueStatement {
  pl: IncomeSummary;
  layout: StatementLayout;
  /** 青色申告特別控除額 */
  deduction: number;
  monthly: MonthlySales;
  salaries: PayLine[];
  family: PayLine[];
  interest: PayeeLine[];
  fees: PayeeLine[];
  rent: PayeeLine[];
  depreciation: DepreciationLine[];
  /** 売上先の明細（計は売上（収入）金額。家事消費等・雑収入は上記以外に入る）・仕入先の明細（計は仕入金額） */
  sales: PartnerTable;
  purchases: PartnerTable;
  /** 売上先・仕入先の行（多い順。全部。収支内訳書は計の違う表を作る） */
  salesPartners: PartnerLine[];
  purchasePartners: PartnerLine[];
  special: string;
}

/** 書き込み欄の数値（カンマ・空白は無視。読めなければ 0） */
const num = (v: string | undefined) => Number((v ?? "").replace(/[,\s円]/g, "")) || 0;
/** 書き込み欄の整数（min〜max。読めなければ null） */
const int = (v: string | undefined, min: number, max: number) => {
  const n = Number((v ?? "").normalize("NFKC").replace(/[\s歳か月ヶ月]/g, ""));
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const METHOD_LABEL: Record<FixedAsset["method"], string> = { straight: "定額法", lump3: "一括償却", small: "少額" };

export const buildBlueStatement = (s: BlueStatementSource): BlueStatement => {
  const { accounts, notes } = s;
  const end = closingBalances(accounts, s.opening, s.lines);
  const pl = summarizeIncome(accounts, end);
  const layout = statementLayout(accounts, (a) => end.get(a.id) ?? 0, (a) => s.opening[a.id] ?? 0);
  const idOf = (code: string) => accounts.find((a) => a.code === code)?.id ?? 0;
  const drawId = idOf(CODE.OWNER_DRAW);
  const breakdown = (code: string, yearEnd: boolean) => {
    const id = idOf(code);
    const rate = yearEnd ? s.homeUseRates.find((r) => r.account_id === id && r.method === "yearend") : undefined;
    return payeeBreakdown(id, s.lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: s.excludeEntryIds });
  };
  const included = (k: string, defaultOn: boolean) => (notes[k] ? notes[k] === "1" : defaultOn);

  const pay = (rows: PayeeRow[], prefix: string): PayLine[] =>
    rows.map((r) => {
      const bonus = num(notes[`${prefix}:${r.key}:bonus`]);
      return {
        name: s.payeeName(r), relation: notes[`${prefix}:${r.key}:relation`] ?? "", work: notes[`${prefix}:${r.key}:work`] ?? "",
        age: int(notes[`${prefix}:${r.key}:age`], 1, 999), months: int(notes[`${prefix}:${r.key}:months`], 1, 12),
        salary: r.gross - bonus, bonus, total: r.gross, tax: num(notes[`${prefix}:${r.key}:tax`]),
      };
    });
  const payees = (rows: PayeeRow[], prefix: string, extraKey: string): PayeeLine[] =>
    rows.map((r) => ({
      name: s.payeeName(r), address: notes[`${prefix}:${r.key}:address`] ?? "", gross: r.gross, business: r.business,
      extra: extraKey ? num(notes[`${prefix}:${r.key}:${extraKey}`]) : 0, property: notes[`${prefix}:${r.key}:property`] ?? "",
    }));

  const interestRows = breakdown(CODE.INTEREST, true).filter((r) => included(`interest:${r.key}:use`, true));
  const feeRows = breakdown(CODE.FEES, true).filter((r) => included(`fees:${r.key}:use`, false));

  const depreciation = s.assets
    .map((a) => ({ a, d: depreciationFor(a, s.year) }))
    .filter((x) => x.d && !(x.d.opening === 0 && x.d.depreciation === 0))
    .map(({ a, d }): DepreciationLine => ({
      name: a.name, quantity: notes[`dep:${a.id}:qty`] ?? "", acquired: a.acquired_on.slice(0, 7), cost: a.cost, base: d!.base,
      method: isOldStraight(a) ? "旧定額法" : METHOD_LABEL[a.method],
      life: a.method === "straight" ? a.useful_life : a.method === "lump3" ? 3 : null, rate: d!.rate, months: d!.months,
      depreciation: d!.depreciation, businessRate: a.business_rate, business: d!.business, closing: d!.closing,
      memo: [a.method === "small" ? "措法28の2" : "", d!.equal ? "均等償却" : "", d!.disposed ? `${Number(a.disposed_on!.slice(5, 7))}月売却・除却` : "", a.memo].filter(Boolean).join(" "),
    }));

  // 売上先・仕入先の明細（計は 1ページの売上（収入）金額・仕入金額。家事消費等・雑収入は上記以外に入る）
  const salesPartners = partnerLines("sales", accounts, s.lines, notes, s.payeeName, s.invoiceNoOf);
  const purchasePartners = partnerLines("purchase", accounts, s.lines, notes, s.payeeName, s.invoiceNoOf);
  const purchaseTotal = layout.sections.cogs.find((r) => r.label === "仕入金額（製品製造原価）")?.amount ?? 0;

  return {
    pl,
    layout,
    deduction: Math.min(s.deductionLimit, Math.max(0, pl.income)),
    monthly: monthlySales(accounts, s.lines),
    salaries: pay(breakdown(CODE.SALARIES, false), "salary"),
    family: pay(breakdown(CODE.FAMILY_SALARY, false), "family"),
    interest: payees(interestRows, "interest", "loan"),
    fees: payees(feeRows, "fees", "tax"),
    rent: payees(breakdown(CODE.RENT, true), "rent", ""),
    depreciation,
    sales: partnerTable(salesPartners, pl.revenue),
    purchases: partnerTable(purchasePartners, purchaseTotal),
    salesPartners,
    purchasePartners,
    special: notes.special ?? "",
  };
};
