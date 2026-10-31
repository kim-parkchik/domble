/**
 * 事業者の情報（純粋関数）：表示する名前・郵便番号・適格請求書発行事業者の登録番号
 */
import { isValidInvoiceNo, normalizeInvoiceNo } from "./counterparty";

/** 郵便番号を「123-4567」の形にそろえる（全角・ハイフンなし・〒を許す）。7桁でなければそのまま返す */
export const normalizePostalCode = (raw: string) => {
  const digits = raw.normalize("NFKC").replace(/[〒\s\-ー－]/g, "");
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : raw.trim();
};

/** 事業者の情報の確認（問題があればメッセージ） */
export const validateBusinessInfo = (s: { business_name: string; owner_name: string; postal_code: string; address: string; invoice_no: string }): string | null => {
  if (!displayName(s)) return "氏名を入れてください";
  const pc = normalizePostalCode(s.postal_code);
  if (pc && !/^\d{3}-\d{4}$/.test(pc)) return "郵便番号は7桁の数字で入れてください（例：123-4567）";
  if (s.address.length > 200) return "住所は200文字までです";
  const inv = normalizeInvoiceNo(s.invoice_no);
  if (inv && !isValidInvoiceNo(inv)) return "登録番号は「T」と13桁の数字です（例：T1234567890123）";
  return null;
};

/** 帳簿の表示名：屋号（任意）、無ければ氏名 */
export const displayName = (s: { business_name: string; owner_name: string }) => s.business_name.trim() || s.owner_name.trim();
/** 書き出すファイルの名前に入れる名前（屋号、無ければ氏名、どちらも無ければ「帳簿」） */
export const fileLabel = (s: { business_name: string; owner_name: string }) => displayName(s) || "帳簿";
