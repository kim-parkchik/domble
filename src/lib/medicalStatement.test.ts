/**
 * 医療費控除の明細書・セルフメディケーション税制の明細書
 */
import { describe, expect, test } from "bun:test";
import { medicalStatement, selfMedStatement, statementProblem, MEDICAL_ROWS } from "./medicalStatement";
import { EMPTY_INCOME_TAX_INPUT, hasMedicalDetail, medicalDeduction, medicalTotals, type IncomeTaxInput } from "./incomeTax";

const m = (x: Partial<IncomeTaxInput["medical"]>): IncomeTaxInput["medical"] => ({ ...EMPTY_INCOME_TAX_INPUT.medical, ...x });

describe("医療費控除の明細書", () => {
  test("同じ人・同じ支払先はまとめ、区分を合わせる。医療費通知と合わせて A・B、所得の 5% と 10万円の少ない方を引く", () => {
    const med = m({
      notice: { amount: 80_000, paid: 70_000, reimbursed: 0 },
      rows: [
        { person: "本人", payee: "A病院", kind: "treatment", paid: 50_000, reimbursed: 0 },
        { person: "本人", payee: "A病院", kind: "medicine", paid: 10_000, reimbursed: 0 },
        { person: "子", payee: "A病院", kind: "treatment", paid: 30_000, reimbursed: 20_000 },
        { person: "子", payee: "B薬局", kind: "medicine", paid: 0, reimbursed: 0 },
      ],
    });
    const s = medicalStatement(med, 1_500_000);
    expect(s.rows.map((r) => [r.person, r.payee, r.kinds, r.paid])).toEqual([["本人", "A病院", ["treatment", "medicine"], 60_000], ["子", "A病院", ["treatment"], 30_000]]);
    expect([s.a, s.b, s.c, s.e, s.f, s.deduction]).toEqual([160_000, 20_000, 140_000, 75_000, 75_000, 65_000]);
    // 第一表の医療費控除も明細の合計から
    expect(medicalTotals(med)).toEqual({ paid: 160_000, reimbursed: 20_000 });
    expect(medicalDeduction(med, 1_500_000)).toBe(65_000);
  });
  test("明細が無ければ、合計だけ入れた額で計算する（明細書は作らない）", () => {
    const med = m({ paid: 300_000, reimbursed: 0 });
    expect(hasMedicalDetail(med)).toBe(false);
    expect(medicalDeduction(med, 5_000_000)).toBe(200_000);
  });
  test("明細書の行が多すぎれば書き出せない", () => {
    const rows = Array.from({ length: MEDICAL_ROWS + 1 }, (_, i) => ({ person: "本人", payee: `病院${i}`, kind: "treatment" as const, paid: 1_000, reimbursed: 0 }));
    expect(statementProblem(m({ rows }))).toMatch(/16行まで/);
    expect(statementProblem(m({ rows: rows.slice(0, MEDICAL_ROWS) }))).toBeNull();
  });
});

describe("セルフメディケーション税制の明細書", () => {
  test("同じ支払先・同じ医薬品はまとめる。1万2千円を引き、8万8千円まで", () => {
    const med = m({
      kind: "self", effort: { kind: "workplace", issuer: "勤務先" },
      selfRows: [
        { payee: "C薬局", medicine: "かぜ薬", paid: 50_000, reimbursed: 0 }, { payee: "C薬局", medicine: "かぜ薬", paid: 70_000, reimbursed: 0 },
        { payee: "D薬局", medicine: "胃腸薬", paid: 3_000, reimbursed: 1_000 },
      ],
    });
    const s = selfMedStatement(med);
    expect(s.rows.map((r) => [r.payee, r.paid])).toEqual([["C薬局", 120_000], ["D薬局", 3_000]]);
    expect([s.a, s.b, s.c, s.deduction]).toEqual([123_000, 1_000, 122_000, 88_000]);
    expect(medicalDeduction(med, 0)).toBe(88_000);
    expect(statementProblem({ ...med, effort: { kind: "", issuer: "" } })).toMatch(/取組/);
  });
});
