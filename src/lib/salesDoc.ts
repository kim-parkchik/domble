/**
 * 見積書・請求書（純粋関数）。保存は repo の sales_docs・sales_payments、画面は features/sales/SalesDocsPage.tsx
 *  - 金額：明細ごとに 数量 × 単価（端数は設定の丸め方）。単価は税抜か税込かを書類ごとに選ぶ
 *  - 消費税：適格請求書の決まりどおり、税率ごとに合計してから1回だけ端数を処理する（税抜なら 合計 × 税率、税込なら 合計 × 税率 /（100＋税率））。
 *    免税事業者の年は、登録番号と消費税額を出さない（税率ごとに分けず、金額をそのまま合計）
 *  - 源泉徴収（報酬・料金）：消費税が区分されていれば税抜の額、区分されていなければ税込の額に、100万円までは 10.21%、
 *    100万円を超える部分は 20.42%（1円未満切り捨て。国税庁 No.2795・No.2798）。差引請求額 ＝ 合計 − 源泉徴収税額
 *  - 仕訳（請求書を発行したとき）：売掛金（差引請求額）＋ 事業主貸（源泉徴収税額） ／ 売上の科目（税率ごとに税込の額。税区分つき）。
 *    税抜経理の年は、税率ごとの消費税額を仕訳の消費税額にする（請求書の額と合わせる）
 *  - 入金：預金（受け取った額）＋ 振込手数料（差し引かれた額） ／ 売掛金。差引請求額から入金の合計を引いた残りで、入金済みを決める
 *  - 明細の取り込みの入金の候補：入金の額が残りと同じか、残りより振込手数料の分（1,000円まで）だけ少ない請求書
 */
import type { JournalLine, TaxCode } from "./types";

export type DocKind = "estimate" | "invoice";
export const DOC_KIND_LABEL: Record<DocKind, string> = { estimate: "見積書", invoice: "請求書" };
/** draft 下書き ／ issued 発行済み ／ void 取消 */
export type DocStatus = "draft" | "issued" | "void";
/** 明細の税：10% ／ 8%（軽減） ／ 輸出免税 ／ 非課税 ／ 対象外（立替金など） */
export type ItemTax = "10" | "8" | "export" | "nontax" | "none";
export const ITEM_TAX_LABEL: Record<ItemTax, string> = { "10": "10%", "8": "8%（軽減）", export: "輸出免税", nontax: "非課税", none: "対象外" };
const ITEM_TAX_CODE: Record<ItemTax, TaxCode> = { "10": "sales10", "8": "sales8", export: "export", nontax: "sales_nontax", none: "none" };
const ITEM_RATE: Record<ItemTax, number> = { "10": 10, "8": 8, export: 0, nontax: 0, none: 0 };
/** 単価が税抜か税込か */
export type PriceMode = "exclusive" | "inclusive";
/** 端数の丸め方（明細の金額と、税率ごとの消費税額） */
export type Rounding = "floor" | "round" | "ceil";
export const ROUNDING_LABEL: Record<Rounding, string> = { floor: "切り捨て", round: "四捨五入", ceil: "切り上げ" };

export interface DocItem {
  name: string;
  /** 数量（小数第2位まで） */
  qty: number;
  unit: string;
  /** 単価（円。整数） */
  price: number;
  tax: ItemTax;
}

export interface SalesDoc {
  id: number;
  kind: DocKind;
  /** 番号（初めは年ごとの連番。直せる） */
  doc_no: string;
  /** 発行日（請求日・見積日） */
  issue_date: string;
  /** 取引年月日（納品日など。あれば売上をこの日に立てる） */
  delivery_date: string | null;
  /** 支払期限（請求書）・有効期限（見積書） */
  due_date: string | null;
  counterparty_id: number | null;
  /** 宛名と敬称・住所 */
  to_name: string;
  honorific: string;
  to_address: string;
  subject: string;
  items: DocItem[];
  price_mode: PriceMode;
  /** 源泉徴収あり（1） */
  withholding: number;
  notes: string;
  /** 振込先（請求書） */
  bank_text: string;
  status: DocStatus;
  /** 見積書から写した請求書の、元の見積書 */
  source_id: number | null;
  /** 売掛金の仕訳（請求書を発行したとき） */
  entry_id: number | null;
  /** 売上の科目（null = 売上高） */
  revenue_account_id: number | null;
  /** 保存したときの丸め方と、免税事業者の年だったか（1）。あとで設定や課税区分を変えても、保存した書類の金額は変わらない */
  rounding: Rounding;
  exempt: number;
}

export interface SalesPayment {
  id: number;
  doc_id: number;
  /** 入金の仕訳（domble で作ったもの、明細の取り込みで作ったもの） */
  entry_id: number | null;
  paid_on: string;
  /** 売掛金から消した額（受け取った額 ＋ 差し引かれた振込手数料） */
  amount: number;
}

const roundBy = (n: number, r: Rounding) => {
  // 小数の誤差（0.1 × 3 など）で切り捨て・切り上げがずれないように、少しだけ寄せてから丸める
  const x = Math.round(n * 1e6) / 1e6;
  return r === "floor" ? Math.floor(x) : r === "ceil" ? Math.ceil(x) : Math.round(x);
};

/** 明細の金額（数量 × 単価） */
export const itemAmount = (it: Pick<DocItem, "qty" | "price">, r: Rounding) => roundBy(it.qty * it.price, r);

export interface TaxGroup {
  tax: ItemTax;
  rate: number;
  /** 対価の額（税抜。税のない区分は金額） */
  base: number;
  tax_amount: number;
  /** 税込 */
  total: number;
}

export interface DocTotals {
  /** 明細ごとの金額 */
  amounts: number[];
  /** 税率・区分ごと（明細に出てくる順。10%・8%・輸出免税・非課税・対象外） */
  groups: TaxGroup[];
  /** 税抜の合計（免税の年は金額の合計） */
  subtotal: number;
  taxTotal: number;
  /** 税込の合計 */
  total: number;
  /** 源泉徴収税額の対象額と税額（源泉徴収なしなら 0） */
  withholdingBase: number;
  withholding: number;
  /** 差引請求額（合計 − 源泉徴収税額） */
  billed: number;
  /** 免税事業者の年（登録番号・消費税額を出さない） */
  exempt: boolean;
}

const GROUP_ORDER: ItemTax[] = ["10", "8", "export", "nontax", "none"];

/** 源泉徴収税額（報酬・料金。100万円までは 10.21%、超える部分は 20.42%。1円未満切り捨て） */
export const withholdingTax = (base: number) =>
  base <= 0 ? 0 : base <= 1_000_000 ? Math.floor((base * 1021) / 10000) : Math.floor(((base - 1_000_000) * 2042) / 10000) + 102_100;

/** 書類の金額（exempt = 売上の日の年が免税事業者） */
export const docTotals = (d: Pick<SalesDoc, "items" | "price_mode" | "withholding">, rounding: Rounding, exempt: boolean): DocTotals => {
  const amounts = d.items.map((it) => itemAmount(it, rounding));
  const sumOf = (t: ItemTax) => d.items.reduce((s, it, i) => s + (it.tax === t ? amounts[i] : 0), 0);
  const groups: TaxGroup[] = exempt
    ? (d.items.length ? [{ tax: "none" as ItemTax, rate: 0, base: amounts.reduce((s, a) => s + a, 0), tax_amount: 0, total: amounts.reduce((s, a) => s + a, 0) }] : [])
    : GROUP_ORDER.filter((t) => d.items.some((it) => it.tax === t)).map((t) => {
      const rate = ITEM_RATE[t];
      const sum = sumOf(t);
      if (!rate) return { tax: t, rate, base: sum, tax_amount: 0, total: sum };
      if (d.price_mode === "exclusive") {
        const tax = roundBy((sum * rate) / 100, rounding);
        return { tax: t, rate, base: sum, tax_amount: tax, total: sum + tax };
      }
      const tax = roundBy((sum * rate) / (100 + rate), rounding);
      return { tax: t, rate, base: sum - tax, tax_amount: tax, total: sum };
    });
  const subtotal = groups.reduce((s, g) => s + g.base, 0);
  const taxTotal = groups.reduce((s, g) => s + g.tax_amount, 0);
  const total = subtotal + taxTotal;
  // 消費税が区分されていれば税抜の額、免税の年（区分なし）は税込の額
  const withholdingBase = d.withholding ? (exempt ? total : subtotal) : 0;
  const withholding = withholdingTax(withholdingBase);
  return { amounts, groups, subtotal, taxTotal, total, withholdingBase, withholding, billed: total - withholding, exempt };
};

/** 書類の確かめ。問題があれば文言 */
export const docProblem = (d: Omit<SalesDoc, "id" | "status" | "entry_id" | "source_id" | "rounding" | "exempt">): string | null => {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!d.doc_no.trim()) return "番号を入れてください";
  if (!date.test(d.issue_date)) return `${d.kind === "invoice" ? "請求日" : "見積日"}を入れてください`;
  if (d.delivery_date && !date.test(d.delivery_date)) return "取引日が正しくありません";
  if (d.due_date && !date.test(d.due_date)) return `${d.kind === "invoice" ? "支払期限" : "有効期限"}が正しくありません`;
  if (!d.to_name.trim()) return "宛名を入れてください";
  if (d.items.length === 0) return "明細を1行以上入れてください";
  if (d.items.length > 60) return "明細は60行までです";
  for (const [i, it] of d.items.entries()) {
    if (!it.name.trim()) return `${i + 1}行目の品名を入れてください`;
    if (!Number.isFinite(it.qty) || it.qty <= 0 || Math.round(it.qty * 100) !== it.qty * 100) return `${i + 1}行目の数量は 0 より大きい数（小数第2位まで）で入れてください`;
    if (!Number.isInteger(it.price) || it.price < 0) return `${i + 1}行目の単価は 0円以上の整数で入れてください`;
    if (!(it.tax in ITEM_TAX_LABEL)) return `${i + 1}行目の税の区分が正しくありません`;
  }
  return null;
};

/** 保存した書類の金額（保存したときの丸め方・課税区分で） */
export const savedTotals = (d: Pick<SalesDoc, "items" | "price_mode" | "withholding" | "rounding" | "exempt">) => docTotals(d, d.rounding, !!d.exempt);

/** 次の番号（年ごとの連番。「2026-0001」の形。直した番号は数えない） */
export const nextDocNo = (existing: string[], year: number) => {
  const nums = existing.map((n) => n.match(new RegExp(`^${year}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  return `${year}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0")}`;
};

/** 売上を立てる日（取引日があればその日、無ければ発行日） */
export const salesDate = (d: Pick<SalesDoc, "issue_date" | "delivery_date">) => d.delivery_date || d.issue_date;

/** 仕訳の摘要 */
export const docMemo = (d: Pick<SalesDoc, "kind" | "doc_no" | "subject">) => `${DOC_KIND_LABEL[d.kind]} ${d.doc_no}${d.subject.trim() ? ` ${d.subject.trim()}` : ""}`;

/**
 * 請求書を発行したときの仕訳の明細：借方 売掛金（差引請求額）・事業主貸（源泉徴収税額）、貸方 売上の科目（税率・区分ごとに税込の額。税区分つき）
 * 税率ごとの消費税額は、税抜経理の年の仕訳の消費税額にする（税込経理の年は使われない）
 */
export const invoiceEntryLines = (
  d: Pick<SalesDoc, "kind" | "doc_no" | "subject">, t: DocTotals, ids: { receivable: number; revenue: number; draw: number },
): JournalLine[] => {
  const memo = docMemo(d);
  const debits: JournalLine[] = [
    { row_no: 0, side: "debit" as const, account_id: ids.receivable, sub_account_id: null, amount: t.billed, memo },
    ...(t.withholding ? [{ row_no: 0, side: "debit" as const, account_id: ids.draw, sub_account_id: null, amount: t.withholding, memo: `${memo}（源泉徴収税額）` }] : []),
  ].filter((l) => l.amount > 0);
  const credits: JournalLine[] = t.groups.filter((g) => g.total > 0).map((g) => ({
    row_no: 0, side: "credit", account_id: ids.revenue, sub_account_id: null, amount: g.total, memo,
    tax_code: t.exempt ? null : ITEM_TAX_CODE[g.tax], tax_amount: g.rate ? g.tax_amount : null,
  }));
  const rows = Math.max(debits.length, credits.length);
  const out: JournalLine[] = [];
  for (let i = 0; i < rows; i++) {
    if (debits[i]) out.push({ ...debits[i], row_no: i + 1 });
    if (credits[i]) out.push({ ...credits[i], row_no: i + 1 });
  }
  return out;
};

/** 入金の仕訳の明細：預金（受け取った額）＋ 振込手数料（差し引かれた額） ／ 売掛金 */
export const paymentEntryLines = (
  p: { amount: number; fee: number; memo: string }, ids: { bank: number; receivable: number; fee: number },
): JournalLine[] => [
  { row_no: 1, side: "debit", account_id: ids.bank, sub_account_id: null, amount: p.amount, memo: p.memo },
  { row_no: 1, side: "credit", account_id: ids.receivable, sub_account_id: null, amount: p.amount + p.fee, memo: p.memo },
  ...(p.fee > 0 ? [{ row_no: 2, side: "debit" as const, account_id: ids.fee, sub_account_id: null, amount: p.fee, memo: `${p.memo}（振込手数料）` }] : []),
];

/** 入金の残り（差引請求額 − 入金の合計） */
export const remainingOf = (billed: number, payments: Pick<SalesPayment, "amount">[]) => billed - payments.reduce((s, p) => s + p.amount, 0);

/** 一覧に出す状態 */
export type DocState = "draft" | "issued" | "partial" | "paid" | "void" | "converted";
export const DOC_STATE_LABEL: Record<DocState, string> = {
  draft: "下書き", issued: "発行済み", partial: "一部入金", paid: "入金済み", void: "取消", converted: "請求書にした",
};
export const docState = (d: Pick<SalesDoc, "kind" | "status">, remaining: number, billed: number, converted = false): DocState =>
  d.status === "void" ? "void"
  : d.status === "draft" ? "draft"
  : d.kind === "estimate" ? (converted ? "converted" : "issued")
  : remaining <= 0 ? "paid"
  : remaining < billed ? "partial" : "issued";

/** 明細の取り込みの入金の候補（振込手数料の分だけ少なく入るのは 1,000円まで） */
export const FEE_LIMIT = 1_000;
export interface OpenInvoice {
  id: number;
  doc_no: string;
  to_name: string;
  /** 取引先の名前・よみ（明細の摘要と比べる） */
  names: string[];
  remaining: number;
  due_date: string | null;
}
/** 会社の種類（株式会社・振込の「カ）」など）を除き、ひらがなをカタカナ・全角半角をそろえて比べる */
const AFFIX = /株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)|カ\)|\(カ|ユ\)|\(ユ|ド\)|\(ド/g;
const normName = (s: string) =>
  s.normalize("NFKC").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(AFFIX, "").replace(/[\s・.,()]/g, "").toUpperCase();

/**
 * 入金の明細（額・摘要）に合う請求書：残りと同じ額か、残りより振込手数料の分だけ少ない額。
 * 摘要に取引先の名前・よみがあるもの、振込手数料の無いもの、期限の早いものから。fee = 差し引かれた額
 */
export const paymentCandidates = (line: { amount: number; description: string }, open: OpenInvoice[]) => {
  const desc = normName(line.description);
  return open
    .map((o) => ({ o, fee: o.remaining - line.amount, named: o.names.some((n) => normName(n).length >= 2 && desc.includes(normName(n))) }))
    .filter((x) => x.fee >= 0 && x.fee <= FEE_LIMIT)
    .sort((a, b) => Number(b.named) - Number(a.named) || a.fee - b.fee || (a.o.due_date ?? "9999").localeCompare(b.o.due_date ?? "9999"))
    .map((x) => ({ id: x.o.id, doc_no: x.o.doc_no, to_name: x.o.to_name, fee: x.fee, named: x.named }));
};
