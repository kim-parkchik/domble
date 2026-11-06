/**
 * 申告の種類（青色75・65・55・10万円控除・白色）を年度ごとに持つ（純粋関数）
 *  - 年度ごとの設定（filing_years）は from_year 以降に効き、次の設定がある年まで引き継ぐ（消費税の tax_years と同じ考え方）
 *  - 設定の無い年（いちばん古い設定より前・まだ一度も年度ごとに変えていない帳簿）は、帳簿を作ったときの設定（settings.filing_type）
 *  - 年の締めをした年度の設定は変えられない（トリガーと repo）
 * 開業の年は白色、承認を受けた翌年から青色、e-Tax をやめて 65万円から 55万円、のように年で変わるため
 *
 * 青色申告特別控除の見直し（令和8年度税制改正。令和9年分から。租税特別措置法25条の2）
 *  - 65万円：正規の簿記で記帳し、確定申告書・貸借対照表・損益計算書等を期限内に e-Tax で出す（55万円の控除に e-Tax の要件を加えて 65万円に）
 *  - 75万円：65万円の要件に加えて、その年の仕訳帳・総勘定元帳を電子帳簿保存法の電磁的記録で保存し、
 *      イ 優良な電子帳簿の要件を満たす、または ロ 特定電子計算機処理システムを使って電子取引のデータを保存する（どちらも届出書を出す）
 *  - 55万円は無くなり、書面で申告すると 10万円。簡易な簿記で前々年の収入が 1,000万円を超える人は 10万円も受けられない（domble の帳簿は正規の簿記）
 *  - 選べる種類は年で変える（filingTypesFor）。55万円を引き継いだ令和9年分以後の年は 10万円で計算し、知らせる（filingNotes）
 */
import type { FilingType, FilingYear } from "./types";
import { longDate } from "./format";

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
  blue75: "青色申告（75万円控除）",
  blue65: "青色申告（65万円控除）",
  blue55: "青色申告（55万円控除）",
  blue10: "青色申告（10万円控除）",
  white: "白色申告",
};

export const isFilingType = (v: unknown): v is FilingType => (Object.keys(FILING_LABEL) as unknown[]).includes(v);

export const isBlue = (t: FilingType) => t !== "white";

/** 75万円の控除ができ、55万円の控除が無くなる年（令和9年分） */
export const BLUE75_FROM = 2027;

/** その年に選べる申告の種類 */
export const filingTypesFor = (year: number): FilingType[] =>
  year >= BLUE75_FROM ? ["blue75", "blue65", "blue10", "white"] : ["blue65", "blue55", "blue10", "white"];

/** その年に選べない種類なら、その理由 */
export const filingTypeProblem = (type: FilingType, year: number) =>
  filingTypesFor(year).includes(type) ? ""
    : type === "blue75" ? "75万円の青色申告特別控除は令和9年分からです"
      : "55万円の青色申告特別控除は令和8年分までです（令和9年分からは、e-Tax で申告すると65万円、書面で申告すると10万円）";

export interface FilingNote {
  level: "warn" | "info";
  text: string;
}

/**
 * 申告の種類について知らせること（令和9年分から）
 * ebook：その年が電子帳簿保存法に対応した年（厳密モード）か、優良な電子帳簿の届出書を出したか（電子帳簿保存法の画面のチェック）
 */
export const filingNotes = (type: FilingType, year: number, ebook: { compliant: boolean; filed: boolean }): FilingNote[] => {
  if (year < BLUE75_FROM) return [];
  const eTax = "e-Tax で期限内に申告することが条件です（書面で出すと10万円）。";
  if (type === "blue55") {
    return [{
      level: "warn",
      text: "令和9年分から55万円の控除は無くなりました。書面で申告すると10万円なので、10万円で計算しています。"
        + "e-Tax で申告するなら、事業者設定の申告の種類を65万円（優良な電子帳簿で保存して届出書を出していれば75万円）にしてください。",
    }];
  }
  if (type === "blue65") {
    return [{ level: "info", text: `65万円の控除は、${eTax}${ebook.compliant && ebook.filed ? "優良な電子帳簿で保存して届出書を出しているので、75万円にできます（事業者設定の申告の種類）。" : ""}` }];
  }
  if (type !== "blue75") return [];
  if (ebook.compliant && ebook.filed) return [{ level: "info", text: `75万円の控除は、${eTax}` }];
  return [{
    level: "warn",
    text: "75万円の控除は、e-Tax で期限内に申告し、その年の仕訳帳・総勘定元帳を優良な電子帳簿で保存して、届出書を出していることが条件です。"
      + (ebook.compliant ? "電子帳簿保存法の画面で、届出書を出したことにチェックがありません。" : `${year}年は電子帳簿保存法の対応外（厳密モードでない年）です。`)
      + "電子取引のデータを特定電子計算機処理システムで保存する方法（届出が要ります）で受けるときは、その条件を満たしているか確かめてください。",
  }];
};

/**
 * 期限後申告の青色申告特別控除（No.2072）：55万円・65万円（令和9年分からは 65万円・75万円）は、法定申告期限までに出したときだけで、期限後に出すと 10万円まで。
 * due：その年分の所得税の申告期限（休みの日なら次の日）、today：今日、filings：その年分の所得税の申告の控え（種類・申告した日）。
 * 期限内に出した確定申告の控えがあれば何も言わない（あとの修正申告は、期限内の申告の控除のまま）
 */
export const lateFilingNote = (
  type: FilingType, year: number, due: string | null, today: string, filings: { kind: string; filed_on: string }[],
): FilingNote | null => {
  if (!due || type === "white" || type === "blue10") return null;
  const original = filings.find((f) => f.kind === "original");
  if (original ? original.filed_on <= due : today <= due) return null;
  const head = original
    ? `${longDate(original.filed_on)}に出した確定申告は、申告期限（${longDate(due)}）の後です（期限後申告）。`
    : `令和${year - 2018}年分の確定申告の期限（${longDate(due)}）を過ぎています。`;
  return {
    level: "warn",
    text: head + "期限後に出す確定申告では、青色申告特別控除は10万円までです（55万円・65万円・75万円は、期限内に出したときだけ）。"
      + `期限後に出すときは、事業者設定の申告の種類を ${year}年は10万円にしてください（翌年からは元の種類に戻します）。期限内に出した申告を直す修正申告なら、このままで構いません。`,
  };
};
