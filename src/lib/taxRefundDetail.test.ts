import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { FlatLine } from "./accounting";
import type { Account, Counterparty, TaxCode } from "./types";
import { purchaseFigures, refundCandidates, refundDetailFromBooks, refundDetailProblems, withoutTax, type RefundBooks } from "./taxRefundDetail";

const accounts: Account[] = ACCOUNT_SEEDS.map((a, i) => ({
  id: i + 1, code: a.code, name: a.name, kana: a.kana, category: a.category, normal_side: a.normal_side, sort_order: i, is_active: 1, is_system: 1,
  default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null, income_kind: a.income_kind ?? "business",
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const counterparties: Counterparty[] = [
  { id: 1, name: "株式会社A", kana: "", invoice_no: "T1234567890123", not_registered: 0, memo: "", is_active: 1 },
  { id: 2, name: "Overseas Inc.", kana: "", invoice_no: "", not_registered: 1, memo: "", is_active: 1 },
];
let n = 0;
const line = (date: string, account: string, side: "debit" | "credit", amount: number, tax: TaxCode, memo = "", cp: number | null = null): FlatLine => ({
  entry_id: ++n, date, description: "", row_no: 1, side, account_id: id(account), sub_account_id: null, amount, memo, tax_code: tax, counterparty_id: cp,
});
const books = (lines: FlatLine[]): RefundBooks => ({ lines, accounts, counterparties, from: "2026-01-01", to: "2026-12-31" });

describe("還付申告に関する明細書：帳簿からの候補", () => {
  const lines = [
    // 課税売上：A社へ続けて（税抜 100万円以上の合計 → 継続）、ほかに1件 220万円、1件 99万円（税抜 90万円で出さない）
    line("2026-03-10", "売上高", "credit", 660_000, "sales10", "部品", 1),
    line("2026-04-10", "売上高", "credit", 660_000, "sales10", "部品", 1),
    line("2026-05-20", "売上高", "credit", 2_200_000, "sales10", "建設機械"),
    line("2026-06-01", "売上高", "credit", 990_000, "sales10", "小物"),
    // 輸出免税
    line("2026-07-01", "売上高", "credit", 3_000_000, "export", "機械用部品", 2),
    line("2026-08-01", "売上高", "credit", 1_000_000, "export", "機械用部品", 2),
    // 仕入：A社から続けて、外注
    line("2026-02-01", "仕入高", "debit", 1_650_000, "purchase10", "原材料", 1),
    line("2026-09-01", "仕入高", "debit", 1_650_000, "purchase10", "原材料", 1),
    line("2026-10-01", "外注工賃", "debit", 1_100_000, "purchase10", "加工委託"),
    // 経費：給料（対象外）・家賃（課税）・家事分の振替（課税仕入の返還）
    line("2026-12-25", "給料賃金", "debit", 3_000_000, "none"),
    line("2026-12-31", "地代家賃", "debit", 1_200_000, "purchase10"),
    line("2026-12-31", "地代家賃", "credit", 200_000, "purchase10"),
    // 固定資産：車両（課税）と土地（非課税）
    line("2026-11-15", "車両運搬具", "debit", 4_400_000, "purchase10", "営業車", 1),
    line("2026-11-20", "土地", "debit", 5_000_000, "purchase_nontax"),
    // 削除済み・課税期間の外は数えない
    { ...line("2026-05-01", "売上高", "credit", 9_900_000, "sales10"), is_deleted: 1 },
    line("2025-12-31", "売上高", "credit", 9_900_000, "sales10"),
  ];

  test("2(1) 税抜 100万円以上を上位5件。続けて売っている取引先は合計して「継続」", () => {
    const c = refundCandidates(books(lines));
    expect(c.sales).toEqual([
      { kind: "売上高", date: "", continuous: true, amount: 1_320_000, regNo: "", name: "株式会社A", address: "" },
      { kind: "建設機械", date: "2026-05-20", continuous: false, amount: 2_200_000, regNo: "", name: "", address: "" },
    ].sort((a, b) => b.amount - a.amount));
    expect(withoutTax(990_000, "sales10")).toBe(900_000);
  });

  test("2(2) 輸出免税を取引先ごとに合計。3(2) 固定資産を除く課税仕入、3(3) 固定資産（1件ごと・登録番号つき）", () => {
    const c = refundCandidates(books(lines));
    expect(c.exports).toEqual([{ name: "Overseas Inc.", address: "", amount: 4_000_000, goods: "機械用部品", customs: "" }]);
    expect(c.inventory.map((r) => [r.kind, r.continuous, r.amount, r.regNo, r.name])).toEqual([
      ["仕入高", true, 3_300_000, "1234567890123", "株式会社A"],
      ["地代家賃", false, 1_200_000, "", ""],
      ["加工委託", false, 1_100_000, "", ""],
    ]);
    expect(c.assets.map((r) => [r.kind, r.date, r.amount, r.regNo])).toEqual([["営業車", "2026-11-15", 4_400_000, "1234567890123"]]);
    expect(c.reasons).toEqual({ export: true, capex: true, other: false, otherText: "" });
  });

  test("3(1) 仕入金額等の明細：決算額・課税仕入れにならないもの・課税仕入高", () => {
    const p = purchaseFigures(books(lines));
    expect(p.business.purchase).toEqual({ total: 3_300_000, notTaxable: 0, taxable: 3_300_000 });
    // 経費：外注 110万・給料 300万・家賃 120万−家事分 20万
    expect(p.business.expense).toEqual({ total: 5_100_000, notTaxable: 3_000_000, taxable: 2_100_000 });
    expect(p.business.asset).toEqual({ total: 9_400_000, notTaxable: 5_000_000, taxable: 4_400_000 });
    expect(p.business.subtotal).toEqual({ total: 17_800_000, notTaxable: 8_000_000, taxable: 9_800_000 });
    expect(p.realEstate.subtotal).toEqual({ total: 0, notTaxable: 0, taxable: 0 });
    expect([p.taxableTotal, p.outside]).toEqual([9_800_000, 0]);
  });

  test("候補から作った明細書の確かめ：理由・年月日・登録番号・文字数", () => {
    const x = refundDetailFromBooks(books(lines));
    expect(refundDetailProblems(x)).toEqual([]);
    expect(refundDetailProblems({ ...x, reasons: { export: false, capex: false, other: false, otherText: "" } })).toEqual(["還付申告となった主な理由を選んでください"]);
    expect(refundDetailProblems({ ...x, reasons: { ...x.reasons, other: true } })).toEqual(["還付申告となった理由（その他）の内容を入れてください"]);
    const bad = { ...x, assets: [{ ...x.assets[0], date: "", regNo: "T123", kind: "とても長い資産の種類の名前" }] };
    expect(refundDetailProblems(bad)).toEqual([
      "主な固定資産等の取得の1行目の資産の種類等は10文字までです",
      "主な固定資産等の取得の1行目の年月日を入れてください（続けて取引しているものは「継続」）",
      "主な固定資産等の取得の1行目の登録番号は、T を除いた13桁の数字で入れてください",
    ]);
  });
});
