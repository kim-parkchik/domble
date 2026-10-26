/**
 * 消費税の申告書の数字（純粋関数）。税込経理・割戻し計算（売上も仕入も）
 *
 * 様式は国税庁の令和5年10月1日以後終了課税期間用（標準税率 7.8%・軽減税率 6.24% だけの場合）
 *  - 本則課税：付表1-3（税率別消費税額計算表）・付表2-3（課税売上割合・控除対象仕入税額等の計算表）
 *  - 簡易課税：付表4-3（税率別消費税額計算表）・付表5-3（控除対象仕入税額等の計算表。今は事業区分が1種類のとき）
 *  - 2割特例：付表6（小規模事業者に係る税額控除に関する経過措置を適用する課税期間用。特別控除税額 = ⑥ × 80%）
 *  - 3割特例：付表6（小規模個人事業者に係る税額控除に関する経過措置を適用する課税期間用。⑥ × 70%。令和9年分・令和10年分）
 *  - 第二表・第一表は付表から転記する
 * 端数：計算の途中の 1 円未満はその都度切り捨て、課税標準額は千円未満切り捨て、差引税額・譲渡割額は百円未満切り捨て
 * 対象は課税事業者の期間の、削除済みでない明細（年の途中から課税事業者になった場合はその日から）
 * 個別対応方式・特定課税仕入れ・課税貨物・棚卸資産の調整・旧税率には対応していない
 */
import type { TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { isPurchaseCode, taxActiveOn, taxCodeDef, transitionalRate } from "./tax";
import { BUSINESS_CLASSES } from "../constants/tax";

export type Rate = 8 | 10;
export const RATES: Rate[] = [8, 10];

/** 申告書の数字のもとになる金額（税込。税率ごと） */
export interface TaxBase {
  sales: Record<Rate, number>;
  salesReturn: Record<Rate, number>;
  badDebt: Record<Rate, number>;
  badDebtRecovered: Record<Rate, number>;
  /** 輸出免税・非課税売上（返還を差し引いた額） */
  exportSales: number;
  nontaxSales: number;
  /** インボイスのある課税仕入とその返還 */
  purchase: Record<Rate, number>;
  purchaseReturn: Record<Rate, number>;
  /** 経過措置の課税仕入とその返還（控除できる割合ごと） */
  transitional: { pct: number; purchase: Record<Rate, number>; ret: Record<Rate, number> }[];
}

const zero = (): Record<Rate, number> => ({ 8: 0, 10: 0 });

export const buildTaxBase = (lines: FlatLine[], taxYears: TaxYear[]): TaxBase => {
  const b: TaxBase = {
    sales: zero(), salesReturn: zero(), badDebt: zero(), badDebtRecovered: zero(), exportSales: 0, nontaxSales: 0,
    purchase: zero(), purchaseReturn: zero(), transitional: [],
  };
  for (const l of lines) {
    if (l.is_deleted || !l.tax_code || l.tax_code === "none" || !taxActiveOn(taxYears, l.date)) continue;
    const def = taxCodeDef(l.tax_code);
    const rate = def.rate as Rate;
    const dr = l.side === "debit";
    if (l.tax_code === "export") b.exportSales += dr ? -l.amount : l.amount;
    else if (l.tax_code === "sales_nontax") b.nontaxSales += dr ? -l.amount : l.amount;
    else if (l.tax_code === "baddebt10" || l.tax_code === "baddebt8") (dr ? b.badDebt : b.badDebtRecovered)[rate] += l.amount;
    else if (def.group === "sales") (dr ? b.salesReturn : b.sales)[rate] += l.amount;
    else if (isPurchaseCode(l.tax_code)) {
      const inv = l.invoice_kind ?? "qualified";
      if (inv === "none") continue;
      if (inv === "qualified") (dr ? b.purchase : b.purchaseReturn)[rate] += l.amount;
      else {
        const pct = transitionalRate(l.date);
        let t = b.transitional.find((x) => x.pct === pct);
        if (!t) b.transitional.push((t = { pct, purchase: zero(), ret: zero() }));
        (dr ? t.purchase : t.ret)[rate] += l.amount;
      }
    }
  }
  b.transitional.sort((x, y) => y.pct - x.pct);
  return b;
};

// ── 端数の決まり ──
/** 税込 → 税抜（1 円未満切り捨て） */
export const exclusive = (amount: number, r: Rate) => Math.floor((amount * 100) / (100 + r));
/** 税込の金額に含まれる消費税額（国税分。7.8/110・6.24/108。1 円未満切り捨て） */
export const nationalTaxIn = (amount: number, r: Rate) => (r === 10 ? Math.floor((amount * 78) / 1100) : Math.floor((amount * 624) / 10800));
/** 課税標準額 × 7.8%・6.24% */
export const nationalTaxOn = (base: number, r: Rate) => (r === 10 ? Math.floor((base * 78) / 1000) : Math.floor((base * 624) / 10000));
export const floor1000 = (n: number) => Math.floor(n / 1000) * 1000;
export const floor100 = (n: number) => Math.floor(n / 100) * 100;

// ── 申告書の欄 ──
export interface FormRow {
  /** 欄の番号（①、⑤-1 など） */
  no: string;
  label: string;
  /** 付表は税率 6.24%（A）・7.8%（B）・合計（C）。第一表・第二表は c だけ */
  a?: number;
  b?: number;
  c: number | null;
  /** 転記先・計算式など */
  note?: string;
}
export interface TaxForm {
  id: string;
  title: string;
  /** A・B・C の列があるか（付表） */
  abc: boolean;
  rows: FormRow[];
}

export type ReturnMethod = "standard" | "simplified" | "twenty" | "thirty";
export const METHOD_LABEL: Record<ReturnMethod, string> = {
  standard: "本則課税", simplified: "簡易課税", twenty: "2割特例", thirty: "3割特例",
};

export interface TaxReturn {
  method: ReturnMethod;
  forms: TaxForm[];
  /** 消費税（国税）：納付税額 ⑪ − 還付（⑧＋⑫） */
  national: number;
  /** 地方消費税：納付譲渡割額 ㉒ − 還付（⑲＋㉓） */
  local: number;
  /** 消費税及び地方消費税の合計（納付又は還付）税額 ㉖（還付はマイナス） */
  total: number;
  notes: string[];
}

export interface ReturnOptions {
  /** 簡易課税の事業区分（1〜6） */
  businessClass: number;
  /** 中間納付税額（消費税・地方消費税） */
  interimNational: number;
  interimLocal: number;
}

type AB = Record<Rate, number>;
const sumAB = (x: AB) => x[8] + x[10];
const abRow = (no: string, label: string, x: AB, note?: string): FormRow => ({ no, label, a: x[8], b: x[10], c: sumAB(x), note });
const map = (f: (r: Rate) => number): AB => ({ 8: f(8), 10: f(10) });

/** 売上側（付表1-3・4-3・6 に共通）：課税資産の譲渡等の対価の額、課税標準額、消費税額、返還・貸倒れ・貸倒回収の税額 */
const salesSide = (b: TaxBase) => {
  const price = map((r) => exclusive(b.sales[r], r));
  const base = map((r) => floor1000(price[r]));
  const tax = map((r) => nationalTaxOn(base[r], r));
  const ret = map((r) => nationalTaxIn(b.salesReturn[r], r));
  const bad = map((r) => nationalTaxIn(b.badDebt[r], r));
  const recovered = map((r) => nationalTaxIn(b.badDebtRecovered[r], r));
  return { price, base, tax, ret, bad, recovered };
};

/** 第一表の納付税額まで（②③④⑤⑥ から） */
const finish = (c: { tax: number; plus: number; deduct: number; ret: number; bad: number }, o: ReturnOptions) => {
  const subtotal = c.deduct + c.ret + c.bad; // ⑦
  const diff = c.tax + c.plus - subtotal;
  const shortfall = diff < 0 ? -diff : 0; // ⑧ 控除不足還付税額
  const net = diff > 0 ? floor100(diff) : 0; // ⑨ 差引税額
  const pay = Math.max(net - o.interimNational, 0); // ⑪
  const interimRefund = Math.max(o.interimNational - net, 0); // ⑫
  const localRefund = Math.floor((shortfall * 22) / 78); // ⑲
  const localTax = floor100((net * 22) / 78); // ⑳
  const localPay = Math.max(localTax - o.interimLocal, 0); // ㉒
  const localInterimRefund = Math.max(o.interimLocal - localTax, 0); // ㉓
  return {
    subtotal, shortfall, net, pay, interimRefund, localRefund, localTax, localPay, localInterimRefund,
    national: pay - shortfall - interimRefund,
    local: localPay - localRefund - localInterimRefund,
    total: pay + localPay - (shortfall + interimRefund + localRefund + localInterimRefund),
  };
};

const secondTable = (s: ReturnType<typeof salesSide>, retTotal: number, localBase: number, note: string): TaxForm => ({
  id: "second", title: `第二表（課税標準額等の内訳書）${note}`, abc: false,
  rows: [
    { no: "①", label: "課税標準額", c: sumAB(s.base), note: "第一表の①へ" },
    { no: "⑤", label: "課税資産の譲渡等の対価の額（6.24% 適用分）", c: s.price[8] },
    { no: "⑥", label: "課税資産の譲渡等の対価の額（7.8% 適用分）", c: s.price[10] },
    { no: "⑦", label: "課税資産の譲渡等の対価の額の合計額", c: sumAB(s.price) },
    { no: "⑪", label: "消費税額", c: sumAB(s.tax), note: "第一表の②へ" },
    { no: "⑮", label: "⑪の内訳（6.24% 適用分）", c: s.tax[8] },
    { no: "⑯", label: "⑪の内訳（7.8% 適用分）", c: s.tax[10] },
    { no: "⑰", label: "返還等対価に係る税額", c: retTotal, note: "第一表の⑤へ" },
    { no: "⑱", label: "売上げの返還等対価に係る税額", c: retTotal },
    { no: "⑳", label: "地方消費税の課税標準となる消費税額", c: localBase, note: "還付のときはマイナス" },
    { no: "㉓", label: "地方消費税の課税標準となる消費税額（6.24% 及び 7.8% 適用分）", c: localBase },
  ],
});

const firstTable = (
  kind: "一般用" | "簡易課税用", base: number, c: { tax: number; plus: number; deduct: number; ret: number; bad: number }, f: ReturnType<typeof finish>,
  o: ReturnOptions, extra: FormRow[], twentyLike: string | null,
): TaxForm => ({
  id: "first", title: `第一表（${kind}）`, abc: false,
  rows: [
    { no: "①", label: "課税標準額", c: base, note: "第二表の①から" },
    { no: "②", label: "消費税額", c: c.tax },
    { no: "③", label: kind === "一般用" ? "控除過大調整税額" : "貸倒回収に係る消費税額", c: c.plus },
    { no: "④", label: "控除対象仕入税額", c: c.deduct },
    { no: "⑤", label: "返還等対価に係る税額", c: c.ret },
    { no: "⑥", label: "貸倒れに係る税額", c: c.bad },
    { no: "⑦", label: "控除税額小計（④＋⑤＋⑥）", c: f.subtotal },
    { no: "⑧", label: "控除不足還付税額（⑦－②－③）", c: f.shortfall },
    { no: "⑨", label: "差引税額（②＋③－⑦。百円未満切り捨て）", c: f.net },
    { no: "⑩", label: "中間納付税額", c: o.interimNational },
    { no: "⑪", label: "納付税額（⑨－⑩）", c: f.pay },
    { no: "⑫", label: "中間納付還付税額（⑩－⑨）", c: f.interimRefund },
    ...extra,
    { no: "⑰", label: "地方消費税の課税標準となる消費税額・控除不足還付税額", c: f.shortfall },
    { no: "⑱", label: "地方消費税の課税標準となる消費税額・差引税額", c: f.net },
    { no: "⑲", label: "譲渡割額・還付額（⑰ × 22/78）", c: f.localRefund },
    { no: "⑳", label: "譲渡割額・納税額（⑱ × 22/78。百円未満切り捨て）", c: f.localTax },
    { no: "㉑", label: "中間納付譲渡割額", c: o.interimLocal },
    { no: "㉒", label: "納付譲渡割額（⑳－㉑）", c: f.localPay },
    { no: "㉓", label: "中間納付還付譲渡割額（㉑－⑳）", c: f.localInterimRefund },
    { no: "㉖", label: "消費税及び地方消費税の合計（納付又は還付）税額", c: f.total, note: "（⑪＋㉒）－（⑧＋⑫＋⑲＋㉓）。還付はマイナス" },
    ...(twentyLike ? [{ no: "", label: `税額控除に係る経過措置の適用（${twentyLike}）`, c: null, note: "○ をつける" }] : []),
  ],
});

// ────────────────────────────────────────────
// 本則課税（付表1-3・2-3）
// ────────────────────────────────────────────
export const standardReturn = (b: TaxBase, o: ReturnOptions): TaxReturn => {
  const s = salesSide(b);
  const notes: string[] = [];
  // 付表2-3
  const taxableNet = map((r) => exclusive(b.sales[r], r) - exclusive(b.salesReturn[r], r)); // ①
  const r1 = sumAB(taxableNet);
  const r4 = r1 + b.exportSales; // ④（③ 非課税資産の輸出等は 0）
  const r7 = r4 + b.nontaxSales; // ⑦
  const ratio = r7 > 0 ? r4 / r7 : 1; // ⑧
  const pay9 = map((r) => b.purchase[r] - b.purchaseReturn[r]);
  const tax10 = map((r) => nationalTaxIn(b.purchase[r], r) - nationalTaxIn(b.purchaseReturn[r], r));
  const pay11 = map((r) => b.transitional.reduce((t, x) => t + x.purchase[r] - x.ret[r], 0));
  const tax12 = map((r) => b.transitional.reduce(
    (t, x) => t + Math.floor(((nationalTaxIn(x.purchase[r], r) - nationalTaxIn(x.ret[r], r)) * x.pct) / 100), 0));
  const total17 = map((r) => tax10[r] + tax12[r]);
  const full = r1 + b.exportSales <= 500_000_000 && ratio >= 0.95;
  const deductible = full ? total17 : map((r) => Math.floor(total17[r] * (r7 > 0 ? r4 / r7 : 1))); // ⑱ または ㉒（一括比例配分方式）
  if (!full) notes.push("課税売上割合が 95% 未満（または課税売上高が5億円超）のため、一括比例配分方式（㉒）で計算しています。個別対応方式には対応していません");
  const r26 = map((r) => Math.max(deductible[r], 0));
  const r27 = map((r) => Math.max(-deductible[r], 0));
  const plus3 = map((r) => r27[r] + s.recovered[r]);
  const subtotal7 = map((r) => r26[r] + s.ret[r] + s.bad[r]);
  const c = { tax: sumAB(s.tax), plus: sumAB(plus3), deduct: sumAB(r26), ret: sumAB(s.ret), bad: sumAB(s.bad) };
  const f = finish(c, o);
  const ratioText = `${(Math.floor(ratio * 10000) / 100).toFixed(2)}%`;
  if (b.transitional.length) notes.push(`経過措置の仕入れは、控除できる割合（${b.transitional.map((t) => `${t.pct}%`).join("・")}）ごとに計算して ⑫ に合計しています`);

  const fuhyo23: TaxForm = {
    id: "2-3", title: "付表2-3 課税売上割合・控除対象仕入税額等の計算表", abc: true,
    rows: [
      abRow("①", "課税売上額（税抜き）", taxableNet, "売上の返還を差し引いた額"),
      { no: "②", label: "免税売上額", c: b.exportSales },
      { no: "③", label: "非課税資産の輸出等の金額、海外支店等へ移送した資産の価額", c: 0 },
      { no: "④", label: "課税資産の譲渡等の対価の額（①＋②＋③）", c: r4, note: "第一表の⑮へ" },
      { no: "⑥", label: "非課税売上額", c: b.nontaxSales },
      { no: "⑦", label: "資産の譲渡等の対価の額（⑤＋⑥）", c: r7, note: "第一表の⑯へ" },
      { no: "⑧", label: "課税売上割合（④／⑦）", c: null, note: ratioText },
      abRow("⑨", "課税仕入れに係る支払対価の額（税込み）", pay9, "インボイスのあるもの。仕入の返還を差し引いた額"),
      abRow("⑩", "課税仕入れに係る消費税額", tax10),
      abRow("⑪", "適格請求書発行事業者以外の者から行った課税仕入れに係る経過措置の適用を受ける課税仕入れに係る支払対価の額（税込み）", pay11),
      abRow("⑫", "適格請求書発行事業者以外の者から行った課税仕入れに係る経過措置により課税仕入れに係る消費税額とみなされる額", tax12),
      abRow("⑰", "課税仕入れ等の税額の合計額（⑩＋⑫＋⑭＋⑮±⑯）", total17),
      full
        ? abRow("⑱", "課税売上高が5億円以下、かつ、課税売上割合が95%以上の場合（⑰の金額）", total17)
        : abRow("㉒", "一括比例配分方式により控除する課税仕入れ等の税額（⑰×④／⑦）", deductible),
      abRow("㉖", "差引・控除対象仕入税額", r26, "付表1-3の④へ"),
      abRow("㉗", "差引・控除過大調整税額", r27, "付表1-3の③へ"),
      abRow("㉘", "貸倒回収に係る消費税額", s.recovered, "付表1-3の③へ"),
    ],
  };
  const fuhyo13: TaxForm = {
    id: "1-3", title: "付表1-3 税率別消費税額計算表 兼 地方消費税の課税標準となる消費税額計算表", abc: true,
    rows: [
      abRow("①-1", "課税資産の譲渡等の対価の額", s.price, "第二表の⑤⑥⑦へ"),
      abRow("①", "課税標準額（千円未満切り捨て）", s.base, "第二表の①へ"),
      abRow("②", "消費税額", s.tax, "第二表の⑪⑮⑯へ"),
      abRow("③", "控除過大調整税額", plus3, "第一表の③へ"),
      abRow("④", "控除対象仕入税額", r26, "第一表の④へ"),
      abRow("⑤", "返還等対価に係る税額", s.ret, "第二表の⑰へ"),
      abRow("⑤-1", "売上げの返還等対価に係る税額", s.ret, "第二表の⑱へ"),
      abRow("⑥", "貸倒れに係る税額", s.bad, "第一表の⑥へ"),
      abRow("⑦", "控除税額小計（④＋⑤＋⑥）", subtotal7, "第一表の⑦へ"),
      { no: "⑧", label: "控除不足還付税額（⑦－②－③）", c: f.shortfall, note: "第一表の⑧へ" },
      { no: "⑨", label: "差引税額（②＋③－⑦。百円未満切り捨て）", c: f.net, note: "第一表の⑨へ" },
      { no: "⑩", label: "地方消費税の課税標準となる消費税額・控除不足還付税額", c: f.shortfall, note: "第一表の⑰へ" },
      { no: "⑪", label: "地方消費税の課税標準となる消費税額・差引税額", c: f.net, note: "第一表の⑱へ" },
      { no: "⑫", label: "譲渡割額・還付額", c: f.localRefund, note: "第一表の⑲へ" },
      { no: "⑬", label: "譲渡割額・納税額", c: f.localTax, note: "第一表の⑳へ" },
    ],
  };
  const extra: FormRow[] = [
    { no: "⑮", label: "課税売上割合・課税資産の譲渡等の対価の額", c: r4 },
    { no: "⑯", label: "課税売上割合・資産の譲渡等の対価の額", c: r7 },
  ];
  return {
    method: "standard",
    forms: [fuhyo23, fuhyo13, secondTable(s, sumAB(s.ret), f.net - f.shortfall, "（一般用）"), firstTable("一般用", sumAB(s.base), c, f, o, extra, null)],
    national: f.national, local: f.local, total: f.total, notes,
  };
};

// ────────────────────────────────────────────
// 簡易課税（付表4-3・5-3）。事業区分は1種類（年度の「主な事業区分」）
// ────────────────────────────────────────────
export const simplifiedReturn = (b: TaxBase, o: ReturnOptions): TaxReturn => {
  const s = salesSide(b);
  const cls = BUSINESS_CLASSES.find((x) => x.value === o.businessClass) ?? BUSINESS_CLASSES[4];
  const basis = map((r) => s.tax[r] + s.recovered[r] - s.ret[r]); // 付表5-3 ④
  const deduct = map((r) => Math.max(Math.floor((basis[r] * cls.rate) / 100), 0)); // 付表5-3 ⑤
  const subtotal = map((r) => deduct[r] + s.ret[r] + s.bad[r]);
  const c = { tax: sumAB(s.tax), plus: sumAB(s.recovered), deduct: sumAB(deduct), ret: sumAB(s.ret), bad: sumAB(s.bad) };
  const f = finish(c, o);
  // この課税期間の課税売上高（税抜き。返還を差し引き、免税売上を足す）
  const salesNet = map((r) => exclusive(b.sales[r], r) - exclusive(b.salesReturn[r], r));
  const periodSales = sumAB(salesNet) + b.exportSales;

  const fuhyo53: TaxForm = {
    id: "5-3", title: "付表5-3 控除対象仕入税額等の計算表", abc: true,
    rows: [
      abRow("①", "課税標準額に対する消費税額", s.tax, "付表4-3の②から"),
      abRow("②", "貸倒回収に係る消費税額", s.recovered, "付表4-3の③から"),
      abRow("③", "売上対価の返還等に係る消費税額", s.ret, "付表4-3の⑤から"),
      abRow("④", "控除対象仕入税額の計算の基礎となる消費税額（①＋②－③）", basis),
      abRow("⑤", `１種類の事業の専業者の場合の控除対象仕入税額（④ × みなし仕入率 ${cls.rate}%）`, deduct, `${cls.label}。付表4-3の④へ`),
    ],
  };
  const fuhyo43: TaxForm = {
    id: "4-3", title: "付表4-3 税率別消費税額計算表 兼 地方消費税の課税標準となる消費税額計算表", abc: true,
    rows: [
      abRow("①-1", "課税資産の譲渡等の対価の額", s.price, "第二表の⑤⑥⑦へ"),
      abRow("①", "課税標準額（千円未満切り捨て）", s.base, "第二表の①へ"),
      abRow("②", "消費税額", s.tax, "第二表の⑪⑮⑯へ"),
      abRow("③", "貸倒回収に係る消費税額", s.recovered, "第一表の③へ"),
      abRow("④", "控除対象仕入税額", deduct, "付表5-3の⑤から。第一表の④へ"),
      abRow("⑤", "返還等対価に係る税額", s.ret, "第二表の⑰⑱へ"),
      abRow("⑥", "貸倒れに係る税額", s.bad, "第一表の⑥へ"),
      abRow("⑦", "控除税額小計（④＋⑤＋⑥）", subtotal, "第一表の⑦へ"),
      { no: "⑧", label: "控除不足還付税額（⑦－②－③）", c: f.shortfall, note: "第一表の⑧へ" },
      { no: "⑨", label: "差引税額（②＋③－⑦。百円未満切り捨て）", c: f.net, note: "第一表の⑨へ" },
      { no: "⑩", label: "地方消費税の課税標準となる消費税額・控除不足還付税額", c: f.shortfall, note: "第一表の⑰へ" },
      { no: "⑪", label: "地方消費税の課税標準となる消費税額・差引税額", c: f.net, note: "第一表の⑱へ" },
      { no: "⑫", label: "譲渡割額・還付額", c: f.localRefund, note: "第一表の⑲へ" },
      { no: "⑬", label: "譲渡割額・納税額", c: f.localTax, note: "第一表の⑳へ" },
    ],
  };
  const extra: FormRow[] = [
    { no: "⑮", label: "この課税期間の課税売上高", c: periodSales, note: "税抜き。返還を差し引き、免税売上を足した額" },
    { no: "", label: `参考事項・事業区分（${cls.label}）の課税売上高`, c: Math.round(sumAB(salesNet) / 1000), note: "千円単位（千円未満四捨五入）。売上割合 100%" },
  ];
  return {
    method: "simplified",
    forms: [fuhyo53, fuhyo43, secondTable(s, sumAB(s.ret), f.net - f.shortfall, "（簡易課税用）"), firstTable("簡易課税用", sumAB(s.base), c, f, o, extra, null)],
    national: f.national, local: f.local, total: f.total,
    notes: ["事業区分が1種類（年度の「主な事業区分」）として計算しています。2種類以上の事業がある場合の計算には、まだ対応していません"],
  };
};

// ────────────────────────────────────────────
// 2割特例・3割特例（付表6）
// ────────────────────────────────────────────
const specialReturn = (b: TaxBase, o: ReturnOptions, method: "twenty" | "thirty", firstKind: "一般用" | "簡易課税用"): TaxReturn => {
  const s = salesSide(b);
  const pct = method === "twenty" ? 80 : 70;
  const basis = map((r) => s.tax[r] + s.recovered[r] - s.ret[r]); // ⑥
  const special = map((r) => Math.max(Math.floor((basis[r] * pct) / 100), 0)); // ⑦
  const c = { tax: sumAB(s.tax), plus: sumAB(s.recovered), deduct: sumAB(special), ret: sumAB(s.ret), bad: sumAB(s.bad) };
  const f = finish(c, o);
  const label = METHOD_LABEL[method];
  const fuhyo6: TaxForm = {
    id: "6", abc: true,
    title: `付表6 税率別消費税額計算表〔${method === "twenty" ? "小規模事業者" : "小規模個人事業者"}に係る税額控除に関する経過措置を適用する課税期間用〕`,
    rows: [
      abRow("①", "課税資産の譲渡等の対価の額", s.price, "第二表の⑤⑥⑦へ"),
      abRow("②", "課税標準額（千円未満切り捨て）", s.base, "第二表の①へ"),
      abRow("③", "課税標準額に対する消費税額", s.tax, "第二表の⑪⑮⑯へ"),
      abRow("④", "貸倒回収に係る消費税額", s.recovered, "第一表の③へ"),
      abRow("⑤", "売上対価の返還等に係る消費税額", s.ret, "第二表の⑰⑱へ"),
      abRow("⑥", "控除対象仕入税額の計算の基礎となる消費税額（③＋④－⑤）", basis),
      abRow("⑦", `特別控除税額（⑥ × ${pct}%）`, special, "第一表の④へ"),
      abRow("⑧", "貸倒れに係る税額", s.bad, "第一表の⑥へ"),
    ],
  };
  return {
    method,
    forms: [fuhyo6, secondTable(s, sumAB(s.ret), f.net - f.shortfall, ""), firstTable(firstKind, sumAB(s.base), c, f, o, [], label)],
    national: f.national, local: f.local, total: f.total,
    notes: [
      `第一表は、簡易課税制度選択届出書を出していれば簡易課税用、出していなければ一般用を使います（欄の番号は同じ。③の名前だけ違います）。${label}では「この課税期間の課税売上高」と事業区分は書きません`,
      `付表6 は${method === "twenty" ? "令和5年10月1日以後終了課税期間用" : "令和8年10月1日以後開始する課税期間用（3割特例）"}の様式です`,
    ],
  };
};

export const twentyReturn = (b: TaxBase, o: ReturnOptions, firstKind: "一般用" | "簡易課税用" = "一般用") => specialReturn(b, o, "twenty", firstKind);
export const thirtyReturn = (b: TaxBase, o: ReturnOptions, firstKind: "一般用" | "簡易課税用" = "一般用") => specialReturn(b, o, "thirty", firstKind);

/** その年に使える方式（2割特例は令和8年分まで、3割特例は令和9年分・令和10年分） */
export const methodsFor = (year: number): ReturnMethod[] => [
  "standard", "simplified", ...(year >= 2023 && year <= 2026 ? (["twenty"] as const) : []), ...(year >= 2027 && year <= 2028 ? (["thirty"] as const) : []),
];

export const computeReturn = (method: ReturnMethod, b: TaxBase, o: ReturnOptions): TaxReturn =>
  method === "standard" ? standardReturn(b, o) : method === "simplified" ? simplifiedReturn(b, o) : method === "twenty" ? twentyReturn(b, o) : thirtyReturn(b, o);
