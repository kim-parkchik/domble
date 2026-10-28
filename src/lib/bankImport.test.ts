/**
 * 銀行・カードの明細の取り込み
 */
import { describe, expect, test } from "bun:test";
import type { FlatLine } from "./accounting";
import {
  findBookDuplicate, guessColumns, guessLine, learnFromBooks, parseStatement, parseStatementAmount, parseStatementDate, type BankRule,
} from "./bankImport";
import { parseCsv } from "./csv";

const BANK = [
  "口座番号,1234567",
  "",
  '"お取引日","お取引内容","お預入金額","お引出金額","残高"',
  '"2026/10/01","ﾌﾘｺﾐ ｶ)ｴｰｼﾔ","330,000","","1,330,000"',
  '"2026/10/05","デンキ トウキヨウデンリヨク","","5,500","1,324,500"',
  '"2026/10/05","デンキ トウキヨウデンリヨク","","5,500","1,319,000"',
].join("\r\n");
const CARD = ["ご利用日,ご利用店名,ご利用金額", "2026/10/03,AMAZON.CO.JP,3300", "2026/10/04,ｶﾞｿﾘﾝｽﾀﾝﾄﾞ,-500", "合計,,2800"].join("\n");
const bankAccount = { id: 3, normal_side: "debit" as const };
const cardAccount = { id: 40, normal_side: "credit" as const };

describe("列の推測と読み取り", () => {
  test("見出しの行を探し、入金・出金・残高の列を推測する", () => {
    expect(guessColumns(parseCsv(BANK))).toEqual({
      headerRow: 2, date: 0, description: [1], mode: "split", increase: 2, decrease: 3, amount: null, invert: false, balance: 4,
    });
    expect(guessColumns(parseCsv(CARD))).toMatchObject({ headerRow: 0, date: 0, description: [1], mode: "signed", amount: 2, balance: null });
    expect(guessColumns(parseCsv("a,b\n1,2"))).toBeNull();
  });
  test("銀行：入金は借方（普通預金が増える）、出金は貸方。同じ日・同じ金額・同じ摘要の2件目は別の指紋", () => {
    const p = parseStatement(BANK, guessColumns(parseCsv(BANK))!, bankAccount);
    expect(p.problems).toEqual([]);
    expect(p.lines.map((l) => [l.row, l.date, l.side, l.amount, l.balance])).toEqual([
      [4, "2026-10-01", "debit", 330_000, 1_330_000], [5, "2026-10-05", "credit", 5_500, 1_324_500], [6, "2026-10-05", "credit", 5_500, 1_319_000],
    ]);
    expect(p.lines[1].fingerprint).not.toBe(p.lines[2].fingerprint);
    // もう一度読んでも同じ指紋
    expect(parseStatement(BANK, guessColumns(parseCsv(BANK))!, bankAccount).lines.map((l) => l.fingerprint)).toEqual(p.lines.map((l) => l.fingerprint));
  });
  test("カード（未払金）：ご利用は貸方（未払金が増える）、マイナスの返金は借方。合計の行は飛ばす", () => {
    const p = parseStatement(CARD, guessColumns(parseCsv(CARD))!, cardAccount);
    expect(p.lines.map((l) => [l.date, l.side, l.amount, l.description])).toEqual([
      ["2026-10-03", "credit", 3_300, "AMAZON.CO.JP"], ["2026-10-04", "debit", 500, "ｶﾞｿﾘﾝｽﾀﾝﾄﾞ"],
    ]);
    expect(p.skipped).toBe(1);
  });
  test("読めない日付・金額は行番号つきで返す", () => {
    const p = parseStatement("日付,摘要,金額\n2026/13/01,x,100\n2026/10/01,y,abc", { headerRow: 0, date: 0, description: [1], mode: "signed", increase: null, decrease: null, amount: 2, invert: false, balance: null }, bankAccount);
    expect(p.problems).toEqual([{ row: 2, message: "日付を読めません：2026/13/01" }, { row: 3, message: "金額を読めません：abc" }]);
  });
  test("日付・金額の書き方", () => {
    expect(parseStatementDate("2026-1-5")).toBe("2026-01-05");
    expect(parseStatementDate("2026年1月5日")).toBe("2026-01-05");
    expect(parseStatementDate("20260105")).toBe("2026-01-05");
    expect(parseStatementDate("R8.1.5")).toBe("2026-01-05");
    expect(parseStatementDate("26/01/05")).toBe("2026-01-05");
    expect(parseStatementDate("2026/01/05 12:34")).toBe("2026-01-05");
    expect(parseStatementDate("1/5", 2026)).toBe("2026-01-05");
    expect(parseStatementDate("1/5")).toBeNull();
    expect(parseStatementAmount("¥3,300")).toBe(3300);
    expect(parseStatementAmount("3,300円")).toBe(3300);
    expect(parseStatementAmount("▲500")).toBe(-500);
    expect(parseStatementAmount("(500)")).toBe(-500);
    expect(parseStatementAmount("")).toBeNull();
    expect(Number.isNaN(parseStatementAmount("x"))).toBe(true);
  });
});

describe("推測", () => {
  const rule = (x: Partial<BankRule>): BankRule => ({
    id: 1, keyword: "デンキ", direction: "decrease", target_account_id: null, account_id: 603, sub_account_id: null,
    tax_code: "purchase10", invoice_kind: "qualified", counterparty_id: 7, memo: "電気代", sort_order: 0, ...x,
  });
  const line = (id: number, entry: number, date: string, side: FlatLine["side"], account: number, amount: number, memo: string, sub: number | null = null): FlatLine => ({
    entry_id: entry, date, description: "", row_no: id, side, account_id: account, sub_account_id: sub, amount, memo, tax_code: null, invoice_kind: null,
  });
  const books = [
    line(1, 10, "2026-09-01", "credit", 3, 4_400, "AMAZON", 5), line(1, 10, "2026-09-01", "debit", 610, 4_400, "AMAZON"),
    line(1, 11, "2026-09-02", "credit", 3, 2_000, "AMAZON", 5), line(1, 11, "2026-09-02", "debit", 622, 2_000, "AMAZON"),
  ];
  test("ルール（摘要に含む言葉・増減）が先", () => {
    const g = guessLine({ description: "デンキ トウキヨウ", side: "credit" }, bankAccount, [rule({})], new Map());
    expect(g).toMatchObject({ counterId: 603, taxCode: "purchase10", counterpartyId: 7, memo: "電気代", source: "rule", ruleId: 1 });
    expect(guessLine({ description: "デンキ", side: "debit" }, bankAccount, [rule({})], new Map()).source).toBeNull();
    expect(guessLine({ description: "デンキ", side: "credit" }, bankAccount, [rule({ target_account_id: 99 })], new Map()).source).toBeNull();
  });
  test("ルールが無ければ、同じ口座で前に同じ摘要だった仕訳（新しいもの）に合わせる", () => {
    const h = learnFromBooks(books, 3, 5);
    expect(guessLine({ description: "amazon", side: "credit" }, bankAccount, [], h)).toMatchObject({ counterId: 622, memo: "AMAZON", source: "history" });
    expect(learnFromBooks(books, 3, null).size).toBe(0);
    // 仕訳の摘要を書き換えていても、もとの明細の摘要で引ける
    const h2 = learnFromBooks(books, 3, 5, [{ entryId: 11, description: "ｱﾏｿﾞﾝ ﾏｰｹｯﾄ" }]);
    expect(guessLine({ description: "ｱﾏｿﾞﾝ ﾏｰｹｯﾄ", side: "credit" }, bankAccount, [], h2).counterId).toBe(622);
  });
  test("帳簿に同じ日・同じ増減・同じ金額の仕訳があれば重複かも", () => {
    expect(findBookDuplicate({ date: "2026-09-01", side: "credit", amount: 4_400 }, books, 3, 5)).toBe(10);
    expect(findBookDuplicate({ date: "2026-09-01", side: "debit", amount: 4_400 }, books, 3, 5)).toBeNull();
    expect(findBookDuplicate({ date: "2026-09-01", side: "credit", amount: 4_400 }, books, 3, 5, new Set([10]))).toBeNull();
  });
});
