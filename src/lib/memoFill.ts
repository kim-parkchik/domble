/**
 * 摘要からの自動入力（純粋関数）
 * 摘要を確定したとき、同じ摘要で登録したいちばん新しい仕訳（repo.findMemoEntry）から、空いている欄を埋める。
 *  - 帳簿入力：その帳簿の科目を使った仕訳の、相手の側（相手科目・補助科目・税区分）と取引先
 *  - 振替伝票：摘要が同じ行の借方・貸方（科目・補助科目・税区分）と取引先
 *  - 金額は入れない（電気代など毎回変わる額を、前回のまま登録してしまわないため。決まった額は定型仕訳で）
 *  - インボイス区分は、帳簿のみ保存の特例（交通機関など。取引の種類で決まる）だけ引き継ぐ。
 *    適格・経過措置は取引先と日付で決まるので、今の取引先・日付の初期値に任せる
 */
import type { Account, InvoiceKind, PurchaseUse, Side, SubAccount, TaxCode } from "./types";

export interface MemoEntryLine {
  row_no: number;
  side: Side;
  account_id: number;
  sub_account_id: number | null;
  memo: string;
  tax_code: TaxCode | null;
  invoice_kind: InvoiceKind | null;
  business_class: number | null;
  purchase_use: PurchaseUse | null;
}

/** 同じ摘要で登録したいちばん新しい仕訳 */
export interface MemoEntry {
  id: number;
  date: string;
  counterparty_id: number | null;
  lines: MemoEntryLine[];
}

/** 片側（科目・補助科目・税区分） */
export interface SideFill {
  accountId: number;
  subId: number | null;
  tax: TaxCode | null;
  invoice: InvoiceKind | null;
  cls: number | null;
  use: PurchaseUse | null;
}

const sideOf = (l: MemoEntryLine): SideFill => ({
  accountId: l.account_id, subId: l.sub_account_id, tax: l.tax_code,
  invoice: l.invoice_kind?.startsWith("book_") ? l.invoice_kind : null, cls: l.business_class, use: l.purchase_use,
});

/**
 * 帳簿入力：その帳簿の科目の明細（摘要が同じものを先に）の相手の側。
 * 相手は同じ行番号の反対側（家事按分で分けた事業主貸の行は使わない）。無ければ反対側が1つだけのとき。
 * 同じ科目どうし（口座の間の振替）は入れない
 */
export const bookFill = (e: MemoEntry, bookAccountId: number, memo: string): SideFill | null => {
  const m = memo.trim();
  const mine = e.lines.find((l) => l.account_id === bookAccountId && l.memo === m) ?? e.lines.find((l) => l.account_id === bookAccountId);
  if (!mine) return null;
  const others = e.lines.filter((l) => l.side !== mine.side && l.account_id !== bookAccountId);
  const counter = others.find((l) => l.row_no === mine.row_no) ?? (others.length === 1 ? others[0] : null);
  return counter ? sideOf(counter) : null;
};

/** 振替伝票：摘要が同じ行の借方・貸方 */
export const voucherFill = (e: MemoEntry, memo: string): { debit: SideFill | null; credit: SideFill | null } | null => {
  const hit = e.lines.find((l) => l.memo === memo.trim());
  if (!hit) return null;
  const row = e.lines.filter((l) => l.row_no === hit.row_no);
  const debit = row.find((l) => l.side === "debit");
  const credit = row.find((l) => l.side === "credit");
  return debit || credit ? { debit: debit ? sideOf(debit) : null, credit: credit ? sideOf(credit) : null } : null;
};

/** 今も使える形にする：非表示・消した科目なら入れない（null）。補助科目だけ使えなければ補助科目を外す */
export const usableSide = (
  f: SideFill | null, accounts: Pick<Account, "id" | "is_active">[], subs: Pick<SubAccount, "id" | "account_id" | "is_active">[],
): SideFill | null => {
  if (!f || !accounts.some((a) => a.id === f.accountId && a.is_active)) return null;
  const subOk = f.subId === null || subs.some((x) => x.id === f.subId && x.account_id === f.accountId && x.is_active);
  return subOk ? f : { ...f, subId: null };
};
