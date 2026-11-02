/**
 * 銀行の明細の形式（純粋関数）。銀行が公式に公開している形式だけを持つ（推測で作らない）
 *  - ゆうちょダイレクト：入出金明細の CSV（ゆうちょ銀行「ゆうちょダイレクト 主な操作方法 入出金明細」の CSV ファイルの内容）。
 *    口座の情報の行のあとに見出し。取引日（20150901）・入出金明細ID・受入金額（円）・払出金額（円）・詳細1・詳細2・現在（貸付）高。古い順
 *  - ゆうちょBizダイレクト：入出金明細の CSV（ゆうちょBizダイレクト 操作説明書（オンライン取引編）2025年6月版 18.4 ファイル出力時のファイル仕様）。
 *    取引日・入出金区分（受入／払出）・取引内容・送金人名等・受入明細番号・取扱口数・取引金額・現在（貸付）高・EDI情報等。新しい順
 *  - 三菱UFJ銀行 BizSTATION：入出金明細（CSV形式）出力フォーマット。Shift_JIS、見出しは決まった名前。
 *    取引日は和暦の YYMMDD、入払区分は 1 入金・2 出金、取引金額は符号なし。摘要と振込依頼人名
 *  - 全銀協の入出金取引明細（固定長 200 バイト。ヘッダー・データ・トレーラ・エンドのレコード）：多くの銀行の法人・事業者向けの
 *    インターネットバンキングで出せる形（北國銀行「入出金取引明細レコード・フォーマット」）。勘定日は和暦の YYMMDD、入払区分は 1・2
 * 公式の形式が無い銀行・カードは、見出しから列を推測する（lib/bankImport.ts の guessColumns）
 */
import type { ColumnMap } from "./bankImport";

export type BankFormatId = "yucho-direct" | "yucho-biz" | "mufg-biz" | "zengin";

export interface BankFormat {
  id: BankFormatId;
  name: string;
  /** よりどころの資料 */
  source: string;
  /** 見出しの名前（全角半角・空白の違いは無視）。すべてあれば、この形式 */
  required: string[];
  /** 見出しから列の対応を作る（find = 見出しの名前の列。無ければ -1） */
  build: (find: (name: string) => number) => Omit<ColumnMap, "headerRow" | "format">;
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
const some = (...xs: number[]) => xs.filter((x) => x >= 0);
const opt = (x: number) => (x >= 0 ? x : null);

/** 全銀協の固定長を表にしたときの見出し（zenginToTable） */
export const ZENGIN_HEADER = ["勘定日", "起算日", "入払区分", "取引区分", "取引金額", "振込依頼人名", "仕向銀行名", "仕向店名", "摘要内容", "照会番号"];

export const BANK_FORMATS: BankFormat[] = [
  {
    id: "yucho-direct", name: "ゆうちょダイレクト", source: "ゆうちょ銀行「ゆうちょダイレクト 入出金明細」の CSV ファイルの内容",
    required: ["取引日", "入出金明細ID", "受入金額(円)", "払出金額(円)"],
    build: (f) => ({
      date: f("取引日"), description: some(f("詳細1"), f("詳細2")), mode: "split",
      increase: f("受入金額(円)"), decrease: f("払出金額(円)"), amount: null, invert: false, balance: opt(f("現在(貸付)高")),
    }),
  },
  {
    id: "yucho-biz", name: "ゆうちょBizダイレクト", source: "ゆうちょBizダイレクト 操作説明書（オンライン取引編）2025年6月版 18.4 ファイル出力時のファイル仕様",
    required: ["取引日", "入出金区分", "取引内容", "取引金額"],
    build: (f) => ({
      date: f("取引日"), description: some(f("取引内容"), f("送金人名等")), mode: "kind", kind: f("入出金区分"), kindIncrease: ["受入"], kindDecrease: ["払出"],
      increase: null, decrease: null, amount: f("取引金額"), invert: false, balance: opt(f("現在(貸付)高")),
    }),
  },
  {
    id: "mufg-biz", name: "三菱UFJ銀行 BizSTATION", source: "三菱UFJ銀行「入出金明細（CSV形式）出力フォーマット」",
    required: ["金融機関コード", "取引日", "入払区分", "取引金額", "振込依頼人名", "摘要"],
    build: (f) => ({
      date: f("取引日"), dateStyle: "wareki6", description: some(f("摘要"), f("振込依頼人名")), mode: "kind", kind: f("入払区分"), kindIncrease: ["1"], kindDecrease: ["2"],
      increase: null, decrease: null, amount: f("取引金額"), invert: false, balance: null,
    }),
  },
  {
    id: "zengin", name: "全銀協の入出金取引明細（固定長）", source: "全銀協の入出金取引明細レコード・フォーマット（銀行の公開資料）",
    required: ["勘定日", "入払区分", "取引金額", "摘要内容"],
    build: (f) => ({
      date: f("勘定日"), dateStyle: "wareki6", description: some(f("摘要内容"), f("振込依頼人名")), mode: "kind", kind: f("入払区分"), kindIncrease: ["1"], kindDecrease: ["2"],
      increase: null, decrease: null, amount: f("取引金額"), invert: false, balance: null,
    }),
  },
];

export const formatOf = (id: string | undefined) => BANK_FORMATS.find((f) => f.id === id);

/** その形式で、headerRow の行を見出しとして列の対応を作る（見出しが足りなければ null） */
export const mapWithFormat = (format: BankFormat, rows: string[][], headerRow: number): ColumnMap | null => {
  const head = (rows[headerRow] ?? []).map(norm);
  const find = (name: string) => head.indexOf(norm(name));
  if (!format.required.every((n) => find(n) >= 0)) return null;
  return { ...format.build(find), headerRow, format: format.id };
};

/** 見出しの行を上から20行まで探して、形式を見分ける（どれにも合わなければ null） */
export const detectFormat = (rows: string[][]): ColumnMap | null => {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    for (const f of BANK_FORMATS) {
      const m = mapWithFormat(f, rows, r);
      if (m) return m;
    }
  }
  return null;
};

/** その形式の見出しの行を探す（選び直したとき） */
export const mapForFormat = (format: BankFormat, rows: string[][]): ColumnMap | null => {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const m = mapWithFormat(format, rows, r);
    if (m) return m;
  }
  return null;
};

/**
 * 全銀協の入出金取引明細（固定長 200 文字のレコード。改行があってもなくてもよい）なら、表（見出し＋データ）にする。違えば null。
 * 半角の文字だけの形（コード区分 0：JIS）なので、文字の位置で切る。accounts = ヘッダーレコードの数（口座の数）
 */
export const zenginToTable = (text: string): { rows: string[][]; accounts: number } | null => {
  const body = text.replace(/^﻿/, "");
  const lines = /\r?\n/.test(body.trim()) ? body.split(/\r?\n/).filter((l) => l.length > 0) : body.match(/.{1,200}/gs) ?? [];
  if (lines.length < 2 || !lines.every((l) => l.length === 200 && /^[1289]/.test(l))) return null;
  // ヘッダーレコード：データ区分「1」・種別コード「03」（入出金取引明細）
  if (!lines[0].startsWith("103")) return null;
  const at = (l: string, from: number, len: number) => l.slice(from - 1, from - 1 + len).trim();
  const rows = [ZENGIN_HEADER];
  for (const l of lines.filter((x) => x[0] === "2")) {
    rows.push([at(l, 10, 6), at(l, 16, 6), at(l, 22, 1), at(l, 23, 2), at(l, 25, 12), at(l, 82, 48), at(l, 130, 15), at(l, 145, 15), at(l, 160, 20), at(l, 2, 8)]);
  }
  return { rows, accounts: lines.filter((x) => x[0] === "1").length };
};

/** 明細のファイルを表にする（全銀協の固定長なら表に直し、ほかは CSV として読む） */
export const statementTable = (text: string, parseCsv: (t: string) => string[][]) => zenginToTable(text)?.rows ?? parseCsv(text);

/**
 * 和暦の YYMMDD（令和。令和の年より大きければ平成）を西暦の日付にする。
 * thisYear = 今の年（令和の年の上限を決める。令和 YY が thisYear + 1 を超えれば平成）
 */
export const warekiYymmdd = (raw: string, thisYear: number): string | null => {
  const m = raw.normalize("NFKC").trim().match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const yy = Number(m[1]);
  const y = 2018 + yy <= thisYear + 1 ? 2018 + yy : 1988 + yy;
  const iso = `${y}-${m[2]}-${m[3]}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === Number(m[2]) && t.getUTCDate() === Number(m[3]) ? iso : null;
};
