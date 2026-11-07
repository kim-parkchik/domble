/**
 * 分野 F・例7（2026-11-04 に足した）：事業所得と不動産所得（事業的規模でない）の両方がある人（令和7年分・青色65万円・消費税は免税）
 * 何を確かめるか：
 *  - 1つの帳簿で、不動産所得の科目（賃貸料・礼金・〜（不動産））と事業所得の科目を分ける
 *  - 貸家の減価償却（木造22年・定額法 0.046・2020年1月取得）を固定資産台帳から減価償却費（不動産）に
 *  - 青色申告特別控除は不動産所得、事業所得の順（措法25の2③。国税庁 No.2072）：不動産 110,000円 → 事業 540,000円
 *  - 決算書（一般用）2ページの ⑥〜⑨、不動産所得用の決算書、所得税の ㋐㋒①③・(59)・第二表の「不動産所得から差し引いた青色申告特別控除額」
 *  - e-Tax のデータ（KOA020・KOA210・KOA220）が XSD に合うか
 *  - 別の人：事業所得が無く事業的規模でない貸付けだけ → 控除は 10万円まで
 *  - 不動産所得の赤字のうち、土地等を取得するための負債の利子までは損益通算しない（措法41の4）
 * 動かし方：bun s8_realestate.ts
 */
import { makeDb, makeBook, cashEntry, yearFigures, incomeTaxScreen, incomeXtxScreen, setFiler, xtxVal, cmp, printTable, repo, YEAR, type Cmp } from "./common";
import { computeIncomeTax, EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";
import { depreciationLines, depreciationFor } from "../../../src/lib/depreciation";

const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** 貸家を持つ人の帳簿を作る（withBusiness = 事業所得もある） */
const setup = async (withBusiness: boolean) => {
  const { db } = makeDb("strict");
  await repo.saveRealEstate(db, "small");
  const b = await makeBook(db);
  await b.reload();
  const rates = await repo.getHomeUseRates(db, YEAR);
  const TEN = await b.cp("入居者 佐藤");
  await repo.saveOpening(db, YEAR, { [`${b.acc("普通預金")}:0`]: 2_000_000, [`${b.acc("建物")}:0`]: 15_400_000, [`${b.acc("元入金")}:0`]: 17_400_000 });
  for (let m = 1; m <= 12; m++) await cashEntry(db, b, rates, { date: M(m, 27), book: "普通預金", counter: "賃貸料", dir: "in", amount: 100_000, memo: `家賃 ${m}月`, cp: TEN, tax: "sales_nontax" });
  await cashEntry(db, b, rates, { date: M(4, 1), book: "普通預金", counter: "礼金・権利金・更新料", dir: "in", amount: 100_000, memo: "更新料", cp: TEN, tax: "sales_nontax" });
  await cashEntry(db, b, rates, { date: M(6, 30), book: "普通預金", counter: "租税公課（不動産）", dir: "out", amount: 80_000, memo: "固定資産税" });
  await cashEntry(db, b, rates, { date: M(3, 1), book: "普通預金", counter: "損害保険料（不動産）", dir: "out", amount: 20_000, memo: "火災保険" });
  await cashEntry(db, b, rates, { date: M(9, 1), book: "普通預金", counter: "修繕費（不動産）", dir: "out", amount: 50_000, memo: "給湯器の修理" });
  await cashEntry(db, b, rates, { date: M(12, 25), book: "普通預金", counter: "借入金利子（不動産）", dir: "out", amount: 120_000, memo: "ローン利子" });
  if (withBusiness) {
    await cashEntry(db, b, rates, { date: M(6, 30), book: "普通預金", counter: "売上高", dir: "in", amount: 3_300_000, memo: "デザイン料", tax: "none" });
    await cashEntry(db, b, rates, { date: M(6, 30), book: "普通預金", counter: "外注工賃", dir: "out", amount: 800_000, memo: "外注", tax: "none" });
  }
  await repo.saveAsset(db, null, {
    name: "貸家（木造）", account_id: b.acc("建物"), acquired_on: "2020-01-10", used_on: "2020-01-10", cost: 20_000_000, method: "straight", useful_life: 22, business_rate: 100,
    opening_year: null, opening_book_value: null, disposed_on: null, memo: "", income_kind: "realestate",
  } as never);
  // 固定資産台帳の「年末の仕訳を作る」（FixedAssetsPage と同じ：不動産所得の資産は減価償却費（不動産）へ）
  const assets = await repo.getAssets(db);
  await repo.saveDepreciationRun(db, YEAR, depreciationLines(assets, YEAR, { expense: b.acc("減価償却費"), draw: b.acc("事業主貸"), expenseRealEstate: b.acc("減価償却費（不動産）") }));
  return { db, b, assets };
};

const rows: Cmp[] = [];
const input: IncomeTaxInput = { ...EMPTY_INCOME_TAX_INPUT, outside: "none", birthday: "1975-05-05", socialInsurance: [{ kind: "国民健康保険", amount: 300_000 }], residentTax: "self" };

// ── 事業所得と不動産所得の両方 ──
{
  const { db, b, assets } = await setup(true);
  const dep = depreciationFor(assets[0], YEAR)!;
  cmp(rows, "減価償却：貸家 期首の未償却残高（2020〜2024年 920,000 × 5 年）", 15_400_000, dep.opening);
  cmp(rows, "減価償却：貸家 本年分（20,000,000 × 0.046）", 920_000, dep.depreciation);
  const f = await yearFigures(db, b);
  cmp(rows, "減価償却費（不動産）の残高", 920_000, f.bal("減価償却費（不動産）"));
  const it = await incomeTaxScreen(db, b, input);
  cmp(rows, "不動産所得：収入金額 ㋒（賃貸料 1,200,000 ＋ 更新料 100,000）", 1_300_000, it.v("㋒"));
  cmp(rows, "不動産所得：特別控除前（1,300,000 − 1,190,000）", 110_000, it.biz.realEstate?.incomeBeforeBlue ?? null);
  cmp(rows, "事業所得：収入金額 ㋐（不動産の収入を含まない）", 3_300_000, it.v("㋐"));
  cmp(rows, "事業所得：特別控除前", 2_500_000, it.biz.incomeBeforeBlue);
  cmp(rows, "不動産所得 ③（110,000 − 110,000）", 0, it.v("③"));
  cmp(rows, "事業所得 ①（2,500,000 − 540,000）", 1_960_000, it.v("①"));
  cmp(rows, "第一表 青色申告特別控除額の合計 (59)", 650_000, it.r.rows.find((r) => r.label === "青色申告特別控除額")?.value ?? null);
  cmp(rows, "第二表：不動産所得から差し引いた青色申告特別控除額", 110_000, it.r.blueRealEstate);
  cmp(rows, "合計所得金額 ⑫", 1_960_000, it.v("⑫"));
  cmp(rows, "基礎控除（令和7年分 88万円）", 880_000, it.r.rows.find((r) => r.label === "基礎控除")?.value ?? null);
  cmp(rows, "課税される所得金額（1,960,000 − 1,180,000）", 780_000, it.k("taxable"));
  cmp(rows, "納める税金（39,000 ＋ 819 → 39,800）", 39_800, it.k("pay"));
  await setFiler(db, { occupation: "デザイナー" });
  const x = await incomeXtxScreen(db, b, input, it);
  cmp(rows, "決算書（一般用）2ページ ⑥ 不動産所得（控除前）", 110_000, x.statement.realEstateIncome);
  cmp(rows, "決算書（一般用）㊹ 青色申告特別控除額（⑨ = 65万 − 110,000）", 540_000, x.statement.deduction);
  cmp(rows, "不動産所得用の決算書：青色申告特別控除額", 110_000, x.realEstate?.st.deduction ?? null);
  cmp(rows, "不動産所得用の決算書：所得金額", 0, x.realEstate?.st.income ?? null);
  cmp(rows, "不動産所得用の決算書：減価償却費 ⑧", 920_000, x.realEstate?.st.main.find((r) => r.label === "減価償却費")?.amount ?? null);
  cmp(rows, "e-Tax のデータ：書き出せる", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
  cmp(rows, "e-Tax のデータ：XSD に合う（KOA020・KOA210・KOA220）", "", x.invalid);
  cmp(rows, "e-Tax：KOA220（不動産所得用の決算書）がある", true, x.xml.includes("<KOA220"));
  cmp(rows, "e-Tax：不動産所得 ③（ABB00290 付近の値 0）と事業所得 ①（ABB00300）", "1960000", xtxVal(x.xml, "ABB00300"));
}

// ── 不動産所得だけ（事業的規模でない） ──
{
  const { db, b } = await setup(false);
  const it = await incomeTaxScreen(db, b, input);
  cmp(rows, "不動産だけ：不動産所得 ③（110,000 − 10万円）", 10_000, it.v("③"));
  cmp(rows, "不動産だけ：青色申告特別控除額（事業的規模でないので 10万円まで）", 100_000, it.r.rows.find((r) => r.label === "青色申告特別控除額")?.value ?? null);
  await setFiler(db, { occupation: "不動産賃貸" });
  const x = await incomeXtxScreen(db, b, input, it);
  cmp(rows, "不動産だけ：不動産所得用の決算書の控除額", 100_000, x.realEstate?.st.deduction ?? null);
  cmp(rows, "不動産だけ：e-Tax が XSD に合う", "", x.problems.join(" / ") || x.invalid);
  cmp(rows, "不動産だけ：一般用の決算書（KOA210）を書かない", false, x.xml.includes("<KOA210"));
}

// ── 不動産所得の赤字と土地の負債の利子（計算だけ） ──
{
  const biz = { revenue: 3_300_000, incomeBeforeBlue: 2_500_000, filingType: "blue65" as const, familySalary: 0, realEstate: { revenue: 1_300_000, incomeBeforeBlue: -300_000, familySalary: 0, scale: "small" as const, landInterest: 200_000 } };
  const r = computeIncomeTax(input, biz, YEAR);
  cmp(rows, "不動産の赤字 −300,000・土地の利子 200,000：③（−100,000 だけ通算）", -100_000, r.rows.find((x) => x.key === "realestate")?.value ?? null);
  cmp(rows, "同：事業所得 ①（控除 65万円は全部事業から）", 1_850_000, r.rows.find((x) => x.key === "business")?.value ?? null);
  cmp(rows, "同：合計所得金額", 1_750_000, r.totalIncome);
}

printTable("例7 事業所得と不動産所得（青色65万円・事業的規模でない貸付け）", rows);
