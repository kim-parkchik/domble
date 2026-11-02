/**
 * 仕訳のまとめての置き換え：科目（税区分は新しい科目の初期値に）、補助科目、税区分、取引先
 */
import { describe, expect, test } from "bun:test";
import type { JournalLine } from "./types";
import { replaceInEntry, replaceSpecProblem, sameSlotRow } from "./bulkReplace";

const SUPPLIES = 621;
const OFFICE = 640;
const BANK = 103;
const CASH = 101;
const line = (p: Partial<JournalLine> & Pick<JournalLine, "side" | "account_id">): JournalLine => ({ row_no: 1, sub_account_id: null, amount: 1100, memo: "", ...p });
const entry = [
  line({ side: "debit", account_id: SUPPLIES, tax_code: "purchase10", invoice_kind: "transitional", tax_amount: 80 }),
  line({ side: "credit", account_id: BANK, sub_account_id: null }),
];

describe("科目", () => {
  test("前の科目の明細だけを後の科目に。科目が変わる明細の税区分は外して、新しい科目の初期値に任せる", () => {
    const r = replaceInEntry(entry, null, { account: { from: { accountId: SUPPLIES }, to: { accountId: OFFICE, subId: null } } });
    expect(r.changed).toBe(true);
    expect(r.lines[0]).toMatchObject({ account_id: OFFICE, tax_code: null, invoice_kind: null, tax_amount: null });
    expect(r.lines[1]).toEqual(entry[1]);
  });
  test("補助科目だけ変えるときは税区分を残す。前の補助科目を決めれば、その補助科目の明細だけ", () => {
    const toA = { account: { from: { accountId: BANK, subId: null }, to: { accountId: BANK, subId: 1 } } };
    expect(replaceInEntry(entry, null, toA).lines[1]).toMatchObject({ account_id: BANK, sub_account_id: 1 });
    const onlyB = { account: { from: { accountId: BANK, subId: 2 }, to: { accountId: BANK, subId: 1 } } };
    expect(replaceInEntry(entry, null, onlyB).changed).toBe(false);
    const keepTax = { account: { from: { accountId: SUPPLIES }, to: { accountId: SUPPLIES, subId: 5 } } };
    expect(replaceInEntry(entry, null, keepTax).lines[0]).toMatchObject({ sub_account_id: 5, tax_code: "purchase10", invoice_kind: "transitional" });
  });
});

describe("税区分・取引先", () => {
  test("税区分は（置き換えたあとの）その科目の明細だけ", () => {
    const r = replaceInEntry(entry, null, {
      account: { from: { accountId: SUPPLIES }, to: { accountId: OFFICE, subId: null } },
      tax: { accountId: OFFICE, code: "purchase10", invoice: "qualified", cls: null, use: null },
    });
    expect(r.lines[0]).toMatchObject({ account_id: OFFICE, tax_code: "purchase10", invoice_kind: "qualified" });
    expect(r.lines[1].tax_code).toBeUndefined();
  });
  test("取引先：前を決めれば、その取引先の仕訳だけ。同じなら変わらない", () => {
    expect(replaceInEntry(entry, 3, { counterparty: { to: 4 } })).toMatchObject({ counterpartyId: 4, changed: true });
    expect(replaceInEntry(entry, 3, { counterparty: { from: 5, to: 4 } })).toMatchObject({ counterpartyId: 3, changed: false });
    expect(replaceInEntry(entry, null, { counterparty: { from: null, to: 4 } }).counterpartyId).toBe(4);
    expect(replaceInEntry(entry, 3, { counterparty: { to: null } }).counterpartyId).toBeNull();
  });
});

describe("部門", () => {
  const withDept = [{ ...entry[0], department_id: 1 }, { ...entry[1], department_id: 1 }];
  test("前を決めなければすべての明細、決めればその部門の明細だけ。後を空にすると共通", () => {
    expect(replaceInEntry(entry, null, { department: { to: 2 } }).lines.map((l) => l.department_id)).toEqual([2, 2]);
    expect(replaceInEntry(withDept, null, { department: { from: 3, to: 2 } }).changed).toBe(false);
    expect(replaceInEntry(withDept, null, { department: { from: 1, to: null } }).lines.map((l) => l.department_id)).toEqual([null, null]);
    // 共通（部門なし）の明細だけ
    const mixed = [withDept[0], entry[1]];
    expect(replaceInEntry(mixed, null, { department: { from: null, to: 2 } }).lines.map((l) => l.department_id ?? null)).toEqual([1, 2]);
  });
  test("同じ部門への置き換えは問題", () => {
    expect(replaceSpecProblem({ department: { from: 2, to: 2 } })).toMatch(/部門の置き換える前と後が同じ/);
    expect(replaceSpecProblem({ department: { to: null } })).toBeNull();
  });
});

test("指定の問題と、借方・貸方が同じ科目になる行", () => {
  expect(replaceSpecProblem({})).toMatch(/選んでください/);
  expect(replaceSpecProblem({ account: { from: { accountId: BANK, subId: 1 }, to: { accountId: BANK, subId: 1 } } })).toMatch(/同じ/);
  expect(replaceSpecProblem({ account: { from: { accountId: BANK }, to: { accountId: BANK, subId: 1 } } })).toBeNull();
  expect(replaceSpecProblem({ counterparty: { from: 2, to: 2 } })).toMatch(/同じ/);
  const r = replaceInEntry(entry, null, { account: { from: { accountId: SUPPLIES }, to: { accountId: BANK, subId: null } } });
  expect(sameSlotRow(r.lines)).toBe(1);
  expect(sameSlotRow(entry)).toBeNull();
  expect(sameSlotRow([line({ side: "debit", account_id: CASH }), line({ side: "credit", account_id: CASH, row_no: 2 })])).toBeNull();
});
