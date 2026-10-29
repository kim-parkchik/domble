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
 * 本則課税で課税売上割合が 95% 未満（または課税売上高が5億円超）なら、個別対応方式（⑲⑳㉑。課税仕入の用途区分ごと）か一括比例配分方式（㉒）
 * 棚卸資産の調整（付表2-3 ⑯。消法36条・No.6491）：免税事業者から課税事業者になる年は、前日に持っていた棚卸資産のうち免税の期間に仕入れたものの税額を加算、
 *   課税事業者から免税事業者になる前の年は、その年に仕入れて年末に残っている棚卸資産の税額を減算する。取得価額（税込）× 7.8/110・6.24/108（経過措置の仕入れは控除できる割合を掛ける）。
 *   棚卸資産は課税売上げにのみ要するもの（個別対応方式の ⑲）として扱う。本則課税だけ（簡易課税・2割特例は調整しない）
 * 課税売上割合に準ずる割合・特定課税仕入れ・課税貨物・調整対象固定資産の調整・旧税率には対応していない
 */
import type { Account, DeductionMethod, PurchaseUse, TaxYear } from "./types";
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
  /** 簡易課税の事業区分ごとの課税売上とその返還（1〜6。0 = 区分が分からない売上） */
  byClass: Record<number, { sales: Record<Rate, number>; ret: Record<Rate, number> }>;
  /** 本則課税の用途区分ごとの課税仕入（インボイスのあるもの・経過措置。区分の無い課税仕入は共通対応） */
  byUse?: Record<PurchaseUse, PurchaseGroup>;
  /** 用途区分の無い課税仕入とその返還の額（税込。共通対応として計算したもの） */
  useUnknown?: number;
}

/** 課税仕入とその返還（インボイスのあるもの・経過措置の控除できる割合ごと） */
export interface PurchaseGroup {
  purchase: Record<Rate, number>;
  ret: Record<Rate, number>;
  transitional: { pct: number; purchase: Record<Rate, number>; ret: Record<Rate, number> }[];
}

const zero = (): Record<Rate, number> => ({ 8: 0, 10: 0 });

/**
 * @param classOf 課税売上の明細の事業区分（ふつうは明細に記録した区分。null = 分からない）
 */
export const buildTaxBase = (lines: FlatLine[], taxYears: TaxYear[], classOf: (l: FlatLine) => number | null = (l) => l.business_class ?? null): TaxBase => {
  const group = (): PurchaseGroup => ({ purchase: zero(), ret: zero(), transitional: [] });
  const byUse: Record<PurchaseUse, PurchaseGroup> = { taxable: group(), common: group(), nontaxable: group() };
  const b: TaxBase = {
    sales: zero(), salesReturn: zero(), badDebt: zero(), badDebtRecovered: zero(), exportSales: 0, nontaxSales: 0,
    purchase: zero(), purchaseReturn: zero(), transitional: [], byClass: {}, byUse, useUnknown: 0,
  };
  const addTransitional = (list: PurchaseGroup["transitional"], pct: number, rate: Rate, dr: boolean, amount: number) => {
    let t = list.find((x) => x.pct === pct);
    if (!t) list.push((t = { pct, purchase: zero(), ret: zero() }));
    (dr ? t.purchase : t.ret)[rate] += amount;
  };
  for (const l of lines) {
    if (l.is_deleted || !l.tax_code || l.tax_code === "none" || !taxActiveOn(taxYears, l.date)) continue;
    const def = taxCodeDef(l.tax_code);
    const rate = def.rate as Rate;
    const dr = l.side === "debit";
    if (l.tax_code === "export") b.exportSales += dr ? -l.amount : l.amount;
    else if (l.tax_code === "sales_nontax") b.nontaxSales += dr ? -l.amount : l.amount;
    else if (l.tax_code === "baddebt10" || l.tax_code === "baddebt8") (dr ? b.badDebt : b.badDebtRecovered)[rate] += l.amount;
    else if (def.group === "sales") {
      (dr ? b.salesReturn : b.sales)[rate] += l.amount;
      const k = classOf(l) ?? 0;
      const x = (b.byClass[k] ??= { sales: zero(), ret: zero() });
      (dr ? x.ret : x.sales)[rate] += l.amount;
    }
    else if (isPurchaseCode(l.tax_code)) {
      const inv = l.invoice_kind ?? "qualified";
      if (inv === "none") continue;
      const u = byUse[l.purchase_use ?? "common"];
      if (!l.purchase_use) b.useUnknown! += l.amount;
      if (inv === "qualified") {
        (dr ? b.purchase : b.purchaseReturn)[rate] += l.amount;
        (dr ? u.purchase : u.ret)[rate] += l.amount;
      } else {
        const pct = transitionalRate(l.date);
        addTransitional(b.transitional, pct, rate, dr, l.amount);
        addTransitional(u.transitional, pct, rate, dr, l.amount);
      }
    }
  }
  b.transitional.sort((x, y) => y.pct - x.pct);
  for (const u of Object.values(byUse)) u.transitional.sort((x, y) => y.pct - x.pct);
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
  /** 欄の番号の無い行（第一表の参考事項など）を見分ける名前（e-Tax の書き出しで使う） */
  key?: string;
  /** 区分の欄（付表5-3 の ⑤・㉑ の事業区分 1〜6） */
  kubun?: number;
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

export type FirstKind = "一般用" | "簡易課税用";

export interface TaxReturn {
  method: ReturnMethod;
  /** 第一表・第二表の種類 */
  firstKind: FirstKind;
  forms: TaxForm[];
  /** 差引税額 ⑨（中間申告の判定に使う「確定消費税額」。地方消費税は含まない） */
  net: number;
  /** 消費税（国税）：納付税額 ⑪ − 還付（⑧＋⑫） */
  national: number;
  /** 地方消費税：納付譲渡割額 ㉒ − 還付（⑲＋㉓） */
  local: number;
  /** 消費税及び地方消費税の合計（納付又は還付）税額 ㉖（還付はマイナス） */
  total: number;
  notes: string[];
  /** 本則課税で課税売上割合が 95% 未満のとき：控除の方式（使ったもの）と、方式ごとの控除する課税仕入れ等の税額（合計） */
  deduction?: { method: DeductionMethod; amounts: Record<DeductionMethod, number> };
}

/** 棚卸資産の調整（付表2-3 ⑯）。add = 加算（免税から課税になった年）／ sub = 減算（課税から免税になる前の年） */
export interface InventoryAdjust {
  direction: "add" | "sub";
  /** 税率・控除できる割合（100 = 全額。経過措置は 80・70・50・30）ごとの取得価額（税込） */
  rows: { rate: Rate; pct: number; amount: number }[];
}

/** 棚卸資産の調整の税額（税率ごと。減算はマイナス） */
export const inventoryAdjustTax = (adj: InventoryAdjust | null | undefined): Record<Rate, number> => {
  const sign = adj?.direction === "sub" ? -1 : 1;
  const at = (r: Rate) => (adj?.rows ?? []).filter((x) => x.rate === r).reduce((t, x) => t + Math.floor((nationalTaxIn(x.amount, r) * x.pct) / 100), 0);
  return { 8: sign * at(8), 10: sign * at(10) };
};

/**
 * 帳簿の期首・期末の棚卸高（調整の取得価額の初めの額）。期首商品棚卸高・期末商品棚卸高の科目にあればその額、無ければ棚卸資産の科目の期首・期末残高
 * opening = 期首残高、end = 期末残高（科目の残高の側で）
 */
export const inventoryOf = (accounts: Account[], opening: (a: Account) => number, end: (a: Account) => number) => {
  const by = (code: string) => accounts.find((a) => a.code === code);
  const stock = by("113");
  const pick = (code: string, fallback: number) => {
    const a = by(code);
    const v = a ? end(a) : 0;
    return v || fallback;
  };
  return { opening: pick("501", stock ? opening(stock) : 0), closing: pick("503", stock ? end(stock) : 0) };
};

export interface ReturnOptions {
  /** 簡易課税の事業区分（1〜6） */
  businessClass: number;
  /** 中間納付税額（消費税・地方消費税） */
  interimNational: number;
  interimLocal: number;
  /** 基準期間の課税売上高（分からなければ null。第一表に書く） */
  baseSales?: number | null;
  /** 本則課税で課税売上割合が 95% 未満のときの控除の方式（既定は個別対応方式） */
  deduction?: DeductionMethod;
  /** 棚卸資産の調整（本則課税の付表2-3 ⑯） */
  inventory?: InventoryAdjust | null;
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

/** 経過措置の仕入れの税額（控除できる割合ごとに計算して合計。付表2-3 の ⑫） */
const transitionalTax = (list: PurchaseGroup["transitional"], r: Rate) =>
  list.reduce((t, x) => t + Math.floor(((nationalTaxIn(x.purchase[r], r) - nationalTaxIn(x.ret[r], r)) * x.pct) / 100), 0);

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
  kind: FirstKind, base: number, c: { tax: number; plus: number; deduct: number; ret: number; bad: number }, f: ReturnType<typeof finish>,
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
    kind === "簡易課税用"
      ? { no: "⑯", key: "baseSales", label: "基準期間の課税売上高", c: o.baseSales ?? null, note: o.baseSales == null ? "分かりません（事業者設定の「消費税」で入れられます）" : undefined }
      : { no: "", key: "baseSales", label: "参考事項・基準期間の課税売上高", c: o.baseSales ?? null, note: o.baseSales == null ? "分かりません（事業者設定の「消費税」で入れられます）" : "千円単位の欄" },
    { no: "⑰", label: "地方消費税の課税標準となる消費税額・控除不足還付税額", c: f.shortfall },
    { no: "⑱", label: "地方消費税の課税標準となる消費税額・差引税額", c: f.net },
    { no: "⑲", label: "譲渡割額・還付額（⑰ × 22/78）", c: f.localRefund },
    { no: "⑳", label: "譲渡割額・納税額（⑱ × 22/78。百円未満切り捨て）", c: f.localTax },
    { no: "㉑", label: "中間納付譲渡割額", c: o.interimLocal },
    { no: "㉒", label: "納付譲渡割額（⑳－㉑）", c: f.localPay },
    { no: "㉓", label: "中間納付還付譲渡割額（㉑－⑳）", c: f.localInterimRefund },
    { no: "㉖", label: "消費税及び地方消費税の合計（納付又は還付）税額", c: f.total, note: "（⑪＋㉒）－（⑧＋⑫＋⑲＋㉓）。還付はマイナス" },
    ...(twentyLike ? [{ no: "", key: "special", label: `税額控除に係る経過措置の適用（${twentyLike}）`, c: null, note: "○ をつける" }] : []),
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
  const tax12 = map((r) => transitionalTax(b.transitional, r));
  const adj16 = inventoryAdjustTax(o.inventory);
  const total17 = map((r) => tax10[r] + tax12[r] + adj16[r]);
  const full = r1 + b.exportSales <= 500_000_000 && ratio >= 0.95;
  // 個別対応方式：⑲ 課税対応の税額、⑳ 共通対応の税額、㉑ ⑲ ＋ ⑳ × ④／⑦（非課税対応は控除しない）
  const useTax = (g: PurchaseGroup | undefined) =>
    map((r) => (g ? nationalTaxIn(g.purchase[r], r) - nationalTaxIn(g.ret[r], r) + transitionalTax(g.transitional, r) : 0));
  // 棚卸資産の調整は課税対応（⑲）に入れる
  const r19 = map((r) => useTax(b.byUse?.taxable)[r] + adj16[r]);
  const r20 = useTax(b.byUse?.common ?? { purchase: map((r) => b.purchase[r]), ret: map((r) => b.purchaseReturn[r]), transitional: b.transitional });
  const r21 = map((r) => r19[r] + (r7 > 0 ? mulDiv(r20[r], r4, r7) : r20[r]));
  const r22 = map((r) => (r7 > 0 ? mulDiv(total17[r], r4, r7) : total17[r])); // 一括比例配分方式：⑰ × ④／⑦
  const method: DeductionMethod = o.deduction ?? "individual";
  const deductible = full ? total17 : method === "individual" ? r21 : r22; // ⑱・㉑・㉒
  const pct2 = (x: number) => (Math.floor(x * 10000) / 100).toFixed(2);
  if (!full) {
    notes.push(`課税売上割合が 95% 未満（または課税売上高が5億円超）のため、${method === "individual" ? "個別対応方式（⑲⑳㉑）" : "一括比例配分方式（㉒）"}で計算しています（事業者設定の「消費税」の控除の方式）`);
    if (method === "individual" && (b.useUnknown ?? 0) !== 0) {
      notes.push(`用途区分の入っていない課税仕入（税込 ${(b.useUnknown ?? 0).toLocaleString()}円）は、共通対応として計算しています`);
    }
  }
  const r26 = map((r) => Math.max(deductible[r], 0));
  const r27 = map((r) => Math.max(-deductible[r], 0));
  const plus3 = map((r) => r27[r] + s.recovered[r]);
  const subtotal7 = map((r) => r26[r] + s.ret[r] + s.bad[r]);
  const c = { tax: sumAB(s.tax), plus: sumAB(plus3), deduct: sumAB(r26), ret: sumAB(s.ret), bad: sumAB(s.bad) };
  const f = finish(c, o);
  const ratioText = `${pct2(ratio)}%`;
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
      ...(sumAB(adj16) || adj16[8] || adj16[10]
        ? [abRow("⑯", "納税義務の免除を受けない（受ける）こととなった場合における消費税額の調整（加算又は減算）額", adj16, o.inventory?.direction === "sub" ? "減算（課税事業者から免税事業者になる前の年）" : "加算（免税事業者から課税事業者になった年）")]
        : []),
      abRow("⑰", "課税仕入れ等の税額の合計額（⑩＋⑫＋⑭＋⑮±⑯）", total17),
      ...(full
        ? [abRow("⑱", "課税売上高が5億円以下、かつ、課税売上割合が95%以上の場合（⑰の金額）", total17)]
        : method === "individual"
          ? [
            abRow("⑲", "⑰のうち、課税売上げにのみ要するもの", r19, "課税対応"),
            abRow("⑳", "⑰のうち、課税売上げと非課税売上げに共通して要するもの", r20, "共通対応"),
            abRow("㉑", "個別対応方式により控除する課税仕入れ等の税額（⑲＋⑳×④／⑦）", r21),
          ]
          : [abRow("㉒", "一括比例配分方式により控除する課税仕入れ等の税額（⑰×④／⑦）", r22)]),
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
    method: "standard", firstKind: "一般用",
    ...(full ? {} : { deduction: { method, amounts: { individual: sumAB(r21), lump: sumAB(r22) } } }),
    forms: [fuhyo23, fuhyo13, secondTable(s, sumAB(s.ret), f.net - f.shortfall, "（一般用）"), firstTable("一般用", sumAB(s.base), c, f, o, extra, null)],
    net: f.net, national: f.national, local: f.local, total: f.total, notes,
  };
};

// ────────────────────────────────────────────
// 簡易課税（付表4-3・5-3）
//  事業区分が1種類なら ⑤（④ × みなし仕入率）。2種類以上なら ⑥〜⑲ で区分ごとの売上と税額を出し、
//  ⑳ 原則計算、㉑ 1種類で75%以上、㉒〜㊱ 2種類で75%以上 のうち、合計（C）がいちばん多いものを ㊲ に選ぶ
//  （適用税率ごとに違う計算方法は選べない）。各区分の税額 × みなし仕入率 は 1 円未満をその都度切り捨てる
// ────────────────────────────────────────────
const CLASSES = [1, 2, 3, 4, 5, 6] as const;
const CLASS_RATE: Record<number, number> = Object.fromEntries(BUSINESS_CLASSES.map((c) => [c.value, c.rate]));
const CLASS_NAME: Record<number, string> = { 1: "第一種事業（卸売業）", 2: "第二種事業（小売業等）", 3: "第三種事業（製造業等）", 4: "第四種事業（その他）", 5: "第五種事業（サービス業等）", 6: "第六種事業（不動産業）" };
const SALES_ROW = ["", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];
const TAX_ROW = ["", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲"];
/** 2種類で75%以上の欄（第i種及び第j種） */
const PAIR_ROW: Record<string, string> = {
  "1-2": "㉒", "1-3": "㉓", "1-4": "㉔", "1-5": "㉕", "1-6": "㉖", "2-3": "㉗", "2-4": "㉘", "2-5": "㉙", "2-6": "㉚",
  "3-4": "㉛", "3-5": "㉜", "3-6": "㉝", "4-5": "㉞", "4-6": "㉟", "5-6": "㊱",
};
/** a × b ÷ c の 1 円未満切り捨て（大きな金額でも誤差が出ないように整数で） */
const mulDiv = (a: number, b: number, c: number) => (c === 0 ? 0 : Number((BigInt(a) * BigInt(b)) / BigInt(c)));
const pct = (n: number, rate: number) => Math.floor((n * rate) / 100);
/** 売上割合（表示用。小数第1位未満切り捨て） */
const shareText = (x: number, total: number) => (total > 0 ? `${(Math.floor((x / total) * 1000) / 10).toFixed(1)}%` : "—");

export interface ClassCalc {
  /** 計算式の欄（⑳、㉑、㉒…） */
  no: string;
  label: string;
  value: AB;
  /** ㉑ の事業区分 */
  cls?: number;
}

/**
 * 区分が分からない売上（byClass[0]）を、その年の売上に出てくる区分のうちみなし仕入率がいちばん低い区分に入れる
 * （2種類以上の事業で区分していない売上は、いちばん低い率の事業の売上として計算する決まり。施行令57条④）。
 * 区分の分かる売上が1つも無ければ fallback（年度の「主な事業区分」）に入れる
 */
export const assignUnknownClass = (b: TaxBase, fallback: number): { base: TaxBase; unknownTo: number | null; usedFallback: boolean } => {
  const unknown = b.byClass[0];
  if (!unknown || (sumAB(unknown.sales) === 0 && sumAB(unknown.ret) === 0)) return { base: b, unknownTo: null, usedFallback: false };
  const known = CLASSES.filter((c) => b.byClass[c] && (sumAB(b.byClass[c].sales) !== 0 || sumAB(b.byClass[c].ret) !== 0));
  const to = known.length ? known.reduce((low, c) => (CLASS_RATE[c] < CLASS_RATE[low] ? c : low)) : fallback;
  const byClass = { ...b.byClass };
  delete byClass[0];
  const t = byClass[to] ?? { sales: zero(), ret: zero() };
  byClass[to] = { sales: map((r) => t.sales[r] + unknown.sales[r]), ret: map((r) => t.ret[r] + unknown.ret[r]) };
  return { base: { ...b, byClass }, unknownTo: to, usedFallback: known.length === 0 };
};

/** 付表5-3 の 2種類以上の計算（⑥〜㊲） */
export const multiClassDeduction = (b: TaxBase, basis: AB) => {
  const present = CLASSES.filter((c) => b.byClass[c] && (sumAB(b.byClass[c].sales) !== 0 || sumAB(b.byClass[c].ret) !== 0));
  const netOf = (c: number) => map((r) => exclusive(b.byClass[c].sales[r], r) - exclusive(b.byClass[c].ret[r], r));
  const taxOf = (c: number) => map((r) => nationalTaxIn(b.byClass[c].sales[r], r) - nationalTaxIn(b.byClass[c].ret[r], r));
  const net = Object.fromEntries(present.map((c) => [c, netOf(c)])) as Record<number, AB>;
  const tax = Object.fromEntries(present.map((c) => [c, taxOf(c)])) as Record<number, AB>;
  const total6 = map((r) => present.reduce((t, c) => t + net[c][r], 0));
  const total13 = map((r) => present.reduce((t, c) => t + tax[c][r], 0));
  const share = (c: number) => (sumAB(total6) > 0 ? sumAB(net[c]) / sumAB(total6) : 0);
  const fix = (v: AB): AB => map((r) => Math.max(v[r], 0));

  const calcs: ClassCalc[] = [];
  // ⑳ 原則計算：④ ×（⑭×90%＋⑮×80%＋…）／⑬
  calcs.push({
    no: "⑳", label: "原則計算を適用する場合（④ × みなし仕入率 ／ ⑬）",
    value: fix(map((r) => mulDiv(basis[r], present.reduce((t, c) => t + pct(tax[c][r], CLASS_RATE[c]), 0), total13[r]))),
  });
  // ㉑ 1種類の事業で75%以上
  const major = present.find((c) => share(c) >= 0.75);
  if (major) calcs.push({ no: "㉑", cls: major, label: `特例計算・1種類の事業で75%以上（${CLASS_NAME[major]}。④ × ${CLASS_RATE[major]}%）`, value: fix(map((r) => pct(basis[r], CLASS_RATE[major]))) });
  // ㉒〜㊱ 2種類の事業で75%以上：④ ×（第i種の税額 × i のみなし仕入率 ＋（⑬ － 第i種の税額）× j のみなし仕入率）／⑬
  for (const i of present) {
    for (const j of present) {
      if (j <= i || share(i) + share(j) < 0.75) continue;
      calcs.push({
        no: PAIR_ROW[`${i}-${j}`], label: `特例計算・2種類の事業で75%以上（${classLabelShort(i)}及び${classLabelShort(j)}）`,
        value: fix(map((r) => mulDiv(basis[r], pct(tax[i][r], CLASS_RATE[i]) + pct(total13[r] - tax[i][r], CLASS_RATE[j]), total13[r]))),
      });
    }
  }
  const chosen = calcs.reduce((best, x) => (sumAB(x.value) > sumAB(best.value) ? x : best), calcs[0]);
  return { present, net, tax, total6, total13, share, calcs, chosen };
};
const classLabelShort = (c: number) => CLASS_NAME[c].replace(/（.*）/, "");

export const simplifiedReturn = (input: TaxBase, o: ReturnOptions): TaxReturn => {
  const { base: b, unknownTo, usedFallback } = assignUnknownClass(input, o.businessClass);
  const s = salesSide(b);
  const basis = map((r) => s.tax[r] + s.recovered[r] - s.ret[r]); // 付表5-3 ④
  const multi = multiClassDeduction(b, basis);
  const single = multi.present.length <= 1;
  const onlyClass = multi.present[0] ?? o.businessClass;
  const cls = BUSINESS_CLASSES.find((x) => x.value === onlyClass) ?? BUSINESS_CLASSES[4];
  const deduct = single ? map((r) => Math.max(pct(basis[r], cls.rate), 0)) : multi.chosen.value; // 付表5-3 ⑤ または ㊲
  const subtotal = map((r) => deduct[r] + s.ret[r] + s.bad[r]);
  const c = { tax: sumAB(s.tax), plus: sumAB(s.recovered), deduct: sumAB(deduct), ret: sumAB(s.ret), bad: sumAB(s.bad) };
  const f = finish(c, o);
  // この課税期間の課税売上高（税抜き。返還を差し引き、免税売上を足す）
  const salesNet = map((r) => exclusive(b.sales[r], r) - exclusive(b.salesReturn[r], r));
  const periodSales = sumAB(salesNet) + b.exportSales;

  const head: FormRow[] = [
    abRow("①", "課税標準額に対する消費税額", s.tax, "付表4-3の②から"),
    abRow("②", "貸倒回収に係る消費税額", s.recovered, "付表4-3の③から"),
    abRow("③", "売上対価の返還等に係る消費税額", s.ret, "付表4-3の⑤から"),
    abRow("④", "控除対象仕入税額の計算の基礎となる消費税額（①＋②－③）", basis),
  ];
  const fuhyo53: TaxForm = {
    id: "5-3", title: "付表5-3 控除対象仕入税額等の計算表", abc: true,
    rows: single
      ? [...head, { ...abRow("⑤", `１種類の事業の専業者の場合の控除対象仕入税額（④ × みなし仕入率 ${cls.rate}%）`, deduct, `${cls.label}。付表4-3の④へ`), kubun: cls.value }]
      : [
        ...head,
        abRow("⑥", "事業区分別の課税売上高（税抜き）の合計額", multi.total6, "売上割合 100%"),
        ...multi.present.map((k) => abRow(SALES_ROW[k], `${CLASS_NAME[k]}の課税売上高（税抜き）`, multi.net[k], `売上割合 ${shareText(sumAB(multi.net[k]), sumAB(multi.total6))}。第一表の「事業区分」欄へ`)),
        abRow("⑬", "事業区分別の課税売上高に係る消費税額の合計額", multi.total13),
        ...multi.present.map((k) => abRow(TAX_ROW[k], `${CLASS_NAME[k]}の消費税額`, multi.tax[k], `みなし仕入率 ${CLASS_RATE[k]}%`)),
        ...multi.calcs.map((x) => ({ ...abRow(x.no, x.label, x.value, x === multi.chosen ? "いちばん多い（㊲ に選ぶ）" : undefined), kubun: x.cls })),
        abRow("㊲", "上記の計算式区分から選択した控除対象仕入税額", deduct, `${multi.chosen.no} を選択。付表4-3の④へ`),
      ],
  };
  const fuhyo43: TaxForm = {
    id: "4-3", title: "付表4-3 税率別消費税額計算表 兼 地方消費税の課税標準となる消費税額計算表", abc: true,
    rows: [
      abRow("①-1", "課税資産の譲渡等の対価の額", s.price, "第二表の⑤⑥⑦へ"),
      abRow("①", "課税標準額（千円未満切り捨て）", s.base, "第二表の①へ"),
      abRow("②", "消費税額", s.tax, "第二表の⑪⑮⑯へ"),
      abRow("③", "貸倒回収に係る消費税額", s.recovered, "第一表の③へ"),
      abRow("④", "控除対象仕入税額", deduct, `付表5-3の${single ? "⑤" : "㊲"}から。第一表の④へ`),
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
  // 第一表の参考事項：事業区分ごとの課税売上高（千円未満四捨五入）と売上割合、特例計算（令57③）の適用
  const classRows: FormRow[] = single
    ? [{ no: "", key: `class${cls.value}`, label: `参考事項・事業区分（${cls.label}）の課税売上高（千円）`, c: Math.round(sumAB(salesNet) / 1000), note: "千円未満四捨五入。売上割合 100%" }]
    : [
      ...multi.present.map((k) => ({
        no: "", key: `class${k}`, label: `参考事項・事業区分（${classLabelShort(k)}）の課税売上高（千円）`, c: Math.round(sumAB(multi.net[k]) / 1000),
        note: `千円未満四捨五入。売上割合 ${shareText(sumAB(multi.net[k]), sumAB(multi.total6))}`,
      })),
      { no: "", key: "rule57", label: "参考事項・特例計算適用（令57③）", c: null, note: multi.chosen.no === "⑳" ? "無" : "有" },
    ];
  const extra: FormRow[] = [
    { no: "⑮", label: "この課税期間の課税売上高", c: periodSales, note: "税抜き。返還を差し引き、免税売上を足した額" },
    ...classRows,
  ];
  const usedClasses = single ? [cls.label] : multi.present.map((k) => CLASS_NAME[k]);
  return {
    method: "simplified", firstKind: "簡易課税用",
    forms: [fuhyo53, fuhyo43, secondTable(s, sumAB(s.ret), f.net - f.shortfall, "（簡易課税用）"), firstTable("簡易課税用", sumAB(s.base), c, f, o, extra, null)],
    net: f.net, national: f.national, local: f.local, total: f.total,
    notes: [
      single
        ? `事業区分は ${cls.label} の1種類として計算しています（付表5-3 の ⑤）`
        : `事業区分が ${usedClasses.length} 種類（${usedClasses.join("・")}）あるので、原則計算と特例計算のうち、控除対象仕入税額がいちばん多い ${multi.chosen.no} を選んでいます`,
      ...(unknownTo !== null
        ? [`事業区分の分からない売上があるため、${classLabelShort(unknownTo)}（${usedFallback ? "主な事業区分" : "その年の売上に出てくる区分のうち、みなし仕入率がいちばん低い区分"}）として計算しています。「確認」から区分を入れてください`]
        : []),
    ],
  };
};

// ────────────────────────────────────────────
// 2割特例・3割特例（付表6）
// ────────────────────────────────────────────
const specialReturn = (b: TaxBase, o: ReturnOptions, method: "twenty" | "thirty", firstKind: FirstKind): TaxReturn => {
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
    method, firstKind,
    forms: [fuhyo6, secondTable(s, sumAB(s.ret), f.net - f.shortfall, ""), firstTable(firstKind, sumAB(s.base), c, f, o, [], label)],
    net: f.net, national: f.national, local: f.local, total: f.total,
    notes: [
      `第一表は、簡易課税制度選択届出書を出していれば簡易課税用、出していなければ一般用を使います（欄の番号は同じ。③の名前だけ違います）。${label}では「この課税期間の課税売上高」と事業区分は書きません`,
      `付表6 は${method === "twenty" ? "令和5年10月1日以後終了課税期間用" : "令和8年10月1日以後開始する課税期間用（3割特例）"}の様式です`,
    ],
  };
};

export const twentyReturn = (b: TaxBase, o: ReturnOptions, firstKind: FirstKind = "一般用") => specialReturn(b, o, "twenty", firstKind);
export const thirtyReturn = (b: TaxBase, o: ReturnOptions, firstKind: FirstKind = "一般用") => specialReturn(b, o, "thirty", firstKind);

/** その年に使える方式（2割特例は令和8年分まで、3割特例は令和9年分・令和10年分） */
export const methodsFor = (year: number): ReturnMethod[] => [
  "standard", "simplified", ...(year >= 2023 && year <= 2026 ? (["twenty"] as const) : []), ...(year >= 2027 && year <= 2028 ? (["thirty"] as const) : []),
];

export const computeReturn = (method: ReturnMethod, b: TaxBase, o: ReturnOptions): TaxReturn =>
  method === "standard" ? standardReturn(b, o) : method === "simplified" ? simplifiedReturn(b, o) : method === "twenty" ? twentyReturn(b, o) : thirtyReturn(b, o);
