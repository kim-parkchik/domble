import { expect, test } from "bun:test";
import { can, permissionMessage } from "./permissions";

test("管理者はすべて、入力担当は入力だけ、閲覧のみは何もできない", () => {
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("admin", p))).toEqual([true, true, true, true]);
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("editor", p))).toEqual([true, false, false, false]);
  expect((["entry", "master", "settings", "users"] as const).map((p) => can("viewer", p))).toEqual([false, false, false, false]);
  expect(can(null, "entry")).toBe(false);
  expect(permissionMessage("editor")).toMatch(/入力担当/);
});
