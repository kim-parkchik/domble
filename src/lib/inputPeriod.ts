/**
 * 入力期間（純粋関数）
 *
 * 優良な電子帳簿の要件「通常の期間を経過した後に入力した場合は、その事実を確認できること」のため、
 * 取引日と入力期間（帳簿ごとの決め方）から入力の期限を出し、それを過ぎて登録したものを「遅れて登録」とする。
 * 決め方は3つ（事務処理規程などで決めた期間に合わせる）：
 *  - days：取引日から○日（暦日）。既定 70 日＝業務処理サイクル方式の「最長2か月 + おおむね7営業日」の目安（constants/appConfig.ts）
 *  - business：取引日から○営業日
 *  - monthEnd：取引の月の翌月末・翌々月末まで、さらに○営業日（月末締めで翌月に入れる、など）
 * 営業日は土日と、祝日・休業日（daysOff。スキャナ保存と同じ）を除いて数える
 */
import { addBusinessDays, type DaysOff } from "./scan";
import { DEFAULT_INPUT_PERIOD_DAYS, MAX_INPUT_PERIOD_DAYS } from "../constants/appConfig";

export type InputPeriod =
  | { kind: "days"; days: number }
  | { kind: "business"; days: number }
  /** months：1 = 翌月末、2 = 翌々月末。extra：その月末からさらに何営業日 */
  | { kind: "monthEnd"; months: number; extra: number };

export const DEFAULT_INPUT_PERIOD: InputPeriod = { kind: "days", days: DEFAULT_INPUT_PERIOD_DAYS };
/** 営業日の入力期間・月末からの営業日の上限 */
export const MAX_INPUT_BUSINESS_DAYS = 250;
export const MAX_MONTH_END_EXTRA = 20;
const NO_DAYS_OFF: DaysOff = new Set();

/** YYYY-MM-DD（または YYYY-MM-DD HH:MM:SS）の日付部分を、日数の通し番号にする */
const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** 取引日から登録日までの日数（登録日時は日付部分だけを見る。取引日より前に登録したものはマイナス） */
export const inputDelayDays = (date: string, recordedAt: string) => dayNumber(recordedAt) - dayNumber(date);

/** 取引の月の months か月あとの月末（1 = 翌月末） */
const monthEndAfter = (date: string, months: number) => {
  const [y, m] = date.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months + 1, 0)).toISOString().slice(0, 10);
};

/** 入力の期限（この日までに登録すれば期間内） */
export const inputDeadline = (date: string, p: InputPeriod, daysOff: DaysOff = NO_DAYS_OFF) =>
  p.kind === "days" ? isoOf(dayNumber(date) + p.days)
    : p.kind === "business" ? addBusinessDays(date.slice(0, 10), p.days, daysOff)
      : addBusinessDays(monthEndAfter(date, p.months), p.extra, daysOff);

/** 入力期間を過ぎて登録したか（ちょうど期限の日はまだ期間内。日数だけ渡せば「取引日から○日」） */
export const isLateInput = (date: string, recordedAt: string | null | undefined, p: InputPeriod | number, daysOff: DaysOff = NO_DAYS_OFF) =>
  !!recordedAt && recordedAt.slice(0, 10) > inputDeadline(date, typeof p === "number" ? { kind: "days", days: p } : p, daysOff);

/** 入力期間の文（例：取引日から 70 日、取引日から 50 営業日、取引の月の翌月末から 7 営業日） */
export const inputPeriodText = (p: InputPeriod) => {
  if (p.kind === "days") return `取引日から ${p.days} 日`;
  if (p.kind === "business") return `取引日から ${p.days} 営業日`;
  const end = p.months === 1 ? "翌月末" : p.months === 2 ? "翌々月末" : `${p.months}か月後の月末`;
  return p.extra ? `取引の月の${end}から ${p.extra} 営業日` : `取引の月の${end}まで`;
};

/** 事務処理規程などに書く文（例：取引日から 70 日以内に入力する、取引の月の翌月末までに入力する） */
export const inputPeriodDuty = (p: InputPeriod) => `${inputPeriodText(p)}${p.kind === "monthEnd" && !p.extra ? "に" : "以内に"}入力する`;

/** 営業日を数えるか（祝日・休業日を読む） */
export const usesBusinessDays = (p: InputPeriod) => p.kind === "business" || (p.kind === "monthEnd" && p.extra > 0);

/** 入力期間の問題（無ければ null） */
export const inputPeriodProblem = (p: InputPeriod): string | null => {
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (p.kind === "days") return int(p.days, 1, MAX_INPUT_PERIOD_DAYS) ? null : `入力期間は 1〜${MAX_INPUT_PERIOD_DAYS} 日の整数で入れてください`;
  if (p.kind === "business") return int(p.days, 1, MAX_INPUT_BUSINESS_DAYS) ? null : `入力期間は 1〜${MAX_INPUT_BUSINESS_DAYS} 営業日の整数で入れてください`;
  if (!int(p.months, 1, 2)) return "月末は翌月末か翌々月末を選んでください";
  return int(p.extra, 0, MAX_MONTH_END_EXTRA) ? null : `月末からの営業日は 0〜${MAX_MONTH_END_EXTRA} の整数で入れてください`;
};

/**
 * 保存している値から入力期間に（settings.input_period_rule が空なら input_period_days の日数）。
 * 読めない・おかしな値は、日数のほうにする
 */
export const parseInputPeriod = (rule: string | null | undefined, days: number | null | undefined): InputPeriod => {
  const fallback: InputPeriod = { kind: "days", days: days || DEFAULT_INPUT_PERIOD_DAYS };
  if (!rule) return fallback;
  try {
    const x = JSON.parse(rule) as Partial<Record<string, unknown>>;
    const p: InputPeriod | null = x.kind === "business" ? { kind: "business", days: Number(x.days) }
      : x.kind === "monthEnd" ? { kind: "monthEnd", months: Number(x.months), extra: Number(x.extra) } : null;
    return p && !inputPeriodProblem(p) ? p : fallback;
  } catch {
    return fallback;
  }
};
