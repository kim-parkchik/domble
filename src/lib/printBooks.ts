/**
 * 帳簿の印刷の中身（純粋関数）：仕訳日記帳・総勘定元帳（補助元帳・出納帳）・残高試算表・固定資産台帳・訂正削除履歴
 * ページへの分け方は printLayout.ts、画面は components/PrintPreview.tsx
 */
import type { LedgerRow } from "./accounting";
import { shortDate, yen } from "./format";
import type { CsvValue } from "./csv";
import type { PrintCell, PrintColumn, PrintGroup, PrintRow, PrintSection } from "./printLayout";

/** 期間の番号：1〜12 = 月、13 = 決算整理（12月のあと） */
export const ADJUSTMENT = 13;
const periodOf = (r: LedgerRow) => (r.isAdjustment ? ADJUSTMENT : Number(r.date.slice(5, 7)));
const periodName = (p: number) => (p === ADJUSTMENT ? "決算整理" : `${p}月`);

/** 期首（期間の初め）の繰越の名前 */
export const carriedLabel = (from: number) => (from === 1 ? "前期より繰越" : from === ADJUSTMENT ? "12月より繰越" : "前月より繰越");

// ────────────────────────────────────────────
// 総勘定元帳・補助元帳・出納帳
// ────────────────────────────────────────────

export interface LedgerPrintSource {
  /** ページの見出し（科目名。補助元帳は「科目　補助科目」） */
  heading: string;
  /** 1年分の元帳（buildLedger の結果。期首残高から積み上げた残高つき） */
  rows: LedgerRow[];
  /** 期首残高 */
  opening: number;
  /** 期間（1〜13） */
  from: number;
  to: number;
  /** 借方・貸方の列の名前（出納帳は 入金・出金 など） */
  labels: { dr: string; cr: string };
  counterOf: (r: LedgerRow) => string;
  taxOf: (r: LedgerRow) => string;
  /** 摘要の2行目（補助科目・取引先など） */
  noteOf: (r: LedgerRow) => string;
}

export const ledgerColumns = (labels: { dr: string; cr: string }): PrintColumn[] => [
  { label: "日付", width: 11, nowrap: true },
  { label: "No.", width: 8, align: "right", nowrap: true },
  { label: "相手科目", width: 20 },
  { label: "税区分", width: 12 },
  { label: "摘要", width: 42 },
  { label: labels.dr, width: 16, align: "right" },
  { label: labels.cr, width: 16, align: "right" },
  { label: "残高", width: 17, align: "right" },
];

const carryRow = (label: string, balance: number): PrintRow => ({
  kind: "carried",
  cells: [{ text: "", span: 2 }, { text: label, span: 5 }, { text: yen(balance), align: "right" }],
});

/**
 * 元帳の1区分。行ごとに1つのまとまり（続きのページの先頭に「前頁より繰越」）、
 * 期間（月・決算整理）の終わりに「月計」と「累計」（年の初めからの借方・貸方の合計）
 */
export const ledgerSection = (s: LedgerPrintSource): PrintSection => {
  const before = s.rows.filter((r) => periodOf(r) < s.from);
  const rows = s.rows.filter((r) => periodOf(r) >= s.from && periodOf(r) <= s.to);
  const carried = before.length ? before[before.length - 1].balance : s.opening;
  let cumDr = before.reduce((t, r) => t + r.debit, 0);
  let cumCr = before.reduce((t, r) => t + r.credit, 0);

  const groups: PrintGroup[] = [{ rows: [carryRow(carriedLabel(s.from), carried)], carry: carryRow("前頁より繰越", carried) }];
  let monthDr = 0;
  let monthCr = 0;
  rows.forEach((r, i) => {
    groups.push({
      rows: [{
        cells: [
          shortDate(r.date), String(r.entry_id), s.counterOf(r), s.taxOf(r),
          { text: r.memo, note: s.noteOf(r) || undefined, tag: r.isAdjustment ? "決算整理" : undefined },
          yen(r.debit, { blankZero: true }), yen(r.credit, { blankZero: true }), yen(r.balance),
        ],
      }],
      carry: carryRow("前頁より繰越", r.balance),
    });
    monthDr += r.debit;
    monthCr += r.credit;
    const p = periodOf(r);
    if (i === rows.length - 1 || periodOf(rows[i + 1]) !== p) {
      cumDr += monthDr;
      cumCr += monthCr;
      const total = (label: string, dr: number, cr: number): PrintRow => ({
        kind: "month",
        cells: [{ text: "", span: 2 }, { text: label, span: 3, align: "center" }, yen(dr), yen(cr), ""],
      });
      groups.push({
        rows: [total(`${periodName(p)}　計`, monthDr, monthCr), total("累　計", cumDr, cumCr)],
        carry: carryRow("前頁より繰越", r.balance),
      });
      monthDr = 0;
      monthCr = 0;
    }
  });
  if (rows.length === 0) groups.push({ rows: [{ cells: [{ text: "", span: 2 }, { text: "この期間の動きはありません", span: 6 }] }] });
  return { heading: s.heading, columns: ledgerColumns(s.labels), groups };
};

/** 元帳の CSV の見出し */
export const LEDGER_CSV_HEADER = ["科目", "補助科目", "日付", "伝票No", "相手科目", "税区分", "摘要", "取引先", "借方", "貸方", "残高", "決算整理"];

/** 元帳の CSV の行（科目ごと。最初に繰越の行） */
export const ledgerCsvRows = (
  account: string, s: Pick<LedgerPrintSource, "rows" | "opening" | "from" | "to" | "counterOf" | "taxOf">,
  subOf: (r: LedgerRow) => string, counterpartyOf: (r: LedgerRow) => string,
): CsvValue[][] => {
  const before = s.rows.filter((r) => periodOf(r) < s.from);
  const carried = before.length ? before[before.length - 1].balance : s.opening;
  return [
    [account, "", "", "", "", "", carriedLabel(s.from), "", "", "", carried, ""],
    ...s.rows.filter((r) => periodOf(r) >= s.from && periodOf(r) <= s.to).map((r) => [
      account, subOf(r), r.date, r.entry_id, s.counterOf(r), s.taxOf(r), r.memo, counterpartyOf(r),
      r.debit || "", r.credit || "", r.balance, r.isAdjustment ? "決算整理" : "",
    ]),
  ];
};

// ────────────────────────────────────────────
// 仕訳日記帳
// ────────────────────────────────────────────

export interface JournalSide {
  /** 科目（補助科目は note） */
  account: string;
  sub: string;
  tax: string;
  amount: number;
}

export interface JournalPrintEntry {
  entryId: number;
  date: string;
  /** 削除済み・訂正あり・決算整理・遅れて登録 など */
  tags: string[];
  deleted: boolean;
  counterparty: string;
  /** 振替伝票の行ごとの借方・貸方と摘要 */
  lines: { dr?: JournalSide; cr?: JournalSide; memo: string }[];
}

export const JOURNAL_COLUMNS: PrintColumn[] = [
  { label: "日付", width: 11, nowrap: true },
  { label: "No.", width: 8, align: "right", nowrap: true },
  { label: "借方科目", width: 24 },
  { label: "借方金額", width: 16, align: "right" },
  { label: "貸方科目", width: 24 },
  { label: "貸方金額", width: 16, align: "right" },
  { label: "摘要", width: 44 },
];

const sideCells = (x?: JournalSide): (string | PrintCell)[] =>
  x ? [{ text: x.account, note: [x.sub, x.tax].filter(Boolean).join("　") || undefined }, yen(x.amount)] : ["", ""];

/** 仕訳ごとに1つのまとまり（複合仕訳の行を同じページに）。最後に合計 */
export const journalSection = (entries: JournalPrintEntry[], heading = ""): PrintSection => {
  const total = entries.filter((e) => !e.deleted).reduce((t, e) => t + e.lines.reduce((s, l) => s + (l.dr?.amount ?? 0), 0), 0);
  const groups: PrintGroup[] = entries.map((e) => ({
    rows: e.lines.map((l, i): PrintRow => ({
      kind: e.deleted ? "deleted" : i === 0 ? "first" : undefined,
      cells: [
        i === 0 ? shortDate(e.date) : "", i === 0 ? String(e.entryId) : "", ...sideCells(l.dr), ...sideCells(l.cr),
        {
          text: l.memo,
          tag: i === 0 && e.tags.length ? e.tags.join("・") : undefined,
          note: i === 0 && e.counterparty ? e.counterparty : undefined,
        },
      ],
    })),
  }));
  if (entries.length === 0) groups.push({ rows: [{ cells: [{ text: "条件に合う仕訳はありません", span: 7 }] }] });
  groups.push({ rows: [{ kind: "total", cells: [{ text: "合計", span: 3, align: "center" }, yen(total), "", yen(total), ""] }] });
  return { heading, columns: JOURNAL_COLUMNS, groups };
};

// ────────────────────────────────────────────
// 残高試算表
// ────────────────────────────────────────────

export interface TrialPrintLine {
  kind: "category" | "account" | "sub" | "subtotal" | "total";
  label: string;
  carried: number;
  debit: number;
  credit: number;
  balance: number;
  /** 合計の行で、借方・貸方の欄に出す文字（所得金額の「期間中」など） */
  middle?: string;
}

export const trialColumns = (carriedHead: string, balanceHead: string): PrintColumn[] => [
  { label: "勘定科目", width: 34 },
  { label: carriedHead, width: 17, align: "right" },
  { label: "借方", width: 17, align: "right" },
  { label: "貸方", width: 17, align: "right" },
  { label: balanceHead, width: 17, align: "right" },
];

/** 区分（資産・負債など）ごとに1つのまとまり（見出し・科目・小計を同じページに） */
export const trialSection = (heading: string, lines: TrialPrintLine[], carriedHead: string, balanceHead: string): PrintSection => {
  const groups: PrintGroup[] = [];
  for (const l of lines) {
    if (l.kind === "category" || groups.length === 0 || l.kind === "total") groups.push({ rows: [] });
    const row: PrintRow =
      l.kind === "category" ? { kind: "category", cells: [{ text: l.label, span: 5 }] }
        : l.kind === "total" && l.middle !== undefined
          ? { kind: "total", cells: [l.label, yen(l.carried), { text: l.middle, span: 2, align: "right" }, yen(l.balance)] }
          : {
            kind: l.kind === "account" ? undefined : l.kind,
            cells: [l.label, yen(l.carried), yen(l.debit, { blankZero: l.kind !== "subtotal" && l.kind !== "total" }),
              yen(l.credit, { blankZero: l.kind !== "subtotal" && l.kind !== "total" }), yen(l.balance)],
          };
    groups[groups.length - 1].rows.push(row);
  }
  return { heading, columns: trialColumns(carriedHead, balanceHead), groups };
};

export const TRIAL_CSV_HEADER = ["区分", "勘定科目", "補助科目", "繰越", "借方", "貸方", "残高"];

// ────────────────────────────────────────────
// 固定資産台帳
// ────────────────────────────────────────────

export interface AssetPrintLine {
  name: string;
  account: string;
  /** 取得日・使用開始日（YYYY-MM-DD） */
  acquired: string;
  used: string;
  cost: number;
  method: string;
  /** 耐用年数の表示（5年・3年・—） */
  life: string;
  rate: string;
  months: number;
  opening: number;
  depreciation: number;
  businessRate: number;
  business: number;
  closing: number;
  /** 売却・除却・摘要 */
  memo: string;
}

export const ASSET_COLUMNS: PrintColumn[] = [
  { label: "名称・科目", width: 25 },
  { label: "取得日・使用開始", width: 20, nowrap: true },
  { label: "取得価額", width: 15, align: "right" },
  { label: "償却方法・耐用年数", width: 15 },
  { label: "償却率", width: 9, align: "right" },
  { label: "月数", width: 6, align: "right" },
  { label: "期首の未償却残高", width: 15, align: "right" },
  { label: "本年分の償却費", width: 15, align: "right" },
  { label: "事業専用割合", width: 9, align: "right" },
  { label: "必要経費に入れる額", width: 15, align: "right" },
  { label: "期末の未償却残高", width: 15, align: "right" },
];

const slash = (iso: string) => iso.replace(/-/g, "/");

export const assetSection = (heading: string, lines: AssetPrintLine[]): PrintSection => {
  const sum = (k: "opening" | "depreciation" | "business" | "closing") => lines.reduce((s, l) => s + l[k], 0);
  const groups: PrintGroup[] = lines.map((l) => ({
    rows: [{
      cells: [
        { text: l.name, note: [l.account, l.memo].filter(Boolean).join("　") },
        { text: slash(l.acquired), note: slash(l.used) },
        yen(l.cost), { text: l.method, note: l.life }, l.rate, String(l.months), yen(l.opening), yen(l.depreciation),
        `${l.businessRate}%`, yen(l.business), yen(l.closing),
      ],
    }],
  }));
  if (lines.length === 0) groups.push({ rows: [{ cells: [{ text: "この年に償却する資産はありません", span: 11 }] }] });
  groups.push({
    rows: [{
      kind: "total",
      cells: [{ text: "合計", span: 6, align: "center" }, yen(sum("opening")), yen(sum("depreciation")), "", yen(sum("business")), yen(sum("closing"))],
    }],
  });
  return { heading, columns: ASSET_COLUMNS, groups };
};

export const ASSET_CSV_HEADER = [
  "名称", "科目", "取得日", "使用開始日", "取得価額", "償却方法", "耐用年数", "償却率", "本年中の償却期間（月）",
  "期首の未償却残高", "本年分の償却費", "事業専用割合（%）", "必要経費に入れる額", "期末の未償却残高", "摘要",
];

export const assetCsvRows = (lines: AssetPrintLine[]): CsvValue[][] =>
  lines.map((l) => [l.name, l.account, l.acquired, l.used, l.cost, l.method, l.life, l.rate, l.months, l.opening, l.depreciation, l.businessRate, l.business, l.closing, l.memo]);

// ────────────────────────────────────────────
// 訂正削除履歴など（CSV と同じ列の表）
// ────────────────────────────────────────────

/**
 * CSV と同じ列の表。recordKey が同じ行（1つの記録の複数行）は1つのまとまりにし、
 * 2行目からは repeat に入っていない列（記録日時・伝票No など）を空けて読みやすくする
 */
export const tableSection = (
  heading: string, header: string[], widths: number[], rows: CsvValue[][], recordKey?: (r: CsvValue[]) => string, repeat: number[] = [],
): PrintSection => {
  const columns = header.map((label, i) => ({ label, width: widths[i] ?? 10, align: (typeof rows[0]?.[i] === "number" ? "right" : undefined) as PrintColumn["align"] }));
  const text = (v: CsvValue, numeric: boolean) => (v == null ? "" : typeof v === "number" && numeric ? yen(v) : String(v));
  const groups: PrintGroup[] = [];
  let lastKey: string | null = null;
  for (const r of rows) {
    const key = recordKey ? recordKey(r) : null;
    const cont = key !== null && key === lastKey;
    if (!cont) groups.push({ rows: [] });
    groups[groups.length - 1].rows.push({
      kind: !cont && recordKey ? "first" : undefined,
      cells: r.map((v, i) => (cont && !repeat.includes(i) ? "" : text(v, columns[i].align === "right" && /金額/.test(header[i])))),
    });
    lastKey = key;
  }
  if (rows.length === 0) groups.push({ rows: [{ cells: [{ text: "記録はありません", span: header.length }] }] });
  return { heading, columns, groups };
};

// ────────────────────────────────────────────
// 訂正・削除履歴（仕訳）
// ────────────────────────────────────────────

export interface HistoryPrintRecord {
  recordedAt: string;
  entryId: number;
  revision: number;
  /** 登録・訂正・削除 */
  action: string;
  user: string;
  reason: string;
  /** 仕訳の中身（訂正前・訂正後・登録時・削除時） */
  parts: {
    label: string;
    date: string;
    counterparty: string;
    lines: { side: "debit" | "credit"; account: string; sub: string; amount: number; memo: string }[];
  }[];
}

export const HISTORY_COLUMNS: PrintColumn[] = [
  { label: "記録日時", width: 15 },
  { label: "No.", width: 7, align: "right", nowrap: true },
  { label: "操作", width: 9 },
  { label: "操作者・理由", width: 16 },
  { label: "内容", width: 9 },
  { label: "日付", width: 14, nowrap: true },
  { label: "借貸", width: 6, align: "center" },
  { label: "科目", width: 18 },
  { label: "金額", width: 13, align: "right" },
  { label: "摘要", width: 21 },
];

/** 1つの記録（訂正なら訂正前と訂正後）を1つのまとまりに */
export const historySection = (heading: string, records: HistoryPrintRecord[]): PrintSection => {
  const groups: PrintGroup[] = records.map((r) => ({
    rows: r.parts.flatMap((p, pi) =>
      p.lines.map((l, li): PrintRow => {
        const first = pi === 0 && li === 0;
        return {
          kind: first ? "first" : undefined,
          cells: [
            first ? r.recordedAt : "", first ? String(r.entryId) : "",
            first ? { text: r.action, note: `第${r.revision}版` } : "",
            first ? { text: r.user, note: r.reason ? `理由：${r.reason}` : undefined } : "",
            li === 0 ? p.label : "", li === 0 ? slash(p.date) : "",
            l.side === "debit" ? "借方" : "貸方", { text: l.account, note: l.sub || undefined }, yen(l.amount),
            { text: l.memo, note: li === 0 && p.counterparty ? p.counterparty : undefined },
          ],
        };
      })),
  }));
  if (records.length === 0) groups.push({ rows: [{ cells: [{ text: "該当する履歴はありません", span: HISTORY_COLUMNS.length }] }] });
  return { heading, columns: HISTORY_COLUMNS, groups };
};
