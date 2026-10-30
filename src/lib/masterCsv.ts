/**
 * 期首残高・勘定科目・補助科目・取引先の一覧の CSV（純粋関数）。ほかの会計ソフトからの乗り換えや、帳簿の間での写しに使う
 *  - 書き出したものをそのまま取り込める。列は見出しの名前で探す（順番は問わない）
 *  - 期首残高：科目・補助科目・金額（科目の残高の側をプラス）。名前で探し、無い科目・補助科目は問題として返す（先に一覧を取り込む）
 *  - 一覧：無い名前のものだけ足す（ある名前は飛ばす。名前を変えたり消したりはしない）
 */
import type { Account, AccountCategory, Counterparty, SubAccount, SubOpeningBalances } from "./types";
import { subKey } from "./types";
import { parseCsv, unguardCell, type CsvValue } from "./csv";
import { normName, type CounterpartyInput } from "./counterparty";
import { parseAmount } from "./format";
import { BS_CATEGORIES, CATEGORY_LABEL } from "../constants/accounts";

export interface CsvIssue {
  row: number;
  message: string;
}

/** 見出しの行（最初の空でない行）と、名前 → 列の番号 */
const readTable = (text: string) => {
  const table = parseCsv(text);
  const headerAt = table.findIndex((r) => r.some((c) => c.trim() !== ""));
  const header = headerAt < 0 ? [] : table[headerAt].map((h) => normName(h));
  const colOf = (...names: string[]) => header.findIndex((h) => names.some((n) => normName(n) === h));
  const rows = headerAt < 0 ? [] : table.slice(headerAt + 1).map((cells, i) => ({ line: headerAt + i + 2, cells })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  return { headerAt, colOf, rows };
};
const cell = (cells: string[], i: number) => (i >= 0 ? unguardCell(cells[i] ?? "").trim() : "");

// ────────────────────────────────────────────
// 期首残高
// ────────────────────────────────────────────
export const OPENING_HEADER = ["区分", "科目", "補助科目", "金額"];

/** 期首残高の CSV の行（貸借対照表の科目。金額のあるものだけ） */
export const openingCsvRows = (accounts: Account[], subs: SubAccount[], values: SubOpeningBalances): CsvValue[][] =>
  accounts.filter((a) => BS_CATEGORIES.includes(a.category)).flatMap((a) =>
    [null, ...subs.filter((s) => s.account_id === a.id).map((s) => s.id)]
      .filter((sid) => (values[subKey(a.id, sid)] ?? 0) !== 0)
      .map((sid) => [CATEGORY_LABEL[a.category], a.name, sid ? subs.find((s) => s.id === sid)?.name ?? "" : "", values[subKey(a.id, sid)]]),
  );

/** 期首残高の CSV を読む（同じ科目・補助科目の行は足す） */
export const parseOpeningCsv = (text: string, accounts: Account[], subs: SubAccount[]): { values: SubOpeningBalances; issues: CsvIssue[] } => {
  const { headerAt, colOf, rows } = readTable(text);
  const cAcc = colOf("科目", "勘定科目", "科目名");
  const cSub = colOf("補助科目", "補助", "補助科目名");
  const cAmt = colOf("金額", "期首残高", "残高", "開始残高");
  if (headerAt < 0) return { values: {}, issues: [{ row: 1, message: "中身がありません" }] };
  if (cAcc < 0 || cAmt < 0) return { values: {}, issues: [{ row: headerAt + 1, message: "見出しに「科目」と「金額」の列が要ります（補助科目は任意）" }] };
  const values: SubOpeningBalances = {};
  const issues: CsvIssue[] = [];
  for (const { line, cells } of rows) {
    const name = cell(cells, cAcc);
    const subName = cell(cells, cSub);
    const raw = cell(cells, cAmt);
    const amount = raw ? parseAmount(raw.replace(/^▲|^△/, "-")) : 0;
    if (amount === null) {
      issues.push({ row: line, message: `金額「${raw}」が読めません` });
      continue;
    }
    if (!amount) continue;
    const a = accounts.find((x) => normName(x.name) === normName(name));
    if (!a) {
      issues.push({ row: line, message: `科目「${name}」が勘定科目にありません（先に科目の一覧を取り込むか、勘定科目の画面で足してください）` });
      continue;
    }
    if (!BS_CATEGORIES.includes(a.category)) {
      issues.push({ row: line, message: `「${a.name}」は損益の科目なので、期首残高はありません` });
      continue;
    }
    let sid: number | null = null;
    if (subName) {
      const s = subs.find((x) => x.account_id === a.id && normName(x.name) === normName(subName));
      if (!s) {
        issues.push({ row: line, message: `補助科目「${subName}」が「${a.name}」にありません（先に補助科目の一覧を取り込むか、勘定科目の画面で足してください）` });
        continue;
      }
      sid = s.id;
    }
    const k = subKey(a.id, sid);
    values[k] = (values[k] ?? 0) + amount;
  }
  return { values, issues };
};

// ────────────────────────────────────────────
// 勘定科目・補助科目・取引先の一覧
// ────────────────────────────────────────────
export const ACCOUNT_LIST_HEADER = ["コード", "科目", "よみ", "区分"];
export const SUB_LIST_HEADER = ["科目", "補助科目", "よみ"];
export const COUNTERPARTY_LIST_HEADER = ["取引先", "よみ", "登録番号", "適格請求書発行事業者ではない", "メモ"];

export const accountListRows = (accounts: Account[]): CsvValue[][] => accounts.map((a) => [a.code, a.name, a.kana, CATEGORY_LABEL[a.category]]);
export const subListRows = (accounts: Account[], subs: SubAccount[]): CsvValue[][] =>
  subs.map((s) => [accounts.find((a) => a.id === s.account_id)?.name ?? "", s.name, s.kana]);
export const counterpartyListRows = (list: Counterparty[]): CsvValue[][] =>
  list.map((c) => [c.name, c.kana, c.invoice_no, c.not_registered ? "○" : "", c.memo]);

const categoryOf = (raw: string): AccountCategory | null => {
  const n = normName(raw);
  const hit = (Object.entries(CATEGORY_LABEL) as [AccountCategory, string][]).find(([k, l]) => normName(l) === n || k === raw.trim());
  if (hit) return hit[0];
  // 言い換え（ほかの会計ソフトの区分の名前）
  if (/^(流動資産|固定資産|繰延資産)/.test(n)) return "asset";
  if (/^(流動負債|固定負債)/.test(n)) return "liability";
  if (/^(純資産|資本|元入金)/.test(n)) return "equity";
  if (/^(売上|収入|営業外収益)/.test(n)) return "revenue";
  if (/^(製造原価|仕入)/.test(n)) return "cogs";
  if (/^(販売費|一般管理費|販管費|経費|営業外費用)/.test(n)) return "expense";
  return null;
};

export interface AccountListRow {
  code: string | null;
  name: string;
  kana: string;
  category: AccountCategory;
}

/** 科目の一覧：無い名前の科目だけ（skipped = すでにある名前） */
export const parseAccountListCsv = (text: string, accounts: Account[]): { rows: AccountListRow[]; skipped: number; issues: CsvIssue[] } => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cCode = colOf("コード", "科目コード");
  const cName = colOf("科目", "勘定科目", "科目名");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  const cCat = colOf("区分", "科目区分", "大分類");
  if (headerAt < 0) return { rows: [], skipped: 0, issues: [{ row: 1, message: "中身がありません" }] };
  if (cName < 0 || cCat < 0) return { rows: [], skipped: 0, issues: [{ row: headerAt + 1, message: "見出しに「科目」と「区分」の列が要ります（コード・よみは任意）" }] };
  const rows: AccountListRow[] = [];
  const issues: CsvIssue[] = [];
  let skipped = 0;
  const known = new Set(accounts.map((a) => normName(a.name)));
  for (const { line, cells } of lines) {
    const name = cell(cells, cName);
    if (!name) continue;
    if (known.has(normName(name))) {
      skipped++;
      continue;
    }
    const category = categoryOf(cell(cells, cCat));
    if (!category) {
      issues.push({ row: line, message: `区分「${cell(cells, cCat)}」が読めません（資産・負債・資本・収益・売上原価・経費・専従者給与等）` });
      continue;
    }
    known.add(normName(name));
    rows.push({ code: cell(cells, cCode) || null, name, kana: cell(cells, cKana), category });
  }
  return { rows, skipped, issues };
};

/** 補助科目の一覧：無い名前の補助科目だけ */
export const parseSubListCsv = (
  text: string, accounts: Account[], subs: SubAccount[],
): { rows: { accountId: number; name: string; kana: string }[]; skipped: number; issues: CsvIssue[] } => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cAcc = colOf("科目", "勘定科目", "科目名");
  const cName = colOf("補助科目", "補助", "補助科目名");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  if (headerAt < 0) return { rows: [], skipped: 0, issues: [{ row: 1, message: "中身がありません" }] };
  if (cAcc < 0 || cName < 0) return { rows: [], skipped: 0, issues: [{ row: headerAt + 1, message: "見出しに「科目」と「補助科目」の列が要ります（よみは任意）" }] };
  const rows: { accountId: number; name: string; kana: string }[] = [];
  const issues: CsvIssue[] = [];
  let skipped = 0;
  const known = new Set(subs.map((s) => `${s.account_id}:${normName(s.name)}`));
  for (const { line, cells } of lines) {
    const name = cell(cells, cName);
    if (!name) continue;
    const a = accounts.find((x) => normName(x.name) === normName(cell(cells, cAcc)));
    if (!a) {
      issues.push({ row: line, message: `科目「${cell(cells, cAcc)}」が勘定科目にありません（先に科目の一覧を取り込んでください）` });
      continue;
    }
    const k = `${a.id}:${normName(name)}`;
    if (known.has(k)) {
      skipped++;
      continue;
    }
    known.add(k);
    rows.push({ accountId: a.id, name, kana: cell(cells, cKana) });
  }
  return { rows, skipped, issues };
};

/** 取引先の一覧：無い名前の取引先だけ */
export const parseCounterpartyCsv = (text: string, list: Counterparty[]): { rows: CounterpartyInput[]; skipped: number; issues: CsvIssue[] } => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cName = colOf("取引先", "取引先名", "名称", "名前");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  const cNo = colOf("登録番号", "インボイス登録番号", "適格請求書発行事業者登録番号");
  const cNot = colOf("適格請求書発行事業者ではない");
  const cMemo = colOf("メモ", "備考");
  if (headerAt < 0) return { rows: [], skipped: 0, issues: [{ row: 1, message: "中身がありません" }] };
  if (cName < 0) return { rows: [], skipped: 0, issues: [{ row: headerAt + 1, message: "見出しに「取引先」の列が要ります（よみ・登録番号・メモは任意）" }] };
  const rows: CounterpartyInput[] = [];
  let skipped = 0;
  const known = new Set(list.map((c) => normName(c.name)));
  for (const { cells } of lines) {
    const name = cell(cells, cName);
    if (!name) continue;
    if (known.has(normName(name))) {
      skipped++;
      continue;
    }
    known.add(normName(name));
    const not = cell(cells, cNot);
    rows.push({ name, kana: cell(cells, cKana), invoice_no: cell(cells, cNo), not_registered: !!not && !/^(0|×|いいえ|false)$/i.test(not), memo: cell(cells, cMemo) });
  }
  return { rows, skipped, issues: [] };
};
