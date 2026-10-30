/**
 * 消費税（純粋関数）
 *  - 課税区分・経理方式は年度ごと（tax_years。from_year 以降に適用し、次の設定がある年まで引き継ぐ）
 *  - 税区分は仕訳の明細ごとに持つ。初期値は科目から（科目ごとに変えられる）
 *  - インボイス区分は課税仕入の明細ごと。初期値は取引先から（「適格請求書発行事業者ではない」取引先なら経過措置）
 *  - 免税事業者の期間の明細は税区分を持たない（null）
 *  - 簡易課税の事業区分は課税売上の明細ごと。登録するときに、明細で選んだ区分 → 科目の初期値（固定資産の売却は第4種）→ 年度の「主な事業区分」
 *    の順で決めて記録する（あとで「主な事業区分」を変えても、登録済みの売上は変わらない）。区分の無い売上は「不明」として扱う
 *  - 本則課税の用途区分（課税対応・非課税対応・共通対応）は課税仕入の明細ごと。登録するときに、明細で選んだ区分 → 科目の初期値 → 共通対応
 *    の順で決めて記録する（本則課税の年）。区分の無い課税仕入は共通対応として計算し、「確認」で知らせる
 *  - 課税売上割合が 95% 未満のときの控除の方式（個別対応方式・一括比例配分方式）は年度ごと。一括比例配分方式は2年続けて使う決まり
 * 制度は令和8年分に合わせている（2割特例は令和8年分まで、3割特例は令和9年分・令和10年分、経過措置は 80% → 70% …）
 */
import type { Account, Counterparty, DeductionMethod, InvoiceKind, JournalLine, PurchaseUse, Side, TaxCode, TaxStatus, TaxYear } from "./types";
import {
  ACCOUNT_TAX_DEFAULTS, BUSINESS_CLASSES, DEDUCTION_METHODS, INVOICE_KINDS, PURCHASE_USES, TAX_CODES, TAX_METHOD_OPTIONS, TAX_STATUS_OPTIONS,
} from "../constants/tax";
import { yearStart } from "./accounting";

const CODE_SET = new Set<string>(TAX_CODES.map((t) => t.code));
export const isTaxCode = (v: unknown): v is TaxCode => typeof v === "string" && CODE_SET.has(v);
export const isInvoiceKind = (v: unknown): v is InvoiceKind => INVOICE_KINDS.some((k) => k.value === v);
/** 帳簿のみ保存の特例（控除は適格と同じ） */
export const isBookOnly = (v: InvoiceKind | null | undefined) => !!v && v.startsWith("book_");
/** 控除が適格と同じインボイス区分（適格・帳簿のみ保存の特例） */
export const isFullyDeductible = (v: InvoiceKind | null | undefined) => !v || v === "qualified" || isBookOnly(v);
const invoiceDef = (v: InvoiceKind) => INVOICE_KINDS.find((k) => k.value === v)!;

export const taxCodeDef = (code: TaxCode) => TAX_CODES.find((t) => t.code === code)!;
/** 課税仕入（インボイス区分を持つ明細） */
export const isPurchaseCode = (code: TaxCode | null | undefined) => code === "purchase10" || code === "purchase8";
/** 輸入の消費税（国税の額そのもの） */
export const isImportCode = (code: TaxCode | null | undefined) => code === "import10" || code === "import8";
/** 税抜経理で消費税額を分ける税区分（課税売上・課税仕入・貸倒れ・輸入の消費税） */
export const splitsTax = (code: TaxCode | null | undefined) =>
  code === "sales10" || code === "sales8" || code === "baddebt10" || code === "baddebt8" || isPurchaseCode(code) || isImportCode(code);
/** 本則課税で用途区分を持つ明細（課税仕入・輸入の消費税・特定課税仕入れ） */
export const takesPurchaseUse = (code: TaxCode | null | undefined) => isPurchaseCode(code) || isImportCode(code) || code === "reverse10";
/** 課税売上（簡易課税の事業区分を持つ明細） */
export const isSalesCode = (code: TaxCode | null | undefined) => code === "sales10" || code === "sales8";
export const isBusinessClass = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6;
export const isPurchaseUse = (v: unknown): v is PurchaseUse => PURCHASE_USES.some((u) => u.value === v);
export const isDeductionMethod = (v: unknown): v is DeductionMethod => DEDUCTION_METHODS.some((d) => d.value === v);

/**
 * 科目の事業区分の初期値：資産の科目（業務用の固定資産などの売却）は第4種、科目に初期値があればそれ、無ければ null
 */
export const defaultBusinessClass = (a: Pick<Account, "category" | "default_business_class">): number | null =>
  a.category === "asset" ? 4 : a.default_business_class ?? null;

/** 登録するときに記録する事業区分（明細 → 科目の初期値 → 年度の「主な事業区分」）。入力欄の初期表示にも使う */
export const effectiveBusinessClass = (
  l: { business_class?: number | null }, a: Pick<Account, "category" | "default_business_class"> | undefined, mainClass: number,
) => l.business_class ?? (a ? defaultBusinessClass(a) : null) ?? mainClass;

/** 用途区分（明細 → 科目の初期値 → 共通対応）。入力欄の初期表示にも使う */
export const effectivePurchaseUse = (l: { purchase_use?: PurchaseUse | null }, a: Pick<Account, "default_purchase_use"> | undefined): PurchaseUse =>
  l.purchase_use ?? a?.default_purchase_use ?? "common";

// ────────────────────────────────────────────
// 年度ごとの設定
// ────────────────────────────────────────────

/** 設定が1つも無い年の扱い（免税事業者・税込経理） */
export const EXEMPT_YEAR = (year: number): TaxYear => ({
  from_year: year, status: "exempt", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0,
});

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
  if (!isDeductionMethod(t.deduction ?? "individual")) return "控除の方式は個別対応方式か一括比例配分方式から選んでください";
  if (![0, 1].includes(t.voluntary_interim ?? 0)) return "任意の中間申告の届出が正しくありません";
  if (t.taxable_from) {
    if (t.status === "exempt") return "免税事業者のときは「課税事業者になった日」は入れられません";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.taxable_from) || !t.taxable_from.startsWith(`${t.from_year}-`)) {
      return `課税事業者になった日は ${t.from_year}年の日付で入れてください`;
    }
  }
  return null;
};

/**
 * 個別対応方式を選べるか（選べなければ理由）。一括比例配分方式は2年以上続けて使ってからでないと個別対応方式に変えられないため、
 * 前の年が本則課税・一括比例配分方式で、その前の年はそうでない（1年しか使っていない）なら選べない
 */
export const deductionProblem = (rows: TaxYear[], year: number, deduction: DeductionMethod): string | null => {
  if (deduction !== "individual") return null;
  const lump = (y: number) => {
    const t = taxYearOf(rows, y);
    return t.status === "standard" && (t.deduction ?? "individual") === "lump";
  };
  return lump(year - 1) && !lump(year - 2)
    ? `${year - 1}年に一括比例配分方式にしたため、${year}年は個別対応方式にできません（一括比例配分方式は2年続けて使う決まり）`
    : null;
};

/** 履歴に残す説明（例：課税事業者（2割特例）・税込経理・2026-10-01 から） */
export const taxYearText = (t: Pick<TaxYear, "status" | "method" | "business_class" | "taxable_from" | "deduction"> & Partial<Pick<TaxYear, "voluntary_interim">>) =>
  [
    TAX_STATUS_OPTIONS.find((o) => o.value === t.status)?.label ?? t.status,
    ...(t.status === "exempt" ? [] : [TAX_METHOD_OPTIONS.find((o) => o.value === t.method)?.label ?? t.method]),
    ...(t.status === "simplified" ? [BUSINESS_CLASSES.find((b) => b.value === t.business_class)?.label ?? ""] : []),
    ...(t.status === "standard" ? [DEDUCTION_METHODS.find((d) => d.value === t.deduction)?.label ?? ""] : []),
    ...(t.taxable_from ? [`${t.taxable_from} から課税事業者`] : []),
    ...(t.status !== "exempt" && t.voluntary_interim ? ["任意の中間申告の届出あり"] : []),
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
 *  - 課税売上の事業区分は、入っていなければ科目の初期値（資産の科目は第4種）、無ければ mainClass（簡易課税の年の「主な事業区分」）。課税売上でなければ外す
 *  - 課税仕入の用途区分は、入っていなければ科目の初期値、無ければ mainUse（本則課税の年の共通対応）。課税仕入でなければ外す
 *  - 手で直した消費税額は、税抜経理の年（exclusive）の消費税額を分ける明細だけ残す（ほかは null = 自動）
 */
export const resolveLineTax = <L extends JournalLine>(
  lines: L[], active: boolean, accountOf: (id: number) => Account | undefined, cp: Counterparty | null | undefined,
  /** 簡易課税の年の「主な事業区分」（区分も科目の初期値も無い課税売上に記録する。null なら記録しない＝不明のまま） */
  mainClass: number | null = null,
  /** 本則課税の年の用途区分の最後の初期値（共通対応。null なら記録しない＝分からないまま） */
  mainUse: PurchaseUse | null = null,
  /** 税抜経理の年か */
  exclusive = false,
): L[] =>
  lines.map((l) => {
    if (!active) return { ...l, tax_code: null, invoice_kind: null, business_class: null, purchase_use: null, tax_amount: null };
    const acc = accountOf(l.account_id);
    const code: TaxCode = l.tax_code && isTaxCode(l.tax_code) ? l.tax_code : acc ? defaultTaxCode(acc, l.side) : "none";
    const invoice = isPurchaseCode(code) ? (l.invoice_kind && isInvoiceKind(l.invoice_kind) ? l.invoice_kind : defaultInvoiceKind(cp)) : null;
    const cls = isSalesCode(code) ? (isBusinessClass(l.business_class) ? l.business_class : (acc ? defaultBusinessClass(acc) : null) ?? mainClass) : null;
    const use = takesPurchaseUse(code) ? (isPurchaseUse(l.purchase_use) ? l.purchase_use : acc?.default_purchase_use ?? mainUse) : null;
    const taxAmount = exclusive && splitsTax(code) && Number.isInteger(l.tax_amount) ? l.tax_amount : null;
    return { ...l, tax_code: code, invoice_kind: invoice, business_class: cls, purchase_use: use, tax_amount: taxAmount };
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

const CLASS_KANJI = ["", "一", "二", "三", "四", "五", "六"];
/** 事業区分の短い名前（例：5種） */
export const classShort = (cls: number) => `${cls}種`;
/** 事業区分の名前（例：第五種） */
export const classLabel = (cls: number) => `第${CLASS_KANJI[cls]}種`;

/**
 * 表示する事業区分：記録した区分。簡易課税の年の課税売上で区分が無ければ 0（不明）
 */
export const displayClass = (taxYears: TaxYear[], l: { date: string; tax_code?: TaxCode | null; business_class?: number | null }) =>
  l.business_class ?? (isSalesCode(l.tax_code) && taxYearOf(taxYears, Number(l.date.slice(0, 4))).status === "simplified" ? 0 : null);

/** 用途区分の短い名前（例：課対）・名前（例：課税対応） */
export const useShort = (u: PurchaseUse) => PURCHASE_USES.find((x) => x.value === u)!.short;
export const useLabel = (u: PurchaseUse) => PURCHASE_USES.find((x) => x.value === u)!.label.replace(/（.*）/, "");

/**
 * 表示する用途区分：本則課税の年の課税仕入だけ（記録した区分。無ければ null）。それ以外の年は出さない
 */
export const displayUse = (taxYears: TaxYear[], l: { date: string; tax_code?: TaxCode | null; purchase_use?: PurchaseUse | null }) =>
  takesPurchaseUse(l.tax_code) && taxYearOf(taxYears, Number(l.date.slice(0, 4))).status === "standard" ? l.purchase_use ?? null : null;

/**
 * 表示用の短い名前（例：課仕10% 経過80%、課売10% 5種、課仕10% 課対）。cls = 0 は事業区分が分からない売上
 * 用途区分は課税対応・非課税対応だけ出す（共通対応は出さない。showCommon で出す）
 */
export const taxShortLabel = (
  code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined, date: string, cls?: number | null, use?: PurchaseUse | null, showCommon = false,
) => {
  if (!code) return "";
  if (isSalesCode(code) && cls === 0) return `${taxCodeDef(code).short} 区分不明`;
  if (isSalesCode(code) && cls) return `${taxCodeDef(code).short} ${classShort(cls)}`;
  const base = taxCodeDef(code).short;
  if (!takesPurchaseUse(code)) return base;
  if (!isPurchaseCode(code)) return use && (use !== "common" || showCommon) ? `${base} ${useShort(use)}` : base;
  const inv = !invoice || invoice === "qualified" ? "" : invoice === "transitional" ? ` 経過${transitionalRate(date)}%` : isBookOnly(invoice) ? ` ${invoiceDef(invoice).short}` : " 控除なし";
  const u = use && (use !== "common" || showCommon) ? ` ${useShort(use)}` : "";
  return `${base}${inv}${u}`;
};

/** 帳簿に出す名前（例：課税仕入 10%（80%控除対象）、課税売上 10%（第五種）、課税仕入 10%（課税対応）） */
export const taxLongLabel = (
  code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined, date: string, cls?: number | null, use?: PurchaseUse | null,
) => {
  if (!code) return "";
  if (isSalesCode(code) && cls === 0) return `${taxCodeDef(code).label}（事業区分不明）`;
  if (isSalesCode(code) && cls) return `${taxCodeDef(code).label}（${classLabel(cls)}）`;
  const base = taxCodeDef(code).label;
  if (!takesPurchaseUse(code)) return base;
  if (!isPurchaseCode(code)) return use ? `${base}（${useLabel(use)}）` : base;
  const notes = [
    ...(!invoice || invoice === "qualified" ? [] : [invoice === "transitional" ? `${transitionalRate(date)}%控除対象` : isBookOnly(invoice) ? invoiceDef(invoice).label : "控除しない"]),
    ...(use ? [useLabel(use)] : []),
  ];
  return notes.length ? `${base}（${notes.join("・")}）` : base;
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

/** CSV の事業区分の文字（5、5種、第5種、第五種）。空なら null、読めなければ undefined */
export const parseBusinessClass = (raw: string): number | null | undefined => {
  const n = norm(raw);
  if (!n) return null;
  const m = n.match(/^第?([1-6一二三四五六])種?(事業)?$/);
  if (!m) return undefined;
  const d = Number(m[1]);
  return Number.isNaN(d) ? CLASS_KANJI.indexOf(m[1]) : d;
};

/** CSV の用途区分の文字（課税対応・課対・taxable など）。空なら null、読めなければ undefined */
export const parsePurchaseUse = (raw: string): PurchaseUse | null | undefined => {
  const n = norm(raw);
  if (!n) return null;
  return PURCHASE_USES.find((u) => norm(useLabel(u.value)) === n || norm(u.short) === n || norm(u.label) === n || u.value === n)?.value;
};

/** CSV に書くインボイス区分（課税仕入でなければ空） */
export const invoiceCsvLabel = (code: TaxCode | null | undefined, invoice: InvoiceKind | null | undefined) =>
  isPurchaseCode(code) && invoice ? INVOICE_KINDS.find((k) => k.value === invoice)!.short : "";
