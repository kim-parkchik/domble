/**
 * 償却資産申告（固定資産税）の資料（純粋関数）
 *
 * 毎年1月1日（賦課期日）に持っている事業用の償却資産は、1月31日までに資産のある市区町村へ申告する（地方税法383条）。
 * 固定資産税の免税点（150万円）未満でも申告は要る。domble の年 Y の画面では、Y+1 年1月1日現在の分（令和(Y+1−2018)年度）を作る
 * （その年の固定資産台帳がそろったところで作るため）。
 *
 * 対象（資産の種類）：1 構築物（建物附属設備のうち、借りた店・事務所に自分で付けた内装・設備など家屋でないものを含む）、2 機械及び装置、
 *   3 船舶、4 航空機、5 車両及び運搬具（自動車税・軽自動車税の対象を除く）、6 工具、器具及び備品
 * 対象外：取得価額10万円未満で必要経費にしたもの・一括償却資産・所有権移転外リースの資産（所有者のリース会社が申告。地方税法341条4号・
 *   施行令49条）、建物と建物と一体の設備（家屋として課税）、無形固定資産（ソフトウェア）、繰延資産、自動車税・軽自動車税の対象の車両
 * 少額減価償却資産（措置法28条の2）は対象。台帳に耐用年数が無いので、ここで入れてもらう（DepTaxSetting.life）
 * 事業と家事で兼用する資産は、事業用の割合が小さくても資産全体が対象（広島市の案内）。取得価額の全額で載せ、市区町村で確かめるよう知らせる
 *
 * 評価額（固定資産評価基準 第3章第1節）：前年中に取得したもの 取得価額 ×（1 − r/2）、前年前に取得したもの 前年度の評価額 ×（1 − r）。
 *   1円未満は切り捨て。取得価額の 5% を下回るときは 5%（最低限度）。r は耐用年数に応ずる減価率（別表第15。旧定率法の償却率と同じ値）
 * 課税標準額は評価額の合計（1,000円未満切り捨て）。150万円未満なら課税されない（免税点。地方税法351条）。税額の見込みは標準税率 1.4%（100円未満切り捨て）
 */
import type { CsvValue } from "./csv";
import { EXPENSE_LIMIT, businessRateIn, hasLife, oldDecliningRateMil, type FixedAsset } from "./depreciation";
import { yen } from "./format";
import type { PrintColumn, PrintGroup, PrintRow, PrintSection } from "./printLayout";

/** 償却資産の種類（申告書・種類別明細書の番号） */
export type DepTaxKind = 1 | 2 | 3 | 4 | 5 | 6;
export const DEP_TAX_KINDS: DepTaxKind[] = [1, 2, 3, 4, 5, 6];
export const DEP_TAX_KIND_LABEL: Record<DepTaxKind, string> = {
  1: "構築物", 2: "機械及び装置", 3: "船舶", 4: "航空機", 5: "車両及び運搬具", 6: "工具、器具及び備品",
};

/** 対象外の理由 */
export type DepTaxExclusion = "house" | "vehicle" | "intangible" | "lump3" | "deferred" | "lease" | "under" | "user";
export const DEP_TAX_EXCLUSION_LABEL: Record<DepTaxExclusion, string> = {
  house: "家屋（建物・建物と一体の設備）として課税",
  vehicle: "自動車税・軽自動車税の対象",
  intangible: "無形固定資産",
  lump3: "一括償却資産",
  deferred: "繰延資産",
  lease: "リース資産（所有者のリース会社が申告）",
  under: "取得価額10万円未満で必要経費にしたもの",
  user: "対象外にした",
};
/** 変えられない対象外（償却方法・取得価額で決まるもの） */
export const FIXED_EXCLUSIONS: DepTaxExclusion[] = ["lump3", "deferred", "lease", "under"];

/**
 * 資産ごとの設定（入れた年から、あとの年へ引き継ぐ）
 *  kind：0 = 対象外、1〜6 = 資産の種類、無ければ科目からの初期値
 *  life：耐用年数（少額減価償却資産など、台帳に耐用年数の無い資産）
 */
export interface DepTaxSetting {
  kind?: 0 | DepTaxKind;
  life?: number;
}

/** 設定の文字（statement_notes に入れる JSON）を読む。おかしな値は捨てる */
export const parseDepTaxSetting = (raw: string): DepTaxSetting => {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: DepTaxSetting = {};
    if (typeof j.kind === "number" && Number.isInteger(j.kind) && j.kind >= 0 && j.kind <= 6) out.kind = j.kind as 0 | DepTaxKind;
    if (typeof j.life === "number" && Number.isInteger(j.life) && j.life >= 2 && j.life <= 100) out.life = j.life;
    return out;
  } catch {
    return {};
  }
};

/** 科目と償却方法からの初期値（guessed = 科目から種類が分からず、工具、器具及び備品にした） */
export type DepTaxDefault = { kind: DepTaxKind; guessed?: boolean } | { exclusion: DepTaxExclusion };

export const defaultDepTax = (a: Pick<FixedAsset, "method" | "cost" | "income_kind">, accountCode: string): DepTaxDefault => {
  if (a.method === "lump3" || accountCode === "137") return { exclusion: "lump3" };
  if (a.method === "deferred") return { exclusion: "deferred" };
  if (a.method === "lease") return { exclusion: "lease" };
  if (a.method === "small" && a.cost < EXPENSE_LIMIT) return { exclusion: "under" };
  switch (accountCode) {
    case "130": return { exclusion: "house" };
    // 建物附属設備：事業所得の資産は借りた店・事務所の内装などとみて構築物、不動産所得の資産は貸している自分の建物の設備とみて家屋
    case "131": return a.income_kind === "realestate" ? { exclusion: "house" } : { kind: 1 };
    case "132": return { kind: 2 };
    case "133": return { exclusion: "vehicle" };
    case "134": return { kind: 6 };
    case "136": return { kind: 1 };
    case "138": return { exclusion: "intangible" };
    default: return { kind: 6, guessed: true };
  }
};

/** 設定を当てたあとの、種類か対象外の理由 */
export const resolveDepTax = (def: DepTaxDefault, s: DepTaxSetting | undefined): { kind: DepTaxKind } | { exclusion: DepTaxExclusion } => {
  if ("exclusion" in def && FIXED_EXCLUSIONS.includes(def.exclusion)) return def;
  if (s?.kind === 0) return { exclusion: "user" };
  if (s?.kind) return { kind: s.kind };
  return "exclusion" in def ? def : { kind: def.kind };
};

/** 賦課期日（domble の年 Y の画面では、Y+1 年1月1日） */
export const assessmentDate = (year: number) => `${year + 1}-01-01`;
/** 申告する年度（例：2026年の画面 → 令和9年度） */
export const depTaxYearLabel = (year: number) => `令和${year + 1 - 2018}年度`;

/** その日（賦課期日）に持っているか（その日に売却・除却したものは、その日には持っていたものとする） */
export const heldOn = (a: Pick<FixedAsset, "acquired_on" | "disposed_on">, date: string) =>
  a.acquired_on <= date && !(a.disposed_on && a.disposed_on < date);

/** 最初に課税される賦課期日の年（1月1日に取得したものはその年、ほかは翌年） */
const firstAssessmentYear = (acquiredOn: string) => Number(acquiredOn.slice(0, 4)) + (acquiredOn.slice(5) === "01-01" ? 0 : 1);

/** 減価率 r（千分率。耐用年数に応ずる減価率表 = 旧定率法の償却率） */
export const depTaxRateMil = (life: number) => oldDecliningRateMil(life);

/** 減価残存率の表示（前年中取得 1 − r/2、前年前取得 1 − r） */
const residualText = (rMil: number, first: boolean) => {
  const v = first ? (2000 - rMil) / 2000 : (1000 - rMil) / 1000;
  return v.toFixed(4).replace(/0$/, "");
};

/**
 * 評価額（assessYear 年1月1日の分）。前年中取得は 取得価額 ×（1 − r/2）、以後は毎年 ×（1 − r）。1円未満切り捨て、最低限度は取得価額の 5%
 */
export const depTaxValue = (cost: number, life: number, acquiredOn: string, assessYear: number) => {
  const r = depTaxRateMil(life);
  const n = assessYear - firstAssessmentYear(acquiredOn) + 1;
  if (n < 1) return { value: 0, residual: "", first: false };
  const floor = Math.floor((cost * 5) / 100);
  let v = Math.floor((cost * (2000 - r)) / 2000);
  for (let i = 2; i <= n; i++) v = Math.floor((v * (1000 - r)) / 1000);
  return { value: Math.max(v, floor), residual: residualText(r, n === 1), first: n === 1 };
};

/** 西暦の日付 → 和暦の年月（令和8年5月）。明治から */
const ERAS: [string, string, number][] = [["2019-05-01", "令和", 2018], ["1989-01-08", "平成", 1988], ["1926-12-25", "昭和", 1925], ["1912-07-30", "大正", 1911], ["0000-01-01", "明治", 1867]];
export const warekiMonth = (date: string) => {
  const [, era, base] = ERAS.find(([from]) => date >= from)!;
  const y = Number(date.slice(0, 4)) - base;
  return `${era}${y === 1 ? "元" : y}年${Number(date.slice(5, 7))}月`;
};

/** 区分：前年中に取得 ／ 前年前に取得 ／ 前年中に減少 */
export type DepTaxStatus = "new" | "old" | "decreased";
export const DEP_TAX_STATUS_LABEL: Record<DepTaxStatus, string> = { new: "前年中に取得", old: "前年前に取得", decreased: "前年中に減少" };

export interface DepTaxRow {
  asset: FixedAsset;
  account: string;
  status: DepTaxStatus;
  /** 種類（対象のとき） */
  kind: DepTaxKind | null;
  /** 対象外の理由（対象外のとき） */
  exclusion: DepTaxExclusion | null;
  /** 初期値（設定を当てる前） */
  def: DepTaxDefault;
  /** 種類・対象外を自分で選んだか */
  chosen: boolean;
  /** 耐用年数（無ければ null：少額減価償却資産で入れていない） */
  life: number | null;
  /** 台帳の耐用年数を使うか（定額法・定率法）。使わない資産は、ここで入れる */
  ledgerLife: boolean;
  /** 減価残存率（前年中取得 1 − r/2、前年前取得 1 − r）・評価額（1月1日に持っていて、耐用年数があるときだけ） */
  residual: string;
  value: number | null;
  /** 事業と家事で兼用（その年の事業専用割合が 100% でない） */
  mixed: boolean;
  /** 摘要（減少の事由・家事用から転用など） */
  memo: string;
}

export interface DepTaxSummaryRow {
  kind: DepTaxKind;
  /** 前年前に取得したもの（イ）：前年の1月1日に持っていたもの */
  before: number;
  /** 前年中に減少したもの（ロ） */
  decreased: number;
  /** 前年中に取得したもの（ハ） */
  added: number;
  /** 計（ニ = イ − ロ + ハ） */
  total: number;
  /** 評価額 */
  value: number;
}

export interface DepTaxIssue {
  level: "error" | "warn" | "info";
  text: string;
}

export interface DepTaxReport {
  year: number;
  /** 賦課期日（YYYY-MM-DD） */
  date: string;
  /** 申告する年度（令和9年度） */
  label: string;
  /** 申告の対象で、1月1日に持っているもの（全資産用。種類・取得日の順） */
  held: DepTaxRow[];
  /** そのうち前年中に取得したもの（増加資産用） */
  added: DepTaxRow[];
  /** 前年中に減少したもの（減少資産用） */
  decreased: DepTaxRow[];
  /** 対象外の資産（1月1日に持っているもの・前年中に減少したもの） */
  excluded: DepTaxRow[];
  summary: DepTaxSummaryRow[];
  sum: Omit<DepTaxSummaryRow, "kind">;
  /** 課税標準額（評価額の合計の 1,000円未満を切り捨て） */
  standard: number;
  /** 免税点（150万円）未満 */
  exempt: boolean;
  /** 固定資産税の見込み（標準税率 1.4%。100円未満切り捨て。免税点未満なら 0） */
  tax: number;
  issues: DepTaxIssue[];
}

/** 免税点（課税標準額がこれ未満なら課税されない。地方税法351条） */
export const DEP_TAX_EXEMPT_LIMIT = 1_500_000;
/** 標準税率（千分率。1.4%） */
export const DEP_TAX_RATE_MIL = 14;

const names = (rows: DepTaxRow[]) => rows.map((r) => `「${r.asset.name}」`).join("・");

/**
 * 償却資産申告の資料（年 year の画面 → year+1 年1月1日現在）
 * @param codeOf 資産の科目のコード（130 建物 など）、nameOf 科目名、settings 資産ごとの設定（その年までのいちばん新しいもの）
 */
export const depTaxReport = (
  assets: FixedAsset[], year: number, codeOf: (accountId: number) => string, nameOf: (accountId: number) => string, settings: Map<number, DepTaxSetting>,
): DepTaxReport => {
  const date = assessmentDate(year);
  const prev = `${year}-01-01`;
  const rows: DepTaxRow[] = [];
  for (const a of assets) {
    const now = heldOn(a, date);
    const before = heldOn(a, prev);
    const status: DepTaxStatus | null = now ? (a.acquired_on <= prev ? "old" : "new") : before ? "decreased" : null;
    if (!status) continue;
    const def = defaultDepTax(a, codeOf(a.account_id));
    const s = settings.get(a.id);
    const r = resolveDepTax(def, s);
    const ledgerLife = hasLife(a.method);
    const life = ledgerLife ? a.useful_life || null : s?.life ?? null;
    const kind = "kind" in r ? r.kind : null;
    const v = kind && life && status !== "decreased" ? depTaxValue(a.cost, life, a.acquired_on, year + 1) : null;
    const memo = [
      status === "decreased" ? (a.disposal_kind === "sale" ? "売却" : a.disposal_kind === "scrap" ? "滅失（除却）" : "減少") + `（${a.disposed_on!.replace(/-/g, "/")}）` : "",
      a.converted ? `家事用から転用（${a.used_on.replace(/-/g, "/")}）` : "",
    ].filter(Boolean).join("・");
    rows.push({
      asset: a, account: nameOf(a.account_id), status, kind, exclusion: "exclusion" in r ? r.exclusion : null, def,
      chosen: s?.kind !== undefined && !("exclusion" in def && FIXED_EXCLUSIONS.includes(def.exclusion)),
      life, ledgerLife, residual: v?.residual ?? "", value: v ? v.value : null,
      mixed: businessRateIn(a, year) < 100, memo,
    });
  }
  const order = (x: DepTaxRow, y: DepTaxRow) => (x.kind ?? 9) - (y.kind ?? 9) || x.asset.acquired_on.localeCompare(y.asset.acquired_on) || x.asset.id - y.asset.id;
  rows.sort(order);
  const taxed = rows.filter((r) => r.kind !== null);
  const held = taxed.filter((r) => r.status !== "decreased");
  const added = held.filter((r) => r.status === "new");
  const decreased = taxed.filter((r) => r.status === "decreased");
  const excluded = rows.filter((r) => r.kind === null);

  const summary = DEP_TAX_KINDS.map((kind): DepTaxSummaryRow => {
    const of = (list: DepTaxRow[]) => list.filter((r) => r.kind === kind);
    const costOf = (list: DepTaxRow[]) => of(list).reduce((s, r) => s + r.asset.cost, 0);
    const before = costOf(taxed.filter((r) => r.status !== "new"));
    const dec = costOf(decreased);
    const add = costOf(added);
    return { kind, before, decreased: dec, added: add, total: before - dec + add, value: of(held).reduce((s, r) => s + (r.value ?? 0), 0) };
  });
  const total = (k: keyof Omit<DepTaxSummaryRow, "kind">) => summary.reduce((s, r) => s + r[k], 0);
  const sum = { before: total("before"), decreased: total("decreased"), added: total("added"), total: total("total"), value: total("value") };
  const standard = Math.floor(sum.value / 1000) * 1000;
  const exempt = standard < DEP_TAX_EXEMPT_LIMIT;
  const tax = exempt ? 0 : Math.floor((standard * DEP_TAX_RATE_MIL) / 1000 / 100) * 100;

  // 確かめること
  const issues: DepTaxIssue[] = [];
  const noLife = held.filter((r) => r.life === null);
  if (noLife.length) issues.push({ level: "error", text: `${names(noLife)}の耐用年数を入れてください（少額減価償却資産など、台帳に耐用年数の無い資産。評価額の計算に使います）。` });
  const live = rows.filter((r) => r.status !== "decreased");
  const fixtures = live.filter((r) => codeOf(r.asset.account_id) === "131" && !r.chosen);
  if (fixtures.length) {
    issues.push({
      level: "warn",
      text: `建物附属設備の${names(fixtures)}を確かめて選んでください。借りた店・事務所に自分で付けた内装・設備は「構築物」として申告します。` +
        "自分の建物と一体になっている設備（照明・空調・給排水など）は家屋として課税されるので「対象外」にします（初期値は、事業所得の資産は構築物、不動産所得の資産は対象外）。",
    });
  }
  const vehicles = live.filter((r) => codeOf(r.asset.account_id) === "133" && !r.chosen);
  if (vehicles.length) {
    issues.push({
      level: "info",
      text: `車両運搬具の${names(vehicles)}は、自動車税・軽自動車税の対象として申告の対象外にしています。対象でない車両（大型特殊自動車・構内だけで使うものなど）は「車両及び運搬具」を選んでください。`,
    });
  }
  const guessed = live.filter((r) => "kind" in r.def && r.def.guessed && !r.chosen);
  if (guessed.length) issues.push({ level: "warn", text: `${names(guessed)}は科目から種類が分からないので「工具、器具及び備品」にしています。確かめて選んでください。` });
  const mixed = held.filter((r) => r.mixed);
  if (mixed.length) {
    issues.push({
      level: "info",
      text: `事業と家事で兼用している${names(mixed)}は、取得価額の全額で載せています（事業用の割合が小さくても資産全体が申告の対象。広島市などの案内）。扱いは資産のある市区町村で確かめてください。`,
    });
  }
  if (held.length || decreased.length) {
    issues.push({
      level: "info",
      text: exempt
        ? `課税標準額（評価額の合計）が ${DEP_TAX_EXEMPT_LIMIT.toLocaleString()} 円未満なので、固定資産税はかかりません（免税点）。それでも申告は要ります。`
        : `課税標準額（評価額の合計）が ${DEP_TAX_EXEMPT_LIMIT.toLocaleString()} 円以上なので、固定資産税がかかります（評価額は市区町村が決めます。ここの額は見込みです）。`,
    });
  }
  return { year, date, label: depTaxYearLabel(year), held, added, decreased, excluded, summary, sum, standard, exempt, tax, issues };
};

// ────────────────────────────────────────────
// 印刷（A4 縦）と CSV
// ────────────────────────────────────────────

const SUMMARY_COLUMNS: PrintColumn[] = [
  { label: "資産の種類", width: 22 },
  { label: "前年前に取得したもの（イ）", width: 16, align: "right" },
  { label: "前年中に減少したもの（ロ）", width: 16, align: "right" },
  { label: "前年中に取得したもの（ハ）", width: 16, align: "right" },
  { label: "計（ニ）（イ − ロ ＋ ハ）", width: 16, align: "right" },
  { label: "評価額（見込み）", width: 16, align: "right" },
];
const DETAIL_COLUMNS: PrintColumn[] = [
  { label: "資産の種類", width: 13 },
  { label: "資産の名称等", width: 24 },
  { label: "数量", width: 5, align: "right" },
  { label: "取得年月", width: 12, nowrap: true },
  { label: "取得価額", width: 13, align: "right" },
  { label: "耐用年数", width: 7, align: "right" },
  { label: "減価残存率", width: 9, align: "right" },
  { label: "評価額（見込み）", width: 13, align: "right" },
  { label: "摘要", width: 16 },
];
const DECREASE_COLUMNS: PrintColumn[] = [
  { label: "資産の種類", width: 14 },
  { label: "資産の名称等", width: 26 },
  { label: "数量", width: 6, align: "right" },
  { label: "取得年月", width: 13, nowrap: true },
  { label: "取得価額", width: 14, align: "right" },
  { label: "耐用年数", width: 8, align: "right" },
  { label: "減少の事由", width: 25 },
];
const EXCLUDED_COLUMNS: PrintColumn[] = [
  { label: "名称・科目", width: 34 },
  { label: "取得日", width: 14, nowrap: true },
  { label: "取得価額", width: 14, align: "right" },
  { label: "対象外の理由", width: 38 },
];

const kindText = (r: DepTaxRow) => (r.kind ? `${r.kind} ${DEP_TAX_KIND_LABEL[r.kind]}` : "");
const lifeOf = (r: DepTaxRow) => (r.life ? `${r.life}年` : "（未入力）");
const mixedMemo = (r: DepTaxRow) => [r.memo, r.mixed ? "家事と兼用" : ""].filter(Boolean).join("・");

const detailSection = (heading: string, list: DepTaxRow[]): PrintSection => {
  const groups: PrintGroup[] = list.map((r) => ({
    rows: [{
      cells: [
        kindText(r), { text: r.asset.name, note: r.account }, "1", warekiMonth(r.asset.acquired_on), yen(r.asset.cost), lifeOf(r), r.residual,
        r.value === null ? "" : yen(r.value), mixedMemo(r),
      ],
    }],
  }));
  if (list.length === 0) groups.push({ rows: [{ cells: [{ text: "ありません", span: 9 }] }] });
  else {
    groups.push({
      rows: [{
        kind: "total",
        cells: [{ text: "合計", span: 4, align: "center" }, yen(list.reduce((s, r) => s + r.asset.cost, 0)), "", "", yen(list.reduce((s, r) => s + (r.value ?? 0), 0)), ""],
      }],
    });
  }
  return { heading, columns: DETAIL_COLUMNS, groups };
};

/** 印刷の区分：申告書に書く数字・種類別明細書（全資産用・増加資産用・減少資産用）・対象外の資産 */
export const depTaxPrintSections = (r: DepTaxReport): PrintSection[] => {
  const summaryRows: PrintRow[] = r.summary.map((s) => ({
    cells: [`${s.kind} ${DEP_TAX_KIND_LABEL[s.kind]}`, yen(s.before), yen(s.decreased), yen(s.added), yen(s.total), yen(s.value)],
  }));
  summaryRows.push({ kind: "total", cells: ["合計", yen(r.sum.before), yen(r.sum.decreased), yen(r.sum.added), yen(r.sum.total), yen(r.sum.value)] });
  const note = (text: string): PrintRow => ({ cells: [{ text, span: 6 }] });
  const summary: PrintSection = {
    heading: `申告書に書く数字（取得価額・${r.label}）`,
    columns: SUMMARY_COLUMNS,
    groups: [
      { rows: summaryRows },
      {
        rows: [
          note(`課税標準額（見込み）：${yen(r.standard)} 円　${r.exempt ? "免税点（150万円）未満のため課税されません（申告は要ります）" : `固定資産税の見込み（標準税率 1.4%）：${yen(r.tax)} 円`}`),
          ...r.issues.filter((i) => i.level !== "info" || !i.text.startsWith("課税標準額")).map((i) => note(`${i.level === "error" ? "要入力" : "確認"}：${i.text}`)),
        ],
      },
    ],
  };
  const decreased: PrintSection = {
    heading: "種類別明細書（減少資産用）",
    columns: DECREASE_COLUMNS,
    groups: r.decreased.length
      ? r.decreased.map((x) => ({
        rows: [{ cells: [kindText(x), { text: x.asset.name, note: x.account }, "1", warekiMonth(x.asset.acquired_on), yen(x.asset.cost), lifeOf(x), `全部・${x.memo}`] }],
      }))
      : [{ rows: [{ cells: [{ text: "ありません", span: 7 }] }] }],
  };
  const excluded: PrintSection = {
    heading: "申告の対象外にした資産",
    columns: EXCLUDED_COLUMNS,
    groups: r.excluded.length
      ? r.excluded.map((x) => ({
        rows: [{
          cells: [{ text: x.asset.name, note: x.account }, x.asset.acquired_on.replace(/-/g, "/"), yen(x.asset.cost), x.exclusion ? DEP_TAX_EXCLUSION_LABEL[x.exclusion] : ""],
        }],
      }))
      : [{ rows: [{ cells: [{ text: "ありません", span: 4 }] }] }],
  };
  return [summary, detailSection("種類別明細書（全資産用）", r.held), detailSection("種類別明細書（増加資産用）", r.added), decreased, excluded];
};

export const DEP_TAX_CSV_HEADER = [
  "明細書", "資産の種類（番号）", "資産の種類", "資産の名称等", "科目", "数量", "取得年月", "取得日", "取得価額", "耐用年数", "減価残存率", "評価額（見込み）", "摘要",
];

/** CSV：全資産用・増加資産用・減少資産用・対象外の順に1行ずつ（明細書の列で、どの明細書の行かを分ける） */
export const depTaxCsvRows = (r: DepTaxReport): CsvValue[][] => {
  const row = (label: string, x: DepTaxRow, memo: string): CsvValue[] => [
    label, x.kind ?? "", x.kind ? DEP_TAX_KIND_LABEL[x.kind] : "", x.asset.name, x.account, 1, warekiMonth(x.asset.acquired_on), x.asset.acquired_on, x.asset.cost,
    x.life ?? "", x.residual, x.value ?? "", memo,
  ];
  return [
    ...r.held.map((x) => row("全資産用", x, mixedMemo(x))),
    ...r.added.map((x) => row("増加資産用", x, mixedMemo(x))),
    ...r.decreased.map((x) => row("減少資産用", x, x.memo)),
    ...r.excluded.map((x) => row("対象外", x, x.exclusion ? DEP_TAX_EXCLUSION_LABEL[x.exclusion] : "")),
  ];
};
