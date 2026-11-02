/**
 * 仕訳のまとめての置き換え（純粋関数。仕訳日記帳で選んだ仕訳に使う。保存は repo.replaceEntries）
 *  - 科目（と補助科目）：置き換える前の科目の明細だけを、後の科目にする。科目が変わる明細の税区分は、
 *    新しい科目の初期値に入れ直す（振替伝票で科目を選び直したときと同じ。補助科目だけ変えるときはそのまま）
 *  - 税区分：その科目の明細の税区分を変える（科目の置き換えのあとの科目で見る）
 *  - 取引先：仕訳の取引先を変える（前を決めれば、その取引先の仕訳だけ）
 *  - 部門：明細の部門を変える（前を決めれば、その部門の明細だけ。共通だけ、も選べる）
 * 決算整理の画面・固定資産台帳で作った仕訳は、repo のほうで外す（それぞれの画面で作り直す仕訳のため）
 */
import type { InvoiceKind, JournalLine, PurchaseUse, TaxCode } from "./types";

export interface ReplaceSpec {
  /** 科目。from.subId：undefined = どの補助科目も（補助なしも）、null = 補助なしだけ */
  account?: { from: { accountId: number; subId?: number | null }; to: { accountId: number; subId: number | null } };
  /** 税区分（この科目の明細） */
  tax?: { accountId: number; code: TaxCode; invoice: InvoiceKind | null; cls: number | null; use: PurchaseUse | null };
  /** 取引先。from：undefined = どの仕訳も、null = 取引先の無い仕訳だけ。to：null = 外す */
  counterparty?: { from?: number | null; to: number | null };
  /** 部門。from：undefined = どの明細も、null = 共通（部門なし）の明細だけ。to：null = 共通にする */
  department?: { from?: number | null; to: number | null };
}

/** 置き換えの指定の問題（無ければ null） */
export const replaceSpecProblem = (s: ReplaceSpec): string | null => {
  if (!s.account && !s.tax && !s.counterparty && !s.department) return "置き換えるもの（科目・税区分・取引先・部門）を選んでください";
  if (s.account) {
    const { from, to } = s.account;
    if (from.accountId === to.accountId && from.subId !== undefined && (from.subId ?? null) === to.subId) return "科目の置き換える前と後が同じです";
  }
  if (s.counterparty && s.counterparty.from !== undefined && s.counterparty.from === s.counterparty.to) return "取引先の置き換える前と後が同じです";
  if (s.department && s.department.from !== undefined && s.department.from === s.department.to) return "部門の置き換える前と後が同じです";
  return null;
};

const NO_TAX = { tax_code: null, invoice_kind: null, business_class: null, purchase_use: null, tax_amount: null } as const;
const key = (l: JournalLine) => [l.row_no, l.side, l.account_id, l.sub_account_id ?? 0, l.tax_code ?? "", l.invoice_kind ?? "", l.business_class ?? "", l.purchase_use ?? "", l.department_id ?? 0].join("|");

/** 1つの仕訳に置き換えを当てる。changed：何か変わったか */
export const replaceInEntry = <L extends JournalLine>(lines: L[], counterpartyId: number | null, s: ReplaceSpec): { lines: L[]; counterpartyId: number | null; changed: boolean } => {
  const out = lines.map((l) => {
    let x: L = { ...l };
    const a = s.account;
    if (a && x.account_id === a.from.accountId && (a.from.subId === undefined || (x.sub_account_id ?? null) === a.from.subId)) {
      const moved = a.to.accountId !== x.account_id;
      x = { ...x, account_id: a.to.accountId, sub_account_id: a.to.subId, ...(moved ? NO_TAX : {}) };
    }
    if (s.tax && x.account_id === s.tax.accountId) {
      x = { ...x, tax_code: s.tax.code, invoice_kind: s.tax.invoice, business_class: s.tax.cls, purchase_use: s.tax.use, tax_amount: null };
    }
    const d = s.department;
    if (d && (d.from === undefined || (x.department_id ?? null) === d.from)) x = { ...x, department_id: d.to };
    return x;
  });
  const c = s.counterparty;
  const cp = c && (c.from === undefined || c.from === counterpartyId) ? c.to : counterpartyId;
  const changed = cp !== counterpartyId || out.some((l, i) => key(l) !== key(lines[i]));
  return { lines: out, counterpartyId: cp, changed };
};

/** 置き換えのあと、同じ行の借方と貸方が同じ科目・補助科目になっていないか（なっていれば行番号） */
export const sameSlotRow = (lines: JournalLine[]): number | null => {
  for (const d of lines.filter((l) => l.side === "debit")) {
    if (lines.some((c) => c.side === "credit" && c.row_no === d.row_no && c.account_id === d.account_id && (c.sub_account_id ?? null) === (d.sub_account_id ?? null))) return d.row_no;
  }
  return null;
};
