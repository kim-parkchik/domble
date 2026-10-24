import { expect, test } from "bun:test";
import type { AccessLogRecord } from "./types";
import { loginEnds } from "./accessLog";

const rec = (id: number, action: "login" | "logout"): AccessLogRecord => ({ id, user_id: 1, user_name: "a", action, recorded_at: "" });

test("ログアウトの無いログインを見つける（並びは問わない）", () => {
  const ends = loginEnds([rec(5, "login"), rec(1, "login"), rec(2, "logout"), rec(3, "login"), rec(4, "login")]);
  expect(Object.fromEntries(ends)).toEqual({ 1: "logout", 3: "missing", 4: "missing", 5: "current" });
});

test("最後がログアウトなら、利用中のものは無い", () => {
  expect(Object.fromEntries(loginEnds([rec(1, "login"), rec(2, "logout")]))).toEqual({ 1: "logout" });
  expect(loginEnds([]).size).toBe(0);
});
