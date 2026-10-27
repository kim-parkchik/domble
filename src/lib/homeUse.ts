/**
 * 家事按分の計算（純粋関数）
 * 端数は「事業分を切り捨て、残りを家事分（事業主貸）」にする（経費を多く見積もらない側に倒す）
 */
import type { Account, HomeUseRate, InvoiceKind, JournalLine, PurchaseUse, TaxCode } from "./types";
import type { FlatLine } from "./accounting";

export const splitByRate = (amount: number, rate: number) => {
  const business = Math.floor((amount * rate) / 100);
  return { business, private: amount - business };
};

/**
 * 「入力のたびに分ける」科目の事業割合を引く関数を作る（経費の科目で、100% 未満のものだけ）
 * 帳簿入力・振替伝票・CSV 取り込みで同じものを使う
 */
export const entryRateOf = (rates: HomeUseRate[], accounts: Account[]) => {
  const expense = new Set(accounts.filter((a) => a.category === "expense").map((a) => a.id));
  return (accountId: number): number | null => {
    const r = rates.find((x) => x.account_id === accountId);
    return r && r.method === "entry" && r.rate < 100 && expense.has(accountId) ? r.rate : null;
  };
};

/** 按分した1か所（画面で「こう分けます」と見せる） */
export interface HomeUseSplit {
  account_id: number;
  rate: number;
  amount: number;
  business: number;
  private: number;
}

/**
 * 仕訳の明細を家事按分する（振替伝票・CSV 取り込み）
 *  - 借方の経費のうち「入力のたびに分ける」科目を、事業分（その科目）と家事分（事業主貸）に分ける
 *  - 家事分は、新しい行の借方・事業主貸として足す（摘要は元の摘要＋「（家事分）」）
 *  - 事業割合 0% なら、その行をまるごと事業主貸にする
 *  - 借方に事業主貸がすでにある仕訳は、分け済みとみなしてそのままにする（二重に分けないため）
 *  - 貸方の経費（返品・取り消しなど）は分けない（帳簿入力と同じ）
 */
export const splitLinesByHomeUse = (
  lines: JournalLine[], rateOf: (accountId: number) => number | null, drawId: number,
): { lines: JournalLine[]; splits: HomeUseSplit[] } => {
  if (lines.some((l) => l.side === "debit" && l.account_id === drawId)) return { lines, splits: [] };
  let nextRow = lines.reduce((m, l) => Math.max(m, l.row_no), 0) + 1;
  const out: JournalLine[] = [];
  const added: JournalLine[] = [];
  const splits: HomeUseSplit[] = [];
  for (const l of lines) {
    const rate = l.side === "debit" && l.amount > 0 ? rateOf(l.account_id) : null;
    if (rate === null) {
      out.push(l);
      continue;
    }
    const { business, private: priv } = splitByRate(l.amount, rate);
    splits.push({ account_id: l.account_id, rate, amount: l.amount, business, private: priv });
    const privateMemo = l.memo ? `${l.memo}（家事分）` : "家事分";
    if (business === 0) {
      // 家事分は税区分を引き継がない（保存のときに事業主貸の初期値＝対象外になる）
      out.push({ ...l, account_id: drawId, sub_account_id: null, memo: privateMemo, tax_code: null, invoice_kind: null });
      continue;
    }
    out.push({ ...l, amount: business });
    if (priv > 0) added.push({ row_no: nextRow++, side: "debit", account_id: drawId, sub_account_id: null, amount: priv, memo: privateMemo });
  }
  return { lines: [...out, ...added], splits };
};

export interface YearEndRow {
  account: Account;
  rate: HomeUseRate;
  /** 年間の計上額（按分振替の仕訳を除く） */
  total: number;
  business: number;
  private: number;
}

/**
 * 年末一括方式の科目について、年間の計上額から家事分を計算する
 * @param excludeEntryIds 計算に入れない仕訳：すでに作った按分振替の仕訳（作り直すときに除く）と、
 *   固定資産台帳から作った減価償却の仕訳（資産ごとの事業専用割合で分け済み）
 */
export const yearEndRows = (
  accounts: Account[],
  lines: FlatLine[],
  rates: HomeUseRate[],
  excludeEntryIds: number[] = [],
): YearEndRow[] => {
  const rows: YearEndRow[] = [];
  for (const rate of rates) {
    if (rate.method !== "yearend" || rate.rate >= 100) continue;
    const account = accounts.find((a) => a.id === rate.account_id);
    if (!account) continue;
    const total = lines
      .filter((l) => l.account_id === account.id && !excludeEntryIds.includes(l.entry_id))
      .reduce((s, l) => s + (l.side === account.normal_side ? l.amount : -l.amount), 0);
    const { business, private: priv } = splitByRate(Math.max(0, total), rate.rate);
    rows.push({ account, rate, total, business, private: priv });
  }
  return rows;
};

/**
 * 年末一括の家事分を、その科目の明細の税区分・インボイス区分・用途区分ごとに分ける（消費税の仕入の返還を正しく出すため）。
 * 年間の計上額（返還を差し引いた額）の割合で分け、端数は大きい余りから 1 円ずつ配る。
 * 税区分の無い明細（免税事業者の期間など）の分は「対象外」。税区分がまったく無ければ1つ（null = 保存のときの初期値）
 */
export const privateTaxSplit = (
  account: Account, lines: FlatLine[], amount: number, excludeEntryIds: number[] = [],
): { tax_code: TaxCode | null; invoice_kind: InvoiceKind | null; purchase_use?: PurchaseUse | null; amount: number }[] => {
  const buckets = new Map<string, { tax_code: TaxCode | null; invoice_kind: InvoiceKind | null; purchase_use: PurchaseUse | null; base: number }>();
  for (const l of lines) {
    if (l.account_id !== account.id || excludeEntryIds.includes(l.entry_id)) continue;
    const key = `${l.tax_code ?? ""}|${l.invoice_kind ?? ""}|${l.purchase_use ?? ""}`;
    const b = buckets.get(key) ?? { tax_code: l.tax_code ?? null, invoice_kind: l.invoice_kind ?? null, purchase_use: l.purchase_use ?? null, base: 0 };
    b.base += l.side === account.normal_side ? l.amount : -l.amount;
    buckets.set(key, b);
  }
  const list = [...buckets.values()].filter((b) => b.base > 0);
  if (amount <= 0 || list.length === 0 || list.every((b) => !b.tax_code)) return [{ tax_code: null, invoice_kind: null, amount }];
  const total = list.reduce((s, b) => s + b.base, 0);
  const parts = list.map((b) => ({ ...b, exact: (amount * b.base) / total }));
  const out = parts.map((p) => ({
    tax_code: p.tax_code ?? ("none" as const), invoice_kind: p.invoice_kind, ...(p.purchase_use ? { purchase_use: p.purchase_use } : {}), amount: Math.floor(p.exact),
  }));
  let rest = amount - out.reduce((s, o) => s + o.amount, 0);
  const order = parts.map((p, i) => ({ i, r: p.exact - Math.floor(p.exact) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    out[i].amount++;
    rest--;
  }
  return out.filter((o) => o.amount > 0);
};
