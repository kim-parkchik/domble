/**
 * 申告書の数字を、国税庁の「申告書の書き方」「2割特例用 確定申告の手引き」の設例で確かめる
 */
import { describe, expect, test } from "bun:test";
import type { TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { buildTaxBase, computeReturn, methodsFor, simplifiedReturn, standardReturn, thirtyReturn, twentyReturn, type TaxBase, type TaxReturn } from "./taxReturn";
import { effectiveBusinessClass } from "./tax";

const base = (x: Partial<TaxBase>): TaxBase => ({
  sales: { 8: 0, 10: 0 }, salesReturn: { 8: 0, 10: 0 }, badDebt: { 8: 0, 10: 0 }, badDebtRecovered: { 8: 0, 10: 0 },
  exportSales: 0, nontaxSales: 0, purchase: { 8: 0, 10: 0 }, purchaseReturn: { 8: 0, 10: 0 }, transitional: [], byClass: {}, ...x,
});
const opts = { businessClass: 5, interimNational: 0, interimLocal: 0 };
/** 様式の欄の値（no で引く） */
const cell = (r: TaxReturn, form: string, no: string) => {
  const row = r.forms.find((f) => f.id === form)!.rows.find((x) => x.no === no)!;
  return { a: row.a, b: row.b, c: row.c };
};

describe("本則課税（一般用の書き方の設例：割戻し計算）", () => {
  const b = base({
    sales: { 8: 203_878_000, 10: 135_400_000 }, salesReturn: { 8: 4_521_120, 10: 4_400_005 },
    exportSales: 11_000_000, nontaxSales: 7_000_000,
    purchase: { 8: 98_628_000, 10: 72_730_000 }, purchaseReturn: { 8: 6_410_000, 10: 3_700_000 },
    transitional: [{ pct: 80, purchase: { 8: 21_600_000, 10: 22_000_000 }, ret: { 8: 2_160_000, 10: 2_200_000 } }],
    badDebt: { 8: 0, 10: 1_230_000 },
  });
  const r = standardReturn(b, { ...opts, interimNational: 5_460_300, interimLocal: 1_540_000 });

  test("付表1-3：課税標準額・消費税額・返還・貸倒れ", () => {
    expect(cell(r, "1-3", "①-1")).toEqual({ a: 188_775_925, b: 123_090_909, c: 311_866_834 });
    expect(cell(r, "1-3", "①")).toEqual({ a: 188_775_000, b: 123_090_000, c: 311_865_000 });
    expect(cell(r, "1-3", "②")).toEqual({ a: 11_779_560, b: 9_601_020, c: 21_380_580 });
    expect(cell(r, "1-3", "⑤-1")).toEqual({ a: 261_220, b: 312_000, c: 573_220 });
    expect(cell(r, "1-3", "⑥")).toEqual({ a: 0, b: 87_218, c: 87_218 });
    expect(cell(r, "1-3", "⑦")).toEqual({ a: 6_487_931, b: 6_417_273, c: 12_905_204 });
    expect(cell(r, "1-3", "⑨").c).toBe(8_475_300);
    expect(cell(r, "1-3", "⑬").c).toBe(2_390_400);
  });

  test("付表2-3：課税売上割合・仕入税額（経過措置 80%）", () => {
    expect(cell(r, "2-3", "①")).toEqual({ a: 184_589_703, b: 119_090_905, c: 303_680_608 });
    expect(cell(r, "2-3", "④").c).toBe(314_680_608);
    expect(cell(r, "2-3", "⑦").c).toBe(321_680_608);
    expect(cell(r, "2-3", "⑨")).toEqual({ a: 92_218_000, b: 69_030_000, c: 161_248_000 });
    expect(cell(r, "2-3", "⑩")).toEqual({ a: 5_328_151, b: 4_894_855, c: 10_223_006 });
    expect(cell(r, "2-3", "⑪")).toEqual({ a: 19_440_000, b: 19_800_000, c: 39_240_000 });
    expect(cell(r, "2-3", "⑫")).toEqual({ a: 898_560, b: 1_123_200, c: 2_021_760 });
    expect(cell(r, "2-3", "⑱")).toEqual({ a: 6_226_711, b: 6_018_055, c: 12_244_766 });
    expect(cell(r, "2-3", "㉖")).toEqual({ a: 6_226_711, b: 6_018_055, c: 12_244_766 });
  });

  test("第一表：中間納付を引いた納付税額・合計", () => {
    expect(cell(r, "first", "⑪").c).toBe(3_015_000);
    expect(cell(r, "first", "㉒").c).toBe(850_400);
    expect(r.total).toBe(3_865_400);
    expect(cell(r, "first", "⑮").c).toBe(314_680_608);
    expect(cell(r, "first", "⑯").c).toBe(321_680_608);
    expect(cell(r, "second", "⑰").c).toBe(573_220);
    expect(r.notes.join()).not.toMatch(/一括比例/);
  });

  describe("課税売上割合が 95% 未満：個別対応方式と一括比例配分方式", () => {
    // 課税売上 1,100,000（税抜 1,000,000）・非課税売上 1,000,000 → 課税売上割合 50%
    // 課税仕入（10%）：課税対応 110,000（税額 7,800）・用途区分なし 220,000（共通対応 15,600）・非課税対応 330,000（23,400）
    const line = (entry_id: number, amount: number, purchase_use: FlatLine["purchase_use"], code: FlatLine["tax_code"] = "purchase10", side: FlatLine["side"] = "debit"): FlatLine => ({
      entry_id, date: "2026-05-01", description: "", row_no: 1, side, account_id: 1, sub_account_id: null, amount, memo: "", tax_code: code, invoice_kind: code === "purchase10" ? "qualified" : null, purchase_use,
    });
    const years: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" }];
    const tb = buildTaxBase([
      line(1, 1_100_000, null, "sales10", "credit"), line(2, 1_000_000, null, "sales_nontax", "credit"),
      line(3, 110_000, "taxable"), line(4, 220_000, null), line(5, 330_000, "nontaxable"),
    ], years);

    test("個別対応方式：⑲ 課税対応 ＋ ⑳ 共通対応 × 課税売上割合（非課税対応は控除しない）", () => {
      const r = standardReturn(tb, opts);
      expect(cell(r, "2-3", "⑰").c).toBe(46_800);
      expect(cell(r, "2-3", "⑲").c).toBe(7_800);
      expect(cell(r, "2-3", "⑳").c).toBe(15_600);
      expect(cell(r, "2-3", "㉑")).toEqual({ a: 0, b: 15_600, c: 15_600 });
      expect(cell(r, "2-3", "㉖").c).toBe(15_600);
      expect(r.forms[0].rows.some((x) => x.no === "㉒")).toBe(false);
      expect(r.deduction).toEqual({ method: "individual", amounts: { individual: 15_600, lump: 23_400 } });
      expect(r.notes.join()).toMatch(/個別対応方式/);
      expect(r.notes.join()).toMatch(/用途区分の入っていない課税仕入（税込 220,000円）は、共通対応/);
    });

    test("一括比例配分方式：⑰ × 課税売上割合", () => {
      const r = standardReturn(tb, { ...opts, deduction: "lump" });
      expect(cell(r, "2-3", "㉒")).toEqual({ a: 0, b: 23_400, c: 23_400 });
      expect(cell(r, "2-3", "㉖").c).toBe(23_400);
      expect(r.forms[0].rows.some((x) => x.no === "㉑")).toBe(false);
      expect(r.deduction?.method).toBe("lump");
      expect(r.notes.join()).toMatch(/一括比例配分方式/);
    });

    test("用途区分の無い TaxBase（全部共通対応）なら、どちらの方式も同じ額", () => {
      const low = base({ sales: { 8: 0, 10: 1_100_000 }, nontaxSales: 1_000_000, purchase: { 8: 0, 10: 220_000 } });
      // ⑰ = 220,000 × 7.8/110 = 15,600。割合 50%
      expect(cell(standardReturn(low, opts), "2-3", "㉑").c).toBe(7_800);
      expect(cell(standardReturn(low, { ...opts, deduction: "lump" }), "2-3", "㉒").c).toBe(7_800);
    });

    test("95% 以上なら全額控除で、方式の比較は出さない", () => {
      expect(standardReturn(base({ sales: { 8: 0, 10: 1_100_000 }, purchase: { 8: 0, 10: 220_000 } }), opts).deduction).toBeUndefined();
    });
  });

  test("令和8年は経過措置が 80% と 70% に分かれる", () => {
    const lines: FlatLine[] = [
      { entry_id: 1, date: "2026-09-30", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "transitional" },
      { entry_id: 2, date: "2026-10-01", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "transitional" },
      { entry_id: 3, date: "2026-10-02", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "none" },
    ];
    const years: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" }];
    const tb = buildTaxBase(lines, years);
    expect(tb.transitional.map((t) => [t.pct, t.purchase[10]])).toEqual([[80, 110_000], [70, 110_000]]);
    expect(tb.purchase[10]).toBe(0); // 控除しない
    // 7,800 × 80% + 7,800 × 70% = 6,240 + 5,460
    expect(cell(standardReturn(tb, opts), "2-3", "⑫").c).toBe(11_700);
  });
});

describe("棚卸資産の調整（付表2-3 ⑯。令和7年分 確定申告の手引き 個人事業者用（一般用）の設例「甲野商店」）", () => {
  // 令和6年は免税、令和7年分から課税（本則課税）。期首商品棚卸高 1,741,000円 × 7.8/110 = 123,452円
  const b = base({
    sales: { 8: 13_110_000, 10: 9_550_000 }, nontaxSales: 350_000, purchase: { 8: 8_736_000, 10: 7_690_000 },
    transitional: [{ pct: 80, purchase: { 8: 0, 10: 1_650_000 }, ret: { 8: 0, 10: 0 } }],
  });
  const add = { direction: "add" as const, rows: [{ rate: 10 as const, pct: 100, amount: 1_741_000 }] };
  test("⑯ を加算すると ⑰・第一表 ⑨・地方消費税が国税庁の設例と同じになる", () => {
    const r = standardReturn(b, { ...opts, businessClass: 2, inventory: add });
    expect(cell(r, "2-3", "⑯")).toEqual({ a: 0, b: 123_452, c: 123_452 });
    expect(cell(r, "2-3", "⑰").c).toBe(1_267_088);
    expect(cell(r, "first", "⑨").c).toBe(167_400);
    expect(cell(r, "first", "⑳").c).toBe(47_200);
    // 調整が無ければ ⑯ の行は出さない（調整の分だけ納める額が多い）
    const none = standardReturn(b, { ...opts, businessClass: 2 });
    expect(none.forms.find((f) => f.id === "2-3")!.rows.some((x) => x.no === "⑯")).toBe(false);
    expect(cell(none, "first", "⑨").c).toBe(290_800);
  });
  test("減算はマイナス。軽減税率は 6.24/108、経過措置は控除できる割合を掛ける", () => {
    const r = standardReturn(b, {
      ...opts, inventory: { direction: "sub", rows: [{ rate: 8, pct: 100, amount: 1_080_000 }, { rate: 10, pct: 80, amount: 1_100_000 }] },
    });
    expect(cell(r, "2-3", "⑯")).toEqual({ a: -62_400, b: -62_400, c: -124_800 });
  });
  test("課税売上割合が 95% 未満の個別対応方式では、棚卸資産の調整は課税対応（⑲）に入れる", () => {
    const low = base({ sales: { 8: 0, 10: 11_000_000 }, nontaxSales: 5_000_000, purchase: { 8: 0, 10: 5_500_000 } });
    const r = standardReturn(low, { ...opts, inventory: add });
    const without = standardReturn(low, opts);
    expect(cell(r, "2-3", "⑲").b! - cell(without, "2-3", "⑲").b!).toBe(123_452);
    expect(cell(r, "2-3", "⑳").b).toBe(cell(without, "2-3", "⑳").b);
  });
});

describe("簡易課税（簡易課税用の書き方の設例。第二種事業が 75% 以上なので全体に 80%）", () => {
  const b = base({
    sales: { 8: 19_192_000, 10: 11_516_000 }, salesReturn: { 8: 1_250_000, 10: 756_000 },
    exportSales: 1_100_000, badDebt: { 8: 0, 10: 560_000 },
  });
  const r = simplifiedReturn(b, { ...opts, businessClass: 2 });
  test("付表4-3・5-3・第一表", () => {
    expect(cell(r, "4-3", "①-1")).toEqual({ a: 17_770_370, b: 10_469_090, c: 28_239_460 });
    expect(cell(r, "4-3", "①")).toEqual({ a: 17_770_000, b: 10_469_000, c: 28_239_000 });
    expect(cell(r, "4-3", "②")).toEqual({ a: 1_108_848, b: 816_582, c: 1_925_430 });
    expect(cell(r, "4-3", "⑤")).toEqual({ a: 72_222, b: 53_607, c: 125_829 });
    expect(cell(r, "5-3", "④")).toEqual({ a: 1_036_626, b: 762_975, c: 1_799_601 });
    expect(cell(r, "5-3", "⑤")).toEqual({ a: 829_300, b: 610_380, c: 1_439_680 });
    expect(cell(r, "4-3", "⑥").c).toBe(39_709);
    expect(cell(r, "4-3", "⑦")).toEqual({ a: 901_522, b: 703_696, c: 1_605_218 });
    expect(cell(r, "4-3", "⑨").c).toBe(320_200);
    expect(cell(r, "4-3", "⑬").c).toBe(90_300);
    expect(cell(r, "first", "⑮").c).toBe(27_494_781);
    expect(r.total).toBe(410_500);
  });
});

describe("2割特例・3割特例（2割特例用の手引きの設例）", () => {
  const b = base({ sales: { 8: 0, 10: 6_609_330 }, salesReturn: { 8: 0, 10: 192_900 } });
  test("付表6 と第一表", () => {
    const r = twentyReturn(b, opts);
    expect(cell(r, "6", "①").b).toBe(6_008_481);
    expect(cell(r, "6", "②").b).toBe(6_008_000);
    expect(cell(r, "6", "③").b).toBe(468_624);
    expect(cell(r, "6", "⑤").b).toBe(13_678);
    expect(cell(r, "6", "⑥").b).toBe(454_946);
    expect(cell(r, "6", "⑦").c).toBe(363_956);
    expect(cell(r, "first", "⑨").c).toBe(90_900);
    expect(cell(r, "second", "⑳").c).toBe(90_900);
    expect(cell(r, "first", "⑳").c).toBe(25_600);
    expect(r.total).toBe(116_500);
  });

  test("3割特例は ⑥ × 70%", () => {
    const r = thirtyReturn(b, opts);
    expect(cell(r, "6", "⑦").c).toBe(Math.floor(454_946 * 0.7));
    expect(r.forms[0].title).toMatch(/小規模個人事業者/);
  });

  test("還付になるとき：控除不足還付税額と地方消費税の還付額", () => {
    const r = computeReturn("standard", base({ sales: { 8: 0, 10: 110_000 }, purchase: { 8: 0, 10: 1_100_000 } }), opts);
    // ② 100,000 × 7.8% = 7,800、④ 78,000 → ⑧ 70,200、⑲ 70,200 × 22/78 = 19,800
    expect(cell(r, "first", "⑧").c).toBe(70_200);
    expect(cell(r, "first", "⑨").c).toBe(0);
    expect(cell(r, "first", "⑲").c).toBe(19_800);
    expect(r.total).toBe(-90_000);
  });

  test("その年に使える方式", () => {
    expect(methodsFor(2026)).toEqual(["standard", "simplified", "twenty"]);
    expect(methodsFor(2027)).toEqual(["standard", "simplified", "thirty"]);
    expect(methodsFor(2029)).toEqual(["standard", "simplified"]);
  });
});

test("第一表の ① は第二表の ① と同じ課税標準額", () => {
  const r = twentyReturn(base({ sales: { 8: 0, 10: 6_609_330 } }), opts);
  expect(cell(r, "first", "①").c).toBe(cell(r, "second", "①").c);
});

describe("簡易課税・2種類以上の事業（簡易課税用の書き方の設例：第二種と第四種）", () => {
  const b = base({
    sales: { 8: 19_192_000, 10: 11_516_000 }, salesReturn: { 8: 1_250_000, 10: 756_000 },
    exportSales: 1_100_000, badDebt: { 8: 0, 10: 560_000 },
    byClass: {
      2: { sales: { 8: 19_192_000, 10: 7_712_000 }, ret: { 8: 1_250_000, 10: 456_000 } },
      4: { sales: { 8: 0, 10: 3_804_000 }, ret: { 8: 0, 10: 300_000 } },
    },
  });
  const r = simplifiedReturn(b, opts);
  test("付表5-3 ⑥〜⑲：事業区分ごとの売上と税額", () => {
    expect(cell(r, "5-3", "⑥")).toEqual({ a: 16_612_963, b: 9_781_818, c: 26_394_781 });
    expect(cell(r, "5-3", "⑧")).toEqual({ a: 16_612_963, b: 6_596_364, c: 23_209_327 });
    expect(cell(r, "5-3", "⑩")).toEqual({ a: 0, b: 3_185_454, c: 3_185_454 });
    expect(cell(r, "5-3", "⑬")).toEqual({ a: 1_036_649, b: 762_982, c: 1_799_631 });
    expect(cell(r, "5-3", "⑮")).toEqual({ a: 1_036_649, b: 514_516, c: 1_551_165 });
    expect(cell(r, "5-3", "⑰")).toEqual({ a: 0, b: 248_466, c: 248_466 });
  });
  test("原則計算・特例計算と、いちばん多いものの選択", () => {
    expect(cell(r, "5-3", "⑳")).toEqual({ a: 829_300, b: 560_685, c: 1_389_985 });
    expect(cell(r, "5-3", "㉑")).toEqual({ a: 829_300, b: 610_380, c: 1_439_680 });
    expect(cell(r, "5-3", "㉘")).toEqual({ a: 829_300, b: 560_685, c: 1_389_985 });
    expect(cell(r, "5-3", "㊲")).toEqual({ a: 829_300, b: 610_380, c: 1_439_680 });
    expect(cell(r, "4-3", "④").c).toBe(1_439_680);
    expect(cell(r, "4-3", "⑨").c).toBe(320_200);
    // 第一表の参考事項：千円未満四捨五入・売上割合（小数第1位未満切り捨て）
    const first = r.forms.find((f) => f.id === "first")!.rows;
    expect(first.filter((x) => x.label.includes("事業区分")).map((x) => [x.c, x.note])).toEqual([
      [23_209, "千円未満四捨五入。売上割合 87.9%"],
      [3_185, "千円未満四捨五入。売上割合 12.0%"],
    ]);
    expect(first.find((x) => x.label.includes("令57③"))!.note).toBe("有");
  });
  test("どれも 75% に届かなければ原則計算", () => {
    const even = simplifiedReturn(base({
      sales: { 8: 0, 10: 3_300_000 },
      byClass: { 1: { sales: { 8: 0, 10: 1_100_000 }, ret: { 8: 0, 10: 0 } }, 3: { sales: { 8: 0, 10: 1_100_000 }, ret: { 8: 0, 10: 0 } }, 5: { sales: { 8: 0, 10: 1_100_000 }, ret: { 8: 0, 10: 0 } } },
    }), opts);
    // 各区分 78,000。⑳ = 234,000 × (70,200 + 54,600 + 39,000) / 234,000
    expect(cell(even, "5-3", "㊲").c).toBe(163_800);
    expect(even.forms[0].rows.some((x) => x.no === "㉑")).toBe(false);
  });
  test("明細の事業区分 → 科目の初期値 → 主な事業区分（固定資産の売却は第4種）で分ける", () => {
    const years: TaxYear[] = [{ from_year: 2026, status: "simplified", method: "inclusive", business_class: 5, taxable_from: "" }];
    const acc = (id: number, category: "revenue" | "asset", cls: number | null) => ({ id, code: "", name: "", kana: "", category, normal_side: "credit" as const, sort_order: 0, is_active: 1, is_system: 0, default_tax_code: null, default_business_class: cls });
    const accounts = new Map([[1, acc(1, "revenue", null)], [2, acc(2, "revenue", 2)], [3, acc(3, "asset", null)]]);
    const l = (account_id: number, amount: number, business_class: number | null = null): FlatLine => ({
      entry_id: account_id, date: "2026-05-01", description: "", row_no: 1, side: "credit", account_id, sub_account_id: null, amount, memo: "", tax_code: "sales10", business_class,
    });
    const tb = buildTaxBase([l(1, 110), l(1, 220, 3), l(2, 330), l(3, 440)], years, (x) => effectiveBusinessClass(x, accounts.get(x.account_id), 5));
    expect(Object.fromEntries(Object.entries(tb.byClass).map(([k, v]) => [k, v.sales[10]]))).toEqual({ 2: 330, 3: 220, 4: 440, 5: 110 });
  });
});

describe("簡易課税・事業区分の分からない売上", () => {
  const cls = (sales10: number) => ({ sales: { 8: 0, 10: sales10 }, ret: { 8: 0, 10: 0 } });
  test("その年の売上に出てくる区分のうち、みなし仕入率がいちばん低い区分として計算する", () => {
    const b = base({ sales: { 8: 0, 10: 3_300_000 }, byClass: { 2: cls(1_100_000), 5: cls(1_100_000), 0: cls(1_100_000) } });
    const r = simplifiedReturn(b, { ...opts, businessClass: 2 });
    expect(cell(r, "5-3", "⑪").c).toBe(2_000_000); // 第五種 = 1,000,000 + 不明 1,000,000
    expect(r.notes.join()).toMatch(/第五種事業.*いちばん低い区分/);
  });
  test("区分の分かる売上が無ければ主な事業区分（1種類）", () => {
    const r = simplifiedReturn(base({ sales: { 8: 0, 10: 1_100_000 }, byClass: { 0: cls(1_100_000) } }), { ...opts, businessClass: 3 });
    expect(r.forms[0].rows.find((x) => x.no === "⑤")!.label).toMatch(/70%/);
    expect(r.notes.join()).toMatch(/第三種事業（主な事業区分）/);
  });
});
