import { describe, expect, test } from "bun:test";
import { backupName, backupsToRemove, isSyncedPath, lockState, parseBackupName, parseLock, stampLabel } from "./backup";

describe("バックアップの名前", () => {
  test("帳簿名_日時（と印）。ほかの帳簿（名前が前方一致するだけ）は違う", () => {
    expect(backupName("帳簿", new Date(2026, 9, 30, 9, 5, 7), "dmbk")).toBe("帳簿_20261030-090507.dmbk");
    expect(backupName("帳簿", new Date(2026, 9, 30, 9, 5, 7), "dmbk", "戻す前")).toBe("帳簿_20261030-090507_戻す前.dmbk");
    expect(parseBackupName("帳簿_20261030-090507_戻す前.dmbk", "帳簿", "dmbk")).toEqual({ stamp: "20261030-090507", suffix: "戻す前" });
    expect(parseBackupName("帳簿_2_20261030-090507.dmbk", "帳簿", "dmbk")).toBeNull();
  });
  test("一覧に出す日時", () => {
    expect(stampLabel("20261030-090507")).toBe("2026/10/30 09:05:07");
    expect(stampLabel("20270105-235959")).toBe("2027/1/5 23:59:59");
  });
});

describe("バックアップの世代管理", () => {
  const files = [
    "2026年_帳簿_20260103-090000.dmbk",
    "2026年_帳簿_20260101-090000.dmbk",
    "2026年_帳簿_20260101-180000.dmbk",
    "2026年_帳簿_20260102-090000.dmbk",
    "2026年_帳簿_2_20260101-080000.dmbk", // 別の帳簿（名前が前方一致するだけ）
    "2026年_帳簿_20250101-090000_戻す前.dmbk",
    "メモ.txt",
  ];
  test("新しい keep 世代のほか、日ごとにその日のいちばん新しいもの（30日）を残す", () => {
    expect(backupsToRemove(files, "2026年_帳簿", "dmbk", 2)).toEqual(["2026年_帳簿_20260101-090000.dmbk"]);
    expect(backupsToRemove(files, "2026年_帳簿", "dmbk", 100)).toEqual([]);
    expect(backupsToRemove(files, "2026年_帳簿_2", "dmbk", 1)).toEqual([]);
  });
  test("30日より前は月ごとにいちばん新しいもの（7年＝84か月）だけ。戻す前のものには触れない", () => {
    const many = [
      "b_20190131-120000.dmbk", // 84か月より前
      "b_20250510-120000.dmbk", "b_20250520-120000.dmbk", // 2025年5月：20日のだけ残る
      "b_20260901-120000.dmbk", "b_20260915-120000.dmbk", // 30日より前の9月：15日のだけ
      "b_20261020-080000.dmbk", "b_20261020-090000.dmbk", // 30日以内：日ごとに新しいもの
      "b_20261030-120000.dmbk",
      "b_20180101-120000_戻す前.dmbk",
    ];
    expect(backupsToRemove(many, "b", "dmbk", 1, "20261030")).toEqual([
      "b_20190131-120000.dmbk", "b_20250510-120000.dmbk", "b_20260901-120000.dmbk", "b_20261020-080000.dmbk",
    ]);
  });
});

describe("同期フォルダ・使用中の目印", () => {
  test("同期フォルダの中か", () => {
    expect(isSyncedPath("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/帳簿.dmbl")).toBe(true);
    expect(isSyncedPath("/Users/a/Library/CloudStorage/Dropbox/帳簿.dmbl")).toBe(true);
    expect(isSyncedPath("/Users/a/Dropbox/帳簿.dmbl")).toBe(true);
    expect(isSyncedPath("/Users/a/Documents/domble/帳簿.dmbl")).toBe(false);
  });
  test("目印：無い・この PC・ほかの PC。壊れた目印は無いものとする", () => {
    const lock = parseLock(JSON.stringify({ host: "mac-a", device: "d1", openedAt: "2026-10-30T09:00:00", app: "0.2.0" }));
    expect(lock).toEqual({ host: "mac-a", device: "d1", openedAt: "2026-10-30T09:00:00", app: "0.2.0" });
    expect([lockState(null, "d1"), lockState(lock, "d1"), lockState(lock, "d2")]).toEqual(["none", "self", "other"]);
    expect(parseLock("{")).toBeNull();
  });
});
