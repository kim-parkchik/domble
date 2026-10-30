/**
 * 消費税まわりの定義（選択肢・税区分・科目の初期値）
 * 計算や判定は lib/tax.ts。制度は令和8年分に合わせています。
 */
import type { DeductionMethod, InvoiceKind, PurchaseUse, TaxCode, TaxMethod, TaxStatus } from "../lib/types";

/**
 * 課税区分。years は選べる年（2割特例は令和8年分まで、3割特例は個人事業者の令和9年分・令和10年分）
 */
export const TAX_STATUS_OPTIONS: { value: TaxStatus; label: string; years?: [number, number] }[] = [
  { value: "exempt", label: "免税事業者" },
  { value: "standard", label: "課税事業者（本則課税）" },
  { value: "simplified", label: "課税事業者（簡易課税）" },
  { value: "twenty", label: "課税事業者（2割特例）", years: [2023, 2026] },
  { value: "thirty", label: "課税事業者（3割特例）", years: [2027, 2028] },
];

export const TAX_METHOD_OPTIONS: { value: TaxMethod; label: string; enabled: boolean }[] = [
  { value: "inclusive", label: "税込経理", enabled: true },
  { value: "exclusive", label: "税抜経理", enabled: false },
];

/** 簡易課税の事業区分とみなし仕入率（%） */
export const BUSINESS_CLASSES: { value: number; label: string; rate: number }[] = [
  { value: 1, label: "第1種（卸売業）", rate: 90 },
  { value: 2, label: "第2種（小売業など）", rate: 80 },
  { value: 3, label: "第3種（製造業・建設業など）", rate: 70 },
  { value: 4, label: "第4種（飲食店業など、ほかに当たらない事業）", rate: 60 },
  { value: 5, label: "第5種（サービス業・運輸通信業・金融業など）", rate: 50 },
  { value: 6, label: "第6種（不動産業）", rate: 40 },
];

/** 課税仕入の用途区分（本則課税の個別対応方式。付表2-3 の ⑲ 課税対応・⑳ 共通対応。非課税対応は控除しない） */
export const PURCHASE_USES: { value: PurchaseUse; label: string; short: string }[] = [
  { value: "taxable", label: "課税対応（課税売上にだけ要するもの）", short: "課対" },
  { value: "common", label: "共通対応（課税売上と非課税売上に共通して要するもの）", short: "共通" },
  { value: "nontaxable", label: "非課税対応（非課税売上にだけ要するもの）", short: "非対" },
];

/** 本則課税で課税売上割合が 95% 未満（または課税売上高が5億円超）のときの控除の方式 */
export const DEDUCTION_METHODS: { value: DeductionMethod; label: string }[] = [
  { value: "individual", label: "個別対応方式" },
  { value: "lump", label: "一括比例配分方式" },
];

/**
 * 仕訳の明細の税区分（journal_lines.tax_code）
 *  - group：sales = 売上側、purchase = 仕入側、other = 対象外
 *  - rate：税率（%）。0 は税がかからないもの
 *  - 値引き・返品は区分を増やさず、貸借の側で判定する（売上の科目が借方なら売上の返還、仕入・経費の科目が貸方なら仕入の返還）
 */
export const TAX_CODES: { code: TaxCode; label: string; short: string; group: "sales" | "purchase" | "other"; rate: number }[] = [
  { code: "none", label: "対象外", short: "対象外", group: "other", rate: 0 },
  { code: "sales10", label: "課税売上 10%", short: "課売10%", group: "sales", rate: 10 },
  { code: "sales8", label: "課税売上 8%（軽減）", short: "課売8%軽", group: "sales", rate: 8 },
  { code: "export", label: "輸出免税", short: "輸出免税", group: "sales", rate: 0 },
  { code: "sales_nontax", label: "非課税売上", short: "非課売", group: "sales", rate: 0 },
  { code: "purchase10", label: "課税仕入 10%", short: "課仕10%", group: "purchase", rate: 10 },
  { code: "purchase8", label: "課税仕入 8%（軽減）", short: "課仕8%軽", group: "purchase", rate: 8 },
  { code: "purchase_nontax", label: "非課税仕入", short: "非課仕", group: "purchase", rate: 0 },
  { code: "baddebt10", label: "貸倒れ 10%", short: "貸倒10%", group: "sales", rate: 10 },
  { code: "baddebt8", label: "貸倒れ 8%（軽減）", short: "貸倒8%軽", group: "sales", rate: 8 },
];

/** インボイス区分（課税仕入の明細だけ） */
export const INVOICE_KINDS: { value: InvoiceKind; label: string; short: string }[] = [
  { value: "qualified", label: "適格（インボイスあり）", short: "適格" },
  { value: "transitional", label: "経過措置（インボイスなし）", short: "経過措置" },
  { value: "none", label: "控除しない", short: "控除なし" },
];

/**
 * 初期科目の税区分の初期値（科目コード → 税区分）。ここに無い科目は区分から決める（lib/tax.ts の builtinTaxCode）
 * 勘定科目の画面で科目ごとに変えられる（accounts.default_tax_code）
 */
export const ACCOUNT_TAX_DEFAULTS: Record<string, TaxCode> = {
  // 資産：固定資産は取得（借方）のとき課税仕入。土地は非課税
  "130": "purchase10", "131": "purchase10", "132": "purchase10", "133": "purchase10", "134": "purchase10",
  "135": "purchase_nontax", "136": "purchase10", "137": "purchase10", "138": "purchase10",
  // 収益（家事消費等は棚卸資産の家事消費で課税）
  "401": "sales10", "402": "sales10", "403": "sales10",
  // 売上原価
  "501": "none", "502": "purchase10", "503": "none",
  // 経費
  "601": "none", "602": "purchase10", "603": "purchase10", "604": "purchase10", "605": "purchase10",
  "606": "purchase10", "607": "purchase10", "608": "purchase_nontax", "609": "purchase10", "610": "purchase10",
  "611": "none", "612": "purchase10", "613": "none", "614": "purchase10", "615": "purchase_nontax",
  "616": "purchase10", "617": "baddebt10", "620": "purchase10", "621": "purchase10", "622": "purchase10",
  "623": "purchase10", "624": "purchase10", "625": "none", "699": "purchase10",
  // 法定福利費（社会保険料・労働保険料の事業主負担）・固定資産除却損は対象外。開業費は支出したときの課税仕入。未払消費税等は対象外
  "670": "none", "671": "none", "160": "purchase10", "260": "none",
  "701": "none",
};

export const TAX_DISABLED_NOTE = "免税事業者の期間のため、税区分は「対象外」で固定です";
