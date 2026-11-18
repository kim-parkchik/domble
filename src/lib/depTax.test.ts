import { describe, expect, test } from "bun:test";
import {
  assessmentDate, defaultDepTax, depTaxCsvRows, depTaxPrintSections, depTaxRateMil, depTaxReport, depTaxValue, depTaxYearLabel, heldOn, parseDepTaxSetting, resolveDepTax,
  warekiMonth, type DepTaxSetting,
} from "./depTax";
import type { FixedAsset } from "./depreciation";

const asset = (p: Partial<FixedAsset>): FixedAsset => ({
  id: 1, name: "パソコン", account_id: 134, acquired_on: "2026-04-10", used_on: "2026-04-10", cost: 240_000, method: "straight",
  useful_life: 4, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", ...p,
});
// 科目 id → コード（テストでは id をそのままコードの番号にする）
const codeOf = (id: number) => String(id);
const nameOf = (id: number) => ({ 131: "建物附属設備", 132: "機械装置", 133: "車両運搬具", 134: "工具器具備品", 136: "構築物", 137: "一括償却資産", 138: "ソフトウェア", 130: "建物" })[id] ?? "その他";
const report = (assets: FixedAsset[], year: number, settings: [number, DepTaxSetting][] = []) => depTaxReport(assets, year, codeOf, nameOf, new Map(settings));

describe("評価額（固定資産評価基準）", () => {
  test("減価率は耐用年数に応ずる減価率表（旧定率法の償却率と同じ）", () => {
    expect([2, 3, 4, 5, 6, 8, 10, 15, 20, 50].map(depTaxRateMil)).toEqual([684, 536, 438, 369, 319, 250, 206, 142, 109, 45]);
  });

  test("前年中の取得は 1 − r/2、前年前は前年度の評価額 × (1 − r)。1円未満は切り捨て、取得価額の 5% が最低限度（宝塚市の手引きの例）", () => {
    // 令和7年5月取得・50万円・耐用年数3年：令和8年度 366,000 → 169,824 → 78,798 → 36,562 → 令和12年度以降は 25,000（5%）
    expect([2026, 2027, 2028, 2029, 2030, 2031].map((y) => depTaxValue(500_000, 3, "2025-05-10", y).value)).toEqual([366_000, 169_824, 78_798, 36_562, 25_000, 25_000]);
    expect(depTaxValue(500_000, 3, "2025-05-10", 2026)).toMatchObject({ residual: "0.732", first: true });
    expect(depTaxValue(500_000, 3, "2025-05-10", 2027)).toMatchObject({ residual: "0.464", first: false });
    // 1 − r/2 は割り切れないときも、そのままの値（5年：0.8155）で計算する
    expect(depTaxValue(300_000, 5, "2026-06-01", 2027)).toEqual({ value: 244_650, residual: "0.8155", first: true });
    // 1月1日に取得したものは、その日が最初の賦課期日
    expect(depTaxValue(100_000, 4, "2027-01-01", 2027).value).toBe(78_100);
    expect(depTaxValue(100_000, 4, "2027-01-02", 2027).value).toBe(0);
  });

  test("賦課期日と年度。1月1日に持っているか（その日に売却したものは持っていたもの）", () => {
    expect(assessmentDate(2026)).toBe("2027-01-01");
    expect(depTaxYearLabel(2026)).toBe("令和9年度");
    expect(heldOn({ acquired_on: "2026-05-01", disposed_on: null }, "2027-01-01")).toBe(true);
    expect(heldOn({ acquired_on: "2026-05-01", disposed_on: "2026-12-31" }, "2027-01-01")).toBe(false);
    expect(heldOn({ acquired_on: "2026-05-01", disposed_on: "2027-01-01" }, "2027-01-01")).toBe(true);
    expect(warekiMonth("2026-05-10")).toBe("令和8年5月");
    expect(warekiMonth("2019-04-30")).toBe("平成31年4月");
    expect(warekiMonth("2019-05-01")).toBe("令和元年5月");
  });
});

describe("種類と対象外", () => {
  test("科目と償却方法から初期値を決める", () => {
    const a = (p: Partial<FixedAsset>) => asset(p);
    expect(defaultDepTax(a({}), "134")).toEqual({ kind: 6 });
    expect(defaultDepTax(a({}), "136")).toEqual({ kind: 1 });
    expect(defaultDepTax(a({}), "132")).toEqual({ kind: 2 });
    expect(defaultDepTax(a({}), "131")).toEqual({ kind: 1 });
    expect(defaultDepTax(a({ income_kind: "realestate" }), "131")).toEqual({ exclusion: "house" });
    expect(defaultDepTax(a({}), "130")).toEqual({ exclusion: "house" });
    expect(defaultDepTax(a({}), "133")).toEqual({ exclusion: "vehicle" });
    expect(defaultDepTax(a({}), "138")).toEqual({ exclusion: "intangible" });
    expect(defaultDepTax(a({ method: "lump3" }), "134")).toEqual({ exclusion: "lump3" });
    expect(defaultDepTax(a({ method: "lease" }), "134")).toEqual({ exclusion: "lease" });
    expect(defaultDepTax(a({ method: "deferred" }), "150")).toEqual({ exclusion: "deferred" });
    // 少額減価償却資産は対象。10万円未満は必要経費にしたものとして対象外
    expect(defaultDepTax(a({ method: "small", cost: 280_000 }), "134")).toEqual({ kind: 6 });
    expect(defaultDepTax(a({ method: "small", cost: 99_000 }), "134")).toEqual({ exclusion: "under" });
    expect(defaultDepTax(a({}), "139")).toEqual({ kind: 6, guessed: true });
  });

  test("資産ごとに種類・対象外を選べる。一括償却資産・リース・繰延資産・10万円未満は変えられない", () => {
    expect(resolveDepTax({ exclusion: "vehicle" }, { kind: 5 })).toEqual({ kind: 5 });
    expect(resolveDepTax({ kind: 1 }, { kind: 0 })).toEqual({ exclusion: "user" });
    expect(resolveDepTax({ kind: 6 }, {})).toEqual({ kind: 6 });
    expect(resolveDepTax({ exclusion: "lump3" }, { kind: 6 })).toEqual({ exclusion: "lump3" });
    expect(parseDepTaxSetting('{"kind":5,"life":4}')).toEqual({ kind: 5, life: 4 });
    expect(parseDepTaxSetting('{"kind":9,"life":1}')).toEqual({});
    expect(parseDepTaxSetting("壊れた")).toEqual({});
  });
});

describe("申告書と種類別明細書の数字", () => {
  const pc = asset({ id: 1, name: "パソコン", acquired_on: "2024-03-01", used_on: "2024-03-01", cost: 240_000, useful_life: 4 });
  const desk = asset({ id: 2, name: "机", acquired_on: "2026-07-01", used_on: "2026-07-01", cost: 180_000, method: "small", useful_life: 0 });
  const sign = asset({ id: 3, name: "看板", account_id: 136, acquired_on: "2025-02-01", used_on: "2025-02-01", cost: 400_000, useful_life: 10, disposed_on: "2026-09-30", disposal_kind: "scrap" });
  const car = asset({ id: 4, name: "営業車", account_id: 133, acquired_on: "2025-01-15", cost: 2_000_000, useful_life: 6 });
  const lump = asset({ id: 5, name: "椅子", acquired_on: "2026-02-01", cost: 150_000, method: "lump3" });
  const interior = asset({ id: 6, name: "内装", account_id: 131, acquired_on: "2026-10-01", cost: 1_000_000, useful_life: 15 });
  const old = asset({ id: 7, name: "前の年に売った機械", account_id: 132, acquired_on: "2020-01-10", cost: 500_000, useful_life: 10, disposed_on: "2025-06-30", disposal_kind: "sale" });
  const all = [pc, desk, sign, car, lump, interior, old];

  test("2026年の画面は令和9年度（2027年1月1日現在）。前年前・前年中の取得、前年中の減少、対象外を分ける", () => {
    const r = report(all, 2026, [[2, { life: 8 }]]);
    expect(r.label).toBe("令和9年度");
    expect(r.held.map((x) => [x.asset.name, x.status, x.kind])).toEqual([["内装", "new", 1], ["パソコン", "old", 6], ["机", "new", 6]]);
    expect(r.added.map((x) => x.asset.name)).toEqual(["内装", "机"]);
    expect(r.decreased.map((x) => [x.asset.name, x.memo])).toEqual([["看板", "滅失（除却）（2026/09/30）"]]);
    expect(r.excluded.map((x) => [x.asset.name, x.exclusion])).toEqual([["営業車", "vehicle"], ["椅子", "lump3"]]);
    // パソコン：2024年3月取得・4年 → 令和7年度 187,440 → 令和8年度 105,341 → 令和9年度 59,201
    expect(r.held.find((x) => x.asset.id === 1)).toMatchObject({ value: 59_201, residual: "0.562" });
    // 机（少額減価償却資産・耐用年数8年）：180,000 × (1 − 0.25/2) = 157,500
    expect(r.held.find((x) => x.asset.id === 2)).toMatchObject({ value: 157_500, residual: "0.875", life: 8, ledgerLife: false });
    // 内装（建物附属設備・15年）：1,000,000 × (1 − 0.142/2) = 929,000
    expect(r.held.find((x) => x.asset.id === 6)?.value).toBe(929_000);
    // 申告書：構築物 イ 400,000（看板）ロ 400,000 ハ 1,000,000 ニ 1,000,000。工具器具備品 イ 240,000 ハ 180,000 ニ 420,000
    expect(r.summary.find((s) => s.kind === 1)).toEqual({ kind: 1, before: 400_000, decreased: 400_000, added: 1_000_000, total: 1_000_000, value: 929_000 });
    expect(r.summary.find((s) => s.kind === 6)).toEqual({ kind: 6, before: 240_000, decreased: 0, added: 180_000, total: 420_000, value: 216_701 });
    expect(r.sum).toEqual({ before: 640_000, decreased: 400_000, added: 1_180_000, total: 1_420_000, value: 1_145_701 });
    // 課税標準額 1,145,000 は免税点（150万円）未満
    expect(r).toMatchObject({ standard: 1_145_000, exempt: true, tax: 0 });
    // 確かめること：建物附属設備は選んでもらう、車両は対象外にしたことを知らせる、免税点
    expect(r.issues.map((i) => i.level)).toEqual(["warn", "info", "info"]);
    expect(r.issues[0].text).toContain("建物附属設備の「内装」");
    expect(r.issues[1].text).toContain("車両運搬具の「営業車」");
    expect(r.issues[2].text).toContain("免税点");
  });

  test("耐用年数の無い少額減価償却資産は評価額を出さずに知らせる。選んだ種類はそのまま（確かめる知らせを出さない）", () => {
    const r = report(all, 2026, [[6, { kind: 1 }], [4, { kind: 5 }]]);
    expect(r.held.find((x) => x.asset.id === 2)).toMatchObject({ life: null, value: null });
    const texts = r.issues.map((i) => i.text);
    expect(r.issues[0].level).toBe("error");
    expect(texts[0]).toContain("「机」の耐用年数を入れてください");
    expect(texts.some((t) => t.includes("建物附属設備"))).toBe(false);
    // 車両及び運搬具を選んだ営業車（2025年1月取得・6年）：2,000,000 × 0.8405 = 1,681,000 → × 0.681 = 1,144,761
    expect(r.held.find((x) => x.asset.id === 4)).toMatchObject({ kind: 5, value: 1_144_761, residual: "0.681" });
    expect(r.summary.find((s) => s.kind === 5)).toMatchObject({ before: 2_000_000, added: 0, total: 2_000_000 });
  });

  test("課税標準額が150万円以上なら固定資産税の見込み（1.4%）。兼用の資産は全額で載せて知らせる", () => {
    const machine = asset({ id: 8, name: "工作機械", account_id: 132, acquired_on: "2026-03-01", cost: 3_000_000, useful_life: 10, business_rate: 80 });
    const r = report([machine], 2026);
    // 3,000,000 × (1 − 0.206/2) = 2,691,000 → 課税標準額 2,691,000、税額 2,691,000 × 1.4% = 37,674 → 37,600
    expect(r).toMatchObject({ standard: 2_691_000, exempt: false, tax: 37_600 });
    expect(r.held[0].mixed).toBe(true);
    expect(r.issues.map((i) => i.text).join()).toContain("事業と家事で兼用している「工作機械」は、取得価額の全額で載せています");
  });

  test("印刷：申告書に書く数字・種類別明細書（全資産用・増加資産用・減少資産用）・対象外。CSV は明細書ごとの行", () => {
    const r = report(all, 2026, [[2, { life: 8 }]]);
    const sections = depTaxPrintSections(r);
    expect(sections.map((x) => x.heading)).toEqual([
      "申告書に書く数字（取得価額・令和9年度）", "種類別明細書（全資産用）", "種類別明細書（増加資産用）", "種類別明細書（減少資産用）", "申告の対象外にした資産",
    ]);
    const cells = (i: number) => sections[i].groups.map((g) => g.rows.map((row) => row.cells.map((c) => (typeof c === "string" ? c : c.text))));
    expect(cells(0)[0][6]).toEqual(["合計", "640,000", "400,000", "1,180,000", "1,420,000", "1,145,701"]);
    expect(cells(0)[1][0][0]).toBe("課税標準額（見込み）：1,145,000 円　免税点（150万円）未満のため課税されません（申告は要ります）");
    expect(cells(1)[1][0]).toEqual(["6 工具、器具及び備品", "パソコン", "1", "令和6年3月", "240,000", "4年", "0.562", "59,201", ""]);
    expect(cells(3)[0][0]).toEqual(["1 構築物", "看板", "1", "令和7年2月", "400,000", "10年", "全部・滅失（除却）（2026/09/30）"]);
    expect(cells(4).map((g) => g[0][3])).toEqual(["自動車税・軽自動車税の対象", "一括償却資産"]);
    const csv = depTaxCsvRows(r);
    expect(csv.map((x) => x[0])).toEqual(["全資産用", "全資産用", "全資産用", "増加資産用", "増加資産用", "減少資産用", "対象外", "対象外"]);
    expect(csv[2]).toEqual(["全資産用", 6, "工具、器具及び備品", "机", "工具器具備品", 1, "令和8年7月", "2026-07-01", 180_000, 8, "0.875", 157_500, ""]);
  });

  test("1月1日にまだ持っていない資産・前の年までに手放した資産は出さない", () => {
    const later = asset({ id: 9, name: "来年の資産", acquired_on: "2027-03-01" });
    const r = report([later, asset({ id: 10, disposed_on: "2025-05-01", acquired_on: "2024-01-01" })], 2026);
    expect([...r.held, ...r.decreased, ...r.excluded]).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});
