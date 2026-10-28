/**
 * 分野 F・補足：所得税の計算（src/lib/incomeTax.ts）が令和8年分の決まりで固定されていることを、令和7年分の正しい額と並べて確かめる
 * 何を確かめるか：
 *  - 基礎控除（令和7年分：132万円以下95万・336万円以下88万・489万円以下68万・655万円以下63万・2,350万円以下58万）
 *  - 給与所得控除の最低保障（令和7年分 65万円。domble は令和8・9年分の 74万円）
 *  - 扶養親族・同一生計配偶者の所得要件（令和7年分 58万円。domble は 62万円）、特定親族特別控除（58万円超）
 *  - 生命保険料控除の23歳未満の扶養親族がいる場合の特例（令和8年分だけ。令和7年分には無い）
 *  - 勤労学生控除の所得要件（令和7年分 85万円、令和8年分 89万円。domble は 85万円のまま）
 *  - year を渡しても、年齢の計算にしか使われない（年分で決まりが変わらない）
 * 動かし方：bun spec/audit/scenarios/s4_r7_rules.ts（リポジトリの直下で）
 */
import {
  basicDeduction, salaryIncome, spouseDeduction, dependentDeduction, lifeInsuranceDeduction, computeIncomeTax, EMPTY_INCOME_TAX_INPUT, emptyRelative,
} from "../../../src/lib/incomeTax";
import { cmp, printTable, type Cmp } from "./common";

const rows: Cmp[] = [];
for (const [inc, r7] of [[1_000_000, 950_000], [3_000_000, 880_000], [4_500_000, 680_000], [6_000_000, 630_000], [10_000_000, 580_000]] as const) {
  cmp(rows, `基礎控除（合計所得金額 ${inc.toLocaleString()}円）`, r7, basicDeduction(inc));
}
cmp(rows, "給与所得（給与収入 1,000,000円）", 350_000, salaryIncome(1_000_000), "令和7年分は 100万 − 65万");
cmp(rows, "給与所得（給与収入 1,800,000円）", 1_150_000, salaryIncome(1_800_000));
cmp(rows, "給与所得（給与収入 3,000,000円）", 2_020_000, salaryIncome(3_000_000), "ここは令和7年分と令和8年分で同じ");
const sp = spouseDeduction({ ...emptyRelative("妻"), birthday: "1985-01-01", income: 600_000 }, 5_000_000, 2025);
cmp(rows, "配偶者（合計所得金額 60万円）の区分", "配偶者特別控除", sp.kind === "spouse" ? "配偶者控除" : sp.kind === "special" ? "配偶者特別控除" : "なし");
const dep = dependentDeduction({ ...emptyRelative("母"), birthday: "1960-01-01", income: 600_000 }, 2025);
cmp(rows, "扶養親族（65歳・合計所得金額 60万円）の扶養控除", 0, dep.amount, "令和7年分は 58万円超なので扶養親族にならない");
const stu = dependentDeduction({ ...emptyRelative("子"), birthday: "2005-06-01", income: 600_000 }, 2025);
cmp(rows, "20歳の子（合計所得金額 60万円）の区分", "特定親族特別控除 63万", `${stu.kind === "specific" ? "特定扶養親族" : stu.kind === "specificRelative" ? "特定親族特別控除" : stu.kind} ${stu.amount / 10000}万`, "額は同じだが欄（㉓扶養控除／㉔特定親族特別控除）が違う");
cmp(rows, "生命保険料控除（新生命 10万円・10歳の子あり）", 40_000, lifeInsuranceDeduction({ newLife: 100_000, oldLife: 0, newPension: 0, oldPension: 0, care: 0 }, true), "23歳未満の扶養親族の特例は令和8年分だけ");
// 勤労学生（令和8年分）：合計所得金額 87万円（給与収入 161万円 → 令和8年分の給与所得 87万円）
const s26 = computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT, student: true, salaries: [{ item: "給料", payer: "A", payerId: "", income: 1_610_000, withheld: 0 }] },
  { revenue: 0, incomeBeforeBlue: 0, filingType: "white", familySalary: 0 }, 2026);
cmp(rows, "（令和8年分）勤労学生控除：合計所得金額 87万円", 270_000, s26.rows.find((r) => r.no === "⑲⑳")?.value ?? null, "令和8年分の所得要件は 89万円以下（国税庁 No.1175）");
// 同じ入力で year だけ変えても、決まりは変わらない
const a = computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT }, { revenue: 5_000_000, incomeBeforeBlue: 3_650_000, filingType: "blue65", familySalary: 0 }, 2025);
const c = computeIncomeTax({ ...EMPTY_INCOME_TAX_INPUT }, { revenue: 5_000_000, incomeBeforeBlue: 3_650_000, filingType: "blue65", familySalary: 0 }, 2026);
cmp(rows, "year=2025 と 2026 で基礎控除が変わるか（所得 300万円）", "880,000 と 1,040,000", `${a.rows.find((r) => r.no === "㉕")!.value!.toLocaleString()} と ${c.rows.find((r) => r.no === "㉕")!.value!.toLocaleString()}`);
printTable("補足 所得税の決まり（令和7年分の正しい額 と domble）", rows);
