/**
 * 帳簿の CSV（各帳簿の画面と、まとめての書き出しで同じもの）
 */
import { describe, expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { FlatLine } from "./accounting";
import type { Account, Counterparty, SubAccount } from "./types";
import { subKey } from "./types";
import type { FixedAsset } from "./depreciation";
import {
  assetPrintLine, assetsOfYear, journalCsvRows, journalRowsAll, labelOfAccount, ledgerCsvAll, trialCsvRows, trialLines, type BookSource,
} from "./bookExport";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({
  ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1, income_kind: s.income_kind ?? "business", default_tax_code: null, default_business_class: null,
  default_purchase_use: null, statement_line: null,
}));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const subs: SubAccount[] = [{ id: 1, account_id: id("普通預金"), name: "A銀行", kana: "", sort_order: 1, is_active: 1 }];
const cps: Counterparty[] = [{ id: 1, name: "株式会社A", kana: "", invoice_no: "T1234567890123", not_registered: 0, memo: "", is_active: 1 }];

const line = (entry: number, row: number, side: "debit" | "credit", account: string, amount: number, o: Partial<FlatLine> = {}): FlatLine => ({
  entry_id: entry, date: "2026-01-10", description: "", row_no: row, side, account_id: id(account), sub_account_id: null, amount, memo: "",
  created_at: "2026-01-11 09:00:00", is_adjustment: 0, ...o,
});
const lines: FlatLine[] = [
  line(1, 1, "debit", "普通預金", 330_000, { sub_account_id: 1, memo: "売上", counterparty_id: 1 }),
  line(1, 1, "credit", "売上高", 300_000, { memo: "売上", counterparty_id: 1 }),
  line(1, 2, "credit", "仮受消費税等", 30_000, { memo: "消費税", counterparty_id: 1 }),
  line(2, 1, "debit", "地代家賃", 80_000, { date: "2026-02-25", memo: "家賃", created_at: "2026-06-30 09:00:00" }),
  line(2, 1, "credit", "普通預金", 80_000, { date: "2026-02-25", sub_account_id: 1, memo: "家賃", created_at: "2026-06-30 09:00:00" }),
];
const book: BookSource = {
  accounts, subs, counterparties: cps, taxYears: [], lines,
  opening: { [id("普通預金")]: 100_000, [id("元入金")]: 100_000 },
  subOpening: { [subKey(id("普通預金"), 1)]: 100_000, [subKey(id("元入金"), null)]: 100_000 },
};

describe("仕訳日記帳", () => {
  test("伝票ごとに行番号で借方｜貸方を並べ、取引先・登録番号・遅れて登録を出す", () => {
    const rows = journalRowsAll(lines, cps, 70);
    expect(rows.map((r) => [r.entryId, r.first, r.dr?.amount ?? null, r.cr?.amount ?? null, r.late])).toEqual([
      [1, true, 330_000, 300_000, false], [1, false, null, 30_000, false], [2, true, 80_000, 80_000, true],
    ]);
    const csv = journalCsvRows(rows, accounts, subs, cps);
    expect(csv[0].slice(0, 12)).toEqual([1, "2026-01-10", "普通預金", "A銀行", 330_000, "売上高", "", 300_000, "売上", "株式会社A", "T1234567890123", ""]);
    expect(csv[2].slice(12, 15)).toEqual(["2026-06-30 09:00:00", 125, "過ぎて登録"]);
    // 遅れた理由があれば添える
    const withReason = journalCsvRows(journalRowsAll(lines, cps, 70, new Map([[2, "領収書をあとから見つけた"]])), accounts, subs, cps);
    expect(withReason[2][14]).toBe("過ぎて登録（理由：領収書をあとから見つけた）");
  });
});

describe("総勘定元帳・残高試算表", () => {
  test("元帳は動きか残高のある科目すべて、科目ごとに繰越の行から", () => {
    const csv = ledgerCsvAll(book, 1, 13);
    expect([...new Set(csv.map((r) => r[0]))]).toEqual(["普通預金", "仮受消費税等", "元入金", "売上高", "地代家賃"]);
    expect(csv.filter((r) => r[0] === "普通預金").map((r) => r[10])).toEqual([100_000, 430_000, 350_000]);
    expect(labelOfAccount(accounts, subs)(id("普通預金"), 1)).toBe("普通預金（A銀行）");
  });
  test("試算表の行と CSV（区分・補助科目・所得金額）", () => {
    const bs = trialLines("bs", book, 1, 13, { showSubs: true, hideZero: true });
    expect(bs.find((l) => l.label === "A銀行")).toMatchObject({ kind: "sub", carried: 100_000, balance: 350_000 });
    const pl = trialCsvRows("pl", trialLines("pl", book, 1, 13, { showSubs: true, hideZero: true }));
    expect(pl.find((r) => r[1] === "地代家賃")).toEqual(["損益計算書・経費", "地代家賃", "", 0, 80_000, 0, 80_000]);
    expect(pl.at(-1)).toEqual(["損益計算書", "青色申告特別控除前の所得金額", "", 0, "", "", 220_000]);
  });
});

describe("固定資産台帳", () => {
  test("その年に償却する資産だけを行にする", () => {
    const pc: FixedAsset = {
      id: 1, name: "パソコン", account_id: id("工具器具備品"), acquired_on: "2026-04-01", used_on: "2026-04-01", cost: 240_000, method: "straight",
      useful_life: 4, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", income_kind: "business",
    } as FixedAsset;
    expect(assetsOfYear([pc], 2025)).toEqual([]);
    const [r] = assetsOfYear([pc], 2026);
    expect(assetPrintLine(r.a, r.d, () => "工具器具備品")).toMatchObject({ name: "パソコン", life: "4年", months: 9, depreciation: 45_000, closing: 195_000 });
  });
});
