/**
 * 決算整理の仕訳（純粋関数）。12月31日付の決算整理仕訳で作り、作り直すときは同じ仕訳を訂正する（repo.saveYearEndRun）
 *  - 棚卸：期首の振替「期首商品棚卸高 / 棚卸資産（期首の棚卸高）」と、期末の振替「棚卸資産 / 期末商品棚卸高（期末の棚卸高）」を1本で。
 *          期首の棚卸高は帳簿の期首残高（前の年の期末の棚卸高を繰り越したもの）。期末の棚卸高は棚卸表（品名・数量・単価）の合計か、金額で入れる
 *          （青色申告の決算の手引き「棚卸表の作成」。棚卸表は作って保存する：所得税法施行規則60条）
 *  - 未払消費税等：税込経理で、その年の申告書の ㉖（中間納付を差し引いた後）を「租税公課 / 未払消費税等」に。還付なら「未収入金 / 雑収入」。どちらも対象外
 *          （国税庁 No.6901：納付税額は申告書を出した年の必要経費が原則。年末に未払金に計上すれば、その年の必要経費にできる）
 *  - 振り戻し：決算整理仕訳（未払費用・前払費用など）を、翌年1月1日付で逆の仕訳にする
 */
import type { JournalLine } from "./types";

/** 棚卸表の1行 */
export interface InventoryRow {
  name: string;
  quantity: number;
  /** 単価（円。取得価額。最終仕入原価法なら最後に仕入れたときの単価） */
  unitPrice: number;
}

/** その年の棚卸（期末の棚卸高と棚卸表） */
export interface InventoryCount {
  /** 棚卸表が無いときに使う、期末の棚卸高（円） */
  amount: number;
  rows: InventoryRow[];
}

/** 棚卸表の1行の金額（1円未満切り捨て） */
export const rowAmount = (r: InventoryRow) => Math.floor(r.quantity * r.unitPrice);

/** 期末の棚卸高：棚卸表があればその合計、無ければ入れた金額 */
export const closingInventory = (c: InventoryCount | null) => (!c ? 0 : c.rows.length ? c.rows.reduce((t, r) => t + rowAmount(r), 0) : c.amount);

/** 入力の確かめ。問題があれば文言を返す */
export const inventoryProblem = (c: InventoryCount): string | null => {
  if (!Number.isInteger(c.amount) || c.amount < 0) return "期末の棚卸高は 0円以上の整数で入れてください";
  for (const [i, r] of c.rows.entries()) {
    if (!r.name.trim()) return `棚卸表の${i + 1}行目の品名を入れてください`;
    if (!Number.isFinite(r.quantity) || r.quantity < 0) return `棚卸表の${i + 1}行目の数量は 0 以上で入れてください`;
    if (!Number.isFinite(r.unitPrice) || r.unitPrice < 0) return `棚卸表の${i + 1}行目の単価は 0 以上で入れてください`;
  }
  return null;
};

const line = (row_no: number, side: JournalLine["side"], account_id: number, amount: number, memo: string): JournalLine =>
  ({ row_no, side, account_id, sub_account_id: null, amount, memo, tax_code: "none" });

/** 棚卸の振替の明細（期首・期末。0円の側は作らない） */
export const inventoryLines = (opening: number, closing: number, ids: { openingAccount: number; closingAccount: number; stock: number }): JournalLine[] => {
  const out: JournalLine[] = [];
  let row = 0;
  if (opening > 0) {
    row++;
    out.push(line(row, "debit", ids.openingAccount, opening, "期首の棚卸高の振替"), line(row, "credit", ids.stock, opening, "期首の棚卸高の振替"));
  }
  if (closing > 0) {
    row++;
    out.push(line(row, "debit", ids.stock, closing, "期末の棚卸高"), line(row, "credit", ids.closingAccount, closing, "期末の棚卸高"));
  }
  return out;
};

/** 未払消費税等（還付なら未収）の明細。total = 申告書の ㉖（納付はプラス・還付はマイナス） */
export const accruedTaxLines = (total: number, ids: { taxes: number; accrued: number; receivable: number; misc: number }): JournalLine[] =>
  total > 0
    ? [line(1, "debit", ids.taxes, total, "未払消費税等"), line(1, "credit", ids.accrued, total, "未払消費税等")]
    : total < 0
      ? [line(1, "debit", ids.receivable, -total, "未収消費税等（還付）"), line(1, "credit", ids.misc, -total, "未収消費税等（還付）")]
      : [];

/** 振り戻しの明細：貸借を入れ替える（税区分などはそのまま） */
export const reversalLines = (lines: JournalLine[]): JournalLine[] =>
  lines.map((l) => ({
    row_no: l.row_no, side: l.side === "debit" ? "credit" : "debit", account_id: l.account_id, sub_account_id: l.sub_account_id, amount: l.amount,
    memo: `振り戻し ${l.memo}`.trim(), tax_code: l.tax_code ?? null, invoice_kind: l.invoice_kind ?? null, business_class: l.business_class ?? null, purchase_use: l.purchase_use ?? null,
  }));

/** 棚卸の確かめ：期首の振替と期首残高、期末の棚卸高と棚卸資産の残高が合っているか（合っていなければ文言） */
export const inventoryIssues = (x: { openingStock: number; openingTransferred: number; closingStock: number; closingCounted: number }): string[] => {
  const out: string[] = [];
  if (x.openingTransferred !== x.openingStock) {
    out.push(`期首商品棚卸高（${x.openingTransferred.toLocaleString()}円）が、棚卸資産の期首残高（${x.openingStock.toLocaleString()}円）と違います。期首の振替が足りないか、二重になっていないか確かめてください`);
  }
  if (x.closingStock !== x.closingCounted) {
    out.push(`棚卸資産の期末残高（${x.closingStock.toLocaleString()}円）が、期末商品棚卸高（${x.closingCounted.toLocaleString()}円）と違います`);
  }
  return out;
};
