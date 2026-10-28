/**
 * DBアクセスはこのファイルに集約します。画面側には SQL を書かない方針です。
 *
 * 書き込みはすべて tx()（下）のトランザクションの中で行います。
 * 接続は帳簿ファイルごとに1本（src-tauri/src/db.rs）なので、BEGIN / COMMIT が同じ接続で実行されます。
 */
import type Database from "./connection";
import { RETIRED_TRIGGERS } from "./schema";
import type {
  AccessLogRecord, Account, AccountCategory, Counterparty, User, EBookMode, EntrySnapshot, Evidence, EvidenceAction, EvidenceHistoryRecord, EvidenceKind, EvidenceMeta,
  EvidenceSnapshot, FiscalClosing, HistoryAction, HistoryRecord, JournalEntry, JournalLine,
  HomeUseRate, MasterHistoryRecord, OpeningBalances, PurchaseUse, Settings, SubAccount, SubOpeningBalances, TaxCode, TaxYear, VoucherRow,
} from "../lib/types";
import { subKey } from "../lib/types";
import { yearEnd, yearStart, type FlatLine } from "../lib/accounting";
import { closedLabel, closedMonthOf, monthEnd, yearsToAutoClose } from "../lib/closing";
import { isValidInvoiceNo, normalizeInvoiceNo, type CounterpartyInput } from "../lib/counterparty";
import {
  builtinTaxCode, classLabel, deductionProblem, isBusinessClass, isInvoiceKind, isPurchaseUse, isTaxCode, resolveLineTax, taxActiveOn, taxCodeDef, taxYearOf, taxYearText,
  useLabel, validateTaxYear,
} from "../lib/tax";
import { normalizePostalCode, validateBusinessInfo } from "../lib/business";
import { ETAX_FIELDS, normalizeEtaxInfo, type EtaxInfo } from "../lib/etax";
import { EMPTY_INCOME_TAX_INPUT, normalizeIncomeTaxInput, type IncomeTaxInput } from "../lib/incomeTax";
import { autoLine, EXTRA_LINE, lineOptions, sectionOf } from "../lib/statementLines";
import { columnMapProblem, parseColumnMap, type BankRule, type ColumnMap, type StatementLine } from "../lib/bankImport";
import { removeFromTemplate, templateRows, validateTemplateName, type JournalTemplate } from "../lib/templates";
import { checkScanQuality, docClassOf, type DocClass, type ScanInputMethod } from "../lib/scan";
import { lastHolidayYear, mergeHolidays, type Holiday } from "../lib/holidays";
import { BUILTIN_HOLIDAYS } from "../constants/holidays";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";
import { can, isRole, permissionMessage, ROLE_LABEL, type Perm, type Role } from "../lib/permissions";
import {
  anchorCode, chainHash, closingState, entryState, evidenceState, GENESIS, hashText, HISTORY_COLUMNS, historyContent, normalizeAnchor,
  openingState, sourceLabel, stateLabel, verifyChain, type ChainRow, type ChainSource, type IntegrityIssue,
} from "../lib/integrity";
import { detectFileType, fromBase64, sha256Hex, toBase64, validateEvidenceFile, validateEvidenceMeta } from "../lib/evidence";
import { CATEGORY_CODE_RANGE, LOCKED_CODES, normalSideOf } from "../constants/accounts";
import { METHOD_LABEL, validateAsset, type FixedAsset } from "../lib/depreciation";
import {
  DEFAULT_BACKUP_GENERATIONS, DEFAULT_INPUT_PERIOD_DAYS, MAX_BACKUP_GENERATIONS, MAX_INPUT_PERIOD_DAYS, MAX_SUB_ACCOUNTS_PER_ACCOUNT,
} from "../constants/appConfig";

// ────────────────────────────────────────────
// トランザクション
//  書き込みはすべて tx() の中で行う（失敗したら丸ごと取り消す）。
//  始める前に「保存中」の目印（pending_ops）を置き、終わったら消す。
//  ソフトが途中で止まると、SQLite が書きかけを取り消し、目印だけが残る → 次に開いたときに知らせる（checkInterrupted）
//  tx の中から別の tx は呼ばない（呼ぶと待ち合わせて止まる）。中では「_」つきの関数を使う
// ────────────────────────────────────────────
let queue: Promise<unknown> = Promise.resolve();

/**
 * 読み取り専用（バックアップを開いているとき）。書き込みはすべて止める（年度の切り替えのような表示のためのものだけ通す）。
 * 接続そのものもファイルのメモリ上の写しなので（src-tauri/src/db.rs）、ここをすり抜けてもファイルは変わらない
 */
let readOnly = false;
export const setReadOnly = (v: boolean) => {
  readOnly = v;
};
export const isReadOnly = () => readOnly;
export const READ_ONLY_MESSAGE = "バックアップを読み取り専用で開いているため、変更できません";

/** 書き込みの入り口の決まり。allowReadOnly：読み取り専用でもできる。perm：必要な権限（無ければ誰でも） */
type TxOptions = { allowReadOnly?: boolean; perm?: Perm };

export const tx = <T>(db: Database, label: string, fn: () => Promise<T>, opts: TxOptions = {}): Promise<T> => {
  if (readOnly && !opts.allowReadOnly) return Promise.reject(new Error(READ_ONLY_MESSAGE));
  // 権限：ユーザーを選んだあとだけ確かめる（帳簿を開くときの準備などは、ユーザーを選ぶ前に行う）
  if (opts.perm && currentActor !== null && !can(currentRole, opts.perm)) {
    return Promise.reject(new Error(permissionMessage(currentRole ?? "viewer")));
  }
  const run = queue.then(async () => {
    const mark = await db.execute("INSERT INTO pending_ops (label, user_id) VALUES (?, ?)", [label, currentActor]);
    await db.execute("BEGIN IMMEDIATE");
    try {
      const r = await fn();
      await db.execute("COMMIT");
      return r;
    } catch (e) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        /* すでに取り消されている */
      }
      throw e;
    } finally {
      await db.execute("DELETE FROM pending_ops WHERE id = ?", [mark.lastInsertId]);
    }
  });
  queue = run.catch(() => undefined);
  return run;
};

/**
 * 書き込みの待ち行列に並んで読む（トランザクションは使わない）。
 * 接続は1本なので、書き込みの途中に読むと書きかけが見えてしまう。改ざんの確認のように、
 * 「そろった状態」を読まないと誤って知らせてしまうものはこれを通す。tx の中からは呼ばない
 */
export const queuedRead = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
};

type Rest<F> = F extends (db: Database, ...a: infer R) => unknown ? R : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inTx = <F extends (db: Database, ...a: any[]) => Promise<any>>(f: F, label: (...a: Rest<F>) => string, opts: TxOptions = {}) =>
  (db: Database, ...a: Rest<F>) => tx(db, label(...a), () => f(db, ...a), opts) as ReturnType<F>;

/** 操作しているユーザーとその権限（帳簿を開いてユーザーを選んだときに setActor で決める） */
let currentActor: number | null = null;
let currentRole: Role | null = null;
export const setActor = (userId: number | null, role: Role | null = null) => {
  currentActor = userId;
  currentRole = userId === null ? null : role;
};
export const getActor = () => currentActor;

/**
 * 前回、保存の途中でソフトが止まっていないか（帳簿を開いたとき）。
 * 書きかけは SQLite が取り消しているので帳簿は整っている。何が取り消されたかを知らせ、厳密モードでは記録する
 */
export const checkInterrupted = async (db: Database) => {
  const rows = await db.select<{ id: number; label: string; started_at: string; user_name: string | null }[]>(
    `SELECT p.id, p.label, p.started_at, u.name AS user_name FROM pending_ops p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id`,
  );
  const messages = rows.map((r) => `${r.started_at}　${r.label}${r.user_name ? `（${r.user_name}）` : ""}`);
  if (rows.length === 0) return messages;
  await tx(db, "中断の記録", async () => {
    for (const m of messages) await recordEvent(db, "interrupted", `保存が完了せず、取り消されました：${m}`);
  });
  for (const r of rows) await db.execute("DELETE FROM pending_ops WHERE id = ?", [r.id]);
  return messages;
};

// ────────────────────────────────────────────
// 設定
// ────────────────────────────────────────────
export const getSettings = async (db: Database): Promise<Settings> => {
  const rows = await db.select<Settings[]>(
    `SELECT business_name, owner_name, postal_code, address, invoice_no, invoice_registered_on, etax_user_id, tax_office, phone, owner_kana,
            business_kana, occupation, householder_name, householder_relation, jan1_address, office_phone, refund_mode, bank_name, bank_kind,
            branch_name, branch_kind, deposit_kind, account_no, yucho_symbol, yucho_number,
            office_address, union_name, agent_name, agent_address, agent_phone,
            industry, fiscal_year, filing_type, e_book_mode, strict_from_year, strict_switched_at
       FROM settings WHERE id = 1`,
  );
  return rows[0];
};

/** 電子帳簿保存法モードを決める（一度だけ。変更はトリガーで拒否される） */
const setEBookMode_ = (db: Database, mode: EBookMode) =>
  db.execute("UPDATE settings SET e_book_mode = ? WHERE id = 1 AND e_book_mode IS NULL", [mode]);

/**
 * 通常モードの帳簿を、year 年から電子帳簿保存法に対応した保存方式（厳密モード）に切り替えられるか。
 * 翌年を始めるとき（繰越）にだけ聞く。year 年以降の仕訳がまだ無いときだけ（その年の初めから履歴を残せる）
 */
export const canSwitchToStrict = async (db: Database, year: number) => {
  const s = await getSettings(db);
  if (s.e_book_mode !== "standard") return false;
  const r = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM journal_entries WHERE date >= ?", [`${year}-01-01`]);
  return r[0].n === 0;
};

/** 通常 → 厳密 に切り替える（戻せない）。今の帳簿の状態を基準点にして記録の連鎖を始め、切り替えたことを履歴に残す */
const switchToStrict_ = async (db: Database, year: number) => {
  if (!(await canSwitchToStrict(db, year))) throw new Error(`${year}年の仕訳がすでにあるか、通常モードの帳簿ではないため、切り替えられません`);
  await db.execute(
    "UPDATE settings SET e_book_mode = 'strict', strict_from_year = ?, strict_switched_at = DATETIME('now','localtime') WHERE id = 1",
    [year],
  );
  await initChain_(db);
  await logMaster(db, {
    target_type: "setting", target_id: 0, action: "change", fiscal_year: year, label: "帳簿の保存方式",
    old_value: "通常", new_value: `電子帳簿保存法に対応（${year}年から）`,
  });
};

const isStrict = async (db: Database) => {
  const r = await db.select<{ e_book_mode: EBookMode | null }[]>("SELECT e_book_mode FROM settings WHERE id = 1");
  return r[0]?.e_book_mode === "strict";
};

const currentYear = async (db: Database) => {
  const r = await db.select<{ fiscal_year: number }[]>("SELECT fiscal_year FROM settings WHERE id = 1");
  return r[0].fiscal_year;
};

// ────────────────────────────────────────────
// 変更履歴（科目・補助科目・期首残高）厳密モードのときだけ記録
// ────────────────────────────────────────────
type MasterLog = Omit<MasterHistoryRecord, "id" | "recorded_at">;

const logMaster = async (db: Database, rec: MasterLog) => {
  if (!(await isStrict(db))) return;
  const res = await db.execute(
    `INSERT INTO master_history (target_type, target_id, action, fiscal_year, label, old_value, new_value, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.target_type, rec.target_id, rec.action, rec.fiscal_year, rec.label, rec.old_value, rec.new_value, currentActor],
  );
  const key = rec.target_type === "opening" ? `opening:${rec.fiscal_year}` : rec.target_type === "closing" ? `closing:${rec.target_id}` : "";
  await appendChain(db, "master_history", Number(res.lastInsertId), key);
};

export const getMasterHistory = (db: Database) =>
  db.select<MasterHistoryRecord[]>(
    "SELECT h.*, u.name AS user_name FROM master_history h LEFT JOIN users u ON u.id = h.user_id ORDER BY h.id DESC",
  );

// ────────────────────────────────────────────
// 締め（年度ごとに「何月まで締めたか」。12月までが年の締め）
//  締めた月までの仕訳は書き込めない。年の締めをした年度は、期首残高・家事按分・年度ごとの科目名なども書き込めない。
//  ここで先に確認してわかりやすいメッセージを出し、DB のトリガー（schema.ts）でも拒否する
// ────────────────────────────────────────────
export const closedMessage = (year: number) => `${year}年は締め済みのため変更できません。事業者設定で締めを戻してください。`;
const closedMonthMessage = (year: number, month: number) =>
  `${year}年は${month}月まで締め済みのため、${month}月以前の仕訳は変更できません。事業者設定で締めを戻してください。`;

export const getClosings = (db: Database) =>
  db.select<FiscalClosing[]>("SELECT fiscal_year, period_start, period_end, closed_at, chain_head FROM fiscal_closings ORDER BY fiscal_year");

const closingRow = async (db: Database, year: number) =>
  (await db.select<FiscalClosing[]>("SELECT fiscal_year, period_start, period_end, closed_at, chain_head FROM fiscal_closings WHERE fiscal_year = ?", [year]))[0];

/** 年度が年の締め（12月まで）をしてあれば止める（期首残高・家事按分など、年度ごとのもの） */
const assertYearOpen = async (db: Database, year: number) => {
  if (closedMonthOf(await closingRow(db, year)) === 12) throw new Error(closedMessage(year));
};

/** 日付が締めた月に入っていれば止める（仕訳） */
const assertDateOpen = async (db: Database, date: string) => {
  const r = await db.select<{ fiscal_year: number; period_end: string }[]>(
    "SELECT fiscal_year, period_end FROM fiscal_closings WHERE ? BETWEEN period_start AND period_end",
    [date],
  );
  if (r.length === 0) return;
  const m = closedMonthOf(r[0]);
  throw new Error(m === 12 ? closedMessage(r[0].fiscal_year) : closedMonthMessage(r[0].fiscal_year, m));
};

/**
 * 年度を month 月まで締める（12 なら年の締め）。すでにそこまで締めてあれば何もしない。note は履歴に残す補足
 * 締めたときの記録の連鎖の先頭を控える（確認コードとして画面に出し、ファイルの外に残してもらう）
 */
const closeThrough_ = async (db: Database, year: number, month: number, note = "") => {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("締める月は 1〜12 で選んでください");
  const before = closedMonthOf(await closingRow(db, year));
  if (before >= month) return;
  await db.execute(
    `INSERT INTO fiscal_closings (fiscal_year, period_start, period_end) VALUES (?, ?, ?)
     ON CONFLICT (fiscal_year) DO UPDATE SET period_end = excluded.period_end, closed_at = DATETIME('now','localtime')`,
    [year, yearStart(year), monthEnd(year, month)],
  );
  await logMaster(db, {
    target_type: "closing", target_id: year, action: "close", fiscal_year: year,
    label: `${year}年`, old_value: closedLabel(before), new_value: closedLabel(month) + (note ? `（${note}）` : ""),
  });
  const head = await getChainHead(db);
  if (head) await db.execute("UPDATE fiscal_closings SET chain_head = ? WHERE fiscal_year = ?", [head.row_hash, year]);
};

/** 年の締め（12月まで締める） */
const closeYear_ = (db: Database, year: number, note = "") => closeThrough_(db, year, 12, note);

/**
 * 締めを month 月までに戻す（0 なら締めなし）。厳密モードでは理由が必須で、履歴に残す
 * 年の締めをした年度も、たとえば 10 を選べば 11・12月だけが直せるようになる（1回の操作で済む）
 */
const reopenTo_ = async (db: Database, year: number, month: number, reason: string) => {
  const r = reason.trim();
  if (!Number.isInteger(month) || month < 0 || month > 11) throw new Error("戻す先の月は 0〜11 で選んでください");
  if ((await isStrict(db)) && !r) throw new Error("締めを戻す理由を入れてください");
  const before = closedMonthOf(await closingRow(db, year));
  if (before <= month) return;
  if (month === 0) await db.execute("DELETE FROM fiscal_closings WHERE fiscal_year = ?", [year]);
  else await db.execute("UPDATE fiscal_closings SET period_end = ? WHERE fiscal_year = ?", [monthEnd(year, month), year]);
  await logMaster(db, {
    target_type: "closing", target_id: year, action: "unlock", fiscal_year: year,
    label: `${year}年`, old_value: closedLabel(before), new_value: `${closedLabel(month)}に戻す${r ? `（理由：${r}）` : ""}`,
  });
};

/** 締めを全部外す（0月までに戻す） */
const reopenYear_ = (db: Database, year: number, reason: string) => reopenTo_(db, year, 0, reason);

/**
 * 既存の帳簿で、繰越済みの年度を締め済みにする（帳簿を開いたときに一度だけ）。
 * 一度済ませたら印をつけ、あとで解除した年度を開くたびに締め直すことはしない
 */
const initClosings_ = async (db: Database) => {
  const flag = await db.select<{ closings_initialized: number }[]>("SELECT closings_initialized FROM settings WHERE id = 1");
  if (!flag[0] || flag[0].closings_initialized) return;
  const openingYears = (await db.select<{ y: number }[]>("SELECT DISTINCT fiscal_year AS y FROM opening_balances")).map((r) => r.y);
  const dataYears: number[] = [];
  for (const y of openingYears.map((x) => x - 1)) {
    const r = await db.select<{ n: number }[]>(
      `SELECT (SELECT COUNT(*) FROM journal_entries WHERE date BETWEEN ? AND ?)
            + (SELECT COUNT(*) FROM opening_balances WHERE fiscal_year = ?) AS n`,
      [yearStart(y), yearEnd(y), y],
    );
    if (r[0].n > 0) dataYears.push(y);
  }
  const closed = (await getClosings(db)).map((c) => c.fiscal_year);
  for (const y of yearsToAutoClose(openingYears, dataYears, closed)) {
    await closeYear_(db, y, "繰越済みの年度を自動で締め");
  }
  await db.execute("UPDATE settings SET closings_initialized = 1 WHERE id = 1");
};

/** 年度ごとの名前（無ければ作成時の名前）を引く SQL 片 */
const effectiveName = (type: "account" | "sub", alias: string) =>
  `COALESCE((SELECT m.name FROM master_names m WHERE m.target_type = '${type}' AND m.target_id = ${alias}.id
     AND m.from_year <= ? ORDER BY m.from_year DESC LIMIT 1), ${alias}.name)`;

/** 事業者の情報（登録番号は消費税の設定で saveInvoiceRegistration から変える） */
const saveSettings_ = async (db: Database, s: Settings) => {
  const info = { postal_code: s.postal_code ?? "", address: (s.address ?? "").trim(), invoice_no: "" };
  const err = validateBusinessInfo(info);
  if (err) throw new Error(err);
  await db.execute(
    `UPDATE settings SET business_name = ?, owner_name = ?, postal_code = ?, address = ?, industry = ?, fiscal_year = ?,
            filing_type = ? WHERE id = 1`,
    [s.business_name, s.owner_name, normalizePostalCode(info.postal_code), info.address, s.industry, s.fiscal_year, s.filing_type],
  );
};

/** e-Tax の申告者の情報（形式は lib/etax.ts の normalizeEtaxInfo で確かめる） */
const saveEtaxInfo_ = async (db: Database, x: EtaxInfo) => {
  const n = normalizeEtaxInfo(x);
  if (typeof n === "string") throw new Error(n);
  await db.execute(
    `UPDATE settings SET etax_user_id = ?, tax_office = ?, phone = ?, owner_kana = ?, business_kana = ?, occupation = ?, householder_name = ?,
            householder_relation = ?, jan1_address = ?, office_phone = ?, refund_mode = ?, bank_name = ?, bank_kind = ?, branch_name = ?, branch_kind = ?,
            deposit_kind = ?, account_no = ?, yucho_symbol = ?, yucho_number = ?, office_address = ?, union_name = ?, agent_name = ?, agent_address = ?,
            agent_phone = ? WHERE id = 1`,
    ETAX_FIELDS.map((k) => n[k]),
  );
};

// ────────────────────────────────────────────
// 消費税（年度ごとの設定・登録番号）。考え方は lib/tax.ts
//  年度ごとの設定は from_year 以降に効く（次の設定がある年まで引き継ぐ）。年の締めをした年度の設定は変えられない
// ────────────────────────────────────────────
export const getTaxYears = (db: Database) =>
  db.select<TaxYear[]>("SELECT from_year, status, method, business_class, taxable_from, deduction, voluntary_interim FROM tax_years ORDER BY from_year");

/** year 年の設定を保存する（前の年から引き継いでいた年も、その年の設定として持つ）。変更は履歴に残す（厳密モード） */
const saveTaxYear_ = async (db: Database, t: TaxYear) => {
  const row: TaxYear = {
    ...t, taxable_from: t.status === "exempt" ? "" : t.taxable_from.trim(), deduction: t.deduction ?? "individual",
    voluntary_interim: t.status === "exempt" ? 0 : t.voluntary_interim ? 1 : 0,
  };
  const err = validateTaxYear(row);
  if (err) throw new Error(err);
  await assertYearOpen(db, row.from_year);
  const years = await getTaxYears(db);
  if (row.status === "standard") {
    const d = deductionProblem(years, row.from_year, row.deduction);
    if (d) throw new Error(d);
  }
  const before = taxYearOf(years, row.from_year);
  await db.execute(
    `INSERT INTO tax_years (from_year, status, method, business_class, taxable_from, deduction, voluntary_interim) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (from_year) DO UPDATE SET status = excluded.status, method = excluded.method, business_class = excluded.business_class,
       taxable_from = excluded.taxable_from, deduction = excluded.deduction, voluntary_interim = excluded.voluntary_interim`,
    [row.from_year, row.status, row.method, row.business_class, row.taxable_from, row.deduction, row.voluntary_interim],
  );
  const [o, n] = [taxYearText(before), taxYearText(row)];
  if (o !== n || before.inherited) {
    await logMaster(db, {
      target_type: "setting", target_id: row.from_year, action: "change", fiscal_year: row.from_year, label: `${row.from_year}年の消費税`,
      old_value: before.inherited ? `${o}（前の年から引き継ぎ）` : o, new_value: n,
    });
  }
};

/** 手で入れた基準期間の課税売上高（無ければ null） */
export const getTaxBaseManual = async (db: Database, year: number) => {
  const r = await db.select<{ amount: number }[]>("SELECT amount FROM tax_base_sales WHERE fiscal_year = ?", [year]);
  return r[0]?.amount ?? null;
};

/** 基準期間の課税売上高を手で入れる（null で外す＝帳簿から計算する）。変更は履歴に残す */
const saveTaxBaseManual_ = async (db: Database, year: number, amount: number | null) => {
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000_000)) {
    throw new Error("基準期間の課税売上高は 0 以上の整数（円）で入れてください");
  }
  await assertYearOpen(db, year);
  const before = await getTaxBaseManual(db, year);
  if (before === amount) return;
  if (amount === null) await db.execute("DELETE FROM tax_base_sales WHERE fiscal_year = ?", [year]);
  else {
    await db.execute(
      "INSERT INTO tax_base_sales (fiscal_year, amount) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET amount = excluded.amount",
      [year, amount],
    );
  }
  const text = (x: number | null) => (x === null ? "帳簿から計算" : `${x.toLocaleString()} 円（手で入力）`);
  await logMaster(db, {
    target_type: "setting", target_id: year, action: "change", fiscal_year: year, label: `${year}年の基準期間（${year - 2}年）の課税売上高`,
    old_value: text(before), new_value: text(amount),
  });
};

/** 手で入れた前年の確定消費税額（中間申告の判定に使う。無ければ null） */
export const getTaxPrevManual = async (db: Database, year: number) => {
  const r = await db.select<{ amount: number }[]>("SELECT amount FROM tax_prev_amounts WHERE fiscal_year = ?", [year]);
  return r[0]?.amount ?? null;
};

/** 前年の確定消費税額を手で入れる（null で外す＝帳簿から計算する）。変更は履歴に残す */
const saveTaxPrevManual_ = async (db: Database, year: number, amount: number | null) => {
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000_000)) {
    throw new Error("前年の確定消費税額は 0 以上の整数（円）で入れてください");
  }
  await assertYearOpen(db, year);
  const before = await getTaxPrevManual(db, year);
  if (before === amount) return;
  if (amount === null) await db.execute("DELETE FROM tax_prev_amounts WHERE fiscal_year = ?", [year]);
  else {
    await db.execute(
      "INSERT INTO tax_prev_amounts (fiscal_year, amount) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET amount = excluded.amount",
      [year, amount],
    );
  }
  const text = (x: number | null) => (x === null ? "帳簿から計算" : `${x.toLocaleString()} 円（手で入力）`);
  await logMaster(db, {
    target_type: "setting", target_id: year, action: "change", fiscal_year: year, label: `${year}年の中間申告の判定に使う前年（${year - 1}年）の確定消費税額`,
    old_value: text(before), new_value: text(amount),
  });
};

// ────────────────────────────────────────────
// 銀行・カードの明細の取り込み（考え方は lib/bankImport.ts）
//  口座は科目と補助科目（補助なしは 0 で持つ）。明細・ルール・列の対応は帳簿そのものではないので履歴に残さない
//  仕訳にしたときは、仕訳の登録の履歴に「明細の取り込み（ファイル名）」と残る
// ────────────────────────────────────────────
export interface BankLineRow {
  id: number;
  account_id: number;
  sub_account_id: number | null;
  date: string;
  description: string;
  side: "debit" | "credit";
  amount: number;
  balance: number | null;
  status: "pending" | "done" | "skipped";
  entry_id: number | null;
  file_name: string;
  imported_at: string;
}

const subKeyOf = (subId: number | null) => subId ?? 0;

export const getBankFormat = async (db: Database, accountId: number, subId: number | null) => {
  const r = await db.select<{ mapping: string }[]>("SELECT mapping FROM bank_formats WHERE account_id = ? AND sub_account_id = ?", [accountId, subKeyOf(subId)]);
  return parseColumnMap(r[0]?.mapping ?? null);
};

const saveBankFormat_ = async (db: Database, accountId: number, subId: number | null, map: ColumnMap) => {
  const p = columnMapProblem(map);
  if (p) throw new Error(p);
  await db.execute(
    "INSERT INTO bank_formats (account_id, sub_account_id, mapping) VALUES (?, ?, ?) ON CONFLICT (account_id, sub_account_id) DO UPDATE SET mapping = excluded.mapping",
    [accountId, subKeyOf(subId), JSON.stringify(map)],
  );
};

/** 明細を足す（前に読んだ明細＝指紋が同じものは足さない）。足した件数と、前に読んでいた件数 */
const addBankLines_ = async (db: Database, accountId: number, subId: number | null, lines: StatementLine[], fileName: string) => {
  let added = 0;
  for (const l of lines) {
    const r = await db.execute(
      `INSERT OR IGNORE INTO bank_lines (account_id, sub_account_id, date, description, side, amount, balance, fingerprint, file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, subKeyOf(subId), l.date, l.description, l.side, l.amount, l.balance, l.fingerprint, fileName],
    );
    added += r.rowsAffected;
  }
  return { added, known: lines.length - added };
};

/**
 * 口座の明細（日付順）。仕訳にした明細のうち、仕訳を削除したものは未登録に戻す（厳密モードの削除済み・通常モードで消した仕訳）
 */
export const getBankLines = async (db: Database, accountId: number, subId: number | null): Promise<BankLineRow[]> => {
  const rows = await db.select<(BankLineRow & { gone: number })[]>(
    `SELECT b.id, b.account_id, NULLIF(b.sub_account_id, 0) AS sub_account_id, b.date, b.description, b.side, b.amount, b.balance, b.status, b.entry_id,
            b.file_name, b.imported_at, (b.status = 'done' AND (e.id IS NULL OR e.is_deleted = 1)) AS gone
       FROM bank_lines b LEFT JOIN journal_entries e ON e.id = b.entry_id
      WHERE b.account_id = ? AND b.sub_account_id = ? ORDER BY b.date, b.id`,
    [accountId, subKeyOf(subId)],
  );
  return rows.map(({ gone, ...r }) => (gone ? { ...r, status: "pending" as const, entry_id: null } : r));
};

/** 口座ごとの未登録の明細の数（キーは「科目ID|補助科目ID（無ければ 0）」） */
export const getPendingBankCounts = async (db: Database) => {
  const rows = await db.select<{ account_id: number; sub_account_id: number; n: number }[]>(
    `SELECT b.account_id, b.sub_account_id, COUNT(*) AS n FROM bank_lines b LEFT JOIN journal_entries e ON e.id = b.entry_id
      WHERE b.status = 'pending' OR (b.status = 'done' AND (e.id IS NULL OR e.is_deleted = 1)) GROUP BY b.account_id, b.sub_account_id`,
  );
  return new Map(rows.map((r) => [`${r.account_id}|${r.sub_account_id}`, r.n]));
};

/** 前に明細から作った仕訳と、もとの明細の摘要（推測に使う） */
export const getBankHistory = async (db: Database, accountId: number, subId: number | null) =>
  (await db.select<{ entry_id: number; description: string }[]>(
    "SELECT entry_id, description FROM bank_lines WHERE account_id = ? AND sub_account_id = ? AND status = 'done' AND entry_id IS NOT NULL",
    [accountId, subKeyOf(subId)],
  )).map((r) => ({ entryId: r.entry_id, description: r.description }));

/** 取り込まない・未登録に戻す */
const setBankLinesStatus_ = async (db: Database, ids: number[], status: "pending" | "skipped") => {
  for (const id of ids) {
    await db.execute("UPDATE bank_lines SET status = ?, entry_id = NULL WHERE id = ? AND (status != 'done' OR entry_id IS NULL OR entry_id NOT IN (SELECT id FROM journal_entries WHERE is_deleted = 0))", [status, id]);
  }
};

/** 明細を仕訳にする（まとめて。1つのトランザクションなので、途中で失敗したら1件も残らない） */
const registerBankLines_ = async (
  db: Database, items: { lineId: number; date: string; lines: JournalLine[]; counterpartyId: number | null }[], source: string,
) => {
  const ids: number[] = [];
  for (const it of items) {
    const r = await db.select<{ status: string; entry_id: number | null; live: number }[]>(
      "SELECT b.status, b.entry_id, (e.id IS NOT NULL AND e.is_deleted = 0) AS live FROM bank_lines b LEFT JOIN journal_entries e ON e.id = b.entry_id WHERE b.id = ?",
      [it.lineId],
    );
    if (!r[0]) throw new Error("明細が見つかりません");
    if (r[0].status === "done" && r[0].live) throw new Error("この明細はもう仕訳にしています");
    const entryId = await createEntry_(db, it.date, it.lines, it.counterpartyId, `明細の取り込み（${source}）`);
    await db.execute("UPDATE bank_lines SET status = 'done', entry_id = ? WHERE id = ?", [entryId, it.lineId]);
    ids.push(entryId);
  }
  return ids;
};

export const getBankRules = (db: Database) =>
  db.select<BankRule[]>(
    `SELECT id, keyword, direction, target_account_id, account_id, sub_account_id, tax_code, invoice_kind, counterparty_id, memo, sort_order
       FROM bank_rules ORDER BY sort_order, id`,
  );

/** ルールを保存する（id が 0 なら足す）。足したルールの id */
const saveBankRule_ = async (db: Database, r: Omit<BankRule, "sort_order"> & { sort_order?: number }) => {
  const keyword = r.keyword.normalize("NFKC").trim();
  if (!keyword) throw new Error("摘要に含む言葉を入れてください");
  if (keyword.length > 50) throw new Error("摘要に含む言葉は50文字までです");
  if (!["any", "increase", "decrease"].includes(r.direction)) throw new Error("入金・出金の区分が正しくありません");
  if (!r.account_id) throw new Error("相手科目を選んでください");
  if (r.tax_code !== null && !isTaxCode(r.tax_code)) throw new Error("税区分が正しくありません");
  if (r.invoice_kind !== null && !isInvoiceKind(r.invoice_kind)) throw new Error("インボイス区分が正しくありません");
  const memo = r.memo.trim().slice(0, 200);
  const vals = [keyword, r.direction, r.target_account_id, r.account_id, r.sub_account_id, r.tax_code, r.invoice_kind, r.counterparty_id, memo];
  if (r.id) {
    await db.execute(
      `UPDATE bank_rules SET keyword = ?, direction = ?, target_account_id = ?, account_id = ?, sub_account_id = ?, tax_code = ?, invoice_kind = ?,
              counterparty_id = ?, memo = ? WHERE id = ?`,
      [...vals, r.id],
    );
    return r.id;
  }
  const next = await db.select<{ n: number }[]>("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM bank_rules");
  const res = await db.execute(
    `INSERT INTO bank_rules (keyword, direction, target_account_id, account_id, sub_account_id, tax_code, invoice_kind, counterparty_id, memo, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...vals, r.sort_order ?? next[0].n],
  );
  return Number(res.lastInsertId);
};

const deleteBankRule_ = async (db: Database, id: number) => {
  await db.execute("DELETE FROM bank_rules WHERE id = ?", [id]);
};

// ────────────────────────────────────────────
// 所得税の申告書に入れるもの（年度ごと。考え方は lib/incomeTax.ts）
//  帳簿そのものではないので履歴には残さない（決算書の書き込み欄と同じ）。年の締めをした年度は変えられない
// ────────────────────────────────────────────
export const getIncomeTaxInput = async (db: Database, year: number): Promise<IncomeTaxInput> => {
  const r = await db.select<{ data: string }[]>("SELECT data FROM income_tax_inputs WHERE fiscal_year = ?", [year]);
  if (!r[0]) return EMPTY_INCOME_TAX_INPUT;
  try {
    const n = normalizeIncomeTaxInput(JSON.parse(r[0].data));
    return typeof n === "string" ? EMPTY_INCOME_TAX_INPUT : n;
  } catch {
    return EMPTY_INCOME_TAX_INPUT;
  }
};

const saveIncomeTaxInput_ = async (db: Database, year: number, input: IncomeTaxInput) => {
  const n = normalizeIncomeTaxInput(input);
  if (typeof n === "string") throw new Error(n);
  await assertYearOpen(db, year);
  await db.execute(
    "INSERT INTO income_tax_inputs (fiscal_year, data) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET data = excluded.data",
    [year, JSON.stringify(n)],
  );
};

/** その年の中間納付税額（申告した税額。無ければ 0） */
export const getTaxInterim = async (db: Database, year: number) => {
  const r = await db.select<{ national: number; local: number }[]>("SELECT national, local FROM tax_interims WHERE fiscal_year = ?", [year]);
  return r[0] ?? { national: 0, local: 0 };
};

const saveTaxInterim_ = async (db: Database, year: number, national: number, local: number) => {
  for (const n of [national, local]) {
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000_000) throw new Error("中間納付税額は 0 以上の整数（円）で入れてください");
  }
  await assertYearOpen(db, year);
  const before = await getTaxInterim(db, year);
  if (before.national === national && before.local === local) return;
  if (national === 0 && local === 0) await db.execute("DELETE FROM tax_interims WHERE fiscal_year = ?", [year]);
  else {
    await db.execute(
      "INSERT INTO tax_interims (fiscal_year, national, local) VALUES (?, ?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET national = excluded.national, local = excluded.local",
      [year, national, local],
    );
  }
  const text = (x: { national: number; local: number }) => `消費税 ${x.national.toLocaleString()} 円・地方消費税 ${x.local.toLocaleString()} 円`;
  await logMaster(db, {
    target_type: "setting", target_id: year, action: "change", fiscal_year: year, label: `${year}年の消費税の中間納付税額`,
    old_value: text(before), new_value: text({ national, local }),
  });
};

/** 適格請求書発行事業者の登録番号と登録日（どちらも空にできる） */
const saveInvoiceRegistration_ = async (db: Database, invoiceNo: string, registeredOn: string) => {
  const no = normalizeInvoiceNo(invoiceNo);
  const on = registeredOn.trim();
  if (no && !isValidInvoiceNo(no)) throw new Error("登録番号は「T」と13桁の数字です（例：T1234567890123）");
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new Error("登録日は日付で入れてください");
  if (on && !no) throw new Error("登録日を入れるときは、登録番号も入れてください");
  const before = await getSettings(db);
  await db.execute("UPDATE settings SET invoice_no = ?, invoice_registered_on = ? WHERE id = 1", [no, on]);
  const text = (n: string, d: string) => (n ? `${n}${d ? `（${d} 登録）` : ""}` : "なし");
  if (before.invoice_no !== no || before.invoice_registered_on !== on) {
    await logMaster(db, {
      target_type: "setting", target_id: 0, action: "change", fiscal_year: await currentYear(db), label: "適格請求書発行事業者の登録番号",
      old_value: text(before.invoice_no, before.invoice_registered_on), new_value: text(no, on),
    });
  }
};

/** 表示する年度を切り替える（読み取り専用でも使える。読み取り専用のときはメモリ上の写しだけが変わる） */
const setFiscalYear_ = (db: Database, year: number) => db.execute("UPDATE settings SET fiscal_year = ? WHERE id = 1", [year]);

/** バックアップを残す世代数 */
export const getBackupGenerations = async (db: Database) => {
  const r = await db.select<{ backup_generations: number | null }[]>("SELECT backup_generations FROM settings WHERE id = 1");
  return r[0]?.backup_generations || DEFAULT_BACKUP_GENERATIONS;
};

const setBackupGenerations_ = async (db: Database, n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BACKUP_GENERATIONS) throw new Error(`世代数は 1〜${MAX_BACKUP_GENERATIONS} の整数で入れてください`);
  await db.execute("UPDATE settings SET backup_generations = ? WHERE id = 1", [n]);
};

/** 帳簿入力のタブに出す科目（科目ID の並び）。まだ決めていなければ null（既定の科目を使う） */
export const getCashbookAccounts = async (db: Database): Promise<number[] | null> => {
  const r = await db.select<{ cashbook_accounts: string }[]>("SELECT cashbook_accounts FROM settings WHERE id = 1");
  const raw = r[0]?.cashbook_accounts;
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((x): x is number => Number.isInteger(x)) : null;
  } catch {
    return null;
  }
};

/** 帳簿入力のタブを保存する（画面の設定なので履歴には残さない）。貸借対照表の科目だけ・1つ以上 */
const setCashbookAccounts_ = async (db: Database, ids: number[]) => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new Error("帳簿のタブを1つ以上選んでください");
  const rows = await db.select<{ id: number; category: string }[]>("SELECT id, category FROM accounts");
  const bs = new Set(rows.filter((a) => ["asset", "liability", "equity"].includes(a.category)).map((a) => a.id));
  if (unique.some((id) => !bs.has(id))) throw new Error("帳簿のタブにできるのは、資産・負債・資本の科目だけです");
  await db.execute("UPDATE settings SET cashbook_accounts = ? WHERE id = 1", [JSON.stringify(unique)]);
};

/** 入力期間（日）。これを過ぎて登録した仕訳を「遅れて登録」として抽出する */
export const getInputPeriodDays = async (db: Database) => {
  const r = await db.select<{ input_period_days: number | null }[]>("SELECT input_period_days FROM settings WHERE id = 1");
  return r[0]?.input_period_days || DEFAULT_INPUT_PERIOD_DAYS;
};

/** 入力期間の変更。どの仕訳が「遅れて登録」に当たるかが変わるので、厳密モードでは履歴に残す */
const setInputPeriodDays_ = async (db: Database, n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INPUT_PERIOD_DAYS) throw new Error(`入力期間は 1〜${MAX_INPUT_PERIOD_DAYS} 日の整数で入れてください`);
  const before = await getInputPeriodDays(db);
  if (before === n) return;
  await db.execute("UPDATE settings SET input_period_days = ? WHERE id = 1", [n]);
  await logMaster(db, {
    target_type: "setting", target_id: 0, action: "change", fiscal_year: await currentYear(db),
    label: "入力期間", old_value: `${before}日`, new_value: `${n}日`,
  });
};

// ────────────────────────────────────────────
// 勘定科目
// ────────────────────────────────────────────
/** 勘定科目（名前はその年度のもの） */
export const getAccounts = (db: Database, year: number) =>
  db.select<Account[]>(
    `SELECT a.id, a.code, ${effectiveName("account", "a")} AS name, a.kana, a.category, a.normal_side,
            a.sort_order, a.is_active, a.is_system, a.default_tax_code, a.default_business_class, a.default_purchase_use, a.statement_line
       FROM accounts a ORDER BY a.code`,
    [year],
  );

const accountLabel = async (db: Database, id: number) => {
  const year = await currentYear(db);
  return (await getAccounts(db, year)).find((a) => a.id === id)?.name ?? `#${id}`;
};

const setAccountActive_ = async (db: Database, id: number, active: boolean) => {
  // 現金・事業主貸・事業主借・元入金は仕組みで使うので、非表示にできない
  const code = (await db.select<{ code: string }[]>("SELECT code FROM accounts WHERE id = ?", [id]))[0]?.code;
  if (!active && code && LOCKED_CODES.includes(code)) throw new Error("この科目は仕組みで使うため、非表示にできません");
  await db.execute("UPDATE accounts SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, {
    target_type: "account", target_id: id, action: active ? "show" : "hide",
    fiscal_year: await currentYear(db), label: await accountLabel(db, id), old_value: "", new_value: "",
  });
};

/** 科目の税区分の初期値を変える（決まった初期値と同じなら null に戻す）。今までの仕訳の税区分は変わらない */
const setAccountTaxCode_ = async (db: Database, id: number, code: TaxCode) => {
  if (!isTaxCode(code)) throw new Error("税区分が正しくありません");
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before) return;
  const value = code === builtinTaxCode(before) ? null : code;
  const old = before.default_tax_code ?? builtinTaxCode(before);
  await db.execute("UPDATE accounts SET default_tax_code = ? WHERE id = ?", [value, id]);
  if (old !== code) {
    await logMaster(db, {
      target_type: "account", target_id: id, action: "change", fiscal_year: year, label: before.name,
      old_value: `税区分の初期値 ${taxCodeDef(old).label}`, new_value: `税区分の初期値 ${taxCodeDef(code).label}`,
    });
  }
};

/** 科目の事業区分（簡易課税）の初期値を変える（null = 年度の「主な事業区分」）。今までの仕訳の事業区分は変わらない */
const setAccountBusinessClass_ = async (db: Database, id: number, cls: number | null) => {
  if (cls !== null && !isBusinessClass(cls)) throw new Error("事業区分は第1種〜第6種から選んでください");
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before || before.default_business_class === cls) return;
  await db.execute("UPDATE accounts SET default_business_class = ? WHERE id = ?", [cls, id]);
  const text = (c: number | null) => `事業区分の初期値 ${c ? classLabel(c) : "主な事業区分"}`;
  await logMaster(db, { target_type: "account", target_id: id, action: "change", fiscal_year: year, label: before.name, old_value: text(before.default_business_class), new_value: text(cls) });
};

/** 科目の用途区分（本則課税の個別対応方式）の初期値を変える（null = 共通対応）。今までの仕訳の用途区分は変わらない */
const setAccountPurchaseUse_ = async (db: Database, id: number, use: PurchaseUse | null) => {
  if (use !== null && !isPurchaseUse(use)) throw new Error("用途区分は課税対応・共通対応・非課税対応から選んでください");
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before || before.default_purchase_use === use) return;
  await db.execute("UPDATE accounts SET default_purchase_use = ? WHERE id = ?", [use, id]);
  const text = (u: PurchaseUse | null) => `用途区分の初期値 ${useLabel(u ?? "common")}`;
  await logMaster(db, { target_type: "account", target_id: id, action: "change", fiscal_year: year, label: before.name, old_value: text(before.default_purchase_use), new_value: text(use) });
};

/** 青色申告決算書で書く欄（null = 科目名から自動）。変更は履歴に残す */
const setAccountStatementLine_ = async (db: Database, id: number, line: string | null) => {
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before) return;
  const section = sectionOf(before);
  if (!section) throw new Error("売上（収入）金額の科目は、決算書の欄を選べません");
  if (line !== null && !lineOptions(section).some(([v]) => v === line)) throw new Error("決算書の欄が正しくありません");
  if ((before.statement_line ?? null) === line) return;
  await db.execute("UPDATE accounts SET statement_line = ? WHERE id = ?", [line, id]);
  const text = (l: string | null) => `決算書の欄 ${l === null ? `自動（${autoLineLabel(before)}）` : l === EXTRA_LINE ? "追加の欄" : l}`;
  await logMaster(db, { target_type: "account", target_id: id, action: "change", fiscal_year: year, label: before.name, old_value: text(before.statement_line ?? null), new_value: text(line) });
};
const autoLineLabel = (a: Account) => (autoLine(a) === EXTRA_LINE ? "追加の欄" : autoLine(a));

/** 使われている科目を削除しようとしたときの知らせ */
export const ACCOUNT_IN_USE = "この科目は仕訳・期首残高・家事按分の設定・固定資産台帳・銀行やカードの明細・明細のルールで使われているので削除できません。使わない場合は「使う」のチェックを外してください";

/** 科目の使用件数（仕訳・期首残高・家事按分の設定・固定資産台帳・銀行やカードの明細と列の対応・明細のルール。定型仕訳は削除のときに外す） */
export const accountUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id = ?)
          + (SELECT COUNT(*) FROM opening_balances WHERE account_id = ?)
          + (SELECT COUNT(*) FROM home_use_rates WHERE account_id = ?)
          + (SELECT COUNT(*) FROM fixed_assets WHERE account_id = ?)
          + (SELECT COUNT(*) FROM bank_lines WHERE account_id = ?)
          + (SELECT COUNT(*) FROM bank_formats WHERE account_id = ?)
          + (SELECT COUNT(*) FROM bank_rules WHERE account_id = ? OR target_account_id = ?) AS n`,
    [id, id, id, id, id, id, id, id],
  );
  return r[0].n;
};

/** その区分で次に空いているコード */
export const nextAccountCode = (accounts: Account[], category: AccountCategory): string | null => {
  const [lo, hi] = CATEGORY_CODE_RANGE[category];
  const used = new Set(accounts.map((a) => a.code));
  for (let c = lo; c <= hi; c++) if (!used.has(String(c))) return String(c);
  return null;
};

export interface AccountInputData {
  code: string;
  name: string;
  kana: string;
  category: AccountCategory;
}

export const validateAccount = (accounts: Account[], data: AccountInputData, editingId?: number): string | null => {
  const name = data.name.trim();
  if (!name) return "科目名を入れてください";
  if (name.length > 20) return "科目名は20文字までです";
  if (!/^\d{3}$/.test(data.code)) return "コードは3桁の数字です";
  const [lo, hi] = CATEGORY_CODE_RANGE[data.category];
  const n = Number(data.code);
  if (n < lo || n > hi) return `この区分のコードは ${lo}〜${hi} です`;
  if (accounts.some((a) => a.code === data.code && a.id !== editingId)) return "そのコードはすでに使われています";
  if (accounts.some((a) => a.name === name && a.id !== editingId)) return "同じ名前の科目があります";
  return null;
};

const createAccount_ = async (db: Database, data: AccountInputData) => {
  const res = await db.execute(
    `INSERT INTO accounts (code, name, kana, category, normal_side, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [data.code, data.name.trim(), data.kana.trim(), data.category, normalSideOf(data.category), Number(data.code) * 10],
  );
  await logMaster(db, {
    target_type: "account", target_id: Number(res.lastInsertId), action: "create",
    fiscal_year: await currentYear(db), label: data.name.trim(), old_value: "", new_value: `${data.code} ${data.name.trim()}`,
  });
};

/**
 * 名前・よみ・コードの変更（区分は変えられない：過去の集計が変わってしまうため）
 *  - 厳密モード：名前は「表示中の年度から」変わる。過去の年度は元の名前のまま。変更は履歴に残る
 *  - 通常モード：すべての年度の名前が変わる
 */
const updateAccount_ = async (db: Database, id: number, data: Omit<AccountInputData, "category">) => {
  const year = await currentYear(db);
  const before = (await getAccounts(db, year)).find((a) => a.id === id);
  if (!before) return;
  // 初期科目のコードは変えられない（コードで特別扱いしている科目があり、決算書の並びもコード順のため）
  if (before.is_system && data.code !== before.code) throw new Error("初期の科目はコードを変えられません");
  const name = data.name.trim();
  if (await isStrict(db)) {
    if (name !== before.name) await assertYearOpen(db, year);
    await db.execute("UPDATE accounts SET code = ?, kana = ?, sort_order = ? WHERE id = ?", [
      data.code, data.kana.trim(), Number(data.code) * 10, id,
    ]);
    if (name !== before.name) {
      await db.execute(
        "INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('account', ?, ?, ?) ON CONFLICT (target_type, target_id, from_year) DO UPDATE SET name = excluded.name",
        [id, year, name],
      );
      await logMaster(db, { target_type: "account", target_id: id, action: "rename", fiscal_year: year, label: name, old_value: before.name, new_value: name });
    }
    if (data.code !== before.code) {
      await logMaster(db, { target_type: "account", target_id: id, action: "change", fiscal_year: year, label: name, old_value: `コード ${before.code}`, new_value: `コード ${data.code}` });
    }
  } else {
    await db.execute("UPDATE accounts SET code = ?, name = ?, kana = ?, sort_order = ? WHERE id = ?", [
      data.code, name, data.kana.trim(), Number(data.code) * 10, id,
    ]);
  }
};

/** 追加した科目で、一度も使っていないものだけ削除できる（使ったものは非表示にする） */
const deleteAccount_ = async (db: Database, id: number) => {
  if ((await accountUsage(db, id)) > 0) throw new Error(ACCOUNT_IN_USE);
  const label = await accountLabel(db, id);
  // 定型仕訳からこの科目（とその補助科目）の部分を外す
  const templates = await cleanTemplates_(db, { accountId: id });
  await db.execute("DELETE FROM sub_accounts WHERE account_id = ?", [id]);
  await db.execute("DELETE FROM accounts WHERE id = ? AND is_system = 0", [id]);
  await logMaster(db, { target_type: "account", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
  return templates;
};

// ────────────────────────────────────────────
// 補助科目
// ────────────────────────────────────────────
/** 補助科目（名前はその年度のもの） */
export const getSubAccounts = (db: Database, year: number) =>
  db.select<SubAccount[]>(
    `SELECT s.id, s.account_id, ${effectiveName("sub", "s")} AS name, s.kana, s.sort_order, s.is_active
       FROM sub_accounts s ORDER BY s.account_id, s.sort_order, s.id`,
    [year],
  );

/** 「普通預金 / みずほ銀行」のような履歴用の表示名 */
const subLabel = async (db: Database, id: number) => {
  const year = await currentYear(db);
  const sub = (await getSubAccounts(db, year)).find((x) => x.id === id);
  if (!sub) return `#${id}`;
  return `${await accountLabel(db, sub.account_id)} / ${sub.name}`;
};

export const validateSub = (subs: SubAccount[], accountId: number, name: string, editingId?: number): string | null => {
  const n = name.trim();
  if (!n) return "補助科目名を入れてください";
  if (n.length > 30) return "補助科目名は30文字までです";
  const mine = subs.filter((s) => s.account_id === accountId);
  if (mine.some((s) => s.name === n && s.id !== editingId)) return "同じ名前の補助科目があります";
  if (!editingId && mine.length >= MAX_SUB_ACCOUNTS_PER_ACCOUNT)
    return `補助科目は1科目につき ${MAX_SUB_ACCOUNTS_PER_ACCOUNT} 件までです`;
  return null;
};

const createSub_ = async (db: Database, accountId: number, name: string, kana = "") => {
  const res = await db.execute(
    `INSERT INTO sub_accounts (account_id, name, kana, sort_order)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM sub_accounts WHERE account_id = ?))`,
    [accountId, name.trim(), kana.trim(), accountId],
  );
  const id = Number(res.lastInsertId);
  await logMaster(db, { target_type: "sub", target_id: id, action: "create", fiscal_year: await currentYear(db), label: await subLabel(db, id), old_value: "", new_value: name.trim() });
};

/** 補助科目の名前変更（厳密モードでは表示中の年度から。過去は元の名前） */
const renameSub_ = async (db: Database, id: number, name: string) => {
  const year = await currentYear(db);
  const before = (await getSubAccounts(db, year)).find((x) => x.id === id);
  const n = name.trim();
  if (!before || before.name === n) return;
  if (await isStrict(db)) {
    await assertYearOpen(db, year);
    await db.execute(
      "INSERT INTO master_names (target_type, target_id, from_year, name) VALUES ('sub', ?, ?, ?) ON CONFLICT (target_type, target_id, from_year) DO UPDATE SET name = excluded.name",
      [id, year, n],
    );
    await logMaster(db, { target_type: "sub", target_id: id, action: "rename", fiscal_year: year, label: await subLabel(db, id), old_value: before.name, new_value: n });
  } else {
    await db.execute("UPDATE sub_accounts SET name = ? WHERE id = ?", [n, id]);
  }
};

const setSubActive_ = async (db: Database, id: number, active: boolean) => {
  await db.execute("UPDATE sub_accounts SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, { target_type: "sub", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db), label: await subLabel(db, id), old_value: "", new_value: "" });
};

export const subUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_lines WHERE sub_account_id = ?)
          + (SELECT COUNT(*) FROM opening_balances WHERE sub_account_id = ?)
          + (SELECT COUNT(*) FROM bank_lines WHERE sub_account_id = ?)
          + (SELECT COUNT(*) FROM bank_formats WHERE sub_account_id = ?)
          + (SELECT COUNT(*) FROM bank_rules WHERE sub_account_id = ?) AS n`,
    [id, id, id, id, id],
  );
  return r[0].n;
};

const deleteSub_ = async (db: Database, id: number) => {
  const label = await subLabel(db, id);
  // 定型仕訳からこの補助科目を外す（科目は残す）
  const templates = await cleanTemplates_(db, { subId: id });
  await db.execute("DELETE FROM sub_accounts WHERE id = ?", [id]);
  await logMaster(db, { target_type: "sub", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });  return templates;
};

// ────────────────────────────────────────────
// 取引先（任意で使う）
//  厳密モードでは追加・変更・非表示・削除を master_history に残す
// ────────────────────────────────────────────
export const getCounterparties = (db: Database) =>
  db.select<Counterparty[]>("SELECT id, name, kana, invoice_no, not_registered, memo, is_active FROM counterparties ORDER BY kana = '', kana, name");

const counterpartyName = async (db: Database, id: number | null | undefined) => {
  if (!id) return "";
  const r = await db.select<{ name: string }[]>("SELECT name FROM counterparties WHERE id = ?", [id]);
  return r[0]?.name ?? `#${id}`;
};

const cpText = (c: { name: string; invoice_no: string; not_registered: number; memo: string }) =>
  [c.name, c.invoice_no && `登録番号 ${c.invoice_no}`, c.not_registered ? "適格請求書発行事業者ではない" : "", c.memo && `メモ：${c.memo}`]
    .filter(Boolean).join("　");

const cpRow = (d: CounterpartyInput) => {
  const invoice_no = normalizeInvoiceNo(d.invoice_no);
  // 登録番号がある取引先は「適格請求書発行事業者ではない」にしない
  return { name: d.name.trim(), kana: d.kana.trim(), invoice_no, not_registered: d.not_registered && !invoice_no ? 1 : 0, memo: d.memo.trim() };
};

const createCounterparty_ = async (db: Database, d: CounterpartyInput) => {
  const c = cpRow(d);
  const res = await db.execute(
    "INSERT INTO counterparties (name, kana, invoice_no, not_registered, memo) VALUES (?, ?, ?, ?, ?)",
    [c.name, c.kana, c.invoice_no, c.not_registered, c.memo],
  );
  const id = Number(res.lastInsertId);
  await logMaster(db, {
    target_type: "counterparty", target_id: id, action: "create", fiscal_year: await currentYear(db), label: c.name, old_value: "", new_value: cpText(c),
  });
  return id;
};

/** 名前の変更はすべての年度・過去の仕訳の表示に反映される（履歴の写しには記録時点の名前が残る） */
const updateCounterparty_ = async (db: Database, id: number, d: CounterpartyInput) => {
  const before = (await getCounterparties(db)).find((c) => c.id === id);
  if (!before) return;
  const c = cpRow(d);
  await db.execute("UPDATE counterparties SET name = ?, kana = ?, invoice_no = ?, not_registered = ?, memo = ? WHERE id = ?", [
    c.name, c.kana, c.invoice_no, c.not_registered, c.memo, id,
  ]);
  const year = await currentYear(db);
  if (c.name !== before.name) {
    await logMaster(db, { target_type: "counterparty", target_id: id, action: "rename", fiscal_year: year, label: c.name, old_value: before.name, new_value: c.name });
  }
  if (c.invoice_no !== before.invoice_no || c.not_registered !== before.not_registered || c.memo !== before.memo) {
    await logMaster(db, { target_type: "counterparty", target_id: id, action: "change", fiscal_year: year, label: c.name, old_value: cpText(before), new_value: cpText(c) });
  }
};

const setCounterpartyActive_ = async (db: Database, id: number, active: boolean) => {
  await db.execute("UPDATE counterparties SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, {
    target_type: "counterparty", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db),
    label: await counterpartyName(db, id), old_value: "", new_value: "",
  });
};

/** 使用件数（仕訳・証憑） */
/** 取引先の使用件数（仕訳・証憑・定型仕訳・明細のルール） */
export const counterpartyUsage = async (db: Database, id: number) => {
  const r = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE counterparty_id = ?)
          + (SELECT COUNT(*) FROM evidences WHERE counterparty_id = ?)
          + (SELECT COUNT(*) FROM journal_templates WHERE counterparty_id = ?)
          + (SELECT COUNT(*) FROM bank_rules WHERE counterparty_id = ?) AS n`,
    [id, id, id, id],
  );
  return r[0].n;
};

/** 一度も使っていない取引先だけ削除できる（使ったものは非表示にする） */
const deleteCounterparty_ = async (db: Database, id: number) => {
  if ((await counterpartyUsage(db, id)) > 0) throw new Error("この取引先は仕訳・証憑・定型仕訳・明細のルールで使われているので削除できません。非表示にしてください");
  const label = await counterpartyName(db, id);
  await db.execute("DELETE FROM counterparties WHERE id = ?", [id]);
  await logMaster(db, { target_type: "counterparty", target_id: id, action: "delete", fiscal_year: await currentYear(db), label, old_value: label, new_value: "" });
};

// ────────────────────────────────────────────
// 定型仕訳（帳簿そのものではないので履歴には残さない）
// ────────────────────────────────────────────
export const getTemplates = async (db: Database): Promise<JournalTemplate[]> =>
  (await db.select<{ id: number; name: string; rows: string; counterparty_id: number | null }[]>(
    "SELECT id, name, rows, counterparty_id FROM journal_templates ORDER BY name",
  )).map((t) => ({ ...t, rows: JSON.parse(t.rows) }));

const createTemplate_ = async (db: Database, name: string, rows: VoucherRow[], counterpartyId: number | null) => {
  const nameErr = validateTemplateName(await getTemplates(db), name);
  if (nameErr) throw new Error(nameErr);
  const t = templateRows(rows);
  if (t.error) throw new Error(t.error);
  const res = await db.execute("INSERT INTO journal_templates (name, rows, counterparty_id) VALUES (?, ?, ?)", [name.trim(), JSON.stringify(t.rows), counterpartyId]);
  return Number(res.lastInsertId);
};

/** 中身を今の伝票で置き換える（名前はそのまま） */
const overwriteTemplate_ = async (db: Database, id: number, rows: VoucherRow[], counterpartyId: number | null) => {
  const t = templateRows(rows);
  if (t.error) throw new Error(t.error);
  await db.execute(
    "UPDATE journal_templates SET rows = ?, counterparty_id = ?, updated_at = DATETIME('now','localtime') WHERE id = ?",
    [JSON.stringify(t.rows), counterpartyId, id],
  );
};

const renameTemplate_ = async (db: Database, id: number, name: string) => {
  const err = validateTemplateName(await getTemplates(db), name, id);
  if (err) throw new Error(err);
  await db.execute("UPDATE journal_templates SET name = ?, updated_at = DATETIME('now','localtime') WHERE id = ?", [name.trim(), id]);
};

const deleteTemplate_ = (db: Database, id: number) => db.execute("DELETE FROM journal_templates WHERE id = ?", [id]);

type TemplateTarget = { accountId?: number; subId?: number };

/** その科目（補助科目）を使っている定型仕訳の名前（科目を消す前の確認に使う） */
export const templatesUsing = async (db: Database, target: TemplateTarget) =>
  (await getTemplates(db)).filter((t) => removeFromTemplate(t.rows, target).changed).map((t) => t.name);

/**
 * 科目（補助科目）を消すときに、定型仕訳からその部分を外す。科目が1つも残らない定型仕訳は消す
 * 外したあとの貸借は確かめない（呼び出して登録するときに確かめられる）
 */
const cleanTemplates_ = async (db: Database, target: TemplateTarget) => {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const t of await getTemplates(db)) {
    const r = removeFromTemplate(t.rows, target);
    if (!r.changed) continue;
    if (r.empty) {
      await deleteTemplate_(db, t.id);
      deleted.push(t.name);
    } else {
      await db.execute("UPDATE journal_templates SET rows = ?, updated_at = DATETIME('now','localtime') WHERE id = ?", [JSON.stringify(r.rows), t.id]);
      changed.push(t.name);
    }
  }
  return { changed, deleted };
};

/** 名前が取引先一覧の名前と一致すれば、その取引先（証憑の取引先名から引く） */
const counterpartyIdByName = async (db: Database, name: string) => {
  const r = await db.select<{ id: number }[]>("SELECT id FROM counterparties WHERE name = ?", [name.trim()]);
  return r[0]?.id ?? null;
};

// ────────────────────────────────────────────
// 期首残高
// ────────────────────────────────────────────
export interface OpeningData {
  /** 科目ごとの合計（補助科目の分も含む） */
  byAccount: OpeningBalances;
  /** "科目ID:補助ID" ごとの金額（補助ID 0 = 補助なし） */
  bySub: SubOpeningBalances;
}

export const getOpening = async (db: Database, year: number): Promise<OpeningData> => {
  const rows = await db.select<{ account_id: number; sub_account_id: number; amount: number }[]>(
    "SELECT account_id, sub_account_id, amount FROM opening_balances WHERE fiscal_year = ?",
    [year],
  );
  const byAccount: OpeningBalances = {};
  const bySub: SubOpeningBalances = {};
  for (const r of rows) {
    byAccount[r.account_id] = (byAccount[r.account_id] ?? 0) + r.amount;
    bySub[subKey(r.account_id, r.sub_account_id || null)] = r.amount;
  }
  return { byAccount, bySub };
};

export const hasOpening = async (db: Database, year: number) => {
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM opening_balances WHERE fiscal_year = ?", [year]);
  return rows[0].n > 0;
};

/** bySub（"科目ID:補助ID" → 金額）をそのまま保存する */
const saveOpening_ = async (db: Database, year: number, bySub: SubOpeningBalances, viaCarryForward = false) => {
  await assertYearOpen(db, year);
  const items = Object.entries(bySub).filter(([, v]) => v !== 0);
  const before = (await getOpening(db, year)).bySub;

  await db.execute("DELETE FROM opening_balances WHERE fiscal_year = ?", [year]);
  if (items.length > 0) {
    const placeholders = items.map(() => "(?, ?, ?, ?)").join(", ");
    const params = items.flatMap(([k, v]) => {
      const [acc, sub] = k.split(":").map(Number);
      return [year, acc, sub, v];
    });
    await db.execute(
      `INSERT INTO opening_balances (fiscal_year, account_id, sub_account_id, amount) VALUES ${placeholders}`,
      params,
    );
  }

  // 厳密モード：変わった金額を履歴に残す（書き込んだあとに記録する。記録の連鎖に変更後の状態を残すため）
  if (await isStrict(db)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(bySub)]);
    const accounts = await getAccounts(db, year);
    const subs = await getSubAccounts(db, year);
    for (const k of keys) {
      const o = before[k] ?? 0;
      const n = bySub[k] ?? 0;
      if (o === n) continue;
      const [acc, sub] = k.split(":").map(Number);
      const label = (accounts.find((a) => a.id === acc)?.name ?? `#${acc}`) + (sub ? ` / ${subs.find((x) => x.id === sub)?.name ?? ""}` : "");
      await logMaster(db, {
        target_type: "opening", target_id: acc, action: "change", fiscal_year: year,
        label: viaCarryForward ? `${label}（繰越処理）` : label, old_value: String(o), new_value: String(n),
      });
    }
  }
};

// ────────────────────────────────────────────
// 仕訳
// ────────────────────────────────────────────

/**
 * 期間内の仕訳明細を、日付・摘要つきで取得する（既定では削除済みを除く）
 * created_at（登録日時）は、厳密モードでは登録時の履歴の日時を使う（記録の連鎖に入っているので、直接書き換えると見つかる）
 */
export const getLines = (db: Database, from: string, to: string, includeDeleted = false) =>
  db.select<FlatLine[]>(
    `SELECT l.entry_id, e.date, e.description, e.is_deleted, e.revision, e.counterparty_id, e.is_adjustment, l.row_no, l.side,
            l.account_id, l.sub_account_id, l.amount, l.memo, l.tax_code, l.invoice_kind, l.business_class, l.purchase_use,
            COALESCE((SELECT h.recorded_at FROM entry_history h WHERE h.entry_id = e.id AND h.action = 'create'), e.created_at) AS created_at
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.date BETWEEN ? AND ? ${includeDeleted ? "" : "AND e.is_deleted = 0"}
      ORDER BY e.date, l.entry_id, l.row_no, CASE l.side WHEN 'debit' THEN 0 ELSE 1 END`,
    [from, to],
  );

export const getEntry = async (db: Database, id: number): Promise<JournalEntry | null> => {
  const e = await db.select<Omit<JournalEntry, "lines">[]>(
    `SELECT e.id, e.date, e.description, e.counterparty_id, e.revision, e.is_deleted, e.is_adjustment, e.created_at, e.updated_at,
            cu.name AS created_by_name, uu.name AS updated_by_name
       FROM journal_entries e LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by
      WHERE e.id = ?`,
    [id],
  );
  if (e.length === 0) return null;
  const lines = await db.select<JournalLine[]>(
    `SELECT id, entry_id, row_no, side, account_id, sub_account_id, amount, memo, tax_code, invoice_kind, business_class, purchase_use
       FROM journal_lines WHERE entry_id = ? ORDER BY row_no, CASE side WHEN 'debit' THEN 0 ELSE 1 END`,
    [id],
  );
  return { ...e[0], lines };
};

const insertLines = async (db: Database, entryId: number, lines: JournalLine[]) => {
  // 1文でまとめて INSERT（途中で失敗しても半端な明細が残らない）
  const placeholders = lines.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = lines.flatMap((l) => [
    entryId, l.row_no, l.side, l.account_id, l.sub_account_id, l.amount, l.memo, l.tax_code ?? null, l.invoice_kind ?? null, l.business_class ?? null,
    l.purchase_use ?? null,
  ]);
  await db.execute(
    `INSERT INTO journal_lines (entry_id, row_no, side, account_id, sub_account_id, amount, memo, tax_code, invoice_kind, business_class, purchase_use)
     VALUES ${placeholders}`,
    params,
  );
};

/**
 * 保存する明細の税区分をそろえる（lib/tax.ts の resolveLineTax）。
 * 課税事業者の期間なら、入っていない税区分を科目の初期値で、インボイス区分を取引先の初期値で埋める。免税事業者の期間なら外す
 * 簡易課税の年の課税売上には事業区分を記録する（明細 → 科目の初期値 → 主な事業区分）。stampMain = false なら「主な事業区分」は入れない（CSV 取り込み：区分の無い売上は不明のまま）
 * 本則課税の年の課税仕入には用途区分を記録する（明細 → 科目の初期値 → 共通対応）。stampMain = false なら共通対応は入れない（分からないまま）
 */
const withTax = async (db: Database, date: string, lines: JournalLine[], counterpartyId: number | null, stampMain = true) => {
  const years = await getTaxYears(db);
  const active = taxActiveOn(years, date);
  if (!active) return resolveLineTax(lines, false, () => undefined, null);
  const accounts = new Map((await getAccounts(db, Number(date.slice(0, 4)))).map((a) => [a.id, a]));
  const cp = counterpartyId ? (await getCounterparties(db)).find((c) => c.id === counterpartyId) : null;
  const ty = taxYearOf(years, Number(date.slice(0, 4)));
  return resolveLineTax(
    lines, true, (id) => accounts.get(id), cp,
    stampMain && ty.status === "simplified" ? ty.business_class : null,
    stampMain && ty.status === "standard" ? "common" : null,
  );
};

const descriptionOf = (lines: JournalLine[]) => lines.find((l) => l.memo)?.memo ?? "";

/** 履歴用の写しを作る（科目名は今の名前で固定して残す） */
const makeSnapshot = async (
  db: Database, date: string, lines: JournalLine[], counterpartyId: number | null = null, adjustment = false,
): Promise<EntrySnapshot> => {
  // 仕訳の日付の年度で使われている名前で残す
  const year = Number(date.slice(0, 4));
  const accounts = await getAccounts(db, year);
  const subs = await getSubAccounts(db, year);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const counterparty = await counterpartyName(db, counterpartyId);
  return {
    date,
    ...(counterparty ? { counterparty } : {}),
    ...(adjustment ? { adjustment: true as const } : {}),
    lines: lines.map((l) => ({
      side: l.side,
      account: an.get(l.account_id) ?? `#${l.account_id}`,
      sub: l.sub_account_id ? sn.get(l.sub_account_id) ?? "" : "",
      amount: l.amount,
      memo: l.memo,
      ...(l.tax_code ? { tax: l.tax_code } : {}),
      ...(l.invoice_kind ? { invoice: l.invoice_kind } : {}),
      ...(l.business_class ? { cls: l.business_class } : {}),
      ...(l.purchase_use ? { use: l.purchase_use } : {}),
    })),
  };
};

const writeHistory = async (
  db: Database, entryId: number, revision: number, action: HistoryAction, snapshot: EntrySnapshot, reason: string,
) => {
  const res = await db.execute(
    "INSERT INTO entry_history (entry_id, revision, action, reason, snapshot, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    [entryId, revision, action, reason.trim(), JSON.stringify(snapshot), currentActor],
  );
  await appendChain(db, "entry_history", Number(res.lastInsertId), `entry:${entryId}`);
};

/** 決算整理仕訳は年度末の日付だけ */
export const ADJUSTMENT_DATE_MESSAGE = "決算整理の仕訳は、年度末の日付（12月31日）にしてください";
const assertAdjustmentDate = (date: string, adjustment: boolean) => {
  if (adjustment && date !== yearEnd(Number(date.slice(0, 4)))) throw new Error(ADJUSTMENT_DATE_MESSAGE);
};

/**
 * reason は登録の履歴に残す補足（CSV 取り込みなど。厳密モードのみ）
 * adjustment = true で決算整理仕訳（日付は年度末）
 */
const createEntry_ = async (
  db: Database, date: string, input: JournalLine[], counterpartyId: number | null = null, reason = "", adjustment = false, stampMainClass = true,
) => {
  await assertDateOpen(db, date);
  assertAdjustmentDate(date, adjustment);
  const lines = await withTax(db, date, input, counterpartyId, stampMainClass);
  const res = await db.execute(
    "INSERT INTO journal_entries (date, description, counterparty_id, is_adjustment, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
    [date, descriptionOf(lines), counterpartyId, adjustment ? 1 : 0, currentActor, currentActor],
  );
  const entryId = Number(res.lastInsertId);
  // 途中で失敗しても tx() が丸ごと取り消す
  await insertLines(db, entryId, lines);
  if (await isStrict(db)) await writeHistory(db, entryId, 1, "create", await makeSnapshot(db, date, lines, counterpartyId, adjustment), reason);
  return entryId;
};

/**
 * 仕訳をまとめて登録する（CSV 取り込み）。1つのトランザクションなので、途中で失敗したら1件も残らない
 * 中身の確かめは lib/journalImport.ts で済ませておく（ここでも締め済みの年度などは拒否される）
 */
const importEntries_ = async (
  db: Database, entries: { date: string; lines: JournalLine[]; counterpartyId: number | null; adjustment?: boolean }[], source: string,
) => {
  const ids: number[] = [];
  // 事業区分を指定していない売上は「不明」のまま取り込む（主な事業区分は入れない。確認の一覧で知らせる）
  for (const e of entries) ids.push(await createEntry_(db, e.date, e.lines, e.counterpartyId, `CSV 取り込み（${source}）`, !!e.adjustment, false));
  return ids;
};

/** 訂正：仕訳を書き換える。厳密モードでは新しい版を履歴に積む */
/** counterpartyId・adjustment を省くとそのまま（取引先は null を渡すと外す） */
const updateEntry_ = async (
  db: Database, id: number, date: string, input: JournalLine[], reason = "", counterpartyId?: number | null, adjustment?: boolean,
) => {
  const before = await getEntry(db, id);
  if (!before) throw new Error("仕訳が見つかりません");
  if (before.is_deleted) throw new Error("削除済みの仕訳は訂正できません");
  // 元の日付・新しい日付のどちらかが締め済みの年度なら訂正できない（明細だけ書き換わるのを防ぐため先に確認）
  await assertDateOpen(db, before.date);
  await assertDateOpen(db, date);
  const revision = before.revision + 1;
  const cp = counterpartyId === undefined ? before.counterparty_id : counterpartyId;
  const adj = adjustment === undefined ? before.is_adjustment === 1 : adjustment;
  assertAdjustmentDate(date, adj);
  const lines = await withTax(db, date, input, cp);

  await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
  await insertLines(db, id, lines);
  await db.execute(
    `UPDATE journal_entries SET date = ?, description = ?, counterparty_id = ?, is_adjustment = ?, revision = ?, updated_by = ?,
            updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [date, descriptionOf(lines), cp, adj ? 1 : 0, revision, currentActor, id],
  );
  if (await isStrict(db)) await writeHistory(db, id, revision, "update", await makeSnapshot(db, date, lines, cp, adj), reason);
};

/** 削除：厳密モードでは消さずに「削除済み」にし、削除時点の内容を履歴に残す */
const deleteEntry_ = async (db: Database, id: number, reason = "") => {
  const before = await getEntry(db, id);
  if (!before || before.is_deleted) return;
  await assertDateOpen(db, before.date);
  // 通常モード：本当に消す（履歴が無いのでトリガーにも止められない）
  if (!(await isStrict(db))) {
    // 証憑そのものは残し、この仕訳とのひも付けだけ外す
    await db.execute("DELETE FROM evidence_links WHERE entry_id = ?", [id]);
    // 家事按分の年末振替の仕訳なら、振替の記録も消す（次は作り直しになる）
    await db.execute("DELETE FROM home_use_runs WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM depreciation_runs WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM journal_lines WHERE entry_id = ?", [id]);
    await db.execute("DELETE FROM journal_entries WHERE id = ?", [id]);
    return;
  }
  const revision = before.revision + 1;
  await db.execute(
    `UPDATE journal_entries SET is_deleted = 1, revision = ?, updated_by = ?, deleted_at = DATETIME('now','localtime'),
            updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [revision, currentActor, id],
  );
  await writeHistory(db, id, revision, "delete", await makeSnapshot(db, before.date, before.lines, before.counterparty_id, before.is_adjustment === 1), reason);
};

/**
 * 税区分が入っていない仕訳（課税事業者の期間の、削除済みでない仕訳）の伝票番号。簡易課税の年は、事業区分の無い課税売上がある仕訳も。
 * 本則課税の年は、用途区分の無い課税仕入がある仕訳も。
 * 免税事業者から課税事業者に変えた年、本則課税から簡易課税に変えた年、消費税に対応する前に入れた仕訳を、あとから埋めるときに使う
 */
export const untaxedEntryIds = async (db: Database, year: number) => {
  const rows = await getTaxYears(db);
  const status = taxYearOf(rows, year).status;
  const r = await db.select<{ id: number; date: string }[]>(
    `SELECT DISTINCT e.id, e.date FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.is_deleted = 0 AND e.date BETWEEN ? AND ?
        AND (l.tax_code IS NULL
             ${status === "simplified" ? "OR (l.tax_code IN ('sales10','sales8') AND l.business_class IS NULL)" : ""}
             ${status === "standard" ? "OR (l.tax_code IN ('purchase10','purchase8') AND l.purchase_use IS NULL)" : ""})
      ORDER BY e.date, e.id`,
    [yearStart(year), yearEnd(year)],
  );
  return r.filter((x) => taxActiveOn(rows, x.date)).map((x) => ({ id: x.id, date: x.date }));
};

export const FILL_TAX_REASON = "税区分を科目の初期値で一括設定";

/**
 * 税区分が入っていない仕訳に、科目の初期値（インボイス区分は取引先の初期値）を入れる。
 * 1件ずつ訂正として保存する（厳密モードでは訂正の履歴が残る）。締めた月の仕訳は飛ばす
 */
const fillTaxCodes_ = async (db: Database, year: number) => {
  let updated = 0, closed = 0;
  for (const { id, date } of await untaxedEntryIds(db, year)) {
    try {
      await assertDateOpen(db, date);
    } catch {
      closed++;
      continue;
    }
    const e = await getEntry(db, id);
    if (!e) continue;
    // 入っている税区分はそのまま、空のところだけ埋める
    await updateEntry_(db, id, e.date, e.lines, FILL_TAX_REASON);
    updated++;
  }
  return { updated, closed };
};

interface HistoryRow extends Omit<HistoryRecord, "snapshot"> { snapshot: string }

/** 履歴（entryId を渡せばその仕訳だけ）。新しい順 */
export const getHistory = async (db: Database, entryId?: number): Promise<HistoryRecord[]> => {
  const rows = await db.select<HistoryRow[]>(
    `SELECT h.id, h.entry_id, h.revision, h.action, h.recorded_at, h.reason, h.snapshot, u.name AS user_name
       FROM entry_history h LEFT JOIN users u ON u.id = h.user_id
      ${entryId ? "WHERE h.entry_id = ?" : ""} ORDER BY h.id DESC`,
    entryId ? [entryId] : [],
  );
  return rows.map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) as EntrySnapshot }));
};

/** 摘要の入力候補（よく使う順） */
export const getMemoSuggestions = async (db: Database) => {
  const rows = await db.select<{ memo: string }[]>(
    `SELECT memo FROM journal_lines WHERE memo <> '' GROUP BY memo ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT 300`,
  );
  return rows.map((r) => r.memo);
};

/** データがある年度の一覧 */
export const getYears = async (db: Database, current: number) => {
  const rows = await db.select<{ y: string }[]>(
    `SELECT DISTINCT substr(date, 1, 4) AS y FROM journal_entries WHERE is_deleted = 0
     UNION SELECT DISTINCT CAST(fiscal_year AS TEXT) FROM opening_balances`,
  );
  const set = new Set(rows.map((r) => Number(r.y)));
  set.add(current);
  return [...set].sort((a, b) => b - a);
};

// ────────────────────────────────────────────
// 家事按分
// ────────────────────────────────────────────

/** その年度に有効な按分設定（科目ごとに、from_year が年度以下で最新のもの） */
export const getHomeUseRates = (db: Database, year: number) =>
  db.select<HomeUseRate[]>(
    `SELECT h.account_id, h.from_year, h.rate, h.method, h.basis FROM home_use_rates h
      WHERE h.from_year = (SELECT MAX(x.from_year) FROM home_use_rates x WHERE x.account_id = h.account_id AND x.from_year <= ?)`,
    [year],
  );

/** 按分設定を保存する（その年度から適用。前の年度の設定はそのまま残る） */
const saveHomeUseRate_ = async (db: Database, year: number, rate: Omit<HomeUseRate, "from_year">) => {
  await assertYearOpen(db, year);
  const before = (await getHomeUseRates(db, year)).find((r) => r.account_id === rate.account_id);
  await db.execute(
    `INSERT INTO home_use_rates (account_id, from_year, rate, method, basis) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, from_year) DO UPDATE SET rate = excluded.rate, method = excluded.method, basis = excluded.basis`,
    [rate.account_id, year, rate.rate, rate.method, rate.basis.trim()],
  );
  const fmt = (r?: Omit<HomeUseRate, "from_year">) =>
    r ? `事業 ${r.rate}%（${r.method === "entry" ? "入力時" : "年末一括"}）${r.basis ? " 根拠：" + r.basis : ""}` : "設定なし";
  await logMaster(db, {
    target_type: "homeuse", target_id: rate.account_id, action: "change", fiscal_year: year,
    label: await accountLabel(db, rate.account_id), old_value: fmt(before), new_value: fmt(rate),
  });
};

export const getHomeUseRun = async (db: Database, year: number) => {
  const r = await db.select<{ entry_id: number }[]>(
    `SELECT r.entry_id FROM home_use_runs r JOIN journal_entries e ON e.id = r.entry_id
      WHERE r.fiscal_year = ? AND e.is_deleted = 0`,
    [year],
  );
  return r[0]?.entry_id ?? null;
};

const setHomeUseRun_ = (db: Database, year: number, entryId: number) =>
  db.execute(
    "INSERT INTO home_use_runs (fiscal_year, entry_id) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET entry_id = excluded.entry_id",
    [year, entryId],
  );

// ────────────────────────────────────────────
// 固定資産台帳・減価償却（計算は lib/depreciation.ts）
//  - 台帳の追加・変更・削除は履歴に残す（厳密モード）
//  - 年末の減価償却の仕訳は年度ごとに1本（depreciation_runs）。作り直すときは同じ仕訳を訂正する
// ────────────────────────────────────────────
export type AssetInput = Omit<FixedAsset, "id">;

export const getAssets = (db: Database) =>
  db.select<FixedAsset[]>(
    `SELECT id, name, account_id, acquired_on, used_on, cost, method, useful_life, business_rate, opening_year, opening_book_value, disposed_on, memo
       FROM fixed_assets ORDER BY used_on, id`,
  );

const assetText = (a: AssetInput) =>
  [
    `取得 ${a.acquired_on}`, `使用開始 ${a.used_on}`, `取得価額 ${a.cost.toLocaleString()}円`,
    METHOD_LABEL[a.method] + (a.method === "straight" ? ` ${a.useful_life}年` : ""), `事業 ${a.business_rate}%`,
    a.opening_year !== null ? `${a.opening_year}年期首の未償却残高 ${a.opening_book_value?.toLocaleString()}円` : "",
    a.disposed_on ? `売却・除却 ${a.disposed_on}` : "",
    a.memo ? `備考 ${a.memo}` : "",
  ].filter(Boolean).join("、");

const normalizeAsset = (a: AssetInput): AssetInput => ({
  ...a,
  name: a.name.trim(),
  memo: a.memo.trim(),
  useful_life: a.method === "straight" ? a.useful_life : 0,
  disposed_on: a.disposed_on || null,
});

const assertAsset = async (db: Database, a: AssetInput) => {
  const settings = await getSettings(db);
  const e = validateAsset(a, { blue: settings.filing_type !== "white" });
  if (e) throw new Error(e);
  const acc = await db.select<{ category: string }[]>("SELECT category FROM accounts WHERE id = ?", [a.account_id]);
  if (acc[0]?.category !== "asset") throw new Error("資産の科目を選んでください");
};

/** 追加（id = null）・変更。id を返す */
const saveAsset_ = async (db: Database, id: number | null, input: AssetInput) => {
  const a = normalizeAsset(input);
  await assertAsset(db, a);
  const values = [a.name, a.account_id, a.acquired_on, a.used_on, a.cost, a.method, a.useful_life, a.business_rate, a.opening_year, a.opening_book_value, a.disposed_on, a.memo];
  const fiscal_year = await currentYear(db);
  if (id === null) {
    const r = await db.execute(
      `INSERT INTO fixed_assets (name, account_id, acquired_on, used_on, cost, method, useful_life, business_rate, opening_year, opening_book_value, disposed_on, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
    );
    const newId = Number(r.lastInsertId);
    await logMaster(db, { target_type: "asset", target_id: newId, action: "create", fiscal_year, label: a.name, old_value: "", new_value: assetText(a) });
    return newId;
  }
  const before = (await getAssets(db)).find((x) => x.id === id);
  if (!before) throw new Error("固定資産が見つかりません");
  await db.execute(
    `UPDATE fixed_assets SET name = ?, account_id = ?, acquired_on = ?, used_on = ?, cost = ?, method = ?, useful_life = ?, business_rate = ?,
       opening_year = ?, opening_book_value = ?, disposed_on = ?, memo = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [...values, id],
  );
  const [oldText, newText] = [assetText(before), assetText(a)];
  if (oldText !== newText || before.name !== a.name || before.account_id !== a.account_id) {
    await logMaster(db, { target_type: "asset", target_id: id, action: "change", fiscal_year, label: a.name, old_value: `${before.name}：${oldText}`, new_value: `${a.name}：${newText}` });
  }
  return id;
};

/** 削除（間違えて登録したとき。売ったり捨てたりしたときは「売却・除却した日」を入れる） */
const deleteAsset_ = async (db: Database, id: number) => {
  const before = (await getAssets(db)).find((x) => x.id === id);
  if (!before) return;
  await db.execute("DELETE FROM fixed_assets WHERE id = ?", [id]);
  await logMaster(db, { target_type: "asset", target_id: id, action: "delete", fiscal_year: await currentYear(db), label: before.name, old_value: assetText(before), new_value: "" });
};

export const getDepreciationRun = async (db: Database, year: number) => {
  const r = await db.select<{ entry_id: number }[]>(
    `SELECT r.entry_id FROM depreciation_runs r JOIN journal_entries e ON e.id = r.entry_id
      WHERE r.fiscal_year = ? AND e.is_deleted = 0`,
    [year],
  );
  return r[0]?.entry_id ?? null;
};

/**
 * 年末の減価償却の仕訳を作る（作り直すときは同じ仕訳を訂正する。償却する資産が無くなったら、その仕訳を削除する）。
 * 12月31日付の決算整理仕訳。仕訳の id を返す（削除したときは null）
 */
const saveDepreciationRun_ = async (db: Database, year: number, lines: JournalLine[]) => {
  await assertYearOpen(db, year);
  const runId = await getDepreciationRun(db, year);
  if (lines.length === 0) {
    if (runId) await deleteEntry_(db, runId, "減価償却の再計算（償却する資産なし）");
    return null;
  }
  if (runId) {
    await updateEntry_(db, runId, yearEnd(year), lines, "減価償却の再計算", null, true);
    return runId;
  }
  const id = await createEntry_(db, yearEnd(year), lines, null, "", true);
  await db.execute(
    "INSERT INTO depreciation_runs (fiscal_year, entry_id) VALUES (?, ?) ON CONFLICT (fiscal_year) DO UPDATE SET entry_id = excluded.entry_id",
    [year, id],
  );
  return id;
};

// ────────────────────────────────────────────
// 決算書に手で書き込む欄（帳簿から出せない項目。帳簿そのものではないので履歴には残さない）
// ────────────────────────────────────────────
export const getStatementNotes = async (db: Database, year: number) => {
  const r = await db.select<{ note_key: string; value: string }[]>("SELECT note_key, value FROM statement_notes WHERE fiscal_year = ?", [year]);
  return Object.fromEntries(r.map((x) => [x.note_key, x.value])) as Record<string, string>;
};

const saveStatementNote_ = async (db: Database, year: number, key: string, value: string) => {
  await assertYearOpen(db, year);
  const v = value.trim().slice(0, 500);
  if (!v) await db.execute("DELETE FROM statement_notes WHERE fiscal_year = ? AND note_key = ?", [year, key]);
  else {
    await db.execute(
      `INSERT INTO statement_notes (fiscal_year, note_key, value) VALUES (?, ?, ?)
       ON CONFLICT (fiscal_year, note_key) DO UPDATE SET value = excluded.value`,
      [year, key, v],
    );
  }
};

// ────────────────────────────────────────────
// 証憑
//  - ファイルの中身は登録後に変えられない（トリガーでも拒否）
//  - 厳密モード：削除せず無効の印。登録・訂正・無効・ひも付けを evidence_history に残す
//  - 通常モード：履歴なし。削除は物理削除
// ────────────────────────────────────────────
interface EvidenceRow extends Omit<Evidence, "entry_ids"> { entry_ids: string | null }

const EVIDENCE_COLUMNS = `ev.id, ev.counterparty_id, ev.kind, ev.doc_type, ev.doc_class, ev.scan_info, ev.txn_date, ev.received_date, ev.amount, ev.counterparty, ev.memo, ev.file_name, ev.mime, ev.size,
  ev.sha256, ev.revision, ev.is_void, ev.created_at, ev.updated_at, ev.voided_at,
  (SELECT GROUP_CONCAT(entry_id) FROM (SELECT entry_id FROM evidence_links WHERE evidence_id = ev.id ORDER BY entry_id)) AS entry_ids,
  COALESCE((SELECT h.recorded_at FROM evidence_history h WHERE h.evidence_id = ev.id AND h.action = 'create'), ev.created_at) AS registered_at`;

const toEvidence = (r: EvidenceRow): Evidence => ({
  ...r,
  entry_ids: r.entry_ids ? String(r.entry_ids).split(",").map(Number) : [],
});

/** 証憑の一覧（ファイルの中身は含まない）。新しい取引年月日から */
export const getEvidences = async (db: Database) =>
  (await db.select<EvidenceRow[]>(`SELECT ${EVIDENCE_COLUMNS} FROM evidences ev ORDER BY ev.txn_date DESC, ev.id DESC`)).map(toEvidence);

export const getEvidence = async (db: Database, id: number) => {
  const r = await db.select<EvidenceRow[]>(`SELECT ${EVIDENCE_COLUMNS} FROM evidences ev WHERE ev.id = ?`, [id]);
  return r[0] ? toEvidence(r[0]) : null;
};

/** 仕訳にひも付いている証憑 */
export const getEntryEvidences = async (db: Database, entryId: number) =>
  (await db.select<EvidenceRow[]>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidences ev JOIN evidence_links l ON l.evidence_id = ev.id
      WHERE l.entry_id = ? ORDER BY ev.txn_date, ev.id`,
    [entryId],
  )).map(toEvidence);

/** 仕訳ごとの証憑の件数（無効を除く）。伝票番号 → 件数 */
export const getEvidenceCounts = async (db: Database) => {
  const rows = await db.select<{ entry_id: number; n: number }[]>(
    `SELECT l.entry_id, COUNT(*) AS n FROM evidence_links l JOIN evidences ev ON ev.id = l.evidence_id
      WHERE ev.is_void = 0 GROUP BY l.entry_id`,
  );
  return new Map(rows.map((r) => [r.entry_id, r.n]));
};

/** ファイルの中身 */
export const getEvidenceBytes = async (db: Database, id: number) => {
  const r = await db.select<{ data: string }[]>("SELECT data FROM evidence_files WHERE evidence_id = ?", [id]);
  if (!r[0]) throw new Error("証憑のファイルが見つかりません");
  return fromBase64(r[0].data);
};

const evidenceSnapshot = (e: Evidence): EvidenceSnapshot => ({
  kind: e.kind, doc_type: e.doc_type, txn_date: e.txn_date, amount: e.amount, counterparty: e.counterparty, memo: e.memo,
  file_name: e.file_name, mime: e.mime, size: e.size, sha256: e.sha256, entry_ids: e.entry_ids,
  // 受領日はあとから足した項目。入っているときだけ写しに残す
  ...(e.received_date ? { received_date: e.received_date } : {}),
  ...(e.doc_class ? { doc_class: e.doc_class } : {}),
});

/** 今の状態を履歴に積む（厳密モードのみ。呼ぶ前に revision を上げておく） */
const writeEvidenceHistory = async (db: Database, id: number, action: EvidenceAction, reason: string) => {
  if (!(await isStrict(db))) return;
  const e = await getEvidence(db, id);
  if (!e) return;
  const res = await db.execute(
    "INSERT INTO evidence_history (evidence_id, revision, action, reason, snapshot, user_id) VALUES (?, ?, ?, ?, ?, ?)",
    [id, e.revision, action, reason.trim(), JSON.stringify(evidenceSnapshot(e)), currentActor],
  );
  await appendChain(db, "evidence_history", Number(res.lastInsertId), `evidence:${id}`);
};

const bumpEvidence = (db: Database, id: number) =>
  db.execute("UPDATE evidences SET revision = revision + 1, updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?", [currentActor, id]);

const cleanMeta = (m: EvidenceMeta): EvidenceMeta => ({
  ...m, counterparty: m.counterparty.trim(), memo: m.memo.trim(), received_date: (m.received_date ?? "").trim(), doc_class: m.doc_class ?? "",
});

// ────────────────────────────────────────────
// 祝日・休業日（営業日の数え方に使う）
// ────────────────────────────────────────────
export interface HolidayData {
  /** 祝日（内蔵＋取得したもの） */
  holidays: Holiday[];
  /** 事業者の休業日 */
  custom: Holiday[];
  /** 内閣府から取得した日時（取得していなければ空） */
  fetchedAt: string;
  /** 祝日がいつの年まであるか */
  lastYear: number;
}

export const getHolidayData = async (db: Database): Promise<HolidayData> => {
  const rows = await db.select<(Holiday & { kind: string })[]>("SELECT date, name, kind FROM holidays ORDER BY date");
  const r = await db.select<{ holidays_fetched_at: string }[]>("SELECT holidays_fetched_at FROM settings WHERE id = 1");
  const holidays = mergeHolidays(BUILTIN_HOLIDAYS, rows.filter((x) => x.kind === "fetched").map(({ date, name }) => ({ date, name })));
  return {
    holidays,
    custom: rows.filter((x) => x.kind === "custom").map(({ date, name }) => ({ date, name })),
    fetchedAt: r[0]?.holidays_fetched_at ?? "",
    lastYear: lastHolidayYear(holidays),
  };
};

/** 休みの日（祝日＋休業日）の日付 */
export const getDaysOff = async (db: Database) => {
  const d = await getHolidayData(db);
  return new Set([...d.holidays, ...d.custom].map((h) => h.date));
};

/** 内閣府から取得した祝日を保存する（取得したものは丸ごと入れ替える） */
const saveFetchedHolidays_ = async (db: Database, list: Holiday[]) => {
  if (list.length === 0) throw new Error("祝日を読み取れませんでした（内閣府の一覧の形が変わった可能性があります）");
  const before = await getHolidayData(db);
  await db.execute("DELETE FROM holidays WHERE kind = 'fetched'");
  for (const h of list) await db.execute("INSERT INTO holidays (date, name, kind) VALUES (?, ?, 'fetched')", [h.date, h.name]);
  await db.execute("UPDATE settings SET holidays_fetched_at = DATETIME('now','localtime') WHERE id = 1");
  await logMaster(db, {
    target_type: "setting", target_id: 0, action: "change", fiscal_year: await currentYear(db), label: "祝日（内閣府から取得）",
    old_value: `${before.lastYear}年まで`, new_value: `${lastHolidayYear(mergeHolidays(BUILTIN_HOLIDAYS, list))}年まで（${list.length}件）`,
  });
};

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** 休業日を足す（同じ日があれば名前を変える） */
const addCustomHoliday_ = async (db: Database, date: string, name: string) => {
  if (!isIso(date)) throw new Error("日付を入れてください");
  const n = name.trim();
  if (n.length > 40) throw new Error("名前は40文字までです");
  await db.execute(
    "INSERT INTO holidays (date, name, kind) VALUES (?, ?, 'custom') ON CONFLICT (date, kind) DO UPDATE SET name = excluded.name",
    [date, n],
  );
  await logMaster(db, { target_type: "setting", target_id: 0, action: "create", fiscal_year: await currentYear(db), label: "休業日", old_value: "", new_value: `${date} ${n}`.trim() });
};

const deleteCustomHoliday_ = async (db: Database, date: string) => {
  const res = await db.execute("DELETE FROM holidays WHERE date = ? AND kind = 'custom'", [date]);
  if (res.rowsAffected === 0) return;
  await logMaster(db, { target_type: "setting", target_id: 0, action: "delete", fiscal_year: await currentYear(db), label: "休業日", old_value: date, new_value: "" });
};

/** スキャナ保存を使えないときのメッセージ */
export const SCAN_STRICT_ONLY = "スキャナ保存は、電子帳簿保存法に対応した保存方式（厳密モード）の帳簿でだけ使えます（訂正・削除の履歴が残ることが、タイムスタンプの代わりになるため）";

/** スキャナ保存の入力期間の方式 */
export const getScanInputMethod = async (db: Database): Promise<ScanInputMethod> => {
  const r = await db.select<{ scan_input_method: string }[]>("SELECT scan_input_method FROM settings WHERE id = 1");
  return r[0]?.scan_input_method === "cycle" ? "cycle" : "early";
};

const setScanInputMethod_ = async (db: Database, method: ScanInputMethod) => {
  if (method !== "early" && method !== "cycle") throw new Error("入力期間の方式が正しくありません");
  const before = await getScanInputMethod(db);
  if (before === method) return;
  await db.execute("UPDATE settings SET scan_input_method = ? WHERE id = 1", [method]);
  const label = { early: "早期入力方式", cycle: "業務処理サイクル方式" };
  await logMaster(db, {
    target_type: "setting", target_id: 0, action: "change", fiscal_year: await currentYear(db),
    label: "スキャナ保存の入力期間", old_value: label[before], new_value: label[method],
  });
};

/** 証憑を登録する。ファイルの種類・大きさ・ハッシュはここで決める（画面から渡された値は信用しない） */
/**
 * kind = scan（スキャナ保存）のときは：厳密モードだけ・受領日が必須・画質を確かめる（JPEG・PNG は中身で、それ以外は declared＝自己申告）。
 * 入力期間を過ぎていても登録はできる（一覧で「入力期間外」と知らせる）
 */
const createEvidence_ = async (
  db: Database, meta: EvidenceMeta, file: { name: string; bytes: Uint8Array }, kind: EvidenceKind = "electronic", declared = false,
) => {
  const fileErr = validateEvidenceFile(file.bytes, file.name);
  if (fileErr) throw new Error(fileErr);
  const metaErr = validateEvidenceMeta(meta);
  if (metaErr) throw new Error(metaErr);
  const type = detectFileType(file.bytes, file.name)!;
  const hash = await sha256Hex(file.bytes);
  const m = cleanMeta(meta);
  let docClass: DocClass | "" = "";
  let scanInfo = "";
  if (kind === "scan") {
    if (!(await isStrict(db))) throw new Error(SCAN_STRICT_ONLY);
    if (!m.received_date) throw new Error("スキャナ保存では受領日（紙を受け取った日）が必要です");
    docClass = m.doc_class || docClassOf(m.doc_type);
    const q = checkScanQuality(file.bytes, docClass, declared);
    if (!q.ok) throw new Error(q.problems.join("。"));
    scanInfo = JSON.stringify({ method: q.method, info: q.info });
  }
  const res = await db.execute(
    `INSERT INTO evidences (kind, doc_type, doc_class, scan_info, txn_date, received_date, amount, counterparty, counterparty_id, memo, file_name, mime, size, sha256, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, m.doc_type, docClass, scanInfo, m.txn_date, m.received_date ?? "", m.amount, m.counterparty, await counterpartyIdByName(db, m.counterparty), m.memo, file.name, type.mime,
      file.bytes.length, hash, currentActor, currentActor],
  );
  const id = Number(res.lastInsertId);
  // 途中で失敗しても tx() が丸ごと取り消す
  await db.execute("INSERT INTO evidence_files (evidence_id, data) VALUES (?, ?)", [id, toBase64(file.bytes)]);
  await writeEvidenceHistory(db, id, "create", "");
  return id;
};

/** 項目（取引年月日・金額・取引先など）の訂正。ファイルは変えられない */
const updateEvidence_ = async (db: Database, id: number, meta: EvidenceMeta, reason = "") => {
  const err = validateEvidenceMeta(meta);
  if (err) throw new Error(err);
  const before = await getEvidence(db, id);
  if (!before) throw new Error("証憑が見つかりません");
  if (before.is_void) throw new Error("無効にした証憑は訂正できません");
  const m = cleanMeta(meta);
  // 書類の区分はスキャナ保存だけ。重要書類に変えるなら、取り込んだときの画像がカラーであること
  let docClass: DocClass | "" = "";
  if (before.kind === "scan") {
    if (!m.received_date) throw new Error("スキャナ保存では受領日（紙を受け取った日）が必要です");
    docClass = m.doc_class || before.doc_class || docClassOf(m.doc_type);
    const info = before.scan_info ? JSON.parse(before.scan_info).info : null;
    if (docClass === "important" && info && info.color !== "color") throw new Error("グレースケールで読み取った書類は、重要書類にできません（カラーで読み取り直してください）");
  }
  await db.execute(
    `UPDATE evidences SET doc_type = ?, doc_class = ?, txn_date = ?, received_date = ?, amount = ?, counterparty = ?, counterparty_id = ?, memo = ?,
            revision = revision + 1, updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [m.doc_type, docClass, m.txn_date, m.received_date ?? "", m.amount, m.counterparty, await counterpartyIdByName(db, m.counterparty), m.memo, currentActor, id],
  );
  await writeEvidenceHistory(db, id, "update", reason);
};

/** 厳密モード：無効の印をつける（中身と履歴は残る）。通常モード：削除する */
const voidEvidence_ = async (db: Database, id: number, reason = "") => {
  const before = await getEvidence(db, id);
  if (!before || before.is_void) return;
  if (!(await isStrict(db))) {
    await db.execute("DELETE FROM evidence_links WHERE evidence_id = ?", [id]);
    await db.execute("DELETE FROM evidence_files WHERE evidence_id = ?", [id]);
    await db.execute("DELETE FROM evidences WHERE id = ?", [id]);
    return;
  }
  // 無効にしてから履歴を積む（記録の連鎖に無効にしたあとの状態を残すため。無効にした行は以後変更できない）
  await db.execute(
    `UPDATE evidences SET is_void = 1, revision = revision + 1, voided_at = DATETIME('now','localtime'),
            updated_by = ?, updated_at = DATETIME('now','localtime') WHERE id = ?`,
    [currentActor, id],
  );
  await writeEvidenceHistory(db, id, "void", reason);
};

/** 仕訳とひも付ける */
const linkEvidence_ = async (db: Database, evidenceId: number, entryId: number) => {
  const ev = await getEvidence(db, evidenceId);
  if (!ev || ev.is_void) throw new Error("無効にした証憑はひも付けられません");
  const entry = await getEntry(db, entryId);
  if (!entry || entry.is_deleted) throw new Error("削除済みの仕訳にはひも付けられません");
  const res = await db.execute("INSERT OR IGNORE INTO evidence_links (evidence_id, entry_id) VALUES (?, ?)", [evidenceId, entryId]);
  if (res.rowsAffected === 0) return;
  await bumpEvidence(db, evidenceId);
  await writeEvidenceHistory(db, evidenceId, "link", `伝票 No.${entryId}`);
};

/** ひも付けを外す */
const unlinkEvidence_ = async (db: Database, evidenceId: number, entryId: number) => {
  const ev = await getEvidence(db, evidenceId);
  if (!ev || ev.is_void) throw new Error("無効にした証憑は変更できません");
  const res = await db.execute("DELETE FROM evidence_links WHERE evidence_id = ? AND entry_id = ?", [evidenceId, entryId]);
  if (res.rowsAffected === 0) return;
  await bumpEvidence(db, evidenceId);
  await writeEvidenceHistory(db, evidenceId, "unlink", `伝票 No.${entryId}`);
};

interface EvidenceHistoryRow extends Omit<EvidenceHistoryRecord, "snapshot"> { snapshot: string }

export const getEvidenceHistory = async (db: Database, evidenceId?: number): Promise<EvidenceHistoryRecord[]> => {
  const rows = await db.select<EvidenceHistoryRow[]>(
    `SELECT h.id, h.evidence_id, h.revision, h.action, h.recorded_at, h.reason, h.snapshot, u.name AS user_name
       FROM evidence_history h LEFT JOIN users u ON u.id = h.user_id
      ${evidenceId ? "WHERE h.evidence_id = ?" : ""} ORDER BY h.id DESC`,
    evidenceId ? [evidenceId] : [],
  );
  return rows.map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) as EvidenceSnapshot }));
};

export interface EvidenceCheckResult {
  id: number;
  /** ok = 中身のハッシュが記録と一致 */
  status: "ok" | "changed" | "missing";
  detail: string;
}

/**
 * 改ざんの確認：ファイルの中身から計算したハッシュを、証憑の記録と、登録時の履歴（厳密モード）の両方と比べる。
 * 中身と記録を同時に書き換えられても、書き換え不可の履歴と食い違えば見つけられる
 */
export const verifyEvidences = (db: Database) => queuedRead(() => verifyEvidences_(db));

const verifyEvidences_ = async (db: Database): Promise<EvidenceCheckResult[]> => {
  const list = await getEvidences(db);
  const created = await db.select<{ evidence_id: number; snapshot: string }[]>(
    "SELECT evidence_id, snapshot FROM evidence_history WHERE action = 'create'",
  );
  const firstHash = new Map(created.map((r) => [r.evidence_id, (JSON.parse(r.snapshot) as EvidenceSnapshot).sha256]));
  const out: EvidenceCheckResult[] = [];
  for (const e of list) {
    let bytes: Uint8Array;
    try {
      bytes = await getEvidenceBytes(db, e.id);
    } catch {
      out.push({ id: e.id, status: "missing", detail: "ファイルの中身がありません" });
      continue;
    }
    const actual = await sha256Hex(bytes);
    const recorded = firstHash.get(e.id);
    if (actual !== e.sha256) out.push({ id: e.id, status: "changed", detail: "中身が登録時のハッシュと一致しません" });
    else if (recorded !== undefined && recorded !== e.sha256) out.push({ id: e.id, status: "changed", detail: "ハッシュの記録が登録時の履歴と一致しません" });
    else out.push({ id: e.id, status: "ok", detail: "" });
  }
  return out;
};

/** 取引先の入力候補（証憑で使ったもの） */
export const getEvidenceCounterparties = async (db: Database) =>
  (await db.select<{ c: string }[]>(
    "SELECT counterparty AS c FROM evidences WHERE counterparty <> '' GROUP BY counterparty ORDER BY COUNT(*) DESC LIMIT 300",
  )).map((r) => r.c);

/** 同じ中身のファイルがすでに登録されていないか（無効のものを除く） */
export const findEvidenceByHash = async (db: Database, sha256: string) => {
  const r = await db.select<{ id: number }[]>("SELECT id FROM evidences WHERE sha256 = ? AND is_void = 0 ORDER BY id", [sha256]);
  return r.map((x) => x.id);
};

// ────────────────────────────────────────────
// 改ざんの検知（厳密モードのみ）。考え方は lib/integrity.ts
// ────────────────────────────────────────────
const chainReady = async (db: Database) => {
  const r = await db.select<{ e_book_mode: string | null; chain_initialized: number }[]>(
    "SELECT e_book_mode, chain_initialized FROM settings WHERE id = 1",
  );
  return r[0]?.e_book_mode === "strict" && r[0].chain_initialized === 1;
};

/** 状態のキー（entry:12 など）の今の中身（正規形） */
const currentState = async (db: Database, key: string): Promise<string> => {
  const [kind, idStr] = key.split(":");
  const id = Number(idStr);
  if (kind === "entry") {
    const e = await db.select<{ date: string; counterparty_id: number | null; is_deleted: number; revision: number; is_adjustment: number }[]>(
      "SELECT date, counterparty_id, is_deleted, revision, is_adjustment FROM journal_entries WHERE id = ?", [id],
    );
    if (!e[0]) return "null";
    const lines = await db.select<Parameters<typeof entryState>[1]>(
      "SELECT row_no, side, account_id, sub_account_id, amount, memo, tax_code, invoice_kind, business_class, purchase_use FROM journal_lines WHERE entry_id = ?", [id],
    );
    return entryState(e[0], lines);
  }
  if (kind === "evidence") {
    const e = await db.select<Parameters<typeof evidenceState>[0][]>(
      `SELECT doc_type, doc_class, scan_info, txn_date, received_date, amount, counterparty, counterparty_id, memo, file_name, mime, size, sha256, revision, is_void
         FROM evidences WHERE id = ?`, [id],
    );
    if (!e[0]) return "null";
    const links = await db.select<{ entry_id: number }[]>("SELECT entry_id FROM evidence_links WHERE evidence_id = ?", [id]);
    return evidenceState(e[0], links.map((l) => l.entry_id));
  }
  if (kind === "opening") {
    return openingState(await db.select<{ account_id: number; sub_account_id: number; amount: number }[]>(
      "SELECT account_id, sub_account_id, amount FROM opening_balances WHERE fiscal_year = ?", [id],
    ));
  }
  if (kind === "closing") {
    const c = await db.select<{ period_start: string; period_end: string }[]>(
      "SELECT period_start, period_end FROM fiscal_closings WHERE fiscal_year = ?", [id],
    );
    return closingState(c[0] ?? null);
  }
  return "";
};

/** 連鎖の「基準点」：連鎖を始めた時点の状態を記録する行（source = baseline、source_id は基準点の通し番号。中身は state_key そのもの） */
const BASELINE = "baseline";

const loadHistoryRow = async (db: Database, source: ChainSource, id: number) => {
  const r = await db.select<Record<string, unknown>[]>(`SELECT * FROM ${source} WHERE id = ?`, [id]);
  return r[0];
};

export const getChainHead = async (db: Database) => {
  const r = await db.select<{ id: number; row_hash: string; recorded_at: string }[]>(
    "SELECT id, row_hash, recorded_at FROM audit_chain ORDER BY id DESC LIMIT 1",
  );
  return r[0] ?? null;
};

/** 連鎖に1行積む（厳密モードで、連鎖を始めたあとだけ） */
const appendChain = async (db: Database, source: ChainSource | typeof BASELINE, sourceId: number, stateKey = "", force = false) => {
  if (!force && !(await chainReady(db))) return;
  let content: string;
  if (source === BASELINE) content = stateKey;
  else {
    const row = await loadHistoryRow(db, source, sourceId);
    if (!row) return;
    content = historyContent(row, HISTORY_COLUMNS[source]);
  }
  const prev = (await getChainHead(db))?.row_hash ?? GENESIS;
  const link = {
    prev_hash: prev, source, source_id: sourceId, state_key: stateKey,
    state_hash: stateKey ? await hashText(await currentState(db, stateKey)) : "",
    content_hash: await hashText(content),
  };
  await db.execute(
    `INSERT INTO audit_chain (source, source_id, state_key, state_hash, content_hash, prev_hash, row_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [link.source, link.source_id, link.state_key, link.state_hash, link.content_hash, link.prev_hash, await chainHash(link)],
  );
};

/** 状態を持つもの（仕訳・証憑・期首残高・締め）のキーの一覧 */
const allStateKeys = async (db: Database) => {
  const ids = async (sql: string) => (await db.select<{ k: number }[]>(sql)).map((r) => r.k);
  return [
    ...(await ids("SELECT id AS k FROM journal_entries ORDER BY id")).map((k) => `entry:${k}`),
    ...(await ids("SELECT id AS k FROM evidences ORDER BY id")).map((k) => `evidence:${k}`),
    ...(await ids("SELECT DISTINCT fiscal_year AS k FROM opening_balances ORDER BY k")).map((k) => `opening:${k}`),
    ...(await ids("SELECT fiscal_year AS k FROM fiscal_closings ORDER BY k")).map((k) => `closing:${k}`),
  ];
};

/**
 * 記録の連鎖を始める（厳密モードの帳簿で一度だけ）。
 * この仕組みを入れる前の履歴を連鎖に取り込み、今の状態を基準点として記録する。
 * これより前に直接書き換えられていたものは見つけられない（README の課題に記載）
 */
const initChain_ = async (db: Database) => {
  const r = await db.select<{ e_book_mode: string | null; chain_initialized: number }[]>(
    "SELECT e_book_mode, chain_initialized FROM settings WHERE id = 1",
  );
  if (!r[0] || r[0].e_book_mode !== "strict" || r[0].chain_initialized) return;
  const sources = Object.keys(HISTORY_COLUMNS) as ChainSource[];
  const rows: { source: ChainSource; id: number; at: string }[] = [];
  for (const src of sources) {
    const xs = await db.select<{ id: number; recorded_at: string }[]>(`SELECT id, recorded_at FROM ${src}`);
    rows.push(...xs.map((x) => ({ source: src, id: x.id, at: x.recorded_at })));
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || sources.indexOf(a.source) - sources.indexOf(b.source) || a.id - b.id);
  for (const x of rows) await appendChain(db, x.source, x.id, "", true);
  let n = 0;
  for (const key of await allStateKeys(db)) await appendChain(db, BASELINE, ++n, key, true);
  await db.execute("UPDATE settings SET chain_initialized = 1 WHERE id = 1");
};

/** 検知した出来事を記録する（厳密モード） */
const recordEvent = async (db: Database, kind: string, detail: string) => {
  if (!(await isStrict(db))) return;
  const res = await db.execute("INSERT INTO integrity_events (kind, detail, user_id) VALUES (?, ?, ?)", [kind, detail, currentActor]);
  await appendChain(db, "integrity_events", Number(res.lastInsertId));
};

export const getIntegrityEvents = (db: Database) =>
  db.select<{ id: number; kind: string; detail: string; recorded_at: string }[]>("SELECT * FROM integrity_events ORDER BY id DESC");

/**
 * トリガーが消されていなかったかを確かめる（帳簿を開いたとき）。
 * 前回開いたときにあったトリガーが、今回開く前に無くなっていたら記録する。
 * トリガーは開くたびに作り直すので、消されても黙って元に戻ってしまう。その前に気づくための確認
 */
const checkTriggers_ = async (db: Database, before: string[]) => {
  const r = await db.select<{ known_triggers: string }[]>("SELECT known_triggers FROM settings WHERE id = 1");
  const known: string[] = r[0]?.known_triggers ? JSON.parse(r[0].known_triggers) : [];
  // 作り直して使わなくなったトリガーは、ソフトが消したので数えない
  const missing = known.filter((n) => !before.includes(n) && !RETIRED_TRIGGERS.includes(n));
  if (missing.length > 0) await recordEvent(db, "trigger_missing", `帳簿を開く前に、次のトリガー（書き換え防止の仕組み）が消されていました：${missing.join("、")}`);
  const now = (await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map((x) => x.name);
  await db.execute("UPDATE settings SET known_triggers = ? WHERE id = 1", [JSON.stringify(now)]);
};

export interface IntegrityReport {
  /** 厳密モードでなければ false（連鎖による検知はしない） */
  enabled: boolean;
  issues: IntegrityIssue[];
  /** 連鎖の件数・先頭 */
  length: number;
  head: { id: number; row_hash: string; recorded_at: string } | null;
}

/**
 * 改ざんの確認
 *  1. 連鎖をたどって、履歴の書き換え・削除を見つける
 *  2. 連鎖に入っていない履歴（ソフトを通さずに足された可能性）を見つける
 *  3. 仕訳・証憑・期首残高・締めの今の中身を、最後に記録した状態と比べる
 *  4. 検知の記録（トリガーが消されていた、など）を出す
 *  5. files = true なら証憑ファイルの中身もハッシュで確かめる
 */
export const verifyIntegrity = (db: Database, opts: { files?: boolean } = {}) => queuedRead(() => verifyIntegrity_(db, opts));

const verifyIntegrity_ = async (db: Database, opts: { files?: boolean } = {}): Promise<IntegrityReport> => {
  const issues: IntegrityIssue[] = [];
  if (opts.files) {
    for (const c of await verifyEvidences_(db)) {
      if (c.status !== "ok") issues.push({ level: "error", message: `証憑 No.${c.id}：${c.detail}` });
    }
  }
  if (!(await chainReady(db))) return { enabled: false, issues, length: 0, head: null };

  const chain = await db.select<ChainRow[]>("SELECT * FROM audit_chain ORDER BY id");
  const contents = new Map<string, string>();
  const sources = Object.keys(HISTORY_COLUMNS) as ChainSource[];
  for (const src of sources) {
    for (const row of await db.select<Record<string, unknown>[]>(`SELECT * FROM ${src}`)) {
      contents.set(`${src}:${row.id}`, historyContent(row, HISTORY_COLUMNS[src]));
    }
  }
  issues.push(...(await verifyChain(chain, (src, id) => {
    if (src === BASELINE) return chain.find((c) => c.source === BASELINE && c.source_id === id)?.state_key; // 基準点は中身 = キー
    return contents.get(`${src}:${id}`);
  })));

  // 連鎖に入っていない履歴
  const chained = new Set(chain.map((c) => `${c.source}:${c.source_id}`));
  for (const key of contents.keys()) {
    if (!chained.has(key)) {
      const [src, id] = key.split(":");
      issues.push({ level: "warn", message: `${sourceLabel(src)} No.${id} が記録の連鎖に入っていません（ソフトを通さずに追加された、または記録の途中でソフトが止まった可能性があります）` });
    }
  }

  // 今の中身と、最後に記録した状態
  const latest = new Map<string, string>();
  for (const c of chain) if (c.state_key) latest.set(c.state_key, c.state_hash);
  const keys = new Set([...latest.keys(), ...(await allStateKeys(db))]);
  for (const key of keys) {
    const recorded = latest.get(key);
    const now = await hashText(await currentState(db, key));
    if (recorded === undefined) {
      issues.push({ level: "error", message: `${stateLabel(key)} に記録がありません（ソフトを通さずに追加された可能性があります）` });
    } else if (recorded !== now) {
      issues.push({ level: "error", message: `${stateLabel(key)} が、最後に記録した内容と一致しません（ソフトを通さずに変更された、または保存の途中でソフトが止まった可能性があります）` });
    }
  }

  for (const ev of await getIntegrityEvents(db)) issues.push({ level: "warn", message: `${ev.recorded_at}　${ev.detail}` });

  return { enabled: true, issues, length: chain.length, head: chain.length ? chain[chain.length - 1] : null };
};

/**
 * 控えておいた確認コードが、今の連鎖の中にあるか。
 * 連鎖をまるごと計算し直されていると、控えたコードが見つからなくなる
 */
export const findAnchor = async (db: Database, code: string) => {
  const c = normalizeAnchor(code);
  if (c.length < 16) throw new Error("確認コードが短すぎます");
  const r = await db.select<{ id: number; recorded_at: string; row_hash: string }[]>(
    "SELECT id, recorded_at, row_hash FROM audit_chain WHERE row_hash LIKE ? ORDER BY id LIMIT 1",
    [`${c}%`],
  );
  return r[0] ?? null;
};

export { anchorCode };

// ────────────────────────────────────────────
// ユーザー（権限はまだ分けない。誰が操作したかを記録するため）
// ────────────────────────────────────────────
export const getUsers = (db: Database) =>
  db.select<User[]>(
    "SELECT id, name, (password_hash <> '') AS has_password, is_active, role, memo, created_at FROM users ORDER BY id",
  );

const userName = async (db: Database, id: number) =>
  (await db.select<{ name: string }[]>("SELECT name FROM users WHERE id = ?", [id]))[0]?.name ?? `#${id}`;

export const validateUserName = (users: User[], name: string, editingId?: number): string | null => {
  const n = name.trim();
  if (!n) return "ユーザー名を入れてください";
  if (n.length > 30) return "ユーザー名は30文字までです";
  if (users.some((u) => u.id !== editingId && u.name === n)) return "同じ名前のユーザーがいます";
  return null;
};

const createUser_ = async (db: Database, name: string, password = "", role: Role = "editor", memo = "") => {
  const err = validateUserName(await getUsers(db), name);
  if (err) throw new Error(err);
  if (!isRole(role)) throw new Error("権限が正しくありません");
  if (memo.length > 200) throw new Error("備考は200文字までです");
  if (password) {
    const pe = validatePassword(password);
    if (pe) throw new Error(pe);
  }
  const res = await db.execute("INSERT INTO users (name, password_hash, role, memo) VALUES (?, ?, ?, ?)", [name.trim(), password ? await hashPassword(password) : "", role, memo.trim()]);
  const id = Number(res.lastInsertId);
  await logMaster(db, {
    target_type: "user", target_id: id, action: "create", fiscal_year: await currentYear(db), label: name.trim(),
    old_value: "", new_value: `${ROLE_LABEL[role]}・${password ? "パスワードあり" : "パスワードなし"}`,
  });
  return id;
};

const renameUser_ = async (db: Database, id: number, name: string) => {
  const err = validateUserName(await getUsers(db), name, id);
  if (err) throw new Error(err);
  const before = await userName(db, id);
  if (before === name.trim()) return;
  await db.execute("UPDATE users SET name = ? WHERE id = ?", [name.trim(), id]);
  await logMaster(db, { target_type: "user", target_id: id, action: "rename", fiscal_year: await currentYear(db), label: name.trim(), old_value: before, new_value: name.trim() });
};

/** 備考の変更 */
const setUserMemo_ = async (db: Database, id: number, memo: string) => {
  const m = memo.trim();
  if (m.length > 200) throw new Error("備考は200文字までです");
  const me = (await getUsers(db)).find((u) => u.id === id);
  if (!me || me.memo === m) return;
  await db.execute("UPDATE users SET memo = ? WHERE id = ?", [m, id]);
  await logMaster(db, { target_type: "user", target_id: id, action: "change", fiscal_year: await currentYear(db), label: me.name, old_value: `備考：${me.memo}`, new_value: `備考：${m}` });
};

/**
 * パスワードの設定・変更・解除（newPassword が空なら解除）。
 * すでにパスワードがあるときは、今のパスワードが必要（他の人に勝手に変えられないように）
 */
const setUserPassword_ = async (db: Database, id: number, currentPassword: string, newPassword: string) => {
  // 自分のパスワードは誰でも変えられる（今のパスワードが要る）。
  // ほかの人のパスワードは管理者だけ。忘れたときに上書きできるよう、今のパスワードは要らない（再設定）
  if (currentActor !== null && currentActor !== id && !can(currentRole, "users")) throw new Error(permissionMessage(currentRole ?? "viewer"));
  const adminReset = currentActor !== null && currentActor !== id && can(currentRole, "users");
  const r = await db.select<{ password_hash: string }[]>("SELECT password_hash FROM users WHERE id = ?", [id]);
  if (!r[0]) throw new Error("ユーザーが見つかりません");
  if (!adminReset && !(await verifyPassword(currentPassword, r[0].password_hash))) throw new Error("今のパスワードが違います");
  if (newPassword) {
    const pe = validatePassword(newPassword);
    if (pe) throw new Error(pe);
  }
  await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [newPassword ? await hashPassword(newPassword) : "", id]);
  await logMaster(db, {
    target_type: "user", target_id: id, action: "change", fiscal_year: await currentYear(db), label: await userName(db, id),
    old_value: r[0].password_hash ? "パスワードあり" : "パスワードなし",
    new_value: (newPassword ? (r[0].password_hash ? "パスワードを変更" : "パスワードあり") : "パスワードなし") + (adminReset ? `（管理者「${await userName(db, currentActor!)}」が再設定）` : ""),
  });
};

/**
 * 帳簿ファイルの暗号化をかける・外す・パスワードを変える（db/encryption.ts の処理を run で渡す）。
 * 暗号化はファイルの置き換えなのでトランザクションの外で、書き込みの待ち行列に並んで行い、終わったら履歴に残す
 */
export type EncryptionChange = "on" | "off" | "password";
const ENCRYPTION_LOG: Record<EncryptionChange, [string, string]> = {
  on: ["なし", "あり（パスワードを設定）"],
  off: ["あり", "なし（暗号化をやめた）"],
  password: ["あり", "あり（パスワードを変更）"],
};
const logEncryption_ = async (db: Database, change: EncryptionChange) => {
  const [old_value, new_value] = ENCRYPTION_LOG[change];
  await logMaster(db, { target_type: "setting", target_id: 0, action: "change", fiscal_year: await currentYear(db), label: "帳簿ファイルの暗号化", old_value, new_value });
};
export const changeEncryption = async <T>(db: Database, change: EncryptionChange, run: () => Promise<T>): Promise<T> => {
  if (readOnly) throw new Error(READ_ONLY_MESSAGE);
  if (currentActor !== null && !can(currentRole, "settings")) throw new Error(permissionMessage(currentRole ?? "viewer"));
  const r = await queuedRead(run);
  await tx(db, "帳簿ファイルの暗号化の記録", () => logEncryption_(db, change), { perm: "settings" });
  return r;
};

/** 使える管理者が残るか（管理者が1人もいなくなると、設定やユーザーを誰も変えられなくなる） */
const assertAdminRemains = async (db: Database, id: number, after: { active: boolean; role: Role }) => {
  const users = await getUsers(db);
  const admins = users.filter((u) => u.is_active && u.role === "admin" && u.id !== id).length + (after.active && after.role === "admin" ? 1 : 0);
  if (admins === 0) throw new Error("使える管理者が1人もいなくなるため、変更できません");
};

/** 使わなくなったユーザーは非表示（履歴に名前が残るので削除はしない）。使えるユーザー・管理者が1人もいなくなる変更は不可 */
const setUserActive_ = async (db: Database, id: number, active: boolean) => {
  if (!active) {
    const others = (await getUsers(db)).filter((u) => u.is_active && u.id !== id);
    if (others.length === 0) throw new Error("使えるユーザーが1人もいなくなるため、非表示にできません");
    const me = (await getUsers(db)).find((u) => u.id === id);
    if (me) await assertAdminRemains(db, id, { active: false, role: me.role });
  }
  await db.execute("UPDATE users SET is_active = ? WHERE id = ?", [active ? 1 : 0, id]);
  await logMaster(db, { target_type: "user", target_id: id, action: active ? "show" : "hide", fiscal_year: await currentYear(db), label: await userName(db, id), old_value: "", new_value: "" });
};

/** 権限を変える（管理者が1人もいなくなる変更は不可） */
const setUserRole_ = async (db: Database, id: number, role: Role) => {
  if (!isRole(role)) throw new Error("権限が正しくありません");
  const me = (await getUsers(db)).find((u) => u.id === id);
  if (!me || me.role === role) return;
  await assertAdminRemains(db, id, { active: !!me.is_active, role });
  await db.execute("UPDATE users SET role = ? WHERE id = ?", [role, id]);
  await logMaster(db, {
    target_type: "user", target_id: id, action: "change", fiscal_year: await currentYear(db), label: me.name,
    old_value: `権限 ${ROLE_LABEL[me.role]}`, new_value: `権限 ${ROLE_LABEL[role]}`,
  });
  // 自分の権限を変えたら、すぐ反映する
  if (id === currentActor) currentRole = role;
};

/** ユーザーが1人もいなければ、最初のユーザー（パスワードなし・管理者）を作る。帳簿を開いたときに呼ぶ */
const ensureUsers_ = async (db: Database, defaultName: string) => {
  if ((await getUsers(db)).length > 0) return;
  await createUser_(db, defaultName.trim() || "利用者1", "", "admin");
};

/** パスワードの確認（パスワードなしのユーザーは常に通る） */
export const checkLogin = async (db: Database, id: number, password: string) => {
  const r = await db.select<{ password_hash: string; is_active: number }[]>("SELECT password_hash, is_active FROM users WHERE id = ?", [id]);
  return !!r[0] && r[0].is_active === 1 && (await verifyPassword(password, r[0].password_hash));
};

/** ログイン・ログアウトの記録（どちらのモードでも残す。厳密モードでは記録の連鎖にも入れる） */
const logAccess_ = async (db: Database, userId: number, action: "login" | "logout") => {
  const res = await db.execute("INSERT INTO access_log (user_id, action) VALUES (?, ?)", [userId, action]);
  await appendChain(db, "access_log", Number(res.lastInsertId));
};

export const getAccessLog = (db: Database) =>
  db.select<AccessLogRecord[]>(
    "SELECT a.id, a.user_id, u.name AS user_name, a.action, a.recorded_at FROM access_log a JOIN users u ON u.id = a.user_id ORDER BY a.id DESC",
  );

/**
 * 翌年への繰越：翌年の期首残高を保存する。close = true なら、この年度も締める（1つのトランザクションで）。
 * 締めずに繰り越せば、前の年を直しながら翌年の入力を始められる（直したら繰越をやり直す。ずれは画面上部で知らせる）
 */
const carryForward_ = async (db: Database, year: number, nextOpening: SubOpeningBalances, close = false) => {
  await saveOpening_(db, year + 1, nextOpening, true);
  if (close) await closeYear_(db, year, "繰越処理による締め");
};

/** 家事按分の年末振替の仕訳を作る（作り直すときは同じ仕訳を訂正する）。仕訳の登録と記録を1つのトランザクションで */
const saveHomeUseRunEntry_ = async (db: Database, year: number, date: string, lines: JournalLine[], runId: number | null) => {
  // 年度末の振替は決算整理仕訳にする
  const adjustment = date === yearEnd(year);
  if (runId) {
    await updateEntry_(db, runId, date, lines, "家事按分の再計算", undefined, adjustment);
    return runId;
  }
  const id = await createEntry_(db, date, lines, null, "", adjustment);
  await setHomeUseRun_(db, year, id);
  return id;
};

// ────────────────────────────────────────────
// 書き込みの入り口（すべてトランザクションの中で行う）
// ────────────────────────────────────────────
export const setEBookMode = inTx(setEBookMode_, () => "保存方式の設定", { perm: "settings" });
export const saveSettings = inTx(saveSettings_, () => "事業者設定の保存", { perm: "settings" });
export const saveTaxYear = inTx(saveTaxYear_, (t) => `${t.from_year}年の消費税の設定`, { perm: "settings" });
export const saveTaxBaseManual = inTx(saveTaxBaseManual_, (year) => `${year}年の基準期間の課税売上高`, { perm: "settings" });
export const saveBankFormat = inTx(saveBankFormat_, () => "明細の列の対応", { perm: "entry" });
export const addBankLines = inTx(addBankLines_, (_a, _s, lines, file) => `明細 ${lines.length} 件の読み込み（${file}）`, { perm: "entry" });
export const setBankLinesStatus = inTx(setBankLinesStatus_, (ids, status) => `明細 ${ids.length} 件を${status === "skipped" ? "取り込まない" : "未登録に戻す"}`, { perm: "entry" });
export const registerBankLines = inTx(registerBankLines_, (items, source) => `明細 ${items.length} 件の仕訳への登録（${source}）`, { perm: "entry" });
export const saveBankRule = inTx(saveBankRule_, (r) => `明細のルール「${r.keyword}」`, { perm: "entry" });
export const deleteBankRule = inTx(deleteBankRule_, (id) => `明細のルール #${id} の削除`, { perm: "entry" });
export const setAccountStatementLine = inTx(setAccountStatementLine_, (id) => `勘定科目 #${id} の決算書の欄`, { perm: "master" });
export const saveIncomeTaxInput = inTx(saveIncomeTaxInput_, (year) => `${year}年の所得税の申告書の入力`, { perm: "settings" });
export const saveTaxPrevManual = inTx(saveTaxPrevManual_, (year) => `${year}年の前年の確定消費税額`, { perm: "settings" });
export const saveTaxInterim = inTx(saveTaxInterim_, (year) => `${year}年の中間納付税額`, { perm: "settings" });
export const saveInvoiceRegistration = inTx(saveInvoiceRegistration_, () => "登録番号の保存", { perm: "settings" });
export const saveEtaxInfo = inTx(saveEtaxInfo_, () => "e-Tax の申告者の情報の保存", { perm: "settings" });
export const fillTaxCodes = inTx(fillTaxCodes_, (year) => `${year}年の仕訳の税区分の一括設定`, { perm: "entry" });
export const setFiscalYear = inTx(setFiscalYear_, (year) => `${year}年への切り替え`, { allowReadOnly: true });
export const setBackupGenerations = inTx(setBackupGenerations_, () => "バックアップ世代数の保存", { perm: "settings" });
export const setInputPeriodDays = inTx(setInputPeriodDays_, () => "入力期間の保存", { perm: "settings" });
export const setScanInputMethod = inTx(setScanInputMethod_, () => "スキャナ保存の入力期間の方式", { perm: "settings" });
export const saveFetchedHolidays = inTx(saveFetchedHolidays_, () => "祝日の取得", { perm: "settings" });
export const addCustomHoliday = inTx(addCustomHoliday_, (date) => `休業日（${date}）の追加`, { perm: "settings" });
export const deleteCustomHoliday = inTx(deleteCustomHoliday_, (date) => `休業日（${date}）の削除`, { perm: "settings" });
export const setCashbookAccounts = inTx(setCashbookAccounts_, () => "帳簿入力のタブの保存", { perm: "entry" });
export const setAccountActive = inTx(setAccountActive_, (id) => `勘定科目 #${id} の表示切り替え`, { perm: "master" });
export const createAccount = inTx(createAccount_, (d) => `勘定科目「${d.name}」の追加`, { perm: "master" });
export const updateAccount = inTx(updateAccount_, (id) => `勘定科目 #${id} の変更`, { perm: "master" });
export const deleteAccount = inTx(deleteAccount_, (id) => `勘定科目 #${id} の削除`, { perm: "master" });
export const setAccountBusinessClass = inTx(setAccountBusinessClass_, (id) => `勘定科目 #${id} の事業区分の初期値`, { perm: "master" });
export const setAccountPurchaseUse = inTx(setAccountPurchaseUse_, (id) => `勘定科目 #${id} の用途区分の初期値`, { perm: "master" });
export const setAccountTaxCode = inTx(setAccountTaxCode_, (id) => `勘定科目 #${id} の税区分の初期値`, { perm: "master" });
export const createSub = inTx(createSub_, (_a, name) => `補助科目「${name}」の追加`, { perm: "master" });
export const renameSub = inTx(renameSub_, (id) => `補助科目 #${id} の名前変更`, { perm: "master" });
export const setSubActive = inTx(setSubActive_, (id) => `補助科目 #${id} の表示切り替え`, { perm: "master" });
export const deleteSub = inTx(deleteSub_, (id) => `補助科目 #${id} の削除`, { perm: "master" });
export const createCounterparty = inTx(createCounterparty_, (d) => `取引先「${d.name}」の追加`, { perm: "entry" });
export const updateCounterparty = inTx(updateCounterparty_, (id) => `取引先 #${id} の変更`, { perm: "entry" });
export const setCounterpartyActive = inTx(setCounterpartyActive_, (id) => `取引先 #${id} の表示切り替え`, { perm: "entry" });
export const deleteCounterparty = inTx(deleteCounterparty_, (id) => `取引先 #${id} の削除`, { perm: "entry" });
export const createTemplate = inTx(createTemplate_, (name) => `定型仕訳「${name}」の登録`, { perm: "entry" });
export const overwriteTemplate = inTx(overwriteTemplate_, (id) => `定型仕訳 #${id} の置き換え`, { perm: "entry" });
export const renameTemplate = inTx(renameTemplate_, (id) => `定型仕訳 #${id} の名前変更`, { perm: "entry" });
export const deleteTemplate = inTx(deleteTemplate_, (id) => `定型仕訳 #${id} の削除`, { perm: "entry" });
export const saveOpening = inTx(saveOpening_, (year) => `${year}年の期首残高の保存`, { perm: "master" });
export const createEntry = inTx(createEntry_, (date) => `仕訳（${date}）の登録`, { perm: "entry" });
export const importEntries = inTx(importEntries_, (entries, source) => `仕訳 ${entries.length} 件の CSV 取り込み（${source}）`, { perm: "entry" });
export const updateEntry = inTx(updateEntry_, (id) => `伝票 No.${id} の訂正`, { perm: "entry" });
export const deleteEntry = inTx(deleteEntry_, (id) => `伝票 No.${id} の削除`, { perm: "entry" });
export const saveHomeUseRate = inTx(saveHomeUseRate_, (year) => `${year}年の家事按分の設定`, { perm: "master" });
export const setHomeUseRun = inTx(setHomeUseRun_, (year) => `${year}年の家事按分の振替`, { perm: "entry" });
export const closeYear = inTx(closeYear_, (year) => `${year}年の締め`, { perm: "settings" });
export const closeThrough = inTx(closeThrough_, (year, month) => `${year}年${month}月までの締め`, { perm: "settings" });
export const reopenTo = inTx(reopenTo_, (year, month) => `${year}年の締めを${month}月までに戻す`, { perm: "settings" });
export const reopenYear = inTx(reopenYear_, (year) => `${year}年の締めの解除`, { perm: "settings" });
export const initClosings = inTx(initClosings_, () => "繰越済みの年度の締め");
export const createEvidence = inTx(createEvidence_, (m) => `証憑（${m.txn_date} ${m.counterparty}）の取り込み`, { perm: "entry" });
export const updateEvidence = inTx(updateEvidence_, (id) => `証憑 No.${id} の訂正`, { perm: "entry" });
export const voidEvidence = inTx(voidEvidence_, (id) => `証憑 No.${id} の無効・削除`, { perm: "entry" });
export const linkEvidence = inTx(linkEvidence_, (e, entry) => `証憑 No.${e} と伝票 No.${entry} のひも付け`, { perm: "entry" });
export const unlinkEvidence = inTx(unlinkEvidence_, (e, entry) => `証憑 No.${e} と伝票 No.${entry} のひも付け解除`, { perm: "entry" });
export const initChain = inTx(initChain_, () => "記録の連鎖の開始");
export const checkTriggers = inTx(checkTriggers_, () => "トリガーの確認");
export const createUser = inTx(createUser_, (name) => `ユーザー「${name}」の追加`, { perm: "users" });
export const renameUser = inTx(renameUser_, (id) => `ユーザー #${id} の名前変更`, { perm: "users" });
export const setUserMemo = inTx(setUserMemo_, (id) => `ユーザー #${id} の備考`, { perm: "users" });
export const setUserPassword = inTx(setUserPassword_, (id) => `ユーザー #${id} のパスワード`);
export const setUserRole = inTx(setUserRole_, (id) => `ユーザー #${id} の権限`, { perm: "users" });
export const setUserActive = inTx(setUserActive_, (id) => `ユーザー #${id} の表示切り替え`, { perm: "users" });
export const ensureUsers = inTx(ensureUsers_, () => "最初のユーザーの作成");
export const logAccess = inTx(logAccess_, (id, action) => `ユーザー #${id} の${action === "login" ? "ログイン" : "ログアウト"}`);
export const carryForward = inTx(carryForward_, (year) => `${year}年から${year + 1}年への繰越`, { perm: "settings" });
export const switchToStrict = inTx(switchToStrict_, (year) => `${year}年からの電子帳簿保存法への切り替え`, { perm: "settings" });
export const saveStatementNote = inTx(saveStatementNote_, (year) => `${year}年の決算書の書き込み`, { perm: "master" });
export const saveAsset = inTx(saveAsset_, (id) => (id === null ? "固定資産の追加" : `固定資産 #${id} の変更`), { perm: "master" });
export const deleteAsset = inTx(deleteAsset_, (id) => `固定資産 #${id} の削除`, { perm: "master" });
export const saveDepreciationRun = inTx(saveDepreciationRun_, (year) => `${year}年の減価償却`, { perm: "entry" });
export const saveHomeUseRunEntry = inTx(saveHomeUseRunEntry_, (year) => `${year}年の家事按分の振替`, { perm: "entry" });
