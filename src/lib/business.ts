/**
 * 事業者の情報（純粋関数）：郵便番号・適格請求書発行事業者の登録番号
 */
import { isValidInvoiceNo, normalizeInvoiceNo } from "./counterparty";

/** 郵便番号を「123-4567」の形にそろえる（全角・ハイフンなし・〒を許す）。7桁でなければそのまま返す */
export const normalizePostalCode = (raw: string) => {
  const digits = raw.normalize("NFKC").replace(/[〒\s\-ー－]/g, "");
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : raw.trim();
};

/** 事業者の情報の確認（問題があればメッセージ） */
export const validateBusinessInfo = (s: { postal_code: string; address: string; invoice_no: string }): string | null => {
  const pc = normalizePostalCode(s.postal_code);
  if (pc && !/^\d{3}-\d{4}$/.test(pc)) return "郵便番号は7桁の数字で入れてください（例：123-4567）";
  if (s.address.length > 200) return "住所は200文字までです";
  const inv = normalizeInvoiceNo(s.invoice_no);
  if (inv && !isValidInvoiceNo(inv)) return "登録番号は「T」と13桁の数字です（例：T1234567890123）";
  return null;
};
