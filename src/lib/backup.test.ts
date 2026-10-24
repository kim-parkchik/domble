import { describe, expect, test } from "bun:test";
import { backupsToRemove } from "./backup";

describe("バックアップの世代管理", () => {
  const files = [
    "2026年_帳簿_20260103-090000.dmbk",
    "2026年_帳簿_20260101-090000.dmbk",
    "2026年_帳簿_20260102-090000.dmbk",
    "2026年_帳簿_2_20260101-080000.dmbk", // 別の帳簿（名前が前方一致するだけ）
    "メモ.txt",
  ];
  test("古いものから消し、新しい keep 世代を残す", () => {
    expect(backupsToRemove(files, "2026年_帳簿", "dmbk", 2)).toEqual(["2026年_帳簿_20260101-090000.dmbk"]);
  });
  test("世代数以下なら消さない。他の帳簿のバックアップには触れない", () => {
    expect(backupsToRemove(files, "2026年_帳簿", "dmbk", 100)).toEqual([]);
    expect(backupsToRemove(files, "2026年_帳簿_2", "dmbk", 1)).toEqual([]);
  });
  test("0 以下が来ても最低1世代は残す", () => {
    expect(backupsToRemove(files, "2026年_帳簿", "dmbk", 0)).toHaveLength(2);
  });
});
