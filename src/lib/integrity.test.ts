import { expect, test } from "bun:test";
import { entryState } from "./integrity";

const line = { row_no: 1, side: "debit", account_id: 1, sub_account_id: null, amount: 100, memo: "x" };

test("仕訳の正規形：決算整理でない仕訳は、印を足す前と同じ文字列（記録済みのハッシュを変えない）", () => {
  const e = { date: "2026-06-01", counterparty_id: null, is_deleted: 0, revision: 1 };
  const before = JSON.stringify(["2026-06-01", null, 0, 1, [[1, 0, 1, 0, 100, "x"]]]);
  expect(entryState(e, [line])).toBe(before);
  expect(entryState({ ...e, is_adjustment: 0 }, [line])).toBe(before);
});

test("仕訳の正規形：決算整理の仕訳だけ印が入る", () => {
  const e = { date: "2026-12-31", counterparty_id: null, is_deleted: 0, revision: 1, is_adjustment: 1 };
  expect(entryState(e, [line])).toBe(JSON.stringify(["2026-12-31", null, 0, 1, [[1, 0, 1, 0, 100, "x"]], "adjustment"]));
});
