/**
 * 消費税の申告書を e-Tax のデータ（xtx）にする（純粋関数。数字は taxReturn.ts の計算結果をそのまま使う）
 *
 * 手続（手続の版は年分で選ぶ：XTX_VERSIONS）
 *  - 第一表が一般用：RSH0010（消費税及び地方消費税申告(一般・個人)）
 *      本則課税：SHA010（第一表・第二表）・SHB017（付表1-3）・SHB033（付表2-3。個別対応方式なら ⑲⑳㉑、一括比例配分方式なら ㉒）
 *      2割特例：SHA010・SHB070（付表6）。第一表の「控除税額の計算方法」を 8（2割特例）にする
 *  - 第一表が簡易課税用：RSH0030（消費税及び地方消費税申告(簡易課税・個人)）
 *      簡易課税：SHA020（第一表・第二表）・SHB047（付表4-3）・SHB067（付表5-3）
 *      2割特例：SHA020・SHB070。第一表の「税額控除に係る経過措置の適用（２割特例）」を 1（該当）にする
 *  - 3割特例は、国税庁の様式（付表）がまだ無いため書き出せない
 *  - 一般用で ⑧ 控除不足還付税額があるときは、消費税の還付申告に関する明細書（個人事業者用）SHC025 も付ける（lib/taxRefundDetail.ts）
 * 確定申告だけ（中間申告・修正申告は対象外）。個人番号と提出年月日は e-Tax の側で入れる
 */
import type { FormRow, TaxReturn } from "./taxReturn";
import { documentXml, formXml, itRefs, itXml, type EtaxFiler, type EtaxValues, type FormAttrs } from "./etax";
import type { PurchaseFigure, PurchaseFigures, RefundTradeRow, TaxRefundDetailInput } from "./taxRefundDetail";

const NAMESPACE = "http://xml.e-tax.nta.go.jp/XSD/shohi";
const PROCEDURES = {
  一般用: { procedure: "RSH0010", name: "消費税及び地方消費税申告(一般・個人)", first: "SHA010" },
  簡易課税用: { procedure: "RSH0030", name: "消費税及び地方消費税申告(簡易課税・個人)", first: "SHA020" },
} as const;
/**
 * 年分ごとの手続の版（spec/etax/shohi の RSH0010-<版>.xsd・RSH0030-<版>.xsd）。中の様式（第一表・付表）は同じ版を使う
 *  23.2.0 = 令和5年10月1日以後終了の課税期間用（e-Taxソフトの消費税モジュール 232）。令和7年分・令和8年分
 *    国税庁「個人事業者の方の令和８年分申告においては、【令和８年９月30日以前に開始した課税期間用】をご利用ください」
 *    （年の途中で課税事業者になった令和8年分も同じ）
 *  26.0.0 = 令和8年10月1日以後開始の課税期間用（モジュール 260）。個人事業者は令和9年分から
 * 表に無い新しい年分は、いちばん新しい版で書き出して知らせる（国税庁が新しい版を出したら表に足す）
 */
export const XTX_VERSIONS: { year: number; version: string }[] = [
  { year: 2025, version: "23.2.0" },
  { year: 2026, version: "23.2.0" },
  { year: 2027, version: "26.0.0" },
];
/** この表で書き出せる最初の年分 */
export const XTX_FIRST_YEAR = Math.min(...XTX_VERSIONS.map((v) => v.year));

/** その年分の手続の版。表に無い新しい年分は、いちばん新しい版（fallback = true） */
export const xtxVersionFor = (year: number): { version: string; fallback: boolean } => {
  const exact = XTX_VERSIONS.find((v) => v.year === year);
  if (exact) return { version: exact.version, fallback: false };
  const latest = [...XTX_VERSIONS].sort((a, b) => b.year - a.year)[0];
  return { version: latest.version, fallback: true };
};

/** 書き出せない理由（書き出せるなら null） */
export const xtxProblem = (r: TaxReturn, year: number): string | null => {
  if (r.method === "thirty") return "3割特例の付表は国税庁の様式がまだ出ていないため、e-Tax のデータは書き出せません";
  if (year < XTX_FIRST_YEAR) return `e-Tax のデータは令和${XTX_FIRST_YEAR - 2018}年（${XTX_FIRST_YEAR}年）分から書き出せます。それより前の年分には対応していません`;
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
  "⑨": abc("DTE", 20), "⑩": abc("DTE", 60), "⑪": abc("DTE", 280), "⑫": abc("DTE", 320), "⑯": abc("DTE", 200), "⑰": abc("DTE", 240),
  "⑱": abc("DTF", 10), "⑲": abc("DTG", 30), "⑳": abc("DTG", 70), "㉑": abc("DTG", 110), "㉒": abc("DTG", 150), "㉖": abc("DTI", 20), "㉗": abc("DTI", 60), "㉘": abc("DTJ", 10),
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
/**
 * 納税者等部（第一表は AAI/ABH、第二表は AAN/ABM。番号は同じ）。refund = 還付になる申告
 * 個人番号と還付先は第一表だけ。公金受取口座を使うときは口座を書かず、口座情報利用同意区分を 1（個人番号が必須）にする
 */
const headValues = (prefix: string, f: EtaxFiler, first: boolean, refund: boolean): EtaxValues => {
  const refs = itRefs(f, { refund });
  const v: EtaxValues = {};
  // 名称又は屋号 = 屋号、代表者氏名又は氏名 = 氏名（個人）。第二表には提出先税務署が無い
  const numbers: [string, number, number][] = [
    ["ZEIMUSHO", 20, 0], ["NOZEISHA_ADR", 30, 10], ["NOZEISHA_TEL", 40, 20], ["NOZEISHA_YAGO_KN", 60, 40], ["NOZEISHA_YAGO", 70, 50],
    ["NOZEISHA_BANGO", 80, 0], ["NOZEISHA_NM_KN", 100, 70], ["NOZEISHA_NM", 110, 80], ["KAZEI_KIKAN_FROM", 130, 100], ["KAZEI_KIKAN_TO", 140, 110],
    ["SHINKOKU_KBN", 150, 120], ["KANPU_KINYUKIKAN", 190, 0],
  ];
  for (const [ref, one, two] of numbers) {
    const n = first ? one : two;
    if (n && refs.has(ref)) v[tag(prefix, n)] = { ref };
  }
  if (first && refund && f.refund?.kind === "public" && f.myNumber) v[tag(prefix, 250)] = { kubun: 1 };
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
  const v = fill(headValues(general ? "AAI" : "ABH", f, true, r.total < 0), rows, table);
  // 付記事項（割賦基準・延払基準・工事進行基準・現金主義会計）と、課税標準額に対する消費税額の計算の特例（積上げ計算）は「無」
  for (const n of [10, 20, 30, 40]) v[tag(note, n)] = { kubun: 2 };
  v[tag(ref, 10)] = { kubun: 2 };
  const baseSales = rows.find((x) => x.key === "baseSales")?.c ?? null;
  if (general) {
    // 控除税額の計算方法：1 個別対応方式・2 一括比例配分方式・3 全額控除・8 2割特例
    v.AAM00020 = { kubun: r.method === "twenty" ? 8 : rowOf(r, "2-3", "⑱") ? 3 : rowOf(r, "2-3", "㉑") ? 1 : 2 };
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
  return fill(headValues(general ? "AAN" : "ABM", f, false, false), rowsOf(r, "second"), t);
};

export interface XtxOptions {
  /** 課税期間（YYYY-MM-DD） */
  from: string;
  to: string;
  /** 作成日（YYYY-MM-DD） */
  createdOn: string;
  /** 還付申告に関する明細書（⑧ 控除不足還付税額があるときに付ける） */
  refundDetail?: { input: TaxRefundDetailInput; purchases: PurchaseFigures };
}

/** 第一表の ⑧ 控除不足還付税額（明細書が要るのは、一般用でこれがあるとき） */
export const refundShortfall = (r: TaxReturn) => (r.firstKind === "一般用" ? rowOf(r, "first", "⑧")?.c ?? 0 : 0);

// ── 消費税の還付申告に関する明細書（個人事業者用）SHC025 ──
const yesNo = (b: boolean) => ({ kubun: b ? 1 : 2 });
const text = (s: string) => ({ text: s.trim() });
/** 明細の行（年月日か「継続」・金額・登録番号・取引先） */
const tradeRow = (r: RefundTradeRow, t: { kind: string; date: string; cont?: string; amount: string; reg?: string; name: string; addr: string }): EtaxValues => {
  const v: EtaxValues = { [t.kind]: text(r.kind), [t.amount]: r.amount };
  if (r.continuous && t.cont) v[t.cont] = text("継続");
  else if (r.date) v[t.date] = { date: r.date };
  if (t.reg && r.regNo) v[t.reg] = text(r.regNo);
  if (r.name.trim()) v[t.name] = text(r.name);
  if (r.address.trim()) v[t.addr] = text(r.address);
  return v;
};
/** 決算額・課税仕入れにならないもの・課税仕入高の3つの欄 */
const purchaseCells = (v: EtaxValues, f: PurchaseFigure, prefix: string, n: number) => {
  v[tag(prefix, n)] = f.total;
  v[tag(prefix, n + 10)] = f.notTaxable;
  v[tag(prefix, n + 20)] = f.taxable;
};

const refundDetailValues = (r: TaxReturn, d: NonNullable<XtxOptions["refundDetail"]>, year: number): EtaxValues => {
  const x = d.input;
  const p = d.purchases;
  const v: EtaxValues = {
    CJA00020: { ref: "KAZEI_KIKAN_FROM" }, CJA00030: { ref: "KAZEI_KIKAN_TO" }, CJA00040: { ref: "NOZEISHA_ADR" }, CJA00050: { ref: "NOZEISHA_NM" },
    CJB00010: yesNo(x.reasons.export), CJB00020: yesNo(x.reasons.capex), CJB00040: yesNo(x.reasons.other),
  };
  if (x.reasons.other && x.reasons.otherText.trim()) v.CJB00050 = text(x.reasons.otherText);
  // 2(1) 主な課税資産の譲渡等（税込）
  if (x.sales.length) {
    v.CJC00020 = { kubun: 1 };
    v.CJC00030 = { rows: x.sales.map((row) => tradeRow(row, { kind: "CJC00040", date: "CJC00050", cont: "CJC00060", amount: "CJC00070", name: "CJC00080", addr: "CJC00090" })) };
  }
  // 2(2) 主な輸出取引等の明細・利用する金融機関・通関業者
  if (x.exports.length) {
    v.CJC00110 = {
      rows: x.exports.map((e) => {
        const row: EtaxValues = { CJC00140: e.amount };
        if (e.name.trim()) row.CJC00120 = text(e.name);
        if (e.address.trim()) row.CJC00130 = text(e.address);
        if (e.goods.trim()) row.CJC00150 = text(e.goods);
        if (e.customs.trim()) row.CJC00160 = text(e.customs);
        return row;
      }),
    };
  }
  if (x.bank.name.trim()) {
    Object.assign(v, { CJC00190: text(x.bank.name), CJC00200: { kubun: x.bank.kind }, CJC00220: { kubun: x.bank.branchKind }, CJC00230: { kubun: x.bank.deposit } });
    if (x.bank.branch.trim()) v.CJC00210 = text(x.bank.branch);
    if (x.bank.number.trim()) v.CJC00240 = text(x.bank.number);
  }
  if (x.broker.name.trim()) v.CJC00260 = text(x.broker.name);
  if (x.broker.address.trim()) v.CJC00270 = text(x.broker.address);
  // 3(1) 仕入金額等の明細（税込）。不動産所得は動きがあるときだけ
  v.CJD00020 = { kubun: 1 };
  purchaseCells(v, p.business.purchase, "CJD", 50);
  purchaseCells(v, p.business.expense, "CJD", 90);
  purchaseCells(v, p.business.asset, "CJD", 130);
  purchaseCells(v, p.business.subtotal, "CJD", 170);
  const re = p.realEstate.subtotal;
  if (re.total !== 0 || re.taxable !== 0) {
    purchaseCells(v, p.realEstate.expense, "CJD", 220);
    purchaseCells(v, p.realEstate.asset, "CJD", 260);
    purchaseCells(v, re, "CJD", 300);
  }
  v.CJD00510 = p.taxableTotal;
  // 課税仕入れ等の税額の合計額 ＝ 付表2-3 ⑰
  v.CJD00520 = rowOf(r, "2-3", "⑰")?.c ?? 0;
  // 3(2) 主な棚卸資産・原材料等の取得、3(3) 主な固定資産等の取得（税込）
  if (x.inventory.length) {
    v.CJD00540 = { kubun: 1 };
    v.CJD00550 = { rows: x.inventory.map((row) => tradeRow(row, { kind: "CJD00560", date: "CJD00570", cont: "CJD00580", amount: "CJD00590", reg: "CJD00595", name: "CJD00600", addr: "CJD00610" })) };
  }
  if (x.assets.length) {
    v.CJD00630 = { kubun: 1 };
    v.CJD00640 = { rows: x.assets.map((row) => tradeRow(row, { kind: "CJD00650", date: "CJD00660", amount: "CJD00670", reg: "CJD00675", name: "CJD00680", addr: "CJD00690" })) };
  }
  // 4 その年の特殊事情
  if (x.special.trim()) {
    v.CJE00010 = { nen: year };
    v.CJE00020 = text(x.special);
  }
  return v;
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
  // 還付申告に関する明細書（一般用で ⑧ 控除不足還付税額があるとき）
  const refund: [string, EtaxValues][] = refundShortfall(r) > 0 && o.refundDetail ? [["SHC025", refundDetailValues(r, o.refundDetail, Number(o.from.slice(0, 4)))]] : [];
  // 手続の XSD の順番：第一表・第二表、付表1-3/4-3、付表2-3/5-3、付表6、還付申告に関する明細書
  const forms = [[p.first, first] as [string, EtaxValues], ...fuhyo, ...refund].map(([id, values]) => ({ id, xml: formXml(id, values, attrs) }));
  return documentXml({
    namespace: NAMESPACE,
    procedure: p.procedure,
    procedureVersion: xtxVersionFor(Number(o.from.slice(0, 4))).version,
    it: itXml(filer, { procedure: p.procedure, procedureName: p.name, from: o.from, to: o.to, shinkokuKbn: 1, refund: r.total < 0 }),
    forms,
  });
};
