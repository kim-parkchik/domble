import { describe, expect, test } from "bun:test";
import {
  assetLockError, assetYears, businessRateIn, conversionOf, decliningKind, decliningProblem, decliningRates, depreciationFor, depreciationLines, disposalLines, lifeText,
  usedAssetLife, methodLabel, oldDecliningRateMil, oldStraightRateMil, smallTotalOfYear, statementLife, statementMemo, statementMethod, straightRateMil, validateAsset,
  type FixedAsset, lendingRestricted, smallYearLimit,
} from "./depreciation";

const asset = (p: Partial<FixedAsset>): FixedAsset => ({
  id: 1, name: "パソコン", account_id: 134, acquired_on: "2026-04-10", used_on: "2026-04-10", cost: 240_000, method: "straight",
  useful_life: 4, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", ...p,
});
const dep = (a: FixedAsset, y: number) => depreciationFor(a, y)?.depreciation;
const blueOpts = { blue: true };

describe("定額法", () => {
  test("償却率は 1/耐用年数 を小数第3位で切り上げ（償却率表と同じ）", () => {
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 22, 47, 50].map(straightRateMil)).toEqual([500, 334, 250, 200, 167, 143, 125, 112, 100, 67, 46, 22, 20]);
  });

  test("使い始めた年は月割り。最後は 1円（備忘価額）を残す", () => {
    const pc = asset({});
    expect(depreciationFor(pc, 2025)).toBeNull();
    expect(depreciationFor(pc, 2026)).toEqual({
      rate: 0.25, base: 240_000, equal: false, revised: false, months: 9, opening: 240_000, depreciation: 45_000, businessRate: 100, business: 45_000, private: 0, closing: 195_000, disposed: false,
    });
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

describe("旧定額法（平成19年3月31日以前の取得）", () => {
  test("償却率は旧定額法の表（別表第七）。今の定額法と違う耐用年数がある", () => {
    expect([2, 3, 6, 7, 9, 11, 22, 27, 37, 50, 51, 60, 100].map(oldStraightRateMil)).toEqual([500, 333, 166, 142, 111, 90, 46, 37, 27, 20, 20, 17, 10]);
  });
  test("償却方法「定額法」でも、取得日が平成19年3月31日以前なら旧定額法", () => {
    expect(methodLabel(asset({ acquired_on: "2007-03-31" }))).toBe("旧定額法");
    expect(methodLabel(asset({ acquired_on: "2007-04-01" }))).toBe("定額法");
    expect(methodLabel(asset({ acquired_on: "2007-03-31", method: "lump3" }))).toBe("一括償却資産（3年）");
  });
  test("取得価額 × 90% × 償却率。95% に達した翌年から5年で1円まで均等償却（国税庁 No.2105 の例：500万円・5年）", () => {
    const a = asset({ cost: 5_000_000, useful_life: 5, acquired_on: "2001-01-10", used_on: "2001-01-10" });
    expect(Array.from({ length: 12 }, (_, i) => dep(a, 2001 + i))).toEqual([
      900_000, 900_000, 900_000, 900_000, 900_000, 250_000, 50_000, 50_000, 50_000, 50_000, 49_999, 0,
    ]);
    expect(depreciationFor(a, 2001)).toMatchObject({ rate: 0.2, base: 4_500_000, equal: false });
    expect(depreciationFor(a, 2006)).toMatchObject({ base: 4_500_000, equal: false, closing: 250_000 });
    expect(depreciationFor(a, 2007)).toMatchObject({ rate: 0.2, base: 250_000, equal: true });
    expect(depreciationFor(a, 2011)?.closing).toBe(1);
  });
  test("全体の確認の例：2000年4月取得の建物 1,000万円・22年。期首の未償却残高からでも、取得から積み上げても正しい", () => {
    const b = asset({ cost: 10_000_000, useful_life: 22, acquired_on: "2000-04-01", used_on: "2000-04-01" });
    expect(dep({ ...b, opening_year: 2015, opening_book_value: 5_000_000 }, 2015)).toBe(414_000);
    // 2000年は9か月 310,500円、2001〜2022年は 414,000円、2023年に 95% に達し（81,500円）、2024年から 100,000円ずつ
    expect([2000, 2001, 2022, 2023, 2024, 2025, 2027, 2028, 2029].map((y) => dep(b, y))).toEqual([310_500, 414_000, 414_000, 81_500, 100_000, 100_000, 100_000, 99_999, 0]);
    expect(depreciationFor(b, 2025)).toMatchObject({ equal: true, base: 500_000, opening: 400_000, closing: 300_000 });
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

describe("年ごとの事業専用割合", () => {
  test("その年以前で最も新しい割合。前の年はそのまま。家事分の摘要もその年の割合", () => {
    const car = asset({ business_rate: 60, rates: [{ from_year: 2028, rate: 50 }, { from_year: 2027, rate: 80 }] });
    expect([2026, 2027, 2028, 2029].map((y) => businessRateIn(car, y))).toEqual([60, 80, 50, 50]);
    const d = depreciationFor(car, 2027)!;
    expect([d.depreciation, d.businessRate, d.business, d.private]).toEqual([60_000, 80, 48_000, 12_000]);
    expect(depreciationFor(car, 2026)!.business).toBe(27_000);
    const lines = depreciationLines([car], 2027, { expense: 611, draw: 190 });
    expect(lines.at(-1)?.memo).toBe("減価償却 パソコン（家事分 20%）");
  });
});

describe("年の締めをした年の固定資産", () => {
  const pc = asset({});
  test("台帳に出る年：使い始めた年から売却・除却の年まで。一括償却資産は3年目まで。売っていなければ終わりなし", () => {
    expect(assetYears(pc)).toEqual({ from: 2026, to: Infinity });
    expect(assetYears(asset({ disposed_on: "2028-03-31" }))).toEqual({ from: 2026, to: 2028 });
    expect(assetYears(asset({ method: "lump3", cost: 150_000, disposed_on: "2026-12-01" }))).toEqual({ from: 2026, to: 2028 });
  });

  test("締めた年に台帳に出る資産は、追加・削除・項目の変更ができない（名称・備考も）", () => {
    expect(assetLockError(null, pc, [2026])).toMatch(/2026年は締め済み.*追加できません/);
    expect(assetLockError(null, asset({ used_on: "2027-01-05", acquired_on: "2026-12-20" }), [2026])).toBeNull();
    expect(assetLockError(pc, null, [2026])).toMatch(/削除できません/);
    expect(assetLockError(pc, null, [2025])).toBeNull();
    expect(assetLockError(pc, { ...pc, cost: 300_000 }, [2026])).toMatch(/取得価額は変えられません/);
    expect(assetLockError(pc, { ...pc, name: "ノートパソコン", memo: "型番" }, [2026])).toMatch(/名称・備考は変えられません/);
    expect(assetLockError(pc, { ...pc, cost: 300_000 }, [2025])).toBeNull();
    // 締めた年にかかるようにずらすのも不可
    const later = asset({ used_on: "2027-02-01" });
    expect(assetLockError(later, { ...later, used_on: "2026-12-01" }, [2026])).toMatch(/使っていることになる変更/);
  });

  test("売却・除却の日は、締めた年にかからなければ入れられる", () => {
    expect(assetLockError(pc, { ...pc, disposed_on: "2027-06-30" }, [2026])).toBeNull();
    expect(assetLockError(pc, { ...pc, disposed_on: "2026-11-30" }, [2026])).toMatch(/売却・除却の日/);
    // 売却を取り消すと、締めた 2028年の台帳に出るようになる
    const sold = asset({ disposed_on: "2027-06-30" });
    expect(assetLockError(sold, { ...sold, disposed_on: null }, [2026, 2028])).toMatch(/2028年/);
  });

  test("事業専用割合は、締めていない年からなら変えられる。締めた年の割合が変わる変更はできない", () => {
    expect(assetLockError(pc, { ...pc, rates: [{ from_year: 2027, rate: 80 }] }, [2026])).toBeNull();
    expect(assetLockError(pc, { ...pc, business_rate: 80 }, [2026])).toMatch(/2026年は締め済み.*事業専用割合/);
    // 2027年を締めたあとに 2026年（締めていない）から変えると、2027年の割合も変わる
    expect(assetLockError(pc, { ...pc, rates: [{ from_year: 2026, rate: 80 }] }, [2027])).toMatch(/2027年は締め済み/);
    const changed = asset({ rates: [{ from_year: 2028, rate: 50 }] });
    expect(assetLockError(changed, { ...changed, business_rate: 70 }, [2028])).toBeNull();
  });
});

describe("売却・除却の仕訳", () => {
  // 車 180万円・6年・2025年4月から。2026年6月30日に売却・除却 → 2026年の期末の未償却残高（6月まで償却）1,424,250円
  const car = asset({ name: "営業車", account_id: 133, cost: 1_800_000, useful_life: 6, acquired_on: "2025-04-01", used_on: "2025-04-01", disposed_on: "2026-06-30" });
  const ids = { receive: 103, ownerLoan: 301, ownerDraw: 190, loss: 671 };
  const rows = (ls: ReturnType<typeof disposalLines>) => ls!.map((l) => [l.row_no, l.side, l.account_id, l.amount, l.tax_code, l.business_class ?? null]);
  test("売却：売却額を課税売上（第4種）、帳簿価額との差は事業主貸・事業主借（譲渡所得）", () => {
    expect(depreciationFor(car, 2026)!.closing).toBe(1_424_250);
    expect(rows(disposalLines({ ...car, disposal_kind: "sale", sale_price: 1_100_000 }, ids))).toEqual([
      [1, "debit", 103, 1_100_000, "none", null], [1, "credit", 133, 1_100_000, "sales10", 4],
      [2, "debit", 190, 324_250, "none", null], [2, "credit", 133, 324_250, "none", null],
    ]);
    expect(rows(disposalLines({ ...car, disposal_kind: "sale", sale_price: 1_600_000 }, ids)).slice(2)).toEqual([
      [2, "debit", 133, 175_750, "none", null], [2, "credit", 301, 175_750, "none", null],
    ]);
  });
  test("家事と兼用する資産：課税売上は事業用の部分だけ。除却損も事業用の部分だけ", () => {
    const shared = { ...car, business_rate: 60 };
    expect(rows(disposalLines({ ...shared, disposal_kind: "sale", sale_price: 1_100_000 }, ids)).slice(0, 3)).toEqual([
      [1, "debit", 103, 1_100_000, "none", null], [1, "credit", 133, 660_000, "sales10", 4], [1, "credit", 133, 440_000, "none", null],
    ]);
    expect(rows(disposalLines({ ...shared, disposal_kind: "scrap" }, ids))).toEqual([
      [1, "debit", 671, 854_550, "none", null], [1, "debit", 190, 569_700, "none", null], [1, "credit", 133, 1_424_250, "none", null],
    ]);
  });
  test("定額法でない資産・区分の無い資産は作らない", () => {
    expect(disposalLines({ ...car, method: "lump3", cost: 150_000, disposal_kind: "scrap" }, ids)).toBeNull();
    expect(disposalLines(car, ids)).toBeNull();
  });
});

describe("200%定率法（平成24年4月1日以後の取得）", () => {
  // 国税庁 No.2106 の例：取得価額100万円・耐用年数10年（償却率 0.200・改定償却率 0.250・保証率 0.06552）
  const machine = asset({ name: "機械", cost: 1_000_000, useful_life: 10, method: "declining", acquired_on: "2026-01-01", used_on: "2026-01-01" });
  test("償却保証額に満たなくなった年（7年目）から、改定取得価額 × 改定償却率。最後は 1円を残す", () => {
    expect(decliningRates(10)).toEqual({ rate: 200, revised: 250, guarantee: 6552 });
    const years = Array.from({ length: 11 }, (_, i) => 2026 + i);
    expect(years.map((y) => dep(machine, y))).toEqual([200_000, 160_000, 128_000, 102_400, 81_920, 65_536, 65_536, 65_536, 65_536, 65_535, 0]);
    const y7 = depreciationFor(machine, 2032)!;
    expect([y7.revised, y7.rate, y7.base, y7.opening]).toEqual([true, 0.25, 262_144, 262_144]);
    expect([depreciationFor(machine, 2031)!.revised, depreciationFor(machine, 2031)!.rate]).toEqual([false, 0.2]);
    // 年の途中から使ったら月割り（1円未満切り上げ）
    expect(dep({ ...machine, used_on: "2026-10-01", acquired_on: "2026-10-01" }, 2026)).toBe(50_000);
  });
  test("使えない資産：平成10年4月1日以後の建物、平成28年4月1日以後の建物附属設備・構築物、ソフトウェア", () => {
    expect(decliningProblem("130", "2026-01-01")).toMatch(/建物/);
    expect(decliningProblem("130", "1998-04-01")).toMatch(/平成10年4月1日以後/);
    expect(decliningProblem("130", "1998-03-31")).toBeNull();
    expect(decliningProblem("131", "2016-04-01")).toMatch(/建物附属設備/);
    expect(decliningProblem("131", "2016-03-31")).toBeNull();
    expect(decliningProblem("138", "2026-01-01")).toMatch(/ソフトウェア/);
    expect(decliningProblem("138", "2005-01-01")).toMatch(/ソフトウェア/);
    expect(validateAsset(machine, { ...blueOpts, accountCode: "130" })).toMatch(/建物/);
  });
});

describe("どの定率法かは取得日で決まる", () => {
  const m = (acquired_on: string, declining_250 = 0) => asset({ method: "declining", useful_life: 10, acquired_on, used_on: acquired_on, declining_250 });
  test("平成19年3月31日以前は旧定率法、平成24年3月31日までは250%、それより後は200%。平成24年4〜12月は 250% も選べる", () => {
    expect(["2007-03-31", "2007-04-01", "2012-03-31", "2012-04-01", "2013-01-01"].map((d) => decliningKind(m(d)))).toEqual(["old", "250", "250", "200", "200"]);
    expect([decliningKind(m("2012-04-01", 1)), decliningKind(m("2012-12-31", 1)), decliningKind(m("2013-01-01", 1))]).toEqual(["250", "250", "200"]);
    expect([m("2007-03-31"), m("2010-01-01"), m("2026-01-01")].map(methodLabel)).toEqual(["旧定率法", "定率法（250%）", "定率法（200%）"]);
    expect([m("2007-03-31"), m("2010-01-01"), asset({ acquired_on: "2007-03-31" })].map(statementMethod)).toEqual(["旧定率法", "定率法", "旧定額法"]);
    expect(validateAsset(m("2010-01-01"), blueOpts)).toBeNull();
  });
});

describe("旧定率法（平成19年3月31日以前の取得）", () => {
  test("償却率は別表第七の旧定率法の欄", () => {
    expect([2, 3, 5, 10, 19, 50, 51, 84, 85, 100].map(oldDecliningRateMil)).toEqual([684, 536, 369, 206, 114, 45, 44, 27, 26, 23]);
  });
  test("期首の未償却残高 × 償却率。95% に達した翌年から5年で1円まで均等償却（国税庁 No.2105 の例：500万円・5年・0.369）", () => {
    const a = asset({ cost: 5_000_000, useful_life: 5, method: "declining", acquired_on: "2001-01-10", used_on: "2001-01-10" });
    const years = Array.from({ length: 13 }, (_, i) => dep(a, 2001 + i));
    expect(years[0]).toBe(1_845_000);
    // 7年目は 95%（未償却残高 250,000円）ちょうどまで、8〜11年目は (250,000 − 1) ÷ 5、12年目は残り（1円を残す）
    expect(years.slice(6)).toEqual([65_606, 50_000, 50_000, 50_000, 50_000, 49_999, 0]);
    expect(depreciationFor(a, 2008)).toMatchObject({ equal: true, rate: 0.2, base: 250_000 });
    expect(depreciationFor(a, 2002)).toMatchObject({ equal: false, rate: 0.369, base: 3_155_000 });
    expect(depreciationFor(a, 2012)!.closing).toBe(1);
  });
});

describe("250%定率法（平成19年4月1日〜平成24年3月31日の取得）", () => {
  const machine = asset({ name: "機械", cost: 1_000_000, useful_life: 10, method: "declining", acquired_on: "2010-01-01", used_on: "2010-01-01" });
  test("償却率・改定償却率・保証率は別表第九。償却保証額に満たなくなった年から改定償却率", () => {
    expect(decliningRates(10, "250")).toEqual({ rate: 250, revised: 334, guarantee: 4448 });
    expect(decliningRates(3, "250")).toEqual({ rate: 833, revised: 1000, guarantee: 2789 });
    expect(decliningRates(91, "250")).toEqual({ rate: 27, revised: 27, guarantee: 649 });
    const years = Array.from({ length: 11 }, (_, i) => dep(machine, 2010 + i));
    // 7年目の調整前償却額 44,495 は償却保証額 44,480 以上。8年目（33,371）から 133,483 × 0.334
    expect(years).toEqual([250_000, 187_500, 140_625, 105_469, 79_102, 59_326, 44_495, 44_584, 44_584, 44_314, 0]);
    expect(depreciationFor(machine, 2017)).toMatchObject({ revised: true, rate: 0.334, base: 133_483 });
  });
});

describe("リース期間定額法", () => {
  const copier = asset({ name: "複合機", cost: 600_000, method: "lease", useful_life: 0, lease_months: 60, residual_value: 0, acquired_on: "2026-04-01", used_on: "2026-04-01" });
  test("（取得価額 − 残価保証額）× その年のリース期間の月数 ÷ リース期間の月数。0円まで（備忘価額を残さない）", () => {
    expect(Array.from({ length: 7 }, (_, i) => dep(copier, 2026 + i))).toEqual([90_000, 120_000, 120_000, 120_000, 120_000, 30_000, 0]);
    expect(depreciationFor(copier, 2026)).toMatchObject({ rate: null, base: 600_000, months: 9 });
    expect(depreciationFor(copier, 2031)).toMatchObject({ months: 3, closing: 0 });
    expect([methodLabel(copier), statementMethod(copier), lifeText(copier), statementLife(copier)]).toEqual(["リース期間定額法", "リース期間定額法", "60か月", null]);
  });
  test("残価保証額まで償却する。端数は累計で切り上げ、最後の年で合わせる。売却・除却した月まで", () => {
    const r = { ...copier, residual_value: 60_000 };
    expect(Array.from({ length: 6 }, (_, i) => dep(r, 2026 + i))).toEqual([81_000, 108_000, 108_000, 108_000, 108_000, 27_000]);
    expect(depreciationFor(r, 2031)!.closing).toBe(60_000);
    const odd = { ...copier, cost: 100_000, lease_months: 7, acquired_on: "2026-10-15", used_on: "2026-10-15" };
    expect([dep(odd, 2026), dep(odd, 2027)]).toEqual([42_858, 57_142]);
    expect(depreciationFor({ ...copier, disposed_on: "2027-06-30" }, 2027)).toMatchObject({ months: 6, depreciation: 60_000, closing: 450_000 });
  });
  test("確かめ：平成20年4月1日以後の契約、リース期間の月数、残価保証額", () => {
    expect(validateAsset(copier, blueOpts)).toBeNull();
    expect(validateAsset({ ...copier, acquired_on: "2008-03-31", used_on: "2008-03-31" }, blueOpts)).toMatch(/平成20年4月1日以後/);
    expect(validateAsset({ ...copier, lease_months: 0 }, blueOpts)).toMatch(/リース期間/);
    expect(validateAsset({ ...copier, residual_value: 600_000 }, blueOpts)).toMatch(/残価保証額/);
  });
});

describe("家事用から転用した資産", () => {
  // 国税庁 No.2109 の計算例：取得価額1,000万円・耐用年数22年、平成22年6月10日取得、令和5年4月1日から業務に使う
  const house = asset({ name: "貸家", cost: 10_000_000, useful_life: 22, acquired_on: "2010-06-10", used_on: "2023-04-01", converted: 1 });
  test("使っていなかった期間の減価の額：取得価額 × 0.9 × 旧定額法の償却率（耐用年数の1.5倍）× 年数（6か月以上は1年）", () => {
    expect(conversionOf(house)).toEqual({ months: 153, years: 13, life: 33, rate: 31, decline: 3_627_000, book: 6_373_000 });
    expect(depreciationFor(house, 2023)).toMatchObject({ opening: 6_373_000, depreciation: 345_000, closing: 6_028_000, rate: 0.046, base: 10_000_000 });
    // 6か月未満の端数は切り捨て
    expect(conversionOf({ ...house, used_on: "2011-12-09" }).years).toBe(1);
    expect(conversionOf({ ...house, used_on: "2011-12-10" }).years).toBe(2);
  });
  test("減価の額は取得価額の 95% まで。旧定額法の資産は、95% に達していれば転用した年から均等償却", () => {
    const old = asset({ cost: 1_000_000, useful_life: 2, acquired_on: "1995-01-01", used_on: "2006-01-01", converted: 1 });
    expect(conversionOf(old)).toMatchObject({ years: 11, decline: 950_000, book: 50_000 });
    expect(depreciationFor(old, 2006)).toMatchObject({ opening: 50_000, depreciation: 10_000, equal: true });
    // 転用したことを外せば、取得価額から
    expect(depreciationFor({ ...house, converted: 0 }, 2023)!.opening).toBe(10_000_000);
  });
  test("確かめ：定額法・定率法だけ。使い始めた日は取得日より後", () => {
    expect(validateAsset({ ...house, method: "lump3", cost: 150_000 }, blueOpts)).toMatch(/定額法・定率法/);
    expect(validateAsset({ ...house, used_on: house.acquired_on }, blueOpts)).toMatch(/取得日より後/);
    expect(statementMemo(house, depreciationFor(house, 2023)!, 2023)).toEqual(["業務転用"]);
    expect(statementMemo(house, depreciationFor(house, 2024)!, 2024)).toEqual([]);
  });
  test("締めた年に使っている資産は、転用・リース期間・残価保証額も変えられない（無い・0 は同じに見る）", () => {
    const closed = [2023];
    expect(assetLockError(house, { ...house, converted: 0 }, closed)).toMatch(/家事用からの転用/);
    const plain = asset({ used_on: "2023-01-01", acquired_on: "2023-01-01" });
    expect(assetLockError({ ...plain, converted: 0, declining_250: 0 }, { ...plain }, closed)).toBeNull();
  });
});

describe("繰延資産（開業費の任意償却）", () => {
  const cost = asset({ name: "開業費", account_id: 160, cost: 300_000, method: "deferred", useful_life: 0, acquired_on: "2026-04-01", used_on: "2026-04-01" });
  test("決めていない年は60か月の均等償却（月割り）。決めた年はその額。0円まで償却する", () => {
    expect([dep(cost, 2026), dep(cost, 2027)]).toEqual([45_000, 60_000]);
    const chosen = { ...cost, amortization: { 2026: 0, 2027: 500_000 } };
    expect([dep(chosen, 2026), dep(chosen, 2027), dep(chosen, 2028)]).toEqual([0, 300_000, 0]);
    expect(depreciationFor(chosen, 2027)!.closing).toBe(0);
    expect(validateAsset({ ...cost, amortization: { 2026: -1 } }, blueOpts)).toMatch(/0円以上/);
  });
});

test("中古資産の耐用年数（簡便法）：月数で計算し、1年未満切り捨て、2年未満は2年", () => {
  expect(usedAssetLife(30, 127)).toBe(21); // (360 − 127) + 127 × 20% = 258.4か月
  expect(usedAssetLife(6, 30)).toBe(4);
  expect(usedAssetLife(6, 72)).toBe(2); // 全部を経過：72 × 20% = 14.4か月 → 1年 → 2年
  expect(usedAssetLife(15, 0)).toBe(15);
});

describe("少額減価償却資産の年の上限と、貸付けの資産（措置法28条の2①・No.2100 注4）", () => {
  test("上限は 300万円。開業・廃業の年は業務を営んだ月数で割る（1か月に満たない端数は1か月）", () => {
    expect([smallYearLimit(), smallYearLimit(12), smallYearLimit(1), smallYearLimit(7), smallYearLimit(0)]).toEqual([3_000_000, 3_000_000, 250_000, 1_750_000, 250_000]);
  });
  test("事業的規模でない不動産の貸付けの資産で、令和4年4月1日以後に取得したものだけ", () => {
    const a = { income_kind: "realestate" as const, acquired_on: "2022-04-01" };
    expect([lendingRestricted(a, false), lendingRestricted(a, true), lendingRestricted({ ...a, acquired_on: "2022-03-31" }, false), lendingRestricted({ ...a, income_kind: "business" }, false)])
      .toEqual([true, false, false, false]);
  });
});
