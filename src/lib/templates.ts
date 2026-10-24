/**
 * 定型仕訳（純粋関数）
 * よく使う仕訳を名前をつけて保存し、振替伝票に呼び出す。金額は空のままでもよい（毎回変わる電気代など）
 */
import type { Account, SubAccount, VoucherRow } from "./types";
import { emptyRow } from "./accounting";

export interface JournalTemplate {
  id: number;
  name: string;
  rows: VoucherRow[];
  counterparty_id: number | null;
}

const isBlank = (r: VoucherRow) => !r.debitAccountId && !r.debitAmount && !r.creditAccountId && !r.creditAmount && !r.memo.trim();

/** 保存する行（空の行は除く）。問題があればメッセージ */
export const templateRows = (rows: VoucherRow[]): { rows: VoucherRow[]; error: string | null } => {
  const out = rows.filter((r) => !isBlank(r)).map((r) => ({ ...r, memo: r.memo.trim() }));
  if (!out.some((r) => r.debitAccountId || r.creditAccountId)) return { rows: out, error: "科目を1つ以上入れてください" };
  for (const [i, r] of out.entries()) {
    if (r.debitAmount && !r.debitAccountId) return { rows: out, error: `${i + 1}行目：借方の科目を選んでください` };
    if (r.creditAmount && !r.creditAccountId) return { rows: out, error: `${i + 1}行目：貸方の科目を選んでください` };
    if ((r.debitAmount ?? 0) < 0 || (r.creditAmount ?? 0) < 0) return { rows: out, error: `${i + 1}行目：金額はプラスで入れてください` };
  }
  // 金額が全部入っているなら、貸借が合っていること（一部でも空なら、呼び出したあとに入れるのでそのまま）
  const sides = out.flatMap((r) => [
    ...(r.debitAccountId ? [{ side: "debit", amount: r.debitAmount }] : []),
    ...(r.creditAccountId ? [{ side: "credit", amount: r.creditAmount }] : []),
  ]);
  if (sides.every((x) => x.amount)) {
    const dr = sides.filter((x) => x.side === "debit").reduce((t, x) => t + (x.amount ?? 0), 0);
    const cr = sides.filter((x) => x.side === "credit").reduce((t, x) => t + (x.amount ?? 0), 0);
    if (dr !== cr) {
      return { rows: out, error: `借方と貸方の合計が一致しません（差額 ${Math.abs(dr - cr).toLocaleString()} 円）。毎回変わる金額は空にして登録できます` };
    }
  }
  return { rows: out, error: null };
};

export const validateTemplateName = (list: JournalTemplate[], name: string, editingId?: number): string | null => {
  const n = name.trim();
  if (!n) return "名前を入れてください";
  if (n.length > 40) return "名前は40文字までです";
  if (list.some((t) => t.id !== editingId && t.name === n)) return "同じ名前の定型仕訳があります";
  return null;
};

/**
 * 科目（または補助科目）を消すときに、定型仕訳からその部分を外す
 *  - 科目：その科目の側（科目・補助科目・金額）を空にする。両側とも空になった行は捨てる
 *  - 補助科目：補助科目だけ空にする（科目は残す）
 * changed：変わったか。empty：科目が1つも残らなかったか（その定型仕訳は消す）
 */
export const removeFromTemplate = (rows: VoucherRow[], target: { accountId?: number; subId?: number }) => {
  let changed = false;
  const out: VoucherRow[] = [];
  for (const r of rows) {
    const x = { ...r };
    for (const side of ["debit", "credit"] as const) {
      if (target.accountId && x[`${side}AccountId`] === target.accountId) {
        x[`${side}AccountId`] = null;
        x[`${side}SubId`] = null;
        x[`${side}Amount`] = null;
        changed = true;
      }
      if (target.subId && x[`${side}SubId`] === target.subId) {
        x[`${side}SubId`] = null;
        changed = true;
      }
    }
    if (!isBlank(x)) out.push(x);
  }
  return { rows: out, changed, empty: !out.some((r) => r.debitAccountId || r.creditAccountId) };
};

/**
 * 呼び出す行。消された科目・補助科目は外す（科目が消えた側は空にし、両側とも空になった行は捨てる）
 * dropped：外した数（画面で知らせる）
 */
export const applyTemplate = (rows: VoucherRow[], accounts: Account[], subs: SubAccount[]): { rows: VoucherRow[]; dropped: number } => {
  const accIds = new Set(accounts.map((a) => a.id));
  const subOf = new Map(subs.map((s) => [s.id, s.account_id]));
  let dropped = 0;
  const out: VoucherRow[] = [];
  for (const r of rows) {
    const x = { ...emptyRow(), ...r };
    for (const side of ["debit", "credit"] as const) {
      const acc = x[`${side}AccountId`];
      const sub = x[`${side}SubId`];
      if (acc && !accIds.has(acc)) {
        dropped++;
        x[`${side}AccountId`] = null;
        x[`${side}SubId`] = null;
        x[`${side}Amount`] = null;
      } else if (sub && subOf.get(sub) !== acc) {
        dropped++;
        x[`${side}SubId`] = null;
      }
    }
    if (!isBlank(x)) out.push(x);
  }
  return { rows: out, dropped };
};
