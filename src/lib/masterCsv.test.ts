/**
 * 期首残高・勘定科目・補助科目・取引先の一覧の CSV
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, Counterparty, SubAccount } from "./types";
import { subKey } from "./types";
import { toCsv } from "./csv";
import {
  ACCOUNT_LIST_HEADER, accountListRows, COUNTERPARTY_LIST_HEADER, counterpartyListRows, OPENING_HEADER, openingCsvRows, parseAccountListCsv, parseCounterpartyCsv,
  parseOpeningCsv, parseSubListCsv, SUB_LIST_HEADER, subListRows,
} from "./masterCsv";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, income_kind: s.income_kind ?? "business", default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const subs: SubAccount[] = [{ id: 1, account_id: id("普通預金"), name: "みずほ銀行", kana: "", sort_order: 10, is_active: 1 }];

describe("期首残高の CSV", () => {
  test("書き出したものをそのまま読める（補助科目ごと・同じ行は足す）。損益の科目・無い科目と補助科目は問題", () => {
    const values = { [subKey(id("現金"), null)]: 30_000, [subKey(id("普通預金"), 1)]: 500_000, [subKey(id("元入金"), null)]: 530_000 };
    const text = toCsv(OPENING_HEADER, openingCsvRows(accounts, subs, values));
    expect(parseOpeningCsv(text, accounts, subs)).toEqual({ values, issues: [] });
    const other = toCsv(["勘定科目", "補助科目", "期首残高"], [["現金", "", "10,000"], ["現金", "", "5000"], ["売上高", "", "1"], ["普通預金", "ゆうちょ", "1"], ["前受金", "", "▲3000"]]);
    const r = parseOpeningCsv(other, accounts, subs);
    expect(r.values[subKey(id("現金"), null)]).toBe(15_000);
    expect(r.values[subKey(id("前受金"), null)]).toBe(-3_000);
    expect(r.issues.map((x) => x.row)).toEqual([4, 5]);
  });
});

describe("一覧の CSV", () => {
  test("科目：無い名前だけ。区分は名前で読む（ほかのソフトの言い換えも）。読めない区分は問題", () => {
    const text = toCsv(ACCOUNT_LIST_HEADER, [...accountListRows(accounts.slice(0, 2)), ["", "車両費", "しゃりょうひ", "販売費及び一般管理費"], ["650", "保守料", "", "経費"], ["", "謎", "", "その他"]]);
    const r = parseAccountListCsv(text, accounts);
    // 書き出した2件と、初期科目にある車両費は飛ばす
    expect(r.skipped).toBe(3);
    expect(r.rows).toEqual([{ code: "650", name: "保守料", kana: "", category: "expense" }]);
    expect(r.issues.map((x) => x.row)).toEqual([6]);
  });
  test("補助科目：科目の名前で探し、無い名前だけ。取引先：無い名前だけ、登録番号と印を読む", () => {
    const subText = toCsv(SUB_LIST_HEADER, [...subListRows(accounts, subs), ["普通預金", "ゆうちょ銀行", ""], ["無い科目", "x", ""]]);
    const r = parseSubListCsv(subText, accounts, subs);
    expect([r.skipped, r.rows, r.issues.length]).toEqual([1, [{ accountId: id("普通預金"), name: "ゆうちょ銀行", kana: "" }], 1]);
    const cps: Counterparty[] = [{ id: 1, name: "株式会社A", kana: "", invoice_no: "", not_registered: 0, memo: "", is_active: 1 }];
    const cpText = toCsv(COUNTERPARTY_LIST_HEADER, [...counterpartyListRows(cps), ["個人の外注", "", "", "○", "メモ"], ["株式会社B", "びー", "T1234567890123", "", ""]]);
    const c = parseCounterpartyCsv(cpText, cps);
    expect(c.skipped).toBe(1);
    expect(c.rows).toEqual([
      { name: "個人の外注", kana: "", invoice_no: "", not_registered: true, memo: "メモ" },
      { name: "株式会社B", kana: "びー", invoice_no: "T1234567890123", not_registered: false, memo: "" },
    ]);
  });
});
