/**
 * 総合課税の譲渡所得・一時所得と、損益通算（純粋関数。所得税法22条・33条・34条・69条、所得税法施行令198条・200条。
 * 国税庁 No.3105・No.3152・No.1490・No.2250、確定申告の手引き「総合課税の譲渡所得・一時所得」）
 *  - 譲渡：固定資産台帳で売却した事業用の資産（assetSalesOf）と、台帳に無いもの（手で入れる行）
 *      譲渡所得の金額 ＝ 譲渡価額 −（取得費 ＋ 譲渡費用）− 特別控除額。持っていた期間が5年以内は短期、5年を超えれば長期。
 *      短期と長期は差し引き（内部通算）、特別控除 50万円は短期の譲渡益から先に引く
 *      家事と兼用する資産は事業用の部分だけ（家事用の部分は生活用動産の譲渡で非課税）。税抜経理の年は税抜の額
 *      一括償却資産・10万円未満の資産を売ったときは事業所得（雑収入）で、譲渡所得ではない（No.3105）
 *      生活に通常必要でない資産（ゴルフ会員権・別荘など）の譲渡損失は、ほかの所得から差し引けない（ほかの譲渡益とは差し引ける）
 *  - 一時所得 ＝ 総収入金額 − 収入を得るために支出した金額 − 特別控除額（50万円まで）。損失はほかの所得から差し引けない
 *  - 損益通算（施行令198条）：経常所得の損失 → 譲渡（短期 → 長期）→ 一時、譲渡の損失 → 一時 → 経常所得の順。
 *      長期譲渡所得と一時所得は、損益通算のあとで 1/2 を総所得金額に入れる
 */
import { businessRateIn, depreciationFor, type FixedAsset } from "./depreciation";

const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
const yearOf = (iso: string) => Number(iso.slice(0, 4));

/** 総合課税の譲渡所得の特別控除額（短期・長期あわせて） */
export const TRANSFER_SPECIAL = 500_000;
/** 一時所得の特別控除額 */
export const OCCASIONAL_SPECIAL = 500_000;

/** 固定資産台帳でその年に売却した資産（総合課税の譲渡所得になるもの） */
export interface AssetSale {
  assetId: number;
  name: string;
  /** 資産の種類（科目の名前。例：車両運搬具） */
  kind: string;
  /** 取得日・売却日（YYYY-MM-DD） */
  acquired: string;
  sold: string;
  /** 売った年の事業専用割合（%） */
  rate: number;
  /** 台帳の売却額（税込） */
  salePrice: number;
  /** 譲渡価額（事業用の部分。税抜経理の年は税抜） */
  price: number;
  /** 取得価額のうち事業用の部分（譲渡所得の内訳書の「資産の購入価額」） */
  acquisitionCost: number;
  /** 帳簿価額（売った年の期末の未償却残高。全体） */
  bookValue: number;
  /** 取得費（帳簿価額のうち事業用の部分） */
  cost: number;
  /** 不動産所得の資産 */
  realEstate: boolean;
}

/**
 * その年に売却した資産を、譲渡所得の計算に使う形にする。
 * kindOf = 資産の科目の名前、exclusive = その日が税抜経理の期間か。
 * 一括償却資産を売ったもの（事業所得になるので譲渡所得に入れない）は lump に名前を返す
 */
export const assetSalesOf = (
  assets: FixedAsset[], year: number, kindOf: (accountId: number) => string, exclusive: (date: string) => boolean,
): { sales: AssetSale[]; lump: string[] } => {
  const sold = assets.filter((a) => a.disposal_kind === "sale" && a.disposed_on && yearOf(a.disposed_on) === year);
  const sales = sold.filter((a) => a.method === "straight" || a.method === "declining" || a.method === "small").map((a): AssetSale => {
    const rate = businessRateIn(a, year);
    const part = (n: number) => (rate >= 100 ? n : Math.floor((n * rate) / 100));
    const salePrice = a.sale_price ?? 0;
    const businessPrice = part(salePrice);
    // 税抜経理：課税売上にした事業用の部分の消費税は仮受消費税等なので、譲渡価額は税抜
    const price = exclusive(a.disposed_on!) ? businessPrice - Math.floor((businessPrice * 10) / 110) : businessPrice;
    const bookValue = depreciationFor(a, year)?.closing ?? 0;
    return {
      assetId: a.id, name: a.name, kind: kindOf(a.account_id), acquired: a.acquired_on, sold: a.disposed_on!, rate,
      salePrice, price, acquisitionCost: part(a.cost), bookValue, cost: part(bookValue), realEstate: a.income_kind === "realestate",
    };
  });
  return { sales, lump: sold.filter((a) => a.method === "lump3").map((a) => a.name) };
};

/** 総合課税の譲渡（所得税の入力。台帳で売却した資産は assetId でつなぎ、台帳の売却額・帳簿価額・日付を使う） */
export interface TransferRow {
  /** 固定資産台帳の資産。台帳に無いものを手で入れた行は null */
  assetId: number | null;
  /** 資産の名称・種類（台帳の行は台帳のものを使う） */
  name: string;
  kind: string;
  /** 取得日・譲渡日（YYYY-MM-DD。台帳の行は台帳のものを使う） */
  acquired: string;
  sold: string;
  /** 譲渡価額（台帳の行は台帳から出すので使わない） */
  price: number;
  /** 取得費（台帳の行は、空なら台帳の帳簿価額の事業用の部分） */
  cost: number | null;
  /** 譲渡費用（仲介手数料など） */
  expenses: number;
  /** 生活に通常必要でない資産（ゴルフ会員権・別荘・1個30万円を超える貴金属や書画骨董など。損失をほかの所得から差し引けない） */
  luxury: boolean;
  /** 譲渡先（買主）の氏名（名称）・住所（所在地）。譲渡所得の内訳書に書く */
  buyer: string;
  buyerAddress: string;
}

export const emptyTransfer = (): TransferRow => ({
  assetId: null, name: "", kind: "", acquired: "", sold: "", price: 0, cost: null, expenses: 0, luxury: false, buyer: "", buyerAddress: "",
});

/** 計算に使う1件の譲渡 */
export interface Transfer {
  assetId: number | null;
  name: string;
  kind: string;
  acquired: string;
  sold: string;
  price: number;
  cost: number;
  expenses: number;
  luxury: boolean;
  buyer: string;
  buyerAddress: string;
  /** 短期（5年以内）・長期（5年超）。日付が無ければ null（短期として計算し、知らせる） */
  term: "short" | "long" | null;
  /** 差引金額（譲渡価額 − 取得費 − 譲渡費用） */
  gain: number;
  /** 台帳の資産（売却額・帳簿価額など） */
  sale?: AssetSale;
}

/** 持っていた期間が5年を超えるか（取得の日から譲渡の日まで。5年ちょうどは5年以内） */
export const termOf = (acquired: string, sold: string): "short" | "long" | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquired) || !/^\d{4}-\d{2}-\d{2}$/.test(sold)) return null;
  const fifth = `${yearOf(acquired) + 5}${acquired.slice(4)}`;
  return sold > fifth ? "long" : "short";
};

/** 入力の行と台帳の売却を合わせる（台帳の資産は売却した分だけ。入力の行が無い資産は譲渡費用 0 で入れる） */
export const transfersOf = (rows: TransferRow[], sales: AssetSale[]): Transfer[] => {
  const fromAssets = sales.map((s): Transfer => {
    const r = rows.find((x) => x.assetId === s.assetId);
    const cost = r?.cost ?? s.cost;
    const expenses = r?.expenses ?? 0;
    return {
      assetId: s.assetId, name: s.name, kind: s.kind, acquired: s.acquired, sold: s.sold, price: s.price, cost, expenses, luxury: false,
      buyer: r?.buyer ?? "", buyerAddress: r?.buyerAddress ?? "", term: termOf(s.acquired, s.sold), gain: s.price - cost - expenses, sale: s,
    };
  });
  const manual = rows.filter((r) => r.assetId === null).map((r): Transfer => {
    const cost = r.cost ?? 0;
    return { ...r, cost, term: termOf(r.acquired, r.sold), gain: r.price - cost - r.expenses };
  });
  return [...fromAssets, ...manual];
};

/** 短期・長期ごとの合計（第二表「総合課税の譲渡所得、一時所得に関する事項」の行） */
export interface TermTotal {
  income: number;
  costs: number;
  gain: number;
}

export interface TransferResult {
  short: TermTotal;
  long: TermTotal;
  /** 短期・長期の譲渡所得の金額（内部通算と特別控除の後。全体が損失なら、その損失を短期・長期に分けたもの） */
  a: number;
  b: number;
  /** 内部通算の後・特別控除の前（損益の通算の計算書 2 の (B)） */
  net: { short: number; long: number };
  /** 特別控除額（短期・長期） */
  special: { short: number; long: number };
  /** 生活に通常必要でない資産の譲渡損失のうち、ほかの所得から差し引けないため無いものとした額 */
  ignored: number;
  /** 事業用の資産（不動産所得の資産を除く）の譲渡損失（第二表の事業税「事業用資産の譲渡損失など」） */
  businessLoss: number;
}

const total = (xs: Transfer[]): TermTotal => ({ income: sum(xs.map((t) => t.price)), costs: sum(xs.map((t) => t.cost + t.expenses)), gain: sum(xs.map((t) => t.gain)) });

/** 総合課税の譲渡所得の金額（短期・長期） */
export const transferResult = (ts: Transfer[]): TransferResult => {
  const short = total(ts.filter((t) => t.term !== "long"));
  const long = total(ts.filter((t) => t.term === "long"));
  const S = short.gain;
  const L = long.gain;
  // 事業税の「事業用資産の譲渡損失など」：事業用の資産（不動産所得の資産を除く）ごとの損失の合計（益とは差し引かない）
  const businessLoss = sum(ts.filter((t) => t.sale && !t.sale.realEstate && t.gain < 0).map((t) => -t.gain));
  if (S + L >= 0) {
    // 内部通算（一方が損失なら、もう一方の益から差し引く）のあと、特別控除は短期から
    const s = L < 0 ? S + L : S;
    const l = S < 0 ? L + S : L;
    const ds = Math.min(TRANSFER_SPECIAL, Math.max(0, s));
    const dl = Math.min(TRANSFER_SPECIAL - ds, Math.max(0, l));
    return { short, long, net: { short: Math.max(0, s), long: Math.max(0, l) }, a: Math.max(0, s) - ds, b: Math.max(0, l) - dl, special: { short: ds, long: dl }, ignored: 0, businessLoss };
  }
  // 全体が損失：損失を出した側に残す。生活に通常必要でない資産の損失の分は無いものとする（施行令200条。その資産のある側から先に）
  let a = S < 0 && L < 0 ? S : S < 0 ? S + L : 0;
  let b = S < 0 && L < 0 ? L : L < 0 ? S + L : 0;
  const luxury = (term: "short" | "long") => sum(ts.filter((t) => t.luxury && t.gain < 0 && (term === "long") === (t.term === "long")).map((t) => -t.gain));
  const ignored = Math.min(luxury("short") + luxury("long"), -(a + b));
  let left = ignored;
  const lift = (v: number, most: number) => {
    const up = Math.min(left, most, Math.max(0, -v));
    left -= up;
    return v + up;
  };
  a = lift(a, luxury("short"));
  b = lift(b, luxury("long"));
  a = lift(a, Infinity);
  b = lift(b, Infinity);
  return { short, long, net: { short: a, long: b }, a, b, special: { short: 0, long: 0 }, ignored, businessLoss };
};

/** 一時所得（所得税の入力） */
export interface OccasionalRow {
  /** 種目（例：生命保険の満期金、懸賞の賞金） */
  item: string;
  /** 支払者の名称・法人番号又は所在地 */
  payer: string;
  payerId: string;
  /** 収入金額 */
  income: number;
  /** 収入を得るために支出した金額（払った保険料など。直接要したものだけ） */
  expenses: number;
  /** 源泉徴収税額 */
  withheld: number;
}

/** 一時所得の金額（特別控除の後。損失は 0） */
export const occasionalResult = (rows: OccasionalRow[]) => {
  const income = sum(rows.map((r) => r.income));
  const costs = sum(rows.map((r) => r.expenses));
  const gain = income - costs;
  const special = Math.min(OCCASIONAL_SPECIAL, Math.max(0, gain));
  return { income, costs, gain, special, amount: Math.max(0, gain) - special };
};

/** 損益通算のあとの各所得と、総所得金額（純損失の繰越控除の前） */
export interface OffsetResult {
  /** 譲渡・一時所得の通算後（損益の通算の計算書 2 の (D)。譲渡の損失を一時所得から差し引いた後） */
  group: { short: number; long: number; occasional: number };
  /** 経常所得（利子・配当・不動産・事業・給与・雑） */
  ordinary: number;
  /** 総合課税の短期・長期譲渡所得（損失はマイナスのまま） */
  short: number;
  long: number;
  /** 総合課税の譲渡所得の損失（ほかの所得から引ききれなかった残り。0 以下） */
  transferLoss: number;
  /** 一時所得 */
  occasional: number;
  /** 第一表 ⑪（短期 ＋（長期 ＋ 一時）× 1/2。損失は 1/2 にしない） */
  r11: number;
  /** 総所得金額（合計） */
  total: number;
}

/**
 * 損益通算（施行令198条。損益の通算の計算書の順）。ordinary = 経常所得（事業・不動産の損失はすでにほかの経常所得から差し引いた額）、
 * a・b = 短期・長期の譲渡所得の金額（特別控除の後。損失はマイナス）、g = 一時所得の金額（特別控除の後）
 *  1. 譲渡の損失 → 一時所得
 *  2. 経常所得の損失 → 短期譲渡 → 長期譲渡 → 一時所得
 *  3. 譲渡の損失（残り）→ 経常所得
 */
export const offsetIncomes = (ordinary: number, a: number, b: number, g: number): OffsetResult => {
  let e = ordinary;
  let s = a;
  let l = b;
  let o = Math.max(0, g);
  const absorb = (loss: number, from: number) => Math.min(Math.max(0, -loss), Math.max(0, from));
  // 1. 譲渡の損失 → 一時所得
  for (const k of ["s", "l"] as const) {
    const t = absorb(k === "s" ? s : l, o);
    o -= t;
    if (k === "s") s += t;
    else l += t;
  }
  const group = { short: s, long: l, occasional: o };
  // 2. 経常所得の損失 → 短期 → 長期 → 一時
  const t1 = absorb(e, s); s -= t1; e += t1;
  const t2 = absorb(e, l); l -= t2; e += t2;
  const t3 = absorb(e, o); o -= t3; e += t3;
  // 3. 譲渡の損失（残り）→ 経常所得
  const t4 = absorb(s, e); s += t4; e -= t4;
  const t5 = absorb(l, e); l += t5; e -= t5;
  const r11 = s + Math.min(0, l) + Math.floor((Math.max(0, l) + o) / 2);
  return { group, ordinary: e, short: s, long: l, transferLoss: Math.min(0, s) + Math.min(0, l), occasional: o, r11, total: e + r11 };
};
