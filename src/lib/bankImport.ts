/**
 * 銀行・カードの明細（CSV）の取り込み（純粋関数）
 *
 *  - 形は銀行・カードごとに違うので、列（日付・摘要・入金と出金、または金額1列・残高）を選んでもらい、口座（科目・補助科目）ごとに覚える
 *    見出しの名前から列を推測する（日付・お取引日・ご利用日、摘要・お取引内容・ご利用店名、入金・お預入、出金・お引出、金額・ご利用金額、残高）
 *  - 「増える側・減る側」で読む：普通預金なら入金が増える側、未払金（カード）ならご利用が増える側。増える側は科目の残高の側（資産は借方）
 *  - 同じ明細を2回読んでも重ならないよう、行ごとに指紋（日付・増減・金額・摘要と、同じ組み合わせの何個目か）を作る
 *  - 相手科目などの推測：ルール（摘要に含む言葉）→ 前に同じ摘要の明細から作った仕訳 → 帳簿で同じ摘要の仕訳 の順
 *  - 1行の明細を相手科目の何行かに分けられる（分けた行は決まった額、最初の相手科目は残りの額）。ルールにも分け方を持たせられる
 */
import type { Account, InvoiceKind, JournalLine, TaxCode } from "./types";
import type { FlatLine } from "./accounting";
import { parseCsv } from "./csv";

// ────────────────────────────────────────────
// 列の対応
// ────────────────────────────────────────────

export interface ColumnMap {
  /** 見出しの行（0始まり。-1 = 見出しなし） */
  headerRow: number;
  date: number;
  /** 摘要（複数の列をつなげてもよい） */
  description: number[];
  /** split = 増える側・減る側の2列、signed = 金額1列（＋が増える側。invert で逆） */
  mode: "split" | "signed";
  increase: number | null;
  decrease: number | null;
  amount: number | null;
  invert: boolean;
  balance: number | null;
}

const HEADER_WORDS = {
  date: /^(日付|年月日|取引日|お取引日|お取引日付|取引年月日|利用日|ご利用日|ご利用年月日|利用年月日|入出金日|日時|date)$/i,
  description: /(摘要|お取引内容|取引内容|内容|ご利用店名|利用店名|ご利用先|利用先|ご利用場所|明細|お支払先|取引先|description)/i,
  increase: /(入金|預入|預け入れ|預入れ|お預り|お預かり|預かり|預り|受入|受け入れ|credit)/i,
  decrease: /(出金|引出|引き出し|引出し|支払金額|支払い金額|支払額|払戻|払出|払い出し|引落|引き落とし|debit)/i,
  amount: /(金額|お支払額|取引額|amount)/i,
  /** 入金と出金を1列で持つ見出し（＋が入金） */
  signed: /(入出金|入払|出入金)/,
  /** カードの利用の金額（「○月支払金額」などより先に使う） */
  usage: /(利用金額|ご利用額|利用額)/,
  balance: /(残高|balance)/i,
};

const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

/** 見出しの行を探して列を推測する（見つからなければ null） */
export const guessColumns = (rows: string[][]): ColumnMap | null => {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cells = rows[r].map(norm);
    const find = (re: RegExp, skip: number[] = []) => cells.findIndex((c, i) => !skip.includes(i) && re.test(c));
    const date = find(HEADER_WORDS.date);
    if (date < 0) continue;
    const balance = find(HEADER_WORDS.balance);
    const used = [date, balance];
    const base = { headerRow: r, date, invert: false, balance: balance >= 0 ? balance : null, increase: null, decrease: null };
    const desc = (skip: number[]) => {
      const d = find(HEADER_WORDS.description, skip);
      return d >= 0 ? [d] : [];
    };
    // 「入出金」のような1列、カードの「利用金額」は金額1列（＋が増える側）として読む
    const signed = find(HEADER_WORDS.signed, used);
    const usage = signed < 0 ? find(HEADER_WORDS.usage, used) : -1;
    const one = signed >= 0 ? signed : usage;
    if (one >= 0) return { ...base, description: desc([...used, one]), mode: "signed", amount: one };
    const increase = find(HEADER_WORDS.increase, used);
    const decrease = find(HEADER_WORDS.decrease, [...used, increase]);
    const amount = find(HEADER_WORDS.amount, [...used, increase, decrease]);
    if (increase < 0 && decrease < 0 && amount < 0) continue;
    const split = increase >= 0 || decrease >= 0;
    return {
      ...base, description: desc([...used, increase, decrease, amount]), mode: split ? "split" : "signed",
      increase: split && increase >= 0 ? increase : null, decrease: split && decrease >= 0 ? decrease : null, amount: split ? null : amount,
    };
  }
  return null;
};

/** 保存した対応を確かめる（形が変わっていれば null） */
export const parseColumnMap = (json: string | null): ColumnMap | null => {
  if (!json) return null;
  try {
    const m = JSON.parse(json) as ColumnMap;
    const idx = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
    if (!Number.isInteger(m.headerRow) || !Number.isInteger(m.date) || !Array.isArray(m.description) || !["split", "signed"].includes(m.mode)) return null;
    if (![m.increase, m.decrease, m.amount, m.balance].every(idx)) return null;
    return { ...m, invert: !!m.invert };
  } catch {
    return null;
  }
};

/** 対応の問題（無ければ null） */
export const columnMapProblem = (m: ColumnMap): string | null => {
  if (m.date < 0) return "日付の列を選んでください";
  if (m.mode === "split" && m.increase === null && m.decrease === null) return "入金（増える側）か出金（減る側）の列を選んでください";
  if (m.mode === "signed" && m.amount === null) return "金額の列を選んでください";
  return null;
};

// ────────────────────────────────────────────
// 値の読み取り
// ────────────────────────────────────────────

/** 日付を読む（2026/1/5・2026-01-05・2026年1月5日・20260105・R8.1.5・令和8年1月5日・26/01/05。時刻は無視。年が無ければ defaultYear） */
export const parseStatementDate = (raw: string, defaultYear?: number): string | null => {
  const s = raw.normalize("NFKC").trim().replace(/\s.*$/, "");
  const ok = (y: number, m: number, d: number) => {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const t = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === m && t.getUTCDate() === d ? iso : null;
  };
  let m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(?:R|令和)(\d{1,2})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/i);
  if (m) return ok(2018 + +m[1], +m[2], +m[3]);
  m = s.match(/^(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (m) return ok(2000 + +m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/\-月](\d{1,2})日?$/);
  if (m && defaultYear) return ok(defaultYear, +m[1], +m[2]);
  return null;
};

/** 金額を読む（3,300・¥3,300・3300円・-3,300・▲3,300・(3,300)）。空なら null、読めなければ NaN */
export const parseStatementAmount = (raw: string): number | null => {
  let s = raw.normalize("NFKC").replace(/[,\s¥\\円]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^[-▲△−]/.test(s)) {
    neg = true;
    s = s.slice(1);
  } else if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return Number.NaN;
  const n = Math.round(Number(s));
  return neg ? -n : n;
};

// ────────────────────────────────────────────
// 明細
// ────────────────────────────────────────────

export interface StatementLine {
  /** CSV の行番号（1始まり） */
  row: number;
  date: string;
  description: string;
  /** その口座の科目の側（増える側 = 科目の残高の側） */
  side: "debit" | "credit";
  amount: number;
  balance: number | null;
  fingerprint: string;
}

export interface ParsedStatement {
  lines: StatementLine[];
  problems: { row: number; message: string }[];
  /** 金額が 0・空の行（飛ばした） */
  skipped: number;
  /**
   * 残高の列との照らし合わせ（残高の列があるとき）：前の行の残高 ± 金額 ＝ その行の残高 になる行の数（matched）と、
   * 符号が逆なら合う行の数（reversed）。reversed が多ければ、入金と出金（増える側・減る側）を逆に読んでいる
   */
  balanceCheck: { compared: number; matched: number; reversed: number } | null;
}

/**
 * 残高の列と金額の向きを照らす。CSV は古い順・新しい順のどちらもあるので、両方で数えて合うほうを使う
 *  古い順：残高[i] − 残高[i−1] ＝ 増減[i]、新しい順：残高[i−1] − 残高[i] ＝ 増減[i−1]
 */
const checkBalances = (lines: StatementLine[], account: Pick<Account, "normal_side">): ParsedStatement["balanceCheck"] => {
  const signed = (l: StatementLine) => (l.side === account.normal_side ? l.amount : -l.amount);
  let compared = 0;
  const count = { asc: 0, desc: 0, ascRev: 0, descRev: 0 };
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]];
    if (a.balance === null || b.balance === null) continue;
    compared++;
    const d = b.balance - a.balance;
    if (d === signed(b)) count.asc++;
    if (d === -signed(b)) count.ascRev++;
    if (-d === signed(a)) count.desc++;
    if (-d === -signed(a)) count.descRev++;
  }
  if (!compared) return null;
  return { compared, matched: Math.max(count.asc, count.desc), reversed: Math.max(count.ascRev, count.descRev) };
};

/** 摘要の比べ方（全角半角・空白・大文字小文字の違いを無視） */
export const normDescription = (s: string) => s.normalize("NFKC").replace(/\s/g, "").toLowerCase();

/** CSV を明細にする。account = 取り込む先の科目（増える側を決める） */
export const parseStatement = (text: string, map: ColumnMap, account: Pick<Account, "normal_side">, defaultYear?: number): ParsedStatement => {
  const rows = parseCsv(text);
  const lines: StatementLine[] = [];
  const problems: ParsedStatement["problems"] = [];
  let skipped = 0;
  const seen = new Map<string, number>();
  const cell = (r: string[], i: number | null) => (i === null || i < 0 ? "" : (r[i] ?? "").trim());
  for (let i = map.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !c.trim())) continue;
    const rawDate = cell(r, map.date);
    const date = parseStatementDate(rawDate, defaultYear);
    // 合計の行など、日付の無い行（数字の無い行）は飛ばす
    if (!/\d/.test(rawDate)) { skipped++; continue; }
    if (!date) { problems.push({ row: i + 1, message: `日付を読めません：${rawDate}` }); continue; }
    let signed: number;
    if (map.mode === "split") {
      const up = parseStatementAmount(cell(r, map.increase));
      const down = parseStatementAmount(cell(r, map.decrease));
      if (Number.isNaN(up) || Number.isNaN(down)) { problems.push({ row: i + 1, message: "金額を読めません" }); continue; }
      signed = (up ?? 0) - (down ?? 0);
    } else {
      const a = parseStatementAmount(cell(r, map.amount));
      if (Number.isNaN(a)) { problems.push({ row: i + 1, message: `金額を読めません：${cell(r, map.amount)}` }); continue; }
      signed = (a ?? 0) * (map.invert ? -1 : 1);
    }
    if (signed === 0) { skipped++; continue; }
    const bal = map.balance === null ? null : parseStatementAmount(cell(r, map.balance));
    const description = map.description.map((c) => cell(r, c)).filter(Boolean).join(" ").slice(0, 200);
    const side: "debit" | "credit" = signed > 0 ? account.normal_side : account.normal_side === "debit" ? "credit" : "debit";
    const amount = Math.abs(signed);
    const key = `${date}|${side}|${amount}|${normDescription(description)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    lines.push({ row: i + 1, date, description, side, amount, balance: bal === null || Number.isNaN(bal) ? null : bal, fingerprint: `${key}|${n}` });
  }
  return { lines, problems, skipped, balanceCheck: checkBalances(lines, account) };
};

// ────────────────────────────────────────────
// 推測
// ────────────────────────────────────────────

/** 明細のルール（摘要に keyword を含む明細に、相手科目などを入れる） */
export interface BankRule {
  id: number;
  keyword: string;
  /** その口座の科目が増える明細だけ（increase）・減る明細だけ（decrease）・どちらも（any） */
  direction: "any" | "increase" | "decrease";
  /** その口座（科目）だけに使う（null = どの口座にも） */
  target_account_id: number | null;
  account_id: number;
  sub_account_id: number | null;
  tax_code: TaxCode | null;
  invoice_kind: InvoiceKind | null;
  counterparty_id: number | null;
  /** 仕訳の摘要（空なら明細の摘要のまま） */
  memo: string;
  sort_order: number;
  /** 分け方（決まった額を別の相手科目に。相手科目 account_id には残りの額が入る） */
  splits: BankRuleSplit[];
}

/** ルールの分け方の1行（例：借入金の返済のうち利子割引料 6,000円） */
export interface BankRuleSplit {
  account_id: number;
  sub_account_id: number | null;
  tax_code: TaxCode | null;
  invoice_kind: InvoiceKind | null;
  amount: number;
  /** 仕訳の摘要（空なら相手科目の行と同じ） */
  memo: string;
}

export interface Guess {
  counterId: number | null;
  counterSubId: number | null;
  taxCode: TaxCode | null;
  invoice: InvoiceKind | null;
  counterpartyId: number | null;
  memo: string;
  /** rule = ルール、history = 前の明細・仕訳、null = 推測なし */
  source: "rule" | "history" | null;
  ruleId?: number;
  /** ルールの分け方 */
  splits: BankRuleSplit[];
}

/** 前に作った仕訳の相手（摘要ごと） */
export interface HistoryHit {
  counterId: number;
  counterSubId: number | null;
  taxCode: TaxCode | null;
  invoice: InvoiceKind | null;
  counterpartyId: number | null;
  memo: string;
}

/**
 * 帳簿から、その口座で前に使った相手（摘要と増減ごと。新しいものを優先）。相手が1行の仕訳だけを使う
 * extra = 前に明細から作った仕訳の、もとの明細の摘要（仕訳の摘要を書き換えていても、明細の摘要で引けるように）
 */
export const learnFromBooks = (
  lines: FlatLine[], accountId: number, subId: number | null, extra: { entryId: number; description: string }[] = [],
): Map<string, HistoryHit> => {
  const byEntry = new Map<number, FlatLine[]>();
  for (const l of lines) if (!l.is_deleted) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  const extraOf = new Map(extra.map((x) => [x.entryId, x.description]));
  const out = new Map<string, HistoryHit>();
  const entries = [...byEntry.entries()].sort((a, b) => (a[1][0].date < b[1][0].date ? -1 : a[1][0].date > b[1][0].date ? 1 : a[0] - b[0]));
  for (const [entryId, ls] of entries) {
    const mine = ls.filter((l) => l.account_id === accountId && (l.sub_account_id ?? null) === subId);
    const others = ls.filter((l) => !mine.includes(l));
    if (mine.length !== 1 || others.length !== 1) continue;
    const o = others[0];
    const hit: HistoryHit = {
      counterId: o.account_id, counterSubId: o.sub_account_id ?? null, taxCode: o.tax_code ?? null, invoice: o.invoice_kind ?? null,
      counterpartyId: o.counterparty_id ?? null, memo: o.memo,
    };
    const descs = [o.memo, extraOf.get(entryId) ?? ""].filter(Boolean);
    for (const d of descs) out.set(`${mine[0].side}|${normDescription(d)}`, hit);
  }
  return out;
};

export const ruleMatches = (r: BankRule, line: Pick<StatementLine, "description" | "side">, account: Pick<Account, "id" | "normal_side">) => {
  if (!r.keyword.trim()) return false;
  if (r.target_account_id !== null && r.target_account_id !== account.id) return false;
  const increase = line.side === account.normal_side;
  if (r.direction === "increase" && !increase) return false;
  if (r.direction === "decrease" && increase) return false;
  return normDescription(line.description).includes(normDescription(r.keyword));
};

export const guessLine = (
  line: Pick<StatementLine, "description" | "side">, account: Pick<Account, "id" | "normal_side">, rules: BankRule[], history: Map<string, HistoryHit>,
): Guess => {
  const rule = [...rules].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).find((r) => ruleMatches(r, line, account));
  if (rule) {
    return {
      counterId: rule.account_id, counterSubId: rule.sub_account_id, taxCode: rule.tax_code, invoice: rule.invoice_kind,
      counterpartyId: rule.counterparty_id, memo: rule.memo.trim() || line.description, source: "rule", ruleId: rule.id, splits: rule.splits ?? [],
    };
  }
  const h = history.get(`${line.side}|${normDescription(line.description)}`);
  if (h) return { ...h, memo: h.memo || line.description, source: "history", splits: [] };
  return { counterId: null, counterSubId: null, taxCode: null, invoice: null, counterpartyId: null, memo: line.description, source: null, splits: [] };
};

/** 仕訳の相手の1行（税区分などはそのまま仕訳の行に入れる） */
export interface CounterPart {
  accountId: number | null;
  subId: number | null;
  tax: Pick<JournalLine, "tax_code" | "invoice_kind" | "business_class" | "purchase_use">;
  memo: string;
}

/**
 * 明細から仕訳の行を作る：この口座の1行（明細の金額）と相手科目（分けた行は決まった額、最初の相手科目は残りの額）。
 * 作れなければわけ（文字）を返す。家事按分はこのあとで分ける
 */
export const bankEntryLines = (
  line: Pick<StatementLine, "side" | "amount">, accountId: number, subId: number | null, main: CounterPart, splits: (CounterPart & { amount: number | null })[],
): JournalLine[] | string => {
  if (!main.accountId) return "相手科目を選んでください";
  if (splits.some((s) => !s.accountId)) return "分けた行の相手科目を選んでください";
  if (splits.some((s) => !s.amount || s.amount <= 0 || !Number.isSafeInteger(s.amount))) return "分けた行の金額を入れてください";
  const same = (p: CounterPart) => p.accountId === accountId && (p.subId ?? null) === subId;
  if (same(main) || splits.some(same)) return "相手科目に、この口座と同じ科目・補助科目は使えません";
  const split = splits.reduce((t, s) => t + (s.amount ?? 0), 0);
  if (split >= line.amount) return `分けた行の合計（${split.toLocaleString("ja-JP")}円）が明細の金額（${line.amount.toLocaleString("ja-JP")}円）以上です`;
  const other = line.side === "debit" ? "credit" : "debit";
  const clean = (t: CounterPart["tax"]) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null && v !== undefined));
  const mainMemo = main.memo.trim();
  const mine: JournalLine = { row_no: 0, side: line.side, account_id: accountId, sub_account_id: subId, amount: line.amount, memo: mainMemo };
  const counters: JournalLine[] = [
    { row_no: 0, side: other, account_id: main.accountId, sub_account_id: main.subId, amount: line.amount - split, memo: mainMemo, ...clean(main.tax) },
    ...splits.map((s): JournalLine => ({ row_no: 0, side: other, account_id: s.accountId!, sub_account_id: s.subId, amount: s.amount!, memo: s.memo.trim() || mainMemo, ...clean(s.tax) })),
  ];
  return (line.side === "debit" ? [mine, ...counters] : [...counters, mine]).map((l, i) => ({ ...l, row_no: i + 1 }));
};

/** 帳簿に、同じ日・同じ増減・同じ金額の仕訳がすでにあるか（手で入れた分と重なっていないか） */
export const findBookDuplicate = (
  line: Pick<StatementLine, "date" | "side" | "amount">, lines: FlatLine[], accountId: number, subId: number | null, exclude: Set<number> = new Set(),
): number | null => {
  const hit = lines.find((l) => !l.is_deleted && !exclude.has(l.entry_id) && l.account_id === accountId && (l.sub_account_id ?? null) === subId
    && l.date === line.date && l.side === line.side && l.amount === line.amount);
  return hit ? hit.entry_id : null;
};
