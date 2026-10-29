/**
 * 申告の種類（青色65・55・10万円控除・白色）を年度ごとに持つ（純粋関数）
 *  - 年度ごとの設定（filing_years）は from_year 以降に効き、次の設定がある年まで引き継ぐ（消費税の tax_years と同じ考え方）
 *  - 設定の無い年（いちばん古い設定より前・まだ一度も年度ごとに変えていない帳簿）は、帳簿を作ったときの設定（settings.filing_type）
 *  - 年の締めをした年度の設定は変えられない（トリガーと repo）
 * 開業の年は白色、承認を受けた翌年から青色、e-Tax をやめて 65万円から 55万円、のように年で変わるため
 */
import type { FilingType, FilingYear } from "./types";

export interface FilingOfYear {
  type: FilingType;
  /** その年の設定ではなく、前の年（または帳簿を作ったとき）から引き継いだもの */
  inherited: boolean;
}

export const filingOf = (rows: FilingYear[], base: FilingType, year: number): FilingOfYear => {
  const r = rows.filter((x) => x.from_year <= year).sort((a, b) => b.from_year - a.from_year)[0];
  return r ? { type: r.filing_type, inherited: r.from_year !== year } : { type: base, inherited: true };
};

export const FILING_LABEL: Record<FilingType, string> = {
  blue65: "青色申告（65万円控除）",
  blue55: "青色申告（55万円控除）",
  blue10: "青色申告（10万円控除）",
  white: "白色申告",
};

export const isFilingType = (v: unknown): v is FilingType => v === "blue65" || v === "blue55" || v === "blue10" || v === "white";

export const isBlue = (t: FilingType) => t !== "white";
