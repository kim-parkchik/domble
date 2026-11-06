import { expect, test } from "bun:test";
import { can, permissionMessage } from "./permissions";

test("管理者はすべて、入力担当は入力だけ、閲覧のみは何もできない", () => {
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("admin", p))).toEqual([true, true, true, true]);
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("editor", p))).toEqual([true, false, false, false]);
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("viewer", p))).toEqual([false, false, false, false]);
  expect(can(null, "entry")).toBe(false);
  expect(permissionMessage("editor")).toMatch(/入力担当/);
});

test("税理士は会計の操作（入力・科目・設定）ができ、持ち主だけの操作（保存方式・暗号化・バックアップ）とユーザーの管理はできない", () => {
  expect((["entry", "master", "settings", "owner", "users"] as const).map((p) => can("accountant", p))).toEqual([true, true, true, false, false]);
  expect(can("admin", "owner")).toBe(true);
  expect(can("editor", "owner")).toBe(false);
  expect(permissionMessage("accountant")).toMatch(/税理士/);
});
