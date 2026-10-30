import type { IncomeKind, JournalLine } from "./types";

/**
 * 減価償却の計算（純粋関数）
 *
 * 個人の法定の償却方法は定額法（平成19年3月31日以前の取得は旧定額法）なので、次に対応する（定率法・旧定率法は届出が要るので、あとで）
 *  - 定額法（平成19年4月1日以後に取得したもの）：取得価額 × 償却率 × 使った月数 / 12。1円未満は切り上げ。
 *    最後は未償却残高が 1円（備忘価額）になるまで償却する
 *  - 旧定額法（償却方法「定額法」で、取得日が平成19年3月31日以前のもの。国税庁 No.2105、決算書の書き方）：
 *    取得価額 × 90% × 旧定額法の償却率 × 月数 / 12。償却費の累計が取得価額の 95% に達したら、その翌年から5年間で
 *    1円まで均等に償却する（{取得価額 − 取得価額 × 95% − 1円} ÷ 5 × 月数 / 12）
 *  - 200%定率法（平成24年4月1日以後に取得したもの。償却方法の届出をした人。国税庁 No.2106、耐用年数省令 別表第十）：
 *    期首の未償却残高 × 定率法の償却率（調整前償却額）。これが償却保証額（取得価額 × 保証率）に満たなくなった年から、
 *    改定取得価額（その年の期首の未償却残高）× 改定償却率。月割り・1円未満切り上げ・1円（備忘価額）まで は定額法と同じ。
 *    建物、平成28年4月1日以後に取得した建物附属設備・構築物、ソフトウェアには使えない
 *  - 一括償却資産（10万円以上20万円未満）：取得価額の 1/3 ずつを3年。月割りしない。売ったり捨てたりしても3年続ける
 *  - 少額減価償却資産（青色申告・30万円未満。1年の合計300万円まで）：使い始めた年に全額
 *  - 繰延資産（開業費など。任意償却）：年ごとに償却する額を決める（決めていない年は60か月の均等償却。月割り）。0円まで償却する
 * 償却率は「1 / 耐用年数」を小数第3位で切り上げたもの（定額法の償却率表と同じ値になる）
 *
 * 事業専用割合：償却費のうち、必要経費に入れるのは事業で使っている割合だけ（1円未満は切り捨て。経費を多く見積もらない側）。
 * 残りは事業主貸にする。未償却残高は、割合にかかわらず償却費の全額だけ減る。
 * 割合は年ごとに見直せる（家事按分と同じく「何年から何%」。前の年の割合はそのまま）
 *
 * 年の締め：締めた年に台帳・決算書に出る資産は、売却・除却の日（締めていない年の分）と、締めていない年からの事業専用割合だけ変えられる
 * （assetLockError。DB のトリガー（schema.ts）でも同じ条件で拒否する）
 */

export type DepreciationMethod = "straight" | "declining" | "lump3" | "small" | "deferred";
export type DisposalKind = "sale" | "scrap";
export const DISPOSAL_LABEL: Record<DisposalKind, string> = { sale: "売却", scrap: "除却" };

export const METHOD_LABEL: Record<DepreciationMethod, string> = {
  straight: "定額法",
  declining: "定率法（200%）",
  lump3: "一括償却資産（3年）",
  small: "少額減価償却資産",
  deferred: "繰延資産（任意償却）",
};

/** 200%定率法を使える取得日（この日以後。それより前の 250%定率法・旧定率法には対応していない） */
export const DECLINING_FROM = "2012-04-01";
/** 繰延資産の、償却する額を決めていない年の均等償却の月数 */
export const DEFERRED_MONTHS = 60;

/**
 * 200%定率法の償却率・改定償却率（千分率）と保証率（十万分率）。耐用年数 2〜100年（減価償却資産の耐用年数等に関する省令 別表第十）。
 * 2年は改定償却率・保証率が無い（0）
 */
const DECLINING_RATES = [
  1000, 667, 500, 400, 333, 286, 250, 222, 200, 182, 167, 154, 143, 133, 125, 118, 111, 105, 100, 95, 91, 87, 83, 80, 77, 74, 71, 69, 67, 65, 63, 61,
  59, 57, 56, 54, 53, 51, 50, 49, 48, 47, 45, 44, 43, 43, 42, 41, 40, 39, 38, 38, 37, 36, 36, 35, 34, 34, 33, 33, 32, 32, 31, 31, 30, 30, 29, 29, 29, 28,
  28, 27, 27, 27, 26, 26, 26, 25, 25, 25, 24, 24, 24, 24, 23, 23, 23, 22, 22, 22, 22, 22, 21, 21, 21, 21, 20, 20, 20,
];
const DECLINING_REVISED = [
  0, 1000, 1000, 500, 334, 334, 334, 250, 250, 200, 200, 167, 167, 143, 143, 125, 112, 112, 112, 100, 100, 91, 84, 84, 84, 77, 72, 72, 72, 67, 67, 63,
  63, 59, 59, 56, 56, 53, 53, 50, 50, 48, 46, 46, 44, 44, 44, 42, 42, 40, 39, 39, 38, 38, 38, 36, 35, 35, 34, 34, 33, 33, 32, 32, 31, 31, 30, 30, 30, 29,
  29, 27, 27, 27, 27, 27, 27, 26, 26, 26, 24, 24, 24, 24, 23, 23, 23, 22, 22, 22, 22, 22, 21, 21, 21, 21, 20, 20, 20,
];
const DECLINING_GUARANTEE = [
  0, 11089, 12499, 10800, 9911, 8680, 7909, 7126, 6552, 5992, 5566, 5180, 4854, 4565, 4294, 4038, 3884, 3693, 3486, 3335, 3182, 3052, 2969, 2841, 2716,
  2624, 2568, 2463, 2366, 2286, 2216, 2161, 2097, 2051, 1974, 1950, 1882, 1860, 1791, 1741, 1694, 1664, 1664, 1634, 1601, 1532, 1499, 1475, 1440, 1422,
  1422, 1370, 1370, 1337, 1288, 1281, 1281, 1240, 1240, 1201, 1201, 1165, 1165, 1130, 1130, 1097, 1097, 1065, 1034, 1034, 1006, 1063, 1035, 1007, 980,
  954, 929, 929, 907, 884, 929, 907, 885, 864, 885, 864, 844, 863, 844, 825, 807, 790, 807, 790, 773, 757, 773, 757, 742,
];
const lifeIndex = (life: number) => Math.min(Math.max(life, 2), 100) - 2;
/** 200%定率法の償却率・改定償却率（千分率）・保証率（十万分率） */
export const decliningRates = (life: number) => ({
  rate: DECLINING_RATES[lifeIndex(life)], revised: DECLINING_REVISED[lifeIndex(life)], guarantee: DECLINING_GUARANTEE[lifeIndex(life)],
});

/**
 * 中古資産の耐用年数（簡便法。国税庁 No.5404・耐用年数省令3条）：
 *  法定耐用年数の全部を経過したもの：法定耐用年数 × 20%、一部を経過したもの：（法定耐用年数 − 経過年数）＋ 経過年数 × 20%。
 *  月数で計算し、1年未満の端数は切り捨て、2年に満たなければ2年
 */
export const usedAssetLife = (legalYears: number, elapsedMonths: number) => {
  const legal = legalYears * 12;
  const fifth = (m: number) => (m * 2) / 10;
  const months = elapsedMonths >= legal ? fifth(legal) : legal - elapsedMonths + fifth(elapsedMonths);
  return Math.max(2, Math.floor(months / 12));
};

/** 一括償却資産・少額減価償却資産にできる取得価額の上限（この額未満） */
export const LUMP3_LIMIT = 200_000;
/**
 * 少額減価償却資産の取得価額の上限（この額未満）。取得日で変わる（国税庁 No.2100、令和8年度税制改正）
 *  令和8年3月31日までの取得：30万円未満、令和8年4月1日〜令和11年3月31日の取得：40万円未満。令和11年4月1日以後の取得は特例なし
 */
export const SMALL_LIMITS: { from: string; to: string; limit: number }[] = [
  { from: "0000-01-01", to: "2026-03-31", limit: 300_000 },
  { from: "2026-04-01", to: "2029-03-31", limit: 400_000 },
];
/** その取得日の上限（特例の期限を過ぎていれば null） */
export const smallLimitFor = (acquiredOn: string): number | null =>
  SMALL_LIMITS.find((x) => acquiredOn >= x.from && acquiredOn <= x.to)?.limit ?? null;
/** 少額減価償却資産の、1年の取得価額の合計の上限 */
export const SMALL_YEAR_LIMIT = 3_000_000;
/** これ未満なら、資産にせず消耗品費などで落とせる */
export const EXPENSE_LIMIT = 100_000;

export interface FixedAsset {
  id: number;
  name: string;
  /** 資産の科目（工具器具備品・車両運搬具・一括償却資産 など） */
  account_id: number;
  /** 取得日（YYYY-MM-DD） */
  acquired_on: string;
  /** 事業に使い始めた日（償却はこの月から） */
  used_on: string;
  /** 取得価額（円） */
  cost: number;
  method: DepreciationMethod;
  /** 耐用年数（定額法のとき） */
  useful_life: number;
  /** 事業専用割合（%）。使い始めた年からの割合（あとの年に変えたものは rates） */
  business_rate: number;
  /** あとの年から変えた事業専用割合（from_year の年から。古い順） */
  rates?: AssetRate[];
  /** domble を使う前から持っている資産：この年の期首の未償却残高から計算を始める */
  opening_year: number | null;
  opening_book_value: number | null;
  /** 売却・除却した日（その月まで償却し、翌年からは台帳に出さない） */
  disposed_on: string | null;
  /** 売却（sale）か除却（scrap）か（売却・除却した日があるときだけ） */
  disposal_kind?: DisposalKind | null;
  /** 売却した額（税込。売却のときだけ） */
  sale_price?: number | null;
  /** 繰延資産（任意償却）：年ごとに決めた償却する額（決めていない年は60か月の均等償却） */
  amortization?: Record<number, number>;
  memo: string;
  /** 所得の区分（不動産所得の資産は減価償却費（不動産）にし、不動産所得用の決算書に出す。無ければ事業所得） */
  income_kind?: IncomeKind;
}

/** 事業専用割合を変えた年と割合 */
export interface AssetRate {
  from_year: number;
  rate: number;
}

/** ある年度の償却 */
export interface YearDepreciation {
  /** 償却率（定額法・旧定額法のとき。例 0.250。旧定額法の均等償却の年は 0.200） */
  rate: number | null;
  /** 償却の基礎になる金額（取得価額。旧定額法は取得価額 × 90%、均等償却の年は取得価額 × 5%） */
  base: number;
  /** 旧定額法で、95% に達した翌年からの5年間の均等償却の年 */
  equal: boolean;
  /** 200%定率法で、改定償却率に切り替えた年（償却の基礎になる金額は改定取得価額） */
  revised: boolean;
  /** 本年中の償却期間（月数） */
  months: number;
  /** 期首の未償却残高 */
  opening: number;
  /** 本年分の償却費（合計） */
  depreciation: number;
  /** その年の事業専用割合（%） */
  businessRate: number;
  /** 必要経費に入れる額（事業分） */
  business: number;
  /** 事業主貸にする額（家事分） */
  private: number;
  /** 期末の未償却残高 */
  closing: number;
  /** この年に売却・除却した */
  disposed: boolean;
}

/** 定額法の償却率（千分率の整数。例：耐用年数4年 → 250） */
export const straightRateMil = (life: number) => Math.ceil(1000 / life);

/** 旧定額法で計算する取得日（この日以前） */
export const OLD_STRAIGHT_UNTIL = "2007-03-31";
/** 旧定額法の償却率（千分率。耐用年数 2〜100年。減価償却資産の耐用年数等に関する省令 別表第七） */
const OLD_STRAIGHT_RATES = [
  500, 333, 250, 200, 166, 142, 125, 111, 100, 90, 83, 76, 71, 66, 62, 58, 55, 52, 50, 48, 46, 44, 42, 40, 39, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 27,
  26, 25, 25, 24, 24, 23, 23, 22, 22, 21, 21, 20, 20, 20, 19, 19, 19, 18, 18, 18, 17, 17, 17, 17, 16, 16, 16, 16, 15, 15, 15, 15, 14, 14, 14, 14, 14, 14, 13,
  13, 13, 13, 13, 13, 12, 12, 12, 12, 12, 12, 12, 12, 11, 11, 11, 11, 11, 11, 11, 11, 11, 10,
];
export const oldStraightRateMil = (life: number) => OLD_STRAIGHT_RATES[Math.min(Math.max(life, 2), 100) - 2];

/** 旧定額法で計算するか（償却方法が定額法で、取得日が平成19年3月31日以前） */
export const isOldStraight = (a: Pick<FixedAsset, "method" | "acquired_on">) => a.method === "straight" && a.acquired_on <= OLD_STRAIGHT_UNTIL;
/** 台帳・決算書に出す償却方法（取得日で旧定額法になるものは「旧定額法」） */
export const methodLabel = (a: Pick<FixedAsset, "method" | "acquired_on">) => (isOldStraight(a) ? "旧定額法" : METHOD_LABEL[a.method]);
/** 旧定額法：償却費の累計が取得価額の 95% に達したときの未償却残高（取得価額 × 5%） */
const oldFloor = (cost: number) => cost - Math.floor((cost * 95) / 100);

const yearOf = (date: string) => Number(date.slice(0, 4));
const monthOf = (date: string) => Number(date.slice(5, 7));

/** その年に使った月数（使い始めた月・除却した月も1か月に数える） */
const monthsIn = (a: FixedAsset, year: number) => {
  const from = yearOf(a.used_on) === year ? monthOf(a.used_on) : 1;
  const to = a.disposed_on && yearOf(a.disposed_on) === year ? monthOf(a.disposed_on) : 12;
  return Math.max(0, to - from + 1);
};

/** その年の事業専用割合（from_year がその年以前で最も新しいもの。無ければ使い始めた年からの割合） */
export const businessRateIn = (a: Pick<FixedAsset, "business_rate" | "rates">, year: number) => {
  let rate = a.business_rate;
  let from = -Infinity;
  for (const r of a.rates ?? []) if (r.from_year <= year && r.from_year > from) [rate, from] = [r.rate, r.from_year];
  return rate;
};

/**
 * 資産が台帳・決算書に出る年の範囲：使い始めた年から、売却・除却した年まで（一括償却資産は除却しても3年目まで）。売っていなければ終わりなし
 * schema.ts の assetEnd と同じ
 */
export const assetYears = (a: Pick<FixedAsset, "used_on" | "disposed_on" | "method">) => {
  const from = yearOf(a.used_on);
  if (!a.disposed_on) return { from, to: Infinity };
  return { from, to: Math.max(yearOf(a.disposed_on), a.method === "lump3" ? from + 2 : 0) };
};

/** 年の締めをした年のうち、資産が台帳に出る年 */
export const closedYearsOf = (a: Pick<FixedAsset, "used_on" | "disposed_on" | "method">, closedYears: readonly number[]) => {
  const { from, to } = assetYears(a);
  return closedYears.filter((y) => y >= from && y <= to).sort((x, y) => x - y);
};

/** 締めた年にかかる資産で、変えられない項目（売却・除却の日と、あとの年からの事業専用割合のほか全部） */
const LOCKED_FIELDS: [keyof Omit<FixedAsset, "id">, string][] = [
  ["name", "名称"], ["account_id", "科目"], ["acquired_on", "取得日"], ["used_on", "使い始めた日"], ["cost", "取得価額"], ["method", "償却方法"],
  ["useful_life", "耐用年数"], ["opening_year", "期首の未償却残高の年"], ["opening_book_value", "期首の未償却残高"], ["memo", "備考"], ["income_kind", "所得の区分"],
];
const LOCK_HINT = "直すときは、事業者設定で締めを戻してください。";
const yearsText = (ys: number[]) => ys.map((y) => `${y}年`).join("・");

/**
 * 年の締めをした年に関わる、資産の追加・変更・削除を確かめる（before = null は追加、after = null は削除）。問題があれば文言を返す
 *  締めた年に台帳に出る資産は、売却・除却の日（締めた年にかからないもの）と、締めていない年からの事業専用割合だけ変えられる。
 *  締めた年に台帳に出るように変える（使い始めた日を前にずらすなど）こともできない
 */
export const assetLockError = (
  before: Omit<FixedAsset, "id"> | null, after: Omit<FixedAsset, "id"> | null, closedYears: readonly number[],
): string | null => {
  const was = before ? closedYearsOf(before, closedYears) : [];
  const will = after ? closedYearsOf(after, closedYears) : [];
  if (!before) return will.length ? `${yearsText(will)}は締め済みのため、その年に使っている資産は追加できません。${LOCK_HINT}` : null;
  if (!after) return was.length ? `締め済みの年（${yearsText(was)}）に使っている資産は削除できません。${LOCK_HINT}` : null;
  if (was.length === 0) return will.length ? `締め済みの年（${yearsText(will)}）に使っていることになる変更はできません。${LOCK_HINT}` : null;
  const norm = (v: unknown) => v ?? null;
  const changed = LOCKED_FIELDS.filter(([k]) => norm(before[k]) !== norm(after[k])).map(([, label]) => label);
  if (changed.length) {
    return `締め済みの年（${yearsText(was)}）に使っている資産のため、${changed.join("・")}は変えられません（売却・除却の日と、締めていない年からの事業専用割合は変えられます）。${LOCK_HINT}`;
  }
  const years = [...new Set([...was, ...will])].sort((x, y) => x - y);
  if (norm(before.disposed_on) !== norm(after.disposed_on) || norm(before.disposal_kind) !== norm(after.disposal_kind) || norm(before.sale_price) !== norm(after.sale_price)) {
    const from = Math.min(before.disposed_on ? yearOf(before.disposed_on) : Infinity, after.disposed_on ? yearOf(after.disposed_on) : Infinity);
    const hit = years.filter((y) => y >= from);
    if (hit.length) return `売却・除却の日の変更は、締め済みの年（${yearsText(hit)}）の台帳が変わるためできません。${LOCK_HINT}`;
  }
  // 繰延資産の償却額：変えた年から後の年の未償却残高も変わるので、変えた年以後に締めた年があれば止める
  const amortYears = [...new Set([...Object.keys(before.amortization ?? {}), ...Object.keys(after.amortization ?? {})])].map(Number)
    .filter((y) => (before.amortization?.[y] ?? null) !== (after.amortization?.[y] ?? null));
  const amortHit = years.filter((y) => amortYears.some((c) => c <= y));
  if (amortHit.length) return `${yearsText(amortHit)}は締め済みのため、その年までの償却額は変えられません。${LOCK_HINT}`;
  const rateHit = years.filter((y) => businessRateIn(before, y) !== businessRateIn(after, y));
  if (rateHit.length) return `${yearsText(rateHit)}は締め済みのため、その年の事業専用割合は変えられません。${LOCK_HINT}`;
  return null;
};

/** 償却費のうち事業分（切り捨て）と家事分 */
export const splitBusiness = (amount: number, rate: number) => {
  const business = Math.floor((amount * rate) / 100);
  return { business, private: amount - business };
};

/** 年をまたいで持つ計算の状態（200%定率法の改定取得価額） */
interface Carry {
  revisedBase: number | null;
}

/** 1年分の償却費（期首の未償却残高 book から） */
const depreciationOfYear = (a: FixedAsset, year: number, book: number, carry: Carry) => {
  const start = yearOf(a.used_on);
  if (a.method === "small") return year === start ? book : 0;
  if (a.method === "lump3") {
    // 1/3 ずつ。端数は、3年で取得価額ちょうどになるように各年で切り上げて調整する
    const k = year - start + 1;
    if (k < 1 || k > 3) return 0;
    return Math.min(book, Math.ceil((a.cost * k) / 3) - Math.ceil((a.cost * (k - 1)) / 3));
  }
  if (a.method === "deferred") {
    // 決めた額（無ければ60か月の均等償却を月割り）。0円まで
    const chosen = a.amortization?.[year];
    const amount = chosen ?? Math.ceil((a.cost * monthsIn(a, year)) / DEFERRED_MONTHS);
    return Math.max(0, Math.min(amount, book));
  }
  if (a.method === "declining") {
    // 調整前償却額（期首の未償却残高 × 償却率）が償却保証額に満たなくなった年から、改定取得価額 × 改定償却率
    const r = decliningRates(a.useful_life);
    if (carry.revisedBase === null && r.guarantee > 0 && book * r.rate * 100 < a.cost * r.guarantee) carry.revisedBase = book;
    const annual = carry.revisedBase === null ? book * r.rate : carry.revisedBase * r.revised;
    return Math.max(0, Math.min(Math.ceil((annual * monthsIn(a, year)) / 12000), book - 1));
  }
  if (isOldStraight(a)) {
    const floor = oldFloor(a.cost);
    // 95% に達するまで：取得価額 × 90% × 旧定額法の償却率。達する年は 95% ちょうどまで
    if (book > floor) return Math.max(0, Math.min(Math.ceil((a.cost * 9 * oldStraightRateMil(a.useful_life) * monthsIn(a, year)) / 120_000), book - floor));
    // 達した翌年から：(取得価額 × 5% − 1円) ÷ 5 ずつ、1円まで
    return Math.max(0, Math.min(Math.ceil(((floor - 1) * monthsIn(a, year)) / 60), book - 1));
  }
  const annual = Math.ceil((a.cost * straightRateMil(a.useful_life) * monthsIn(a, year)) / 12000);
  return Math.max(0, Math.min(annual, book - 1));
};

/**
 * ある年度の償却を計算する。その年に使っていない資産（使い始める前・除却した翌年以降）は null
 * 前の年から順に積み上げて期首の未償却残高を出す（opening_year があれば、その年の期首はその額から）
 * 200%定率法で opening_year から始めた資産は、改定償却率に切り替わる年をその年から判定する（それより前に切り替わっていた資産は、改定取得価額が違うことがある）
 */
export const depreciationFor = (a: FixedAsset, year: number): YearDepreciation | null => {
  const start = yearOf(a.used_on);
  if (year < start) return null;
  // 一括償却資産は除却しても3年続けるので、除却で打ち切らない
  if (a.method !== "lump3" && a.disposed_on && yearOf(a.disposed_on) < year) return null;
  const carry: Carry = { revisedBase: null };
  let book = a.cost;
  for (let y = start; y < year; y++) {
    if (a.opening_year !== null && a.opening_book_value !== null && y === a.opening_year) {
      book = a.opening_book_value;
      carry.revisedBase = null;
    }
    book -= depreciationOfYear(a, y, book, carry);
  }
  if (a.opening_year !== null && a.opening_book_value !== null && year === a.opening_year) {
    book = a.opening_book_value;
    carry.revisedBase = null;
  }
  const depreciation = depreciationOfYear(a, year, book, carry);
  const businessRate = businessRateIn(a, year);
  const { business, private: priv } = splitBusiness(depreciation, businessRate);
  const old = isOldStraight(a);
  const equal = old && book <= oldFloor(a.cost);
  const revised = a.method === "declining" && carry.revisedBase !== null;
  const dr = a.method === "declining" ? decliningRates(a.useful_life) : null;
  return {
    rate: a.method === "declining" ? (revised ? dr!.revised : dr!.rate) / 1000
      : a.method !== "straight" ? null : equal ? 0.2 : (old ? oldStraightRateMil(a.useful_life) : straightRateMil(a.useful_life)) / 1000,
    // 償却の基礎になる金額：定額法は取得価額（旧定額法は × 90%・均等償却の年は × 5%）、定率法は期首の未償却残高（切り替えた年からは改定取得価額）、繰延資産は取得価額
    base: a.method === "declining" ? (revised ? carry.revisedBase! : book) : equal ? oldFloor(a.cost) : old ? Math.floor((a.cost * 9) / 10) : a.cost,
    equal,
    revised,
    months: a.method === "straight" || a.method === "declining" || a.method === "deferred" ? monthsIn(a, year) : 12,
    opening: book,
    depreciation,
    businessRate,
    business,
    private: priv,
    closing: book - depreciation,
    disposed: !!a.disposed_on && yearOf(a.disposed_on) === year,
  };
};

/** 定率法を使えない資産（建物、平成28年4月1日以後に取得した建物附属設備・構築物、ソフトウェア）なら理由。科目のコードで見る */
export const decliningProblem = (accountCode: string, acquiredOn: string): string | null => {
  if (accountCode === "130") return "建物は定額法で償却します（定率法は使えません）";
  if ((accountCode === "131" || accountCode === "136") && acquiredOn >= "2016-04-01") return "平成28年4月1日以後に取得した建物附属設備・構築物は、定額法で償却します";
  if (accountCode === "138") return "ソフトウェアは定額法で償却します";
  return null;
};

/** 入力の確かめ。問題があれば文言を返す（accountCode：資産の科目のコード。定率法を使えるかに使う） */
export const validateAsset = (a: Omit<FixedAsset, "id">, opts: { blue: boolean; accountCode?: string }): string | null => {
  if (!a.name.trim()) return "名称を入れてください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.acquired_on)) return "取得日を入れてください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.used_on)) return "事業に使い始めた日を入れてください";
  if (a.used_on < a.acquired_on) return "使い始めた日は、取得日より後にしてください";
  if (!Number.isInteger(a.cost) || a.cost <= 0) return "取得価額は 1円以上の整数で入れてください";
  if (!Number.isInteger(a.business_rate) || a.business_rate < 0 || a.business_rate > 100) return "事業専用割合は 0〜100 の整数で入れてください";
  if ((a.method === "straight" || a.method === "declining") && (!Number.isInteger(a.useful_life) || a.useful_life < 2 || a.useful_life > 100)) return "耐用年数は 2〜100 の整数で入れてください";
  if (a.method === "declining") {
    if (a.acquired_on < DECLINING_FROM) return "定率法は、平成24年4月1日以後に取得した資産だけ計算できます（250%定率法・旧定率法には対応していません）";
    const problem = decliningProblem(opts.accountCode ?? "", a.acquired_on);
    if (problem) return problem;
  }
  if (a.method === "deferred") {
    for (const [y, amount] of Object.entries(a.amortization ?? {})) {
      if (!Number.isInteger(amount) || amount < 0) return `${y}年に償却する額は 0円以上の整数で入れてください`;
    }
  }
  if (a.method === "lump3" && a.cost >= LUMP3_LIMIT) return `一括償却資産にできるのは取得価額 ${LUMP3_LIMIT.toLocaleString()}円未満のものです`;
  if (a.method === "small") {
    const limit = smallLimitFor(a.acquired_on);
    if (limit === null) return "少額減価償却資産の特例は、令和11年3月31日までに取得したものだけです";
    if (a.cost >= limit) {
      return `少額減価償却資産にできるのは取得価額 ${limit.toLocaleString()}円未満のものです（${a.acquired_on < "2026-04-01" ? "令和8年3月31日までの取得" : "令和8年4月1日以後の取得"}）`;
    }
  }
  if (a.method === "small" && !opts.blue) return "少額減価償却資産の特例は、青色申告のときだけ使えます";
  if (a.disposed_on && a.disposed_on < a.used_on) return "売却・除却した日は、使い始めた日より後にしてください";
  if (a.disposed_on && a.disposal_kind === "sale" && (a.sale_price == null || !Number.isInteger(a.sale_price) || a.sale_price < 0)) {
    return "売却した額（税込）を 0円以上の整数で入れてください";
  }
  if ((a.opening_year === null) !== (a.opening_book_value === null)) return "期首の未償却残高は、年と金額の両方を入れてください";
  if (a.opening_book_value !== null && (!Number.isInteger(a.opening_book_value) || a.opening_book_value < 0 || a.opening_book_value > a.cost)) {
    return "期首の未償却残高は、0円以上・取得価額以下の整数で入れてください";
  }
  if (a.opening_year !== null && a.opening_year < yearOf(a.used_on)) return "期首の未償却残高の年は、使い始めた年より後にしてください";
  return null;
};

/** その年に使い始めた少額減価償却資産の取得価額の合計（300万円の上限の確かめ） */
export const smallTotalOfYear = (assets: FixedAsset[], year: number) =>
  assets.filter((a) => a.method === "small" && yearOf(a.used_on) === year).reduce((s, a) => s + a.cost, 0);

/**
 * 年末の減価償却の仕訳の明細（決算整理仕訳・直接法）
 *  資産ごとに「減価償却費（事業分） / 資産の科目（償却費の全額）」、家事分があれば次の行に「事業主貸（家事分）」
 */
export const depreciationLines = (assets: FixedAsset[], year: number, ids: { expense: number; draw: number; expenseRealEstate?: number }): JournalLine[] => {
  const lines: JournalLine[] = [];
  let row = 0;
  for (const a of assets) {
    const d = depreciationFor(a, year);
    if (!d || d.depreciation === 0) continue;
    const memo = `減価償却 ${a.name}`;
    const privateMemo = `${memo}（家事分 ${100 - d.businessRate}%）`;
    row++;
    const expense = a.income_kind === "realestate" && ids.expenseRealEstate ? ids.expenseRealEstate : ids.expense;
    if (d.business > 0) {
      lines.push({ row_no: row, side: "debit", account_id: expense, sub_account_id: null, amount: d.business, memo });
      lines.push({ row_no: row, side: "credit", account_id: a.account_id, sub_account_id: null, amount: d.depreciation, memo });
      if (d.private > 0) lines.push({ row_no: ++row, side: "debit", account_id: ids.draw, sub_account_id: null, amount: d.private, memo: privateMemo });
    } else {
      lines.push({ row_no: row, side: "debit", account_id: ids.draw, sub_account_id: null, amount: d.private, memo: privateMemo });
      lines.push({ row_no: row, side: "credit", account_id: a.account_id, sub_account_id: null, amount: d.depreciation, memo });
    }
  }
  return lines;
};

/**
 * 売却・除却の仕訳の明細（売却・除却した日付で1本。定額法・定率法の資産だけ。一括償却資産・少額減価償却資産・繰延資産は null）
 * 個人の事業用資産の売却損益は事業所得ではなく譲渡所得なので、帳簿価額との差は事業主借（益）・事業主貸（損）にする（除却損は事業所得の経費）
 *  売却：受け取った科目 X ／ 資産の科目 X（課税売上 10%。家事と兼用する資産は事業用の部分だけ。簡易課税は第4種）
 *        差額は 資産の科目 ／ 事業主借（益）、または 事業主貸 ／ 資産の科目（損）
 *  除却：固定資産除却損（事業用の部分）＋ 事業主貸（家事分） ／ 資産の科目（帳簿価額）
 * 帳簿価額は、売却・除却した年の期末の未償却残高（その年の減価償却費は、年末の減価償却の仕訳で売却・除却した月まで差し引く）。
 * 税区分は付けておき、免税事業者の期間なら登録のときに外れる
 */
export const disposalLines = (
  a: FixedAsset, ids: { receive: number; ownerLoan: number; ownerDraw: number; loss: number },
): JournalLine[] | null => {
  if (!a.disposed_on || !a.disposal_kind || (a.method !== "straight" && a.method !== "declining")) return null;
  const year = yearOf(a.disposed_on);
  const book = depreciationFor(a, year)?.closing ?? 0;
  const rate = businessRateIn(a, year);
  const memo = `${DISPOSAL_LABEL[a.disposal_kind]} ${a.name}`;
  const lines: JournalLine[] = [];
  let row = 0;
  const push = (side: JournalLine["side"], account_id: number, amount: number, extra: Partial<JournalLine> = {}, sameRow = false) => {
    if (amount <= 0) return;
    lines.push({ row_no: sameRow ? row : ++row, side, account_id, sub_account_id: null, amount, memo, tax_code: "none", ...extra });
  };
  if (a.disposal_kind === "sale") {
    const price = a.sale_price ?? 0;
    // 課税売上は事業用の部分だけ（家事と兼用する資産。消費税は事業用の部分の譲渡だけが課税）
    const taxable = rate >= 100 ? price : Math.floor((price * rate) / 100);
    push("debit", ids.receive, price);
    push("credit", a.account_id, taxable, { tax_code: "sales10", business_class: 4 }, true);
    push("credit", a.account_id, price - taxable, {}, true);
    if (price > book) {
      push("debit", a.account_id, price - book);
      push("credit", ids.ownerLoan, price - book, {}, true);
    } else if (price < book) {
      push("debit", ids.ownerDraw, book - price);
      push("credit", a.account_id, book - price, {}, true);
    }
  } else {
    const business = rate >= 100 ? book : Math.floor((book * rate) / 100);
    push("debit", ids.loss, business);
    push("debit", ids.ownerDraw, book - business, {}, lines.length > 0);
    push("credit", a.account_id, book, {}, true);
  }
  return lines;
};
