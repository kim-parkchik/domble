/**
 * 所得税の確定申告書と青色申告決算書（白色申告は収支内訳書）を e-Tax のデータ（xtx）にする
 * （純粋関数。数字は incomeTax.ts・blueStatement.ts・whiteStatement.ts の計算結果をそのまま使う）
 *
 * 手続 RKO0010（所得税及び復興特別所得税申告）。手続の版は年分で選ぶ（INCOME_XTX_VERSIONS）
 *  - KOA020：確定申告書の第一表・第二表と、損失申告の年（純損失を繰り越す・繰越損失が残る）は第四表（一）（二）（第三表・第四表の付表は扱わない）
 *  - KOA210：青色申告決算書（一般用）の1〜4ページ（製造原価の計算は書かない）
 *  - KOA110：収支内訳書（一般用）の1・2ページ（白色申告の年）
 * 様式の行数より多い明細は、金額の大きい順に入れ、残りは「その他」の1行にまとめる（次葉合計の欄がある明細は次葉合計に）。
 * 配偶者・親族・事業専従者の欄より多い人は書かず、そのことを知らせる
 * 個人番号は書き出すときに入れてもらう（numbers。self・spouse・dep<添字>・family<添字>）。提出年月日は e-Tax の側で入れる
 */
import type { BlueStatement, PartnerTable, PayLine, PayeeLine } from "./blueStatement";
import type { WhiteStatement } from "./whiteStatement";
import { documentXml, filerProblems, formXml, itRefs, itXml, type EtaxFiler, type EtaxValue, type EtaxValues, type FormAttrs } from "./etax";
import {
  dependentDeduction, fieldNo, rulesFor, spouseDeduction, type BusinessFigures, type IncomeTaxInput, type IncomeTaxResult, type Relative,
} from "./incomeTax";
import type { Settings } from "./types";

const NAMESPACE = "http://xml.e-tax.nta.go.jp/XSD/shotoku";
const PROCEDURE = { procedure: "RKO0010", name: "所得税及び復興特別所得税申告" };

/**
 * 年分ごとの手続の版（spec/etax/shotoku の RKO0010-<版>.xsd。様式は KOA020-023・KOA210-011）
 * 表に無い新しい年分は、いちばん新しい版で書き出して知らせる（国税庁が新しい版を出したら表に足す）
 */
export const INCOME_XTX_VERSIONS: { year: number; version: string }[] = [{ year: 2025, version: "25.0.1" }];
export const INCOME_XTX_FIRST_YEAR = Math.min(...INCOME_XTX_VERSIONS.map((v) => v.year));

export const incomeXtxVersionFor = (year: number): { version: string; fallback: boolean } => {
  const exact = INCOME_XTX_VERSIONS.find((v) => v.year === year);
  if (exact) return { version: exact.version, fallback: false };
  const latest = [...INCOME_XTX_VERSIONS].sort((a, b) => b.year - a.year)[0];
  return { version: latest.version, fallback: true };
};

export interface IncomeTaxXtxSource {
  year: number;
  /** 申告者の情報（事業者設定から。生年月日・1月1日の住所は所得税の入力から入れる） */
  filer: EtaxFiler;
  input: IncomeTaxInput;
  result: IncomeTaxResult;
  biz: BusinessFigures;
  statement: BlueStatement;
  /** 収支内訳書（白色申告の年。あれば青色申告決算書の代わりに書く） */
  white?: WhiteStatement;
  settings: Pick<Settings, "address" | "phone" | "office_address" | "office_phone" | "union_name">;
  /** 第一表の事業（営業等）の「区分」：1 優良な電子帳簿（届出あり） ／ 2 会計ソフトで記帳 */
  bookKeeping: 1 | 2;
  /** 個人番号（書き出すときに入れたもの。保存しない） */
  numbers: Record<string, string>;
  /** 作成日（YYYY-MM-DD） */
  createdOn: string;
}

// ── 載せる人 ──
const SPOUSE_SPECIAL_LIMIT = 1_330_000;
const RELATIVE_ROWS = 4;
const FAMILY_ROWS = 2;

/** 第二表の「配偶者や親族に関する事項」に書く配偶者（事業専従者でなく、控除の対象か同一生計配偶者） */
const spouseShown = (x: IncomeTaxInput, year: number, ownIncome: number) => {
  const s = x.spouse;
  if (!s || s.familyEmployee) return null;
  const d = spouseDeduction(s, ownIncome, year);
  return d.kind || s.income <= rulesFor(year).rules.dependentLimit || s.income <= SPOUSE_SPECIAL_LIMIT ? { s, d } : null;
};

/** 第二表に書く親族（扶養控除・特定親族特別控除の対象と、16歳未満の扶養親族） */
const relativesShown = (x: IncomeTaxInput, year: number) =>
  x.dependents
    .map((d, i) => ({ d, i, r: dependentDeduction(d, year) }))
    .filter((v) => v.r.kind !== "none" && v.r.kind !== "familyEmployee");

/** 事業専従者（青色：決算書の専従者給与の内訳で給与のある人 ／ 白色：収支内訳書の事業専従者で控除のある人）。key は個人番号の鍵 */
const familyShown = (src: Pick<IncomeTaxXtxSource, "statement" | "white">) =>
  src.white
    ? src.white.family.filter((l) => l.deduction > 0).map((l, i) => ({
      key: `family${i}`, name: l.name, relation: l.relation, birthday: l.birthday, detail: [l.months ? `${l.months}月` : "", l.work].filter(Boolean).join("・"), amount: l.deduction,
    }))
    : src.statement.family.filter((f) => f.total > 0).map((f, i) => ({
      // 青色は従事月数だけ（「程度・仕事の内容」は白色申告者だけが書く。令和7年分 確定申告の手引き）
      key: `family${i}`, name: f.name, relation: f.relation, birthday: "", detail: f.months ? `${f.months}月` : "", amount: f.total,
    }));

/** 個人番号を入れてもらう人（書き出す人だけ） */
export const myNumberPersons = (src: Pick<IncomeTaxXtxSource, "input" | "year" | "result" | "statement" | "white">) => {
  const out: { key: string; label: string }[] = [];
  const sp = spouseShown(src.input, src.year, src.result.totalIncome);
  if (sp) out.push({ key: "spouse", label: `配偶者（${sp.s.name || "氏名なし"}）` });
  for (const { d, i } of relativesShown(src.input, src.year).slice(0, RELATIVE_ROWS)) out.push({ key: `dep${i}`, label: `${d.relation || "親族"}（${d.name || "氏名なし"}）` });
  for (const f of familyShown(src).slice(0, FAMILY_ROWS)) out.push({ key: f.key, label: `事業専従者（${f.name}）` });
  return out;
};

/** 書き出せない理由（空なら書き出せる） */
export const incomeXtxProblems = (src: Pick<IncomeTaxXtxSource, "year" | "filer" | "input" | "result" | "biz">): string[] => {
  const p: string[] = [];
  if (src.year < INCOME_XTX_FIRST_YEAR) p.push(`e-Tax のデータは令和${INCOME_XTX_FIRST_YEAR - 2018}年（${INCOME_XTX_FIRST_YEAR}年）分から書き出せます`);
  if (src.biz.realEstate) p.push("不動産所得があるときの e-Tax 用のデータ（青色申告決算書・収支内訳書（不動産所得用））は、まだ書き出せません");
  const missing = filerProblems(src.filer);
  if (missing.length) p.push(`事業者設定の e-Tax の欄：${missing.join("、")}`);
  const noPayer = src.result.second.withholding.filter((r) => r.withheld > 0 && (!r.payer.trim() || !r.payerId.trim()));
  if (noPayer.length) p.push(`源泉徴収された収入の「支払者の名称」と「法人番号又は所在地」（${noPayer.map((r) => r.item || r.kind).join("、")}）`);
  return p;
};

/** 書き出すけれど、データに入らないもの・確かめてほしいこと */
export const incomeXtxNotices = (src: Pick<IncomeTaxXtxSource, "year" | "input" | "result" | "statement" | "white">): string[] => {
  const n: string[] = [];
  if (incomeXtxVersionFor(src.year).fallback) {
    n.push(`令和${src.year - 2018}年分の e-Tax の版はまだ domble に入っていないため、令和${INCOME_XTX_FIRST_YEAR - 2018}年分の版で書き出します。e-Tax で読み込めないときは、ソフトの更新を待ってください`);
  }
  const rel = relativesShown(src.input, src.year);
  if (rel.length > RELATIVE_ROWS) n.push(`第二表の親族の欄は${RELATIVE_ROWS}人分です。${rel.slice(RELATIVE_ROWS).map((v) => v.d.name).join("・")}は書いていません`);
  const fam = familyShown(src);
  if (fam.length > FAMILY_ROWS) n.push(`第二表の事業専従者の欄は${FAMILY_ROWS}人分です。${fam.slice(FAMILY_ROWS).map((v) => v.name).join("・")}は書いていません`);
  const notCounted = src.white?.family.filter((l) => l.problem) ?? [];
  if (notCounted.length) n.push(`事業専従者控除の対象にしていない人がいます（${notCounted.map((l) => `${l.name || "氏名なし"}：${l.problem}`).join("、")}）`);
  // 貸倒引当金：2ページの計算と、1ページ（帳簿）の繰入額等・繰戻額等が合っているか
  if (!src.white) {
    const al = src.statement.allowance;
    const sec = src.statement.layout.sections;
    const booked = (rows: typeof sec.addition) => rows.find((r) => !r.extra && r.label === "貸倒引当金")?.amount ?? 0;
    if (booked(sec.addition) !== al.total || booked(sec.reversal) !== al.reversal) {
      n.push(`貸倒引当金の帳簿の額（繰入 ${booked(sec.addition).toLocaleString()}円・戻入 ${booked(sec.reversal).toLocaleString()}円）が、決算書2ページの計算（繰入 ${al.total.toLocaleString()}円・戻入 ${al.reversal.toLocaleString()}円）と合いません。決算書の2ページで仕訳を作り直してください`);
    }
  }
  if (src.white?.familySalaryBooked) n.push("専従者給与の科目に記帳した額は、白色申告では必要経費にならないため、収支内訳書の経費に入れていません");
  if (src.input.salaries.length > 0) n.push("給与があるため、保険料の「うち年末調整等以外」の欄は書いていません（源泉徴収票に載っていない分だけを書く欄です）");
  if (src.input.housingLoan > 0) n.push("住宅借入金等特別控除の区分は書いていません（計算明細書を添付して、区分を確かめてください）");
  // 医療費控除・セルフメディケーション税制は、明細書を付けて出す決まり。domble は合計だけを入れるので明細書を作れない。
  // 合計だけで申告するときは、e-Tax で出しても明細書を書面で別に出す（確定申告書等作成コーナーの「医療費の合計額のみを入力」と同じ）
  if ((src.result.rows.find((v) => v.no === "㉘")?.value ?? 0) > 0) {
    const name = src.input.medical.kind === "self" ? "セルフメディケーション税制の明細書" : "医療費控除の明細書";
    n.push(`${name}は書き出していません（domble は支払額の合計だけを入れるため）。e-Tax で申告するときも、明細書を書面で作って別に税務署へ出してください`);
  }
  return n;
};

// ── 欄の値の作り方 ──
const text = (s: string, max: number): EtaxValue | undefined => (s.trim() ? { text: [...s.trim()].slice(0, max).join("") } : undefined);
/** undefined の欄を落とす */
const clean = (v: Record<string, EtaxValue | undefined>): EtaxValues =>
  Object.fromEntries(Object.entries(v).filter((e): e is [string, EtaxValue] => e[1] !== undefined));
const amount = (n: number): EtaxValue | undefined => (n ? n : undefined);
const yes = (b: boolean): EtaxValue | undefined => (b ? { kubun: 1 } : undefined);
const bango = (s: string | undefined): EtaxValue | undefined => (s && /^\d{12}$/.test(s) ? { bango: s } : undefined);
const ref = (refs: Set<string>, name: string): EtaxValue | undefined => (refs.has(name) ? { ref: name } : undefined);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 明細を様式の行数に収める：多ければ (max - 1) 行と「その他」1行 */
const fit = <T>(rows: T[], max: number, merge: (rest: T[]) => T): T[] => (rows.length <= max ? rows : [...rows.slice(0, max - 1), merge(rows.slice(max - 1))]);
const sumOf = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

// ── 申告書（KOA020） ──
const firstValues = (src: IncomeTaxXtxSource, refs: Set<string>, refund: boolean): EtaxValues => {
  const { input: x, result: r } = src;
  const row = (no: string) => r.rows.find((v) => v.no === no)?.value ?? 0;
  // 第四表を使う年は ⑫・㉛ を書かない（㉜ は 0）
  const fourth = r.loss.fourth;
  const spouse = spouseDeduction(x.spouse, r.totalIncome, src.year);
  const specificCount = x.dependents.filter((d) => dependentDeduction(d, src.year).kind === "specificRelative").length;
  const medical = row("㉘");
  return clean({
    ABA00010: ref(refs, "NENBUN"), ABA00020: ref(refs, "SHINKOKU_KBN"), ABA00030: ref(refs, "ZEIMUSHO"),
    ABA00080: ref(refs, "NOZEISHA_ZIP"), ABA00090: ref(refs, "NOZEISHA_ADR"),
    // 1月1日の住所は翌年1月1日のもの
    ABA00110: refs.has("ICHIGATSUIPPI_ADR") ? { nen: src.year + 1 } : undefined, ABA00120: ref(refs, "ICHIGATSUIPPI_ADR"),
    ABA00125: ref(refs, "NOZEISHA_BANGO"), ABA00130: ref(refs, "NOZEISHA_NM_KN"), ABA00140: ref(refs, "NOZEISHA_NM"),
    ABA00160: ref(refs, "SHOKUGYO"), ABA00170: ref(refs, "NOZEISHA_YAGO"), ABA00180: ref(refs, "SETAINUSHI_NM"), ABA00190: ref(refs, "SETAINUSHI_ZOKU"),
    ABA00200: ref(refs, "BIRTHDAY"), ABA00220: ref(refs, "NOZEISHA_TEL"),
    ABA00240: src.white ? undefined : { kubun: 1 }, // 青色申告
    // 収入金額等
    ABB00025: src.bookKeeping, ABB00030: amount(row("㋐")),
    // 不動産：区分2（事業と同じ記帳の区分）・収入金額 ㋒（区分1 は国外中古建物の特例で、扱わない）
    ABB00046: src.biz.realEstate ? src.bookKeeping : undefined, ABB00050: src.biz.realEstate ? row("㋒") : undefined,
    ABB00080: amount(row("㋔")), ABB00100: amount(row("㋕")), ABB00105: amount(row("㋖")), ABB00110: amount(row("㋗")),
    // 所得金額等
    ABB00300: row("①"), ABB00340: src.biz.realEstate ? row("③") : undefined, ABB00370: amount(row("⑥")), ABB01060: amount(row("⑦")), ABB01090: amount(row("⑧")), ABB01120: amount(row("⑨")),
    ABB01130: amount(row("⑩")), ABB00410: fourth ? undefined : row("⑫"),
    // 所得から差し引かれる金額（医療費控除の区分 1 = セルフメディケーション税制、配偶者（特別）控除の区分1 = 配偶者特別控除、ひとり親控除の区分 = 1）
    ABB00435: medical && x.medical.kind === "self" ? 1 : undefined, ABB00440: amount(medical),
    ABB00450: amount(row("⑬")), ABB00460: amount(row("⑭")), ABB00470: amount(row("⑮")), ABB00480: amount(row("⑯")), ABB00490: amount(row("㉙")),
    ABB00495: row("⑰⑱") && x.widow === "single_parent" ? 1 : undefined, ABB00500: amount(row("⑰⑱")), ABB00510: amount(row("⑲⑳")),
    ABB00515: spouse.kind === "special" ? 1 : undefined, ABB00520: amount(row("㉑㉒")), ABB00540: amount(row("㉓")),
    ABB00546: row("㉔") ? specificCount : undefined, ABB00548: amount(row("㉔")),
    ABB00550: amount(row("㉕")), ABB00555: row("㉖"), ABB00560: row("㉚"),
    // 税金の計算
    ABB00580: fourth ? undefined : row("㉛"), ABB00590: row("㉜"), ABB00650: amount(row("㉟")), ABB00670: row("㊷"), ABB01010: row("㊹"), ABB01020: row("㊺"), ABB01030: row("㊻"),
    ABB00710: amount(row("㊾")), ABB00720: row("㊿"), ABB00730: amount(row(fieldNo(51))), ABB00750: amount(row(fieldNo(52))), ABB00760: amount(row(fieldNo(53))),
    // その他
    ABB00775: amount(row(fieldNo(56))), ABB00780: amount(row(fieldNo(57))), ABB00790: amount(row(fieldNo(58))), ABB00800: amount(row(fieldNo(59))),
    ABB00810: amount(row(fieldNo(60))), ABB00830: amount(row(fieldNo(62))),
    // 還付される税金の受取場所（口座）。公金受取口座は口座を書かず、口座情報利用同意区分を 1 にする（個人番号が必須）
    ABB00950: refund ? ref(refs, "KANPU_KINYUKIKAN") : undefined,
    ABZ40000: refund && src.filer.refund?.kind === "public" && refs.has("NOZEISHA_BANGO") ? { kubun: 1 } : undefined,
  });
};

const secondValues = (src: IncomeTaxXtxSource, refs: Set<string>): EtaxValues => {
  const { input: x, result: r, year } = src;
  const s = r.second;
  const noAdjust = x.salaries.length === 0; // 給与が無ければ、保険料はすべて年末調整等以外
  // 所得の内訳：4行まで。残りは次葉合計（源泉徴収税額の合計は全部の行）
  const withholding = [...s.withholding].sort((a, b) => b.withheld - a.withheld || b.income - a.income);
  const rest = withholding.slice(4);
  // 社会保険料・小規模企業共済等掛金：3行まで
  const byAmount = (rows: typeof s.socialInsurance) => rows.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount);
  const premiums = fit([...byAmount(s.socialInsurance), ...byAmount(s.smallBusiness)], 3, (rows) => ({ kind: "その他", amount: sumOf(rows, (p) => p.amount) }));
  const lifeText = (n: number) => (n ? { text: String(n) } : undefined);
  const life = s.life;
  const donations = [...x.donations].filter((d) => d.amount > 0).sort((a, b) => b.amount - a.amount);
  const localSum = (...kinds: string[]) => sumOf(donations.filter((d) => kinds.includes(d.local)), (d) => d.amount);
  const spouse = spouseShown(x, year, r.totalIncome);
  const relatives = relativesShown(x, year).slice(0, RELATIVE_ROWS);
  const family = familyShown(src).slice(0, FAMILY_ROWS);
  // 青色の事業専従者の生年月日は、所得税の入力で「専従者」に印を付けた同じ氏名の人から
  const birthdayOf = (f: (typeof family)[number]) =>
    f.birthday || ([x.spouse, ...x.dependents].find((p): p is Relative => !!p && p.familyEmployee && p.name.trim() === f.name.trim())?.birthday ?? "");
  const studentOk = x.student && (r.rows.find((v) => v.no === "⑲⑳")?.value ?? 0) > 0;
  const widowOk = (r.rows.find((v) => v.no === "⑰⑱")?.value ?? 0) > 0;
  return clean({
    ABC00010: ref(refs, "NENBUN"), ABC00015: ref(refs, "SHINKOKU_KBN"), ABC00040: ref(refs, "NOZEISHA_ADR"), ABC00050: ref(refs, "NOZEISHA_YAGO"),
    ABC00060: ref(refs, "NOZEISHA_NM_KN"), ABC00070: ref(refs, "NOZEISHA_NM"),
    ABD00010: withholding.length ? {
      rows: withholding.slice(0, 4).map((w) => clean({
        ABD00020: text(w.kind, 10), ABD00025: text(w.item, 10), ABD00030: text(w.payerId, 100), ABD00040: text(w.payer, 100),
        ABD00050: amount(w.income), ABD00060: w.withheld,
      })),
    } : undefined,
    ABD00064: rest.length ? { text: "次葉" } : undefined, ABD00066: rest.length ? sumOf(rest, (w) => w.withheld) : undefined,
    ABD00070: withholding.length ? sumOf(withholding, (w) => w.withheld) : undefined,
    ABE00010: family.length ? {
      rows: family.map((f) => clean({
        ABE00020: text(f.name, 30), ABE00025: bango(src.numbers[f.key]), ABE00030: isDate(birthdayOf(f)) ? { date: birthdayOf(f) } : undefined,
        ABE00040: text(f.relation, 5), ABE00060: text(f.detail, 40), ABE00070: f.amount,
      })),
    } : undefined,
    ABH00120: premiums.length ? {
      rows: premiums.map((p) => clean({ ABH00130: text(p.kind, 10), ABH00140: p.amount, ABH00580: noAdjust ? p.amount : undefined })),
    } : undefined,
    ABH00215: lifeText(life.newLife), ABH00217: noAdjust ? lifeText(life.newLife) : undefined,
    ABH00220: lifeText(life.oldLife), ABH00222: noAdjust ? lifeText(life.oldLife) : undefined,
    ABH00225: lifeText(life.newPension), ABH00227: noAdjust ? lifeText(life.newPension) : undefined,
    ABH00230: lifeText(life.oldPension), ABH00232: noAdjust ? lifeText(life.oldPension) : undefined,
    ABH00235: lifeText(life.care), ABH00237: noAdjust ? lifeText(life.care) : undefined,
    ABH00250: lifeText(s.quake.quake), ABH00255: noAdjust ? lifeText(s.quake.quake) : undefined,
    ABH00260: lifeText(s.quake.oldLong), ABH00265: noAdjust ? lifeText(s.quake.oldLong) : undefined,
    ABH00290: donations.length ? text(`${donations[0].name || "寄附先"}${donations.length > 1 ? " ほか" : ""}`, 100) : undefined,
    ABH00300: donations.length ? sumOf(donations, (d) => d.amount) : undefined,
    ABH00350: yes(widowOk && x.widow === "widow"), ABH00365: yes(widowOk && x.widow === "single_parent"), ABH00380: yes(studentOk),
    ABH00610: yes(x.disability === "normal"), ABH00620: yes(x.disability === "special"),
    // 配偶者
    ABY00020: spouse ? text(spouse.s.name, 30) : undefined, ABY00030: spouse ? bango(src.numbers.spouse) : undefined,
    ABY00040: spouse && isDate(spouse.s.birthday) ? { date: spouse.s.birthday } : undefined,
    ABY00060: yes(!!spouse && spouse.s.disability === "normal"), ABY00070: yes(!!spouse && spouse.s.disability === "special"),
    ABY00130: yes(!!spouse && !spouse.s.cohabiting),
    // 親族（16歳未満は住民税の「16」、特定親族特別控除は控除額（万円））
    ABY00150: relatives.length ? {
      rows: relatives.map(({ d, i, r: k }) => clean({
        ABY00160: text(d.name, 30), ABY00170: bango(src.numbers[`dep${i}`]), ABY00180: text(d.relation, 5),
        ABY00190: isDate(d.birthday) ? { date: d.birthday } : undefined,
        ABY00210: yes(d.disability === "normal"), ABY00220: yes(d.disability === "special"),
        ABY00253: k.kind === "specificRelative" ? k.amount / 10_000 : undefined,
        ABY00270: yes(k.kind === "minor"), ABY00280: yes(!d.cohabiting),
      })),
    } : undefined,
    // 住民税・事業税
    ABI00010: x.residentTax ? { kubun: x.residentTax === "special" ? 1 : 2 } : undefined,
    ABI00240: amount(localSum("furusato")), ABI00250: amount(localSum("community")),
    ABI00270: amount(localSum("pref", "both")), ABI00280: amount(localSum("city", "both")),
    ABI00200: x.businessTax.change ? { kubun: x.businessTax.change === "open" ? 1 : 2 } : undefined,
    ABI00210: x.businessTax.change && isDate(x.businessTax.changeDate) ? { mmdd: x.businessTax.changeDate.slice(5) } : undefined,
    ABI00220: yes(x.businessTax.otherPrefecture),
    // 不動産所得から差し引いた青色申告特別控除額（事業税）
    ABI00170: amount(r.blueRealEstate),
    // 税理士署名欄（依頼している税理士等）
    ABS10050: ref(refs, "DAIRI_NM"), ABS10060: ref(refs, "DAIRI_TEL"),
  });
};

/**
 * 第四表（一）（二）（損失申告用）。domble の所得は経常所得だけなので、損益の通算の欄はどれも (67) と同じ額
 * 4 繰越損失を差し引く計算：A（3年前）・B（2年前）・C（前年）の年分の「青色の場合・山林以外の所得の損失」の行（Ⓒ は B・C だけ）
 */
const CARRY_TAGS: [year: string, blueYear: string, before: string, used: string, after: string | null][] = [
  ["ABP00320", "ABP00340", "ABP00500", "ABP00870", null],
  ["ABP00360", "ABP00380", "ABP00620", "ABP00990", "ABP01240"],
  ["ABP00400", "ABP00420", "ABP00740", "ABP01110", "ABP01360"],
];
const fourthValues = (src: IncomeTaxXtxSource, refs: Set<string>): EtaxValues => {
  const l = src.result.loss;
  if (!l.fourth) return {};
  const v: Record<string, EtaxValue | undefined> = {
    ABM00010: ref(refs, "NENBUN"), ABM00020: ref(refs, "SHINKOKU_KBN"), ABM00060: ref(refs, "NOZEISHA_ADR"),
    ABM00070: ref(refs, "NOZEISHA_NM_KN"), ABM00080: ref(refs, "NOZEISHA_NM"),
    // 1 損失額又は所得金額・2 損益の通算（通算前・第1次〜第3次通算後・損失額又は所得金額）・(81)
    ABN00030: l.income, ABN00810: l.income, ABN00930: l.income, ABN01070: l.income, ABN01230: l.income, ABN01390: l.income, ABN01520: l.income,
    ABO00010: ref(refs, "NENBUN"), ABO00020: ref(refs, "SHINKOKU_KBN"),
    // 3 翌年以後に繰り越す損失額
    ABP00020: amount(l.blueLoss),
    ABP01445: l.forDeductions,
  };
  l.carry.forEach((c, i) => {
    if (!c.before) return;
    const [yearTag, blueTag, beforeTag, usedTag, afterTag] = CARRY_TAGS[i];
    Object.assign(v, { [yearTag]: { nen: c.year }, [blueTag]: { nen: c.year }, [beforeTag]: c.before, [usedTag]: c.used });
    if (afterTag) v[afterTag] = c.after ?? 0;
  });
  return clean(v);
};

// ── 青色申告決算書（KOA210） ──
/** 経費の決まった欄 */
const EXPENSE_TAGS: Record<string, string> = {
  租税公課: "AMF00190", 荷造運賃: "AMF00200", 水道光熱費: "AMF00210", 旅費交通費: "AMF00220", 通信費: "AMF00230", 広告宣伝費: "AMF00240",
  接待交際費: "AMF00250", 損害保険料: "AMF00260", 修繕費: "AMF00270", 消耗品費: "AMF00280", 減価償却費: "AMF00290", 福利厚生費: "AMF00300",
  給料賃金: "AMF00310", 外注工賃: "AMF00320", 利子割引料: "AMF00330", 地代家賃: "AMF00340", 貸倒金: "AMF00350", 雑費: "AMF00370",
};
/** 貸借対照表の決まった欄（期首・期末。事業主貸・事業主借は期末だけ） */
const ASSET_TAGS: Record<string, [string | null, string]> = {
  現金: ["AMG00060", "AMG00260"], 当座預金: ["AMG00070", "AMG00270"], 定期預金: ["AMG00080", "AMG00280"], その他の預金: ["AMG00090", "AMG00290"],
  受取手形: ["AMG00100", "AMG00300"], 売掛金: ["AMG00110", "AMG00310"], 有価証券: ["AMG00120", "AMG00320"], 棚卸資産: ["AMG00130", "AMG00330"],
  前払金: ["AMG00140", "AMG00340"], 貸付金: ["AMG00150", "AMG00350"], 建物: ["AMG00160", "AMG00360"], 建物附属設備: ["AMG00170", "AMG00370"],
  機械装置: ["AMG00180", "AMG00380"], 車両運搬具: ["AMG00190", "AMG00390"], "工具 器具 備品": ["AMG00200", "AMG00400"], 土地: ["AMG00210", "AMG00410"],
  事業主貸: [null, "AMG00430"],
};
const LIABILITY_TAGS: Record<string, [string | null, string]> = {
  支払手形: ["AMG00510", "AMG00640"], 買掛金: ["AMG00520", "AMG00650"], 借入金: ["AMG00530", "AMG00660"], 未払金: ["AMG00540", "AMG00670"],
  前受金: ["AMG00550", "AMG00680"], 預り金: ["AMG00560", "AMG00690"], 貸倒引当金: ["AMG00580", "AMG00710"], 事業主借: [null, "AMG00730"],
  元入金: ["AMG00600", "AMG00740"],
};

/** 売上先・仕入先の明細（4行・上記以外・計）。tags = [行, 名前, 所在地, 登録番号, 金額, 上記以外, 計] */
const partnerValues = (t: PartnerTable, tags: [string, string, string, string, string, string, string]): Record<string, EtaxValue | undefined> => {
  if (!t.total && !t.rows.length) return {};
  const [rowTag, nameTag, addressTag, invoiceTag, amountTag, otherTag, totalTag] = tags;
  return {
    [rowTag]: t.rows.length ? {
      rows: t.rows.map((r) => clean({
        [nameTag]: text(r.name, 30), [addressTag]: text(r.address, 100), [invoiceTag]: /^\d{13}$/.test(r.invoiceNo) ? { text: r.invoiceNo } : undefined, [amountTag]: r.amount,
      })),
    } : undefined,
    [otherTag]: amount(t.other), [totalTag]: t.total,
  };
};

const mergePayee = (rows: PayeeLine[]): PayeeLine => ({
  name: "その他", address: "", property: "", gross: sumOf(rows, (r) => r.gross), business: sumOf(rows, (r) => r.business), extra: sumOf(rows, (r) => r.extra),
});
const monthsOf = (rows: PayLine[]) => sumOf(rows, (r) => r.months ?? 0);

const statementValues = (src: IncomeTaxXtxSource, refs: Set<string>): EtaxValues => {
  const st = src.statement;
  const { pl, layout } = st;
  const sec = layout.sections;
  const fixed = (section: keyof typeof sec, label: string) => sec[section].find((r) => !r.extra && r.label === label);
  const amt = (section: keyof typeof sec, label: string) => fixed(section, label)?.amount ?? 0;
  const extras = (section: keyof typeof sec) => sec[section].filter((r) => r.extra);
  const v: Record<string, EtaxValue | undefined> = {};

  // 1ページ：損益計算書
  const change = src.input.businessTax;
  Object.assign(v, {
    AMA00000: ref(refs, "NENBUN"), AMB00010: text(src.settings.address, 100), AMB00030: ref(refs, "NOZEISHA_NM_KN"), AMB00040: ref(refs, "NOZEISHA_NM"),
    AMB00050: text(src.settings.office_address, 100), AMB00070: src.settings.phone ? { tel: src.settings.phone } : undefined,
    AMB00080: src.settings.office_phone ? { tel: src.settings.office_phone } : undefined,
    AMB00090: ref(refs, "SHOKUGYO"), AMB00100: ref(refs, "NOZEISHA_YAGO"), AMB00110: text(src.settings.union_name, 20),
    AMC00010: ref(refs, "DAIRI_ADR"), AMC00020: ref(refs, "DAIRI_NM"), AMC00030: ref(refs, "DAIRI_TEL"),
    // 事業期間（年の中途の開業・廃業）
    AMF00030: { mmdd: change.change === "open" && isDate(change.changeDate) ? change.changeDate.slice(5) : "01-01" },
    AMF00040: { mmdd: change.change === "close" && isDate(change.changeDate) ? change.changeDate.slice(5) : "12-31" },
    AMF00100: pl.revenue,
    AMF00120: amount(amt("cogs", "期首商品（製品）棚卸高")), AMF00130: amount(amt("cogs", "仕入金額（製品製造原価）")),
    AMF00140: amount(amt("cogs", "期首商品（製品）棚卸高") + amt("cogs", "仕入金額（製品製造原価）")),
    AMF00150: amount(amt("cogs", "期末商品（製品）棚卸高")), AMF00160: amount(pl.cogs), AMF00170: pl.grossProfit,
    AMF00380: pl.expenses, AMF00390: pl.beforeSpecial,
    AMF00420: amount(amt("reversal", "貸倒引当金")), AMF00460: amount(amt("addition", "専従者給与")), AMF00470: amount(amt("addition", "貸倒引当金")),
    AMF00500: pl.income, AMF00510: st.deduction, AMF00530: pl.income - st.deduction,
  });
  for (const [label, t] of Object.entries(EXPENSE_TAGS)) v[t] = amount(amt("expense", label));
  const extraRows = (section: keyof typeof sec, nameTag: string, amountTag: string) => {
    const rows = extras(section).filter((r) => r.amount !== 0);
    return rows.length ? { rows: rows.map((r) => clean({ [nameTag]: text(r.label, 10), [amountTag]: r.amount })) } : undefined;
  };
  v.AMF00355 = extraRows("expense", "AMF00060", "AMF00360");
  v.AMF00425 = extraRows("reversal", "AMF00070", "AMF00430");
  v.AMF00475 = extraRows("addition", "AMF00080", "AMF00480");
  const reversal = sumOf(sec.reversal, (r) => r.amount);
  const addition = sumOf(sec.addition, (r) => r.amount);
  v.AMF00440 = amount(reversal);
  v.AMF00490 = amount(addition);

  // 2ページ：月別売上（収入）金額及び仕入金額
  const m = st.monthly;
  v.AMF00538 = ref(refs, "NENBUN");
  v.AMF00550 = ref(refs, "NOZEISHA_NM_KN");
  v.AMF00560 = ref(refs, "NOZEISHA_NM");
  m.sales.forEach((x, i) => {
    v[`AMF${String(600 + i * 30).padStart(5, "0")}`] = amount(x);
    v[`AMF${String(610 + i * 30).padStart(5, "0")}`] = amount(m.purchases[i]);
  });
  v.AMF00950 = amount(m.householdUse);
  v.AMF00960 = amount(m.miscIncome);
  v.AMF00980 = sumOf(m.sales, (x) => x) + m.householdUse + m.miscIncome;
  v.AMF00990 = amount(sumOf(m.purchases, (x) => x));
  // 給料賃金の内訳：4人まで。残りは「その他」の欄（人数・延べ従事月数）
  const salaries = st.salaries.filter((r) => r.total !== 0);
  if (salaries.length) {
    const shown = salaries.slice(0, 4);
    const others = salaries.slice(4);
    v.AMF01080 = {
      rows: shown.map((r) => clean({
        AMF01090: text(r.name, 30), AMF01100: r.age ?? undefined, AMF01110: r.months ?? undefined,
        AMF01130: r.salary, AMF01140: amount(r.bonus), AMF01150: r.total, AMF01160: amount(r.tax),
      })),
    };
    if (others.length) {
      Object.assign(v, {
        AMF01180: others.length, AMF01190: monthsOf(others) || undefined,
        AMF01210: sumOf(others, (r) => r.salary), AMF01220: amount(sumOf(others, (r) => r.bonus)), AMF01230: sumOf(others, (r) => r.total),
        AMF01240: amount(sumOf(others, (r) => r.tax)),
      });
    }
    Object.assign(v, {
      AMF01260: monthsOf(salaries) || undefined, AMF01280: sumOf(salaries, (r) => r.salary), AMF01290: amount(sumOf(salaries, (r) => r.bonus)),
      AMF01300: sumOf(salaries, (r) => r.total), AMF01310: amount(sumOf(salaries, (r) => r.tax)),
    });
  }
  // 専従者給与の内訳：4人まで。残りは次葉合計
  const family = st.family.filter((r) => r.total !== 0);
  if (family.length) {
    const shown = family.slice(0, 4);
    const others = family.slice(4);
    v.AMF01330 = {
      rows: shown.map((r) => clean({
        AMF01340: text(r.name, 30), AMF01350: text(r.relation, 5), AMF01360: r.age ?? undefined, AMF01370: r.months ?? undefined,
        AMF01390: r.salary, AMF01400: amount(r.bonus), AMF01410: r.total, AMF01420: amount(r.tax),
      })),
    };
    if (others.length) {
      Object.assign(v, {
        AMF01422: { text: "次葉" }, AMF01423: Math.min(monthsOf(others), 99) || undefined,
        AMF01425: sumOf(others, (r) => r.salary), AMF01426: amount(sumOf(others, (r) => r.bonus)), AMF01427: sumOf(others, (r) => r.total),
        AMF01428: amount(sumOf(others, (r) => r.tax)),
      });
    }
    Object.assign(v, {
      AMF01440: Math.min(monthsOf(family), 99) || undefined, AMF01460: sumOf(family, (r) => r.salary), AMF01470: amount(sumOf(family, (r) => r.bonus)),
      AMF01480: sumOf(family, (r) => r.total), AMF01490: amount(sumOf(family, (r) => r.tax)),
    });
  }
  // 地代家賃の内訳：2件まで
  const rent = fit(st.rent.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AMF02120 = rent.length ? {
    rows: rent.map((r) => clean({
      AMF02140: text(r.address, 100), AMF02150: text(r.name, 100), AMF02160: text(r.property, 14), AMF02200: r.gross, AMF02210: r.business,
    })),
  } : undefined;
  // 青色申告特別控除額の計算（不動産所得は扱わない）
  // 貸倒引当金繰入額の計算（① 個別評価・② 貸金の合計・③ 繰入限度額・④ 一括評価の繰入額・⑤ ①＋④）
  const al = st.allowance;
  if (al.total || al.base) {
    Object.assign(v, { AMF01010: amount(al.individual), AMF01030: amount(al.base), AMF01040: amount(al.limit), AMF01050: amount(al.bulk), AMF01060: al.total });
  }
  // 青色申告特別控除額の計算：⑥ 不動産所得、⑦ 控除前の所得、⑧ 不動産所得から差し引く額、⑨ 控除額
  v.AMF01510 = st.realEstateIncome ? st.realEstateIncome : undefined;
  v.AMF01520 = Math.max(0, pl.income);
  if (src.biz.filingType === "blue10") Object.assign(v, { AMF01570: st.realEstateDeduction, AMF01580: st.deduction });
  else Object.assign(v, { AMF01540: st.realEstateDeduction, AMF01550: st.deduction });

  // 3ページ：売上（収入）金額・仕入金額の明細（4件まで。残りは上記以外）
  Object.assign(v, partnerValues(st.sales, ["AMF02230", "AMF02240", "AMF02250", "AMF02270", "AMF02290", "AMF02300", "AMF02310"]));
  Object.assign(v, partnerValues(st.purchases, ["AMF02330", "AMF02340", "AMF02350", "AMF02370", "AMF02390", "AMF02400", "AMF02410"]));
  // 減価償却費の計算（7件まで。残りは次葉合計）
  const dep = st.depreciation;
  if (dep.length) {
    const shown = dep.slice(0, 7);
    const others = dep.slice(7);
    v.AMF01600 = {
      rows: shown.map((d) => clean({
        AMF01610: text(d.name, 16), AMF01620: text(d.quantity, 13), AMF01630: { yymm: d.acquired }, AMF01640: d.cost, AMF01650: d.base,
        AMF01660: text(d.method, 10), AMF01670: d.life !== null && d.life >= 2 ? d.life : undefined,
        AMF01690: d.rate !== null ? { decimal: d.rate.toFixed(3) } : undefined, AMF01720: d.months >= 1 ? d.months : undefined,
        AMF01730: d.depreciation, AMF01750: d.depreciation, AMF01760: { decimal: String(Number(d.businessRate.toFixed(2))) }, AMF01770: d.business, AMF01780: d.closing,
        AMF01790: text(d.memo, 15),
      })),
    };
    if (others.length) {
      Object.assign(v, {
        AMF01792: { text: "次葉" }, AMF01793: sumOf(others, (d) => d.depreciation), AMF01795: sumOf(others, (d) => d.depreciation),
        AMF01796: sumOf(others, (d) => d.business), AMF01797: sumOf(others, (d) => d.closing),
      });
    }
    Object.assign(v, {
      AMF01810: sumOf(dep, (d) => d.depreciation), AMF01830: sumOf(dep, (d) => d.depreciation), AMF01840: sumOf(dep, (d) => d.business),
      AMF01850: sumOf(dep, (d) => d.closing),
    });
  }
  // 利子割引料（金融機関を除く）・税理士等の報酬：2件まで
  const interest = fit(st.interest.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AMF01870 = interest.length ? {
    rows: interest.map((r) => clean({ AMF01890: text(r.address, 100), AMF01900: text(r.name, 100), AMF01910: amount(r.extra), AMF01920: r.gross, AMF01930: r.business })),
  } : undefined;
  const fees = fit(st.fees.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AMF02040 = fees.length ? {
    rows: fees.map((r) => clean({ AMF02060: text(r.address, 100), AMF02070: text(r.name, 100), AMF02080: r.gross, AMF02090: r.business, AMF02100: amount(r.extra) })),
  } : undefined;
  v.AMF02110 = text(st.special, 275);

  // 4ページ：貸借対照表
  Object.assign(v, {
    AMG00010: { date: `${src.year}-12-31` }, AMG00050: { mmdd: "01-01" }, AMG00250: { mmdd: "12-31" }, AMG00500: { mmdd: "01-01" }, AMG00630: { mmdd: "12-31" },
  });
  const bs = (section: "asset" | "liability", tags: Record<string, [string | null, string]>, extraTag: string, nameTag: string, openTag: string, endTag: string) => {
    for (const r of sec[section].filter((x) => !x.extra)) {
      const t = tags[r.label];
      if (!t) continue;
      if (t[0]) v[t[0]] = amount(r.opening);
      v[t[1]] = amount(r.amount);
    }
    const rows = extras(section);
    v[extraTag] = rows.length ? { rows: rows.map((r) => clean({ [nameTag]: text(r.label, 10), [openTag]: amount(r.opening), [endTag]: amount(r.amount) })) } : undefined;
  };
  bs("asset", ASSET_TAGS, "AMG00025", "AMG00030", "AMG00220", "AMG00420");
  bs("liability", LIABILITY_TAGS, "AMG00465", "AMG00470", "AMG00570", "AMG00700");
  v.AMG00230 = sumOf(sec.asset, (r) => r.opening);
  v.AMG00440 = sumOf(sec.asset, (r) => r.amount);
  v.AMG00750 = st.totalIncome;
  v.AMG00610 = sumOf(sec.liability, (r) => r.opening);
  v.AMG00760 = sumOf(sec.liability, (r) => r.amount) + st.totalIncome;
  return clean(v);
};

// ── 収支内訳書（KOA110） ──
/** 収支内訳書の経費の決まった欄 */
const WHITE_EXPENSE_TAGS: Record<string, string> = {
  給料賃金: "AIG00150", 外注工賃: "AIG00160", 減価償却費: "AIG00170", 貸倒金: "AIG00180", 地代家賃: "AIG00190", 利子割引料: "AIG00200",
  租税公課: "AIG00220", 荷造運賃: "AIG00230", 水道光熱費: "AIG00240", 旅費交通費: "AIG00250", 通信費: "AIG00260", 広告宣伝費: "AIG00270",
  接待交際費: "AIG00280", 損害保険料: "AIG00290", 修繕費: "AIG00300", 消耗品費: "AIG00310", 福利厚生費: "AIG00320", 雑費: "AIG00340",
};

const whiteValues = (src: IncomeTaxXtxSource, refs: Set<string>): EtaxValues => {
  const w = src.white!;
  const d = w.detail;
  const change = src.input.businessTax;
  const v: Record<string, EtaxValue | undefined> = {
    // 1ページ：見出し
    AIA00000: ref(refs, "NENBUN"), AIB00010: text(src.settings.address, 100), AIB00030: ref(refs, "NOZEISHA_NM_KN"), AIB00040: ref(refs, "NOZEISHA_NM"),
    AIB00050: text(src.settings.office_address, 100), AIB00070: src.settings.phone ? { tel: src.settings.phone } : undefined,
    AIB00080: src.settings.office_phone ? { tel: src.settings.office_phone } : undefined,
    AIB00090: ref(refs, "SHOKUGYO"), AIB00100: ref(refs, "NOZEISHA_YAGO"), AIB00110: text(src.settings.union_name, 20),
    AIC00010: ref(refs, "DAIRI_ADR"), AIC00020: ref(refs, "DAIRI_NM"), AIC00030: ref(refs, "DAIRI_TEL"),
    AIR00000: { kubun: 1 }, // 営業等
    AIF00010: { mmdd: change.change === "open" && isDate(change.changeDate) && change.changeDate.startsWith(`${src.year}-`) ? change.changeDate.slice(5) : "01-01" },
    AIF00020: { mmdd: change.change === "close" && isDate(change.changeDate) && change.changeDate.startsWith(`${src.year}-`) ? change.changeDate.slice(5) : "12-31" },
    // 収支内訳
    AIG00030: amount(w.revenue.sales), AIG00040: amount(w.revenue.household), AIG00050: amount(w.revenue.other), AIG00060: w.revenue.total,
    AIG00080: amount(w.cogs.opening), AIG00090: amount(w.cogs.purchases), AIG00100: amount(w.cogs.subtotal), AIG00110: amount(w.cogs.closing), AIG00120: amount(w.cogs.cost),
    AIG00130: w.difference,
    AIG00350: w.otherSubtotal, AIG00360: w.expenseTotal, AIG00370: w.beforeDeduction, AIG00380: amount(w.familyDeduction), AIG00400: w.income,
  };
  for (const r of [...w.mainExpenses, ...w.otherExpenses].filter((x) => !x.extra)) v[WHITE_EXPENSE_TAGS[r.label]] = amount(r.amount);
  const extras = w.otherExpenses.filter((r) => r.extra && r.amount !== 0);
  v.AIG00325 = extras.length ? { rows: extras.map((r) => clean({ AIG00010: text(r.label, 10), AIG00330: r.amount })) } : undefined;

  // 給料賃金の内訳：3人まで。残りは「その他」の欄（人数・延べ従事月数）
  const salaries = d.salaries.filter((r) => r.total !== 0);
  if (salaries.length) {
    const shown = salaries.slice(0, 3);
    const others = salaries.slice(3);
    v.AIH00010 = {
      rows: shown.map((r) => clean({
        AIH00020: text(r.name, 30), AIH00030: r.age ?? undefined, AIH00040: r.months ?? undefined,
        AIH00050: r.salary, AIH00060: amount(r.bonus), AIH00070: r.total, AIH00080: amount(r.tax),
      })),
    };
    if (others.length) {
      Object.assign(v, {
        AIH00100: others.length, AIH00110: monthsOf(others) || undefined,
        AIH00120: sumOf(others, (r) => r.salary), AIH00130: amount(sumOf(others, (r) => r.bonus)), AIH00140: sumOf(others, (r) => r.total),
        AIH00150: amount(sumOf(others, (r) => r.tax)),
      });
    }
    Object.assign(v, {
      AIH00170: monthsOf(salaries) || undefined, AIH00180: sumOf(salaries, (r) => r.salary), AIH00190: amount(sumOf(salaries, (r) => r.bonus)),
      AIH00200: sumOf(salaries, (r) => r.total), AIH00210: amount(sumOf(salaries, (r) => r.tax)),
    });
  }
  // 税理士・弁護士等の報酬・料金の内訳：2件まで
  const fees = fit(d.fees.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AII00000 = fees.length ? {
    rows: fees.map((r) => clean({ AII00020: text(r.address, 100), AII00030: text(r.name, 100), AII00040: r.gross, AII00050: r.business, AII00060: amount(r.extra) })),
  } : undefined;
  // 事業専従者の氏名等：3人まで。残りは次葉合計（従事月数）
  const family = w.family.filter((l) => !l.problem);
  if (family.length) {
    const months = (rows: typeof family) => Math.min(sumOf(rows, (l) => l.months ?? 0), 99);
    const others = family.slice(3);
    v.AIJ00010 = {
      rows: family.slice(0, 3).map((l) => clean({ AIJ00020: text(l.name, 30), AIJ00030: l.age ?? undefined, AIJ00040: text(l.relation, 5), AIJ00050: l.months ?? undefined })),
    };
    if (others.length) Object.assign(v, { AIJ00054: { text: "次葉" }, AIJ00056: months(others) || undefined });
    v.AIJ00060 = months(family) || undefined;
  }

  // 2ページ：売上（収入）金額・仕入金額の明細（4件まで。残りは上記以外）
  Object.assign(v, partnerValues(w.sales, ["AIK00010", "AIK00020", "AIK00030", "AIK00080", "AIK00040", "AIK00050", "AIK00060"]));
  Object.assign(v, partnerValues(w.purchases, ["AIL00010", "AIL00020", "AIL00030", "AIL00080", "AIL00040", "AIL00050", "AIL00060"]));
  // 減価償却費の計算（6件まで。残りは次葉合計）
  const dep = d.depreciation;
  if (dep.length) {
    const others = dep.slice(6);
    v.AIM00010 = {
      rows: dep.slice(0, 6).map((x) => clean({
        AIM00020: text(x.name, 16), AIM00030: text(x.quantity, 20), AIM00050: { yymm: x.acquired }, AIM00060: x.cost, AIM00070: x.base,
        AIM00080: text(x.method, 10), AIM00090: x.life !== null && x.life >= 2 ? x.life : undefined,
        AIM00110: x.rate !== null ? { decimal: x.rate.toFixed(3) } : undefined, AIM00140: x.months >= 1 ? x.months : undefined,
        AIM00150: x.depreciation, AIM00170: x.depreciation, AIM00180: { decimal: String(Number(x.businessRate.toFixed(2))) }, AIM00190: x.business, AIM00200: x.closing,
        AIM00210: text(x.memo, 15),
      })),
    };
    if (others.length) {
      Object.assign(v, {
        AIM00212: { text: "次葉" }, AIM00213: sumOf(others, (x) => x.depreciation), AIM00215: sumOf(others, (x) => x.depreciation),
        AIM00216: sumOf(others, (x) => x.business), AIM00217: sumOf(others, (x) => x.closing),
      });
    }
    Object.assign(v, {
      AIM00230: sumOf(dep, (x) => x.depreciation), AIM00250: sumOf(dep, (x) => x.depreciation), AIM00260: sumOf(dep, (x) => x.business), AIM00270: sumOf(dep, (x) => x.closing),
    });
  }
  // 地代家賃・利子割引料（金融機関を除く）の内訳：2件まで
  const rent = fit(d.rent.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AIN00000 = rent.length ? {
    rows: rent.map((r) => clean({ AIN00020: text(r.address, 100), AIN00030: text(r.name, 100), AIN00040: text(r.property, 14), AIN00080: r.gross, AIN00090: r.business })),
  } : undefined;
  const interest = fit(d.interest.filter((r) => r.gross !== 0), 2, mergePayee);
  v.AIO00000 = interest.length ? {
    rows: interest.map((r) => clean({ AIO00020: text(r.address, 100), AIO00030: text(r.name, 100), AIO00040: amount(r.extra), AIO00050: r.gross, AIO00060: r.business })),
  } : undefined;
  v.AIP00000 = text(d.special, 500);
  return clean(v);
};

/** 確定申告書と青色申告決算書（白色申告は収支内訳書）の xtx。書き出せないときは例外 */
export const buildIncomeTaxXtx = (src: IncomeTaxXtxSource): string => {
  const problems = incomeXtxProblems(src);
  if (problems.length) throw new Error(problems.join("。"));
  const self = src.numbers.self;
  const filer: EtaxFiler = {
    ...src.filer, myNumber: self && /^\d{12}$/.test(self) ? self : "", birthday: /^\d{4}-\d{2}-\d{2}$/.test(src.input.birthday) ? src.input.birthday : "",
    jan1Address: src.input.jan1Address,
  };
  const refund = (src.result.rows.find((r) => r.no === fieldNo(53))?.value ?? 0) > 0;
  const it = { refund, personal: true, nenbun: src.year };
  const refs = itRefs(filer, it);
  const attrs: FormAttrs = { author: filer.yago.trim() || filer.name.trim(), createdOn: src.createdOn };
  const koa020 = { ...firstValues({ ...src, filer }, refs, refund), ...secondValues(src, refs), ...fourthValues(src, refs) };
  return documentXml({
    namespace: NAMESPACE,
    procedure: PROCEDURE.procedure,
    procedureVersion: incomeXtxVersionFor(src.year).version,
    it: itXml(filer, { procedure: PROCEDURE.procedure, procedureName: PROCEDURE.name, shinkokuKbn: 1, ...it }),
    // 手続の XSD の順番：申告書（KOA020）、収支内訳書（KOA110）・青色申告決算書（KOA210）
    forms: [
      { id: "KOA020", xml: formXml("KOA020", koa020, attrs) },
      src.white
        ? { id: "KOA110", xml: formXml("KOA110", whiteValues(src, refs), attrs) }
        : { id: "KOA210", xml: formXml("KOA210", statementValues(src, refs), attrs) },
    ],
  });
};
