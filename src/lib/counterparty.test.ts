import { describe, expect, test } from "bun:test";
import type { Counterparty } from "./types";
import { findCounterparty, isValidCorporateNo, normalizeCorporateNo, normalizeInvoiceNo, validateCounterparty } from "./counterparty";

const list: Counterparty[] = [
  { id: 1, name: "株式会社ABC", kana: "えーびーしー", invoice_no: "T1234567890123", corporate_no: "", not_registered: 0, memo: "", is_active: 1 },
];
const d = { name: "山田文具", kana: "", invoice_no: "", memo: "" };

describe("取引先", () => {
  test("登録番号は T + 13桁。全角やハイフンはそろえる", () => {
    expect(normalizeInvoiceNo("ｔ１２３４-５６７８-９０１２-３")).toBe("T1234567890123");
    expect(validateCounterparty(list, { ...d, invoice_no: "T123" })).toMatch(/13桁/);
    expect(validateCounterparty(list, { ...d, invoice_no: "1234567890123" })).toMatch(/13桁/);
    expect(validateCounterparty(list, { ...d, invoice_no: "T9999999999999" })).toBeNull();
    expect(validateCounterparty(list, d)).toBeNull(); // 登録番号は任意
  });
  test("法人番号は13桁で、先頭の検査用数字が合うこと。全角やハイフンはそろえる。任意", () => {
    expect(isValidCorporateNo("7000012050002")).toBe(true); // 国税庁
    expect(isValidCorporateNo("1180301018771")).toBe(true);
    expect(isValidCorporateNo("8000012050002")).toBe(false); // 検査用数字が違う
    expect(normalizeCorporateNo("７０００-０１２０-５０００２")).toBe("7000012050002");
    expect(validateCounterparty(list, { ...d, corporate_no: "７０００-０１２０-５０００２" })).toBeNull();
    expect(validateCounterparty(list, { ...d, corporate_no: "700001205000" })).toMatch(/13桁/);
    expect(validateCounterparty(list, { ...d, corporate_no: "8000012050002" })).toMatch(/検査用数字/);
    expect(validateCounterparty(list, { ...d, corporate_no: "" })).toBeNull();
  });
  test("名前・登録番号の重複は不可（表記ゆれも同じとみなす）", () => {
    expect(validateCounterparty(list, { ...d, name: "株式会社ＡＢＣ" })).toMatch(/同じ名前/);
    expect(validateCounterparty(list, { ...d, invoice_no: "T1234567890123" })).toMatch(/同じ登録番号/);
    expect(validateCounterparty(list, { ...d, name: "株式会社ABC" }, 1)).toBeNull(); // 自分自身はよい
  });
  test("名前から探す", () => {
    expect(findCounterparty(list, " 株式会社ａｂｃ ")?.id).toBe(1);
    expect(findCounterparty(list, "ABC")).toBeNull();
    expect(findCounterparty(list, "")).toBeNull();
  });
});
