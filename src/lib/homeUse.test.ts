import { describe, expect, test } from "bun:test";
import { entryRateOf, splitByRate, splitLinesByHomeUse } from "./homeUse";
import type { Account, HomeUseRate, JournalLine } from "./types";

const DRAW = 9;
const acc = (id: number, category: Account["category"]) => ({ id, category }) as Account;
const accounts = [acc(1, "asset"), acc(2, "expense"), acc(3, "expense"), acc(4, "expense"), acc(5, "expense"), acc(DRAW, "asset")];
const rate = (account_id: number, r: number, method: HomeUseRate["method"] = "entry"): HomeUseRate => ({ account_id, from_year: 2026, rate: r, method, basis: "" });
const rateOf = entryRateOf([rate(2, 60), rate(3, 30, "yearend"), rate(4, 100), rate(5, 0), rate(1, 50)], accounts);
const line = (row_no: number, side: JournalLine["side"], account_id: number, amount: number, memo = ""): JournalLine => ({ row_no, side, account_id, sub_account_id: null, amount, memo });

describe("家事按分（仕訳の明細）", () => {
  test("入力のたびに分ける経費の科目だけが対象（年末一括・100%・経費でない科目は対象外）", () => {
    expect(rateOf(2)).toBe(60);
    expect(rateOf(3)).toBeNull();
    expect(rateOf(4)).toBeNull();
    expect(rateOf(5)).toBe(0);
    expect(rateOf(1)).toBeNull();
    expect(rateOf(99)).toBeNull();
  });

  test("借方の経費を事業分と事業主貸に分け、家事分は新しい行に足す（端数は事業分を切り捨て）", () => {
    const r = splitLinesByHomeUse([line(1, "debit", 2, 10001, "電気代"), line(1, "credit", 1, 10001, "電気代")], rateOf, DRAW);
    expect(splitByRate(10001, 60)).toEqual({ business: 6000, private: 4001 });
    expect(r.lines).toEqual([
      line(1, "debit", 2, 6000, "電気代"),
      line(1, "credit", 1, 10001, "電気代"),
      line(2, "debit", DRAW, 4001, "電気代（家事分）"),
    ]);
    expect(r.splits).toEqual([{ account_id: 2, rate: 60, amount: 10001, business: 6000, private: 4001 }]);
  });

  test("複合仕訳：対象の行ごとに分け、対象外の行はそのまま", () => {
    const r = splitLinesByHomeUse(
      [line(1, "debit", 2, 1000), line(2, "debit", 3, 500), line(3, "debit", 2, 2000, "通信"), line(1, "credit", 1, 3500)],
      rateOf, DRAW,
    );
    expect(r.lines.filter((l) => l.side === "debit").map((l) => [l.row_no, l.account_id, l.amount, l.memo])).toEqual([
      [1, 2, 600, ""], [2, 3, 500, ""], [3, 2, 1200, "通信"], [4, DRAW, 400, "家事分"], [5, DRAW, 800, "通信（家事分）"],
    ]);
    const sum = (side: string) => r.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);
    expect(sum("debit")).toBe(sum("credit"));
  });

  test("事業割合 0% は行ごと事業主貸。貸方の経費・分け済みの仕訳は分けない", () => {
    expect(splitLinesByHomeUse([line(1, "debit", 5, 800, "私用"), line(1, "credit", 1, 800)], rateOf, DRAW).lines[0]).toEqual({ ...line(1, "debit", DRAW, 800, "私用（家事分）"), tax_code: null, invoice_kind: null });
    const refund = [line(1, "debit", 1, 300), line(1, "credit", 2, 300)];
    expect(splitLinesByHomeUse(refund, rateOf, DRAW)).toEqual({ lines: refund, splits: [] });
    const done = [line(1, "debit", 2, 600), line(2, "debit", DRAW, 400), line(1, "credit", 1, 1000)];
    expect(splitLinesByHomeUse(done, rateOf, DRAW)).toEqual({ lines: done, splits: [] });
  });
});
