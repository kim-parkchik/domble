/**
 * 消費税の申告書を e-Tax のデータ（xtx）にする（純粋関数。数字は taxReturn.ts の計算結果をそのまま使う）
 *
 * 手続（令和8年分。手続の版 26.0.0）
 *  - 第一表が一般用：RSH0010（消費税及び地方消費税申告(一般・個人)）
 *      本則課税：SHA010（第一表・第二表）・SHB017（付表1-3）・SHB033（付表2-3）
 *      2割特例：SHA010・SHB070（付表6）。第一表の「控除税額の計算方法」を 8（2割特例）にする
 *  - 第一表が簡易課税用：RSH0030（消費税及び地方消費税申告(簡易課税・個人)）
 *      簡易課税：SHA020（第一表・第二表）・SHB047（付表4-3）・SHB067（付表5-3）
 *      2割特例：SHA020・SHB070。第一表の「税額控除に係る経過措置の適用（２割特例）」を 1（該当）にする
 *  - 3割特例は、国税庁の様式（付表）がまだ無いため書き出せない
 * 確定申告だけ（中間申告・修正申告は対象外）。個人番号と提出年月日は e-Tax の側で入れる
 */
import type { FormRow, TaxReturn } from "./taxReturn";
import { documentXml, formXml, itRefs, itXml, type EtaxFiler, type EtaxValues, type FormAttrs } from "./etax";

const NAMESPACE = "http://xml.e-tax.nta.go.jp/XSD/shohi";
const PROCEDURES = {
  一般用: { procedure: "RSH0010", name: "消費税及び地方消費税申告(一般・個人)", first: "SHA010" },
  簡易課税用: { procedure: "RSH0030", name: "消費税及び地方消費税申告(簡易課税・個人)", first: "SHA020" },
} as const;
const PROCEDURE_VERSION = "26.0.0";
/** この版で書き出せる最初の年分 */
export const XTX_FIRST_YEAR = 2026;

/** 書き出せない理由（書き出せるなら null） */
export const xtxProblem = (r: TaxReturn, year: number): string | null => {
  if (r.method === "thirty") return "3割特例の付表は国税庁の様式がまだ出ていないため、e-Tax のデータは書き出せません";
  if (year < XTX_FIRST_YEAR) return `e-Tax のデータは令和8年（${XTX_FIRST_YEAR}年）分からの様式で書き出します。それより前の年分には対応していません`;
  return null;
};

type Tags = string | [string, string, string];
type Table = Record<string, Tags>;
const tag = (prefix: string, n: number) => `${prefix}${String(n).padStart(5, "0")}`;
/** A・B・C の3つの欄（a, a+da, a+dc） */
const abc = (prefix: string, a: number, dc = 20, db = 10): [string, string, string] => [tag(prefix, a), tag(prefix, a + db), tag(prefix, a + dc)];

const rowsOf = (r: TaxReturn, id: string): FormRow[] => r.forms.find((f) => f.id === id)?.rows ?? [];
const rowOf = (r: TaxReturn, id: string, no: string) => rowsOf(r, id).find((x) => (x.key ?? x.no) === no);

/** 欄の番号（または key）→ タグ の表に従って、行の値を入れる */
const fill = (v: EtaxValues, rows: FormRow[], table: Table) => {
  for (const row of rows) {
    const t = table[row.key ?? row.no];
    if (!t) continue;
    if (typeof t === "string") {
      if (row.c !== null) v[t] = row.c;
    } else {
      v[t[0]] = row.a ?? 0;
      v[t[1]] = row.b ?? 0;
      if (row.c !== null) v[t[2]] = row.c;
    }
  }
  return v;
};

/** 付表の頭（課税期間・氏名又は名称） */
const fuhyoHead = (prefix: string): EtaxValues => ({
  [tag(prefix, 20)]: { ref: "KAZEI_KIKAN_FROM" },
  [tag(prefix, 30)]: { ref: "KAZEI_KIKAN_TO" },
  [tag(prefix, 40)]: { ref: "NOZEISHA_NM" },
});

/** 割合（小数点以下 digits 桁未満切り捨て） */
const ratio = (x: number, total: number, digits: number) => {
  const k = 10 ** digits;
  return { decimal: (Math.floor((x * 100 * k) / total) / k).toFixed(digits) };
};

// ── 付表 ──
const FUHYO13: Table = {
  "①-1": abc("DSC", 20), "①": abc("DSB", 10), "②": abc("DSD", 10), "③": abc("DSE", 10), "④": abc("DSF", 20),
  "⑤": abc("DSF", 60), "⑤-1": abc("DSF", 110), "⑥": abc("DSF", 180), "⑦": abc("DSF", 220),
  "⑧": "DSG00000", "⑨": "DSH00000", "⑩": "DSI00010", "⑪": "DSI00020", "⑫": "DSJ00010", "⑬": "DSJ00020",
};
const FUHYO23: Table = {
  "①": abc("DTB", 20), "②": "DTB00050", "③": "DTB00060", "④": "DTB00070", "⑥": "DTC00020", "⑦": "DTC00030",
  "⑨": abc("DTE", 20), "⑩": abc("DTE", 60), "⑪": abc("DTE", 280), "⑫": abc("DTE", 320), "⑰": abc("DTE", 240),
  "⑱": abc("DTF", 10), "㉒": abc("DTG", 150), "㉖": abc("DTI", 20), "㉗": abc("DTI", 60), "㉘": abc("DTJ", 10),
};
const FUHYO43: Table = {
  "①-1": abc("DUC", 10), "①": abc("DUB", 10), "②": abc("DUD", 10), "③": abc("DUE", 10), "④": abc("DUF", 20),
  "⑤": abc("DUF", 60), "⑥": abc("DUF", 100), "⑦": abc("DUF", 140),
  "⑧": "DUG00000", "⑨": "DUH00000", "⑩": "DUI00010", "⑪": "DUI00020", "⑫": "DUJ00010", "⑬": "DUJ00020",
};
const SALES_ROWS = "⑦⑧⑨⑩⑪⑫";
const TAX_ROWS = "⑭⑮⑯⑰⑱⑲";
const PAIR_ROWS = "㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱";
const FUHYO53: Table = {
  "①": abc("DVB", 20), "②": abc("DVB", 60), "③": abc("DVB", 100), "④": abc("DVB", 140), "⑤": abc("DVC", 20),
  "⑥": abc("DVD", 30), "⑬": abc("DVD", 440), "⑳": abc("DVE", 20), "㉑": abc("DVE", 80), "㊲": abc("DVE", 730),
  // 第一種〜第六種の課税売上高（A・B・合計）と消費税額
  ...Object.fromEntries([...SALES_ROWS].map((no, i) => [no, abc("DVD", 70 + i * 60, 30)])),
  ...Object.fromEntries([...TAX_ROWS].map((no, i) => [no, abc("DVD", 480 + i * 40)])),
  ...Object.fromEntries([...PAIR_ROWS].map((no, i) => [no, abc("DVE", 130 + i * 40)])),
};
const FUHYO6: Table = {
  "①": abc("AYB", 20), "②": abc("AYB", 60), "③": abc("AYB", 100), "④": abc("AYB", 140), "⑤": abc("AYB", 180),
  "⑥": abc("AYB", 220), "⑦": abc("AYC", 20), "⑧": abc("AYD", 20),
};

const fuhyo23Values = (r: TaxReturn) => {
  const v = fill(fuhyoHead("DTA"), rowsOf(r, "2-3"), FUHYO23);
  v.DTC00010 = v.DTB00070; // ⑤ ＝ ④
  const r4 = rowOf(r, "2-3", "④")?.c ?? 0;
  const r7 = rowOf(r, "2-3", "⑦")?.c ?? 0;
  if (r7 > 0) v.DTD00000 = ratio(r4, r7, 2);
  return v;
};

const fuhyo53Values = (r: TaxReturn) => {
  const rows = rowsOf(r, "5-3");
  const v = fill(fuhyoHead("DVA"), rows, FUHYO53);
  const five = rows.find((x) => x.no === "⑤");
  if (five?.kubun) v.DVC00010 = { kubun: five.kubun };
  const major = rows.find((x) => x.no === "㉑");
  if (major?.kubun) v.DVE00070 = { kubun: major.kubun };
  // 事業区分ごとの売上割合（小数第1位未満切り捨て）
  const total = rows.find((x) => x.no === "⑥")?.c ?? 0;
  [...SALES_ROWS].forEach((no, i) => {
    const row = rows.find((x) => x.no === no);
    if (row && row.c !== null && total > 0) v[tag("DVD", 110 + i * 60)] = ratio(row.c, total, 1);
  });
  return v;
};

// ── 第一表・第二表 ──
/** 納税者等部（第一表は AAI/ABH、第二表は AAN/ABM。番号は同じ） */
const headValues = (prefix: string, f: EtaxFiler, first: boolean): EtaxValues => {
  const refs = itRefs(f);
  const v: EtaxValues = {};
  // 名称又は屋号 = 屋号、代表者氏名又は氏名 = 氏名（個人）。第二表には提出先税務署が無い
  const numbers: [string, number, number][] = [
    ["ZEIMUSHO", 20, 0], ["NOZEISHA_ADR", 30, 10], ["NOZEISHA_TEL", 40, 20], ["NOZEISHA_YAGO_KN", 60, 40], ["NOZEISHA_YAGO", 70, 50],
    ["NOZEISHA_NM_KN", 100, 70], ["NOZEISHA_NM", 110, 80], ["KAZEI_KIKAN_FROM", 130, 100], ["KAZEI_KIKAN_TO", 140, 110], ["SHINKOKU_KBN", 150, 120],
  ];
  for (const [ref, one, two] of numbers) {
    const n = first ? one : two;
    if (n && refs.has(ref)) v[tag(prefix, n)] = { ref };
  }
  return v;
};

const firstValues = (r: TaxReturn, f: EtaxFiler) => {
  const general = r.firstKind === "一般用";
  const [tax, local, note, ref] = general ? ["AAJ", "AAK", "AAL", "AAM"] : ["ABI", "ABJ", "ABK", "ABL"];
  const table: Table = {
    "①": tag(tax, 10), "②": tag(tax, 20), "③": tag(tax, 30), "④": tag(tax, 50), "⑤": tag(tax, 60), "⑥": tag(tax, 70),
    "⑦": tag(tax, 80), "⑧": tag(tax, 90), "⑨": tag(tax, 100), "⑩": tag(tax, 110), "⑪": tag(tax, 120), "⑫": tag(tax, 130),
    "⑰": tag(local, 20), "⑱": tag(local, 30), "⑲": tag(local, 50), "⑳": tag(local, 60), "㉑": tag(local, 70),
    "㉒": tag(local, 80), "㉓": tag(local, 90), "㉖": tag(local, 130),
    ...(general ? { "⑮": "AAJ00180", "⑯": "AAJ00190" } : { "⑮": "ABI00170", baseSales: "ABI00180" }),
  };
  const rows = rowsOf(r, "first");
  const v = fill(headValues(general ? "AAI" : "ABH", f, true), rows, table);
  // 付記事項（割賦基準・延払基準・工事進行基準・現金主義会計）と、課税標準額に対する消費税額の計算の特例（積上げ計算）は「無」
  for (const n of [10, 20, 30, 40]) v[tag(note, n)] = { kubun: 2 };
  v[tag(ref, 10)] = { kubun: 2 };
  const baseSales = rows.find((x) => x.key === "baseSales")?.c ?? null;
  if (general) {
    // 控除税額の計算方法：1 個別対応方式・2 一括比例配分方式・3 全額控除・8 2割特例
    v.AAM00020 = { kubun: r.method === "twenty" ? 8 : rowOf(r, "2-3", "⑱") ? 3 : 2 };
    if (baseSales !== null) v.AAM00030 = Math.floor(baseSales / 1000); // 千円単位
  } else {
    if (r.method === "twenty") v.ABY00000 = { kubun: 1 };
    // 事業区分ごとの課税売上高（千円）と売上割合
    const classes = [1, 2, 3, 4, 5, 6].filter((k) => rows.some((x) => x.key === `class${k}`));
    const fiveThree = rowsOf(r, "5-3");
    const total = fiveThree.find((x) => x.no === "⑥")?.c ?? 0;
    for (const k of classes) {
      const row = rows.find((x) => x.key === `class${k}`)!;
      if (row.c !== null) v[tag("ABL", 40 + (k - 1) * 30)] = row.c;
      const sales = fiveThree.find((x) => x.no === SALES_ROWS[k - 1])?.c ?? null;
      v[tag("ABL", 50 + (k - 1) * 30)] = classes.length === 1 ? { decimal: "100.0" } : sales !== null && total > 0 ? ratio(sales, total, 1) : { decimal: "0.0" };
    }
    const rule = rows.find((x) => x.key === "rule57");
    if (rule) v.ABL00210 = { kubun: rule.note === "有" ? 1 : 2 };
  }
  return v;
};

const secondValues = (r: TaxReturn, f: EtaxFiler) => {
  const general = r.firstKind === "一般用";
  const t = general
    ? { "①": "AAP00000", "⑤": "AAQ00040", "⑥": "AAQ00050", "⑦": "AAQ00060", "⑪": "AAS00000", "⑮": "AAT00040", "⑯": "AAT00050", "⑰": "AAU00000", "⑱": "AAV00010", "⑳": "AAW00010", "㉓": "AAW00040" }
    : { "①": "ABO00000", "⑤": "ABP00040", "⑥": "ABP00050", "⑦": "ABP00060", "⑪": "ABR00000", "⑮": "ABS00040", "⑯": "ABS00050", "⑰": "ABT00000", "⑱": "ABU00010", "⑳": "ABV00010", "㉓": "ABV00040" };
  return fill(headValues(general ? "AAN" : "ABM", f, false), rowsOf(r, "second"), t);
};

export interface XtxOptions {
  /** 課税期間（YYYY-MM-DD） */
  from: string;
  to: string;
  /** 作成日（YYYY-MM-DD） */
  createdOn: string;
}

/** 申告書の数字（TaxReturn）から xtx を作る。書き出せない方式・年分なら例外 */
export const buildTaxXtx = (r: TaxReturn, filer: EtaxFiler, o: XtxOptions): string => {
  const problem = xtxProblem(r, Number(o.from.slice(0, 4)));
  if (problem) throw new Error(problem);
  const p = PROCEDURES[r.firstKind];
  const attrs: FormAttrs = { author: filer.yago.trim() || filer.name.trim(), createdOn: o.createdOn };
  const first = { ...firstValues(r, filer), ...secondValues(r, filer) };
  const fuhyo: [string, EtaxValues][] =
    r.method === "twenty" ? [["SHB070", fill(fuhyoHead("AYA"), rowsOf(r, "6"), FUHYO6)]]
      : r.method === "standard" ? [["SHB017", fill(fuhyoHead("DSA"), rowsOf(r, "1-3"), FUHYO13)], ["SHB033", fuhyo23Values(r)]]
        : [["SHB047", fill(fuhyoHead("DUA"), rowsOf(r, "4-3"), FUHYO43)], ["SHB067", fuhyo53Values(r)]];
  // 手続の XSD の順番：第一表・第二表、付表1-3/4-3、付表2-3/5-3、付表6
  const forms = [[p.first, first] as [string, EtaxValues], ...fuhyo].map(([id, values]) => ({ id, xml: formXml(id, values, attrs) }));
  return documentXml({
    namespace: NAMESPACE,
    procedure: p.procedure,
    procedureVersion: PROCEDURE_VERSION,
    it: itXml(filer, { procedure: p.procedure, procedureName: p.name, from: o.from, to: o.to, shinkokuKbn: 1 }),
    forms,
  });
};
