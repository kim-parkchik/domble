/**
 * 分野 F・例9（2026-11-07 に足した）：事業用の資産を売った年の総合課税の譲渡所得・一時所得・配当（総合課税）（令和7年分）
 * 何を確かめるか（青色65万円・消費税は免税事業者）：
 *  - 営業車（事業専用割合 80%）：2019-04-01 取得 2,000,000円・定額法6年（償却率 0.167、年 334,000円）。
 *      2019年 9か月 250,500円＋2020〜2024年 1,670,000円 → 2025年の期首 79,500円。2025-09-30 に 1,000,000円で売却：
 *      9か月 250,500円のところ 1円（備忘価額）まで 79,499円（事業分 63,599円）→ 帳簿価額 1円・取得費（事業分）0円。
 *      譲渡価額（事業分）800,000円 − 取得費 0円 − 譲渡費用 22,000円 ＝ 778,000円（5年超なので長期）
 *  - パソコン：2024-01-15 取得 300,000円・定額法4年（年 75,000円）。2025-06-30 に 100,000円で売却：
 *      6か月 37,500円 → 帳簿価額 187,500円。100,000 − 187,500 ＝ −87,500円（短期の損失。事業税の「事業用資産の譲渡損失など」）
 *  - 内部通算：長期 778,000 − 短期の損失 87,500 ＝ 690,500円、特別控除 500,000円 → ㋙ 190,500円
 *  - 一時所得：生命保険の満期金 2,500,000 − 払った保険料 1,640,000 − 特別控除 500,000 ＝ 360,000円
 *  - ⑪ ＝（190,500 ＋ 360,000）× 1/2 ＝ 275,250円
 *  - 配当（上場株式・総合課税）200,000円（源泉徴収 30,630円・配当割 10,000円）→ 配当控除 10% ＝ 20,000円
 *  - 事業所得：売上 6,000,000 − 外注 1,000,000 − 減価償却費（事業分 63,599 ＋ 37,500）＝ 4,898,901円 − 青色 650,000 ＝ 4,248,901円
 *  - ⑫ ＝ 4,248,901 ＋ 200,000 ＋ 275,250 ＝ 4,724,151円。基礎控除（令和7年分・489万円以下）680,000円、社会保険料 400,000円
 *      課税される所得金額 3,644,000円 → 税額 728,800 − 427,500 ＝ 301,300円 − 配当控除 20,000 ＝ 281,300円、
 *      復興 5,907円 → 287,207円 − 源泉 30,630 ＝ 256,577 → 納める税金 256,500円
 *  - e-Tax のデータ：第一表・第二表・譲渡所得の内訳書（総合譲渡用。資産ごと）が XSD に合う
 * 動かし方：bun s10_transfer.ts
 */
import { makeDb, makeBook, cashEntry, runDepreciation, incomeTaxScreen, incomeXtxScreen, setFiler, xtxVal, cmp, printTable, repo, YEAR, type Cmp } from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";

const { db } = makeDb("strict");
const b = await makeBook(db);
const rates = await repo.getHomeUseRates(db, YEAR);
await repo.saveOpening(db, YEAR, {
  [`${b.acc("普通預金")}:0`]: 3_000_000, [`${b.acc("車両運搬具")}:0`]: 79_500, [`${b.acc("工具器具備品")}:0`]: 225_000, [`${b.acc("元入金")}:0`]: 3_304_500,
});
await repo.saveAsset(db, null, {
  name: "営業車", account_id: b.acc("車両運搬具"), acquired_on: "2019-04-01", used_on: "2019-04-01", cost: 2_000_000, method: "straight", useful_life: 6, business_rate: 80,
  opening_year: null, opening_book_value: null, disposed_on: "2025-09-30", disposal_kind: "sale", sale_price: 1_000_000, memo: "",
});
await repo.saveAsset(db, null, {
  name: "パソコン", account_id: b.acc("工具器具備品"), acquired_on: "2024-01-15", used_on: "2024-01-15", cost: 300_000, method: "straight", useful_life: 4, business_rate: 100,
  opening_year: null, opening_book_value: null, disposed_on: "2025-06-30", disposal_kind: "sale", sale_price: 100_000, memo: "",
});
await cashEntry(db, b, rates, { date: "2025-12-20", book: "普通預金", counter: "売上高", dir: "in", amount: 6_000_000, memo: "売上", tax: "none" });
await cashEntry(db, b, rates, { date: "2025-11-30", book: "普通預金", counter: "外注工賃", dir: "out", amount: 1_000_000, memo: "外注", tax: "none" });
await runDepreciation(db, b);

const rows: Cmp[] = [];
const input: IncomeTaxInput = {
  ...EMPTY_INCOME_TAX_INPUT, outside: "none", birthday: "1980-05-05",
  socialInsurance: [{ kind: "国民健康保険", amount: 400_000 }],
  dividends: [{ item: "株式の配当", payer: "B証券", payerId: "東京都中央区日本橋1-1-1", income: 200_000, withheld: 30_630, listed: true, localWithheld: 10_000, interest: 0, credit: "stock" }],
  occasional: [{ item: "生命保険の満期金", payer: "A生命保険", payerId: "東京都千代田区丸の内1-1-1", income: 2_500_000, expenses: 1_640_000, withheld: 0 }],
  transfers: [{ assetId: 1, name: "", kind: "", acquired: "", sold: "", price: 0, cost: null, expenses: 22_000, luxury: false, buyer: "中古車センター", buyerAddress: "東京都江東区" }],
};
await repo.saveIncomeTaxInput(db, YEAR, input);
const r = await incomeTaxScreen(db, b, input, YEAR);
const car = r.r.transfers.find((t) => t.name === "営業車");
const pc = r.r.transfers.find((t) => t.name === "パソコン");
cmp(rows, "営業車：帳簿価額（売った年の期末の未償却残高）", 1, car?.sale?.bookValue ?? null);
cmp(rows, "営業車：譲渡価額（事業分 80%）", 800_000, car?.price ?? null);
cmp(rows, "営業車：取得費（事業分）", 0, car?.cost ?? null);
cmp(rows, "営業車：長期（2019-04-01 取得、5年超）", "long", car?.term ?? null);
cmp(rows, "営業車：差引金額（800,000 − 0 − 22,000）", 778_000, car?.gain ?? null);
cmp(rows, "パソコン：帳簿価額（225,000 − 37,500）", 187_500, pc?.sale?.bookValue ?? null);
cmp(rows, "パソコン：短期の損失", -87_500, pc?.gain ?? null);
cmp(rows, "事業所得 ①（4,898,901 − 650,000）", 4_248_901, r.v("①"));
cmp(rows, "総合譲渡（短期）㋘（内部通算で 0）", 0, r.v("㋘"));
cmp(rows, "総合譲渡（長期）㋙（690,500 − 特別控除 500,000）", 190_500, r.v("㋙"));
cmp(rows, "一時 ㋚", 360_000, r.v("㋚"));
cmp(rows, "配当 ㋓・⑤", "200000/200000", `${r.v("㋓")}/${r.v("⑤")}`);
cmp(rows, "⑪ 総合譲渡・一時（(190,500 + 360,000) / 2）", 275_250, r.v("⑪"));
cmp(rows, "⑫ 合計", 4_724_151, r.v("⑫"));
cmp(rows, "基礎控除（令和7年分・合計所得金額 489万円以下）", 680_000, r.r.rows.find((x) => x.label === "基礎控除")?.value ?? null);
cmp(rows, "課税される所得金額", 3_644_000, r.k("taxable"));
cmp(rows, "配当控除 ㉝（10%）", 20_000, r.k("dividendCredit"));
cmp(rows, "納める税金", 256_500, r.k("pay"));
cmp(rows, "事業税：事業用資産の譲渡損失など", 87_500, r.r.transfer.businessLoss);
cmp(rows, "住民税：配当割額控除額", 10_000, r.r.dividend.local);

await setFiler(db);
const x = await incomeXtxScreen(db, b, input, r, YEAR);
cmp(rows, "e-Tax のデータが書き出せる", "書き出せる", x.problems.length ? "出せない" : "書き出せる", x.problems.join(" / "));
cmp(rows, "e-Tax のデータが XSD に合う", "", x.invalid);
cmp(rows, "e-Tax ㋙・㋚・⑪・㉝（ABB00180・ABB00230・ABB00400・ABB00600）", "190500/360000/275250/20000",
  [xtxVal(x.xml, "ABB00180"), xtxVal(x.xml, "ABB00230"), xtxVal(x.xml, "ABB00400"), xtxVal(x.xml, "ABB00600")].join("/"));
cmp(rows, "e-Tax 譲渡所得の内訳書は資産ごとに1面（2面）", 2, x.xml.split("<KOC020-1>").length - 1);
cmp(rows, "e-Tax 内訳書：営業車の長期の計算（収入・必要経費・差引・特別控除・譲渡所得）", "800000/22000/778000/500000/278000",
  [xtxVal(x.xml, "EBG00290"), xtxVal(x.xml, "EBG00320"), xtxVal(x.xml, "EBG00330"), xtxVal(x.xml, "EBG00340"), xtxVal(x.xml, "EBG00350")].join("/"));
cmp(rows, "e-Tax 第二表の譲渡・一時の欄は2行（短期・長期。一時は書けないので知らせる）", 2, x.xml.split("<ABX00000>").length - 1);
cmp(rows, "e-Tax 事業税 事業用資産の譲渡損失など（ABI00180）", "87500", xtxVal(x.xml, "ABI00180"));

printTable("例9 事業用の資産を売った年（総合課税の譲渡・一時所得・配当）", rows);
console.log("\nお知らせ：", r.r.notes.join(" / ") || "なし");
