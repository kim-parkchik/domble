/**
 * 貸倒引当金（純粋関数）。国税庁「青色申告の決算の手引き」Ⅶ、青色申告決算書の書き方「貸倒引当金繰入額の計算」
 *  - 一括評価（青色申告の年だけ）：年末の一括評価による貸金の合計額 × 5.5%（金融業は 3.3%。1円未満切り捨て）まで繰り入れられる
 *    貸金は売掛金・受取手形・貸付金・未収入金の年末の残高から始め、対象にならないもの（家事上の貸金・保証金・敷金・手付金・前渡金・
 *    仮払金・立替金・同じ相手の買掛金と相殺できる額・個別評価の相手の分など）を引き、割り引いたり裏書譲渡した手形を足す（調整の欄）
 *  - 個別評価：額を入れるだけ（計算は国税庁の「個別評価による貸倒引当金の繰入れをする方へ」）
 *  - 洗替：前年末の貸倒引当金（期首残高）を戻し入れて本年の収入（繰戻額等）にし、本年分（①＋④）を繰り入れる（繰入額等）
 * 決算書の書き込み（statement_notes）に持つもの：
 *  allowance:individual 個別評価による本年分繰入額 ／ allowance:adjust 貸金の調整（＋−） ／ allowance:finance 金融業（"1"） ／
 *  allowance:amount 一括評価で繰り入れる額（空なら繰入限度額）
 */
import type { Account, JournalLine } from "./types";
import { CODE } from "../constants/accounts";

/** 一括評価の繰入率（千分率） */
export const ALLOWANCE_RATE_MIL = { general: 55, finance: 33 };
/** 一括評価の貸金の初めの額にする科目（受取手形・売掛金・貸付金・未収入金） */
export const RECEIVABLE_CODES: string[] = [CODE.NOTES_RECEIVABLE, CODE.RECEIVABLE, CODE.LOAN, CODE.ACCRUED];

export const ALLOWANCE_NOTE = { individual: "allowance:individual", adjust: "allowance:adjust", finance: "allowance:finance", amount: "allowance:amount" } as const;

/** 貸倒引当金の3つの科目（初期の科目。コードが使われていたときは、同じ名前・区分・残高の側の科目） */
export const allowanceAccounts = (accounts: Account[]) => {
  const find = (code: string, name: string, category: Account["category"], side: Account["normal_side"]) =>
    accounts.find((a) => a.code === code && a.category === category && a.normal_side === side) ??
    accounts.find((a) => a.name === name && a.category === category && a.normal_side === side);
  return {
    allowance: find(CODE.ALLOWANCE, "貸倒引当金", "liability", "credit"),
    add: find(CODE.ALLOWANCE_ADD, "貸倒引当金繰入", "special", "debit"),
    back: find(CODE.ALLOWANCE_BACK, "貸倒引当金戻入", "special", "credit"),
  };
};

export interface AllowanceCalc {
  /** 貸金の初めの額にした科目と年末の残高 */
  receivables: { name: string; amount: number }[];
  /** 貸金の調整（＋−） */
  adjust: number;
  /** ② 年末における一括評価による貸倒引当金の繰入れの対象となる貸金の合計額 */
  base: number;
  finance: boolean;
  /** ③ 本年分繰入限度額 */
  limit: number;
  /** ④ 本年分繰入額（一括評価） */
  bulk: number;
  /** ① 個別評価による本年分繰入額 */
  individual: number;
  /** ⑤ 本年分の貸倒引当金繰入額（①＋④。1ページの繰入額等「貸倒引当金」） */
  total: number;
  /** 前年からの繰戻し（期首の貸倒引当金。1ページの繰戻額等「貸倒引当金」） */
  reversal: number;
  /** 確かめてほしいこと */
  problems: string[];
}

/** 書き込みの整数（カンマ・空白・円は無視。読めなければ null） */
const int = (v: string | undefined) => {
  const s = (v ?? "").normalize("NFKC").replace(/[,\s円]/g, "").replace(/^[△▲]/, "-");
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
};

/**
 * 決算書の「貸倒引当金繰入額の計算」。end = 期末残高（年末の貸倒引当金の仕訳の前でも後でも同じ：売掛金などは動かさない）、
 * openingAllowance = 期首の貸倒引当金。blue = 青色申告の年（白色申告の年は一括評価を使えない）
 */
export const allowanceCalc = (
  accounts: Account[], end: (a: Account) => number, openingAllowance: number, notes: Record<string, string>, blue: boolean,
): AllowanceCalc => {
  const problems: string[] = [];
  const receivables = RECEIVABLE_CODES
    .map((code) => accounts.find((a) => a.code === code && a.category === "asset"))
    .filter((a): a is Account => !!a)
    .map((a) => ({ name: a.name, amount: end(a) }));
  const adjust = int(notes[ALLOWANCE_NOTE.adjust]) ?? 0;
  const base = Math.max(0, receivables.reduce((s, r) => s + r.amount, 0) + adjust);
  const finance = notes[ALLOWANCE_NOTE.finance] === "1";
  const limit = blue ? Math.floor((base * (finance ? ALLOWANCE_RATE_MIL.finance : ALLOWANCE_RATE_MIL.general)) / 1000) : 0;
  const chosen = int(notes[ALLOWANCE_NOTE.amount]);
  if (chosen !== null && chosen > limit) problems.push(`一括評価の本年分繰入額（${chosen.toLocaleString()}円）が繰入限度額を超えているので、限度額にしています`);
  if (chosen !== null && chosen < 0) problems.push("一括評価の本年分繰入額は 0円以上にしてください");
  const bulk = Math.max(0, Math.min(chosen ?? limit, limit));
  const individual = Math.max(0, int(notes[ALLOWANCE_NOTE.individual]) ?? 0);
  return { receivables, adjust, base, finance, limit, bulk, individual, total: individual + bulk, reversal: Math.max(0, openingAllowance), problems };
};

/**
 * 年末の貸倒引当金の仕訳（洗替）：「貸倒引当金 / 貸倒引当金戻入」（期首残高）と「貸倒引当金繰入 / 貸倒引当金」（本年分）。
 * 科目が無ければ null
 */
export const allowanceLines = (accounts: Account[], calc: AllowanceCalc): JournalLine[] | null => {
  const { allowance, add, back } = allowanceAccounts(accounts);
  if (!allowance || !add || !back) return null;
  const lines: JournalLine[] = [];
  let row = 0;
  if (calc.reversal > 0) {
    row++;
    lines.push({ row_no: row, side: "debit", account_id: allowance.id, sub_account_id: null, amount: calc.reversal, memo: "貸倒引当金の戻入（前年分）" });
    lines.push({ row_no: row, side: "credit", account_id: back.id, sub_account_id: null, amount: calc.reversal, memo: "貸倒引当金の戻入（前年分）" });
  }
  if (calc.total > 0) {
    row++;
    lines.push({ row_no: row, side: "debit", account_id: add.id, sub_account_id: null, amount: calc.total, memo: "貸倒引当金の繰入（本年分）" });
    lines.push({ row_no: row, side: "credit", account_id: allowance.id, sub_account_id: null, amount: calc.total, memo: "貸倒引当金の繰入（本年分）" });
  }
  return lines;
};
