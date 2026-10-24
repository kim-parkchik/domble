import { expect, test } from "bun:test";
import { normalizePostalCode, validateBusinessInfo } from "./business";

test("郵便番号をそろえる", () => {
  expect(normalizePostalCode("1234567")).toBe("123-4567");
  expect(normalizePostalCode("〒１２３－４５６７")).toBe("123-4567");
  expect(normalizePostalCode(" 123-4567 ")).toBe("123-4567");
  expect(normalizePostalCode("")).toBe("");
});

test("事業者の情報の確認", () => {
  const ok = { postal_code: "123-4567", address: "東京都千代田区", invoice_no: "" };
  expect(validateBusinessInfo(ok)).toBeNull();
  expect(validateBusinessInfo({ ...ok, postal_code: "12345" })).toMatch(/郵便番号/);
  expect(validateBusinessInfo({ ...ok, invoice_no: "T123" })).toMatch(/登録番号/);
  expect(validateBusinessInfo({ ...ok, invoice_no: "ｔ１２３４－５６７８９－０１２３" })).toBeNull();
  expect(validateBusinessInfo({ ...ok, address: "あ".repeat(201) })).toMatch(/200文字/);
});
