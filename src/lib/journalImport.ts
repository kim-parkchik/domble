/**
 * 仕訳の CSV 取り込み（純粋関数）
 *
 * 形式は仕訳日記帳の CSV 書き出しと同じ（書き出したものをそのまま取り込める）。列は見出しの名前で探すので、順番は問わない
 *  - 必須：日付・借方科目・借方金額・貸方科目・貸方金額
 *  - 任意：伝票No（同じ番号の行を1つの仕訳にまとめる。無ければ1行 = 1仕訳）・借方補助・貸方補助・摘要・取引先・状態（「削除済み」の行は飛ばす）・
 *    決算整理（何か入っていれば決算整理仕訳。日付は年度末）・借方税区分・借方インボイス・借方事業区分・借方用途区分・貸方税区分・貸方インボイス・貸方事業区分・貸方用途区分
 *    （空なら科目・取引先の初期値。免税事業者の期間の仕訳では外れる）
 *  - それ以外の列（登録番号・登録日時など）は読まない
 * 科目・補助科目・取引先は名前で探す（全角半角・空白の違いは無視）。見つからない名前は作らずに問題として返す
 * 1つでも問題があれば取り込まない（画面で行番号つきで知らせる）
 */
import type { Account, Counterparty, JournalLine, SubAccount, VoucherRow } from "./types";
import { emptyRow, rowsToLines } from "./accounting";
import { parseAmount, toHalfWidth } from "./format";
import { normName } from "./counterparty";
import { parseCsv, unguardCell } from "./csv";
import { parseBusinessClass, parseInvoiceKind, parsePurchaseUse, parseTaxCode } from "./tax";

/** 一度に取り込める仕訳の数 */
export const MAX_IMPORT_ENTRIES = 10_000;

export interface ImportContext {
  accounts: Account[];
  subs: SubAccount[];
  counterparties: Counterparty[];
  /** 締め済みの年度の日付か */
  isDateClosed?: (date: string) => boolean;
}

export interface ImportEntry {
  date: string;
  lines: JournalLine[];
  counterpartyId: number | null;
  /** 決算整理仕訳か */
  adjustment: boolean;
  /** もとの CSV の行番号（1始まり。見出しの行を含めて数える） */
  csvRows: number[];
}

export interface ImportIssue {
  row: number;
  message: string;
}

export interface ImportResult {
  entries: ImportEntry[];
  issues: ImportIssue[];
  /** 「削除済み」で飛ばした行の数 */
  skipped: number;
}

const COLUMNS = {
  no: ["伝票No", "伝票番号", "No"],
  date: ["日付", "取引日"],
  drAcc: ["借方科目", "借方勘定科目"],
  drSub: ["借方補助", "借方補助科目"],
  drAmt: ["借方金額"],
  crAcc: ["貸方科目", "貸方勘定科目"],
  crSub: ["貸方補助", "貸方補助科目"],
  crAmt: ["貸方金額"],
  memo: ["摘要"],
  cp: ["取引先"],
  state: ["状態"],
  adj: ["決算整理"],
  drTax: ["借方税区分"],
  drInv: ["借方インボイス"],
  crTax: ["貸方税区分"],
  crInv: ["貸方インボイス"],
  drCls: ["借方事業区分"],
  crCls: ["貸方事業区分"],
  drUse: ["借方用途区分"],
  crUse: ["貸方用途区分"],
} as const;
type Col = keyof typeof COLUMNS;
const REQUIRED: Col[] = ["date", "drAcc", "drAmt", "crAcc", "crAmt"];

/** 2026-01-05・2026/1/5・2026年1月5日・20260105 → 2026-01-05（年の省略は不可） */
export const parseImportDate = (raw: string): string | null => {
  const s = toHalfWidth(raw).trim();
  const m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/) ?? s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

interface Group {
  date: string | null;
  cpText: string;
  adjustment: boolean;
  rows: { line: number; vr: VoucherRow }[];
}

export const importJournalCsv = (text: string, ctx: ImportContext): ImportResult => {
  const table = parseCsv(text);
  const issues: ImportIssue[] = [];
  const headerAt = table.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerAt < 0) return { entries: [], issues: [{ row: 1, message: "中身がありません" }], skipped: 0 };

  // 見出しから列の位置を決める
  const header = table[headerAt].map((h) => normName(h));
  const col = {} as Record<Col, number>;
  for (const k of Object.keys(COLUMNS) as Col[]) col[k] = header.findIndex((h) => COLUMNS[k].some((name) => normName(name) === h));
  const missing = REQUIRED.filter((k) => col[k] < 0);
  if (missing.length > 0) {
    return {
      entries: [],
      issues: [{ row: headerAt + 1, message: `見出しに次の列がありません：${missing.map((k) => COLUMNS[k][0]).join("、")}（仕訳日記帳の CSV 書き出しと同じ見出しにしてください）` }],
      skipped: 0,
    };
  }

  const accByName = new Map(ctx.accounts.map((a) => [normName(a.name), a]));
  const findSub = (accountId: number, name: string) => ctx.subs.find((s) => s.account_id === accountId && normName(s.name) === normName(name));

  const groups = new Map<string, Group>();
  let skipped = 0;
  for (let i = headerAt + 1; i < table.length; i++) {
    const line = i + 1;
    const cells = table[i];
    if (cells.every((c) => c.trim() === "")) continue;
    const get = (k: Col) => (col[k] >= 0 ? unguardCell(cells[col[k]] ?? "").trim() : "");
    if (get("state") === "削除済み") {
      skipped++;
      continue;
    }
    const err = (message: string) => issues.push({ row: line, message });

    const date = parseImportDate(get("date"));
    if (!date) err(`日付「${get("date")}」が読めません（例：2026-01-05、2026/1/5）`);

    const vr = emptyRow();
    vr.memo = get("memo");
    for (const side of ["dr", "cr"] as const) {
      const label = side === "dr" ? "借方" : "貸方";
      const accName = get(`${side}Acc`);
      const subName = get(`${side}Sub`);
      const amtRaw = get(`${side}Amt`);
      const amount = amtRaw ? parseAmount(amtRaw) : null;
      if (amtRaw && (amount === null || amount <= 0)) err(`${label}金額「${amtRaw}」は 1 円以上の整数で入れてください`);
      if (!accName && !amtRaw && !subName) continue;
      if (!accName) {
        err(`${label}の科目がありません`);
        continue;
      }
      const acc = accByName.get(normName(accName));
      if (!acc) {
        err(`${label}科目「${accName}」が勘定科目にありません`);
        continue;
      }
      if (!amtRaw) err(`${label}金額がありません`);
      let subId: number | null = null;
      if (subName) {
        const sub = findSub(acc.id, subName);
        if (sub) subId = sub.id;
        else err(`${label}補助「${subName}」が「${acc.name}」の補助科目にありません`);
      }
      // 税区分・インボイス区分（空なら科目・取引先の初期値。免税事業者の期間なら登録のときに外れる）
      const taxRaw = get(`${side}Tax`);
      const tax = parseTaxCode(taxRaw);
      if (tax === undefined) err(`${label}税区分「${taxRaw}」が読めません（例：課税仕入 10%、課税売上 8%（軽減）、対象外）`);
      const invRaw = get(`${side}Inv`);
      const inv = parseInvoiceKind(invRaw);
      if (inv === undefined) err(`${label}インボイス「${invRaw}」が読めません（適格・経過措置・控除なし）`);
      const clsRaw = get(`${side}Cls`);
      const cls = parseBusinessClass(clsRaw);
      if (cls === undefined) err(`${label}事業区分「${clsRaw}」が読めません（第一種〜第六種、または 1〜6）`);
      const useRaw = get(`${side}Use`);
      const use = parsePurchaseUse(useRaw);
      if (use === undefined) err(`${label}用途区分「${useRaw}」が読めません（課税対応・共通対応・非課税対応）`);
      if (side === "dr") {
        vr.debitAccountId = acc.id;
        vr.debitSubId = subId;
        vr.debitAmount = amount;
        vr.debitTax = tax ?? null;
        vr.debitInvoice = inv ?? null;
        vr.debitClass = cls ?? null;
        vr.debitUse = use ?? null;
      } else {
        vr.creditAccountId = acc.id;
        vr.creditSubId = subId;
        vr.creditAmount = amount;
        vr.creditTax = tax ?? null;
        vr.creditInvoice = inv ?? null;
        vr.creditClass = cls ?? null;
        vr.creditUse = use ?? null;
      }
    }

    // 同じ伝票No の行は1つの仕訳。伝票No が無ければ1行で1つ
    const no = get("no");
    const key = no ? `no:${no}` : `row:${line}`;
    const g = groups.get(key) ?? { date, cpText: "", adjustment: false, rows: [] };
    if (get("adj")) g.adjustment = true;
    if (g.rows.length > 0 && date && g.date && date !== g.date) err(`伝票No ${no} の中で日付が違います（${g.date} と ${date}）`);
    const cp = get("cp");
    if (cp && g.cpText && normName(cp) !== normName(g.cpText)) err(`伝票No ${no} の中で取引先が違います（${g.cpText} と ${cp}）`);
    if (cp && !g.cpText) g.cpText = cp;
    g.rows.push({ line, vr });
    groups.set(key, g);
  }

  if (groups.size > MAX_IMPORT_ENTRIES) {
    issues.push({ row: headerAt + 1, message: `一度に取り込めるのは ${MAX_IMPORT_ENTRIES.toLocaleString()} 件までです（${groups.size.toLocaleString()} 件あります）。ファイルを分けてください` });
  }

  const entries: ImportEntry[] = [];
  for (const g of groups.values()) {
    const first = g.rows[0].line;
    const err = (message: string) => issues.push({ row: first, message });
    const lines = rowsToLines(g.rows.map((r) => r.vr));
    const dr = lines.filter((l) => l.side === "debit").reduce((t, l) => t + l.amount, 0);
    const cr = lines.filter((l) => l.side === "credit").reduce((t, l) => t + l.amount, 0);
    if (lines.length > 0 && dr !== cr) err(`借方と貸方の合計が一致しません（借方 ${dr.toLocaleString()}、貸方 ${cr.toLocaleString()}）`);
    if (dr === 0 && cr === 0 && !issues.some((x) => g.rows.some((r) => r.line === x.row))) err("金額がありません");
    if (g.adjustment && g.date && g.date.slice(5) !== "12-31") err("決算整理の仕訳は、年度末の日付（12月31日）にしてください");
    if (g.date && ctx.isDateClosed?.(g.date)) err(`${g.date.slice(0, 4)}年は締め済みのため取り込めません（事業者設定で締めを解除してください）`);
    let counterpartyId: number | null = null;
    if (g.cpText) {
      const c = ctx.counterparties.find((x) => normName(x.name) === normName(g.cpText));
      if (c) counterpartyId = c.id;
      else err(`取引先「${g.cpText}」が取引先の一覧にありません（先に取引先を登録してください）`);
    }
    if (g.date) entries.push({ date: g.date, lines, counterpartyId, adjustment: g.adjustment, csvRows: g.rows.map((r) => r.line) });
  }

  issues.sort((a, b) => a.row - b.row);
  return { entries: issues.length ? [] : entries, issues, skipped };
};
