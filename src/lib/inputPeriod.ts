/**
 * 入力期間（純粋関数）
 *
 * 優良な電子帳簿の要件「通常の期間を経過した後に入力した場合は、その事実を確認できること」のため、
 * 仕訳の取引日から登録日までの日数を出し、入力期間（帳簿ごとの日数）を超えたものを「遅れて登録」とする。
 * 入力期間の目安は、業務処理サイクル方式の「最長2か月 + おおむね7営業日」→ 既定 70 日（constants/appConfig.ts）
 */

/** YYYY-MM-DD（または YYYY-MM-DD HH:MM:SS）の日付部分を、日数の通し番号にする */
const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** 取引日から登録日までの日数（登録日時は日付部分だけを見る。取引日より前に登録したものはマイナス） */
export const inputDelayDays = (date: string, recordedAt: string) => dayNumber(recordedAt) - dayNumber(date);

/** 入力期間を過ぎて登録したか */
export const isLateInput = (date: string, recordedAt: string | null | undefined, limitDays: number) =>
  !!recordedAt && inputDelayDays(date, recordedAt) > limitDays;
