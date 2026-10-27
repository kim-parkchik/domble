/**
 * 消費税の中間申告（純粋関数）。個人事業者・令和8年分の制度
 *  - 判定は前年の確定消費税額（第一表の ⑨ 差引税額。地方消費税は含まない）
 *      48万円以下 → 要らない（「任意の中間申告書を提出する旨の届出書」を出していれば年1回）
 *      48万円超〜400万円以下 → 年1回（⑨ × 6/12）
 *      400万円超〜4,800万円以下 → 年3回（⑨ × 3/12）
 *      4,800万円超 → 年11回（⑨ × 1/12）
 *  - 中間納付税額は百円未満切り捨て。地方消費税（中間納付譲渡割額）はその 22/78（百円未満切り捨て）
 *  - 期限は対象期間の末日の翌日から2か月以内（年11回の1月分・2月分は5月31日）。土日・祝日・12月29日〜1月3日なら次の日
 *  - 個人事業者の課税期間は暦年なので、前年の途中から課税事業者になっていても月数で割らない
 *  - その年が免税事業者なら中間申告は無い。仮決算による中間申告・課税期間の短縮の特例は扱わない
 */
import type { TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { taxYearOf } from "./tax";
import { buildTaxBase, computeReturn, floor100, type ReturnMethod } from "./taxReturn";

export const INTERIM_NONE_LIMIT = 480_000;
export const INTERIM_ONCE_LIMIT = 4_000_000;
export const INTERIM_THREE_LIMIT = 48_000_000;

// ────────────────────────────────────────────
// 前年の確定消費税額
// ────────────────────────────────────────────

export interface PrevTaxInfo {
  /** 前年 */
  year: number;
  /** 前年の確定消費税額（⑨。分からなければ null。免税事業者だった年は 0） */
  amount: number | null;
  /** books = 帳簿から計算、manual = 手で入れた額、exempt = 前年は免税事業者、none = 分からない */
  source: "books" | "manual" | "exempt" | "none";
  /** 帳簿から計算した ⑨（前年の帳簿が無い・免税事業者だったときは null） */
  fromBooks: number | null;
  /** 前年の課税区分（免税事業者なら null） */
  method: ReturnMethod | null;
}

export interface PrevTaxInput {
  /** 中間申告をする年 */
  year: number;
  /** 前年の明細（削除済みを除く） */
  prevLines: FlatLine[];
  taxYears: TaxYear[];
  /** 手で入れた前年の確定消費税額（無ければ null）。入っていれば帳簿の計算より優先する */
  manual: number | null;
}

/** 前年の ⑨ を、前年の帳簿と前年の課税区分（事業区分・控除の方式も前年のもの）で計算する */
export const prevTaxInfo = (x: PrevTaxInput): PrevTaxInfo => {
  const py = x.year - 1;
  const t = taxYearOf(x.taxYears, py);
  const method = t.status === "exempt" ? null : t.status;
  const fromBooks = method && x.prevLines.length
    ? computeReturn(method, buildTaxBase(x.prevLines, x.taxYears), { businessClass: t.business_class, interimNational: 0, interimLocal: 0, deduction: t.deduction }).net
    : null;
  const base = { year: py, fromBooks, method };
  if (x.manual !== null) return { ...base, amount: x.manual, source: "manual" };
  if (fromBooks !== null) return { ...base, amount: fromBooks, source: "books" };
  // 前年が免税事業者だったと言えるのは、前年の帳簿があるか、前年に効く消費税の設定があるとき（domble を今年から使い始めた人は分からない）
  if (!method && (x.prevLines.length > 0 || x.taxYears.some((r) => r.from_year <= py))) return { ...base, amount: 0, source: "exempt" };
  return { ...base, amount: null, source: "none" };
};

// ────────────────────────────────────────────
// 中間申告の予定
// ────────────────────────────────────────────

/** unknown = 前年の税額が分からない ／ exempt = その年は免税事業者 ／ none = 要らない ／ voluntary = 任意の中間申告（年1回）／ once・three・monthly = 年1回・年3回・年11回 */
export type InterimKind = "unknown" | "exempt" | "none" | "voluntary" | "once" | "three" | "monthly";

export interface InterimPeriod {
  no: number;
  /** 中間申告対象期間 */
  from: string;
  to: string;
  /** 申告・納付の期限（法律の日付） */
  due: string;
  /** 期限が土日・祝日・年末年始なら次の日 */
  payBy: string;
  /** 中間納付税額（消費税）・中間納付譲渡割額（地方消費税） */
  national: number;
  local: number;
}

export interface InterimPlan {
  year: number;
  kind: InterimKind;
  prevTax: number | null;
  periods: InterimPeriod[];
  /** 1年分の合計（確定申告の ⑩・㉑ に書く額） */
  national: number;
  local: number;
}

export interface InterimInput {
  year: number;
  prevTax: number | null;
  /** その年が免税事業者か */
  exempt: boolean;
  /** 任意の中間申告書を提出する旨の届出をしているか */
  voluntary: boolean;
  /** 祝日（YYYY-MM-DD）。期限を次の日にずらすのに使う */
  holidays?: ReadonlySet<string>;
}

export const interimKind = (prevTax: number | null, exempt: boolean, voluntary: boolean): InterimKind => {
  if (exempt) return "exempt";
  if (prevTax === null) return "unknown";
  if (prevTax > INTERIM_THREE_LIMIT) return "monthly";
  if (prevTax > INTERIM_ONCE_LIMIT) return "three";
  if (prevTax > INTERIM_NONE_LIMIT) return "once";
  return voluntary && prevTax > 0 ? "voluntary" : "none";
};

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** y 年 m 月の末日（m が 12 を超えたら翌年） */
const monthEnd = (y: number, m: number) => {
  const yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12) + 1;
  return `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}`;
};

/** 期限が土日・祝日・12月29日〜1月3日なら、その次の日（国税通則法10条2項） */
export const nextOpenDay = (iso: string, holidays: ReadonlySet<string> = new Set()) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const closed = () => {
    const s = d.toISOString().slice(0, 10), md = s.slice(5);
    return d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(s) || md >= "12-29" || md <= "01-03";
  };
  while (closed()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** 期間の月（開始月・終了月）と、前年の税額に掛ける割合（/12） */
const SCHEDULE: Record<"voluntary" | "once" | "three" | "monthly", { months: [number, number][]; share: number }> = {
  voluntary: { months: [[1, 6]], share: 6 },
  once: { months: [[1, 6]], share: 6 },
  three: { months: [[1, 3], [4, 6], [7, 9]], share: 3 },
  monthly: { months: Array.from({ length: 11 }, (_, i): [number, number] => [i + 1, i + 1]), share: 1 },
};

export const interimPlan = (x: InterimInput): InterimPlan => {
  const kind = interimKind(x.prevTax, x.exempt, x.voluntary);
  const empty: InterimPlan = { year: x.year, kind, prevTax: x.prevTax, periods: [], national: 0, local: 0 };
  if (kind === "unknown" || kind === "exempt" || kind === "none" || x.prevTax === null) return empty;
  const s = SCHEDULE[kind];
  const national = floor100(Math.floor((x.prevTax * s.share) / 12));
  const local = floor100(Math.floor((national * 22) / 78));
  const periods = s.months.map(([a, b], i): InterimPeriod => {
    // 年11回の1月分・2月分は5月31日（個人事業者）
    const due = kind === "monthly" && b <= 2 ? `${x.year}-05-31` : monthEnd(x.year, b + 2);
    return { no: i + 1, from: `${x.year}-${pad(a)}-01`, to: monthEnd(x.year, b), due, payBy: nextOpenDay(due, x.holidays), national, local };
  });
  return { ...empty, periods, national: national * periods.length, local: local * periods.length };
};

export const INTERIM_KIND_LABEL: Record<InterimKind, string> = {
  unknown: "前年の確定消費税額が分かりません",
  exempt: "免税事業者のため中間申告はありません",
  none: "中間申告は要りません",
  voluntary: "任意の中間申告（年1回）",
  once: "年1回",
  three: "年3回",
  monthly: "年11回",
};
