import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, Counterparty, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { buildTaxSummary, codeMismatch, includedTax, taxChecks, taxKindOf } from "./taxSummary";
import { privateTaxSplit } from "./homeUse";
import { interimPlan } from "./taxInterim";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const acc = (name: string) => accounts.find((a) => a.name === name)!;
const twenty: TaxYear[] = [{ from_year: 2026, status: "twenty", method: "inclusive", business_class: 5, taxable_from: "2026-04-01" }];

let seq = 0;
const line = (date: string, side: "debit" | "credit", name: string, amount: number, tax: FlatLine["tax_code"], invoice: FlatLine["invoice_kind"] = null, extra: Partial<FlatLine> = {}): FlatLine => ({
  entry_id: ++seq, date, description: "", row_no: 1, side, account_id: id(name), sub_account_id: null, amount, memo: "",
  tax_code: tax, invoice_kind: invoice, ...extra,
});

describe("集計表", () => {
  test("区分は貸借の側で判定する", () => {
    expect(taxKindOf("sales10", "credit")).toBe("sales");
    expect(taxKindOf("sales10", "debit")).toBe("salesReturn");
    expect(taxKindOf("purchase8", "credit")).toBe("purchaseReturn");
    expect(taxKindOf("baddebt10", "debit")).toBe("badDebt");
    expect(taxKindOf("baddebt10", "credit")).toBe("badDebtRecovered");
    expect(taxKindOf("none", "debit")).toBe("other");
    expect(includedTax(11000, 10)).toBe(1000);
    expect(includedTax(1080, 8)).toBe(80);
    expect(includedTax(999, 10)).toBe(90);
  });

  test("課税事業者の期間だけ集計し、経過措置は日付の割合ごとに分ける。対象外は損益の科目だけ", () => {
    const lines = [
      line("2026-03-31", "credit", "売上高", 99999, "sales10"), // 課税事業者になる前
      line("2026-04-10", "credit", "売上高", 110000, "sales10"),
      line("2026-04-20", "debit", "売上高", 11000, "sales10"), // 値引き
      line("2026-05-01", "debit", "消耗品費", 1100, "purchase10", "qualified"),
      line("2026-09-30", "debit", "外注工賃", 33000, "purchase10", "transitional"),
      line("2026-10-01", "debit", "外注工賃", 22000, "purchase10", "transitional"),
      line("2026-06-01", "debit", "給料賃金", 200000, "none"),
      line("2026-06-01", "credit", "現金", 200000, "none"),
      line("2026-07-01", "debit", "消耗品費", 500, "purchase10", "qualified", { is_deleted: 1 }),
    ];
    const s = buildTaxSummary(lines, accounts, twenty);
    expect(s.rows.map((r) => [r.kind, r.code, r.invoice, r.transitional, r.amount, r.tax])).toEqual([
      ["sales", "sales10", null, null, 110000, 10000],
      ["salesReturn", "sales10", null, null, 11000, 1000],
      ["purchase", "purchase10", "qualified", null, 1100, 100],
      ["purchase", "purchase10", "transitional", 80, 33000, 3000],
      ["purchase", "purchase10", "transitional", 70, 22000, 2000],
      ["other", "none", null, null, 200000, 0],
    ]);
    expect(s.rows[0].accounts).toEqual([{ account_id: id("売上高"), amount: 110000, lines: 1 }]);
  });

  test("課税売上割合は税抜・返還を差し引いて計算する", () => {
    const s = buildTaxSummary([
      line("2026-05-01", "credit", "売上高", 110000, "sales10"),
      line("2026-05-02", "debit", "売上高", 11000, "sales10"),
      line("2026-05-03", "credit", "雑収入", 10000, "sales_nontax"),
      line("2026-05-04", "credit", "売上高", 5000, "export"),
    ], accounts, twenty);
    expect(s.ratio).toMatchObject({ taxable: 90000, exportSales: 5000, nontax: 10000 });
    expect(s.ratio.value).toBeCloseTo(95000 / 105000);
  });
});

describe("確認の一覧", () => {
  const cps: Counterparty[] = [
    { id: 1, name: "登録なしの外注先", kana: "", invoice_no: "", not_registered: 1, memo: "", is_active: 1 },
    { id: 2, name: "登録ありの店", kana: "", invoice_no: "T1234567890123", not_registered: 0, memo: "", is_active: 1 },
    { id: 3, name: "番号未入力の店", kana: "", invoice_no: "", not_registered: 0, memo: "", is_active: 1 },
  ];
  const run = (lines: FlatLine[], taxYears = twenty, extra: { invoiceNo?: string; registeredOn?: string } = {}) =>
    taxChecks({
      year: 2026, lines, accounts, counterparties: cps, taxYears, invoiceNo: extra.invoiceNo ?? "", registeredOn: extra.registeredOn ?? "",
      summary: buildTaxSummary(lines, accounts, taxYears),
    });

  test("科目と税区分の組み合わせ", () => {
    expect(codeMismatch(acc("売上高"), "purchase10")).toMatch(/収益/);
    expect(codeMismatch(acc("消耗品費"), "sales10")).toMatch(/経費/);
    expect(codeMismatch(acc("貸倒金"), "baddebt10")).toBeNull();
    expect(codeMismatch(acc("工具器具備品"), "sales10")).toBeNull(); // 資産の売却
    expect(codeMismatch(acc("借入金"), "purchase10")).toMatch(/負債/);
  });

  test("未設定・組み合わせ・インボイス区分と取引先を見つける（期間の外と削除済みは見ない）", () => {
    const untaxed = line("2026-05-01", "debit", "消耗品費", 1000, null);
    const before = line("2026-03-01", "debit", "消耗品費", 1000, null);
    const wrong = line("2026-05-02", "credit", "売上高", 1000, "purchase10", "qualified");
    const q1 = line("2026-05-03", "debit", "外注工賃", 1000, "purchase10", "qualified", { counterparty_id: 1 });
    const t2 = line("2026-05-04", "debit", "消耗品費", 1000, "purchase10", "transitional", { counterparty_id: 2 });
    const q3 = line("2026-05-05", "debit", "消耗品費", 1000, "purchase10", "qualified", { counterparty_id: 3 });
    const deleted = line("2026-05-06", "debit", "消耗品費", 1000, null, null, { is_deleted: 1 });
    const issues = run([untaxed, before, wrong, q1, t2, q3, deleted]);
    expect(issues.map((i) => [i.level, i.entryIds])).toEqual([
      ["error", [untaxed.entry_id]],
      ["warn", [wrong.entry_id]],
      ["warn", [q1.entry_id]],
      ["warn", [t2.entry_id]],
      ["info", [q3.entry_id]],
    ]);
    expect(issues[4].detail).toMatch(/番号未入力の店/);
  });

  test("設定：引き継いだ2割特例が使えない年、登録番号があるのに免税事業者。免税事業者の年は明細を見ない", () => {
    const y2027 = taxChecks({
      year: 2027, lines: [], accounts, counterparties: cps, taxYears: twenty, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, twenty),
    });
    expect(y2027[0]).toMatchObject({ level: "error", fix: "settings" });
    expect(y2027[0].detail).toMatch(/令和8年/);
    const exempt = run([line("2026-05-01", "debit", "消耗品費", 1000, null)], [], { invoiceNo: "T1234567890123", registeredOn: "2026-10-01" });
    expect(exempt.map((i) => i.title)).toEqual(["登録番号があるのに免税事業者になっています"]);
  });

  test("本則課税で課税売上割合が 95% 未満なら知らせる", () => {
    const standard: TaxYear[] = [{ ...twenty[0], status: "standard", taxable_from: "" }];
    const lines = [line("2026-05-01", "credit", "売上高", 110000, "sales10"), line("2026-05-02", "credit", "雑収入", 10000, "sales_nontax")];
    expect(run(lines, standard).map((i) => i.title)).toEqual([expect.stringMatching(/90\.90%/)]);
    expect(run(lines)).toEqual([]); // 2割特例では関係ない
  });
});

describe("年末一括の家事分の税区分", () => {
  const utl = acc("水道光熱費");
  test("年間の計上額の割合で分け、端数は大きい余りから配る", () => {
    const lines = [
      line("2026-01-10", "debit", "水道光熱費", 7000, "purchase10", "qualified"),
      line("2026-02-10", "debit", "水道光熱費", 2000, "purchase10", "transitional"),
      line("2026-03-10", "debit", "水道光熱費", 1000, "purchase8", "qualified"),
      line("2026-03-20", "credit", "水道光熱費", 1000, "purchase8", "qualified"), // 返金で 0
    ];
    expect(privateTaxSplit(utl, lines, 1001)).toEqual([
      { tax_code: "purchase10", invoice_kind: "qualified", amount: 779 },
      { tax_code: "purchase10", invoice_kind: "transitional", amount: 222 },
    ]);
  });

  test("税区分の無い明細の分は対象外。税区分がまったく無ければ1つ（初期値）。作り直す仕訳は除く", () => {
    const a = line("2026-01-10", "debit", "水道光熱費", 3000, null);
    const b = line("2026-06-10", "debit", "水道光熱費", 1000, "purchase10", "qualified");
    expect(privateTaxSplit(utl, [a, b], 400)).toEqual([
      { tax_code: "none", invoice_kind: null, amount: 300 },
      { tax_code: "purchase10", invoice_kind: "qualified", amount: 100 },
    ]);
    expect(privateTaxSplit(utl, [a], 400)).toEqual([{ tax_code: null, invoice_kind: null, amount: 400 }]);
    expect(privateTaxSplit(utl, [a, b], 400, [a.entry_id])).toEqual([{ tax_code: "purchase10", invoice_kind: "qualified", amount: 400 }]);
  });
});

describe("確認の一覧：基準期間の課税売上高", () => {
  const info = (base: number | null, source: "books" | "manual" | "none" = "books") => ({ year: 2026, base, source, fromBooks: null, specific: null });
  const check = (taxYears: TaxYear[], baseSales: ReturnType<typeof info>) =>
    taxChecks({ year: 2026, lines: [], accounts, counterparties: [], taxYears, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, taxYears), baseSales });

  test("免税事業者なのに基準期間が 1,000万円超、2割特例なのに 1,000万円超、簡易課税なのに 5,000万円超", () => {
    expect(check([], info(12_000_000)).map((i) => i.title)).toEqual(["2026年は課税事業者です"]);
    expect(check(twenty, info(12_000_000)).map((i) => i.title)).toEqual(["課税事業者（2割特例）は使えません"]);
    expect(check(twenty, info(9_000_000))).toEqual([]);
    const simplified: TaxYear[] = [{ ...twenty[0], status: "simplified" }];
    expect(check(simplified, info(12_000_000))).toEqual([]);
    expect(check(simplified, info(60_000_000)).map((i) => i.title)).toEqual(["課税事業者（簡易課税）は使えません"]);
  });

  test("帳簿も手入力も無ければ、入れるよう知らせる（免税事業者の年は知らせない）", () => {
    expect(check(twenty, info(null, "none")).map((i) => [i.level, i.title])).toEqual([["info", "基準期間（2024年）の課税売上高が分かりません"]]);
    expect(check([], info(null, "none"))).toEqual([]);
  });
});


describe("確認の一覧：事業区分の分からない売上", () => {
  test("簡易課税の年に区分の無い課税売上があれば知らせる。集計表では「不明」（0）に分ける", () => {
    const simplified: TaxYear[] = [{ from_year: 2026, status: "simplified", method: "inclusive", business_class: 5, taxable_from: "" }];
    const lines = [
      line("2026-05-01", "credit", "売上高", 1100, "sales10"),
      { ...line("2026-05-02", "credit", "売上高", 2200, "sales10"), business_class: 2 },
    ];
    const summary = buildTaxSummary(lines, accounts, simplified);
    expect(summary.rows.map((r) => [r.businessClass, r.amount])).toEqual([[0, 1100], [2, 2200]]);
    const issues = taxChecks({ year: 2026, lines, accounts, counterparties: [], taxYears: simplified, invoiceNo: "", registeredOn: "", summary });
    expect(issues.map((i) => [i.level, i.title, i.entryIds])).toEqual([["error", "事業区分の分からない売上", [lines[0].entry_id]]]);
    // 本則課税の年は知らせない
    expect(taxChecks({ year: 2026, lines, accounts, counterparties: [], taxYears: twenty, invoiceNo: "", registeredOn: "", summary: buildTaxSummary(lines, accounts, twenty) })).toEqual([]);
  });
});

describe("本則課税の用途区分（集計表・確認）", () => {
  const standard = (deduction: TaxYear["deduction"] = "individual"): TaxYear[] => [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction }];
  const lines = () => [
    line("2026-05-01", "credit", "売上高", 110000, "sales10"),
    line("2026-05-02", "credit", "雑収入", 100000, "sales_nontax"),
    line("2026-05-03", "debit", "消耗品費", 1100, "purchase10", "qualified", { purchase_use: "taxable" }),
    line("2026-05-04", "debit", "消耗品費", 2200, "purchase10", "qualified"),
  ];
  test("課税売上割合が 95% 未満なら、課税仕入を用途区分ごとに分けて集計し、区分の無いものを知らせる", () => {
    const ls = lines();
    const summary = buildTaxSummary(ls, accounts, standard());
    expect(summary.rows.filter((r) => r.kind === "purchase").map((r) => [r.purchaseUse, r.amount])).toEqual([["taxable", 1100], ["unknown", 2200]]);
    const issues = taxChecks({ year: 2026, lines: ls, accounts, counterparties: [], taxYears: standard(), invoiceNo: "", registeredOn: "", summary });
    expect(issues.map((i) => [i.title, i.entryIds])).toEqual([
      [expect.stringMatching(/95% 未満/), []],
      ["用途区分の入っていない課税仕入", [ls[3].entry_id]],
    ]);
    expect(issues[0].detail).toMatch(/今は個別対応方式/);
    // 一括比例配分方式なら用途区分は使わない
    const lump = taxChecks({ year: 2026, lines: ls, accounts, counterparties: [], taxYears: standard("lump"), invoiceNo: "", registeredOn: "", summary });
    expect(lump.map((i) => i.title)).toEqual([expect.stringMatching(/95% 未満/)]);
  });

  test("95% 以上なら用途区分で分けない", () => {
    const ls = [line("2026-05-01", "credit", "売上高", 110000, "sales10"), ...lines().slice(2)];
    const summary = buildTaxSummary(ls, accounts, standard());
    expect(summary.rows.filter((r) => r.kind === "purchase").map((r) => [r.purchaseUse, r.amount, r.lines])).toEqual([[null, 3300, 2]]);
  });

  test("前の年に一括比例配分方式にしたのに、この年が個別対応方式なら知らせる", () => {
    const years: TaxYear[] = [{ ...standard("lump")[0], from_year: 2025 }, ...standard("individual")];
    const issues = taxChecks({ year: 2026, lines: [], accounts, counterparties: [], taxYears: years, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, years) });
    expect(issues.map((i) => [i.level, i.title])).toEqual([["error", "控除の方式を確かめてください"]]);
  });

  test("年末一括の家事分は用途区分ごとにも分ける", () => {
    const utl = acc("水道光熱費");
    const ls = [
      line("2026-01-10", "debit", "水道光熱費", 3000, "purchase10", "qualified", { purchase_use: "taxable" }),
      line("2026-02-10", "debit", "水道光熱費", 1000, "purchase10", "qualified", { purchase_use: "common" }),
    ];
    expect(privateTaxSplit(utl, ls, 400)).toEqual([
      { tax_code: "purchase10", invoice_kind: "qualified", purchase_use: "taxable", amount: 300 },
      { tax_code: "purchase10", invoice_kind: "qualified", purchase_use: "common", amount: 100 },
    ]);
  });
});

describe("中間申告（確認）", () => {
  const standard: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 }];
  const check = (prevTax: number | null, entered: { national: number; local: number }, voluntary = false) => taxChecks({
    year: 2026, lines: [], accounts, counterparties: [], taxYears: standard, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, standard),
    interim: { plan: interimPlan({ year: 2026, prevTax, exempt: false, voluntary }), entered },
  });

  test("中間申告が要るのに中間納付税額が 0 なら知らせる（任意の中間申告は念のため）", () => {
    const [i] = check(6_000_000, { national: 0, local: 0 });
    expect(i).toMatchObject({ level: "warn", title: "中間納付税額が入っていません", fix: "return" });
    expect(i.detail).toMatch(/年3回（合計 消費税 4,500,000円・地方消費税 1,269,000円）/);
    expect(check(400_000, { national: 0, local: 0 }, true)[0]).toMatchObject({ level: "info", title: "中間納付税額が入っていません" });
  });
  test("前年の実績で計算した額と同じなら何も出さず、違えば念のため知らせる", () => {
    expect(check(6_000_000, { national: 4_500_000, local: 1_269_000 })).toEqual([]);
    expect(check(6_000_000, { national: 4_000_000, local: 1_128_200 })[0]).toMatchObject({ level: "info", title: expect.stringMatching(/計算した額と違います/) });
  });
  test("前年の税額が分からなければ入れるように知らせる。要らない年に入っていれば知らせる", () => {
    expect(check(null, { national: 0, local: 0 })[0]).toMatchObject({ level: "info", fix: "interim", title: "前年（2025年）の確定消費税額が分かりません" });
    expect(check(300_000, { national: 0, local: 0 })).toEqual([]);
    expect(check(300_000, { national: 100_000, local: 28_200 })[0]).toMatchObject({ title: expect.stringMatching(/要らない年/) });
  });
});

describe("棚卸資産の調整（確認）", () => {
  const ty = (from_year: number, status: TaxYear["status"], taxable_from = ""): TaxYear =>
    ({ from_year, status, method: "inclusive", business_class: 5, taxable_from, deduction: "individual", voluntary_interim: 0 });
  const check = (taxYears: TaxYear[], inventory: { adjust: { direction: "add" | "sub"; rows: { rate: 8 | 10; pct: number; amount: number }[] } | null; opening: number; closing: number }) =>
    taxChecks({ year: 2026, lines: [], accounts, counterparties: [], taxYears, invoiceNo: "", registeredOn: "", summary: buildTaxSummary([], accounts, taxYears), inventory });
  const add = { direction: "add" as const, rows: [{ rate: 10 as const, pct: 100, amount: 1_000_000 }] };

  test("前年が免税で本則課税になった年、期首の棚卸高があるのに加算が無ければ知らせる", () => {
    const years = [ty(2025, "exempt"), ty(2026, "standard")];
    expect(check(years, { adjust: null, opening: 1_741_000, closing: 0 })[0]).toMatchObject({
      level: "warn", fix: "return", title: "免税事業者から課税事業者になった年の棚卸資産の調整が入っていません",
    });
    expect(check(years, { adjust: add, opening: 1_741_000, closing: 0 })).toEqual([]);
    expect(check(years, { adjust: null, opening: 0, closing: 0 })).toEqual([]);
    // 年の途中から課税事業者：前日の棚卸高は帳簿に無いので、念のため
    expect(check([ty(2026, "standard", "2026-04-01")], { adjust: null, opening: 0, closing: 0 })[0]).toMatchObject({ level: "info", detail: expect.stringMatching(/2026-04-01 から課税事業者/) });
  });
  test("翌年から免税になる年は、年末の棚卸高があるのに減算が無ければ知らせる。本則課税でなければ調整は使わない", () => {
    expect(check([ty(2026, "standard"), ty(2027, "exempt")], { adjust: null, opening: 0, closing: 500_000 })[0]).toMatchObject({
      level: "warn", title: "免税事業者になる前の年の棚卸資産の調整が入っていません",
    });
    expect(check([ty(2026, "standard")], { adjust: null, opening: 0, closing: 500_000 })).toEqual([]);
    expect(check([ty(2025, "exempt"), ty(2026, "simplified")], { adjust: add, opening: 1_000_000, closing: 0 })).toEqual([
      expect.objectContaining({ level: "info", title: "棚卸資産の調整が入っていますが、本則課税ではありません" }),
    ]);
  });
});

describe("確認の一覧：固定資産と、課税・非課税を取り違えやすい科目", () => {
  const standard: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" }];
  const car = {
    id: 1, name: "営業車", account_id: id("車両運搬具"), acquired_on: "2026-02-01", used_on: "2026-02-01", cost: 3_300_000, method: "straight" as const,
    useful_life: 6, business_rate: 70, opening_year: null, opening_book_value: null, disposed_on: null, memo: "",
  };
  const check = (lines: FlatLine[], assets: typeof car[], taxYears = standard) =>
    taxChecks({ year: 2026, lines, accounts, counterparties: [], taxYears, invoiceNo: "", registeredOn: "", summary: buildTaxSummary(lines, accounts, taxYears), assets });
  const titles = (xs: ReturnType<typeof check>) => xs.map((i) => i.title);

  test("家事と兼用する資産の取得が全額課税仕入なら知らせる（事業用の部分だけなら知らせない）", () => {
    const all = [line("2026-02-01", "debit", "車両運搬具", 3_300_000, "purchase10", "qualified")];
    expect(titles(check(all, [car]))).toEqual(["家事と兼用する資産の取得が、全額課税仕入になっています"]);
    const split = [line("2026-02-01", "debit", "車両運搬具", 2_310_000, "purchase10", "qualified"), line("2026-02-01", "debit", "車両運搬具", 990_000, "none")];
    expect(check(split, [car])).toEqual([]);
  });

  test("売却した資産の売却額が課税売上に無ければ知らせる。除却なら知らせない", () => {
    const sold = { ...car, business_rate: 100, disposed_on: "2026-11-30", disposal_kind: "sale" as const, sale_price: 1_100_000 };
    const buy = [line("2026-02-01", "debit", "車両運搬具", 3_300_000, "purchase10", "qualified")];
    expect(titles(check(buy, [sold]))).toEqual(["売却した固定資産の売却額が、課税売上に入っていません"]);
    expect(check([...buy, line("2026-11-30", "credit", "車両運搬具", 1_100_000, "sales10")], [sold])).toEqual([]);
    expect(check(buy, [{ ...sold, disposal_kind: "scrap" as const }])).toEqual([]);
  });

  test("念のため：雑収入の課税売上、本則課税の地代家賃・福利厚生費の課税仕入、給料賃金の通勤手当", () => {
    const ls = [
      line("2026-03-01", "credit", "雑収入", 5_000, "sales10"),
      line("2026-03-02", "debit", "地代家賃", 50_000, "purchase10", "qualified"),
      line("2026-03-03", "debit", "福利厚生費", 8_000, "purchase10", "qualified"),
      line("2026-03-25", "debit", "給料賃金", 200_000, "none"),
    ];
    expect(titles(check(ls, []))).toEqual([
      "念のため：雑収入が課税売上になっています", "念のため：地代家賃が課税仕入になっています",
      "念のため：福利厚生費が課税仕入になっています", "念のため：給料賃金の通勤手当は課税仕入です",
    ]);
    // 2割特例では仕入の区分は計算に使わないので、雑収入だけ
    expect(titles(check(ls.map((l) => ({ ...l, date: l.date.replace("-03-", "-05-") })), [], twenty))).toEqual(["念のため：雑収入が課税売上になっています"]);
  });
});
