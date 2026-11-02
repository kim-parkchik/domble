/**
 * 部門：並び順・確かめ・行の部門（借方・貸方の両方）・絞り込み、部門別の損益（共通の列・合計）
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { FlatLine } from "./accounting";
import type { Account } from "./types";
import { emptyRow } from "./accounting";
import { departmentName, matchesDepartment, MIXED, rowDepartment, sortDepartments, validateDepartment, withRowDepartment } from "./departments";
import { departmentHeads, departmentLines } from "./trend";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, income_kind: s.income_kind ?? "business", default_tax_code: null, default_business_class: null,
  default_purchase_use: null, statement_line: null,
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;

describe("部門の一覧", () => {
  test("コード（数の大きさで）→ 名前の順。コードの無い部門はあと", () => {
    const list = [{ code: "", name: "通販" }, { code: "10", name: "支店" }, { code: "2", name: "本店" }, { code: "", name: "キッチンカー" }];
    expect(sortDepartments(list).map((d) => d.name)).toEqual(["本店", "支店", "キッチンカー", "通販"]);
  });
  test("名前は必須・同じ名前（全角半角の違いも）は不可・「共通」は使えない", () => {
    const list = [{ id: 1, name: "本店" }];
    const d = (name: string, code = "") => ({ code, name, kana: "", memo: "" });
    expect(validateDepartment(list, d(" "))).toMatch(/部門名/);
    expect(validateDepartment(list, d("本店"))).toMatch(/同じ名前/);
    expect(validateDepartment(list, d("本店"), 1)).toBeNull();
    expect(validateDepartment(list, d("共通"))).toMatch(/共通/);
    expect(validateDepartment(list, d("支店", "12345678901"))).toMatch(/コード/);
    expect(validateDepartment(list, d("支店"))).toBeNull();
  });
});

describe("行の部門", () => {
  const row = { ...emptyRow(), debitAccountId: 1, creditAccountId: 2 };
  test("借方・貸方の両方に付け、両方同じならその部門。違えば MIXED", () => {
    const r = withRowDepartment(row, 3);
    expect([r.debitDept, r.creditDept]).toEqual([3, 3]);
    expect(rowDepartment(r)).toBe(3);
    expect(rowDepartment({ ...r, creditDept: 4 })).toBe(MIXED);
    expect(withRowDepartment({ ...r, creditDept: 4 }, MIXED)).toMatchObject({ debitDept: 3, creditDept: 4 });
    // 片側だけの行（複合仕訳の2行目など）は、その側の部門
    expect(rowDepartment({ ...emptyRow(), debitAccountId: 1, debitDept: 5 })).toBe(5);
    expect(rowDepartment(row)).toBeNull();
  });
  test("名前と絞り込み（0 = 共通）", () => {
    expect(departmentName([{ id: 3, name: "本店" }], 3)).toBe("本店");
    expect(departmentName([], null)).toBe("共通（部門なし）");
    expect(matchesDepartment({ department_id: 3 }, 3)).toBe(true);
    expect(matchesDepartment({ department_id: null }, 0)).toBe(true);
    expect(matchesDepartment({}, 0)).toBe(true);
    expect(matchesDepartment({ department_id: 3 }, 0)).toBe(false);
    expect(matchesDepartment({ department_id: 3 }, "all")).toBe(true);
  });
});

describe("部門別の損益", () => {
  let n = 0;
  const je = (dr: string, cr: string, amount: number, dept: number | null, date = "2026-03-10"): FlatLine[] => {
    n++;
    const base = { entry_id: n, date, description: "", memo: "", row_no: 1, amount, department_id: dept };
    return [
      { ...base, side: "debit", account_id: id(dr), sub_account_id: null },
      { ...base, side: "credit", account_id: id(cr), sub_account_id: null },
    ];
  };
  const lines = [
    ...je("現金", "売上高", 500_000, 1),
    ...je("現金", "売上高", 300_000, 2),
    ...je("仕入高", "現金", 200_000, 1),
    ...je("地代家賃", "普通預金", 120_000, null), // 共通の経費は割り振らない
    ...je("消耗品費", "現金", 10_000, 2, "2026-07-01"),
  ];
  const depts = [{ id: 1, name: "本店" }, { id: 2, name: "キッチンカー" }];
  const out = departmentLines(accounts, [], lines, 1, 13, depts, { showSubs: false, hideZero: true });
  const row = (label: string) => out.find((l) => l.label === label && l.kind === "account")!;
  test("列は部門ごと・共通・合計。損益の科目だけ", () => {
    expect(departmentHeads(depts)).toEqual(["本店", "キッチンカー", "共通", "合計"]);
    expect(row("売上高").values).toEqual([500_000, 300_000, 0, 800_000]);
    expect(row("仕入高").values).toEqual([200_000, 0, 0, 200_000]);
    expect(row("地代家賃").values).toEqual([0, 0, 120_000, 120_000]);
    expect(out.some((l) => l.label === "現金")).toBe(false);
    // 所得：本店 300,000、キッチンカー 290,000、共通 ▲120,000、合計 470,000
    expect(out[out.length - 1].values).toEqual([300_000, 290_000, -120_000, 470_000]);
  });
  test("期間で絞る", () => {
    const q1 = departmentLines(accounts, [], lines, 1, 3, depts, { showSubs: false, hideZero: true });
    expect(q1.some((l) => l.label === "消耗品費")).toBe(false);
  });
});
