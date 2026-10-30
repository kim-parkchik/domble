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
 *  - 一括償却資産（10万円以上20万円未満）：取得価額の 1/3 ずつを3年。月割りしない。売ったり捨てたりしても3年続ける
 *  - 少額減価償却資産（青色申告・30万円未満。1年の合計300万円まで）：使い始めた年に全額
 * 償却率は「1 / 耐用年数」を小数第3位で切り上げたもの（定額法の償却率表と同じ値になる）
 *
 * 事業専用割合：償却費のうち、必要経費に入れるのは事業で使っている割合だけ（1円未満は切り捨て。経費を多く見積もらない側）。
 * 残りは事業主貸にする。未償却残高は、割合にかかわらず償却費の全額だけ減る。
 * 割合は年ごとに見直せる（家事按分と同じく「何年から何%」。前の年の割合はそのまま）
 *
 * 年の締め：締めた年に台帳・決算書に出る資産は、売却・除却の日（締めていない年の分）と、締めていない年からの事業専用割合だけ変えられる
 * （assetLockError。DB のトリガー（schema.ts）でも同じ条件で拒否する）
 */

export type DepreciationMethod = "straight" | "lump3" | "small";

export const METHOD_LABEL: Record<DepreciationMethod, string> = {
  straight: "定額法",
  lump3: "一括償却資産（3年）",
  small: "少額減価償却資産",
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
  if (norm(before.disposed_on) !== norm(after.disposed_on)) {
    const from = Math.min(before.disposed_on ? yearOf(before.disposed_on) : Infinity, after.disposed_on ? yearOf(after.disposed_on) : Infinity);
    const hit = years.filter((y) => y >= from);
    if (hit.length) return `売却・除却の日の変更は、締め済みの年（${yearsText(hit)}）の台帳が変わるためできません。${LOCK_HINT}`;
  }
  const rateHit = years.filter((y) => businessRateIn(before, y) !== businessRateIn(after, y));
  if (rateHit.length) return `${yearsText(rateHit)}は締め済みのため、その年の事業専用割合は変えられません。${LOCK_HINT}`;
  return null;
};

/** 償却費のうち事業分（切り捨て）と家事分 */
export const splitBusiness = (amount: number, rate: number) => {
  const business = Math.floor((amount * rate) / 100);
  return { business, private: amount - business };
};

/** 1年分の償却費（期首の未償却残高 book から） */
const depreciationOfYear = (a: FixedAsset, year: number, book: number) => {
  const start = yearOf(a.used_on);
  if (a.method === "small") return year === start ? book : 0;
  if (a.method === "lump3") {
    // 1/3 ずつ。端数は、3年で取得価額ちょうどになるように各年で切り上げて調整する
    const k = year - start + 1;
    if (k < 1 || k > 3) return 0;
    return Math.min(book, Math.ceil((a.cost * k) / 3) - Math.ceil((a.cost * (k - 1)) / 3));
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
 */
export const depreciationFor = (a: FixedAsset, year: number): YearDepreciation | null => {
  const start = yearOf(a.used_on);
  if (year < start) return null;
  // 一括償却資産は除却しても3年続けるので、除却で打ち切らない
  if (a.method !== "lump3" && a.disposed_on && yearOf(a.disposed_on) < year) return null;
  let book = a.cost;
  for (let y = start; y < year; y++) {
    if (a.opening_year !== null && a.opening_book_value !== null && y === a.opening_year) book = a.opening_book_value;
    book -= depreciationOfYear(a, y, book);
  }
  if (a.opening_year !== null && a.opening_book_value !== null && year === a.opening_year) book = a.opening_book_value;
  const depreciation = depreciationOfYear(a, year, book);
  const businessRate = businessRateIn(a, year);
  const { business, private: priv } = splitBusiness(depreciation, businessRate);
  const old = isOldStraight(a);
  const equal = old && book <= oldFloor(a.cost);
  return {
    rate: a.method !== "straight" ? null : equal ? 0.2 : (old ? oldStraightRateMil(a.useful_life) : straightRateMil(a.useful_life)) / 1000,
    base: equal ? oldFloor(a.cost) : old ? Math.floor((a.cost * 9) / 10) : a.cost,
    equal,
    months: a.method === "straight" ? monthsIn(a, year) : 12,
    opening: book,
    depreciation,
    businessRate,
    business,
    private: priv,
    closing: book - depreciation,
    disposed: !!a.disposed_on && yearOf(a.disposed_on) === year,
  };
};

/** 入力の確かめ。問題があれば文言を返す */
export const validateAsset = (a: Omit<FixedAsset, "id">, opts: { blue: boolean }): string | null => {
  if (!a.name.trim()) return "名称を入れてください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.acquired_on)) return "取得日を入れてください";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.used_on)) return "事業に使い始めた日を入れてください";
  if (a.used_on < a.acquired_on) return "使い始めた日は、取得日より後にしてください";
  if (!Number.isInteger(a.cost) || a.cost <= 0) return "取得価額は 1円以上の整数で入れてください";
  if (!Number.isInteger(a.business_rate) || a.business_rate < 0 || a.business_rate > 100) return "事業専用割合は 0〜100 の整数で入れてください";
  if (a.method === "straight" && (!Number.isInteger(a.useful_life) || a.useful_life < 2 || a.useful_life > 100)) return "耐用年数は 2〜100 の整数で入れてください";
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
