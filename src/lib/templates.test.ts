import { expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, SubAccount, VoucherRow } from "./types";
import { emptyRow } from "./accounting";
import { applyTemplate, removeFromTemplate, templateForBook, templateRows, validateTemplateName } from "./templates";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const id = (n: string) => accounts.find((a) => a.name === n)!.id;
const subs: SubAccount[] = [{ id: 1, account_id: id("普通預金"), name: "A銀行", kana: "", sort_order: 1, is_active: 1 }];
const row = (p: Partial<VoucherRow>): VoucherRow => ({ ...emptyRow(), ...p });

test("保存する行：空の行は除き、金額は空でもよい", () => {
  const r = templateRows([row({ debitAccountId: id("水道光熱費"), creditAccountId: id("普通預金"), creditSubId: 1, memo: " 電気代 " }), emptyRow()]);
  expect(r.error).toBeNull();
  expect(r.rows).toEqual([row({ debitAccountId: id("水道光熱費"), creditAccountId: id("普通預金"), creditSubId: 1, memo: "電気代" })]);
});

test("保存する行：科目が無い・金額だけ・マイナスは不可", () => {
  expect(templateRows([emptyRow()]).error).toMatch(/科目を1つ以上/);
  expect(templateRows([row({ debitAmount: 100, creditAccountId: id("現金") })]).error).toMatch(/借方の科目/);
  expect(templateRows([row({ debitAccountId: id("現金"), debitAmount: -1 })]).error).toMatch(/プラス/);
});

test("名前：空・長すぎ・重複は不可（自分自身は除く）", () => {
  const list = [{ id: 1, name: "家賃", rows: [], counterparty_id: null }];
  expect(validateTemplateName(list, " ")).toMatch(/名前を/);
  expect(validateTemplateName(list, "家賃")).toMatch(/同じ名前/);
  expect(validateTemplateName(list, "家賃", 1)).toBeNull();
  expect(validateTemplateName(list, "あ".repeat(41))).toMatch(/40文字/);
});

test("呼び出し：消された科目・合わない補助科目は外して知らせる", () => {
  const rows = [
    row({ debitAccountId: id("地代家賃"), debitAmount: 80000, creditAccountId: id("普通預金"), creditSubId: 1, creditAmount: 80000 }),
    row({ debitAccountId: 9999, debitAmount: 100 }),
    row({ debitAccountId: id("現金"), debitSubId: 1 }),
  ];
  const r = applyTemplate(rows, accounts, subs);
  expect(r.dropped).toBe(2);
  expect(r.rows).toEqual([rows[0], row({ debitAccountId: id("現金") })]);
});

test("保存する行：金額が全部入っているなら貸借が合うこと。一部でも空ならそのまま", () => {
  const rent = row({ debitAccountId: id("地代家賃"), debitAmount: 80000, creditAccountId: id("普通預金"), creditAmount: 79000 });
  expect(templateRows([rent]).error).toMatch(/差額 1,000 円/);
  expect(templateRows([{ ...rent, creditAmount: 80000 }]).error).toBeNull();
  // 給料 300,000 ／ 普通預金（空）・預り金（空）
  const salary = [
    row({ debitAccountId: id("給料賃金"), debitAmount: 300000, creditAccountId: id("普通預金") }),
    row({ creditAccountId: id("預り金") }),
  ];
  expect(templateRows(salary).error).toBeNull();
  // 複合で金額が全部入っていて合っている
  expect(templateRows([
    row({ debitAccountId: id("給料賃金"), debitAmount: 300000, creditAccountId: id("普通預金"), creditAmount: 280000 }),
    row({ creditAccountId: id("預り金"), creditAmount: 20000 }),
  ]).error).toBeNull();
});

test("科目を消すとき：その科目の側だけ外し、科目が残らなければ空と知らせる", () => {
  const rows = [
    row({ debitAccountId: id("給料賃金"), debitAmount: 300000, creditAccountId: id("普通預金"), creditSubId: 1, creditAmount: 280000, memo: "給料" }),
    row({ creditAccountId: id("預り金"), creditAmount: 20000 }),
  ];
  const r = removeFromTemplate(rows, { accountId: id("預り金") });
  expect(r).toEqual({ rows: [rows[0]], changed: true, empty: false });
  expect(removeFromTemplate(rows, { accountId: id("現金") }).changed).toBe(false);
  const only = removeFromTemplate([row({ debitAccountId: id("現金"), debitAmount: 1 })], { accountId: id("現金") });
  expect(only).toEqual({ rows: [], changed: true, empty: true });
});

test("補助科目を消すとき：補助科目だけ空にして科目は残す", () => {
  const rows = [row({ debitAccountId: id("地代家賃"), creditAccountId: id("普通預金"), creditSubId: 1 })];
  expect(removeFromTemplate(rows, { subId: 1 })).toEqual({
    rows: [row({ debitAccountId: id("地代家賃"), creditAccountId: id("普通預金") })], changed: true, empty: false,
  });
});

test("帳簿入力に入れる形：この帳簿の科目と相手科目1つの定型仕訳だけ。相手の税区分も", () => {
  const bank = id("普通預金");
  const electric = row({ debitAccountId: id("水道光熱費"), debitTax: "purchase10", creditAccountId: bank, creditSubId: 1, memo: "電気代" });
  expect(templateForBook([electric], bank, "普通預金")).toEqual({
    bookDebit: false, counterId: id("水道光熱費"), counterSubId: null, amount: null, memo: "電気代", tax: { code: "purchase10", invoice: null, cls: null, use: null },
  });
  // 入金（この帳簿が借方）。金額は相手の側、なければこの帳簿の側
  expect(templateForBook([row({ debitAccountId: bank, debitAmount: 5_000, creditAccountId: id("売上高") })], bank, "普通預金")).toMatchObject({ bookDebit: true, counterId: id("売上高"), amount: 5_000 });
  expect(templateForBook([electric, electric], bank, "普通預金")).toEqual({ error: expect.stringMatching(/何行も/) });
  expect(templateForBook([electric], id("現金"), "現金")).toEqual({ error: expect.stringMatching(/現金を使っていない/) });
  expect(templateForBook([row({ debitAccountId: bank, creditAccountId: bank, creditSubId: 1 })], bank, "普通預金")).toEqual({ error: expect.stringMatching(/同じ科目どうし/) });
});
