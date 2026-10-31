import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS, CASHBOOK_CODES } from "../constants/accounts";
import { subKey, type Account } from "./types";
import type { FlatLine } from "./accounting";
import { cashbookCandidates, cashbookTabs, isCashLike, negativeBalances, negativeLabel, negativeText } from "./cashbook";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const byCode = (c: string) => accounts.find((a) => a.code === c)!;

test("決めていなければ既定の科目（並びも既定どおり）", () => {
  expect(cashbookTabs(accounts, null).map((a) => a.code)).toEqual(CASHBOOK_CODES.filter((c) => accounts.some((a) => a.code === c)));
});

test("保存した並び順。非表示・損益の科目・無い科目は出さない", () => {
  const hidden = { ...byCode("102"), is_active: 0 };
  const list = accounts.map((a) => (a.code === "102" ? hidden : a));
  const saved = [byCode("103").id, byCode("102").id, byCode("401").id, 9999, byCode("101").id];
  expect(cashbookTabs(list, saved).map((a) => a.code)).toEqual(["103", "101"]);
});

test("タブにできるのは使っている貸借対照表の科目だけ", () => {
  expect(cashbookCandidates(accounts).every((a) => ["asset", "liability", "equity"].includes(a.category))).toBe(true);
});

describe("現金・預金の残高のマイナス", () => {
  const cash = byCode("101");
  const bank = byCode("103");
  let n = 0;
  /** 現金・預金の明細（入金は借方、出金は貸方） */
  const line = (date: string, account: Account, amount: number, sub: number | null = null): FlatLine => ({
    entry_id: ++n, date, description: "", row_no: 1, side: amount >= 0 ? "debit" : "credit", account_id: account.id, sub_account_id: sub, amount: Math.abs(amount), memo: "", counterparty_id: null,
  });
  test("一日の終わりの残高で見る（同じ日に入金があれば戻る）。いちばん少ない日も", () => {
    const lines = [
      line("2026-03-05", cash, -15_000), line("2026-03-05", cash, 3_000), // 期首 10,000 → 3/5 の終わりに −2,000
      line("2026-03-12", cash, -10_000), // −12,000
      line("2026-03-20", cash, 20_000), // 8,000
      line("2026-04-01", cash, -1_000), line("2026-04-01", cash, 1_000), // 同じ日に戻る
    ];
    const found = negativeBalances(accounts, { [subKey(cash.id, null)]: 10_000 }, lines);
    expect(found).toEqual([{ accountId: cash.id, subId: null, opening: false, dates: ["2026-03-05", "2026-03-12"], lowest: -12_000, lowestDate: "2026-03-12" }]);
    expect(negativeText(found[0], "現金")).toBe("現金：03/05 など 2 日（いちばん少ないのは 03/12 の ▲12,000円）");
  });
  test("補助科目ごと（銀行ごと）。当座預金・売掛金は見ない", () => {
    const lines = [line("2026-01-10", bank, -5_000, 1), line("2026-01-10", bank, 5_000, 2), line("2026-01-10", byCode("102"), -9_000), line("2026-01-10", byCode("111"), -9_000)];
    expect(negativeBalances(accounts, {}, lines).map((x) => [x.accountId, x.subId, x.lowest])).toEqual([[bank.id, 1, -5_000]]);
    expect([byCode("101"), byCode("103"), byCode("104")].every(isCashLike)).toBe(true);
    expect([byCode("102"), byCode("111")].some(isCashLike)).toBe(false);
  });
  test("期首残高のマイナスも（その年に取引が無くても）", () => {
    const only = negativeBalances(accounts, { [subKey(bank.id, 2)]: -5_000 }, []);
    expect(only).toEqual([{ accountId: bank.id, subId: 2, opening: true, dates: [], lowest: -5_000, lowestDate: "" }]);
    expect(negativeText(only[0], "普通預金（B銀行）")).toBe("普通預金（B銀行）：期首残高 ▲5,000円");
    // 補助科目のある科目の、補助科目の無い分
    const label = (id: number, sub: number | null) => (sub ? `普通預金（${sub}）` : "普通預金");
    expect(negativeLabel({ ...only[0], subId: null }, label, [{ account_id: bank.id }])).toBe("普通預金（補助なし）");
    expect(negativeLabel({ ...only[0], subId: null }, label, [])).toBe("普通預金");
    const both = negativeBalances(accounts, { [subKey(cash.id, null)]: -1_000 }, [line("2026-02-01", cash, -500)]);
    expect(negativeText(both[0], "現金")).toBe("現金：期首残高と 02/01（いちばん少ないのは 02/01 の ▲1,500円）");
  });
});
