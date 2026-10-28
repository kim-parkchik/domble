import { describe, expect, test } from "bun:test";
import { depreciationFor, depreciationLines, smallTotalOfYear, straightRateMil, validateAsset, type FixedAsset } from "./depreciation";

const asset = (p: Partial<FixedAsset>): FixedAsset => ({
  id: 1, name: "パソコン", account_id: 134, acquired_on: "2026-04-10", used_on: "2026-04-10", cost: 240_000, method: "straight",
  useful_life: 4, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", ...p,
});
const dep = (a: FixedAsset, y: number) => depreciationFor(a, y)?.depreciation;

describe("定額法", () => {
  test("償却率は 1/耐用年数 を小数第3位で切り上げ（償却率表と同じ）", () => {
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 22, 47, 50].map(straightRateMil)).toEqual([500, 334, 250, 200, 167, 143, 125, 112, 100, 67, 46, 22, 20]);
  });

  test("使い始めた年は月割り。最後は 1円（備忘価額）を残す", () => {
    const pc = asset({});
    expect(depreciationFor(pc, 2025)).toBeNull();
    expect(depreciationFor(pc, 2026)).toEqual({ rate: 0.25, months: 9, opening: 240_000, depreciation: 45_000, business: 45_000, private: 0, closing: 195_000, disposed: false });
    expect([2027, 2028, 2029, 2030, 2031].map((y) => dep(pc, y))).toEqual([60_000, 60_000, 60_000, 14_999, 0]);
    expect(depreciationFor(pc, 2031)?.closing).toBe(1);
  });

  test("1円未満は切り上げ。事業専用割合の分だけ経費（切り捨て）、残りは事業主貸", () => {
    expect(dep(asset({ cost: 100_001, useful_life: 3, used_on: "2026-12-01", acquired_on: "2026-12-01" }), 2026)).toBe(2784);
    const car = depreciationFor(asset({ cost: 3_000_001, useful_life: 6, used_on: "2026-01-15", acquired_on: "2026-01-15", business_rate: 70 }), 2026)!;
    expect([car.depreciation, car.business, car.private]).toEqual([501_001, 350_700, 150_301]);
  });

  test("売却・除却した年はその月まで。翌年からは出さない", () => {
    const pc = asset({ disposed_on: "2027-06-30" });
    expect(depreciationFor(pc, 2027)).toMatchObject({ months: 6, depreciation: 30_000, disposed: true });
    expect(depreciationFor(pc, 2028)).toBeNull();
  });

  test("前から持っている資産は、決めた年の期首の未償却残高から計算する", () => {
    const old = asset({ used_on: "2020-01-01", acquired_on: "2020-01-01", cost: 300_000, opening_year: 2026, opening_book_value: 50_000 });
    expect(depreciationFor(old, 2026)).toMatchObject({ opening: 50_000, depreciation: 49_999, closing: 1 });
    expect(dep(old, 2027)).toBe(0);
  });
});

describe("一括償却資産・少額減価償却資産", () => {
  test("一括償却資産は 1/3 ずつ3年（月割りしない。端数は合計が取得価額になるように）", () => {
    const a = asset({ method: "lump3", cost: 100_001, used_on: "2026-12-20", acquired_on: "2026-12-20" });
    expect([2026, 2027, 2028, 2029].map((y) => dep(a, y))).toEqual([33_334, 33_334, 33_333, 0]);
    expect(depreciationFor(a, 2028)?.closing).toBe(0);
    // 除却しても3年続ける
    expect(dep({ ...a, disposed_on: "2027-03-01" }, 2028)).toBe(33_333);
  });

  test("少額減価償却資産は使い始めた年に全額", () => {
    const a = asset({ method: "small", cost: 280_000, business_rate: 50 });
    expect(depreciationFor(a, 2026)).toMatchObject({ depreciation: 280_000, business: 140_000, private: 140_000, closing: 0 });
    expect(dep(a, 2027)).toBe(0);
    expect(smallTotalOfYear([a, { ...a, used_on: "2027-01-01" }, asset({})], 2026)).toBe(280_000);
  });
});

describe("入力の確かめ", () => {
  const blue = { blue: true };
  test("取得価額・耐用年数・割合・日付", () => {
    expect(validateAsset(asset({}), blue)).toBeNull();
    expect(validateAsset(asset({ name: " " }), blue)).toMatch(/名称/);
    expect(validateAsset(asset({ cost: 0 }), blue)).toMatch(/取得価額/);
    expect(validateAsset(asset({ useful_life: 1 }), blue)).toMatch(/耐用年数/);
    expect(validateAsset(asset({ business_rate: 101 }), blue)).toMatch(/事業専用割合/);
    expect(validateAsset(asset({ used_on: "2026-04-01" }), blue)).toMatch(/使い始めた日/);
    expect(validateAsset(asset({ disposed_on: "2026-01-01" }), blue)).toMatch(/売却・除却/);
  });

  test("一括・少額の上限、少額は青色申告だけ、期首の未償却残高", () => {
    expect(validateAsset(asset({ method: "lump3", cost: 200_000 }), blue)).toMatch(/200,000円未満/);
    expect(validateAsset(asset({ method: "small", cost: 300_000, acquired_on: "2026-03-10", used_on: "2026-03-10" }), blue)).toMatch(/300,000円未満/);
    // 令和8年4月1日以後の取得は 40万円未満、令和11年4月1日以後は特例なし
    expect(validateAsset(asset({ method: "small", cost: 350_000, acquired_on: "2026-03-31", used_on: "2026-03-31" }), blue)).toMatch(/300,000円未満.*3月31日まで/);
    expect(validateAsset(asset({ method: "small", cost: 350_000, acquired_on: "2026-04-01", used_on: "2026-04-01" }), blue)).toBeNull();
    expect(validateAsset(asset({ method: "small", cost: 400_000, acquired_on: "2026-04-01", used_on: "2026-04-01" }), blue)).toMatch(/400,000円未満/);
    expect(validateAsset(asset({ method: "small", cost: 100_000, acquired_on: "2029-04-01", used_on: "2029-04-01" }), blue)).toMatch(/令和11年3月31日まで/);
    expect(validateAsset(asset({ method: "small", cost: 200_000 }), { blue: false })).toMatch(/青色申告/);
    expect(validateAsset(asset({ opening_year: 2027, opening_book_value: null }), blue)).toMatch(/両方/);
    expect(validateAsset(asset({ opening_year: 2027, opening_book_value: 300_000 }), blue)).toMatch(/取得価額以下/);
    expect(validateAsset(asset({ opening_year: 2025, opening_book_value: 1000 }), blue)).toMatch(/使い始めた年より後/);
  });
});

describe("年末の減価償却の仕訳", () => {
  test("資産ごとに 減価償却費（事業分） / 資産の科目。家事分は事業主貸。0% は事業主貸だけ。償却しない資産は入れない", () => {
    const ids = { expense: 611, draw: 190 };
    const lines = depreciationLines(
      [asset({ business_rate: 80 }), asset({ id: 2, name: "私用", business_rate: 0, cost: 120_000, account_id: 133 }), asset({ id: 3, used_on: "2027-01-01", acquired_on: "2027-01-01" })],
      2026, ids,
    );
    expect(lines.map((l) => [l.row_no, l.side, l.account_id, l.amount, l.memo])).toEqual([
      [1, "debit", 611, 36_000, "減価償却 パソコン"],
      [1, "credit", 134, 45_000, "減価償却 パソコン"],
      [2, "debit", 190, 9_000, "減価償却 パソコン（家事分 20%）"],
      [3, "debit", 190, 22_500, "減価償却 私用（家事分 100%）"],
      [3, "credit", 133, 22_500, "減価償却 私用"],
    ]);
  });
});
