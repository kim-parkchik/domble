import { expect, test } from "bun:test";
import { ACCOUNT_SEEDS, CASHBOOK_CODES } from "../constants/accounts";
import type { Account } from "./types";
import { cashbookCandidates, cashbookTabs } from "./cashbook";

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
