/**
 * 利用の記録（純粋関数）
 * ソフトが強制終了した・電源が落ちたなどで、ログアウトが記録されないことがある（防げない）。
 * そこで「ログインのあと、次のログインまでにログアウトが無い」ものを見つけて、画面で知らせる
 */
import type { AccessLogRecord } from "./types";

export type LoginEnd = "logout" | "missing" | "current";

/**
 * ログインの記録 ID → どう終わったか
 *  - logout：ログアウトが記録されている
 *  - missing：ログアウトが無いまま次のログインがあった（強制終了など）
 *  - current：いちばん新しいログインで、まだログアウトが無い（今使っている、または最後に強制終了した）
 */
export const loginEnds = (records: AccessLogRecord[]): Map<number, LoginEnd> => {
  const out = new Map<number, LoginEnd>();
  let open: number | null = null;
  for (const r of [...records].sort((a, b) => a.id - b.id)) {
    if (r.action === "login") {
      if (open !== null) out.set(open, "missing");
      open = r.id;
    } else if (open !== null) {
      out.set(open, "logout");
      open = null;
    }
  }
  if (open !== null) out.set(open, "current");
  return out;
};
