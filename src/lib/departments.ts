/**
 * 部門（純粋関数）
 * 店舗・事業の種類などを仕訳の明細ごとに付けて、部門ごとの損益を見る（決算書・申告書は全部まとめて1枚のまま）。
 *  - 明細ごとに1つ（journal_lines.department_id。null = 共通・部門なし）。画面（帳簿入力・振替伝票）では行に1つ選び、借方・貸方の両方に付ける
 *  - 借方と貸方で違う部門の明細（CSV で取り込んだものなど）は、行の部門を「借方と貸方で違う」として、そのまま持つ
 *  - 共通の経費（家賃・電気代など）は割り振らず、部門別の表の「共通」の列に出す
 */
import type { Department, VoucherRow } from "./types";
import { normName } from "./counterparty";

/** 部門別の表・絞り込みで、部門の無い明細の呼び方 */
export const COMMON_LABEL = "共通（部門なし）";
/** 行の部門が借方と貸方で違うとき */
export const MIXED = "mixed" as const;

/** 並び順：コード（数字は数の大きさで）→ 名前 */
export const sortDepartments = <T extends Pick<Department, "code" | "name">>(list: T[]): T[] =>
  [...list].sort((a, b) =>
    (a.code === "" ? 1 : 0) - (b.code === "" ? 1 : 0) || a.code.localeCompare(b.code, "ja", { numeric: true }) || a.name.localeCompare(b.name, "ja"));

export interface DepartmentInput {
  code: string;
  name: string;
  kana: string;
  memo: string;
}

/** 登録・編集の確かめ（問題が無ければ null） */
export const validateDepartment = (list: Pick<Department, "id" | "name">[], d: DepartmentInput, editingId?: number): string | null => {
  const name = d.name.trim();
  if (!name) return "部門名を入れてください";
  if (name.length > 30) return "部門名は30文字までです";
  if (name === COMMON_LABEL || normName(name) === normName("共通")) return "「共通」は部門の無い明細の呼び方なので、部門名にできません";
  if (d.code.trim().length > 10) return "コードは10文字までです";
  if (list.some((x) => x.id !== editingId && normName(x.name) === normName(name))) return "同じ名前の部門があります";
  return null;
};

/** 行の部門（借方・貸方のある側から。両方あって違えば MIXED） */
export const rowDepartment = (r: Pick<VoucherRow, "debitAccountId" | "creditAccountId" | "debitDept" | "creditDept">): number | null | typeof MIXED => {
  const d = r.debitDept ?? null;
  const c = r.creditDept ?? null;
  if (r.debitAccountId && r.creditAccountId) return d === c ? d : MIXED;
  if (r.debitAccountId) return d;
  if (r.creditAccountId) return c;
  return d ?? c;
};

/** 行の部門を選ぶ（借方・貸方の両方に付ける）。MIXED を選んだときは変えない */
export const withRowDepartment = <T extends VoucherRow>(r: T, dept: number | null | typeof MIXED): T =>
  dept === MIXED ? r : { ...r, debitDept: dept, creditDept: dept };

/** 部門の名前（null は共通。見つからなければ #id） */
export const departmentName = (departments: Pick<Department, "id" | "name">[], id: number | null | undefined) =>
  id ? departments.find((d) => d.id === id)?.name ?? `#${id}` : COMMON_LABEL;

/** 部門で絞り込む明細（"all" = すべて、0 = 共通（部門なし）、それ以外は部門の id） */
export type DepartmentFilter = "all" | number;
export const matchesDepartment = (l: { department_id?: number | null }, filter: DepartmentFilter) =>
  filter === "all" || (l.department_id ?? 0) === filter;
