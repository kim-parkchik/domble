/**
 * 青色申告決算書（一般用）の様式の行（純粋関数）：1ページの損益計算書（①〜㊺）、4ページの貸借対照表と製造原価の計算（①〜㉖）
 * 欄と金額は statementLayout（勘定科目の「決算書の欄」）から。番号は令和7年分の様式と「決算書の書き方」による
 *  - 損益計算書：経費 ⑧〜㉛（追加の欄 ㉕〜㉚）、繰戻額等 ㉞〜㊱、繰入額等 ㊳〜㊶（専従者給与 ㊳）、青色申告特別控除前の所得金額 ㊸
 *  - 製造原価の計算：その他の製造経費 ⑦〜⑳（追加の欄 ⑫〜⑲）、期首半製品・仕掛品棚卸高 ㉓、期末 ㉕、製品製造原価 ㉖（1ページの ③ へ）
 *  - 追加の欄は、使っていない欄も番号だけの空欄として並べる（様式と同じ番号にするため）
 */
import { STATEMENT_SECTIONS, type StatementLayout, type StatementRow, type StatementSection } from "./statementLines";

/** 丸つき数字（1〜50） */
export const circled = (n: number) =>
  String.fromCodePoint(n <= 20 ? 0x2460 + n - 1 : n <= 35 ? 0x3251 + n - 21 : 0x32b1 + n - 36);

export interface FormRow {
  /** 欄の番号（丸つき数字。無ければ空） */
  no: string;
  label: string;
  /** 金額（null = 空欄） */
  amount: number | null;
  /** head 見出し ／ line 欄 ／ total 計・差引など */
  kind: "head" | "line" | "total";
  /** その欄に入れた科目（画面で添える） */
  accountIds?: number[];
  /** 追加の欄（科目名で書く） */
  extra?: boolean;
}

const sum = (rows: StatementRow[]) => rows.reduce((s, r) => s + r.amount, 0);
const fixedRow = (layout: StatementLayout, section: StatementSection, label: string) =>
  layout.sections[section].find((r) => !r.extra && r.label === label) ?? { label, extra: false, opening: 0, amount: 0, accountIds: [] };
const line = (no: number, r: StatementRow, label = r.label): FormRow => ({ no: circled(no), label, amount: r.amount, kind: "line", accountIds: r.accountIds, extra: r.extra });
const total = (no: number | null, label: string, amount: number): FormRow => ({ no: no ? circled(no) : "", label, amount, kind: "total" });
const head = (label: string): FormRow => ({ no: "", label, amount: null, kind: "head" });
/** 追加の欄を、様式の数（count）まで空欄で埋めて番号を振る */
const extraRows = (rows: StatementRow[], from: number, count: number): FormRow[] =>
  Array.from({ length: Math.max(count, rows.length) }, (_, i) =>
    rows[i] ? line(from + i, rows[i]) : { no: circled(from + i), label: "", amount: null, kind: "line", extra: true });

export interface IncomeStatementForm {
  /** 左（①〜㉜）と右（㉝〜㊺） */
  left: FormRow[];
  right: FormRow[];
  /** ㊸ 青色申告特別控除前の所得金額 */
  beforeDeduction: number;
}

/**
 * 1ページの損益計算書。revenue = ① 売上（収入）金額（雑収入を含む）、deduction = ㊹ 青色申告特別控除額
 */
export const incomeStatementForm = (layout: StatementLayout, revenue: number, deduction: number): IncomeStatementForm => {
  const cogs = (label: string) => fixedRow(layout, "cogs", label);
  const opening = cogs("期首商品（製品）棚卸高");
  const purchases = cogs("仕入金額（製品製造原価）");
  const closing = cogs("期末商品（製品）棚卸高");
  const subtotal = opening.amount + purchases.amount;
  const cost = subtotal - closing.amount;
  const gross = revenue - cost;

  const expense = layout.sections.expense;
  const expFixed = STATEMENT_SECTIONS.expense.fixed.filter((l) => l !== "雑費");
  const expenseTotal = sum(expense);
  const beforeSpecial = gross - expenseTotal;

  const reversal = layout.sections.reversal;
  const addition = layout.sections.addition;
  const reversalTotal = sum(reversal);
  const additionTotal = sum(addition);
  const beforeDeduction = beforeSpecial + reversalTotal - additionTotal;

  const left: FormRow[] = [
    { no: circled(1), label: "売上（収入）金額（雑収入を含む）", amount: revenue, kind: "total" },
    head("売上原価"),
    line(2, opening), line(3, purchases),
    total(4, "小計（②＋③）", subtotal),
    line(5, closing),
    total(6, "差引原価（④－⑤）", cost),
    total(7, "差引金額（①－⑥）", gross),
    head("経費"),
    ...expFixed.map((l, i) => line(8 + i, fixedRow(layout, "expense", l))),
    ...extraRows(expense.filter((r) => r.extra), 25, STATEMENT_SECTIONS.expense.extra),
    line(31, fixedRow(layout, "expense", "雑費")),
    total(32, "計", expenseTotal),
  ];
  const right: FormRow[] = [
    total(33, "差引金額（⑦－㉜）", beforeSpecial),
    head("各種引当金・準備金等　繰戻額等"),
    line(34, fixedRow(layout, "reversal", "貸倒引当金")),
    ...extraRows(reversal.filter((r) => r.extra), 35, STATEMENT_SECTIONS.reversal.extra),
    total(37, "計", reversalTotal),
    head("各種引当金・準備金等　繰入額等"),
    line(38, fixedRow(layout, "addition", "専従者給与")),
    line(39, fixedRow(layout, "addition", "貸倒引当金")),
    ...extraRows(addition.filter((r) => r.extra), 40, STATEMENT_SECTIONS.addition.extra),
    total(42, "計", additionTotal),
    total(43, "青色申告特別控除前の所得金額（㉝＋㊲－㊷）", beforeDeduction),
    { no: circled(44), label: "青色申告特別控除額", amount: deduction, kind: "line" },
    total(45, "所得金額（㊸－㊹）", beforeDeduction - deduction),
  ];
  return { left, right, beforeDeduction };
};

export interface ManufacturingForm {
  rows: FormRow[];
  /** ㉖ 製品製造原価 */
  cost: number;
}

/** 4ページの製造原価の計算（①〜㉖） */
export const manufacturingForm = (layout: StatementLayout): ManufacturingForm => {
  const r = (label: string) => fixedRow(layout, "mfg", label);
  const mfg = layout.sections.mfg;
  const material = r("期首原材料棚卸高").amount + r("原材料仕入高").amount;
  const materialCost = material - r("期末原材料棚卸高").amount;
  const otherLabels = ["外注工賃", "電力費", "水道光熱費", "修繕費", "減価償却費"];
  const others = [...otherLabels.map((l) => r(l)), ...mfg.filter((x) => x.extra), r("雑費")];
  const otherTotal = sum(others);
  const total22 = materialCost + r("労務費").amount + otherTotal;
  const total24 = total22 + r("期首半製品・仕掛品棚卸高").amount;
  const cost = total24 - r("期末半製品・仕掛品棚卸高").amount;
  const rows: FormRow[] = [
    head("原材料費"),
    line(1, r("期首原材料棚卸高")), line(2, r("原材料仕入高")),
    total(3, "小計（①＋②）", material),
    line(4, r("期末原材料棚卸高")),
    total(5, "差引原材料費（③－④）", materialCost),
    line(6, r("労務費")),
    head("その他の製造経費"),
    ...otherLabels.map((l, i) => line(7 + i, r(l))),
    ...extraRows(mfg.filter((x) => x.extra), 12, STATEMENT_SECTIONS.mfg.extra),
    line(20, r("雑費")),
    total(21, "計", otherTotal),
    total(22, "総製造費（⑤＋⑥＋㉑）", total22),
    line(23, r("期首半製品・仕掛品棚卸高")),
    total(24, "小計（㉒＋㉓）", total24),
    line(25, r("期末半製品・仕掛品棚卸高")),
    total(26, "製品製造原価（㉔－㉕）", cost),
  ];
  return { rows, cost };
};

export interface BalanceRow {
  label: string;
  /** 期首・期末（null = 空欄） */
  opening: number | null;
  closing: number | null;
  kind: "line" | "total";
  accountIds?: number[];
  extra?: boolean;
}

export interface BalanceSheetForm {
  assets: BalanceRow[];
  liabilities: BalanceRow[];
}

/**
 * 4ページの貸借対照表（資産負債調）。追加の欄は資産は「土地」のあと、負債は「預り金」のあと（様式の空欄の位置）。
 * 事業主貸・事業主借・青色申告特別控除前の所得金額は期末だけ（期首に残高があれば出す）
 */
export const balanceSheetForm = (layout: StatementLayout, income: number): BalanceSheetForm => {
  const bsLine = (r: StatementRow, closingOnly = false): BalanceRow =>
    ({ label: r.label, opening: closingOnly && r.opening === 0 ? null : r.opening, closing: r.amount, kind: "line", accountIds: r.accountIds, extra: r.extra });
  const asset = layout.sections.asset;
  const liab = layout.sections.liability;
  const af = (l: string) => fixedRow(layout, "asset", l);
  const lf = (l: string) => fixedRow(layout, "liability", l);
  const assets: BalanceRow[] = [
    ...STATEMENT_SECTIONS.asset.fixed.filter((l) => l !== "事業主貸").map((l) => bsLine(af(l))),
    ...asset.filter((r) => r.extra).map((r) => bsLine(r)),
    bsLine(af("事業主貸"), true),
  ];
  assets.push({ label: "合計", opening: sum(asset.map((r) => ({ ...r, amount: r.opening }))), closing: sum(asset), kind: "total" });
  const before = ["支払手形", "買掛金", "借入金", "未払金", "前受金", "預り金"];
  const liabilities: BalanceRow[] = [
    ...before.map((l) => bsLine(lf(l))),
    ...liab.filter((r) => r.extra).map((r) => bsLine(r)),
    bsLine(lf("貸倒引当金")),
    bsLine(lf("事業主借"), true),
    bsLine(lf("元入金")),
    { label: "青色申告特別控除前の所得金額", opening: null, closing: income, kind: "line" },
  ];
  liabilities.push({ label: "合計", opening: sum(liab.map((r) => ({ ...r, amount: r.opening }))), closing: sum(liab) + income, kind: "total" });
  return { assets, liabilities };
};
