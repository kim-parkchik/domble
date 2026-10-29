import { expect, test } from "bun:test";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import type { Account } from "./types";
import { buildLedger, toAccountMap, type FlatLine } from "./accounting";
import { journalSection, ledgerCsvRows, ledgerSection, tableSection, trialSection, type LedgerPrintSource } from "./printBooks";
import type { PrintCell, PrintRow } from "./printLayout";

const accounts: Account[] = ACCOUNT_SEEDS.map((s, i) => ({ ...s, id: i + 1, sort_order: i, is_active: 1, is_system: 1 }));
const id = (name: string) => accounts.find((a) => a.name === name)!.id;
const map = toAccountMap(accounts);

let entryId = 0;
const lines: FlatLine[] = [];
const simple = (date: string, dr: string, cr: string, amount: number, adjustment = false) => {
  entryId++;
  for (const [side, name, row] of [["debit", dr, 1], ["credit", cr, 2]] as const)
    lines.push({ entry_id: entryId, date, description: "", row_no: row, side, account_id: id(name), sub_account_id: null, amount, memo: `${dr}/${cr}`, is_adjustment: adjustment ? 1 : 0 });
};
simple("2025-01-10", "普通預金", "売上高", 100_000);
simple("2025-01-25", "地代家賃", "普通預金", 30_000);
simple("2025-03-05", "普通預金", "売上高", 50_000);
simple("2025-12-31", "事業主貸", "普通預金", 5_000, true);

const bank = buildLedger(map.get(id("普通預金"))!, 200_000, lines, map);
const source = (from: number, to: number): LedgerPrintSource => ({
  heading: "普通預金", rows: bank, opening: 200_000, from, to, labels: { dr: "借方", cr: "貸方" },
  counterOf: (r) => r.counter, taxOf: () => "", noteOf: () => "",
});
const texts = (r: PrintRow) => r.cells.map((c) => (typeof c === "string" ? c : (c as PrintCell).text));

test("元帳：繰越・明細・月計と累計（決算整理は12月のあとの期間）", () => {
  const s = ledgerSection(source(1, 13));
  const rows = s.groups.flatMap((g) => g.rows).map(texts);
  expect(rows).toEqual([
    ["", "前期より繰越", "200,000"],
    ["01/10", "1", "売上高", "", "普通預金/売上高", "100,000", "", "300,000"],
    ["01/25", "2", "地代家賃", "", "地代家賃/普通預金", "", "30,000", "270,000"],
    ["", "1月　計", "100,000", "30,000", ""],
    ["", "累　計", "100,000", "30,000", ""],
    ["03/05", "3", "売上高", "", "普通預金/売上高", "50,000", "", "320,000"],
    ["", "3月　計", "50,000", "0", ""],
    ["", "累　計", "150,000", "30,000", ""],
    ["12/31", "4", "事業主貸", "", "事業主貸/普通預金", "", "5,000", "315,000"],
    ["", "決算整理　計", "0", "5,000", ""],
    ["", "累　計", "150,000", "35,000", ""],
  ]);
  // 決算整理の印・続きのページの繰越（その行のあとの残高）
  expect((s.groups[6].rows[0].cells[4] as PrintCell).tag).toBe("決算整理");
  expect(texts(s.groups[2].carry!)).toEqual(["", "前頁より繰越", "270,000"]);
  // 列の数がどの行もそろっている
  for (const r of s.groups.flatMap((g) => [...g.rows, ...(g.carry ? [g.carry] : [])]))
    expect(r.cells.reduce((n, c) => n + (typeof c === "string" ? 1 : c.span ?? 1), 0)).toBe(s.columns.length);
});

test("元帳：途中の月からは前月より繰越、累計は年の初めから", () => {
  const s = ledgerSection(source(3, 12));
  const rows = s.groups.flatMap((g) => g.rows).map(texts);
  expect(rows[0]).toEqual(["", "前月より繰越", "270,000"]);
  expect(rows.at(-1)).toEqual(["", "累　計", "150,000", "30,000", ""]);
  // 動きのない期間
  expect(ledgerSection(source(6, 6)).groups.flatMap((g) => g.rows).map(texts)).toEqual([["", "前月より繰越", "320,000"], ["", "この期間の動きはありません"]]);
});

test("元帳の CSV：科目ごとに繰越の行から", () => {
  const rows = ledgerCsvRows("普通預金", source(1, 12), () => "", () => "");
  expect(rows[0]).toEqual(["普通預金", "", "", "", "", "", "前期より繰越", "", "", "", 200_000, ""]);
  expect(rows).toHaveLength(4);
  expect(rows[3]).toEqual(["普通預金", "", "2025-03-05", 3, "売上高", "", "普通預金/売上高", "", 50_000, "", 320_000, ""]);
});

test("仕訳日記帳：複合仕訳は1つのまとまり、削除済みは合計に入れない", () => {
  const s = journalSection([
    { entryId: 1, date: "2025-04-20", tags: ["訂正あり"], deleted: false, counterparty: "A社", lines: [
      { dr: { account: "通信費", sub: "", tax: "課仕10%", amount: 8_000 }, cr: { account: "普通預金", sub: "B銀行", tax: "", amount: 10_000 }, memo: "電話代" },
      { dr: { account: "事業主貸", sub: "", tax: "", amount: 2_000 }, memo: "" },
    ] },
    { entryId: 2, date: "2025-04-21", tags: ["削除済み"], deleted: true, counterparty: "", lines: [
      { dr: { account: "消耗品費", sub: "", tax: "", amount: 500 }, cr: { account: "現金", sub: "", tax: "", amount: 500 }, memo: "" },
    ] },
  ]);
  expect(s.groups.map((g) => g.rows.length)).toEqual([2, 1, 1]);
  const first = s.groups[0].rows[0].cells;
  expect(first[2]).toEqual({ text: "通信費", note: "課仕10%" });
  expect(first[4]).toEqual({ text: "普通預金", note: "B銀行" });
  expect(first[6]).toEqual({ text: "電話代", tag: "訂正あり", note: "A社" });
  expect(texts(s.groups[0].rows[1]).slice(0, 2)).toEqual(["", ""]);
  expect(s.groups[1].rows[0].kind).toBe("deleted");
  expect(texts(s.groups[2].rows[0])).toEqual(["合計", "10,000", "", "10,000", ""]);
});

test("試算表：区分ごとのまとまり", () => {
  const s = trialSection("貸借対照表", [
    { kind: "category", label: "資産", carried: 0, debit: 0, credit: 0, balance: 0 },
    { kind: "account", label: "現金", carried: 100, debit: 50, credit: 0, balance: 150 },
    { kind: "subtotal", label: "資産合計", carried: 100, debit: 50, credit: 0, balance: 150 },
    { kind: "category", label: "負債", carried: 0, debit: 0, credit: 0, balance: 0 },
    { kind: "subtotal", label: "負債合計", carried: 0, debit: 0, credit: 0, balance: 0 },
    { kind: "total", label: "所得金額", carried: 0, debit: 0, credit: 0, balance: 300, middle: "期間中 300" },
  ], "前期繰越", "12月末残高");
  expect(s.groups.map((g) => g.rows.length)).toEqual([3, 2, 1]);
  expect(texts(s.groups[1].rows[1])).toEqual(["負債合計", "0", "0", "0", "0"]);
  expect(texts(s.groups[2].rows[0])).toEqual(["所得金額", "0", "期間中 300", "300"]);
});

test("履歴の表：同じ記録の2行目からは記録の列を空ける", () => {
  const s = tableSection("仕訳", ["記録日時", "伝票No", "借貸", "金額"], [20, 8, 8, 12], [
    ["2025-01-01 10:00", 1, "借方", 1000],
    ["2025-01-01 10:00", 1, "貸方", 1000],
    ["2025-01-02 09:00", 2, "借方", 500],
  ], (r) => `${r[0]}|${r[1]}`, [2, 3]);
  expect(s.groups.map((g) => g.rows.map(texts))).toEqual([
    [["2025-01-01 10:00", "1", "借方", "1,000"], ["", "", "貸方", "1,000"]],
    [["2025-01-02 09:00", "2", "借方", "500"]],
  ]);
  expect(s.columns.map((c) => c.align)).toEqual([undefined, "right", undefined, "right"]);
});
