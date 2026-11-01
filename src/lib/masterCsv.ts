/**
 * 期首残高・勘定科目・補助科目・取引先の一覧の CSV（純粋関数）。ほかの会計ソフトからの乗り換えや、帳簿の間での写しに使う
 *  - 書き出したものをそのまま取り込める。列は見出しの名前で探す（順番は問わない）
 *  - 期首残高：科目・補助科目・金額（科目の残高の側をプラス）。名前で探し、無い科目・補助科目は問題として返す（先に一覧を取り込む）
 *  - 一覧：無い名前のものは足し、ある名前のものは書き換える（取引先のよみ・登録番号・法人番号・印・メモ、科目のよみ・税区分の初期値・決算書の欄、
 *    補助科目のよみ）。空欄・無い列は今のまま。名前は突き合わせに使うので変えない。科目の区分・コードも変えない。
 *    取り込む前に、追加・書き換え（前 → 後）・変わらない・問題を確かめの一覧に出す
 */
import type { Account, AccountCategory, Counterparty, SubAccount, SubOpeningBalances, TaxCode } from "./types";
import { subKey } from "./types";
import { parseCsv, unguardCell, type CsvValue } from "./csv";
import { normalizeCorporateNo, normalizeInvoiceNo, normName, validateCounterparty, type CounterpartyInput } from "./counterparty";
import { builtinTaxCode, taxCodeDef } from "./tax";
import { EXTRA_LINE, lineOptions, sectionOf } from "./statementLines";
import { TAX_CODES } from "../constants/tax";
import { parseAmount } from "./format";
import { BS_CATEGORIES, CATEGORY_LABEL, normalSideOf } from "../constants/accounts";

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
export const ACCOUNT_LIST_HEADER = ["コード", "科目", "よみ", "区分", "税区分の初期値", "決算書の欄"];
export const SUB_LIST_HEADER = ["科目", "補助科目", "よみ"];
export const COUNTERPARTY_LIST_HEADER = ["取引先", "よみ", "登録番号", "法人番号", "適格請求書発行事業者ではない", "メモ"];

/** 書き換えの1欄（確かめの一覧に出す。前 → 後） */
export interface ListChange {
  label: string;
  before: string;
  after: string;
}
/** 今あるものの書き換え（確かめの一覧で、行ごとに外せる） */
export interface ListUpdate<T> {
  row: number;
  name: string;
  id: number;
  changes: ListChange[];
  data: T;
}
/** 一覧の取り込みの計画：rows = 足すもの、updates = 書き換えるもの、skipped = 今あるもので変わらないもの */
export interface ListPlan<A, U> {
  rows: A[];
  updates: ListUpdate<U>[];
  skipped: number;
  issues: CsvIssue[];
}

/** 決算書の欄の表示（null = 自動） */
export const statementLineText = (line: string | null) => (line === null ? "自動" : line === EXTRA_LINE ? "追加の欄" : line);
/** 税区分の初期値（決まった初期値も含めた、今の値） */
const taxOfAccount = (a: Pick<Account, "code" | "category" | "default_tax_code">) => a.default_tax_code ?? builtinTaxCode(a);

export const accountListRows = (accounts: Account[]): CsvValue[][] =>
  accounts.map((a) => [a.code, a.name, a.kana, CATEGORY_LABEL[a.category], taxCodeDef(taxOfAccount(a)).label, sectionOf(a) ? statementLineText(a.statement_line ?? null) : ""]);
export const subListRows = (accounts: Account[], subs: SubAccount[]): CsvValue[][] =>
  subs.map((s) => [accounts.find((a) => a.id === s.account_id)?.name ?? "", s.name, s.kana]);
export const counterpartyListRows = (list: Counterparty[]): CsvValue[][] =>
  list.map((c) => [c.name, c.kana, c.invoice_no, c.corporate_no, c.not_registered ? "○" : "", c.memo]);

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

/** 税区分の名前（または記号）から。読めなければ null */
const taxCodeOf = (raw: string): TaxCode | null => {
  const n = normName(raw);
  return TAX_CODES.find((t) => normName(t.label) === n || normName(t.short) === n || t.code === raw.trim())?.code ?? null;
};
/** 決算書の欄（自動 = null）。その科目で選べなければ undefined */
const statementLineOf = (raw: string, a: Pick<Account, "category" | "normal_side">): string | null | undefined => {
  const n = normName(raw);
  if (n === normName("自動")) return null;
  const section = sectionOf(a);
  if (!section) return undefined;
  if (n === normName("追加の欄")) return lineOptions(section).some(([v]) => v === EXTRA_LINE) ? EXTRA_LINE : undefined;
  return lineOptions(section).find(([v, l]) => normName(v) === n || normName(l) === n)?.[0];
};

export interface AccountListRow {
  code: string | null;
  name: string;
  kana: string;
  category: AccountCategory;
  /** 税区分の初期値・決算書の欄（列に書いてあれば。決算書の欄の null = 自動） */
  taxCode?: TaxCode;
  statementLine?: string | null;
}
/** 科目の書き換え（変わるものだけ） */
export interface AccountListUpdate {
  kana?: string;
  taxCode?: TaxCode;
  statementLine?: string | null;
}

/**
 * 科目の一覧：無い名前の科目は足し、ある名前の科目はよみ・税区分の初期値・決算書の欄を書き換える。
 * lineLocked = 表示中の年を締めている（決算書の欄は表示中の年から変わるので、締めた年は変えられない）
 */
export const parseAccountListCsv = (text: string, accounts: Account[], lineLocked = false): ListPlan<AccountListRow, AccountListUpdate> => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cCode = colOf("コード", "科目コード");
  const cName = colOf("科目", "勘定科目", "科目名");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  const cCat = colOf("区分", "科目区分", "大分類");
  const cTax = colOf("税区分の初期値", "税区分");
  const cLine = colOf("決算書の欄");
  const empty = (issues: CsvIssue[]) => ({ rows: [], updates: [], skipped: 0, issues });
  if (headerAt < 0) return empty([{ row: 1, message: "中身がありません" }]);
  if (cName < 0 || cCat < 0) return empty([{ row: headerAt + 1, message: "見出しに「科目」と「区分」の列が要ります（コード・よみ・税区分の初期値・決算書の欄は任意）" }]);
  const out: ListPlan<AccountListRow, AccountListUpdate> = { rows: [], updates: [], skipped: 0, issues: [] };
  const seen = new Set<string>();
  for (const { line, cells } of lines) {
    const name = cell(cells, cName);
    if (!name || seen.has(normName(name))) continue;
    seen.add(normName(name));
    const current = accounts.find((a) => normName(a.name) === normName(name));
    const category = current?.category ?? categoryOf(cell(cells, cCat));
    if (!category) {
      out.issues.push({ row: line, message: `区分「${cell(cells, cCat)}」が読めません（資産・負債・資本・収益・売上原価・経費・専従者給与等）` });
      continue;
    }
    const taxRaw = cell(cells, cTax);
    const taxCode = taxRaw ? taxCodeOf(taxRaw) : undefined;
    if (taxCode === null) {
      out.issues.push({ row: line, message: `税区分「${taxRaw}」が読めません（例：課税仕入 10%・対象外）` });
      continue;
    }
    const lineRaw = cell(cells, cLine);
    const shape = current ?? { category, normal_side: normalSideOf(category) };
    const statementLine = lineRaw ? statementLineOf(lineRaw, shape) : undefined;
    if (lineRaw && statementLine === undefined) {
      out.issues.push({ row: line, message: `決算書の欄「${lineRaw}」は、この科目では選べません（自動・追加の欄か、勘定科目の画面で選べる欄の名前）` });
      continue;
    }
    if (!current) {
      out.rows.push({ code: cell(cells, cCode) || null, name, kana: cell(cells, cKana), category, ...(taxCode ? { taxCode } : {}), ...(lineRaw ? { statementLine } : {}) });
      continue;
    }
    const data: AccountListUpdate = {};
    const changes: ListChange[] = [];
    const kana = cell(cells, cKana);
    if (kana && kana !== current.kana) {
      data.kana = kana;
      changes.push({ label: "よみ", before: current.kana, after: kana });
    }
    if (taxCode && taxCode !== taxOfAccount(current)) {
      data.taxCode = taxCode;
      changes.push({ label: "税区分の初期値", before: taxCodeDef(taxOfAccount(current)).label, after: taxCodeDef(taxCode).label });
    }
    if (lineRaw && statementLine !== undefined && statementLine !== (current.statement_line ?? null)) {
      if (lineLocked) {
        out.issues.push({ row: line, message: `「${name}」：表示中の年を締めているので、決算書の欄は変えられません` });
        continue;
      }
      data.statementLine = statementLine;
      changes.push({ label: "決算書の欄", before: statementLineText(current.statement_line ?? null), after: statementLineText(statementLine) });
    }
    if (changes.length) out.updates.push({ row: line, name, id: current.id, changes, data });
    else out.skipped++;
  }
  return out;
};

/** 補助科目の一覧：無い名前の補助科目は足し、ある名前の補助科目はよみを書き換える */
export const parseSubListCsv = (
  text: string, accounts: Account[], subs: SubAccount[],
): ListPlan<{ accountId: number; name: string; kana: string }, { kana: string }> => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cAcc = colOf("科目", "勘定科目", "科目名");
  const cName = colOf("補助科目", "補助", "補助科目名");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  const empty = (issues: CsvIssue[]) => ({ rows: [], updates: [], skipped: 0, issues });
  if (headerAt < 0) return empty([{ row: 1, message: "中身がありません" }]);
  if (cAcc < 0 || cName < 0) return empty([{ row: headerAt + 1, message: "見出しに「科目」と「補助科目」の列が要ります（よみは任意）" }]);
  const out: ListPlan<{ accountId: number; name: string; kana: string }, { kana: string }> = { rows: [], updates: [], skipped: 0, issues: [] };
  const seen = new Set<string>();
  for (const { line, cells } of lines) {
    const name = cell(cells, cName);
    if (!name) continue;
    const a = accounts.find((x) => normName(x.name) === normName(cell(cells, cAcc)));
    if (!a) {
      out.issues.push({ row: line, message: `科目「${cell(cells, cAcc)}」が勘定科目にありません（先に科目の一覧を取り込んでください）` });
      continue;
    }
    const k = `${a.id}:${normName(name)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const current = subs.find((s) => s.account_id === a.id && normName(s.name) === normName(name));
    const kana = cell(cells, cKana);
    if (!current) out.rows.push({ accountId: a.id, name, kana });
    else if (kana && kana !== current.kana) {
      out.updates.push({ row: line, name: `${a.name}／${current.name}`, id: current.id, changes: [{ label: "よみ", before: current.kana, after: kana }], data: { kana } });
    } else out.skipped++;
  }
  return out;
};

/** 「適格請求書発行事業者ではない」の欄（空 = 今のまま） */
const notRegisteredOf = (raw: string): boolean | undefined => (raw ? !/^(0|×|いいえ|false|no)$/i.test(raw) : undefined);

/** 取引先の一覧：無い名前の取引先は足し、ある名前の取引先はよみ・登録番号・法人番号・印・メモを書き換える（空欄は今のまま） */
export const parseCounterpartyCsv = (text: string, list: Counterparty[]): ListPlan<CounterpartyInput, CounterpartyInput> => {
  const { headerAt, colOf, rows: lines } = readTable(text);
  const cName = colOf("取引先", "取引先名", "名称", "名前");
  const cKana = colOf("よみ", "読み", "フリガナ", "カナ");
  const cNo = colOf("登録番号", "インボイス登録番号", "適格請求書発行事業者登録番号");
  const cCorp = colOf("法人番号");
  const cNot = colOf("適格請求書発行事業者ではない");
  const cMemo = colOf("メモ", "備考");
  const empty = (issues: CsvIssue[]) => ({ rows: [], updates: [], skipped: 0, issues });
  if (headerAt < 0) return empty([{ row: 1, message: "中身がありません" }]);
  if (cName < 0) return empty([{ row: headerAt + 1, message: "見出しに「取引先」の列が要ります（よみ・登録番号・法人番号・メモは任意）" }]);
  const out: ListPlan<CounterpartyInput, CounterpartyInput> = { rows: [], updates: [], skipped: 0, issues: [] };
  const seen = new Set<string>();
  for (const { line, cells } of lines) {
    const name = cell(cells, cName);
    if (!name || seen.has(normName(name))) continue;
    seen.add(normName(name));
    const current = list.find((c) => normName(c.name) === normName(name));
    const not = notRegisteredOf(cell(cells, cNot));
    if (!current) {
      const input = { name, kana: cell(cells, cKana), invoice_no: cell(cells, cNo), corporate_no: cell(cells, cCorp), not_registered: !!not, memo: cell(cells, cMemo) };
      const p = validateCounterparty(list, input);
      if (p) out.issues.push({ row: line, message: `「${name}」：${p}` });
      else out.rows.push(input);
      continue;
    }
    const pick = (i: number, now: string, norm: (v: string) => string = (v) => v) => (cell(cells, i) ? norm(cell(cells, i)) : now);
    const input: CounterpartyInput = {
      name: current.name, kana: pick(cKana, current.kana), invoice_no: pick(cNo, current.invoice_no, normalizeInvoiceNo),
      corporate_no: pick(cCorp, current.corporate_no, normalizeCorporateNo), not_registered: not ?? !!current.not_registered, memo: pick(cMemo, current.memo),
    };
    // 登録番号を入れた取引先は「適格請求書発行事業者ではない」にしない（今の印は外す）
    if (input.invoice_no) input.not_registered = false;
    const p = validateCounterparty(list, input, current.id);
    if (p) {
      out.issues.push({ row: line, message: `「${name}」：${p}` });
      continue;
    }
    const yes = (b: boolean) => (b ? "○" : "");
    const changes: ListChange[] = [
      ...(input.kana !== current.kana ? [{ label: "よみ", before: current.kana, after: input.kana }] : []),
      ...(input.invoice_no !== current.invoice_no ? [{ label: "登録番号", before: current.invoice_no, after: input.invoice_no }] : []),
      ...(input.corporate_no !== current.corporate_no ? [{ label: "法人番号", before: current.corporate_no, after: input.corporate_no ?? "" }] : []),
      ...(!!input.not_registered !== !!current.not_registered ? [{ label: "適格請求書発行事業者ではない", before: yes(!!current.not_registered), after: yes(!!input.not_registered) }] : []),
      ...(input.memo !== current.memo ? [{ label: "メモ", before: current.memo, after: input.memo }] : []),
    ];
    if (changes.length) out.updates.push({ row: line, name: current.name, id: current.id, changes, data: input });
    else out.skipped++;
  }
  return out;
};
