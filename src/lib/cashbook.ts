/**
 * 帳簿入力のタブ（純粋関数）
 * タブに出す科目は帳簿ごとに決められる（事業者の好みで、よく使う帳簿だけを並べる）。
 * まだ決めていなければ既定の科目（constants/accounts.ts の CASHBOOK_CODES）
 */
import type { Account } from "./types";
import { CASHBOOK_CODES, isBalanceSheet } from "../constants/accounts";

/** タブにできる科目（貸借対照表の科目で、使っているもの） */
export const cashbookCandidates = (accounts: Account[]) => accounts.filter((a) => a.is_active && isBalanceSheet(a.category));

/** タブに出す科目（保存した並び順。非表示にした科目・消した科目は出さない） */
export const cashbookTabs = (accounts: Account[], saved: number[] | null): Account[] => {
  const ok = cashbookCandidates(accounts);
  if (saved === null) return CASHBOOK_CODES.map((c) => ok.find((a) => a.code === c)).filter((a): a is Account => !!a);
  return saved.map((id) => ok.find((a) => a.id === id)).filter((a): a is Account => !!a);
};
