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
    const cps: Counterparty[] = [{ id: 1, name: "株式会社A", kana: "", invoice_no: "", corporate_no: "", not_registered: 0, memo: "", is_active: 1 }];
    const cpText = toCsv(COUNTERPARTY_LIST_HEADER, [...counterpartyListRows(cps), ["個人の外注", "", "", "", "○", "メモ"], ["株式会社B", "びー", "T1234567890123", "", "", ""], ["国税庁", "", "", "7000012050002", "", ""]]);
    const c = parseCounterpartyCsv(cpText, cps);
    expect(c.skipped).toBe(1);
    expect(c.rows).toEqual([
      { name: "個人の外注", kana: "", invoice_no: "", corporate_no: "", not_registered: true, memo: "メモ" },
      { name: "株式会社B", kana: "びー", invoice_no: "T1234567890123", corporate_no: "", not_registered: false, memo: "" },
      { name: "国税庁", kana: "", invoice_no: "", corporate_no: "7000012050002", not_registered: false, memo: "" },
    ]);
  });
});

describe("一覧の CSV：ある名前は書き換える（空欄は今のまま）", () => {
  test("取引先：よみ・登録番号・法人番号・印・メモの前 → 後。変わらなければ飛ばす。おかしな番号は問題", () => {
    const cps: Counterparty[] = [
      { id: 1, name: "株式会社A", kana: "", invoice_no: "", corporate_no: "", not_registered: 1, memo: "古い", is_active: 1 },
      { id: 2, name: "B商店", kana: "びー", invoice_no: "", corporate_no: "", not_registered: 0, memo: "", is_active: 1 },
    ];
    const text = toCsv(COUNTERPARTY_LIST_HEADER, [
      ["株式会社Ａ", "えー", "T1234567890123", "", "", ""], // 全角の名前も同じ。登録番号を入れると印は外れる。メモは空欄なので今のまま
      ["B商店", "", "", "", "", ""], // 変わらない
      ["C社", "", "", "8000012050002", "", ""], // 検査用数字が合わない
    ]);
    const r = parseCounterpartyCsv(text, cps);
    expect(r.skipped).toBe(1);
    expect(r.rows).toEqual([]);
    expect(r.issues.map((x) => x.message)).toEqual([expect.stringMatching(/C社.*検査用数字/)]);
    expect(r.updates).toEqual([{
      row: 2, name: "株式会社A", id: 1,
      changes: [
        { label: "よみ", before: "", after: "えー" }, { label: "登録番号", before: "", after: "T1234567890123" },
        { label: "適格請求書発行事業者ではない", before: "○", after: "" },
      ],
      data: { name: "株式会社A", kana: "えー", invoice_no: "T1234567890123", corporate_no: "", not_registered: false, memo: "古い" },
    }]);
  });
  test("科目：よみ・税区分の初期値・決算書の欄（自動・欄の名前）。読めない税区分・選べない欄・締めた年の欄は問題", () => {
    const text = toCsv(ACCOUNT_LIST_HEADER, [
      ["", "消耗品費", "", "経費", "課税仕入 8%（軽減）", "雑費"],
      ["", "通信費", "", "経費", "課税仕入 10%", "自動"], // 今のまま
      ["", "旅費交通費", "", "経費", "謎の税", ""],
      ["", "売上高", "", "収益", "", "雑費"], // 売上の科目は欄を選べない
      ["", "新しい経費", "あたらしい", "経費", "対象外", "追加の欄"],
    ]);
    const r = parseAccountListCsv(text, accounts);
    expect(r.updates).toEqual([{
      row: 2, name: "消耗品費", id: id("消耗品費"),
      changes: [{ label: "税区分の初期値", before: "課税仕入 10%", after: "課税仕入 8%（軽減）" }, { label: "決算書の欄", before: "自動", after: "雑費" }],
      data: { taxCode: "purchase8", statementLine: "雑費" },
    }]);
    expect(r.skipped).toBe(1);
    expect(r.rows).toEqual([{ code: null, name: "新しい経費", kana: "あたらしい", category: "expense", taxCode: "none", statementLine: "extra" }]);
    expect(r.issues.map((x) => x.row)).toEqual([4, 5]);
    // 締めた年は決算書の欄を変えられない
    expect(parseAccountListCsv(text, accounts, true).issues.map((x) => x.message)).toContain("「消耗品費」：表示中の年を締めているので、決算書の欄は変えられません");
    // 書き出したものをそのまま読むと、何も変わらない
    expect(parseAccountListCsv(toCsv(ACCOUNT_LIST_HEADER, accountListRows(accounts)), accounts)).toMatchObject({ rows: [], updates: [], issues: [] });
  });
  test("補助科目：よみを書き換える", () => {
    const r = parseSubListCsv(toCsv(SUB_LIST_HEADER, [["普通預金", "みずほ銀行", "みずほ"]]), accounts, subs);
    expect(r.updates).toEqual([{ row: 2, name: "普通預金／みずほ銀行", id: 1, changes: [{ label: "よみ", before: "", after: "みずほ" }], data: { kana: "みずほ" } }]);
  });
});
