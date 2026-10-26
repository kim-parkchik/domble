/**
 * 消費税（純粋関数）
 *  - 課税区分・経理方式は年度ごと（tax_years。from_year 以降に適用し、次の設定がある年まで引き継ぐ）
 *  - 税区分は仕訳の明細ごとに持つ。初期値は科目から（科目ごとに変えられる）
 *  - インボイス区分は課税仕入の明細ごと。初期値は取引先から（「適格請求書発行事業者ではない」取引先なら経過措置）
 *  - 免税事業者の期間の明細は税区分を持たない（null）
 * 制度は令和8年分に合わせている（2割特例は令和8年分まで、3割特例は令和9年分・令和10年分、経過措置は 80% → 70% …）
 */
import type { Account, Counterparty, InvoiceKind, JournalLine, Side, TaxCode, TaxStatus, TaxYear } from "./types";
import { ACCOUNT_TAX_DEFAULTS, BUSINESS_CLASSES, INVOICE_KINDS, TAX_CODES, TAX_METHOD_OPTIONS, TAX_STATUS_OPTIONS } from "../constants/tax";
import { yearStart } from "./accounting";

const CODE_SET = new Set<string>(TAX_CODES.map((t) => t.code));
export const isTaxCode = (v: unknown): v is TaxCode => typeof v === "string" && CODE_SET.has(v);
export const isInvoiceKind = (v: unknown): v is InvoiceKind => INVOICE_KINDS.some((k) => k.value === v);

export const taxCodeDef = (code: TaxCode) => TAX_CODES.find((t) => t.code === code)!;
/** 課税仕入（インボイス区分を持つ明細） */
export const isPurchaseCode = (code: TaxCode | null | undefined) => code === "purchase10" || code === "purchase8";

// ────────────────────────────────────────────
// 年度ごとの設定
// ────────────────────────────────────────────

/** 設定が1つも無い年の扱い（免税事業者・税込経理） */
export const EXEMPT_YEAR = (year: number): TaxYear => ({ from_year: year, status: "exempt", method: "inclusive", business_class: 5, taxable_from: "" });

/** その年に効いている設定（その年以前でいちばん新しいもの）。inherited = 前の年から引き継いだもの */
export const taxYearOf = (rows: TaxYear[], year: number): TaxYear & { inherited: boolean } => {
  const r = rows.filter((x) => x.from_year <= year).sort((a, b) => b.from_year - a.from_year)[0];
  if (!r) return { ...EXEMPT_YEAR(year), inherited: false };
  // 年の途中から課税事業者になった日は、その年だけのもの
  return r.from_year === year ? { ...r, inherited: false } : { ...r, from_year: year, taxable_from: "", inherited: true };
};

/** その日の取引に税区分を付けるか（課税事業者の期間か） */
export const taxActiveOn = (rows: TaxYear[], date: string) => {
  const t = taxYearOf(rows, Number(date.slice(0, 4)));
  return t.status !== "exempt" && date >= (t.taxable_from || yearStart(t.from_year));
};

/** 課税区分をその年に選べるか（選べなければ理由） */
export const statusProblem = (status: TaxStatus, year: number): string | null => {
  const o = TAX_STATUS_OPTIONS.find((x) => x.value === status);
  if (!o) return "課税区分が正しくありません";
  if (o.years && (year < o.years[0] || year > o.years[1])) {
    return status === "twenty"
      ? "2割特例は令和8年（2026年）分の申告までです"
      : "3割特例は個人事業者の令和9年（2027年）分・令和10年（2028年）分だけです";
  }
  return null;
};

export const validateTaxYear = (t: TaxYear): string | null => {
  const s = statusProblem(t.status, t.from_year);
  if (s) return s;
  if (!TAX_METHOD_OPTIONS.some((o) => o.value === t.method && o.enabled)) return "その経理方式にはまだ対応していません";
  if (!BUSINESS_CLASSES.some((b) => b.value === t.business_class)) return "事業区分は第1種〜第6種から選んでください";
  if (t.taxable_from) {
    if (t.status === "exempt") return "免税事業者のときは「課税事業者になった日」は入れられません";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.taxable_from) || !t.taxable_from.startsWith(`${t.from_year}-`)) {
      return `課税事業者になった日は ${t.from_year}年の日付で入れてください`;
    }
  }
  return null;
};

/** 履歴に残す説明（例：課税事業者（2割特例）・税込経理・2026-10-01 から） */
export const taxYearText = (t: Pick<TaxYear, "status" | "method" | "business_class" | "taxable_from">) =>
  [
    TAX_STATUS_OPTIONS.find((o) => o.value === t.status)?.label ?? t.status,
    ...(t.status === "exempt" ? [] : [TAX_METHOD_OPTIONS.find((o) => o.value === t.method)?.label ?? t.method]),
    ...(t.status === "simplified" ? [BUSINESS_CLASSES.find((b) => b.value === t.business_class)?.label ?? ""] : []),
    ...(t.taxable_from ? [`${t.taxable_from} から課税事業者`] : []),
  ].join("・");

// ────────────────────────────────────────────
// 税区分の初期値
// ────────────────────────────────────────────

/** 科目の決まった初期値（初期科目は ACCOUNT_TAX_DEFAULTS、追加した科目は区分から） */
export const builtinTaxCode = (a: Pick<Account, "code" | "category">): TaxCode => {
  const c = ACCOUNT_TAX_DEFAULTS[a.code];
  if (c) return c;
  if (a.category === "revenue") return "sales10";
  if (a.category === "cogs" || a.category === "expense") return "purchase10";
  return "none";
};

/** 科目の税区分の初期値（科目ごとに変えていればそれ） */
export const accountTaxCode = (a: Pick<Account, "code" | "category" | "default_tax_code">): TaxCode => a.default_tax_code ?? builtinTaxCode(a);

/**
 * 明細の税区分の初期値。資産の科目の初期値は借方（取得したとき）だけに使い、貸方（売却・償却など）は対象外にする
 */
export const defaultTaxCode = (a: Pick<Account, "code" | "category" | "default_tax_code">, side: Side): TaxCode =>
  a.category === "asset" && side === "credit" ? "none" : accountTaxCode(a);

/** インボイス区分の初期値：「適格請求書発行事業者ではない」取引先なら経過措置、それ以外は適格 */
export const defaultInvoiceKind = (cp: Pick<Counterparty, "not_registered"> | null | undefined): InvoiceKind =>
  cp?.not_registered ? "transitional" : "qualified";

/**
 * 保存する明細の税区分をそろえる（repo の登録・訂正で通す）
 *  - 課税事業者の期間でなければ、税区分・インボイス区分は持たない（null）
 *  - 税区分が無ければ科目の初期値、課税仕入でインボイス区分が無ければ取引先の初期値
 *  - 課税仕入でない明細のインボイス区分は外す
 */
export const resolveLineTax = <L extends JournalLine>(
  lines: L[], active: boolean, accountOf: (id: number) => Account | undefined, cp: Counterparty | null | undefined,
): L[] =>
  lines.map((l) => {
    if (!active) return { ...l, tax_code: null, invoice_kind: null };
    const acc = accountOf(l.account_id);
    const code: TaxCode = l.tax_code && isTaxCode(l.tax_code) ? l.tax_code : acc ? defaultTaxCode(acc, l.side) : "none";
    const invoice = isPurchaseCode(code) ? (l.invoice_kind && isInvoiceKind(l.invoice_kind) ? l.invoice_kind : defaultInvoiceKind(cp)) : null;
    return { ...l, tax_code: code, invoice_kind: invoice };
  });

// ────────────────────────────────────────────
// 経過措置（適格請求書発行事業者以外の者からの課税仕入）
// ────────────────────────────────────────────

/**
 * 仕入税額相当額のうち控除できる割合（%）。課税仕入を行った日で決まる（令和8年度改正後）
 *  令和5年10月1日〜令和8年9月30日 80%、令和8年10月1日〜令和10年9月30日 70%、
 *  令和10年10月1日〜令和12年9月30日 50%、令和12年10月1日〜令和13年9月30日 30%、それ以後 0%
 */
export const transitionalRate = (date: string): number => {
  if (date < "2023-10-01") return 100; // インボイス制度の前（区分記載請求書等保存方式）
  if (date < "2026-10-01") return 80;
  if (date < "2028-10-01") return 70;
  if (date < "2030-10-01") return 50;
  if (date < "2031-10-01") return 30;
  return 0;
};

/** 表示用の短い名前（例：課仕10% 経過80%） */
export const taxShortLabel = (code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined, date: string) => {
  if (!code) return "";
  const base = taxCodeDef(code).short;
  if (!isPurchaseCode(code) || !invoice || invoice === "qualified") return base;
  return invoice === "transitional" ? `${base} 経過${transitionalRate(date)}%` : `${base} 控除なし`;
};

/** 帳簿・CSV に出す名前（例：課税仕入 10%（80%控除対象）） */
export const taxLongLabel = (code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined, date: string) => {
  if (!code) return "";
  const base = taxCodeDef(code).label;
  if (!isPurchaseCode(code) || !invoice || invoice === "qualified") return base;
  return invoice === "transitional" ? `${base}（${transitionalRate(date)}%控除対象）` : `${base}（控除しない）`;
};

// ────────────────────────────────────────────
// CSV の読み書き
// ────────────────────────────────────────────

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** CSV の税区分の文字（名前・短い名前・コード）から税区分。空なら null（初期値に従う）、読めなければ undefined */
export const parseTaxCode = (raw: string): TaxCode | null | undefined => {
  const n = norm(raw);
  if (!n) return null;
  return TAX_CODES.find((t) => norm(t.label) === n || norm(t.short) === n || t.code === n)?.code;
};

export const parseInvoiceKind = (raw: string): InvoiceKind | null | undefined => {
  const n = norm(raw);
  if (!n) return null;
  return INVOICE_KINDS.find((k) => norm(k.label) === n || norm(k.short) === n || k.value === n)?.value;
};

/** CSV に書くインボイス区分（課税仕入でなければ空） */
export const invoiceCsvLabel = (code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined) =>
  isPurchaseCode(code) && invoice ? INVOICE_KINDS.find((k) => k.value === invoice)!.short : "";
