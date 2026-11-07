/**
 * 一年分の続け通し（分野 F）の共通部品
 *  - DB は src/db/repo.test.ts の makeDb と同じ作り方で、bun:sqlite のメモリ上に作る（settings の fiscal_year は 2025）
 *  - 画面がしていること（帳簿入力の家事按分・振替伝票・固定資産台帳の年末の仕訳・家事按分の年末の振替・決算書の集計・
 *    消費税の申告書・所得税の申告書）を、画面のコードと同じ関数の呼び方でまねる
 *  - リポジトリは変更しない（読むだけ）
 */
import { Database as Sqlite } from "bun:sqlite";
const ROOT = new URL("../../../src", import.meta.url).pathname;
import type Database from "../../../src/db/connection";
import { COLUMN_MIGRATIONS, SCHEMA, SEED_ACCOUNT_SQL } from "../../../src/db/schema";
import { ACCOUNT_SEEDS, CODE } from "../../../src/constants/accounts";
import * as repo from "../../../src/db/repo";
import type { Account, HomeUseRate, JournalLine, TaxCode, InvoiceKind, PurchaseUse } from "../../../src/lib/types";
import { buildTrialBalance, closingBalances, summarizeIncome, summarizeBalanceSheet, yearEnd, yearStart, rowsToLines, emptyRow } from "../../../src/lib/accounting";
import { splitByRate, entryRateOf, splitLinesByHomeUse, yearEndRows, privateTaxSplit } from "../../../src/lib/homeUse";
import { depreciationLines, depreciationFor } from "../../../src/lib/depreciation";
import { statementLayout } from "../../../src/lib/statementLines";
import { monthlySales, payeeBreakdown } from "../../../src/lib/statements";
import { blueDeductionLimit, computeIncomeTax, type BusinessFigures, type IncomeTaxInput } from "../../../src/lib/incomeTax";
import { buildTaxBase, computeReturn, methodsFor, type ReturnMethod } from "../../../src/lib/taxReturn";
import { baseSalesInfo, methodProblem } from "../../../src/lib/baseSales";
import { prevTaxInfo, interimPlan } from "../../../src/lib/taxInterim";
import { buildTaxSummary, taxChecks } from "../../../src/lib/taxSummary";
import { taxYearOf } from "../../../src/lib/tax";
import { buildTaxXtx, xtxProblem } from "../../../src/lib/taxXtx";
import { buildBlueStatement } from "../../../src/lib/blueStatement";
import { buildIncomeTaxXtx, incomeXtxProblems } from "../../../src/lib/incomeTaxXtx";
import { ETAX_FIELDS, filerFromSettings } from "../../../src/lib/etax";
import { isYearCompliant } from "../../../src/lib/ebook";
export { ROOT };

export const YEAR = 2025;

export const makeDb = (mode: "strict" | "standard" = "strict", year = YEAR) => {
  const raw = new Sqlite(":memory:");
  raw.run("PRAGMA foreign_keys = ON");
  const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
  for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s);
  for (const [t, c, d] of COLUMN_MIGRATIONS) {
    const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
    if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  }
  for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
  raw.run("INSERT INTO settings (id, fiscal_year, e_book_mode, business_name) VALUES (1, ?, ?, 'テスト')", [year, mode]);
  // src/db/repo.test.ts の makeDb と同じ（所得の区分・非表示も入れる）
  ACCOUNT_SEEDS.forEach((a, i) => raw.run(SEED_ACCOUNT_SQL, [a.code, a.name, a.kana, a.category, a.normal_side, i, a.income_kind ?? "business", a.hidden ? 0 : 1]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (params?: unknown[]) => (params ?? []) as any[];
  const db = {
    select: async (sql: string, params?: unknown[]) => raw.query(sql).all(...p(params)),
    execute: async (sql: string, params?: unknown[]) => {
      const r = raw.query(sql).run(...p(params));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  } as unknown as Database;
  repo.setActor(null);
  return { db, raw };
};

/** 科目・補助科目・取引先を名前で引く */
export const makeBook = async (db: Database) => {
  let accounts = await repo.getAccounts(db, YEAR);
  const reload = async () => { accounts = await repo.getAccounts(db, YEAR); };
  const acc = (name: string) => {
    const a = accounts.find((x) => x.name === name);
    if (!a) throw new Error(`科目がありません：${name}`);
    return a.id;
  };
  const sub = async (accountName: string, name: string) => {
    const aid = acc(accountName);
    let s = (await repo.getSubAccounts(db, YEAR)).find((x) => x.account_id === aid && x.name === name);
    if (!s) {
      await repo.createSub(db, aid, name);
      s = (await repo.getSubAccounts(db, YEAR)).find((x) => x.account_id === aid && x.name === name)!;
    }
    return s.id;
  };
  const cp = async (name: string, invoice_no = "", not_registered = false) => {
    const c = (await repo.getCounterparties(db)).find((x) => x.name === name);
    if (c) return c.id;
    return repo.createCounterparty(db, { name, kana: "", invoice_no, not_registered, memo: "" }) as Promise<number>;
  };
  return { get accounts() { return accounts; }, reload, acc, sub, cp };
};
export type Book = Awaited<ReturnType<typeof makeBook>>;

export interface TaxOpt { tax?: TaxCode; invoice?: InvoiceKind; cls?: number; use?: PurchaseUse }
const taxFields = (t: TaxOpt = {}) => ({
  ...(t.tax ? { tax_code: t.tax } : {}), ...(t.invoice ? { invoice_kind: t.invoice } : {}),
  ...(t.cls ? { business_class: t.cls } : {}), ...(t.use ? { purchase_use: t.use } : {}),
});

/**
 * 帳簿入力（CashBookPage.save と同じ組み立て）。book = 帳簿の科目（現金・普通預金など）、counter = 相手科目
 * dir = in（入金：帳簿の科目が借方）／ out（出金：帳簿の科目が貸方）。家事按分（入力のたびに）は出金で相手が経費のとき
 */
export const cashEntry = async (
  db: Database, b: Book, rates: HomeUseRate[],
  o: { date: string; book: string; bookSub?: number | null; counter: string; counterSub?: number | null; dir: "in" | "out"; amount: number; memo: string; cp?: number | null; adjustment?: boolean } & TaxOpt,
) => {
  const accountId = b.acc(o.book), counterId = b.acc(o.counter);
  const isDebit = o.dir === "in";
  const tax = taxFields(o);
  const lines: JournalLine[] = [
    { row_no: 1, side: "debit", account_id: isDebit ? accountId : counterId, sub_account_id: isDebit ? o.bookSub ?? null : o.counterSub ?? null, amount: o.amount, memo: o.memo, ...(isDebit ? {} : tax) },
    { row_no: 1, side: "credit", account_id: isDebit ? counterId : accountId, sub_account_id: isDebit ? o.counterSub ?? null : o.bookSub ?? null, amount: o.amount, memo: o.memo, ...(isDebit ? tax : {}) },
  ];
  const hu = rates.find((r) => r.account_id === counterId && r.rate < 100);
  const counterAcc = b.accounts.find((a) => a.id === counterId)!;
  if (hu && hu.method === "entry" && !isDebit && counterAcc.category === "expense") {
    const split = splitByRate(o.amount, hu.rate);
    lines[0] = { ...lines[0], amount: split.business };
    lines.push({ row_no: 2, side: "debit", account_id: b.acc("事業主貸"), sub_account_id: null, amount: split.private, memo: o.memo ? `${o.memo}（家事分）` : "家事分" });
  }
  return repo.createEntry(db, o.adjustment ? yearEnd(YEAR) : o.date, lines, o.cp ?? null, "", !!o.adjustment);
};

/** 振替伝票（VoucherForm と同じ：rowsToLines → 入力のたびの家事按分 → createEntry） */
export interface VRow { dr?: string; drSub?: number | null; drAmt?: number; drTax?: TaxOpt; cr?: string; crSub?: number | null; crAmt?: number; crTax?: TaxOpt; memo?: string }
export const voucher = async (db: Database, b: Book, rates: HomeUseRate[], date: string, rows: VRow[], o: { cp?: number | null; adjustment?: boolean } = {}) => {
  const vrows = rows.map((r) => ({
    ...emptyRow(),
    debitAccountId: r.dr ? b.acc(r.dr) : null, debitSubId: r.drSub ?? null, debitAmount: r.drAmt ?? null,
    creditAccountId: r.cr ? b.acc(r.cr) : null, creditSubId: r.crSub ?? null, creditAmount: r.crAmt ?? null,
    memo: r.memo ?? "",
    debitTax: r.drTax?.tax ?? null, debitInvoice: r.drTax?.invoice ?? null, debitClass: r.drTax?.cls ?? null, debitUse: r.drTax?.use ?? null,
    creditTax: r.crTax?.tax ?? null, creditInvoice: r.crTax?.invoice ?? null, creditClass: r.crTax?.cls ?? null, creditUse: r.crTax?.use ?? null,
  }));
  const drawId = b.acc("事業主貸");
  const lines = splitLinesByHomeUse(rowsToLines(vrows), entryRateOf(rates, b.accounts), drawId).lines;
  return repo.createEntry(db, date, lines, o.cp ?? null, "", !!o.adjustment);
};

/** 固定資産台帳の「年末の仕訳を作る」（FixedAssetsPage と同じ） */
export const runDepreciation = async (db: Database, b: Book) => {
  const assets = await repo.getAssets(db);
  const lines = depreciationLines(assets, YEAR, { expense: b.acc("減価償却費"), draw: b.acc("事業主貸") });
  return repo.saveDepreciationRun(db, YEAR, lines);
};

/** 家事按分の「年末の振替」（HomeUsePage.runYearEnd と同じ） */
export const runHomeUseYearEnd = async (db: Database, b: Book) => {
  const rates = await repo.getHomeUseRates(db, YEAR);
  const lines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
  const runId = await repo.getHomeUseRun(db, YEAR);
  const depRunId = await repo.getDepreciationRun(db, YEAR);
  const exclude = [runId, depRunId].filter((x): x is number => x !== null);
  const rows = yearEndRows(b.accounts, lines, rates, exclude);
  const targets = rows.filter((r) => r.private > 0);
  if (!targets.length) return null;
  const privateTotal = rows.reduce((s, r) => s + r.private, 0);
  const memo = "家事按分（年末振替）";
  const credits = targets.flatMap((r) =>
    privateTaxSplit(r.account, lines, r.private, exclude).map((p) => ({
      side: "credit" as const, account_id: r.account.id, sub_account_id: null, amount: p.amount,
      memo: `${memo} ${r.account.name} 家事分 ${100 - r.rate.rate}%`,
      ...(p.tax_code ? { tax_code: p.tax_code } : {}), ...(p.invoice_kind ? { invoice_kind: p.invoice_kind } : {}),
      ...(p.purchase_use ? { purchase_use: p.purchase_use } : {}),
    })),
  );
  const jl: JournalLine[] = [
    { row_no: 1, side: "debit", account_id: b.acc("事業主貸"), sub_account_id: null, amount: privateTotal, memo },
    ...credits.map((c, i) => ({ ...c, row_no: i + 1 })),
  ];
  await repo.saveHomeUseRunEntry(db, YEAR, yearEnd(YEAR), jl, runId ?? null);
  return { rows, privateTotal };
};

/** 年度の帳簿の数字（試算表・決算書・申告書）をまとめて出す */
export const yearFigures = async (db: Database, b: Book) => {
  await b.reload();
  const accounts = b.accounts;
  const lines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
  const opening = (await repo.getOpening(db, YEAR)).byAccount;
  const tb = buildTrialBalance(accounts, opening, lines, 1, 13);
  const end = closingBalances(accounts, opening, lines);
  const pl = summarizeIncome(accounts, end);
  const bs = summarizeBalanceSheet(accounts, end);
  const settings = await repo.getSettings(db);
  const limit = blueDeductionLimit(settings.filing_type, YEAR);
  const blue = Math.min(limit, Math.max(0, pl.income));
  const layout = statementLayout(accounts, (a) => end.get(a.id) ?? 0, (a) => opening[a.id] ?? 0);
  const monthly = monthlySales(accounts, lines);
  const runIds = [await repo.getHomeUseRun(db, YEAR), await repo.getDepreciationRun(db, YEAR)].filter((x): x is number => x !== null);
  const rates = await repo.getHomeUseRates(db, YEAR);
  const drawId = b.acc("事業主貸");
  const payee = (name: string) => {
    const id = b.acc(name);
    const rate = rates.find((r) => r.account_id === id && r.method === "yearend");
    return payeeBreakdown(id, lines, { drawId, yearEndRate: rate?.rate ?? null, excludeEntryIds: runIds });
  };
  const assets = await repo.getAssets(db);
  const deps = assets.map((a) => ({ a, d: depreciationFor(a, YEAR) })).filter((x) => x.d && !(x.d.opening === 0 && x.d.depreciation === 0));
  const bal = (name: string) => end.get(b.acc(name)) ?? 0;
  const tbRow = (name: string) => tb.find((r) => r.account.name === name)!;
  return { accounts, lines, opening, tb, end, pl, bs, blue, layout, monthly, payee, deps, bal, tbRow, settings };
};

/** 消費税の申告書（TaxReturnView と同じ：buildTaxBase → computeReturn） */
export const taxReturnOf = async (db: Database, b: Book, method?: ReturnMethod) => {
  await b.reload();
  const lines = await repo.getLines(db, yearStart(YEAR), yearEnd(YEAR));
  const taxYears = await repo.getTaxYears(db);
  const ty = taxYearOf(taxYears, YEAR);
  const interim = await repo.getTaxInterim(db, YEAR);
  const baseLines = await repo.getLines(db, yearStart(YEAR - 2), yearEnd(YEAR - 2));
  const prevLines = await repo.getLines(db, yearStart(YEAR - 1), yearEnd(YEAR - 1));
  const manual = await repo.getTaxBaseManual(db, YEAR);
  const bsInfo = baseSalesInfo({ year: YEAR, baseLines, prevLines, accounts: b.accounts, taxYears, manual });
  const base = buildTaxBase(lines, taxYears);
  const options = { businessClass: ty.business_class, interimNational: interim.national, interimLocal: interim.local, baseSales: bsInfo.base ?? null, deduction: ty.deduction };
  const m = method ?? (ty.status as ReturnMethod);
  const r = computeReturn(m, base, options);
  const all = methodsFor(YEAR).map((x) => ({ m: x, total: computeReturn(x, base, options).total, problem: methodProblem(x, bsInfo) }));
  const prevManual = await repo.getTaxPrevManual(db, YEAR);
  const holidays = new Set((await repo.getHolidayData(db)).holidays.map((h) => h.date));
  const prev = prevTaxInfo({ year: YEAR, prevLines, taxYears, manual: prevManual });
  const plan = interimPlan({ year: YEAR, prevTax: prev.amount, exempt: ty.status === "exempt", voluntary: !!ty.voluntary_interim, holidays });
  const counterparties = await repo.getCounterparties(db);
  const settings = await repo.getSettings(db);
  const summary = buildTaxSummary(lines, b.accounts, taxYears);
  const issues = taxChecks({ year: YEAR, lines, accounts: b.accounts, counterparties, taxYears, invoiceNo: settings.invoice_no, registeredOn: settings.invoice_registered_on, summary, baseSales: bsInfo, interim: { plan, entered: interim } });
  const row = (formId: string, no: string) => r.forms.find((f) => f.id === formId)?.rows.find((x) => x.no === no);
  return { r, base, all, plan, prev, issues, bsInfo, row, xtx: xtxProblem(r, YEAR) };
};

/** 所得税（IncomeTaxPage と同じ：帳簿から BusinessFigures → computeIncomeTax） */
export const incomeTaxOf = async (db: Database, b: Book, input: IncomeTaxInput) => {
  const f = await yearFigures(db, b);
  const family = f.accounts.find((a) => a.code === CODE.FAMILY_SALARY);
  const biz: BusinessFigures = { revenue: f.pl.revenue, incomeBeforeBlue: f.pl.income, filingType: f.settings.filing_type, familySalary: family ? f.end.get(family.id) ?? 0 : 0 };
  const r = computeIncomeTax(input, biz, YEAR);
  const v = (no: string) => r.rows.find((x) => x.no === no)?.value ?? null;
  return { r, v, biz };
};

/**
 * 所得税の e-Tax のデータ（IncomeTaxPage の書き出しと同じ：buildBlueStatement → buildIncomeTaxXtx）
 * xmllint で手続 RKO0010 の XSD に照らした結果（合っていれば ""）も返す
 */
export const incomeXtxOf = async (db: Database, b: Book, input: IncomeTaxInput, numbers: Record<string, string> = {}) => {
  const it = await incomeTaxOf(db, b, input);
  const f = await yearFigures(db, b);
  const notes = await repo.getStatementNotes(db, YEAR);
  const subs = await repo.getSubAccounts(db, YEAR);
  const cps = await repo.getCounterparties(db);
  const statement = buildBlueStatement({
    year: YEAR, accounts: f.accounts, opening: f.opening, lines: f.lines, notes, assets: await repo.getAssets(db),
    homeUseRates: await repo.getHomeUseRates(db, YEAR),
    excludeEntryIds: [await repo.getHomeUseRun(db, YEAR), await repo.getDepreciationRun(db, YEAR)].filter((x): x is number => x !== null),
    payeeName: (r) => (r.counterpartyId ? cps.find((c) => c.id === r.counterpartyId)?.name ?? "" : r.subId ? subs.find((x) => x.id === r.subId)?.name ?? "" : "（支払先の指定なし）"),
    deductionLimit: blueDeductionLimit(f.settings.filing_type, YEAR),
  });
  const src = {
    year: YEAR, filer: filerFromSettings(f.settings), input, result: it.r, biz: it.biz, statement, settings: f.settings,
    bookKeeping: (isYearCompliant(f.settings, YEAR) && notes["ebook:filed"] ? 1 : 2) as 1 | 2, numbers, createdOn: "2026-02-20",
  };
  const problems = incomeXtxProblems(src);
  if (problems.length) return { xml: "", problems, invalid: "", statement };
  const xml = buildIncomeTaxXtx(src);
  const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/domble-it-`);
  const file = `${dir}/t.xtx`;
  (await import("node:fs")).writeFileSync(file, xml);
  const xsd = new URL("../../etax/shotoku/RKO0010-250.xsd", import.meta.url).pathname;
  const p = Bun.spawnSync(["xmllint", "--noout", "--schema", xsd, file]);
  return { xml, problems, invalid: p.exitCode === 0 ? "" : p.stderr.toString(), statement };
};
/** 申告者の情報（氏名・住所と e-Tax の欄）を入れる。x で上書きできる */
export const setFiler = async (db: Database, x: Partial<Record<(typeof ETAX_FIELDS)[number], string>> = {}) => {
  await db.execute("UPDATE settings SET owner_name = ?, postal_code = ?, address = ? WHERE id = 1", ["山田 太郎", "150-0002", "東京都渋谷区渋谷1-2-3"]);
  const s = await repo.getSettings(db);
  const info = Object.fromEntries(ETAX_FIELDS.map((k) => [k, s[k]])) as Record<(typeof ETAX_FIELDS)[number], string>;
  await repo.saveEtaxInfo(db, { ...info, etax_user_id: "1234567890123456", tax_office: "01141", phone: "03-1234-5678", owner_kana: "ヤマダ タロウ", occupation: "自営業", ...x } as never);
};
/** xtx の欄の値（最初に出てくるもの） */
export const xtxVal = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>(?:<kubun_CD>)?([^<]*)<`))?.[1] ?? null;

/** 比べの表の1行 */
export interface Cmp { item: string; expected: number | string | null; actual: number | string | null; note?: string }
export const results: { scenario: string; rows: Cmp[] }[] = [];
export const cmp = (rows: Cmp[], item: string, expected: number | string | null, actual: number | string | null, note = "") => rows.push({ item, expected, actual, note });
const fmt = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? v.toLocaleString() : v);
export const printTable = (title: string, rows: Cmp[]) => {
  console.log(`\n### ${title}\n`);
  console.log("| 項目 | 手計算（国税庁の決まり・令和7年分） | domble の値 | 判定 | 備考 |");
  console.log("|---|---:|---:|---|---|");
  let ng = 0;
  for (const r of rows) {
    const same = r.expected === r.actual;
    const mark = r.actual === null || r.actual === "出せない" ? "出せない" : same ? "一致" : "違う";
    if (mark !== "一致") ng++;
    console.log(`| ${r.item} | ${fmt(r.expected)} | ${fmt(r.actual)} | ${mark} | ${r.note ?? ""} |`);
  }
  console.log(`\n（一致 ${rows.length - ng} ／ 違う・出せない ${ng}）`);
};

export { repo, CODE, yearEnd, yearStart, buildTaxXtx, depreciationFor };
export type { Account, JournalLine, HomeUseRate, IncomeTaxInput };

// ───────── 2026-11-04 の確認で足したもの ─────────
import { businessFigures } from "../../../src/lib/incomeTaxBooks";
import { carriedLosses, carriedFromPast, type PastIncomeTax } from "../../../src/lib/incomeTax";
import { bookLines, exclusiveAccountsOf, isExclusiveOn } from "../../../src/lib/taxExclusive";
import { assetSalesOf } from "../../../src/lib/transfers";

/** 消費税の e-Tax のデータ（TaxReturnView の書き出しと同じ：buildTaxXtx）。XSD（spec/etax/shohi の RSH0010・RSH0030）に照らした結果も返す */
export const taxXtxOf = async (db: Database, r: Parameters<typeof buildTaxXtx>[0], o: { interim?: { from: string; to: string }; year?: number } = {}) => {
  if (!(await repo.getSettings(db)).etax_user_id) await setFiler(db); // 画面は e-Tax の欄が足りないと書き出さないので、先に入れる
  const s = await repo.getSettings(db);
  const filer = { ...filerFromSettings(s), myNumber: "" };
  const y = o.year ?? YEAR;
  let xml = "";
  try {
    xml = buildTaxXtx(r, filer, { from: `${y}-01-01`, to: `${y}-12-31`, createdOn: `${y + 1}-02-20`, ...(o.interim ? { interim: o.interim } : {}) });
  } catch (e) {
    return { xml: "", error: String(e), invalid: "" };
  }
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync(`${(await import("node:os")).tmpdir()}/domble-tx-`);
  const file = `${dir}/t.xtx`;
  fs.writeFileSync(file, xml);
  const [, procedure, vr] = xml.match(/<(RSH\d{4}) VR="([\d.]+)"/)!;
  const xsd = new URL(`../../etax/shohi/${procedure}-${vr.replace(/\./g, "").slice(0, 3)}.xsd`, import.meta.url).pathname;
  const p = Bun.spawnSync(["xmllint", "--noout", "--schema", xsd, file]);
  return { xml, error: "", invalid: p.exitCode === 0 ? "" : p.stderr.toString().slice(0, 400) };
};

/**
 * 所得税（IncomeTaxPage と同じ：businessFigures（白色・不動産所得も）＋固定資産台帳で売却した資産 → carriedFromPast → computeIncomeTax）
 * y = 年分。繰越損失は、前の年の保存した所得税の入力と帳簿から引き継ぐ（画面と同じ）
 */
export const incomeTaxScreen = async (db: Database, b: Book, input: IncomeTaxInput, y = YEAR) => {
  await b.reload();
  const accounts = await repo.getAccounts(db, y);
  const figuresOf = async (yy: number, inp: IncomeTaxInput) => {
    const lines = await repo.getLines(db, yearStart(yy), yearEnd(yy));
    const opening = (await repo.getOpening(db, yy)).byAccount;
    const taxYears = await repo.getTaxYears(db);
    const books = bookLines(lines, taxYears, exclusiveAccountsOf(accounts));
    const end = closingBalances(accounts, opening, books);
    const n = await repo.getStatementNotes(db, yy);
    const landInterest = Number((n["re:landInterest"] ?? "").replace(/[,\s円]/g, "")) || 0;
    const scale = await repo.getRealEstateScale(db, yy);
    const filingType = await repo.filingTypeIn(db, yy);
    const f = businessFigures(accounts, end, filingType, inp, yy, { scale, landInterest });
    // 固定資産台帳でその年に売却した資産（総合課税の譲渡所得）
    const sold = assetSalesOf(await repo.getAssets(db), yy, (id) => accounts.find((a) => a.id === id)?.name ?? "", (d) => isExclusiveOn(taxYears, d));
    return { ...f, biz: { ...f.biz, assetSales: sold.sales, lumpSold: sold.lump } };
  };
  const { biz, familyLines } = await figuresOf(y, input);
  const load = async (yy: number): Promise<PastIncomeTax | null> => {
    const inp = await repo.findIncomeTaxInput(db, yy);
    if (!inp) return null;
    return { input: inp, biz: (await figuresOf(yy, inp)).biz };
  };
  const past = await carriedFromPast(y, load);
  const carried = carriedLosses(input, y, past);
  const r = computeIncomeTax(input, biz, y, carried);
  const v = (no: string) => r.rows.find((x) => x.no === no)?.value ?? null;
  const k = (key: string) => r.rows.find((x) => x.key === key)?.value ?? null;
  return { r, v, k, biz, familyLines, carried };
};

import { accruedTaxLines, inventoryLines } from "../../../src/lib/yearEnd";
/** 決算整理の画面（YearEndPage）の「棚卸の振替の仕訳を作る」：期首残高の棚卸資産と、保存した期末の棚卸高から */
export const runInventory = async (db: Database, b: Book, closing: number) => {
  await b.reload();
  await repo.saveInventoryCount(db, YEAR, { amount: closing, rows: [] });
  const id = (code: string) => b.accounts.find((a) => a.code === code)!.id;
  const opening = (await repo.getOpening(db, YEAR)).byAccount[id(CODE.STOCK)] ?? 0;
  const lines = inventoryLines(opening, closing, { openingAccount: id(CODE.OPENING_STOCK), closingAccount: id(CODE.CLOSING_STOCK), stock: id(CODE.STOCK) });
  return repo.saveYearEndRun(db, YEAR, "inventory", lines);
};
/** 決算整理の画面の「未払消費税等の仕訳を作る」：申告書の ㉖ から（税込経理） */
export const runAccruedTax = async (db: Database, b: Book) => {
  const t = await taxReturnOf(db, b);
  const id = (code: string) => b.accounts.find((a) => a.code === code)!.id;
  const lines = accruedTaxLines(t.r.total, { taxes: id(CODE.TAXES), accrued: id(CODE.ACCRUED_CONSUMPTION_TAX), receivable: id(CODE.ACCRUED), misc: id(CODE.MISC_INCOME) });
  return { id: await repo.saveYearEndRun(db, YEAR, "accrued_tax", lines), total: t.r.total };
};

import { buildWhiteStatement, familyMembers } from "../../../src/lib/whiteStatement";
import { buildRealEstateBook } from "../../../src/lib/realEstateStatement";
/**
 * 所得税の e-Tax のデータ（IncomeTaxPage.prepareExport → exportXtx と同じ組み立て。白色は収支内訳書、不動産所得があれば不動産所得用も）
 * it = incomeTaxScreen の結果
 */
export const incomeXtxScreen = async (
  db: Database, b: Book, input: IncomeTaxInput, it: Awaited<ReturnType<typeof incomeTaxScreen>>, y = YEAR, numbers: Record<string, string> = { self: "123456789018" },
) => {
  const accounts = await repo.getAccounts(db, y);
  const settings = await repo.getSettings(db);
  const filingType = await repo.filingTypeIn(db, y);
  const white = filingType === "white";
  const lines = await repo.getLines(db, yearStart(y), yearEnd(y));
  const opening = (await repo.getOpening(db, y)).byAccount;
  const notes = await repo.getStatementNotes(db, y);
  const subs = await repo.getSubAccounts(db, y);
  const cps = await repo.getCounterparties(db);
  const books = {
    year: y, accounts, opening, lines, notes, assets: await repo.getAssets(db), homeUseRates: await repo.getHomeUseRates(db, y),
    excludeEntryIds: [await repo.getHomeUseRun(db, y), await repo.getDepreciationRun(db, y)].filter((x): x is number => x !== null),
    payeeName: (r: { counterpartyId: number | null; subId: number | null }) => (r.counterpartyId ? cps.find((c) => c.id === r.counterpartyId)?.name ?? "" : r.subId ? subs.find((x) => x.id === r.subId)?.name ?? "" : "（支払先の指定なし）"),
    invoiceNoOf: (id: number) => cps.find((c) => c.id === id)?.invoice_no ?? "",
    corporateNoOf: (id: number) => cps.find((c) => c.id === id)?.corporate_no ?? "",
  };
  const scale = await repo.getRealEstateScale(db, y);
  const statement = buildBlueStatement({ ...books, deductionLimit: blueDeductionLimit(filingType, y), realEstateIncome: it.biz.realEstate?.incomeBeforeBlue });
  const realEstate = it.biz.realEstate ? buildRealEstateBook({ ...books, white, scale, filingType }) : undefined;
  const whiteSt = white ? buildWhiteStatement({ ...books, family: familyMembers(input) }) : undefined;
  const src = {
    year: y, filer: filerFromSettings(settings), input, result: it.r, biz: it.biz, statement, white: whiteSt, realEstate, settings,
    bookKeeping: 2 as const, numbers, createdOn: `${y + 1}-02-20`,
  };
  const problems = incomeXtxProblems(src);
  if (problems.length) return { xml: "", problems, invalid: "", statement, realEstate, whiteSt };
  const xml = buildIncomeTaxXtx(src);
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync(`${(await import("node:os")).tmpdir()}/domble-it-`);
  const file = `${dir}/t.xtx`;
  fs.writeFileSync(file, xml);
  const p = Bun.spawnSync(["xmllint", "--noout", "--schema", new URL("../../etax/shotoku/RKO0010-250.xsd", import.meta.url).pathname, file]);
  return { xml, problems, invalid: p.exitCode === 0 ? "" : p.stderr.toString().slice(0, 400), statement, realEstate, whiteSt };
};
