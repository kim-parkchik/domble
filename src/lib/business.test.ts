import { expect, test } from "bun:test";
import { displayName, fileLabel, normalizePostalCode, validateBusinessInfo } from "./business";

test("郵便番号をそろえる", () => {
  expect(normalizePostalCode("1234567")).toBe("123-4567");
  expect(normalizePostalCode("〒１２３－４５６７")).toBe("123-4567");
  expect(normalizePostalCode(" 123-4567 ")).toBe("123-4567");
  expect(normalizePostalCode("")).toBe("");
});

test("事業者の情報の確認", () => {
  const ok = { business_name: "", owner_name: "山田 太郎", postal_code: "123-4567", address: "東京都千代田区", invoice_no: "" };
  expect(validateBusinessInfo(ok)).toBeNull();
  // 屋号は任意。屋号も氏名も無いときだけ問題
  expect(validateBusinessInfo({ ...ok, owner_name: " " })).toMatch(/氏名/);
  expect(validateBusinessInfo({ ...ok, owner_name: "", business_name: "山田商店" })).toBeNull();
  expect(validateBusinessInfo({ ...ok, postal_code: "12345" })).toMatch(/郵便番号/);
  expect(validateBusinessInfo({ ...ok, invoice_no: "T123" })).toMatch(/登録番号/);
  expect(validateBusinessInfo({ ...ok, invoice_no: "ｔ１２３４－５６７８９－０１２３" })).toBeNull();
  expect(validateBusinessInfo({ ...ok, address: "あ".repeat(201) })).toMatch(/200文字/);
});

test("帳簿の表示名は屋号、無ければ氏名", () => {
  expect(displayName({ business_name: " 山田商店 ", owner_name: "山田 太郎" })).toBe("山田商店");
  expect(displayName({ business_name: "", owner_name: "山田 太郎" })).toBe("山田 太郎");
  expect(fileLabel({ business_name: "", owner_name: "" })).toBe("帳簿");
});
