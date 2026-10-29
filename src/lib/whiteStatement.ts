/**
 * 収支内訳書（一般用）の数字（白色申告。純粋関数。決算書の画面と e-Tax のデータ（incomeTaxXtx.ts）に使う）
 *  - 1ページ：収入金額（①売上（収入）金額・②家事消費・③その他の収入）、売上原価、経費（追加の欄は 5 つ）、
 *    ⑲専従者控除前の所得金額・⑳専従者控除・㉑所得金額、給料賃金の内訳、税理士・弁護士等の報酬・料金の内訳、事業専従者の氏名等
 *  - 2ページ：売上（収入）金額・仕入金額の明細、減価償却費の計算、地代家賃・利子割引料の内訳、特殊事情
 * 明細は青色申告決算書と同じ作り（blueStatement.ts）。違いは計の範囲（売上先の明細の計は①だけ。青色は家事消費等・雑収入を含む）
 *
 * 白色申告では、家族に払った給与は必要経費にならない（所得税法56条・57条③）。専従者給与の科目に記帳していても経費に入れず、
 * 代わりに事業専従者控除を差し引く。事業専従者は、所得税の入力の配偶者・親族のうち「専従者」に印を付けた人
 * 事業専従者控除（所得税法57条③、令和7年分 収支内訳書（一般用）の書き方）：事業専従者1人につき、次の少ない方
 *  ⑴ 86万円（配偶者以外の親族は 50万円） ⑵ ⑲ ÷（事業専従者の数＋1）
 * 事業専従者の要件：生計を一にする配偶者・親族で、その年12月31日に15歳以上、その年に6か月を超えて事業に専ら従事
 * （年の中途の開業・廃業で事業の期間が1年に満たないときは、その期間の2分の1を超えて。所得税法施行令165条①）
 */
import { closingBalances, summarizeIncome, type IncomeSummary } from "./accounting";
import { buildBlueStatement, partnerTable, type BlueStatement, type BlueStatementSource, type PartnerTable } from "./blueStatement";
import { statementLayout, type StatementRow } from "./statementLines";
import { ageAt, type IncomeTaxInput } from "./incomeTax";
import type { Account } from "./types";
import { CODE } from "../constants/accounts";

// ────────────────────────────────────────────
// 事業専従者控除
// ────────────────────────────────────────────

export const FAMILY_DEDUCTION_LIMIT = { spouse: 860_000, other: 500_000 } as const;
/** 収支内訳書の「事業専従者の氏名等」の行数（多ければ次葉合計） */
export const WHITE_FAMILY_ROWS = 3;

export interface FamilyMember {
  /** spouse ／ dep<添字>（所得税の入力の配偶者・扶養親族の欄） */
  from: string;
  name: string;
  relation: string;
  birthday: string;
  spouse: boolean;
  months: number | null;
  work: string;
}

export interface FamilyLine extends FamilyMember {
  /** その年12月31日の年齢（生年月日が無ければ null） */
  age: number | null;
  /** ⑴ 86万円・50万円 */
  limit: number;
  /** 控除額（対象にならなければ 0） */
  deduction: number;
  /** 対象にならない理由（空なら対象） */
  problem: string;
}

/** 所得税の入力の配偶者・親族のうち、事業専従者の印を付けた人 */
export const familyMembers = (x: Pick<IncomeTaxInput, "spouse" | "dependents">): FamilyMember[] => [
  ...(x.spouse?.familyEmployee ? [{ from: "spouse", ...pick(x.spouse), relation: x.spouse.relation || "配偶者", spouse: true }] : []),
  ...x.dependents.flatMap((d, i) => (d.familyEmployee ? [{ from: `dep${i}`, ...pick(d), spouse: false }] : [])),
];
const pick = (r: NonNullable<IncomeTaxInput["spouse"]>) => ({ name: r.name, relation: r.relation, birthday: r.birthday, months: r.months, work: r.work });

/** 事業の期間の月数（その年の中途に開業・廃業したときは、その月を含めた月数） */
export const businessMonths = (b: IncomeTaxInput["businessTax"], year: number) => {
  if (!b.change || !/^\d{4}-\d{2}-\d{2}$/.test(b.changeDate) || Number(b.changeDate.slice(0, 4)) !== year) return 12;
  const m = Number(b.changeDate.slice(5, 7));
  return b.change === "open" ? 13 - m : m;
};

/**
 * 事業専従者ごとの控除額。beforeDeduction = ⑲専従者控除前の所得金額、periodMonths = 事業の期間の月数
 * 要件を満たさない人は数に入れず、理由を返す（⑵の「事業専従者の数」も、対象になる人だけで数える）
 */
export const familyDeductions = (beforeDeduction: number, members: FamilyMember[], year: number, periodMonths = 12): FamilyLine[] => {
  const lines = members.map((m): FamilyLine => {
    const age = ageAt(m.birthday, year);
    const limit = m.spouse ? FAMILY_DEDUCTION_LIMIT.spouse : FAMILY_DEDUCTION_LIMIT.other;
    const problem =
      !m.name.trim() ? "氏名を入れてください"
      : age === null ? "生年月日を入れてください（12月31日に15歳以上か確かめます）"
      : age < 15 ? `12月31日に15歳未満（${age}歳）のため、事業専従者になりません`
      : m.months === null ? "従事月数を入れてください"
      : m.months * 2 <= periodMonths ? `従事月数が${periodMonths === 12 ? "6か月" : `事業の期間（${periodMonths}か月）の2分の1`}以下のため、事業専従者になりません`
      : "";
    return { ...m, age, limit, deduction: 0, problem };
  });
  const ok = lines.filter((l) => !l.problem);
  const share = Math.floor(Math.max(0, beforeDeduction) / (ok.length + 1));
  for (const l of ok) l.deduction = Math.min(l.limit, share);
  return lines;
};

// ────────────────────────────────────────────
// 収支内訳書の1ページの数字（帳簿の残高から）
// ────────────────────────────────────────────

export interface WhiteSummary {
  /** ①売上（収入）金額・②家事消費・③その他の収入・④計 */
  revenue: { sales: number; household: number; other: number; total: number };
  /** ⑤期首商品（製品）棚卸高・⑥仕入金額（製品製造原価）・⑦小計・⑧期末商品（製品）棚卸高・⑨差引原価 */
  cogs: { opening: number; purchases: number; subtotal: number; closing: number; cost: number };
  /** ⑩差引金額 */
  difference: number;
  /** 経費の欄（決まった欄 → 追加の欄。追加の欄は 5 つまで、残りは雑費） */
  expenses: StatementRow[];
  /** 様式の並びの経費：⑪〜⑯ と、その他の経費（㋑〜㋸・追加の欄 ㋾㋻㋕㋵㋟・㋹雑費） */
  mainExpenses: WhiteExpenseLine[];
  otherExpenses: WhiteExpenseLine[];
  /** ⑰その他の経費の小計 */
  otherSubtotal: number;
  /** ⑱経費計 */
  expenseTotal: number;
  /** ⑲専従者控除前の所得金額 */
  beforeDeduction: number;
  /** 専従者給与の科目に記帳した額（経費に入れない） */
  familySalaryBooked: number;
  warnings: string[];
}

/** 収支内訳書の経費の追加の欄の数（令和7年分の様式） */
export const WHITE_EXPENSE_EXTRA = 5;

/** 収支内訳書の経費の欄の並びと記号（令和7年分の様式） */
const WHITE_EXPENSE_MAIN: [string, string][] = [["⑪", "給料賃金"], ["⑫", "外注工賃"], ["⑬", "減価償却費"], ["⑭", "貸倒金"], ["⑮", "地代家賃"], ["⑯", "利子割引料"]];
const WHITE_EXPENSE_OTHER: [string, string][] = [
  ["㋑", "租税公課"], ["㋺", "荷造運賃"], ["㋩", "水道光熱費"], ["㋥", "旅費交通費"], ["㋭", "通信費"], ["㋬", "広告宣伝費"],
  ["㋣", "接待交際費"], ["㋠", "損害保険料"], ["㋷", "修繕費"], ["㋦", "消耗品費"], ["㋸", "福利厚生費"],
];
const WHITE_EXTRA_MARKS = ["㋾", "㋻", "㋕", "㋵", "㋟"];

export interface WhiteExpenseLine {
  no: string;
  label: string;
  amount: number;
  /** 追加の欄（科目名で書く） */
  extra: boolean;
}

export const whiteSummary = (accounts: Account[], amount: (a: Account) => number): WhiteSummary => {
  const warnings: string[] = [];
  const family = accounts.find((a) => a.code === CODE.FAMILY_SALARY);
  const familySalaryBooked = family ? amount(family) : 0;
  if (familySalaryBooked) {
    warnings.push(`白色申告では、家族に払った給与（専従者給与 ${familySalaryBooked.toLocaleString()}円）は必要経費になりません。経費に入れず、代わりに事業専従者控除を差し引いています。家族への支払いは事業主貸で記帳してください`);
  }
  // 専従者給与のほかの「専従者給与等」の科目（引当金の繰入額など）は、収支内訳書に欄が無いので経費の追加の欄に書く
  const others = accounts.filter((a) => a.category === "special" && a.code !== CODE.FAMILY_SALARY && amount(a) !== 0);
  if (others.length) {
    warnings.push(`${others.map((a) => a.name).join("・")}は、収支内訳書に欄が無いため経費の空欄に書いています（白色申告で使える貸倒引当金は個別評価だけです）`);
  }
  const asExpense = accounts
    .filter((a) => a.code !== CODE.FAMILY_SALARY)
    .map((a): Account => (a.category === "special" ? { ...a, category: "expense", statement_line: null } : a));
  // 繰戻額等（貸方の科目。貸倒引当金戻入など）は、経費から差し引く（マイナスの経費）
  const credit = new Set(accounts.filter((a) => a.category === "special" && a.normal_side === "credit").map((a) => a.id));
  const layout = statementLayout(asExpense, (a) => (credit.has(a.id) ? -amount(a) : amount(a)), () => 0, { expense: WHITE_EXPENSE_EXTRA });
  warnings.push(...layout.warnings.filter((w) => w.startsWith("経費")));

  const sumCat = (pred: (a: Account) => boolean) => accounts.filter(pred).reduce((s, a) => s + amount(a), 0);
  const household = sumCat((a) => a.code === CODE.HOUSEHOLD_USE);
  const other = sumCat((a) => a.code === CODE.MISC_INCOME);
  const sales = sumCat((a) => a.category === "revenue") - household - other;
  const total = sales + household + other;
  const cogsRow = (label: string) => layout.sections.cogs.find((r) => r.label === label)?.amount ?? 0;
  const opening = cogsRow("期首商品（製品）棚卸高");
  const purchases = cogsRow("仕入金額（製品製造原価）");
  const closing = cogsRow("期末商品（製品）棚卸高");
  const cost = opening + purchases - closing;
  const expenses = layout.sections.expense;
  const fixed = (label: string) => expenses.find((r) => !r.extra && r.label === label)?.amount ?? 0;
  const mainExpenses = WHITE_EXPENSE_MAIN.map(([no, label]) => ({ no, label, amount: fixed(label), extra: false }));
  const otherExpenses = [
    ...WHITE_EXPENSE_OTHER.map(([no, label]) => ({ no, label, amount: fixed(label), extra: false })),
    ...expenses.filter((r) => r.extra).map((r, i) => ({ no: WHITE_EXTRA_MARKS[i] ?? "", label: r.label, amount: r.amount, extra: true })),
    { no: "㋹", label: "雑費", amount: fixed("雑費"), extra: false },
  ];
  const otherSubtotal = otherExpenses.reduce((s, r) => s + r.amount, 0);
  const expenseTotal = mainExpenses.reduce((s, r) => s + r.amount, 0) + otherSubtotal;
  const difference = total - cost;
  return {
    revenue: { sales, household, other, total },
    cogs: { opening, purchases, subtotal: opening + purchases, closing, cost },
    difference, expenses, mainExpenses, otherExpenses, otherSubtotal, expenseTotal, beforeDeduction: difference - expenseTotal, familySalaryBooked, warnings,
  };
};

// ────────────────────────────────────────────
// 収支内訳書（1・2ページ）
// ────────────────────────────────────────────

export interface WhiteStatementSource extends Omit<BlueStatementSource, "deductionLimit"> {
  /** 事業専従者（familyMembers） */
  family: FamilyMember[];
  /** 事業の期間の月数（businessMonths） */
  periodMonths: number;
}

export interface WhiteStatement extends WhiteSummary {
  /** 帳簿どおりの損益（参考。専従者給与を経費にした額） */
  pl: IncomeSummary;
  family: FamilyLine[];
  /** ⑳専従者控除 */
  familyDeduction: number;
  /** ㉑所得金額 */
  income: number;
  /** 売上（収入）金額の明細（計は①）・仕入金額の明細（計は⑥） */
  sales: PartnerTable;
  purchases: PartnerTable;
  /** 給料賃金・報酬・減価償却・地代家賃・利子割引料の明細と特殊事情（青色申告決算書と同じもの） */
  detail: Pick<BlueStatement, "salaries" | "fees" | "rent" | "interest" | "depreciation" | "special">;
}

export const buildWhiteStatement = (s: WhiteStatementSource): WhiteStatement => {
  const end = closingBalances(s.accounts, s.opening, s.lines);
  const amount = (a: Account) => end.get(a.id) ?? 0;
  const sum = whiteSummary(s.accounts, amount);
  const blue = buildBlueStatement({ ...s, deductionLimit: 0 });
  const family = familyDeductions(sum.beforeDeduction, s.family, s.year, s.periodMonths);
  const familyDeduction = family.reduce((t, l) => t + l.deduction, 0);
  return {
    ...sum,
    pl: summarizeIncome(s.accounts, end),
    family,
    familyDeduction,
    income: sum.beforeDeduction - familyDeduction,
    sales: partnerTable(blue.salesPartners, sum.revenue.sales),
    purchases: partnerTable(blue.purchasePartners, sum.cogs.purchases),
    detail: { salaries: blue.salaries, fees: blue.fees, rent: blue.rent, interest: blue.interest, depreciation: blue.depreciation, special: blue.special },
  };
};
