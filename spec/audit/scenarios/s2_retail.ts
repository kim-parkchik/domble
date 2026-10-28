/**
 * 分野 F・例2：雑貨の小売店（令和7年分＝2025年の一年分）
 * 何を確かめるか：
 *  - 青色65万円、簡易課税（主な事業区分は第二種。事業者への卸売は明細で第一種。2種類の事業の計算 ⑳㉑㉒ と ㊲ の選択）
 *  - 軽減税率の商品（お菓子・紅茶：売上 8%・仕入 8%）、売上の返品（売上の返還 ⑤）
 *  - 期首・期末の棚卸（振替伝票の決算整理仕訳：期首商品棚卸高 / 棚卸資産、棚卸資産 / 期末商品棚卸高）
 *  - 従業員1人の給与と源泉所得税の預り金（納期の特例：7/10・翌1/20）
 *  - 固定資産：2023年4月取得の陳列棚（定額法8年。前の年からの積み上げ）と、2025年9月のレジ（一括償却資産）
 *  - 中間納付（前年の確定消費税額 60万円 → 年1回 30万円・地方 84,600円。期限 8/31 は日曜なので 9/1）
 *  - 未払消費税（年末に「租税公課 / 未払消費税等」を手で入れる。前年分の未払消費税等は期首残高から3月に支払い）
 *  - 残高試算表・決算書・消費税の申告書（簡易課税）・所得税（令和8年分の制度との違い）
 * 動かし方：bun spec/audit/scenarios/s2_retail.ts（リポジトリの直下で）
 */
import {
  makeDb, makeBook, cashEntry, voucher, runDepreciation, yearFigures, taxReturnOf, incomeTaxOf, cmp, printTable, repo, YEAR, type Cmp,
} from "./common";
import { EMPTY_INCOME_TAX_INPUT, type IncomeTaxInput } from "../../../src/lib/incomeTax";

const { db } = makeDb("strict");
const b = await makeBook(db);
const M = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const last = (m: number) => M(m, new Date(YEAR, m, 0).getDate());

// ── 設定 ──
await repo.createAccount(db, { code: "208", name: "未払消費税等", kana: "みばらいしょうひぜいとう", category: "liability" });
await b.reload();
await repo.saveInvoiceRegistration(db, "T1111111111111", "2023-10-01");
await repo.saveTaxYear(db, { from_year: 2024, status: "simplified", method: "inclusive", business_class: 2, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
await repo.saveTaxBaseManual(db, YEAR, 22_000_000);
await repo.saveTaxPrevManual(db, YEAR, 600_000);
const rates = await repo.getHomeUseRates(db, YEAR);
const CAFE = await b.cp("カフェ・ビー", "T2222222222222");
const SHOP_OWNER = await b.cp("株式会社テナント", "T3333333333333");
const SUP = await b.cp("問屋シー", "T4444444444444");
const sSato = await b.sub("給料賃金", "パート 佐藤");
const sNhi = await b.sub("事業主貸", "国民健康保険");
const sPen = await b.sub("事業主貸", "国民年金");
const sKyo = await b.sub("事業主貸", "小規模企業共済");

// ── 期首残高 ──
const op = (name: string) => `${b.acc(name)}:0`;
await repo.saveOpening(db, YEAR, {
  [op("現金")]: 300_000, [op("普通預金")]: 3_000_000, [op("棚卸資産")]: 1_200_000, [op("工具器具備品")]: 687_500,
  [op("買掛金")]: 1_000_000, [op("預り金")]: 18_000, [op("未払消費税等")]: 769_200, [op("元入金")]: 3_400_300,
});

// ── 売上・仕入・給与など（毎月） ──
for (let m = 1; m <= 12; m++) {
  await cashEntry(db, b, rates, { date: last(m), book: "現金", counter: "売上高", dir: "in", amount: 1_650_000, memo: `雑貨 ${m}月分` }); // 第二種（主な事業区分）
  await cashEntry(db, b, rates, { date: last(m), book: "現金", counter: "売上高", dir: "in", amount: 270_000, memo: `お菓子・紅茶 ${m}月分`, tax: "sales8" });
  await cashEntry(db, b, rates, { date: last(m), book: "普通預金", counter: "現金", dir: "in", amount: 1_750_000, memo: "売上金の預け入れ" });
  await voucher(db, b, rates, M(m, 20), [{ dr: "仕入高", drAmt: 1_100_000, cr: "買掛金", crAmt: 1_100_000, memo: `雑貨の仕入 ${m}月` }], { cp: SUP });
  await voucher(db, b, rates, M(m, 20), [{ dr: "仕入高", drAmt: 180_000, drTax: { tax: "purchase8" }, cr: "買掛金", crAmt: 180_000, memo: `食品の仕入 ${m}月` }], { cp: SUP });
  await cashEntry(db, b, rates, { date: M(m, 10), book: "普通預金", counter: "買掛金", dir: "out", amount: m === 1 ? 1_000_000 : 1_280_000, memo: "買掛金の支払" });
  await voucher(db, b, rates, M(m, 25), [
    { dr: "給料賃金", drSub: sSato, drAmt: 150_000, cr: "現金", crAmt: 147_000, memo: `給料 ${m}月分` },
    { cr: "預り金", crAmt: 3_000, memo: `源泉所得税 ${m}月分` },
  ]);
  await cashEntry(db, b, rates, { date: M(m, 27), book: "普通預金", counter: "地代家賃", dir: "out", amount: 220_000, memo: `店舗家賃 ${m}月分`, cp: SHOP_OWNER });
  await cashEntry(db, b, rates, { date: M(m, 15), book: "普通預金", counter: "水道光熱費", dir: "out", amount: 30_000, memo: "電気・水道" });
  await cashEntry(db, b, rates, { date: M(m, 15), book: "普通預金", counter: "通信費", dir: "out", amount: 10_000, memo: "電話・ネット" });
  await cashEntry(db, b, rates, { date: M(m, 15), book: "普通預金", counter: "荷造運賃", dir: "out", amount: 12_500, memo: "配送料" });
  await cashEntry(db, b, rates, { date: M(m, 18), book: "現金", counter: "消耗品費", dir: "out", amount: 15_000, memo: "包装資材" });
  await cashEntry(db, b, rates, { date: M(m, 5), book: "普通預金", counter: "事業主貸", counterSub: sPen, dir: "out", amount: 17_510, memo: "国民年金" });
  await cashEntry(db, b, rates, { date: M(m, 5), book: "普通預金", counter: "事業主貸", counterSub: sKyo, dir: "out", amount: 70_000, memo: "小規模企業共済" });
  await cashEntry(db, b, rates, { date: M(m, 28), book: "普通預金", counter: "事業主貸", dir: "out", amount: 200_000, memo: "生活費" });
}
for (const m of [1, 2, 3, 6, 7, 8, 9, 10, 11, 12]) {
  await cashEntry(db, b, rates, { date: M(m, 26), book: "普通預金", counter: "事業主貸", counterSub: sNhi, dir: "out", amount: 45_000, memo: "国民健康保険" });
}
// 事業者への卸売（第一種）。12月分は年末に売掛金で残る
for (const [m, recv] of [[3, 4], [6, 7], [9, 10], [12, 0]] as const) {
  await voucher(db, b, rates, last(m) === M(12, 31) ? M(12, 20) : last(m), [{ dr: "売掛金", drAmt: 550_000, cr: "売上高", crAmt: 550_000, crTax: { cls: 1 }, memo: "雑貨の卸売" }], { cp: CAFE });
  if (recv) await cashEntry(db, b, rates, { date: last(recv), book: "普通預金", counter: "売掛金", dir: "in", amount: 550_000, memo: "卸売の入金", cp: CAFE });
}
// 返品（売上の返還）
await cashEntry(db, b, rates, { date: M(5, 10), book: "現金", counter: "売上高", dir: "out", amount: 11_000, memo: "返品" });
// 源泉所得税の納付（納期の特例）
await cashEntry(db, b, rates, { date: M(1, 20), book: "普通預金", counter: "預り金", dir: "out", amount: 18_000, memo: "源泉所得税（令和6年7〜12月分）" });
await cashEntry(db, b, rates, { date: M(7, 10), book: "普通預金", counter: "預り金", dir: "out", amount: 18_000, memo: "源泉所得税（1〜6月分）" });
// そのほかの経費
await cashEntry(db, b, rates, { date: M(4, 1), book: "普通預金", counter: "広告宣伝費", dir: "out", amount: 100_000, memo: "チラシ" });
await cashEntry(db, b, rates, { date: M(10, 1), book: "普通預金", counter: "広告宣伝費", dir: "out", amount: 100_000, memo: "チラシ" });
await cashEntry(db, b, rates, { date: M(4, 1), book: "普通預金", counter: "損害保険料", dir: "out", amount: 48_000, memo: "店舗総合保険" });
await cashEntry(db, b, rates, { date: M(3, 31), book: "普通預金", counter: "未払消費税等", dir: "out", amount: 769_200, memo: "令和6年分 消費税及び地方消費税" });
await cashEntry(db, b, rates, { date: M(9, 1), book: "普通預金", counter: "租税公課", dir: "out", amount: 384_600, memo: "消費税の中間納付（国 300,000・地方 84,600）" });
await cashEntry(db, b, rates, { date: M(9, 1), book: "普通預金", counter: "租税公課", dir: "out", amount: 60_000, memo: "個人事業税 第1期" });
await cashEntry(db, b, rates, { date: M(12, 1), book: "普通預金", counter: "租税公課", dir: "out", amount: 60_000, memo: "個人事業税 第2期" });
// 固定資産
await voucher(db, b, rates, M(9, 1), [{ dr: "一括償却資産", drAmt: 198_000, cr: "普通預金", crAmt: 198_000, memo: "レジ" }]);
await repo.saveAsset(db, null, { name: "陳列棚", account_id: b.acc("工具器具備品"), acquired_on: "2023-04-01", used_on: "2023-04-01", cost: 880_000, method: "straight", useful_life: 8, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });
await repo.saveAsset(db, null, { name: "レジ", account_id: b.acc("一括償却資産"), acquired_on: M(9, 1), used_on: M(9, 1), cost: 198_000, method: "lump3", useful_life: 0, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "" });
await repo.saveTaxInterim(db, YEAR, 300_000, 84_600);

// ── 決算整理 ──
await runDepreciation(db, b);
await voucher(db, b, rates, M(12, 31), [
  { dr: "期首商品棚卸高", drAmt: 1_200_000, cr: "棚卸資産", crAmt: 1_200_000, memo: "期首棚卸の振替" },
  { dr: "棚卸資産", drAmt: 1_350_000, cr: "期末商品棚卸高", crAmt: 1_350_000, memo: "期末棚卸" },
], { adjustment: true });
// 未払消費税（domble には自動の仕訳が無いので、申告書の数字を見て手で入れる）
const pre = await taxReturnOf(db, b);
await voucher(db, b, rates, M(12, 31), [{ dr: "租税公課", drAmt: pre.r.total, cr: "未払消費税等", crAmt: pre.r.total, memo: "令和7年分 消費税等の未払計上" }], { adjustment: true });

// ── 数字を出す ──
const f = await yearFigures(db, b);
const rows: Cmp[] = [];
const ex = (label: string) => f.layout.sections.expense.find((r) => r.label === label)?.amount ?? 0;
const cg = (label: string) => f.layout.sections.cogs.find((r) => r.label === label)?.amount ?? 0;
cmp(rows, "試算表：現金（期末）", 385_000, f.tbRow("現金").balance);
cmp(rows, "試算表：普通預金（期末）", 1_644_080, f.tbRow("普通預金").balance);
cmp(rows, "試算表：売掛金（期末）", 550_000, f.tbRow("売掛金").balance);
cmp(rows, "試算表：棚卸資産（期末）", 1_350_000, f.tbRow("棚卸資産").balance);
cmp(rows, "試算表：工具器具備品（期末）", 577_500, f.tbRow("工具器具備品").balance);
cmp(rows, "試算表：一括償却資産（期末）", 132_000, f.tbRow("一括償却資産").balance);
cmp(rows, "試算表：買掛金（期末）", 1_280_000, f.tbRow("買掛金").balance);
cmp(rows, "試算表：預り金（期末）", 18_000, f.tbRow("預り金").balance);
cmp(rows, "試算表：未払消費税等（期末）", 43_000, f.tbRow("未払消費税等").balance);
cmp(rows, "決算書：売上（収入）金額", 25_229_000, f.pl.revenue);
cmp(rows, "決算書：期首商品棚卸高", 1_200_000, cg("期首商品（製品）棚卸高"));
cmp(rows, "決算書：仕入金額", 15_360_000, cg("仕入金額（製品製造原価）"));
cmp(rows, "決算書：期末商品棚卸高", 1_350_000, cg("期末商品（製品）棚卸高"));
cmp(rows, "決算書：差引原価", 15_210_000, f.pl.cogs);
cmp(rows, "決算書：差引金額（売上総利益）", 10_019_000, f.pl.grossProfit);
cmp(rows, "決算書：租税公課", 547_600, ex("租税公課"));
cmp(rows, "決算書：減価償却費", 176_000, ex("減価償却費"));
cmp(rows, "決算書：給料賃金", 1_800_000, ex("給料賃金"));
cmp(rows, "決算書：地代家賃", 2_640_000, ex("地代家賃"));
cmp(rows, "決算書：経費計", 6_221_600, f.pl.expenses);
cmp(rows, "決算書：青色申告特別控除前の所得金額", 3_797_400, f.pl.income);
cmp(rows, "決算書：所得金額", 3_147_400, f.pl.income - f.blue);
cmp(rows, "決算書2頁：月別仕入の計", 15_360_000, f.monthly.purchases.reduce((s, x) => s + x, 0));
cmp(rows, "決算書2頁：5月の売上（返品 11,000 を差引）", 1_909_000, f.monthly.sales[4]);
cmp(rows, "決算書2頁：12月の売上", 2_470_000, f.monthly.sales[11]);
const sal = f.payee("給料賃金");
cmp(rows, "決算書2頁：給料賃金の内訳（パート 佐藤）", 1_800_000, sal.find((r) => r.subId === sSato)?.gross ?? null);
const shelf = f.deps.find((x) => x.a.name === "陳列棚")!.d!;
const reg = f.deps.find((x) => x.a.name === "レジ")!.d!;
cmp(rows, "減価償却：陳列棚 期首の未償却残高（2023年4月から積み上げ）", 687_500, shelf.opening);
cmp(rows, "減価償却：陳列棚 本年分", 110_000, shelf.depreciation);
cmp(rows, "減価償却：レジ（一括償却 1/3）", 66_000, reg.depreciation);
cmp(rows, "貸借対照表：資産合計", 8_538_700, f.bs.assets);
cmp(rows, "貸借対照表：貸借の差", 0, f.bs.difference);

// ── 消費税（簡易課税） ──
const t = await taxReturnOf(db, b);
const r53 = (no: string) => t.row("5-3", no);
cmp(rows, "消費税：課税標準額（①）", 23_000_000, t.row("first", "①")?.c ?? null);
cmp(rows, "消費税：消費税額（②）", 1_747_200, t.row("first", "②")?.c ?? null);
cmp(rows, "付表5-3 ④ 基礎となる消費税額（C）", 1_746_420, r53("④")?.c ?? null);
cmp(rows, "付表5-3 ⑥ 事業区分別の課税売上高の合計", 22_990_000, r53("⑥")?.c ?? null);
cmp(rows, "付表5-3 ⑦ 第一種の課税売上高", 2_000_000, r53("⑦")?.c ?? null);
cmp(rows, "付表5-3 ⑧ 第二種の課税売上高", 20_990_000, r53("⑧")?.c ?? null);
cmp(rows, "付表5-3 ⑳ 原則計算（C）", 1_412_736, r53("⑳")?.c ?? null);
cmp(rows, "付表5-3 ㉑ 第二種で75%以上（C）", 1_397_136, r53("㉑")?.c ?? null);
cmp(rows, "付表5-3 ㉒ 第一種及び第二種（C）", 1_412_736, r53("㉒")?.c ?? null);
cmp(rows, "付表5-3 ㊲ 控除対象仕入税額（C）", 1_412_736, r53("㊲")?.c ?? null);
cmp(rows, "消費税：返還等対価に係る税額（⑤）", 780, t.row("first", "⑤")?.c ?? null);
cmp(rows, "消費税：差引税額（⑨）", 333_600, t.row("first", "⑨")?.c ?? null);
cmp(rows, "消費税：中間納付税額（⑩）", 300_000, t.row("first", "⑩")?.c ?? null);
cmp(rows, "消費税：納付税額（⑪）", 33_600, t.row("first", "⑪")?.c ?? null);
cmp(rows, "消費税：⑮ この課税期間の課税売上高", 22_990_000, t.row("first", "⑮")?.c ?? null);
cmp(rows, "消費税：⑯ 基準期間の課税売上高", 22_000_000, t.row("first", "⑯")?.c ?? null);
cmp(rows, "消費税：譲渡割額（⑳）", 94_000, t.row("first", "⑳")?.c ?? null);
cmp(rows, "消費税：納付譲渡割額（㉒）", 9_400, t.row("first", "㉒")?.c ?? null);
cmp(rows, "消費税：合計税額（㉖）", 43_000, t.r.total);
const ref = (k: string) => t.r.forms.find((x) => x.id === "first")!.rows.find((x) => x.key === k)?.c ?? null;
cmp(rows, "第一表 参考事項：第一種の課税売上高（千円）", 2_000, ref("class1"));
cmp(rows, "第一表 参考事項：第二種の課税売上高（千円）", 20_990, ref("class2"));
cmp(rows, "中間申告の判定：回数", "年1回", t.plan.kind === "once" ? "年1回" : t.plan.kind);
cmp(rows, "中間申告の判定：国税", 300_000, t.plan.national);
cmp(rows, "中間申告の判定：地方", 84_600, t.plan.local);
cmp(rows, "中間申告の判定：納付期限（8/31 は日曜）", "2025-09-01", t.plan.periods[0]?.payBy ?? null);
cmp(rows, "未払消費税の決算整理仕訳", "自動で作る（市販ソフト）", "出せない", "申告書の ㉖ を見て振替伝票で手入力した");
cmp(rows, "消費税：令和7年分の e-Tax データ（.xtx）", "書き出せる", t.xtx ? "出せない" : "書き出せる");

// ── 所得税 ──
const input: IncomeTaxInput = {
  ...EMPTY_INCOME_TAX_INPUT, birthday: "1975-04-01",
  socialInsurance: [{ kind: "国民健康保険", amount: 450_000 }, { kind: "国民年金", amount: 210_120 }],
  smallBusiness: [{ kind: "小規模企業共済", amount: 840_000 }],
};
const it = await incomeTaxOf(db, b, input);
cmp(rows, "所得税：事業所得 ①", 3_147_400, it.v("①"));
cmp(rows, "所得税：基礎控除 ㉕", 880_000, it.v("㉕"), "令和7年分は 132万円超336万円以下 88万円");
cmp(rows, "所得税：課税される所得金額 ㉛", 767_000, it.v("㉛"));
cmp(rows, "所得税：税額 ㉜", 38_350, it.v("㉜"));
cmp(rows, "所得税：復興特別所得税 ㊺", 805, it.v("㊺"));
cmp(rows, "所得税：納める税金", 39_100, it.v("(52)"));
cmp(rows, "所得税：画面で出せるか（令和7年分）", "出せる", "出せない");

printTable("例2 雑貨の小売店（簡易課税・第一種と第二種・青色65万円）", rows);
console.log("\n消費税の確認の一覧：", t.issues.map((i) => `[${i.level}] ${i.title}`).join(" / ") || "なし");
console.log("方式の比較：", t.all.map((x) => `${x.m}=${x.total}${x.problem ? `（${x.problem}）` : ""}`).join(" / "));
console.log("付表5-3 の注記：", t.r.notes.join(" / "));
console.log("決算書の欄の知らせ：", f.layout.warnings.join(" / ") || "なし");
console.log("負債の欄：", f.layout.sections.liability.filter((r) => r.amount || r.opening).map((r) => `${r.label}${r.extra ? "（追加の欄）" : ""}=${r.opening}→${r.amount}`).join(" / "));
