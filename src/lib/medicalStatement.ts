/**
 * 医療費控除の明細書・セルフメディケーション税制の明細書（純粋関数）。所得税の入力の明細から作る
 *  - 医療費控除：1 医療費通知に関する事項（(1) 記載された医療費の額 (2) うち支払った額 (3) 補填される金額）、
 *    2 医療費の明細（医療を受けた人・支払先ごと。同じ人・同じ支払先はまとめる）、3 控除額の計算（A〜控除額）
 *  - セルフメディケーション税制：1 健康の保持増進の取組、2 特定一般用医薬品等購入費の明細（支払先・医薬品ごと）、3 控除額の計算
 *  - e-Tax の明細書（KOB560・KOB570）は1枚に書ける行に上限がある（医療費 16行・医薬品 18行。次葉には対応しない）
 */
import type { IncomeTaxInput, MedicalKind } from "./incomeTax";

/** e-Tax の明細書の1枚に書ける行の数 */
export const MEDICAL_ROWS = 16;
export const SELF_MED_ROWS = 18;

export interface MedicalStatementRow {
  person: string;
  payee: string;
  kinds: MedicalKind[];
  paid: number;
  reimbursed: number;
}

export interface MedicalStatement {
  notice: { amount: number; paid: number; reimbursed: number };
  rows: MedicalStatementRow[];
  /** A 支払った医療費 ／ B 補填される金額 ／ C 差引金額 ／ D 所得金額の合計額 ／ E D × 5% ／ F E と10万円の少ない方 ／ 医療費控除額 */
  a: number; b: number; c: number; d: number; e: number; f: number; deduction: number;
}

/** 同じ人・同じ支払先の行をまとめる（区分は合わせる）。入れた順 */
export const mergeMedicalRows = (rows: NonNullable<IncomeTaxInput["medical"]["rows"]>): MedicalStatementRow[] => {
  const out: MedicalStatementRow[] = [];
  for (const r of rows) {
    if (!r.paid && !r.reimbursed) continue;
    const same = out.find((x) => x.person === r.person && x.payee === r.payee);
    if (same) {
      same.paid += r.paid;
      same.reimbursed += r.reimbursed;
      if (!same.kinds.includes(r.kind)) same.kinds.push(r.kind);
    } else out.push({ person: r.person, payee: r.payee, kinds: [r.kind], paid: r.paid, reimbursed: r.reimbursed });
  }
  return out;
};

/** 医療費控除の明細書。totalIncome = 総所得金額等（繰越控除の後） */
export const medicalStatement = (m: IncomeTaxInput["medical"], totalIncome: number): MedicalStatement => {
  const notice = m.notice ?? { amount: 0, paid: 0, reimbursed: 0 };
  const rows = mergeMedicalRows(m.rows ?? []);
  const a = notice.paid + rows.reduce((s, r) => s + r.paid, 0);
  const b = notice.reimbursed + rows.reduce((s, r) => s + r.reimbursed, 0);
  const c = Math.max(a - b, 0);
  const d = totalIncome;
  const e = Math.floor((Math.max(d, 0) * 5) / 100);
  const f = Math.min(e, 100_000);
  return { notice, rows, a, b, c, d, e, f, deduction: Math.min(Math.max(c - f, 0), 2_000_000) };
};

export interface SelfMedStatementRow {
  payee: string;
  medicine: string;
  paid: number;
  reimbursed: number;
}

export interface SelfMedStatement {
  effort: NonNullable<IncomeTaxInput["medical"]["effort"]>;
  rows: SelfMedStatementRow[];
  /** A 支払った金額 ／ B 補填される金額 ／ C 差引金額 ／ 控除額（C − 1万2千円。8万8千円まで） */
  a: number; b: number; c: number; deduction: number;
}

/** セルフメディケーション税制の明細書（同じ支払先・同じ医薬品の行はまとめる） */
export const selfMedStatement = (m: IncomeTaxInput["medical"]): SelfMedStatement => {
  const rows: SelfMedStatementRow[] = [];
  for (const r of m.selfRows ?? []) {
    if (!r.paid && !r.reimbursed) continue;
    const same = rows.find((x) => x.payee === r.payee && x.medicine === r.medicine);
    if (same) {
      same.paid += r.paid;
      same.reimbursed += r.reimbursed;
    } else rows.push({ ...r });
  }
  const a = rows.reduce((s, r) => s + r.paid, 0);
  const b = rows.reduce((s, r) => s + r.reimbursed, 0);
  const c = Math.max(a - b, 0);
  return { effort: m.effort ?? { kind: "", issuer: "" }, rows, a, b, c, deduction: Math.min(Math.max(c - 12_000, 0), 88_000) };
};

/** e-Tax 用のデータに明細書を書けないわけ（行が多すぎる・取組が無い。書けるなら null） */
export const statementProblem = (m: IncomeTaxInput["medical"]): string | null => {
  if (m.kind === "self") {
    const s = selfMedStatement(m);
    if (s.rows.length > SELF_MED_ROWS) return `セルフメディケーション税制の明細書は${SELF_MED_ROWS}行までです（今は ${s.rows.length}行。同じ薬局・同じ医薬品はまとまります）`;
    if (s.rows.length && !s.effort.kind) return "セルフメディケーション税制の明細書に、健康の保持増進の取組（健康診査・予防接種など）を選んでください";
    return null;
  }
  const n = mergeMedicalRows(m.rows ?? []).length;
  return n > MEDICAL_ROWS ? `医療費控除の明細書は${MEDICAL_ROWS}行までです（今は ${n}行。同じ人・同じ支払先はまとまります。医療費通知の分は「医療費通知」の欄に入れると行が減ります）` : null;
};
