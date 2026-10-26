import { describe, expect, test } from "bun:test";
import type { Account, JournalLine, TaxYear } from "./types";
import {
  defaultBusinessClass, effectiveBusinessClass, parseBusinessClass,
  builtinTaxCode, defaultTaxCode, invoiceCsvLabel, parseInvoiceKind, parseTaxCode, resolveLineTax, statusProblem, taxActiveOn,
  taxLongLabel, taxShortLabel, taxYearOf, transitionalRate, validateTaxYear,
} from "./tax";

const acc = (id: number, code: string, category: Account["category"], default_tax_code: Account["default_tax_code"] = null, default_business_class: number | null = null): Account => ({
  id, code, name: code, kana: "", category, normal_side: category === "revenue" ? "credit" : "debit", sort_order: 0, is_active: 1, is_system: 1, default_tax_code, default_business_class,
});
const ty = (from_year: number, status: TaxYear["status"], taxable_from = ""): TaxYear => ({ from_year, status, method: "inclusive", business_class: 5, taxable_from });

describe("年度ごとの設定", () => {
  test("設定の無い年は免税。設定は次の設定がある年まで引き継ぎ、課税事業者になった日はその年だけ", () => {
    const rows = [ty(2025, "twenty", "2025-10-01"), ty(2027, "standard")];
    expect(taxYearOf(rows, 2024).status).toBe("exempt");
    expect(taxYearOf(rows, 2025)).toMatchObject({ status: "twenty", taxable_from: "2025-10-01", inherited: false });
    expect(taxYearOf(rows, 2026)).toMatchObject({ status: "twenty", taxable_from: "", inherited: true, from_year: 2026 });
    expect(taxYearOf(rows, 2028)).toMatchObject({ status: "standard", inherited: true });
  });

  test("課税事業者の期間だけ税区分を付ける（年の途中から課税事業者になった日より前は付けない）", () => {
    const rows = [ty(2026, "twenty", "2026-10-01")];
    expect(taxActiveOn(rows, "2025-12-31")).toBe(false);
    expect(taxActiveOn(rows, "2026-09-30")).toBe(false);
    expect(taxActiveOn(rows, "2026-10-01")).toBe(true);
    expect(taxActiveOn(rows, "2027-01-01")).toBe(true);
    expect(taxActiveOn([ty(2026, "exempt")], "2026-05-01")).toBe(false);
  });

  test("2割特例は令和8年分まで、3割特例は令和9年分・令和10年分だけ", () => {
    expect(statusProblem("twenty", 2026)).toBeNull();
    expect(statusProblem("twenty", 2027)).toMatch(/令和8年/);
    expect(statusProblem("thirty", 2026)).toMatch(/3割特例/);
    expect(statusProblem("thirty", 2028)).toBeNull();
    expect(statusProblem("thirty", 2029)).toMatch(/3割特例/);
  });

  test("設定の確認：税抜経理はまだ選べない。課税事業者になった日はその年の日付だけ", () => {
    expect(validateTaxYear(ty(2026, "standard"))).toBeNull();
    expect(validateTaxYear({ ...ty(2026, "standard"), method: "exclusive" })).toMatch(/経理方式/);
    expect(validateTaxYear(ty(2026, "standard", "2025-10-01"))).toMatch(/2026年の日付/);
    expect(validateTaxYear(ty(2026, "exempt", "2026-10-01"))).toMatch(/免税事業者/);
    expect(validateTaxYear({ ...ty(2026, "simplified"), business_class: 7 })).toMatch(/事業区分/);
  });
});

describe("税区分の初期値", () => {
  test("初期科目は決まった初期値、追加した科目は区分から。科目ごとに変えていればそれ", () => {
    expect(builtinTaxCode(acc(1, "401", "revenue"))).toBe("sales10");
    expect(builtinTaxCode(acc(1, "608", "expense"))).toBe("purchase_nontax");
    expect(builtinTaxCode(acc(1, "613", "expense"))).toBe("none");
    expect(builtinTaxCode(acc(1, "650", "expense"))).toBe("purchase10"); // 追加した経費
    expect(builtinTaxCode(acc(1, "450", "revenue"))).toBe("sales10");
    expect(builtinTaxCode(acc(1, "150", "asset"))).toBe("none");
    expect(defaultTaxCode(acc(1, "616", "expense", "purchase_nontax"), "debit")).toBe("purchase_nontax");
  });

  test("資産の科目の初期値は借方（取得）だけ。貸方（売却・償却）は対象外", () => {
    const fixtures = acc(1, "134", "asset");
    expect(defaultTaxCode(fixtures, "debit")).toBe("purchase10");
    expect(defaultTaxCode(fixtures, "credit")).toBe("none");
  });

  test("保存する明細：課税事業者の期間なら空のところを埋め、免税事業者の期間なら外す", () => {
    const accounts = new Map([[1, acc(1, "610", "expense")], [2, acc(2, "101", "asset")], [3, acc(3, "401", "revenue")]]);
    const lines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 1100, memo: "" },
      { row_no: 1, side: "credit", account_id: 2, sub_account_id: null, amount: 1100, memo: "", invoice_kind: "qualified" },
    ];
    const cp = { id: 9, name: "A", kana: "", invoice_no: "", not_registered: 1, memo: "", is_active: 1 };
    const out = resolveLineTax(lines, true, (id) => accounts.get(id), cp);
    expect(out.map((l) => [l.tax_code, l.invoice_kind])).toEqual([["purchase10", "transitional"], ["none", null]]);
    // 入れた税区分・インボイス区分はそのまま
    const kept = resolveLineTax([{ ...lines[0], tax_code: "purchase8", invoice_kind: "none" }], true, (id) => accounts.get(id), cp);
    expect([kept[0].tax_code, kept[0].invoice_kind]).toEqual(["purchase8", "none"]);
    // 取引先が無ければ適格
    expect(resolveLineTax([lines[0]], true, (id) => accounts.get(id), null)[0].invoice_kind).toBe("qualified");
    // 課税仕入でなければインボイス区分を外す
    expect(resolveLineTax([{ ...lines[0], tax_code: "purchase_nontax", invoice_kind: "qualified" }], true, (id) => accounts.get(id), null)[0].invoice_kind).toBeNull();
    expect(resolveLineTax([{ ...lines[0], tax_code: "purchase10" }], false, () => undefined, null)[0]).toMatchObject({ tax_code: null, invoice_kind: null });
  });
});

describe("経過措置", () => {
  test("控除できる割合は課税仕入の日で決まる（令和8年10月から70%）", () => {
    expect(transitionalRate("2023-09-30")).toBe(100);
    expect(transitionalRate("2023-10-01")).toBe(80);
    expect(transitionalRate("2026-09-30")).toBe(80);
    expect(transitionalRate("2026-10-01")).toBe(70);
    expect(transitionalRate("2028-10-01")).toBe(50);
    expect(transitionalRate("2030-10-01")).toBe(30);
    expect(transitionalRate("2031-10-01")).toBe(0);
  });

  test("表示：経過措置は割合つき", () => {
    expect(taxShortLabel("purchase10", "qualified", "2026-05-01")).toBe("課仕10%");
    expect(taxShortLabel("purchase10", "transitional", "2026-05-01")).toBe("課仕10% 経過80%");
    expect(taxShortLabel("purchase8", "transitional", "2026-11-01")).toBe("課仕8%軽 経過70%");
    expect(taxLongLabel("purchase10", "transitional", "2026-05-01")).toBe("課税仕入 10%（80%控除対象）");
    expect(taxLongLabel("purchase10", "none", "2026-05-01")).toBe("課税仕入 10%（控除しない）");
    expect(taxShortLabel(null, null, "2026-05-01")).toBe("");
  });
});

describe("CSV の税区分", () => {
  test("名前・短い名前・コードで読める（全角半角・空白の違いは無視）。空は初期値、読めなければ undefined", () => {
    expect(parseTaxCode("課税仕入 10%")).toBe("purchase10");
    expect(parseTaxCode("課税売上８％（軽減）")).toBe("sales8");
    expect(parseTaxCode("課仕10%")).toBe("purchase10");
    expect(parseTaxCode("none")).toBe("none");
    expect(parseTaxCode("")).toBeNull();
    expect(parseTaxCode("消費税")).toBeUndefined();
    expect(parseInvoiceKind("経過措置")).toBe("transitional");
    expect(parseInvoiceKind("")).toBeNull();
    expect(parseInvoiceKind("あり")).toBeUndefined();
    expect(invoiceCsvLabel("purchase10", "qualified")).toBe("適格");
    expect(invoiceCsvLabel("sales10", "qualified")).toBe("");
  });
});

describe("簡易課税の事業区分", () => {
  test("課税売上の明細だけ持つ。入っていなければ科目の初期値、資産の科目（固定資産の売却）は第4種", () => {
    const accounts = new Map([[1, acc(1, "401", "revenue")], [2, acc(2, "450", "revenue", null, 2)], [3, acc(3, "134", "asset")], [4, acc(4, "610", "expense")]]);
    const line = (account_id: number, side: "debit" | "credit", extra: Partial<JournalLine> = {}): JournalLine =>
      ({ row_no: 1, side, account_id, sub_account_id: null, amount: 1100, memo: "", ...extra });
    const out = resolveLineTax([
      line(1, "credit"), line(1, "credit", { business_class: 3 }), line(2, "credit"),
      line(3, "credit", { tax_code: "sales10" }), line(4, "debit", { business_class: 3 }),
    ], true, (id) => accounts.get(id), null);
    expect(out.map((l) => l.business_class)).toEqual([null, 3, 2, 4, null]);
    expect(resolveLineTax([line(1, "credit", { business_class: 3 })], false, () => undefined, null)[0].business_class).toBeNull();
    expect(defaultBusinessClass(acc(9, "401", "revenue"))).toBeNull();
    expect(effectiveBusinessClass({ business_class: null }, acc(9, "401", "revenue"), 5)).toBe(5);
    expect(effectiveBusinessClass({ business_class: 1 }, acc(9, "450", "revenue", null, 2), 5)).toBe(1);
  });

  test("表示と CSV の読み方", () => {
    expect(taxShortLabel("sales10", null, "2026-05-01", 5)).toBe("課売10% 5種");
    expect(taxLongLabel("sales8", null, "2026-05-01", 2)).toBe("課税売上 8%（軽減）（第二種）");
    expect(taxShortLabel("purchase10", "qualified", "2026-05-01", 5)).toBe("課仕10%");
    expect(["5", "5種", "第5種", "第五種", "第５種事業", ""].map(parseBusinessClass)).toEqual([5, 5, 5, 5, 5, null]);
    expect(parseBusinessClass("7")).toBeUndefined();
    expect(parseBusinessClass("サービス")).toBeUndefined();
  });
});
