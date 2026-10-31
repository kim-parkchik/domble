/**
 * 摘要からの自動入力：帳簿入力の相手の側、振替伝票の行、引き継ぐ税区分
 */
import { describe, expect, test } from "bun:test";
import { bookFill, usableSide, voucherFill, type MemoEntry, type MemoEntryLine, type SideFill } from "./memoFill";

const BANK = 103;
const RENT = 614;
const DRAW = 190;
const TRAVEL = 604;
const CASH = 101;
const line = (p: Partial<MemoEntryLine> & Pick<MemoEntryLine, "row_no" | "side" | "account_id">): MemoEntryLine => ({
  sub_account_id: null, memo: "", tax_code: null, invoice_kind: null, business_class: null, purchase_use: null, ...p,
});
const entry = (lines: MemoEntryLine[], counterparty_id: number | null = null): MemoEntry => ({ id: 1, date: "2026-10-01", counterparty_id, lines });

describe("帳簿入力", () => {
  test("この帳簿の科目の相手の側（家事按分の事業主貸の行は使わない）。インボイス区分は今の取引先に任せる", () => {
    const e = entry([
      line({ row_no: 1, side: "debit", account_id: RENT, memo: "家賃", tax_code: "purchase10", invoice_kind: "qualified" }),
      line({ row_no: 1, side: "credit", account_id: BANK, sub_account_id: 1, memo: "家賃" }),
      line({ row_no: 2, side: "debit", account_id: DRAW, memo: "家賃（家事分）" }),
    ], 7);
    expect(bookFill(e, BANK, " 家賃 ")).toEqual({ accountId: RENT, subId: null, tax: "purchase10", invoice: null, cls: null, use: null });
  });
  test("帳簿のみ保存の特例は引き継ぐ。この帳簿の科目が無い・口座の間の振替は入れない", () => {
    const train = entry([
      line({ row_no: 1, side: "debit", account_id: TRAVEL, memo: "電車代", tax_code: "purchase10", invoice_kind: "book_transport" }),
      line({ row_no: 1, side: "credit", account_id: CASH, memo: "電車代" }),
    ]);
    expect(bookFill(train, CASH, "電車代")?.invoice).toBe("book_transport");
    expect(bookFill(train, BANK, "電車代")).toBeNull();
    const transfer = entry([line({ row_no: 1, side: "debit", account_id: BANK, sub_account_id: 2, memo: "振替" }), line({ row_no: 1, side: "credit", account_id: BANK, sub_account_id: 1, memo: "振替" })]);
    expect(bookFill(transfer, BANK, "振替")).toBeNull();
  });
});

describe("振替伝票", () => {
  test("摘要が同じ行の借方・貸方", () => {
    const e = entry([
      line({ row_no: 1, side: "debit", account_id: RENT, memo: "家賃" }), line({ row_no: 1, side: "credit", account_id: BANK, sub_account_id: 1, memo: "家賃" }),
      line({ row_no: 2, side: "debit", account_id: DRAW, memo: "家事分" }), line({ row_no: 2, side: "credit", account_id: RENT, memo: "家事分" }),
    ]);
    expect(voucherFill(e, "家事分")).toMatchObject({ debit: { accountId: DRAW }, credit: { accountId: RENT } });
    expect(voucherFill(e, "家賃")).toMatchObject({ debit: { accountId: RENT, subId: null }, credit: { accountId: BANK, subId: 1 } });
    expect(voucherFill(e, "電気代")).toBeNull();
  });
});

test("今も使える科目だけ入れる（補助科目だけ使えなければ外す）", () => {
  const f: SideFill = { accountId: BANK, subId: 1, tax: null, invoice: null, cls: null, use: null };
  const accounts = [{ id: BANK, is_active: 1 }, { id: RENT, is_active: 0 }];
  expect(usableSide(f, accounts, [{ id: 1, account_id: BANK, is_active: 1 }])).toEqual(f);
  expect(usableSide(f, accounts, [{ id: 1, account_id: BANK, is_active: 0 }])).toEqual({ ...f, subId: null });
  expect(usableSide({ ...f, accountId: RENT, subId: null }, accounts, [])).toBeNull();
  expect(usableSide(null, accounts, [])).toBeNull();
});
