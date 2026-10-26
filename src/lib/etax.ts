/**
 * e-Tax のデータ（xtx）を作る共通の部分（純粋関数）。税目ごとの欄の対応は taxXtx.ts など
 *
 * xtx の形（国税庁「データ形式等仕様書」と各手続の XSD。spec/etax に置いている）
 *   <DATA id="DATA">
 *     <手続ID VR="手続の版" id="手続ID">
 *       <CATALOG id="CATALOG">（RDF：IT部と様式の一覧）</CATALOG>
 *       <CONTENTS id="CONTENTS">
 *         <IT VR="1.5" id="IT">（申告者・税務署・課税期間など。ID 属性で定義）</IT>
 *         <様式ID VR="様式の版" id="…" page="1" sakuseiDay softNM sakuseiNM>（欄。IT部の項目は IDREF で参照）</様式ID>
 *       </CONTENTS>
 *     </手続ID>
 *   </DATA>
 * 様式の中の要素は XSD の順番どおりに書く（etaxForms.ts の並び）。値の無い欄は書かない
 */
import { FORM_TREES, FORM_VERSIONS } from "./etaxForms";
import type { Settings } from "./types";
import { TAX_OFFICES } from "../constants/taxOffices";

/** 申告者の情報（事業者設定から） */
export interface EtaxFiler {
  /** 利用者識別番号（16桁） */
  userId: string;
  /** 提出先の税務署（番号5桁と名前） */
  officeCode: string;
  officeName: string;
  name: string;
  nameKana: string;
  /** 屋号（無ければ空） */
  yago: string;
  yagoKana: string;
  /** 郵便番号（123-4567） */
  postalCode: string;
  address: string;
  /** 電話番号（03-1234-5678 のようにハイフンで区切る） */
  phone: string;
}

/** 欄の値 */
export type EtaxValue =
  | number // 金額
  | { kubun: number } // 区分（1:有 2:無 など）
  | { ref: string } // IT部の項目への参照
  | { decimal: string }; // 割合（"95.12" など）

export type EtaxValues = Record<string, EtaxValue>;

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NS = {
  general: "http://xml.e-tax.nta.go.jp/XSD/general",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
};
const IT_VERSION = "1.5";
export const SOFT_NAME = "domble";

/** 日付（YYYY-MM-DD）→ 和暦の要素（元号 4:平成 5:令和） */
export const warekiXml = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const reiwa = date >= "2019-05-01";
  return `<gen:era>${reiwa ? 5 : 4}</gen:era><gen:yy>${reiwa ? y - 2018 : y - 1988}</gen:yy><gen:mm>${m}</gen:mm><gen:dd>${d}</gen:dd>`;
};

// ── 申告者の情報の確かめ ──
const KANA = /^[ァ-ヶー 　]*$/u;
/** フリガナを全角カタカナにそろえる（半角カナ・ひらがなも受け付ける） */
export const toKatakana = (s: string) =>
  s.normalize("NFKC").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).trim();
export const splitPhone = (phone: string) => {
  const m = phone.trim().match(/^(\d{1,6})-(\d{1,4})-(\d{1,4})$/);
  return m ? { tel1: m[1], tel2: m[2], tel3: m[3] } : null;
};

/** 書き出せない理由（申告者の情報の不足・形式の誤り）。空なら書き出せる */
export const filerProblems = (f: EtaxFiler): string[] => {
  const p: string[] = [];
  if (!/^\d{16}$/.test(f.userId)) p.push("利用者識別番号（16桁の数字）");
  if (!/^\d{5}$/.test(f.officeCode)) p.push("提出先の税務署");
  if (!f.name.trim()) p.push("氏名");
  if (!f.address.trim()) p.push("住所（納税地）");
  if (f.postalCode && !/^\d{3}-?\d{4}$/.test(f.postalCode)) p.push("郵便番号は 123-4567 の形で");
  if (f.phone && !splitPhone(f.phone)) p.push("電話番号は 03-1234-5678 のようにハイフンで区切って");
  if (f.nameKana && !KANA.test(toKatakana(f.nameKana))) p.push("氏名のフリガナはカタカナで");
  if (f.yagoKana && !KANA.test(toKatakana(f.yagoKana))) p.push("屋号のフリガナはカタカナで");
  if (f.yago.length > 30) p.push("屋号は30文字まで");
  return p;
};

/** 事業者設定に持つ e-Tax の申告者の情報 */
export type EtaxInfo = Pick<Settings, "etax_user_id" | "tax_office" | "phone" | "owner_kana" | "business_kana">;

/** 保存する前にそろえて確かめる（空欄はよい）。問題があればメッセージ */
export const normalizeEtaxInfo = (x: EtaxInfo): EtaxInfo | string => {
  const n: EtaxInfo = {
    etax_user_id: x.etax_user_id.normalize("NFKC").replace(/[\s-]/g, ""),
    tax_office: x.tax_office.trim(),
    phone: x.phone.normalize("NFKC").replace(/[ー－‐]/g, "-").replace(/\s/g, ""),
    owner_kana: toKatakana(x.owner_kana),
    business_kana: toKatakana(x.business_kana),
  };
  if (n.etax_user_id && !/^\d{16}$/.test(n.etax_user_id)) return "利用者識別番号は16桁の数字です";
  if (n.tax_office && !TAX_OFFICES.has(n.tax_office)) return "提出先の税務署を一覧から選んでください";
  if (n.phone && !splitPhone(n.phone)) return "電話番号は 03-1234-5678 のようにハイフンで区切って入れてください";
  if (!KANA.test(n.owner_kana) || !KANA.test(n.business_kana)) return "フリガナはカタカナで入れてください";
  if (n.business_kana.length > 60) return "屋号のフリガナは60文字までです";
  return n;
};

/** 事業者設定から申告者の情報を作る */
export const filerFromSettings = (s: Settings): EtaxFiler => ({
  userId: s.etax_user_id,
  officeCode: s.tax_office,
  officeName: TAX_OFFICES.get(s.tax_office)?.name ?? "",
  name: s.owner_name,
  nameKana: s.owner_kana,
  yago: s.business_name,
  yagoKana: s.business_kana,
  postalCode: s.postal_code,
  address: s.address,
  phone: s.phone,
});

// ── IT部 ──
export interface ItOptions {
  procedure: string;
  procedureName: string;
  /** 課税期間（YYYY-MM-DD） */
  from: string;
  to: string;
  /** 申告の種類（1:確定 2:中間 3:修正確定 4:修正中間） */
  shinkokuKbn: number;
}

/** IT部（XSD の順番：税務署・利用者識別番号・氏名読み・氏名・郵便番号・住所・屋号読み・屋号・電話・手続・課税期間・申告の種類） */
export const itXml = (f: EtaxFiler, o: ItOptions) => {
  const el = (tag: string, body: string) => `<${tag} ID="${tag}">${body}</${tag}>`;
  const zip = f.postalCode.replace(/-/g, "");
  const tel = splitPhone(f.phone);
  return [
    `<IT VR="${IT_VERSION}" id="IT">`,
    el("ZEIMUSHO", `<gen:zeimusho_CD>${f.officeCode}</gen:zeimusho_CD>${f.officeName ? `<gen:zeimusho_NM>${escapeXml(f.officeName)}</gen:zeimusho_NM>` : ""}`),
    el("NOZEISHA_ID", f.userId),
    f.nameKana ? el("NOZEISHA_NM_KN", escapeXml(toKatakana(f.nameKana))) : "",
    el("NOZEISHA_NM", escapeXml(f.name.trim())),
    zip.length === 7 ? el("NOZEISHA_ZIP", `<gen:zip1>${zip.slice(0, 3)}</gen:zip1><gen:zip2>${zip.slice(3)}</gen:zip2>`) : "",
    el("NOZEISHA_ADR", escapeXml(f.address.trim())),
    f.yago && f.yagoKana ? el("NOZEISHA_YAGO_KN", escapeXml(toKatakana(f.yagoKana))) : "",
    f.yago ? el("NOZEISHA_YAGO", escapeXml(f.yago.trim())) : "",
    tel ? el("NOZEISHA_TEL", `<gen:tel1>${tel.tel1}</gen:tel1><gen:tel2>${tel.tel2}</gen:tel2><gen:tel3>${tel.tel3}</gen:tel3>`) : "",
    el("TETSUZUKI", `<procedure_CD>${o.procedure}</procedure_CD><procedure_NM>${escapeXml(o.procedureName)}</procedure_NM>`),
    el("KAZEI_KIKAN_FROM", warekiXml(o.from)),
    el("KAZEI_KIKAN_TO", warekiXml(o.to)),
    el("SHINKOKU_KBN", `<kubun_CD>${o.shinkokuKbn}</kubun_CD>`),
    "</IT>",
  ].join("");
};

/** IT部にある項目（様式から参照してよいもの） */
export const itRefs = (f: EtaxFiler) => {
  const s = new Set(["ZEIMUSHO", "NOZEISHA_ID", "NOZEISHA_NM", "NOZEISHA_ADR", "TETSUZUKI", "KAZEI_KIKAN_FROM", "KAZEI_KIKAN_TO", "SHINKOKU_KBN"]);
  if (f.nameKana) s.add("NOZEISHA_NM_KN");
  if (f.yago) s.add("NOZEISHA_YAGO");
  if (f.yago && f.yagoKana) s.add("NOZEISHA_YAGO_KN");
  if (splitPhone(f.phone)) s.add("NOZEISHA_TEL");
  return s;
};

// ── 様式 ──
interface TreeNode {
  tag: string;
  children: TreeNode[];
}

/** 「タグ(子 子 …)」の並びを木にする */
export const parseTree = (s: string): TreeNode[] => {
  let i = 0;
  const list = (): TreeNode[] => {
    const out: TreeNode[] = [];
    while (i < s.length && s[i] !== ")") {
      if (s[i] === " ") { i++; continue; }
      let j = i;
      while (j < s.length && !" ()".includes(s[j])) j++;
      const node: TreeNode = { tag: s.slice(i, j), children: [] };
      i = j;
      if (s[i] === "(") {
        i++;
        node.children = list();
        i++; // ")"
      }
      out.push(node);
    }
    return out;
  };
  return list();
};

const trees = new Map<string, TreeNode[]>();
const treeOf = (form: string) => {
  let t = trees.get(form);
  if (!t) {
    if (!FORM_TREES[form]) throw new Error(`様式 ${form} の定義がありません`);
    trees.set(form, (t = parseTree(FORM_TREES[form])));
  }
  return t;
};

const valueXml = (tag: string, v: EtaxValue) => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`${tag} の金額が整数ではありません（${v}）`);
    return `<${tag}>${v}</${tag}>`;
  }
  if ("ref" in v) return `<${tag} IDREF="${v.ref}"/>`;
  if ("kubun" in v) return `<${tag}><kubun_CD>${v.kubun}</kubun_CD></${tag}>`;
  return `<${tag}>${v.decimal}</${tag}>`;
};

/** 様式の id（CATALOG から参照する） */
export const formInstanceId = (form: string) => `${form}-1`;

export interface FormAttrs {
  /** 作成者（屋号か氏名） */
  author: string;
  /** 作成日（YYYY-MM-DD） */
  createdOn: string;
}

/**
 * 様式を1つ書く。値のある欄と、それを含む親の要素だけを XSD の順番で出す
 * 様式の定義に無い欄が values にあればエラー（対応表の書き間違いを見つけるため）
 */
export const formXml = (form: string, values: EtaxValues, attrs: FormAttrs): string => {
  const used = new Set<string>();
  const walk = (nodes: TreeNode[]): string =>
    nodes.map((n) => {
      if (n.children.length) {
        const inner = walk(n.children);
        return inner ? `<${n.tag}>${inner}</${n.tag}>` : "";
      }
      const v = values[n.tag];
      if (v === undefined) return "";
      used.add(n.tag);
      return valueXml(n.tag, v);
    }).join("");
  const body = walk(treeOf(form));
  const unknown = Object.keys(values).filter((k) => !used.has(k));
  if (unknown.length) throw new Error(`様式 ${form} に無い欄があります：${unknown.join("、")}`);
  return `<${form} VR="${FORM_VERSIONS[form]}" id="${formInstanceId(form)}" page="1" sakuseiDay="${attrs.createdOn}" sakuseiNM="${escapeXml(attrs.author)}" softNM="${SOFT_NAME}">${body}</${form}>`;
};

/** CATALOG（IT部と様式の一覧。空の部分も決まった名前で書く） */
const catalogXml = (forms: string[]) =>
  `<CATALOG id="CATALOG"><rdf:RDF xmlns:rdf="${NS.rdf}"><rdf:description id="REPORT">` +
  "<SEND_DATA/>" +
  '<IT_SEC><rdf:description about="#IT"/></IT_SEC>' +
  `<FORM_SEC><rdf:Seq>${forms.map((f) => `<rdf:li><rdf:description about="#${formInstanceId(f)}"/></rdf:li>`).join("")}</rdf:Seq></FORM_SEC>` +
  "<TENPU_SEC/><XBRL_SEC/><XBRL2_1_SEC/><SOFUSHO_SEC/><ATTACH_SEC/><CSV_SEC/>" +
  "</rdf:description></rdf:RDF></CATALOG>";

export interface EtaxDocument {
  /** 税目の名前空間（消費税は shohi） */
  namespace: string;
  procedure: string;
  procedureVersion: string;
  it: string;
  /** 様式（ID と書いた XML）。書く順番は手続の XSD の順番 */
  forms: { id: string; xml: string }[];
}

export const documentXml = (d: EtaxDocument) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<DATA xmlns="${d.namespace}" xmlns:gen="${NS.general}" id="DATA">` +
  `<${d.procedure} VR="${d.procedureVersion}" id="${d.procedure}">` +
  catalogXml(d.forms.map((f) => f.id)) +
  `<CONTENTS id="CONTENTS">${d.it}${d.forms.map((f) => f.xml).join("")}</CONTENTS>` +
  `</${d.procedure}></DATA>\n`;
