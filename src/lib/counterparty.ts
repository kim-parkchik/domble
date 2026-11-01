/**
 * 取引先（純粋関数）
 *  - 使うかどうかは任意。仕訳1件に1つ、証憑にも付けられる
 *  - 適格請求書発行事業者の登録番号は「T + 13桁」。任意
 *  - 法人番号は13桁（先頭が検査用数字）。任意。決算書の売上先・仕入先の明細の「登録番号（法人番号）」に、登録番号が無いときに書く
 */
import type { Counterparty } from "./types";

/** 名前の比較用（全角半角・大文字小文字・空白の違いを無視） */
export const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** 登録番号を「T1234567890123」の形にそろえる（全角・ハイフン・空白を許す） */
export const normalizeInvoiceNo = (raw: string) => raw.normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");

export const isValidInvoiceNo = (s: string) => /^T\d{13}$/.test(s);

/** 法人番号を13桁の数字にそろえる（全角・ハイフン・空白を許す） */
export const normalizeCorporateNo = (raw: string) => raw.normalize("NFKC").replace(/[\s-]/g, "");

/**
 * 法人番号として正しいか（13桁で、先頭の検査用数字が合う）。
 * 検査用数字 = 9 −（下の桁から n 桁目の数字 × (n が奇数なら 1、偶数なら 2) を12桁分足した和を 9 で割った余り）
 */
export const isValidCorporateNo = (s: string) => {
  if (!/^\d{13}$/.test(s)) return false;
  const base = s.slice(1);
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += Number(base[12 - n]) * (n % 2 === 1 ? 1 : 2);
  return Number(s[0]) === 9 - (sum % 9);
};

export interface CounterpartyInput {
  name: string;
  kana: string;
  invoice_no: string;
  /** 法人番号（13桁。任意） */
  corporate_no?: string;
  /** 適格請求書発行事業者ではない（免税事業者など）。この取引先からの課税仕入は初期値が「経過措置」になる */
  not_registered?: boolean;
  memo: string;
}

export const validateCounterparty = (list: Counterparty[], d: CounterpartyInput, editingId?: number): string | null => {
  const name = d.name.trim();
  if (!name) return "取引先名を入れてください";
  if (name.length > 60) return "取引先名は60文字までです";
  if (list.some((c) => c.id !== editingId && normName(c.name) === normName(name))) return "同じ名前の取引先があります";
  const inv = normalizeInvoiceNo(d.invoice_no);
  if (inv && !isValidInvoiceNo(inv)) return "登録番号は「T」と13桁の数字です（例：T1234567890123）";
  if (inv && list.some((c) => c.id !== editingId && c.invoice_no === inv)) return "同じ登録番号の取引先があります";
  if (inv && d.not_registered) return "登録番号がある取引先は「適格請求書発行事業者ではない」にできません";
  const corp = normalizeCorporateNo(d.corporate_no ?? "");
  if (corp && !/^\d{13}$/.test(corp)) return "法人番号は13桁の数字です";
  if (corp && !isValidCorporateNo(corp)) return "法人番号の検査用数字（先頭の1桁）が合いません。番号を確かめてください";
  if (d.memo.length > 200) return "メモは200文字までです";
  return null;
};

/** 入力された名前から取引先を探す（名前の完全一致。表記ゆれは normName で吸収） */
export const findCounterparty = (list: Counterparty[], text: string) => {
  const n = normName(text);
  return n ? list.find((c) => normName(c.name) === n) ?? null : null;
};
