/**
 * 帳簿入力のタブと、現金・預金の残高のマイナスの確かめ（純粋関数）
 * タブに出す科目は帳簿ごとに決められる（事業者の好みで、よく使う帳簿だけを並べる）。
 * まだ決めていなければ既定の科目（constants/accounts.ts の CASHBOOK_CODES）
 */
import { subKey, type Account, type SubAccount, type SubOpeningBalances } from "./types";
import { signedAmount, type FlatLine } from "./accounting";
import { shortDate, yen } from "./format";
import { CASHBOOK_CODES, isBalanceSheet } from "../constants/accounts";

/** タブにできる科目（貸借対照表の科目で、使っているもの） */
export const cashbookCandidates = (accounts: Account[]) => accounts.filter((a) => a.is_active && isBalanceSheet(a.category));

/** タブに出す科目（保存した並び順。非表示にした科目・消した科目は出さない） */
export const cashbookTabs = (accounts: Account[], saved: number[] | null): Account[] => {
  const ok = cashbookCandidates(accounts);
  if (saved === null) return CASHBOOK_CODES.map((c) => ok.find((a) => a.code === c)).filter((a): a is Account => !!a);
  return saved.map((id) => ok.find((a) => a.id === id)).filter((a): a is Account => !!a);
};

// ── 残高のマイナス ──

/**
 * 残高のマイナスを確かめる科目：現金・普通預金・定期預金と、利用者が足した預金（コード 105〜109）。
 * 当座預金は当座借越の契約でマイナスになることがあるので見ない
 */
export const isCashLike = (a: Pick<Account, "code" | "category">) => a.category === "asset" && /^10[1-9]$/.test(a.code) && a.code !== "102";

export interface NegativeBalance {
  accountId: number;
  subId: number | null;
  /** 期首残高がマイナスか */
  opening: boolean;
  /** 一日の終わりの残高がマイナスだった日（取引のあった日。日付の順） */
  dates: string[];
  /** いちばん少ない残高とその日（"" = 期首） */
  lowest: number;
  lowestDate: string;
}

/**
 * 現金・預金の残高が、期首か一日の終わりにマイナスになった日（科目・補助科目ごと）。
 * 現金や口座の残高はマイナスにならないので、入力漏れ・日付の誤り・二重の登録の手がかりになる。
 * 補助科目のある科目（普通預金の銀行ごとなど）は、補助科目ごとに見る
 */
export const negativeBalances = (accounts: Account[], subOpening: SubOpeningBalances, lines: FlatLine[]): NegativeBalance[] => {
  const out: NegativeBalance[] = [];
  for (const a of accounts.filter(isCashLike)) {
    const mine = lines.filter((l) => l.account_id === a.id);
    const fromOpening = Object.keys(subOpening).filter((k) => k.startsWith(`${a.id}:`)).map((k) => Number(k.split(":")[1]) || null);
    for (const sub of new Set([...fromOpening, ...mine.map((l) => l.sub_account_id ?? null)])) {
      const byDate = new Map<string, number>();
      for (const l of mine) if ((l.sub_account_id ?? null) === sub) byDate.set(l.date, (byDate.get(l.date) ?? 0) + signedAmount(a, l.side, l.amount));
      let balance = subOpening[subKey(a.id, sub)] ?? 0;
      const found: NegativeBalance = { accountId: a.id, subId: sub, opening: balance < 0, dates: [], lowest: Math.min(0, balance), lowestDate: "" };
      for (const date of [...byDate.keys()].sort()) {
        balance += byDate.get(date)!;
        if (balance >= 0) continue;
        found.dates.push(date);
        if (balance < found.lowest) Object.assign(found, { lowest: balance, lowestDate: date });
      }
      if (found.opening || found.dates.length) out.push(found);
    }
  }
  return out;
};

/** 知らせの文（例：現金：03/05 など 2 日（いちばん少ないのは 03/12 の ▲12,000円）、普通預金（A銀行）：期首残高 ▲5,000円） */
export const negativeText = (x: NegativeBalance, label: string) => {
  if (!x.dates.length) return `${label}：期首残高 ${yen(x.lowest)}円`;
  const days = `${shortDate(x.dates[0])}${x.dates.length > 1 ? ` など ${x.dates.length} 日` : ""}`;
  return `${label}：${x.opening ? "期首残高と " : ""}${days}（いちばん少ないのは ${x.lowestDate ? shortDate(x.lowestDate) : "期首"} の ${yen(x.lowest)}円）`;
};

/** 知らせに出す名前（補助科目のある科目の、補助科目の無い分は「（補助なし）」） */
export const negativeLabel = (x: NegativeBalance, labelOf: (accountId: number, subId: number | null) => string, subs: Pick<SubAccount, "account_id">[]) =>
  `${labelOf(x.accountId, x.subId)}${x.subId === null && subs.some((s) => s.account_id === x.accountId) ? "（補助なし）" : ""}`;
