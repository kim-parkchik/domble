import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account, Counterparty, SubAccount } from "./types";
import { findDuplicates, guessJournalColumns, importJournalCsv, parseImportDate, type ImportContext } from "./journalImport";
import { toCsv } from "./csv";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const subs: SubAccount[] = [{ id: 1, account_id: id("普通預金"), name: "みずほ銀行", kana: "", sort_order: 10, is_active: 1 }];
const counterparties: Counterparty[] = [{ id: 7, name: "株式会社A", kana: "", invoice_no: "", memo: "", is_active: 1 }];
const ctx: ImportContext = { accounts, subs, counterparties };

const HEADER = ["伝票No", "日付", "借方科目", "借方補助", "借方金額", "貸方科目", "貸方補助", "貸方金額", "摘要", "取引先", "登録番号", "状態"];
const csv = (...rows: (string | number)[][]) => toCsv(HEADER, rows);

describe("日付", () => {
  test("年つきの書き方を読む", () => {
    expect(parseImportDate("2026-01-05")).toBe("2026-01-05");
    expect(parseImportDate("2026/1/5")).toBe("2026-01-05");
    expect(parseImportDate("２０２６年１月５日")).toBe("2026-01-05");
    expect(parseImportDate("20260105")).toBe("2026-01-05");
    expect(parseImportDate("1/5")).toBeNull();
    expect(parseImportDate("2026-02-30")).toBeNull();
  });
  test("和暦（R・H と令和・平成、元年）", () => {
    expect(parseImportDate("R8.1.5")).toBe("2026-01-05");
    expect(parseImportDate("R08/01/05")).toBe("2026-01-05");
    expect(parseImportDate("令和8年1月5日")).toBe("2026-01-05");
    expect(parseImportDate("令和元年5月1日")).toBe("2019-05-01");
    expect(parseImportDate("H31.4.30")).toBe("2019-04-30");
    expect(parseImportDate("r8-2-30")).toBeNull();
  });
});

describe("ほかの会計ソフトの CSV（列の対応）", () => {
  test("見出しの言い換えから列を推測し、見つからない必須の列は選んでもらう。選んだ対応で読む", () => {
    const other = toCsv(["取引日付", "仕訳番号", "借方勘定科目", "借方金額", "貸方勘定科目", "貸方金額", "摘要文"], [["R8.3.1", "1", "消耗品費", "1100", "現金", "1100", "文房具"]]);
    const r = importJournalCsv(other, ctx);
    expect(r.issues).toEqual([]);
    expect(r.entries[0]).toMatchObject({ date: "2026-03-01" });
    expect(r.entries[0].lines[0].memo).toBe("文房具");
    const odd = toCsv(["day", "dr", "dra", "cr", "cra"], [["2026-03-01", "消耗品費", "1100", "現金", "1100"]]);
    const first = importJournalCsv(odd, ctx);
    expect(first.issues[0].message).toMatch(/次の列を選んでください：日付、借方科目、借方金額、貸方科目、貸方金額/);
    const map = { ...guessJournalColumns(first.header), date: 0, drAcc: 1, drAmt: 2, crAcc: 3, crAmt: 4 };
    expect(importJournalCsv(odd, ctx, map).entries).toHaveLength(1);
  });
});

describe("重複かも", () => {
  test("帳簿にある仕訳と同じもの・ファイルの中で前と同じものに印。摘要は見ない。按分したあとの形でも合えば同じ", () => {
    const r = importJournalCsv(csv(
      [1, "2026-02-01", "消耗品費", "", 1100, "現金", "", 1100, "A", "", "", ""],
      [2, "2026-02-01", "消耗品費", "", 1100, "現金", "", 1100, "B", "", "", ""],
      [3, "2026-02-02", "通信費", "", 5000, "普通預金", "みずほ銀行", 5000, "", "", "", ""],
      [4, "2026-02-03", "地代家賃", "", 80000, "普通預金", "", 80000, "", "", "", ""],
    ), ctx);
    const existing = [
      { entry_id: 9, date: "2026-02-02", description: "", row_no: 1, side: "debit" as const, account_id: id("通信費"), sub_account_id: null, amount: 5000, memo: "別の摘要" },
      { entry_id: 9, date: "2026-02-02", description: "", row_no: 1, side: "credit" as const, account_id: id("普通預金"), sub_account_id: 1, amount: 5000, memo: "" },
      { entry_id: 10, date: "2026-02-03", description: "", row_no: 1, side: "debit" as const, account_id: id("地代家賃"), sub_account_id: null, amount: 48000, memo: "" },
      { entry_id: 10, date: "2026-02-03", description: "", row_no: 2, side: "debit" as const, account_id: id("事業主貸"), sub_account_id: null, amount: 32000, memo: "" },
      { entry_id: 10, date: "2026-02-03", description: "", row_no: 1, side: "credit" as const, account_id: id("普通預金"), sub_account_id: null, amount: 80000, memo: "" },
    ];
    const split = (i: number) => (i === 3 ? existing.filter((l) => l.entry_id === 10) : r.entries[i].lines);
    const d = findDuplicates(r.entries, existing, split);
    expect([...d.keys()]).toEqual([1, 2, 3]);
    expect(d.get(1)).toMatch(/ファイルの中で同じ仕訳が前に/);
    expect(d.get(2)).toMatch(/伝票 No.9/);
    expect(d.get(3)).toMatch(/伝票 No.10/);
  });
});

describe("仕訳の CSV 取り込み", () => {
  test("1行1仕訳。補助科目・取引先・摘要も読む", () => {
    const r = importJournalCsv(csv(
      ["", "2026-01-05", "消耗品費", "", "1,100", "普通預金", "みずほ銀行", "1100", "コピー用紙", "株式会社a", "", ""],
      ["", "2026/1/6", "現金", "", 500, "売上高", "", 500, "", "", "", ""],
    ), ctx);
    expect(r.issues).toEqual([]);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toEqual({
      date: "2026-01-05",
      counterpartyId: 7,
      adjustment: false,
      csvRows: [2],
      lines: [
        { row_no: 1, side: "debit", account_id: id("消耗品費"), sub_account_id: null, amount: 1100, memo: "コピー用紙" },
        { row_no: 1, side: "credit", account_id: id("普通預金"), sub_account_id: 1, amount: 1100, memo: "コピー用紙" },
      ],
    });
  });

  test("同じ伝票No の行は1つの複合仕訳。削除済みの行は飛ばす", () => {
    const r = importJournalCsv(csv(
      [3, "2026-02-01", "外注工賃", "", 10000, "普通預金", "", 8979, "外注", "", "", ""],
      [3, "2026-02-01", "", "", "", "預り金", "", 1021, "源泉", "", "", ""],
      [4, "2026-02-02", "現金", "", 1, "売上高", "", 1, "", "", "", "削除済み"],
    ), ctx);
    expect(r.issues).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].csvRows).toEqual([2, 3]);
    expect(r.entries[0].lines.map((l) => [l.row_no, l.side, l.amount])).toEqual([[1, "debit", 10000], [1, "credit", 8979], [2, "credit", 1021]]);
  });

  test("列の順番は問わず、余分な列は読まない", () => {
    const r = importJournalCsv(toCsv(["メモ欄", "貸方金額", "貸方科目", "借方金額", "借方科目", "日付"], [["x", 300, "売上高", 300, "現金", "2026-03-01"]]), ctx);
    expect(r.issues).toEqual([]);
    expect(r.entries[0].lines.map((l) => l.account_id)).toEqual([id("現金"), id("売上高")]);
  });

  test("問題があれば行番号つきで返し、1件も取り込まない", () => {
    const r = importJournalCsv(csv(
      ["", "2026-01-05", "消耗品費", "", 100, "現金", "", 100, "", "", "", ""],
      ["", "1/5", "雑費X", "", -5, "現金", "楽天銀行", "", "", "B社", "", ""],
      [9, "2026-01-07", "消耗品費", "", 100, "現金", "", 90, "", "", "", ""],
    ), ctx);
    expect(r.entries).toEqual([]);
    expect(r.issues.map((x) => x.row)).toEqual([3, 3, 3, 3, 3, 3, 4]);
    const msgs = r.issues.map((x) => x.message).join("\n");
    expect(msgs).toMatch(/日付「1\/5」が読めません/);
    expect(msgs).toMatch(/借方科目「雑費X」が勘定科目にありません/);
    expect(msgs).toMatch(/借方金額「-5」は 1 円以上/);
    expect(msgs).toMatch(/貸方補助「楽天銀行」/);
    expect(msgs).toMatch(/貸方金額がありません/);
    expect(msgs).toMatch(/借方と貸方の合計が一致しません/);
  });

  test("取引先が一覧に無い・伝票の中で日付が違う・締め済みの年度", () => {
    const r = importJournalCsv(csv(
      [1, "2025-12-31", "消耗品費", "", 100, "現金", "", 100, "", "B社", "", ""],
      [2, "2026-01-01", "消耗品費", "", 100, "現金", "", 50, "", "", "", ""],
      [2, "2026-01-02", "", "", "", "現金", "", 50, "", "", "", ""],
    ), { ...ctx, isDateClosed: (d) => d < "2026-01-01" });
    const msgs = r.issues.map((x) => `${x.row}:${x.message}`);
    expect(msgs.some((m) => m.startsWith("2:") && m.includes("取引先「B社」"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("2:") && m.includes("締め済み"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("4:") && m.includes("日付が違います"))).toBe(true);
  });

  test("必須の列が無い・中身が無い", () => {
    expect(importJournalCsv(toCsv(["日付", "借方科目"], [["2026-01-01", "現金"]]), ctx).issues[0].message).toMatch(/借方金額、貸方科目、貸方金額/);
    expect(importJournalCsv("﻿\r\n", ctx).issues[0].message).toMatch(/中身がありません/);
  });

  test("決算整理の列に何か入っていれば決算整理仕訳（日付は年度末だけ）", () => {
    const h = ["日付", "借方科目", "借方金額", "貸方科目", "貸方金額", "決算整理"];
    const ok = importJournalCsv(toCsv(h, [["2026-12-31", "減価償却費", 1000, "工具器具備品", 1000, "決算整理"], ["2026-12-31", "現金", 1, "売上高", 1, ""]]), ctx);
    expect(ok.issues).toEqual([]);
    expect(ok.entries.map((e) => e.adjustment)).toEqual([true, false]);
    const ng = importJournalCsv(toCsv(h, [["2026-12-30", "減価償却費", 1000, "工具器具備品", 1000, "○"]]), ctx);
    expect(ng.issues[0].message).toMatch(/年度末/);
  });

  test("書き出しで ' をつけた摘要は元に戻す", () => {
    const r = importJournalCsv(csv(["", "2026-01-05", "現金", "", 100, "売上高", "", 100, "-返金", "", "", ""]), ctx);
    expect(r.entries[0].lines[0].memo).toBe("-返金");
  });
});

describe("税区分の列", () => {
  const TAX_HEADER = ["日付", "借方科目", "借方金額", "借方税区分", "借方インボイス", "貸方科目", "貸方金額", "貸方税区分"];
  test("税区分・インボイスを読む。空なら初期値（保存のときに埋まる）", () => {
    const r = importJournalCsv(toCsv(TAX_HEADER, [
      ["2026-01-05", "消耗品費", 1080, "課税仕入 8%（軽減）", "経過措置", "現金", 1080, "対象外"],
      ["2026-01-06", "消耗品費", 1100, "", "", "現金", 1100, ""],
    ]), ctx);
    expect(r.issues).toEqual([]);
    expect(r.entries[0].lines.map((l) => [l.tax_code, l.invoice_kind])).toEqual([["purchase8", "transitional"], ["none", undefined]]);
    expect(r.entries[1].lines.map((l) => l.tax_code)).toEqual([undefined, undefined]);
  });

  test("用途区分の列を読む。読めなければ問題として返す", () => {
    const H = ["日付", "借方科目", "借方金額", "借方用途区分", "貸方科目", "貸方金額"];
    const r = importJournalCsv(toCsv(H, [["2026-01-05", "消耗品費", 1100, "非課税対応", "現金", 1100], ["2026-01-06", "消耗品費", 1100, "", "現金", 1100]]), ctx);
    expect(r.issues).toEqual([]);
    expect(r.entries.map((e) => e.lines[0].purchase_use)).toEqual(["nontaxable", undefined]);
    const bad = importJournalCsv(toCsv(H, [["2026-01-05", "消耗品費", 1100, "課税", "現金", 1100]]), ctx);
    expect(bad.issues.map((i) => i.message)).toEqual([expect.stringMatching(/借方用途区分「課税」/)]);
  });

  test("読めない税区分・インボイスは問題として返す", () => {
    const r = importJournalCsv(toCsv(TAX_HEADER, [["2026-01-05", "消耗品費", 1100, "消費税", "あり", "現金", 1100, ""]]), ctx);
    expect(r.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/借方税区分「消費税」/),
      expect.stringMatching(/借方インボイス「あり」/),
    ]);
  });
});
