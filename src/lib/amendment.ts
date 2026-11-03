/**
 * 申告の控えと、修正申告・更正の請求の手助け（純粋関数）
 *  - 申告の控え：申告した日・種類（確定申告・修正申告・更正の通知）と、申告書の主な数字（FilingLine）を年ごとに残す（repo の tax_filings）。
 *    いちばん新しい控えが「修正前」になる（2回目の修正申告にも使う）
 *  - 修正前と今の帳簿の数字を比べ、税額が増えていれば修正申告、減っていれば更正の請求（国税庁 No.2026）
 *  - 所得税の修正申告：確定申告書 第一表の「修正申告」の欄（修正前の第3期分の税額・第3期分の税額の増加額）と、上の「修正」の区分。
 *    令和4年分からは第五表（修正申告用）は要らない（No.2026）。e-Tax は申告の種類「2:修正」・修正区分「1:該当」（帳票フィールド仕様書 KOA020 23.0）
 *  - 消費税の修正申告：第一表 ⑬ 既確定税額（修正前の納付税額。還付ならマイナス）・⑭ 差引納付税額（修正後 − ⑬。百円未満切り捨て）、
 *    ㉔ 既確定譲渡割額・㉕ 差引納付譲渡割額、㉖ ＝ ⑭＋㉕。e-Tax は申告の種類「3:修正確定」（帳票フィールド仕様書 SHA010 10.0・SHA020 9.0）
 *  - 更正の請求：法定申告期限から5年以内（No.2026）。更正の請求書は国税庁の作成コーナーなどで出す（ここでは数字と期限まで）
 *  - 延滞税・加算税は計算しない（知らせるだけ）
 */
import type { IncomeTaxResult } from "./incomeTax";
import type { TaxReturn } from "./taxReturn";
import { consumptionTaxDeadline, incomeTaxDeadline, nextWeekday } from "./deadlines";
import { longDate } from "./format";

export type FilingTax = "income" | "consumption";
/** original 確定申告（出し直し・期限後を含む） ／ amended 修正申告 ／ reassessed 更正（税務署からの通知・更正の請求が認められたとき） */
export type FilingKind = "original" | "amended" | "reassessed";
export const FILING_TAX_LABEL: Record<FilingTax, string> = { income: "所得税", consumption: "消費税" };
export const FILING_KIND_LABEL: Record<FilingKind, string> = { original: "確定申告", amended: "修正申告", reassessed: "更正（税務署からの通知）" };

/** 申告書の数字の1行（欄の番号・名前は控えを残したときのもの） */
export interface FilingLine {
  key: string;
  no: string;
  label: string;
  value: number;
}

export interface TaxFiling {
  id: number;
  fiscal_year: number;
  tax: FilingTax;
  kind: FilingKind;
  /** 申告した日（YYYY-MM-DD） */
  filed_on: string;
  lines: FilingLine[];
  memo: string;
}

const floor100 = (n: number) => Math.floor(n / 100) * 100;
const valueOf = (lines: FilingLine[], key: string) => lines.find((l) => l.key === key)?.value ?? 0;

/** 所得税：控えに残す第一表の欄と名前（第3期分の税額は「納める税金 − 還付される税金」の1行にまとめる） */
const INCOME_LINES: [string, string][] = [
  ["business", "事業所得"], ["realestate", "不動産所得"], ["total", "所得金額等の合計"], ["deductions", "所得から差し引かれる金額の合計"],
  ["taxable", "課税される所得金額"], ["taxTotal", "所得税及び復興特別所得税の額"], ["withheld", "源泉徴収税額"], ["declared", "申告納税額"],
  ["prepaid", "予定納税額"],
];
export const incomeFilingLines = (r: IncomeTaxResult): FilingLine[] => [
  ...INCOME_LINES.flatMap(([key, label]) => {
    const row = r.rows.find((x) => x.key === key);
    return row ? [{ key, no: row.no, label, value: row.value ?? 0 }] : [];
  }),
  { key: "third", no: "", label: "第3期分の税額（還付は−）", value: r.balance },
];

/** 消費税：控えに残す第一表の欄（納付税額は「納付 − 還付」で、消費税・地方消費税ごとに1行） */
const CONSUMPTION_LINES: [string, string, string][] = [
  ["base", "①", "課税標準額"], ["tax", "②", "消費税額"], ["deduct", "④", "控除対象仕入税額"], ["net", "⑨", "差引税額"], ["localTax", "⑳", "譲渡割額（納税額）"],
];
export const consumptionFilingLines = (r: TaxReturn): FilingLine[] => {
  const first = r.forms.find((f) => f.id === "first")?.rows ?? [];
  return [
    ...CONSUMPTION_LINES.map(([key, no, label]) => ({ key, no, label, value: first.find((x) => x.no === no)?.c ?? 0 })),
    { key: "national", no: "", label: "消費税の納付税額（⑪−⑧−⑫。還付は−）", value: r.national },
    { key: "local", no: "", label: "地方消費税の納付税額（㉒−⑲−㉓。還付は−）", value: r.local },
    { key: "total", no: "㉖", label: "消費税及び地方消費税の合計（還付は−）", value: r.total },
  ];
};

export interface FilingDiff {
  key: string;
  no: string;
  label: string;
  before: number | null;
  after: number | null;
  diff: number;
}
/** 修正前と今の数字を、行ごとに並べる（今の行の順。修正前にしか無い行はあと） */
export const compareFilings = (before: FilingLine[], after: FilingLine[]): FilingDiff[] => [
  ...after.map((a) => {
    const b = before.find((x) => x.key === a.key);
    return { key: a.key, no: a.no, label: a.label, before: b ? b.value : null, after: a.value, diff: a.value - (b?.value ?? 0) };
  }),
  ...before.filter((b) => !after.some((a) => a.key === b.key)).map((b) => ({ key: b.key, no: b.no, label: b.label, before: b.value, after: null, diff: -b.value })),
];

/** 所得税の修正申告の欄（第一表） */
export interface IncomeAmend {
  /** 修正前の第3期分の税額（還付はマイナス。納める税金は百円未満切り捨て済み） */
  before: number;
  /** 第3期分の税額の増加額（百円未満切り捨て） */
  increase: number;
}
/** 消費税の修正申告の欄（第一表 ⑬⑭㉔㉕㉖） */
export interface ConsumptionAmend {
  /** ⑬ 既確定税額（修正前の納付税額。還付はマイナス） */
  known: number;
  /** ⑭ 差引納付税額 */
  pay: number;
  /** ㉔ 既確定譲渡割額 */
  knownLocal: number;
  /** ㉕ 差引納付譲渡割額 */
  payLocal: number;
  /** ㉖ 消費税及び地方消費税の合計税額（⑭＋㉕） */
  total: number;
}

/**
 * 修正前と比べた判定：amend 修正申告（税額が増える）／ claim 更正の請求（税額が減る）／ same 同じ ／ other 税額は同じで、ほかの数字が違う
 * increase = 増える税額（修正申告で納める額）、decrease = 減る税額（更正の請求で戻る額）
 */
export type AmendStatus = "amend" | "claim" | "same" | "other";
export interface Amendment {
  status: AmendStatus;
  increase: number;
  decrease: number;
  income?: IncomeAmend;
  consumption?: ConsumptionAmend;
}

const changed = (before: FilingLine[], after: FilingLine[]) => compareFilings(before, after).some((d) => d.diff !== 0);

export const incomeAmendment = (before: FilingLine[], after: FilingLine[]): Amendment => {
  const b = valueOf(before, "third");
  const d = valueOf(after, "third") - b;
  if (d > 0) return { status: "amend", increase: floor100(d), decrease: 0, income: { before: b, increase: floor100(d) } };
  if (d < 0) return { status: "claim", increase: 0, decrease: -d };
  return { status: changed(before, after) ? "other" : "same", increase: 0, decrease: 0 };
};

export const consumptionAmendment = (before: FilingLine[], after: FilingLine[]): Amendment => {
  const [bn, bl] = [valueOf(before, "national"), valueOf(before, "local")];
  const [dn, dl] = [valueOf(after, "national") - bn, valueOf(after, "local") - bl];
  if (dn > 0 || dl > 0) {
    const pay = floor100(Math.max(dn, 0));
    const payLocal = floor100(Math.max(dl, 0));
    return { status: "amend", increase: pay + payLocal, decrease: 0, consumption: { known: bn, pay, knownLocal: bl, payLocal, total: pay + payLocal } };
  }
  if (dn < 0 || dl < 0) return { status: "claim", increase: 0, decrease: -(dn + dl) };
  return { status: changed(before, after) ? "other" : "same", increase: 0, decrease: 0 };
};

export const amendmentOf = (tax: FilingTax, before: FilingLine[], after: FilingLine[]) =>
  tax === "income" ? incomeAmendment(before, after) : consumptionAmendment(before, after);

/** いちばん新しい控え（申告した日、同じ日なら登録の新しい順）。修正前の数字になる */
export const latestFiling = (filings: TaxFiling[], tax: FilingTax, year: number) =>
  filings.filter((f) => f.tax === tax && f.fiscal_year === year).sort((a, b) => b.filed_on.localeCompare(a.filed_on) || b.id - a.id)[0] ?? null;

/** 法定申告期限（土日・祝日なら次の平日） */
export const filingDeadline = (tax: FilingTax, year: number, holidays: ReadonlySet<string>) =>
  tax === "income" ? incomeTaxDeadline(year, holidays) : consumptionTaxDeadline(year, holidays);

/** 更正の請求ができる期限（法定申告期限から5年。土日・祝日なら次の平日） */
export const claimDeadline = (tax: FilingTax, year: number, holidays: ReadonlySet<string>) => {
  const due = filingDeadline(tax, year, holidays);
  return nextWeekday(`${Number(due.slice(0, 4)) + 5}${due.slice(4)}`, holidays);
};

/** 修正申告のときに知らせること（延滞税・加算税は計算しない） */
export const amendNotes = (tax: FilingTax, due: string): string[] => [
  "修正申告で増えた税額は、修正申告書を出した日が納期限です。その日に納めてください。",
  `法定納期限（${longDate(due)}）の翌日から納めた日までの延滞税がかかります（額は税務署から知らせが来ます）。`,
  "税務署から調査の事前通知を受ける前に自分から修正申告をすれば、過少申告加算税はかかりません。",
  tax === "income"
    ? "住民税・事業税は、税務署から市区町村などに知らせが行くので、別に手続はいりません。"
    : "税込経理では、修正申告で増えた消費税は、修正申告書を出した年の必要経費（租税公課）になります（直した年の未払消費税等は直しません）。",
];

/** 更正の請求のときに知らせること */
export const claimNotes = (deadline: string): string[] => [
  `更正の請求書に、申告した額と正しい額、請求の理由を書き、事実を証明する書類を付けて出します。期限は法定申告期限から5年（${longDate(deadline)}）までです。`,
  "更正の請求書は、国税庁の「更正の請求書・修正申告書作成コーナー」や e-Tax で作れます（domble では作りません）。",
  "最終的な税額（または純損失の金額）が変わらないときは、更正の請求はできません。",
];

/** 法定申告期限までなら、修正申告・更正の請求ではなく、確定申告を出し直せる（あとから出したものが申告になる） */
export const withinDeadlineNote = (due: string) =>
  `申告期限（${longDate(due)}）までなら、修正申告や更正の請求ではなく、確定申告書をもう一度出し直せます（あとから出したものが申告になります）。`;

/** 申告したあとに帳簿を直すときの手順 */
export const AMEND_STEPS = [
  "事業者設定で、その年の締めを戻す（厳密モードでは理由を入れる）",
  "帳簿を直す（仕訳・決算整理・固定資産台帳など）",
  "翌年に繰り越していれば、事業者設定で繰越をやり直す",
  "決算書・申告書の数字を確かめ、下の比べる表で増えた・減った税額を見る",
  "修正申告書を出して納める（e-Tax のデータは修正申告で書き出せる）。減るときは更正の請求書を出す",
  "「申告した」で修正申告の控えを残す",
  "年を締め直す",
];
