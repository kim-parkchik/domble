/**
 * 総合課税の譲渡所得・一時所得・損益の通算（lib/transfers.ts）と、所得税の計算へのつながり・配当控除（lib/incomeTax.ts）
 */
import { describe, expect, test } from "bun:test";
import { assetSalesOf, emptyTransfer, occasionalResult, offsetIncomes, termOf, transferResult, transfersOf, type AssetSale, type Transfer } from "./transfers";
import type { FixedAsset } from "./depreciation";
import { computeIncomeTax, dividendCredit, EMPTY_INCOME_TAX_INPUT, type BusinessFigures } from "./incomeTax";

const asset = (p: Partial<FixedAsset>): FixedAsset => ({
  id: 1, name: "営業車", account_id: 10, acquired_on: "2021-01-10", used_on: "2021-01-10", cost: 2_400_000, method: "straight",
  useful_life: 6, business_rate: 70, opening_year: null, opening_book_value: null, disposed_on: "2026-06-30", disposal_kind: "sale", sale_price: 1_100_000, memo: "", ...p,
});
const kindOf = () => "車両運搬具";
const tr = (p: Partial<Transfer>): Transfer => ({ ...emptyTransfer(), cost: 0, term: "short", gain: 0, ...p } as Transfer);

describe("総合課税の譲渡所得", () => {
  test("持っていた期間：取得の日から5年ちょうどまでは短期、それを超えれば長期", () => {
    expect(termOf("2020-04-01", "2025-04-01")).toBe("short");
    expect(termOf("2020-04-01", "2025-04-02")).toBe("long");
    expect(termOf("", "2025-04-02")).toBeNull();
  });

  test("台帳で売却した資産：事業用の部分だけ。帳簿価額は売った月までの償却の後。税抜経理なら税抜", () => {
    // 定額法 6年（償却率 0.167）：年 400,800円 × 5年 ＋ 6か月 200,400円 → 期末の未償却残高 195,600円
    const { sales, lump } = assetSalesOf([asset({}), asset({ id: 2, name: "棚", method: "lump3", cost: 150_000 })], 2026, kindOf, () => false);
    expect(lump).toEqual(["棚"]);
    expect(sales).toEqual([{
      assetId: 1, name: "営業車", kind: "車両運搬具", acquired: "2021-01-10", sold: "2026-06-30", rate: 70,
      salePrice: 1_100_000, price: 770_000, acquisitionCost: 1_680_000, bookValue: 195_600, cost: 136_920, realEstate: false,
    }]);
    expect(assetSalesOf([asset({})], 2026, kindOf, () => true).sales[0].price).toBe(700_000);
    // 売った年でなければ出さない。除却は譲渡ではない
    expect(assetSalesOf([asset({})], 2025, kindOf, () => false).sales).toEqual([]);
    expect(assetSalesOf([asset({ disposal_kind: "scrap" })], 2026, kindOf, () => false).sales).toEqual([]);
  });

  test("入力の行（譲渡費用・取得費の直し）と台帳の売却を合わせ、5年を超えるので長期。特別控除 50万円のあと", () => {
    const { sales } = assetSalesOf([asset({})], 2026, kindOf, () => false);
    const ts = transfersOf([{ ...emptyTransfer(), assetId: 1, expenses: 33_080, buyer: "中古車店" }, { ...emptyTransfer(), assetId: 9 }], sales);
    expect(ts.map((t) => [t.name, t.term, t.price, t.cost, t.expenses, t.gain, t.buyer])).toEqual([["営業車", "long", 770_000, 136_920, 33_080, 600_000, "中古車店"]]);
    expect(transferResult(ts)).toMatchObject({ a: 0, b: 100_000, special: { short: 0, long: 500_000 }, businessLoss: 0 });
  });

  test("特別控除は短期から。短期の損失は長期の益から差し引く（内部通算）", () => {
    expect(transferResult([tr({ gain: 300_000 }), tr({ term: "long", gain: 400_000 })])).toMatchObject({ a: 0, b: 200_000, special: { short: 300_000, long: 200_000 } });
    expect(transferResult([tr({ gain: -100_000 }), tr({ term: "long", gain: 700_000 })])).toMatchObject({ a: 0, b: 100_000, special: { short: 0, long: 500_000 } });
    expect(transferResult([tr({ gain: 800_000 })])).toMatchObject({ a: 300_000, b: 0 });
  });

  test("全体が損失：生活に通常必要でない資産の損失は無いものとする。事業税の損失は事業用の資産ごとの損失の合計", () => {
    const sale = { realEstate: false } as AssetSale;
    const r = transferResult([tr({ gain: -200_000, sale }), tr({ term: "long", gain: -300_000, luxury: true })]);
    expect(r).toMatchObject({ a: -200_000, b: 0, ignored: 300_000, businessLoss: 200_000 });
    // ゴルフ会員権の損失は、車の益とは差し引ける
    expect(transferResult([tr({ gain: 600_000, sale }), tr({ gain: -100_000, luxury: true })])).toMatchObject({ a: 0, b: 0, special: { short: 500_000 } });
  });
});

describe("一時所得と損益の通算", () => {
  test("一時所得：収入 − 支出 − 特別控除（50万円まで）。損失は 0（確定申告の手引きの例）", () => {
    expect(occasionalResult([{ item: "生命保険の満期金", payer: "", payerId: "", income: 2_500_000, expenses: 1_640_000, withheld: 0 }]))
      .toEqual({ income: 2_500_000, costs: 1_640_000, gain: 860_000, special: 500_000, amount: 360_000 });
    expect(occasionalResult([{ item: "", payer: "", payerId: "", income: 100_000, expenses: 300_000, withheld: 0 }]).amount).toBe(0);
  });

  test("経常所得の損失 → 短期 → 長期 → 一時。譲渡の損失 → 一時 → 経常所得。長期と一時は通算のあとで 1/2", () => {
    expect(offsetIncomes(-1_000_000, 300_000, 400_000, 200_000)).toMatchObject({ ordinary: -100_000, short: 0, long: 0, occasional: 0, r11: 0, total: -100_000 });
    expect(offsetIncomes(2_000_000, -500_000, 0, 300_000)).toMatchObject({ ordinary: 1_800_000, transferLoss: 0, occasional: 0, total: 1_800_000 });
    expect(offsetIncomes(3_000_000, 0, 133_080, 360_000)).toMatchObject({ r11: 246_540, total: 3_246_540 });
    expect(offsetIncomes(-300_000, -200_000, 0, 0)).toMatchObject({ ordinary: -300_000, transferLoss: -200_000, total: -500_000 });
  });
});

describe("所得税の計算", () => {
  const biz: BusinessFigures = { revenue: 8_000_000, incomeBeforeBlue: 3_650_000, filingType: "blue65", familySalary: 0 };
  const row = (r: ReturnType<typeof computeIncomeTax>, no: string) => r.rows.find((x) => x.no === no)?.value;

  test("台帳の売却と一時所得：㋘㋙㋚ と ⑪、第二表の「総合課税の譲渡所得、一時所得に関する事項」、源泉徴収", () => {
    const { sales } = assetSalesOf([asset({})], 2026, kindOf, () => false);
    const r = computeIncomeTax({
      ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-01-01",
      occasional: [{ item: "生命保険の満期金", payer: "A生命", payerId: "東京都", income: 2_500_000, expenses: 1_640_000, withheld: 0 }],
    }, { ...biz, assetSales: sales }, 2026);
    // 譲渡：770,000 − 136,920 = 633,080（長期）− 特別控除 500,000 = 133,080。一時：360,000。⑪ = (133,080 + 360,000) / 2
    expect([row(r, "㋘"), row(r, "㋙"), row(r, "㋚"), row(r, "⑪"), row(r, "⑫")]).toEqual([0, 133_080, 360_000, 246_540, 3_246_540]);
    expect(r.second.transfers).toEqual([
      { kind: "譲渡（長期）", income: 770_000, costs: 136_920, gain: 633_080 },
      { kind: "一時", income: 2_500_000, costs: 1_640_000, gain: 860_000 },
    ]);
    expect(r.second.withholding).toEqual([]);
  });

  test("事業の赤字と譲渡益：損益の通算のあとの ⑪・⑫。純損失は青色なら繰り越す", () => {
    const { sales } = assetSalesOf([asset({})], 2026, kindOf, () => false);
    const r = computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-01-01" }, { ...biz, incomeBeforeBlue: -400_000, assetSales: sales }, 2026);
    // ① −400,000（青色申告特別控除は 0）、長期譲渡 133,080 → 通算で ⑪ 0、⑫ −266,920
    expect([row(r, "①"), row(r, "⑪")]).toEqual([-400_000, 0]);
    expect(r.totalIncome).toBe(-266_920);
    expect(r.loss.blueLoss).toBe(266_920);
    expect(r.notes.join()).toMatch(/損益の通算/);
  });

  test("配当：⑤ は負債の利子を差し引き、配当控除（1,000万円以下は 10%・5%）。源泉徴収税額と住民税の配当割額", () => {
    const r = computeIncomeTax({
      ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-01-01",
      dividends: [
        { item: "株式の配当", payer: "B証券", payerId: "東京都", income: 200_000, withheld: 30_630, listed: true, localWithheld: 10_000, interest: 20_000, credit: "stock" },
        { item: "投資信託の分配", payer: "B証券", payerId: "東京都", income: 100_000, withheld: 15_315, listed: true, localWithheld: 5_000, interest: 0, credit: "fund" },
      ],
    }, biz, 2026);
    expect([row(r, "㋓"), row(r, "⑤")]).toEqual([300_000, 280_000]);
    expect(r.dividend).toEqual({ income: 300_000, amount: 280_000, credit: 180_000 * 0.1 + 100_000 * 0.05, local: 15_000 });
    expect(r.rows.find((x) => x.key === "dividendCredit")).toMatchObject({ no: "㉝", value: 23_000 });
    expect(r.second.withholding.map((w) => [w.kind, w.withheld])).toEqual([["配当", 30_630], ["配当", 15_315]]);
  });

  test("足したまま何も入れていない行は無いものとする（第一表・第二表に出さない）", () => {
    const r = computeIncomeTax({
      ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-01-01",
      dividends: [{ item: "", payer: "", payerId: "", income: 0, withheld: 0, listed: true, localWithheld: 0, interest: 0, credit: "stock" }],
      transfers: [emptyTransfer()], occasional: [{ item: "", payer: "", payerId: "", income: 0, expenses: 0, withheld: 0 }],
    }, biz, 2026);
    expect(r.rows.filter((x) => ["㋓", "㋘", "㋙", "㋚", "⑤", "⑪"].includes(x.no))).toEqual([]);
    expect(r.second.transfers).toEqual([]);
    expect(r.notes.join()).not.toMatch(/取得日か譲渡日/);
  });

  test("配当控除：1,000万円を超える部分は半分の率。証券投資信託を上の段に当てる", () => {
    expect(dividendCredit({ stock: 1_000_000, fund: 0, foreign: 0 }, 5_000_000)).toBe(100_000);
    expect(dividendCredit({ stock: 1_000_000, fund: 0, foreign: 0 }, 10_500_000)).toBe(75_000);
    expect(dividendCredit({ stock: 1_000_000, fund: 300_000, foreign: 0 }, 10_200_000)).toBe(110_000);
  });
});
