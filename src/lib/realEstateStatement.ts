/**
 * 不動産所得用の決算書の1ページの数字（純粋関数）。科目は所得の区分が不動産所得のもの（lib/incomeKind.ts）
 *  青色申告決算書（不動産所得用）：① 賃貸料 ② 礼金・権利金・更新料 ③ 名義書換料その他 ④ 計、
 *    ⑤ 租税公課 ⑥ 損害保険料 ⑦ 修繕費 ⑧ 減価償却費 ⑨ 借入金利子 ⑩ 地代家賃 ⑪ 給料賃金 ⑫〜⑯ 追加の欄 ⑰ その他の経費 ⑱ 計、
 *    ⑲ 差引金額 ⑳ 専従者給与 ㉑ 青色申告特別控除前の所得金額 ㉒ 青色申告特別控除額 ㉓ 所得金額
 *  収支内訳書（不動産所得用）：① 賃貸料 ② 礼金・権利金更新料 ③ 名義書換料その他 ④ 小計 ⑤ 計、
 *    ⑥ 給料賃金 ⑦ 減価償却費 ⑧ 貸倒金 ⑨ 地代家賃 ⑩ 借入金利子、㋑ 租税公課 ㋺ 損害保険料 ㋩ 修繕費 ㋥ 追加の欄 ㋭ 雑費 ⑪ 小計、
 *    ⑫ 経費計 ⑬ 専従者控除前の所得金額 ⑭ 専従者控除 ⑮ 所得金額
 * 科目は名前（「（不動産）」を除いた名前）で欄に当てる。当たらない経費は追加の欄（青色 5・白色 1）に、多ければ金額の小さいものから
 * その他の経費・雑費にまとめて知らせる。専従者給与は、事業的規模の青色申告のときだけ必要経費（白色の事業専従者控除は扱わない）
 */
import type { Account, FilingType, RealEstateScale } from "./types";
import { closingBalances, summarizeIncome, type FlatLine } from "./accounting";
import { partnerTotals, payeeBreakdown } from "./statements";
import { depreciationLinesOf, payeeLinesOf, payLinesOf, type BlueStatementSource, type DepreciationLine, type PayeeLine, type PayLine } from "./blueStatement";
import { CODE } from "../constants/accounts";
import { accountsOfKind } from "./incomeKind";
import { BLUE_DEDUCTION_LIMIT } from "./incomeTax";

export interface ReLine {
  no: string;
  label: string;
  amount: number;
  /** 追加の欄（科目名で書く） */
  extra: boolean;
}

export interface RealEstateStatement {
  form: "blue" | "white";
  /** 賃貸料・礼金・権利金・更新料・名義書換料その他（③ の名前は科目が1つならその名前）・収入の計 */
  revenue: { rent: number; keyMoney: number; other: number; otherLabel: string; total: number };
  /** 青色：⑤〜⑯（決まった欄と追加の欄）。白色：⑥〜⑩ */
  main: ReLine[];
  /** 白色の ㋑〜㋭（青色は空） */
  others: ReLine[];
  /** 青色 ⑰ その他の経費 ／ 白色 ⑪ 小計（その他の経費） */
  otherTotal: number;
  /** 青色 ⑱ ／ 白色 ⑫ */
  expenseTotal: number;
  /** 青色 ⑲ 差引金額 ／ 白色 ⑬ 専従者控除前の所得金額 */
  difference: number;
  /** 青色 ⑳ 専従者給与 ／ 白色 ⑭ 専従者控除（0） */
  family: number;
  /** 青色 ㉑ 青色申告特別控除前の所得金額 ／ 白色 ⑮ 所得金額 */
  beforeDeduction: number;
  /** 青色 ㉒ */
  deduction: number;
  /** 青色 ㉓ ／ 白色 ⑮ */
  income: number;
  warnings: string[];
}

const base = (a: Account) => a.name.normalize("NFKC").replace(/[（(]不動産[）)]$/, "").replace(/[\s・]/g, "");
const KEY_MONEY = new Set(["礼金権利金更新料", "礼金", "権利金", "更新料", "礼金権利金"]);
const ALIASES: Record<string, string> = { 火災保険料: "損害保険料", 支払利息: "借入金利子", 利子割引料: "借入金利子", その他の経費: "雑費", 固定資産税: "租税公課" };
const lineName = (a: Account) => ALIASES[base(a)] ?? base(a);

const BLUE_FIXED: [string, string][] = [["⑤", "租税公課"], ["⑥", "損害保険料"], ["⑦", "修繕費"], ["⑧", "減価償却費"], ["⑨", "借入金利子"], ["⑩", "地代家賃"], ["⑪", "給料賃金"]];
const BLUE_EXTRA_NOS = ["⑫", "⑬", "⑭", "⑮", "⑯"];
const WHITE_MAIN: [string, string][] = [["⑥", "給料賃金"], ["⑦", "減価償却費"], ["⑧", "貸倒金"], ["⑨", "地代家賃"], ["⑩", "借入金利子"]];
const WHITE_OTHER: [string, string][] = [["㋑", "租税公課"], ["㋺", "損害保険料"], ["㋩", "修繕費"]];

/** 不動産所得の青色申告特別控除の上限（事業所得が無く、事業的規模でない貸付けなら 10万円） */
export const realEstateDeductionLimit = (filingType: FilingType, scale: RealEstateScale, hasBusiness: boolean) =>
  !hasBusiness && scale !== "business" ? Math.min(BLUE_DEDUCTION_LIMIT[filingType], 100_000) : BLUE_DEDUCTION_LIMIT[filingType];

/**
 * amount = 科目の残高（期末）。familyAllowed = 専従者給与を必要経費にできる（事業的規模の青色申告）。deductionLimit = 青色申告特別控除の上限（白色は 0）
 */
export const realEstateStatement = (
  allAccounts: Account[], amount: (a: Account) => number, form: "blue" | "white", opts: { familyAllowed: boolean; deductionLimit: number },
): RealEstateStatement => {
  const warnings: string[] = [];
  const accounts = accountsOfKind(allAccounts, "realestate");
  const signed = (a: Account) => (a.normal_side === "debit" ? amount(a) : -amount(a));
  // 収入
  const revenueAccounts = accounts.filter((a) => a.category === "revenue");
  const rent = revenueAccounts.filter((a) => base(a) === "賃貸料").reduce((s, a) => s + amount(a), 0);
  const keyMoney = revenueAccounts.filter((a) => KEY_MONEY.has(base(a))).reduce((s, a) => s + amount(a), 0);
  const otherRevenue = revenueAccounts.filter((a) => base(a) !== "賃貸料" && !KEY_MONEY.has(base(a)));
  const other = otherRevenue.reduce((s, a) => s + amount(a), 0);
  const withAmount = otherRevenue.filter((a) => amount(a) !== 0);
  const otherLabel = withAmount.length === 1 ? withAmount[0].name.replace(/[（(]不動産[）)]$/, "") : "名義書換料その他";
  const total = rent + keyMoney + other;

  // 経費（売上原価の科目も経費として扱う）。専従者給与等は別
  const expenseAccounts = accounts.filter((a) => a.category === "expense" || a.category === "cogs");
  const specials = accounts.filter((a) => a.category === "special");
  const familySalary = specials.filter((a) => base(a) === "専従者給与").reduce((s, a) => s + signed(a), 0);
  const otherSpecials = specials.filter((a) => base(a) !== "専従者給与" && amount(a) !== 0);
  if (otherSpecials.length) warnings.push(`${otherSpecials.map((a) => a.name).join("・")}は、不動産所得用の決算書に欄が無いため経費に入れています`);
  if (familySalary && !opts.familyAllowed) {
    warnings.push(form === "white"
      ? "白色申告では、家族に払った給与（専従者給与（不動産））は必要経費になりません。経費に入れていません（不動産所得の事業専従者控除は扱いません）"
      : "不動産の貸付けが事業的規模でないので、専従者給与（不動産）は必要経費になりません。経費に入れていません");
  }
  const sumBy = new Map<string, number>();
  for (const a of [...expenseAccounts, ...otherSpecials]) sumBy.set(lineName(a), (sumBy.get(lineName(a)) ?? 0) + signed(a));
  const take = (name: string) => {
    const v = sumBy.get(name) ?? 0;
    sumBy.delete(name);
    return v;
  };
  const fixedNames = form === "blue" ? [...BLUE_FIXED.map(([, l]) => l), "雑費"] : [...WHITE_MAIN, ...WHITE_OTHER].map(([, l]) => l).concat("雑費");
  const fixed = new Map(fixedNames.map((n) => [n, take(n)]));
  // 追加の欄（青色 5・白色 1）：金額の大きい順。あふれたらその他の経費・雑費に
  const extraMax = form === "blue" ? 5 : 1;
  const extras = [...sumBy.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  const shown = extras.slice(0, extraMax);
  const overflow = extras.slice(extraMax);
  const misc = (fixed.get("雑費") ?? 0) + overflow.reduce((s, [, v]) => s + v, 0);
  if (overflow.length) warnings.push(`経費の追加の欄が足りないので、${overflow.map(([n]) => n).join("・")}を${form === "blue" ? "その他の経費" : "雑費"}にまとめます`);

  const familyDeducted = opts.familyAllowed ? familySalary : 0;
  if (form === "blue") {
    const main: ReLine[] = [
      ...BLUE_FIXED.map(([no, label]) => ({ no, label, amount: fixed.get(label) ?? 0, extra: false })),
      ...shown.map(([label, v], i) => ({ no: BLUE_EXTRA_NOS[i], label, amount: v, extra: true })),
    ];
    const expenseTotal = main.reduce((s, r) => s + r.amount, 0) + misc;
    const difference = total - expenseTotal;
    const beforeDeduction = difference - familyDeducted;
    const deduction = Math.min(opts.deductionLimit, Math.max(0, beforeDeduction));
    return {
      form, revenue: { rent, keyMoney, other, otherLabel, total }, main, others: [], otherTotal: misc, expenseTotal, difference, family: familyDeducted,
      beforeDeduction, deduction, income: beforeDeduction - deduction, warnings,
    };
  }
  const main = WHITE_MAIN.map(([no, label]) => ({ no, label, amount: fixed.get(label) ?? 0, extra: false }));
  const others: ReLine[] = [
    ...WHITE_OTHER.map(([no, label]) => ({ no, label, amount: fixed.get(label) ?? 0, extra: false })),
    ...shown.map(([label, v]) => ({ no: "㋥", label, amount: v, extra: true })),
    { no: "㋭", label: "雑費", amount: misc, extra: false },
  ];
  const otherTotal = others.reduce((s, r) => s + r.amount, 0);
  const expenseTotal = main.reduce((s, r) => s + r.amount, 0) + otherTotal;
  const difference = total - expenseTotal;
  return {
    form, revenue: { rent, keyMoney, other, otherLabel, total }, main, others, otherTotal, expenseTotal, difference, family: 0,
    beforeDeduction: difference, deduction: 0, income: difference, warnings,
  };
};

/** 不動産所得の収入の内訳の1行（賃借人ごと。取引先 → 補助科目。どちらも無い分は key = none） */
export interface RentIncomeRow {
  key: string;
  counterpartyId: number | null;
  subId: number | null;
  rent: number;
  keyMoney: number;
  other: number;
}

/** 賃借人ごとの賃貸料・礼金等・名義書換料その他（賃借人の分からない分は最後に「none」の1行） */
export const rentIncomeRows = (allAccounts: Account[], lines: FlatLine[]): RentIncomeRow[] => {
  const revenue = accountsOfKind(allAccounts, "realestate").filter((a) => a.category === "revenue");
  const ids = (pred: (a: Account) => boolean) => revenue.filter(pred).map((a) => a.id);
  const groups = {
    rent: ids((a) => base(a) === "賃貸料"),
    keyMoney: ids((a) => KEY_MONEY.has(base(a))),
    other: ids((a) => base(a) !== "賃貸料" && !KEY_MONEY.has(base(a))),
  };
  const rows = new Map<string, RentIncomeRow>();
  const total = { rent: 0, keyMoney: 0, other: 0 };
  for (const k of ["rent", "keyMoney", "other"] as const) {
    const set = new Set(groups[k]);
    for (const l of lines) if (set.has(l.account_id)) total[k] += l.side === "credit" ? l.amount : -l.amount;
    for (const p of partnerTotals(groups[k], lines, "credit")) {
      const row = rows.get(p.key) ?? { key: p.key, counterpartyId: p.counterpartyId, subId: p.subId, rent: 0, keyMoney: 0, other: 0 };
      row[k] += p.amount;
      rows.set(p.key, row);
    }
  }
  const list = [...rows.values()].sort((a, b) => b.rent + b.keyMoney + b.other - (a.rent + a.keyMoney + a.other));
  const rest = {
    rent: total.rent - list.reduce((s, r) => s + r.rent, 0), keyMoney: total.keyMoney - list.reduce((s, r) => s + r.keyMoney, 0),
    other: total.other - list.reduce((s, r) => s + r.other, 0),
  };
  if (rest.rent || rest.keyMoney || rest.other) list.push({ key: "none", counterpartyId: null, subId: null, ...rest });
  return list;
};

/** 不動産所得の収入の内訳の行（書き込みを合わせたもの。e-Tax のデータに使う） */
export interface RentIncomeLine extends RentIncomeRow {
  name: string;
  kind: string;
  use: string;
  location: string;
  address: string;
  /** 契約期間（YYYY-MM。読めなければ空） */
  from: string;
  to: string;
  area: string;
  monthly: number;
  deposit: number;
}

/** 不動産所得用の決算書の全部（1ページの数字と、内訳の行） */
export interface RealEstateBook {
  st: RealEstateStatement;
  /** 事業所得がある（貸借対照表は一般用の決算書に書く） */
  hasBusiness: boolean;
  income: RentIncomeLine[];
  salaries: PayLine[];
  family: PayLine[];
  depreciation: DepreciationLine[];
  rent: PayeeLine[];
  interest: PayeeLine[];
  /** 修繕費の内訳（収支内訳書）：extra は使わない。work = 工事名、date = 支払年月日 */
  repair: (PayeeLine & { work: string; date: string })[];
  /** 貸付不動産の保有状況（収支内訳書） */
  holding: Record<string, number | null>;
  special: string;
  landInterest: number;
  /** 貸借対照表（帳簿全体。事業所得が無いときに不動産所得用の決算書に書く）。liabilities は負債と資本 */
  balance: { assets: BalanceRow[]; liabilities: BalanceRow[]; income: number };
}

export interface BalanceRow {
  name: string;
  opening: number;
  closing: number;
}

export interface RealEstateBookSource extends Omit<BlueStatementSource, "deductionLimit" | "invoiceNoOf"> {
  white: boolean;
  scale: RealEstateScale;
  filingType: FilingType;
}

const noteNum = (v: string | undefined) => Number((v ?? "").normalize("NFKC").replace(/[,\s円㎡]/g, "")) || 0;
const noteYm = (v: string | undefined) => {
  const m = (v ?? "").normalize("NFKC").match(/^(\d{4})[-/年.](\d{1,2})/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2].padStart(2, "0")}` : "";
};

export const buildRealEstateBook = (s: RealEstateBookSource): RealEstateBook => {
  const { notes } = s;
  const end = closingBalances(s.accounts, s.opening, s.lines);
  const amount = (a: Account) => end.get(a.id) ?? 0;
  const biz = summarizeIncome(accountsOfKind(s.accounts, "business"), end);
  const hasBusiness = biz.revenue !== 0 || biz.income !== 0;
  const st = realEstateStatement(s.accounts, amount, s.white ? "white" : "blue", {
    familyAllowed: !s.white && s.scale === "business", deductionLimit: s.white ? 0 : realEstateDeductionLimit(s.filingType, s.scale, hasBusiness),
  });
  const idOf = (code: string) => s.accounts.find((a) => a.code === code)?.id ?? 0;
  const drawId = idOf(CODE.OWNER_DRAW);
  const breakdown = (code: string) => {
    const id = idOf(code);
    if (!id) return [];
    const rate = s.homeUseRates.find((r) => r.account_id === id && r.method === "yearend");
    return payeeBreakdown(id, s.lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: s.excludeEntryIds });
  };
  const n = (k: string) => notes[k] ?? "";
  const bsRows = (cats: Account["category"][]): BalanceRow[] =>
    s.accounts.filter((a) => cats.includes(a.category)).map((a) => ({ name: a.name, opening: s.opening[a.id] ?? 0, closing: amount(a) })).filter((r) => r.opening || r.closing);
  const income = rentIncomeRows(s.accounts, s.lines).map((r): RentIncomeLine => {
    const k = (f: string) => n(`re-income:${r.key}:${f}`);
    return {
      ...r, name: r.key === "none" ? "" : s.payeeName(r), kind: k("kind"), use: k("use"), location: k("location"), address: k("address"),
      from: noteYm(k("from")), to: noteYm(k("to")), area: k("area").normalize("NFKC").replace(/[,\s㎡]/g, ""), monthly: noteNum(k("monthly")), deposit: noteNum(k("deposit")),
    };
  });
  const holding = Object.fromEntries(
    Object.entries(notes).filter(([k]) => k.startsWith("re-holding:")).map(([k, v]) => [k.slice("re-holding:".length), noteNum(v) || null]),
  );
  return {
    st, hasBusiness, income,
    salaries: payLinesOf(breakdown(CODE.RE_SALARIES), "re-salary", notes, s.payeeName),
    family: payLinesOf(breakdown(CODE.RE_FAMILY_SALARY), "re-family", notes, s.payeeName),
    depreciation: depreciationLinesOf(s.assets.filter((a) => a.income_kind === "realestate"), s.year, notes),
    rent: payeeLinesOf(breakdown(CODE.RE_RENT), "re-rent", "key", notes, s.payeeName),
    // 借入金利子の内訳は「書く」のチェックを外したものを除く（金融機関の分も書く）
    interest: payeeLinesOf(breakdown(CODE.RE_INTEREST).filter((r) => (notes[`re-interest:${r.key}:use`] || "1") === "1"), "re-interest", "loan", notes, s.payeeName),
    repair: breakdown(CODE.RE_REPAIR).map((r) => ({
      ...payeeLinesOf([r], "re-repair", "", notes, s.payeeName)[0], work: n(`re-repair:${r.key}:work`), date: n(`re-repair:${r.key}:date`),
    })),
    holding, special: n("re:special"), landInterest: noteNum(notes["re:landInterest"]),
    balance: {
      assets: bsRows(["asset"]), liabilities: bsRows(["liability", "equity"]), income: summarizeIncome(s.accounts, end).income,
    },
  };
};
