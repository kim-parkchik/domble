/**
 * 申告書の数字を、国税庁の「申告書の書き方」「2割特例用 確定申告の手引き」の設例で確かめる
 */
import { describe, expect, test } from "bun:test";
import type { TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { buildTaxBase, computeReturn, methodsFor, simplifiedReturn, standardReturn, thirtyReturn, twentyReturn, type TaxBase, type TaxReturn } from "./taxReturn";

const base = (x: Partial<TaxBase>): TaxBase => ({
  sales: { 8: 0, 10: 0 }, salesReturn: { 8: 0, 10: 0 }, badDebt: { 8: 0, 10: 0 }, badDebtRecovered: { 8: 0, 10: 0 },
  exportSales: 0, nontaxSales: 0, purchase: { 8: 0, 10: 0 }, purchaseReturn: { 8: 0, 10: 0 }, transitional: [], ...x,
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

  test("課税売上割合が 95% 未満なら一括比例配分方式", () => {
    const low = standardReturn(base({ sales: { 8: 0, 10: 1_100_000 }, nontaxSales: 1_000_000, purchase: { 8: 0, 10: 220_000 } }), opts);
    // ⑰ = 220,000 × 7.8/110 = 15,600。割合 1,000,000 / 2,000,000 = 50%
    expect(cell(low, "2-3", "㉒")).toEqual({ a: 0, b: 7_800, c: 7_800 });
    expect(low.notes.join()).toMatch(/一括比例配分方式/);
  });

  test("令和8年は経過措置が 80% と 70% に分かれる", () => {
    const lines: FlatLine[] = [
      { entry_id: 1, date: "2026-09-30", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "transitional" },
      { entry_id: 2, date: "2026-10-01", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "transitional" },
      { entry_id: 3, date: "2026-10-02", description: "", row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 110_000, memo: "", tax_code: "purchase10", invoice_kind: "none" },
    ];
    const years: TaxYear[] = [{ from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "" }];
    const tb = buildTaxBase(lines, years);
    expect(tb.transitional.map((t) => [t.pct, t.purchase[10]])).toEqual([[80, 110_000], [70, 110_000]]);
    expect(tb.purchase[10]).toBe(0); // 控除しない
    // 7,800 × 80% + 7,800 × 70% = 6,240 + 5,460
    expect(cell(standardReturn(tb, opts), "2-3", "⑫").c).toBe(11_700);
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
