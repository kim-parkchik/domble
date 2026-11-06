/**
 * 見積書・請求書：明細の金額・税率ごとの消費税（1回だけ丸める）・源泉徴収・差引請求額・仕訳・入金・番号・状態・入金の候補
 */
import { describe, expect, test } from "bun:test";
import {
  docProblem, docState, docTotals, invoiceEntryLines, itemAmount, itemTaxOn, nextDocNo, paymentCandidates, paymentEntryLines, reducedItemNote, remainingOf,
  withholdingTax, type DocItem, type SalesDoc, issuerOf, salesDocCsvRow, salesDocItemCsvRows, SALES_DOC_CSV_HEADER,
} from "./salesDoc";

const item = (name: string, qty: number, price: number, tax: DocItem["tax"] = "10"): DocItem => ({ name, qty, unit: "式", price, tax });
const doc = (items: DocItem[], o: Partial<SalesDoc> = {}) => ({ items, price_mode: "exclusive" as const, withholding: 0, ...o });

describe("金額と消費税", () => {
  test("税抜の単価：税率ごとに合計してから消費税を1回だけ丸める（切り捨て）", () => {
    const t = docTotals(doc([item("デザイン料", 1, 100_000), item("資料代", 3, 1_234, "8"), item("修正費", 1, 5_555)]), "floor", false);
    expect(t.amounts).toEqual([100_000, 3_702, 5_555]);
    expect(t.groups.map((g) => [g.tax, g.base, g.tax_amount, g.total])).toEqual([["10", 105_555, 10_555, 116_110], ["8", 3_702, 296, 3_998]]);
    expect([t.subtotal, t.taxTotal, t.total, t.billed]).toEqual([109_257, 10_851, 120_108, 120_108]);
  });
  test("税込の単価：合計 × 税率 /（100＋税率）。税のない区分は分けて出す", () => {
    const t = docTotals(doc([item("a", 1, 11_000), item("b", 1, 1_080, "8"), item("立替交通費", 1, 1_200, "none")], { price_mode: "inclusive" }), "floor", false);
    expect(t.groups.map((g) => [g.tax, g.base, g.tax_amount, g.total])).toEqual([["10", 10_000, 1_000, 11_000], ["8", 1_000, 80, 1_080], ["none", 1_200, 0, 1_200]]);
    expect(t.total).toBe(13_280);
  });
  test("明細の金額の丸め方（数量に小数）", () => {
    expect(["floor", "round", "ceil"].map((r) => itemAmount({ qty: 1.5, price: 3_333 }, r as "floor"))).toEqual([4_999, 5_000, 5_000]);
    expect(itemAmount({ qty: 0.1 * 3, price: 10 }, "ceil")).toBe(3); // 0.30000000000000004 × 10 でも 3
  });
  test("免税事業者の年：消費税を出さず、金額をそのまま合計", () => {
    const t = docTotals(doc([item("a", 1, 50_000), item("b", 2, 1_000, "8")]), "floor", true);
    expect(t.groups.map((g) => [g.tax, g.base, g.tax_amount])).toEqual([["none", 52_000, 0]]);
    expect([t.taxTotal, t.total, t.exempt]).toEqual([0, 52_000, true]);
  });
});

describe("飲食料品の税率の引下げ（1%）", () => {
  test("3月と4月をまたぐ請求書：8%・1%・10% を税率ごとに合計して消費税を出す（国税庁 Q&A 問2-2 の例）", () => {
    const t = docTotals(doc([item("豚肉ほか", 1, 40_000, "8"), item("雑貨（3月）", 1, 20_000), item("魚ほか", 1, 20_000, "1"), item("雑貨（4月）", 1, 30_000)]), "floor", false);
    expect(t.groups.map((g) => [g.tax, g.base, g.tax_amount])).toEqual([["10", 50_000, 5_000], ["8", 40_000, 3_200], ["1", 20_000, 200]]);
    expect([t.taxTotal, t.total]).toEqual([8_400, 118_400]);
    const lines = invoiceEntryLines({ kind: "invoice", doc_no: "2027-0001", subject: "" }, t, { receivable: 111, revenue: 401, draw: 190 });
    expect(lines.filter((l) => l.side === "credit").map((l) => [l.tax_code, l.amount, l.tax_amount])).toEqual([["sales10", 55_000, 5_000], ["sales8", 43_200, 3_200], ["sales1", 20_200, 200]]);
  });
  test("税込の単価：合計 × 1/101", () => {
    const t = docTotals(doc([item("野菜", 3, 1_010, "1")], { price_mode: "inclusive" }), "floor", false);
    expect(t.groups.map((g) => [g.base, g.tax_amount, g.total])).toEqual([[3_000, 30, 3_030]]);
  });
  test("複製・見積書から請求書へ：軽減税率の明細を新しい取引日の税率に。取引日と合わない明細は知らせる（書き直さない）", () => {
    expect([itemTaxOn("8", "2027-04-01"), itemTaxOn("1", "2029-04-01"), itemTaxOn("10", "2027-04-01"), itemTaxOn("none", "2027-04-01")]).toEqual(["1", "8", "10", "none"]);
    const d = (tax: DocItem["tax"], issue: string, delivery: string | null = null) => ({ items: [item("a", 1, 100, tax)], issue_date: issue, delivery_date: delivery });
    expect(reducedItemNote(d("1", "2027-03-31"))).toMatch(/令和9年4月1日から/);
    expect(reducedItemNote(d("1", "2027-03-31", "2027-04-01"))).toBeNull();
    expect(reducedItemNote(d("8", "2027-04-15"))).toMatch(/1%（軽減）です/);
    expect(reducedItemNote(d("8", "2027-03-31"))).toBeNull();
    expect(reducedItemNote(d("10", "2027-04-15"))).toBeNull();
  });
});

describe("源泉徴収", () => {
  test("100万円までは 10.21%、超える部分は 20.42%（1円未満切り捨て）", () => {
    expect([withholdingTax(100_000), withholdingTax(33_333), withholdingTax(1_000_000), withholdingTax(1_500_000), withholdingTax(0)]).toEqual([10_210, 3_403, 102_100, 204_200, 0]);
  });
  test("消費税が区分されていれば税抜の額に、免税の年は税込の額に。差引請求額 ＝ 合計 − 源泉徴収税額", () => {
    const t = docTotals(doc([item("原稿料", 1, 100_000)], { withholding: 1 }), "floor", false);
    expect([t.total, t.withholdingBase, t.withholding, t.billed]).toEqual([110_000, 100_000, 10_210, 99_790]);
    const e = docTotals(doc([item("原稿料", 1, 110_000)], { withholding: 1 }), "floor", true);
    expect([e.withholdingBase, e.withholding, e.billed]).toEqual([110_000, 11_231, 98_769]);
  });
});

describe("仕訳", () => {
  const ids = { receivable: 111, revenue: 401, draw: 190 };
  test("売掛金（差引請求額）＋ 事業主貸（源泉徴収税額） ／ 売上（税率ごと。税区分と消費税額つき）", () => {
    const d = { kind: "invoice" as const, doc_no: "2026-0001", subject: "ロゴ制作" };
    const t = docTotals(doc([item("デザイン料", 1, 100_000), item("資料代", 1, 1_000, "8")], { withholding: 1 }), "floor", false);
    const lines = invoiceEntryLines(d, t, ids);
    expect(lines.map((l) => [l.row_no, l.side, l.account_id, l.amount, l.tax_code ?? null, l.tax_amount ?? null])).toEqual([
      [1, "debit", 111, 100_768, null, null], [1, "credit", 401, 110_000, "sales10", 10_000],
      [2, "debit", 190, 10_312, null, null], [2, "credit", 401, 1_080, "sales8", 80],
    ]);
    expect(lines[0].memo).toBe("請求書 2026-0001 ロゴ制作");
    const sum = (s: string) => lines.filter((l) => l.side === s).reduce((x, l) => x + l.amount, 0);
    expect(sum("debit")).toBe(sum("credit"));
  });
  test("免税の年は税区分を付けない。入金：預金 ＋ 振込手数料 ／ 売掛金", () => {
    const t = docTotals(doc([item("a", 1, 30_000)]), "floor", true);
    expect(invoiceEntryLines({ kind: "invoice", doc_no: "1", subject: "" }, t, ids).map((l) => l.tax_code ?? null)).toEqual([null, null]);
    expect(paymentEntryLines({ amount: 99_130, fee: 660, memo: "入金" }, { bank: 103, receivable: 111, fee: 620 }).map((l) => [l.row_no, l.side, l.account_id, l.amount]))
      .toEqual([[1, "debit", 103, 99_130], [1, "credit", 111, 99_790], [2, "debit", 620, 660]]);
  });
});

describe("番号・状態・確かめ", () => {
  test("年ごとの連番（直した番号は数えない）", () => {
    expect(nextDocNo(["2026-0001", "2026-0009", "A-1", "2025-0100"], 2026)).toBe("2026-0010");
    expect(nextDocNo([], 2027)).toBe("2027-0001");
  });
  test("状態：下書き・発行済み・一部入金・入金済み・取消、見積書は請求書にした", () => {
    expect(docState({ kind: "invoice", status: "issued" }, remainingOf(1000, []), 1000)).toBe("issued");
    expect(docState({ kind: "invoice", status: "issued" }, remainingOf(1000, [{ amount: 400 }]), 1000)).toBe("partial");
    expect(docState({ kind: "invoice", status: "issued" }, remainingOf(1000, [{ amount: 400 }, { amount: 600 }]), 1000)).toBe("paid");
    expect(docState({ kind: "invoice", status: "void" }, 0, 1000)).toBe("void");
    expect(docState({ kind: "estimate", status: "issued" }, 1000, 1000, true)).toBe("converted");
    expect(docState({ kind: "estimate", status: "draft" }, 1000, 1000)).toBe("draft");
  });
  test("確かめ：宛名・明細・数量（小数第2位まで）・単価", () => {
    const base = {
      kind: "invoice" as const, doc_no: "2026-0001", issue_date: "2026-05-31", delivery_date: null, due_date: "2026-06-30", counterparty_id: null,
      to_name: "株式会社エー", honorific: "御中", to_address: "", subject: "", items: [item("a", 1, 100)], price_mode: "exclusive" as const, withholding: 0, notes: "",
      bank_text: "", revenue_account_id: null,
    };
    expect(docProblem(base)).toBeNull();
    expect(docProblem({ ...base, to_name: " " })).toMatch(/宛名/);
    expect(docProblem({ ...base, items: [] })).toMatch(/明細/);
    expect(docProblem({ ...base, items: [item("a", 1.234, 100)] })).toMatch(/数量/);
    expect(docProblem({ ...base, items: [item("a", 1, 10.5)] })).toMatch(/単価/);
    expect(docProblem({ ...base, issue_date: "" })).toMatch(/請求日/);
  });
});

describe("明細の取り込みの入金の候補", () => {
  const open = [
    { id: 1, doc_no: "2026-0001", to_name: "株式会社ヤマダ", names: ["株式会社ヤマダ", "やまだ"], remaining: 99_790, due_date: "2026-06-30" },
    { id: 2, doc_no: "2026-0002", to_name: "山本商店", names: ["山本商店"], remaining: 100_000, due_date: "2026-06-15" },
    { id: 3, doc_no: "2026-0003", to_name: "株式会社シー", names: ["株式会社シー"], remaining: 50_000, due_date: null },
  ];
  test("残りと同じ額か、振込手数料の分（1,000円まで）だけ少ない額。摘要に取引先の名前・よみがあるものから", () => {
    expect(paymentCandidates({ amount: 99_130, description: "ﾌﾘｺﾐ ｶ)ﾔﾏﾀﾞ" }, open)).toEqual([
      { id: 1, doc_no: "2026-0001", to_name: "株式会社ヤマダ", fee: 660, named: true },
      { id: 2, doc_no: "2026-0002", to_name: "山本商店", fee: 870, named: false },
    ]);
    expect(paymentCandidates({ amount: 50_000, description: "振込" }, open).map((c) => [c.id, c.fee])).toEqual([[3, 0]]);
    expect(paymentCandidates({ amount: 10_000, description: "振込" }, open)).toEqual([]);
  });
});

describe("発行者と CSV（交付した請求書の写し・控えのデータ）", () => {
  const settings = {
    business_name: "山田デザイン", owner_name: "山田 太郎", postal_code: "100-0001", address: "東京都千代田区千代田1-1", office_address: "", phone: "03-1234-5678", office_phone: "",
    invoice_no: "T1234567890123", invoice_registered_on: "2025-10-01",
  };
  test("発行者：屋号と氏名・住所（事業所があれば事業所）・登録番号（免税の年と登録日より前の取引は空）", () => {
    expect(issuerOf(settings, { issue_date: "2026-05-31", delivery_date: null }, false)).toEqual({
      name: "山田デザイン", owner: "山田 太郎", postal: "100-0001", address: "東京都千代田区千代田1-1", phone: "03-1234-5678", invoice_no: "T1234567890123",
    });
    expect(issuerOf({ ...settings, office_address: "東京都港区1-1" }, { issue_date: "2026-05-31", delivery_date: null }, false).address).toBe("東京都港区1-1");
    expect(issuerOf(settings, { issue_date: "2026-05-31", delivery_date: null }, true).invoice_no).toBe("");
    expect(issuerOf(settings, { issue_date: "2025-10-05", delivery_date: "2025-09-30" }, false).invoice_no).toBe("");
    expect(issuerOf({ ...settings, business_name: "" }, { issue_date: "2026-05-31", delivery_date: null }, false)).toMatchObject({ name: "山田 太郎", owner: "" });
  });
  test("一覧の CSV：税率ごとの対価の額と消費税額・合計・源泉徴収・差引請求額・状態・登録番号。明細の CSV は行ごと", () => {
    const d = {
      id: 1, kind: "invoice" as const, doc_no: "2026-0001", issue_date: "2026-05-31", delivery_date: "2026-05-20", due_date: "2026-06-30", counterparty_id: null,
      to_name: "株式会社エー", honorific: "御中", to_address: "", subject: "制作費", price_mode: "exclusive" as const, withholding: 0, notes: "", bank_text: "",
      status: "issued" as const, source_id: null, entry_id: null, revenue_account_id: null, rounding: "floor" as const, exempt: 0,
      issuer: { name: "山田デザイン", owner: "", postal: "", address: "", phone: "", invoice_no: "T1234567890123" },
      items: [{ name: "デザイン", qty: 1, unit: "式", price: 100_000, tax: "10" as const }, { name: "菓子", qty: 3, unit: "個", price: 1_234, tax: "8" as const }],
    };
    const row = salesDocCsvRow(d, "発行済み");
    expect(row.length).toBe(SALES_DOC_CSV_HEADER.length);
    expect(row).toEqual([
      "請求書", "2026-0001", "2026-05-31", "2026-05-20", "2026-06-30", "株式会社エー 御中", "制作費",
      100_000, 10_000, 3_702, 296, 0, 0, 0, 0, 0, 113_998, 0, 113_998, "発行済み", "T1234567890123",
    ]);
    expect(salesDocItemCsvRows(d)[1]).toEqual(["請求書", "2026-0001", "2026-05-31", 2, "菓子", 3, "個", 1_234, "税抜", "8%（軽減）", 3_702]);
  });
});
