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
 * 様式の中の要素は XSD の順番どおりに書く（etaxForms.ts の並び）。値の無い欄は書かない。くり返せる欄（明細の行）は rows で何行でも書く
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
  /** 個人番号（12桁。書き出すときだけ入れてもらい、保存しない。無ければ空） */
  myNumber: string;
  /** 確定申告書の欄（職業・世帯主の氏名と続柄・1月1日の住所。無ければ空） */
  occupation: string;
  householderName: string;
  householderRelation: string;
  jan1Address: string;
  /** 還付される税金の受取場所（口座・公金受取口座。書かないなら null） */
  refund: RefundPlace | null;
  /** 生年月日（YYYY-MM-DD。所得税の確定申告書。無ければ空） */
  birthday: string;
  /** 依頼している税理士等（所得税の確定申告書・決算書。無ければ null） */
  agent: { name: string; address: string; phone: string } | null;
}

/** 還付される税金の受取場所 */
export type RefundPlace =
  | { kind: "bank"; bankName: string; bankKind: string; branchName: string; branchKind: string; depositKind: string; accountNo: string }
  | { kind: "yucho"; symbol: string; number: string }
  | { kind: "public" };

/** 欄の値 */
export type EtaxValue =
  | number // 金額・人数・月数など
  | { kubun: number } // 区分（1:有 2:無 など）
  | { ref: string } // IT部の項目への参照
  | { decimal: string } // 割合（"95.12" など）
  | { text: string } // 文字（氏名・住所・科目名など）
  | { date: string } // 年月日（YYYY-MM-DD → 元号・年・月・日）
  | { yymm: string } // 年月（YYYY-MM）
  | { mmdd: string } // 月日（MM-DD）
  | { nen: number } // 年（西暦 → 元号・年）
  | { tel: string } // 電話番号（03-1234-5678）
  | { bango: string } // 個人番号（12桁）
  | { rows: EtaxValues[] }; // くり返せる欄（明細の行。1行ずつ欄の値）

export interface EtaxValues {
  [tag: string]: EtaxValue;
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NS = {
  general: "http://xml.e-tax.nta.go.jp/XSD/general",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
};
const IT_VERSION = "1.5";
export const SOFT_NAME = "domble";

/** 元号の始まり（1:明治 2:大正 3:昭和 4:平成 5:令和）と、元年の西暦 */
const ERAS: [string, number, number][] = [["2019-05-01", 5, 2018], ["1989-01-08", 4, 1988], ["1926-12-25", 3, 1925], ["1912-07-30", 2, 1911], ["0000-01-01", 1, 1867]];
/** 日付（YYYY-MM-DD）→ 和暦の元号と年 */
const eraOf = (date: string) => {
  const [, era, base] = ERAS.find(([from]) => date >= from)!;
  return `<gen:era>${era}</gen:era><gen:yy>${Number(date.slice(0, 4)) - base}</gen:yy>`;
};
/** 日付（YYYY-MM-DD）→ 和暦の要素（元号・年・月・日） */
export const warekiXml = (date: string) => `${eraOf(date)}<gen:mm>${Number(date.slice(5, 7))}</gen:mm><gen:dd>${Number(date.slice(8, 10))}</gen:dd>`;

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

/** 事業者設定に持つ e-Tax の申告者の情報（保存する列の順） */
export const ETAX_FIELDS = [
  "etax_user_id", "tax_office", "phone", "owner_kana", "business_kana", "occupation", "householder_name", "householder_relation", "jan1_address",
  "office_phone", "refund_mode", "bank_name", "bank_kind", "branch_name", "branch_kind", "deposit_kind", "account_no", "yucho_symbol", "yucho_number",
  "office_address", "union_name", "agent_name", "agent_address", "agent_phone",
] as const satisfies readonly (keyof Settings)[];
export type EtaxInfo = Pick<Settings, (typeof ETAX_FIELDS)[number]>;

export const BANK_KINDS: [string, string][] = [["1", "銀行"], ["2", "金庫"], ["3", "組合"], ["4", "農協"], ["5", "漁協"]];
export const BRANCH_KINDS: [string, string][] = [["1", "本店"], ["2", "支店"], ["3", "本所"], ["4", "支所"], ["5", "出張所"]];
export const DEPOSIT_KINDS: [string, string][] = [["1", "普通"], ["2", "当座"], ["3", "納税準備"], ["4", "通知"], ["5", "別段"], ["6", "貯蓄"], ["9", "その他"]];

const digits = (s: string) => s.normalize("NFKC").replace(/[\s-]/g, "");
const phoneOf = (s: string) => s.normalize("NFKC").replace(/[ー－‐]/g, "-").replace(/\s/g, "");

/** 保存する前にそろえて確かめる（空欄はよい）。問題があればメッセージ */
export const normalizeEtaxInfo = (x: EtaxInfo): EtaxInfo | string => {
  const t = (s: string | undefined) => (s ?? "").normalize("NFKC").trim();
  const n: EtaxInfo = {
    etax_user_id: digits(x.etax_user_id),
    tax_office: x.tax_office.trim(),
    phone: phoneOf(x.phone),
    owner_kana: toKatakana(x.owner_kana),
    business_kana: toKatakana(x.business_kana),
    occupation: t(x.occupation),
    householder_name: t(x.householder_name),
    householder_relation: t(x.householder_relation),
    jan1_address: t(x.jan1_address),
    office_phone: phoneOf(x.office_phone ?? ""),
    refund_mode: (["bank", "yucho", "public"] as const).find((m) => m === x.refund_mode) ?? "none",
    bank_name: t(x.bank_name).replace(/(銀行|信用金庫|金庫|信用組合|組合|農業協同組合|農協|漁業協同組合|漁協)$/, ""),
    bank_kind: BANK_KINDS.some(([v]) => v === x.bank_kind) ? x.bank_kind : "1",
    branch_name: t(x.branch_name).replace(/(本店|支店|本所|支所|出張所)$/, ""),
    branch_kind: BRANCH_KINDS.some(([v]) => v === x.branch_kind) ? x.branch_kind : "2",
    deposit_kind: DEPOSIT_KINDS.some(([v]) => v === x.deposit_kind) ? x.deposit_kind : "1",
    account_no: digits(x.account_no ?? ""),
    yucho_symbol: digits(x.yucho_symbol ?? ""),
    yucho_number: digits(x.yucho_number ?? ""),
    office_address: t(x.office_address),
    union_name: t(x.union_name),
    agent_name: t(x.agent_name),
    agent_address: t(x.agent_address),
    agent_phone: phoneOf(x.agent_phone ?? ""),
  };
  if (n.etax_user_id && !/^\d{16}$/.test(n.etax_user_id)) return "利用者識別番号は16桁の数字です";
  if (n.tax_office && !TAX_OFFICES.has(n.tax_office)) return "提出先の税務署を一覧から選んでください";
  if (n.phone && !splitPhone(n.phone)) return "電話番号は 03-1234-5678 のようにハイフンで区切って入れてください";
  if (n.office_phone && !splitPhone(n.office_phone)) return "事業所の電話番号は 03-1234-5678 のようにハイフンで区切って入れてください";
  if (!KANA.test(n.owner_kana) || !KANA.test(n.business_kana)) return "フリガナはカタカナで入れてください";
  if (n.business_kana.length > 60) return "屋号のフリガナは60文字までです";
  if (n.occupation.length > 20) return "職業は20文字までです";
  if (n.householder_relation.length > 5) return "世帯主との続柄は5文字までです";
  if (n.householder_name.length > 30) return "世帯主の氏名は30文字までです";
  if (n.bank_name.length > 15 || n.branch_name.length > 15) return "金融機関名・支店名は15文字までです";
  if (n.account_no && !/^\d{1,10}$/.test(n.account_no)) return "口座番号は10桁までの数字です";
  if (n.yucho_symbol && !/^\d{5}$/.test(n.yucho_symbol)) return "ゆうちょ銀行の記号は5桁の数字です";
  if (n.yucho_number && !/^\d{1,8}$/.test(n.yucho_number)) return "ゆうちょ銀行の番号は8桁までの数字です";
  if (n.union_name.length > 20) return "加入団体名は20文字までです";
  if (n.agent_phone && !splitPhone(n.agent_phone)) return "税理士等の電話番号は 03-1234-5678 のようにハイフンで区切って入れてください";
  if (n.refund_mode === "bank" && (!n.bank_name || !n.branch_name || !n.account_no)) return "還付先の金融機関名・支店名・口座番号を入れてください";
  if (n.refund_mode === "yucho" && (!n.yucho_symbol || !n.yucho_number)) return "還付先のゆうちょ銀行の記号番号を入れてください";
  return n;
};

/** 個人番号（12桁）の検査用数字が合っているか（行政手続における特定の個人を識別するための番号の利用等に関する法律施行令の計算） */
export const isValidMyNumber = (s: string) => {
  if (!/^\d{12}$/.test(s)) return false;
  const d = [...s].map(Number);
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += d[11 - n] * (n <= 6 ? n + 1 : n - 5);
  const r = sum % 11;
  return d[11] === (r <= 1 ? 0 : 11 - r);
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
  myNumber: "",
  occupation: s.occupation,
  householderName: s.householder_name,
  householderRelation: s.householder_relation,
  jan1Address: s.jan1_address,
  birthday: "",
  agent: s.agent_name.trim() ? { name: s.agent_name, address: s.agent_address, phone: s.agent_phone } : null,
  refund: s.refund_mode === "bank"
    ? { kind: "bank", bankName: s.bank_name, bankKind: s.bank_kind, branchName: s.branch_name, branchKind: s.branch_kind, depositKind: s.deposit_kind, accountNo: s.account_no }
    : s.refund_mode === "yucho" ? { kind: "yucho", symbol: s.yucho_symbol, number: s.yucho_number }
      : s.refund_mode === "public" ? { kind: "public" } : null,
});

// ── IT部 ──
export interface ItOptions {
  procedure: string;
  procedureName: string;
  /** 課税期間（YYYY-MM-DD。消費税） */
  from?: string;
  to?: string;
  /** 年分（西暦。所得税） */
  nenbun?: number;
  /** 申告の種類（1:確定 2:中間 3:修正確定 4:修正中間） */
  shinkokuKbn: number;
  /** 還付される税金の受取場所（口座）を書くか（還付になるときだけ） */
  refund?: boolean;
  /** 確定申告書の申告者の欄（職業・世帯主・1月1日の住所・生年月日・依頼している税理士等）を書くか（所得税） */
  personal?: boolean;
}

/** IT部に書く還付先の口座（銀行等・ゆうちょ銀行。公金受取口座は様式の区分で示す） */
const refundAccount = (r: RefundPlace | null): string => {
  if (r?.kind === "bank") {
    return `<gen:kinyukikan_NM kinyukikan_KB="${r.bankKind}">${escapeXml(r.bankName)}</gen:kinyukikan_NM>`
      + `<gen:shiten_NM shiten_KB="${r.branchKind}">${escapeXml(r.branchName)}</gen:shiten_NM><gen:yokin>${r.depositKind}</gen:yokin><gen:koza>${r.accountNo}</gen:koza>`;
  }
  if (r?.kind === "yucho") return `<gen:kigobango1>${r.symbol}</gen:kigobango1><gen:kigobango2>${r.number}</gen:kigobango2>`;
  return "";
};

const telXml = (t: { tel1: string; tel2: string; tel3: string }) => `<gen:tel1>${t.tel1}</gen:tel1><gen:tel2>${t.tel2}</gen:tel2><gen:tel3>${t.tel3}</gen:tel3>`;

/**
 * IT部（XSD の順番：税務署・利用者識別番号・個人番号・氏名読み・氏名・郵便番号・住所・1月1日の住所・屋号読み・屋号・電話・生年月日・
 * 世帯主の氏名・続柄・職業・還付先の口座・税理士等の氏名・住所・電話・手続・年分・課税期間・申告の種類）
 */
export const itXml = (f: EtaxFiler, o: ItOptions) => {
  const el = (tag: string, body: string) => `<${tag} ID="${tag}">${body}</${tag}>`;
  const zip = f.postalCode.replace(/-/g, "");
  const tel = splitPhone(f.phone);
  const agentTel = f.agent ? splitPhone(f.agent.phone) : null;
  return [
    `<IT VR="${IT_VERSION}" id="IT">`,
    el("ZEIMUSHO", `<gen:zeimusho_CD>${f.officeCode}</gen:zeimusho_CD>${f.officeName ? `<gen:zeimusho_NM>${escapeXml(f.officeName)}</gen:zeimusho_NM>` : ""}`),
    el("NOZEISHA_ID", f.userId),
    f.myNumber ? el("NOZEISHA_BANGO", `<gen:kojinbango>${f.myNumber}</gen:kojinbango>`) : "",
    f.nameKana ? el("NOZEISHA_NM_KN", escapeXml(toKatakana(f.nameKana))) : "",
    el("NOZEISHA_NM", escapeXml(f.name.trim())),
    zip.length === 7 ? el("NOZEISHA_ZIP", `<gen:zip1>${zip.slice(0, 3)}</gen:zip1><gen:zip2>${zip.slice(3)}</gen:zip2>`) : "",
    el("NOZEISHA_ADR", escapeXml(f.address.trim())),
    o.personal && f.jan1Address.trim() ? el("ICHIGATSUIPPI_ADR", escapeXml(f.jan1Address.trim())) : "",
    f.yago && f.yagoKana ? el("NOZEISHA_YAGO_KN", escapeXml(toKatakana(f.yagoKana))) : "",
    f.yago ? el("NOZEISHA_YAGO", escapeXml(f.yago.trim())) : "",
    tel ? el("NOZEISHA_TEL", telXml(tel)) : "",
    o.personal && f.birthday ? el("BIRTHDAY", warekiXml(f.birthday)) : "",
    o.personal && f.householderName.trim() ? el("SETAINUSHI_NM", escapeXml(f.householderName.trim())) : "",
    o.personal && f.householderRelation.trim() ? el("SETAINUSHI_ZOKU", escapeXml(f.householderRelation.trim())) : "",
    o.personal && f.occupation.trim() ? el("SHOKUGYO", escapeXml(f.occupation.trim())) : "",
    o.refund && refundAccount(f.refund) ? el("KANPU_KINYUKIKAN", refundAccount(f.refund)) : "",
    o.personal && f.agent?.name.trim() ? el("DAIRI_NM", escapeXml(f.agent.name.trim())) : "",
    o.personal && f.agent?.address.trim() ? el("DAIRI_ADR", escapeXml(f.agent.address.trim())) : "",
    o.personal && agentTel ? el("DAIRI_TEL", telXml(agentTel)) : "",
    el("TETSUZUKI", `<procedure_CD>${o.procedure}</procedure_CD><procedure_NM>${escapeXml(o.procedureName)}</procedure_NM>`),
    o.nenbun ? el("NENBUN", eraOf(`${o.nenbun}-12-31`)) : "",
    o.from ? el("KAZEI_KIKAN_FROM", warekiXml(o.from)) : "",
    o.to ? el("KAZEI_KIKAN_TO", warekiXml(o.to)) : "",
    el("SHINKOKU_KBN", `<kubun_CD>${o.shinkokuKbn}</kubun_CD>`),
    "</IT>",
  ].join("");
};

/** IT部にある項目（様式から参照してよいもの） */
export const itRefs = (f: EtaxFiler, o: Pick<ItOptions, "refund" | "personal" | "nenbun" | "from"> = {}) => {
  const s = new Set(["ZEIMUSHO", "NOZEISHA_ID", "NOZEISHA_NM", "NOZEISHA_ADR", "TETSUZUKI", "SHINKOKU_KBN"]);
  if (o.nenbun) s.add("NENBUN");
  if (o.from || !o.nenbun) for (const k of ["KAZEI_KIKAN_FROM", "KAZEI_KIKAN_TO"]) s.add(k);
  if (o.personal && f.birthday) s.add("BIRTHDAY");
  if (o.personal && f.agent?.name.trim()) s.add("DAIRI_NM");
  if (o.personal && f.agent?.address.trim()) s.add("DAIRI_ADR");
  if (o.personal && f.agent && splitPhone(f.agent.phone)) s.add("DAIRI_TEL");
  if (f.myNumber) s.add("NOZEISHA_BANGO");
  if (o.personal && f.jan1Address.trim()) s.add("ICHIGATSUIPPI_ADR");
  if (f.postalCode.replace(/-/g, "").length === 7) s.add("NOZEISHA_ZIP");
  if (o.personal && f.householderName.trim()) s.add("SETAINUSHI_NM");
  if (o.personal && f.householderRelation.trim()) s.add("SETAINUSHI_ZOKU");
  if (o.personal && f.occupation.trim()) s.add("SHOKUGYO");
  if (o.refund && refundAccount(f.refund)) s.add("KANPU_KINYUKIKAN");
  if (f.nameKana) s.add("NOZEISHA_NM_KN");
  if (f.yago) s.add("NOZEISHA_YAGO");
  if (f.yago && f.yagoKana) s.add("NOZEISHA_YAGO_KN");
  if (splitPhone(f.phone)) s.add("NOZEISHA_TEL");
  return s;
};

// ── 様式 ──
interface TreeNode {
  tag: string;
  /** くり返せる要素（明細の行） */
  repeat: boolean;
  children: TreeNode[];
}

/** 「タグ(子 子 …)」の並びを木にする（タグのあとの * はくり返せる要素） */
export const parseTree = (s: string): TreeNode[] => {
  let i = 0;
  const list = (): TreeNode[] => {
    const out: TreeNode[] = [];
    while (i < s.length && s[i] !== ")") {
      if (s[i] === " ") { i++; continue; }
      let j = i;
      while (j < s.length && !" ()".includes(s[j])) j++;
      const name = s.slice(i, j);
      const node: TreeNode = { tag: name.replace(/\*$/, ""), repeat: name.endsWith("*"), children: [] };
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
  if ("text" in v) return `<${tag}>${escapeXml(v.text)}</${tag}>`;
  if ("date" in v) return `<${tag}>${warekiXml(v.date)}</${tag}>`;
  if ("yymm" in v) return `<${tag}>${eraOf(`${v.yymm}-01`)}<gen:mm>${Number(v.yymm.slice(5, 7))}</gen:mm></${tag}>`;
  if ("mmdd" in v) return `<${tag}><gen:mm>${Number(v.mmdd.slice(0, 2))}</gen:mm><gen:dd>${Number(v.mmdd.slice(3, 5))}</gen:dd></${tag}>`;
  if ("bango" in v) return `<${tag}><gen:kojinbango>${v.bango}</gen:kojinbango></${tag}>`;
  if ("nen" in v) return `<${tag}>${eraOf(`${v.nen}-12-31`)}</${tag}>`;
  if ("tel" in v) {
    const t = splitPhone(v.tel);
    if (!t) throw new Error(`${tag} の電話番号の形が正しくありません`);
    return `<${tag}>${telXml(t)}</${tag}>`;
  }
  if ("rows" in v) throw new Error(`${tag} はくり返せる欄ではありません`);
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
  const unknownOf = (vals: EtaxValues, used: Set<string>) => {
    const unknown = Object.keys(vals).filter((k) => !used.has(k));
    if (unknown.length) throw new Error(`様式 ${form} に無い欄があります：${unknown.join("、")}`);
  };
  const walk = (nodes: TreeNode[], vals: EtaxValues, used: Set<string>): string =>
    nodes.map((n) => {
      const v = vals[n.tag];
      // くり返せる欄：1行ずつ、子の欄を書く
      if (n.repeat && v !== undefined && typeof v === "object" && "rows" in v) {
        used.add(n.tag);
        return v.rows.map((row) => {
          const rowUsed = new Set<string>();
          const inner = walk(n.children, row, rowUsed);
          unknownOf(row, rowUsed);
          return inner ? `<${n.tag}>${inner}</${n.tag}>` : "";
        }).join("");
      }
      if (n.children.length) {
        const inner = walk(n.children, vals, used);
        return inner ? `<${n.tag}>${inner}</${n.tag}>` : "";
      }
      if (v === undefined) return "";
      used.add(n.tag);
      return valueXml(n.tag, v);
    }).join("");
  const used = new Set<string>();
  const body = walk(treeOf(form), values, used);
  unknownOf(values, used);
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
