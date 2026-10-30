/**
 * 青色申告決算書（一般用）の様式の行：1ページの損益計算書、4ページの貸借対照表と製造原価の計算
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import { autoLine, layoutSectionOf, lineOptions, manufacturingOn, purchaseAccountIds, statementLayout } from "./statementLines";
import { balanceSheetForm, circled, incomeStatementForm, manufacturingForm } from "./statementForm";
import { summarizeIncome } from "./accounting";

const seeds: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: s.hidden ? 0 : 1, is_system: 1, income_kind: s.income_kind ?? "business",
  default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
}));
const business = seeds.filter((a) => a.income_kind === "business");
const acc = (name: string) => seeds.find((a) => a.name === name)!;

describe("丸つき数字", () => {
  test("①〜⑳・㉑〜㉟・㊱〜㊿", () => {
    expect([1, 20, 21, 26, 35, 36, 43, 45, 50].map(circled).join("")).toBe("①⑳㉑㉖㉟㊱㊸㊺㊿");
  });
});

describe("製造原価の欄", () => {
  test("製造原価の初期科目は製造原価の欄（「（製造）」つきも）。仕入高・期末商品棚卸高は売上原価のまま", () => {
    expect(autoLine(acc("原材料仕入高"))).toBe("原材料仕入高");
    expect(autoLine(acc("外注工賃（製造）"))).toBe("外注工賃");
    expect(autoLine(acc("期末半製品・仕掛品棚卸高"))).toBe("期末半製品・仕掛品棚卸高");
    expect(layoutSectionOf(acc("労務費"))).toBe("mfg");
    expect(layoutSectionOf(acc("仕入高"))).toBe("cogs");
    expect(layoutSectionOf(acc("外注工賃"))).toBe("expense");
    // 売上原価の科目で選べる欄：売上原価の3つと製造原価の欄・製造原価の追加の欄
    expect(lineOptions("cogs").map(([, l]) => l)).toContain("製造原価：期末原材料棚卸高");
    expect(lineOptions("cogs").at(-1)?.[1]).toBe("製造原価：追加の欄（科目名で書く）");
    // 製造原価の追加の欄を選んだ売上原価の科目
    expect(layoutSectionOf({ ...acc("仕入高"), name: "包装材料費", code: "540", statement_line: "extra" })).toBe("mfg");
  });
  test("仕入金額に数える科目は、仕入高と原材料仕入高", () => {
    expect(purchaseAccountIds(seeds).map((id) => seeds.find((a) => a.id === id)!.name)).toEqual(["仕入高", "原材料仕入高"]);
  });
});

describe("1ページの損益計算書", () => {
  const amounts = new Map<string, number>([
    ["売上高", 10_000_000], ["雑収入", 50_000], ["期首商品棚卸高", 300_000], ["仕入高", 4_000_000], ["期末商品棚卸高", 400_000],
    ["租税公課", 100_000], ["通信費", 120_000], ["支払手数料", 30_000], ["雑費", 5_000], ["専従者給与", 1_200_000],
    ["貸倒引当金繰入", 55_000], ["貸倒引当金戻入", 40_000],
    // 製造原価
    ["期首原材料棚卸高", 200_000], ["原材料仕入高", 1_000_000], ["期末原材料棚卸高", 250_000], ["労務費", 600_000], ["電力費", 80_000],
    ["減価償却費（製造）", 70_000], ["期首半製品・仕掛品棚卸高", 50_000], ["期末半製品・仕掛品棚卸高", 30_000],
  ]);
  const amount = (a: Account) => amounts.get(a.name) ?? 0;
  const layout = statementLayout(business, amount);
  const pl = summarizeIncome(business, new Map(business.map((a) => [a.id, amount(a)])));

  test("製造原価の計算：㉖ 製品製造原価を1ページの ③ に足す", () => {
    const m = manufacturingForm(layout);
    const no = (n: number) => m.rows.find((r) => r.no === circled(n))!;
    expect([no(3).amount, no(5).amount, no(6).amount, no(11).amount, no(21).amount, no(22).amount, no(24).amount, no(26).amount])
      .toEqual([1_200_000, 950_000, 600_000, 70_000, 150_000, 1_700_000, 1_750_000, 1_720_000]);
    expect(no(12).label).toBe("");
    expect(m.cost).toBe(layout.manufacturing);
    expect(layout.hasManufacturing).toBe(true);
  });
  test("番号は様式どおり（経費 ⑧〜㉛・繰戻額等 ㉞・専従者給与 ㊳・所得 ㊸）。㊸ は帳簿の所得と同じ", () => {
    const f = incomeStatementForm(layout, pl.revenue, 650_000);
    const all = [...f.left, ...f.right];
    const no = (n: number) => all.find((r) => r.no === circled(n))!;
    expect(no(1).amount).toBe(10_050_000);
    expect(no(3).amount).toBe(4_000_000 + 1_720_000);
    expect(no(6).amount).toBe(300_000 + 5_720_000 - 400_000);
    expect([no(8).label, no(24).label, no(31).label]).toEqual(["租税公課", "貸倒金", "雑費"]);
    // 追加の欄：支払手数料が ㉕、使っていない ㉖〜㉚ は空欄
    expect([no(25).label, no(25).amount, no(30).label]).toEqual(["支払手数料", 30_000, ""]);
    expect([no(34).amount, no(38).amount, no(39).amount, no(37).amount, no(42).amount]).toEqual([40_000, 1_200_000, 55_000, 40_000, 1_255_000]);
    expect(f.beforeDeduction).toBe(pl.income);
    expect(no(45).amount).toBe(pl.income - 650_000);
  });
});

describe("4ページの貸借対照表", () => {
  test("追加の欄は資産は土地のあと・負債は預り金のあと。事業主貸・事業主借は期末だけ。合計が合う", () => {
    const extra = { ...acc("敷金") };
    const amounts = new Map<string, number>([["現金", 100_000], ["普通預金", 900_000], ["敷金", 200_000], ["事業主貸", 300_000], ["未払金", 50_000], ["事業主借", 20_000], ["元入金", 1_000_000]]);
    const opening = new Map<string, number>([["現金", 100_000], ["普通預金", 700_000], ["敷金", 200_000], ["元入金", 1_000_000]]);
    const layout = statementLayout(seeds, (a) => amounts.get(a.name) ?? 0, (a) => opening.get(a.name) ?? 0);
    const f = balanceSheetForm(layout, 430_000);
    const labels = f.assets.map((r) => r.label);
    expect(labels.indexOf(extra.name)).toBe(labels.indexOf("土地") + 1);
    expect(f.assets.find((r) => r.label === "その他の預金")).toMatchObject({ opening: 700_000, closing: 900_000 });
    expect(f.assets.find((r) => r.label === "事業主貸")).toMatchObject({ opening: null, closing: 300_000 });
    expect(f.assets.at(-1)).toMatchObject({ label: "合計", opening: 1_000_000, closing: 1_500_000 });
    expect(f.liabilities.map((r) => r.label).slice(-5)).toEqual(["貸倒引当金", "事業主借", "元入金", "青色申告特別控除前の所得金額", "合計"]);
    expect(f.liabilities.at(-1)).toMatchObject({ opening: 1_000_000, closing: 1_500_000 });
  });
});

describe("製造原価を使う・使わない", () => {
  test("製造原価の初期科目のどれかを表示していれば使っている。使っていなければ売上原価の科目に製造原価の欄を出さない", () => {
    expect(manufacturingOn(seeds)).toBe(false);
    expect(manufacturingOn(seeds.map((a) => (a.code === "523" ? { ...a, is_active: 1 } : a)))).toBe(true);
    expect(lineOptions("cogs", false).map(([v]) => v)).toEqual(["期首商品（製品）棚卸高", "仕入金額（製品製造原価）", "期末商品（製品）棚卸高"]);
    expect(lineOptions("cogs").length).toBe(3 + 12 + 1);
  });
});
