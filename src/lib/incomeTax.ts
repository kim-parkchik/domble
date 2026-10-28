/**
 * 所得税及び復興特別所得税の確定申告書（第一表・第二表）の数字（純粋関数）。欄番号は令和7年分の様式と令和8年分の様式（案）で同じ
 *
 * 年分で変わる決まり（基礎控除・給与所得控除・扶養親族などの所得要件・勤労学生・生命保険料控除の特例）は INCOME_TAX_RULES の年分ごとの表に持つ。
 * 表に無い年分は、いちばん近い年分の表で計算し、そのことを notes で知らせる（決まりが定まる前の年も、仮の数字を出せるように）
 *
 * 対象：事業所得（営業等。帳簿と決算書から）・給与所得・雑所得（公的年金等・業務・その他）
 *  - 給与所得控除は年分の表の最低保障（令和7年分 65万円、令和8・9年分 74万円と 190万円超 220万円以下の特例の段）。660万円未満は「年末調整等のための給与所得控除後の給与等の金額の表」と同じ計算
 *  - 公的年金等控除は年齢（その年12月31日現在で65歳以上か）と、公的年金等以外の合計所得金額（1,000万円・2,000万円）で決める
 *  - 雑所得の損失は雑所得の中だけで差し引く。事業所得の損失はほかの所得から差し引く（純損失が残る場合の損失申告は扱わない）
 * 所得控除：社会保険料・小規模企業共済等掛金・生命保険料（令和8年分からの23歳未満の扶養親族がいる場合の特例を含む）・地震保険料・寄附金・医療費（またはセルフメディケーション税制）・
 *   寡婦・ひとり親・勤労学生・障害者・配偶者（特別）・扶養・特定親族特別控除（令和7年分から）・基礎控除
 * 税額：課税される所得金額（千円未満切り捨て）× 税率、住宅借入金等特別控除（計算明細書の額を入れる）、復興特別所得税（基準所得税額 × 2.1%。1円未満切り捨て）、
 *   源泉徴収税額・予定納税額を差し引いて、納める税金（百円未満切り捨て）または還付される税金
 * 扱わないもの：不動産・利子・配当・譲渡・一時所得、分離課税、損失申告、雑損控除、所得金額調整控除、配当控除などほかの税額控除、災害減免、外国税額控除、白色申告の専従者控除
 */
import type { FilingType } from "./types";

// ────────────────────────────────────────────
// 入力（年度ごとに保存する。帳簿から出せないもの）
// ────────────────────────────────────────────

/** none = なし ／ normal = 障害者 ／ special = 特別障害者 */
export type Disability = "none" | "normal" | "special";
export const DISABILITIES: { value: Disability; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "normal", label: "障害者" },
  { value: "special", label: "特別障害者" },
];

/** 所得の内訳（第二表）：源泉徴収のある収入の支払者ごと */
export interface PayerRow {
  /** 種目（例：原稿料、給料、厚生年金） */
  item: string;
  /** 支払者の名称 */
  payer: string;
  /** 支払者の法人番号又は所在地 */
  payerId: string;
  /** 収入金額 */
  income: number;
  /** 源泉徴収税額 */
  withheld: number;
}

/** 雑所得（業務・その他） */
export interface MiscRow extends PayerRow {
  kind: "business" | "other";
  /** 必要経費 */
  expenses: number;
}

/** 保険料など（種類ごと） */
export interface PremiumRow {
  kind: string;
  amount: number;
}

/** 配偶者・親族 */
export interface Relative {
  name: string;
  /** 続柄（例：子、父） */
  relation: string;
  /** 生年月日（YYYY-MM-DD） */
  birthday: string;
  /** その年の合計所得金額 */
  income: number;
  disability: Disability;
  /** 同居しているか（同居特別障害者・同居老親等） */
  cohabiting: boolean;
  /** 本人または配偶者の直系尊属か（父母・祖父母など。同居老親等） */
  lineal: boolean;
  /** 事業専従者か（青色事業専従者として給与を受ける人・白色の事業専従者）。配偶者控除・扶養控除・障害者控除などの対象にならない */
  familyEmployee: boolean;
}

/**
 * 寄附金の住民税での区分（第二表「住民税・事業税に関する事項」の寄附金税額控除）
 * furusato 都道府県・市区町村への寄附（ふるさと納税など。特例控除対象） ／ community 共同募金・日赤その他 ／
 * pref 都道府県が条例で指定 ／ city 市区町村が条例で指定 ／ both 都道府県と市区町村の両方が条例で指定 ／ "" 住民税の控除なし
 */
export type DonationLocal = "" | "furusato" | "community" | "pref" | "city" | "both";
export const DONATION_LOCALS: [DonationLocal, string][] = [
  ["", "住民税の控除なし"], ["furusato", "ふるさと納税など"], ["community", "共同募金・日赤など"],
  ["pref", "都道府県の条例指定"], ["city", "市区町村の条例指定"], ["both", "都道府県・市区町村の条例指定"],
];

export interface Donation {
  name: string;
  amount: number;
  local: DonationLocal;
}

export interface IncomeTaxInput {
  /** 本人の生年月日（YYYY-MM-DD。公的年金等控除の年齢に使う） */
  birthday: string;
  /** 翌年1月1日の住所（今の住所と違うときだけ。年分ごと） */
  jan1Address: string;
  /** 寡婦・ひとり親 */
  widow: "none" | "widow" | "single_parent";
  student: boolean;
  disability: Disability;
  /** 事業（営業等）の収入のうち源泉徴収されたもの（報酬・料金など） */
  businessWithholding: PayerRow[];
  /** 給与（源泉徴収票の支払金額・源泉徴収税額） */
  salaries: PayerRow[];
  /** 公的年金等（源泉徴収票の支払金額・源泉徴収税額） */
  pensions: PayerRow[];
  misc: MiscRow[];
  socialInsurance: PremiumRow[];
  smallBusiness: PremiumRow[];
  /** 生命保険料（その年に払った額。剰余金・割戻金を差し引いた額） */
  life: { newLife: number; oldLife: number; newPension: number; oldPension: number; care: number };
  quake: { quake: number; oldLong: number };
  /** normal = 医療費控除 ／ self = セルフメディケーション税制（どちらか一方） */
  medical: { kind: "normal" | "self"; paid: number; reimbursed: number };
  donations: Donation[];
  spouse: Relative | null;
  dependents: Relative[];
  /** 住宅借入金等特別控除額（計算明細書で計算した額） */
  housingLoan: number;
  /** 予定納税額（第1期分・第2期分の合計） */
  prepaid: number;
  /** 住民税：給与・公的年金等以外の所得に係る住民税の徴収方法（special 特別徴収 ／ self 自分で納付 ／ "" 書かない） */
  residentTax: "" | "special" | "self";
  /** 事業税：他の都道府県に事務所等があるか、その年の中途の開業・廃業（日付 YYYY-MM-DD） */
  businessTax: { otherPrefecture: boolean; change: "" | "open" | "close"; changeDate: string };
}

export const emptyRelative = (relation = ""): Relative => ({
  name: "", relation, birthday: "", income: 0, disability: "none", cohabiting: true, lineal: false, familyEmployee: false,
});

export const EMPTY_INCOME_TAX_INPUT: IncomeTaxInput = {
  birthday: "", jan1Address: "", widow: "none", student: false, disability: "none",
  businessWithholding: [], salaries: [], pensions: [], misc: [],
  socialInsurance: [], smallBusiness: [],
  life: { newLife: 0, oldLife: 0, newPension: 0, oldPension: 0, care: 0 },
  quake: { quake: 0, oldLong: 0 },
  medical: { kind: "normal", paid: 0, reimbursed: 0 },
  donations: [], spouse: null, dependents: [], housingLoan: 0, prepaid: 0,
  residentTax: "", businessTax: { otherPrefecture: false, change: "", changeDate: "" },
};

const MAX_AMOUNT = 100_000_000_000;
const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** 保存する前に形を整え、おかしければ理由を返す（文字列の前後の空白は落とす。金額は 0 以上の整数） */
export const normalizeIncomeTaxInput = (raw: unknown): IncomeTaxInput | string => {
  const x = (raw ?? {}) as Partial<IncomeTaxInput>;
  const problems: string[] = [];
  const amount = (v: unknown, label: string) => {
    const n = v === undefined || v === null || v === "" ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT) {
      problems.push(`${label}は 0 以上の整数（円）で入れてください`);
      return 0;
    }
    return n;
  };
  const text = (v: unknown, max = 100) => String(v ?? "").trim().slice(0, max);
  const date = (v: unknown, label: string) => {
    const s = text(v, 10);
    if (s && !isIsoDate(s)) problems.push(`${label}の生年月日が正しくありません`);
    return s;
  };
  const disability = (v: unknown): Disability => (v === "normal" || v === "special" ? v : "none");
  const payer = (r: Partial<PayerRow>, label: string): PayerRow => ({
    item: text(r.item), payer: text(r.payer), payerId: text(r.payerId),
    income: amount(r.income, `${label}の収入金額`), withheld: amount(r.withheld, `${label}の源泉徴収税額`),
  });
  const relative = (r: Partial<Relative>, label: string): Relative => ({
    name: text(r.name), relation: text(r.relation, 20), birthday: date(r.birthday, label),
    income: amount(r.income, `${label}の合計所得金額`), disability: disability(r.disability), cohabiting: r.cohabiting !== false, lineal: !!r.lineal, familyEmployee: !!r.familyEmployee,
  });
  const list = <T,>(v: unknown, f: (r: never, i: number) => T): T[] => (Array.isArray(v) ? v.slice(0, 50).map((r, i) => f((r ?? {}) as never, i)) : []);
  const life = (x.life ?? {}) as Partial<IncomeTaxInput["life"]>;
  const quake = (x.quake ?? {}) as Partial<IncomeTaxInput["quake"]>;
  const medical = (x.medical ?? {}) as Partial<IncomeTaxInput["medical"]>;
  const biz = (x.businessTax ?? {}) as Partial<IncomeTaxInput["businessTax"]>;
  const change = biz.change === "open" || biz.change === "close" ? biz.change : "";
  const changeDate = change ? text(biz.changeDate, 10) : "";
  if (changeDate && !isIsoDate(changeDate)) problems.push("事業税の開業・廃業の日付が正しくありません");
  const out: IncomeTaxInput = {
    birthday: date(x.birthday, "本人"),
    jan1Address: text(x.jan1Address),
    widow: x.widow === "widow" || x.widow === "single_parent" ? x.widow : "none",
    student: !!x.student,
    disability: disability(x.disability),
    businessWithholding: list(x.businessWithholding, (r: Partial<PayerRow>, i) => payer(r, `事業の源泉徴収 ${i + 1}行目`)),
    salaries: list(x.salaries, (r: Partial<PayerRow>, i) => payer(r, `給与 ${i + 1}行目`)),
    pensions: list(x.pensions, (r: Partial<PayerRow>, i) => payer(r, `公的年金等 ${i + 1}行目`)),
    misc: list(x.misc, (r: Partial<MiscRow>, i) => ({
      ...payer(r, `雑所得 ${i + 1}行目`), kind: r.kind === "business" ? "business" as const : "other" as const, expenses: amount(r.expenses, `雑所得 ${i + 1}行目の必要経費`),
    })),
    socialInsurance: list(x.socialInsurance, (r: Partial<PremiumRow>, i) => ({ kind: text(r.kind), amount: amount(r.amount, `社会保険料 ${i + 1}行目`) })),
    smallBusiness: list(x.smallBusiness, (r: Partial<PremiumRow>, i) => ({ kind: text(r.kind), amount: amount(r.amount, `小規模企業共済等掛金 ${i + 1}行目`) })),
    life: {
      newLife: amount(life.newLife, "新生命保険料"), oldLife: amount(life.oldLife, "旧生命保険料"),
      newPension: amount(life.newPension, "新個人年金保険料"), oldPension: amount(life.oldPension, "旧個人年金保険料"), care: amount(life.care, "介護医療保険料"),
    },
    quake: { quake: amount(quake.quake, "地震保険料"), oldLong: amount(quake.oldLong, "旧長期損害保険料") },
    medical: { kind: medical.kind === "self" ? "self" : "normal", paid: amount(medical.paid, "医療費"), reimbursed: amount(medical.reimbursed, "保険金などで補填される金額") },
    donations: list(x.donations, (r: Partial<Donation>, i) => ({
      name: text(r.name), amount: amount(r.amount, `寄附金 ${i + 1}行目`), local: DONATION_LOCALS.some(([v]) => v === r.local) ? r.local! : "",
    })),
    spouse: x.spouse ? relative(x.spouse, "配偶者") : null,
    dependents: list(x.dependents, (r: Partial<Relative>, i) => relative(r, `扶養親族 ${i + 1}人目`)),
    housingLoan: amount(x.housingLoan, "住宅借入金等特別控除額"),
    prepaid: amount(x.prepaid, "予定納税額"),
    residentTax: x.residentTax === "special" || x.residentTax === "self" ? x.residentTax : "",
    businessTax: { otherPrefecture: !!biz.otherPrefecture, change, changeDate },
  };
  return problems.length ? problems[0] : out;
};

// ────────────────────────────────────────────
// 所得の計算
// ────────────────────────────────────────────

const floorTo = (n: number, unit: number) => Math.floor(n / unit) * unit;
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);

/** その年12月31日現在の年齢（1月1日生まれの人は12月31日に1つ上がる） */
export const ageAt = (birthday: string, year: number): number | null => {
  if (!isIsoDate(birthday)) return null;
  return year - Number(birthday.slice(0, 4)) + (birthday.slice(5) === "01-01" ? 1 : 0);
};

// ────────────────────────────────────────────
// 年分ごとの決まり
// ────────────────────────────────────────────

export interface IncomeTaxRules {
  /** 年分（西暦） */
  year: number;
  /** 基礎控除：合計所得金額の上限ごとの額（上から順に見る。最後より多ければ 0） */
  basic: [number, number][];
  /** 給与所得控除の最低保障額（給与所得 = 収入 − この額。この額 + 1,000円 未満なら 0） */
  salaryMin: number;
  /** 最低保障の計算をやめる収入（これ以上は 4千円単位の表の計算）と、そのあいだの特例の段（[この収入未満, 給与所得]） */
  salaryFlatUntil: number;
  salarySteps: [number, number][];
  /** 扶養親族・同一生計配偶者の所得要件（合計所得金額がこの額以下） */
  dependentLimit: number;
  /** 勤労学生の所得要件 */
  studentLimit: number;
  /** 23歳未満の扶養親族がいる場合の生命保険料控除の特例（新生命保険料の上限 6万円）があるか */
  lifeUnder23: boolean;
}

/** 国税庁「源泉所得税の改正のあらまし（令和8年4月）」・令和7年分の確定申告の手引き */
export const INCOME_TAX_RULES: IncomeTaxRules[] = [
  {
    year: 2025,
    basic: [[1_320_000, 950_000], [3_360_000, 880_000], [4_890_000, 680_000], [6_550_000, 630_000], [23_500_000, 580_000],
      [24_000_000, 480_000], [24_500_000, 320_000], [25_000_000, 160_000]],
    salaryMin: 650_000, salaryFlatUntil: 1_900_000, salarySteps: [],
    dependentLimit: 580_000, studentLimit: 850_000, lifeUnder23: false,
  },
  {
    year: 2026,
    basic: [[4_890_000, 1_040_000], [6_550_000, 670_000], [23_500_000, 620_000], [24_000_000, 480_000], [24_500_000, 320_000], [25_000_000, 160_000]],
    // 令和8・9年分の特例：最低保障 74万円、190万円超 220万円以下は国税庁の表の特例の段
    salaryMin: 740_000, salaryFlatUntil: 2_191_000, salarySteps: [[2_193_000, 1_451_000], [2_196_000, 1_453_000], [2_200_000, 1_456_000]],
    dependentLimit: 620_000, studentLimit: 890_000, lifeUnder23: true,
  },
];

/** 和暦の年分の表示（2026 → 令和8年分） */
export const reiwaYear = (year: number) => `令和${year - 2018}年分`;

/** その年分の決まり。表に無ければいちばん近い年分（fallback = true） */
export const rulesFor = (year: number): { rules: IncomeTaxRules; fallback: boolean } => {
  const exact = INCOME_TAX_RULES.find((r) => r.year === year);
  if (exact) return { rules: exact, fallback: false };
  const sorted = [...INCOME_TAX_RULES].sort((a, b) => a.year - b.year);
  return { rules: year < sorted[0].year ? sorted[0] : sorted[sorted.length - 1], fallback: true };
};
const LATEST = Math.max(...INCOME_TAX_RULES.map((r) => r.year));

/** 給与所得の金額（所得金額調整控除・特定支出控除は扱わない） */
export const salaryIncome = (x: number, year = LATEST): number => {
  const r = rulesFor(year).rules;
  if (x < r.salaryMin + 1_000) return 0;
  if (x < r.salaryFlatUntil) return x - r.salaryMin;
  const step = r.salarySteps.find(([max]) => x < max);
  if (step) return step[1];
  if (x < 6_600_000) {
    const a = floorTo(x / 4, 1000);
    return x < 3_600_000 ? (a * 28) / 10 - 80_000 : (a * 32) / 10 - 440_000;
  }
  if (x < 8_500_000) return Math.floor((x * 9) / 10) - 1_100_000;
  return x - 1_950_000;
};

/** 公的年金等に係る雑所得の金額。other = 公的年金等に係る雑所得以外の合計所得金額 */
export const pensionIncome = (x: number, age65: boolean, other: number): number => {
  const [zero, bend] = age65 ? [1_100_000, 3_300_000] : [600_000, 1_300_000];
  let r: number;
  if (x <= zero) r = 0;
  else if (x < bend) r = x - zero;
  else if (x < 4_100_000) r = Math.floor((x * 75) / 100) - 275_000;
  else if (x < 7_700_000) r = Math.floor((x * 85) / 100) - 685_000;
  else if (x < 10_000_000) r = Math.floor((x * 95) / 100) - 1_455_000;
  else r = x - 1_955_000;
  // 公的年金等以外の合計所得金額が 1,000万円超なら控除額を 10万円、2,000万円超なら 20万円減らす
  const adj = other > 20_000_000 ? 200_000 : other > 10_000_000 ? 100_000 : 0;
  return Math.min(x, Math.max(0, r + adj));
};

// ────────────────────────────────────────────
// 所得控除
// ────────────────────────────────────────────

const newContract = (x: number, wide = false) => {
  const k = wide ? 1.5 : 1;
  if (x <= 20_000 * k) return x;
  if (x <= 40_000 * k) return Math.floor(x / 2) + 10_000 * k;
  if (x <= 80_000 * k) return Math.floor(x / 4) + 20_000 * k;
  return 40_000 * k;
};
const oldContract = (x: number) => {
  if (x <= 25_000) return x;
  if (x <= 50_000) return Math.floor(x / 2) + 12_500;
  if (x <= 100_000) return Math.floor(x / 4) + 25_000;
  return 50_000;
};
/** 新契約と旧契約の両方：旧契約だけで計算した額と、両方を足した額（上限あり）の多いほう */
const combined = (newer: number, older: number, cap: number, wide = false) => {
  if (!newer) return oldContract(older);
  if (!older) return newContract(newer, wide);
  return Math.max(oldContract(older), Math.min(newContract(newer, wide) + oldContract(older), cap));
};

/** 生命保険料控除。under23 = 23歳未満の扶養親族がいる（令和8年分の特例：新生命保険料の上限 6万円） */
export const lifeInsuranceDeduction = (l: IncomeTaxInput["life"], under23: boolean) => {
  const general = combined(l.newLife, l.oldLife, under23 ? 60_000 : 40_000, under23);
  const pension = combined(l.newPension, l.oldPension, 40_000);
  const care = newContract(l.care);
  return Math.min(general + pension + care, 120_000);
};

/** 地震保険料控除（地震保険料は全額、旧長期損害保険料は 1万5千円まで。合わせて 5万円まで） */
export const quakeDeduction = (q: IncomeTaxInput["quake"]) => {
  const old = q.oldLong <= 10_000 ? q.oldLong : q.oldLong <= 20_000 ? Math.floor(q.oldLong / 2) + 5_000 : 15_000;
  return Math.min(Math.min(q.quake, 50_000) + old, 50_000);
};

/** 医療費控除（総所得金額等の 5% と 10万円の少ないほうを超える額。200万円まで）・セルフメディケーション税制（1万2千円を超える額。8万8千円まで） */
export const medicalDeduction = (m: IncomeTaxInput["medical"], totalIncome: number) => {
  const net = Math.max(m.paid - m.reimbursed, 0);
  if (m.kind === "self") return Math.min(Math.max(net - 12_000, 0), 88_000);
  return Math.min(Math.max(net - Math.min(100_000, Math.floor((Math.max(totalIncome, 0) * 5) / 100)), 0), 2_000_000);
};

/** 寄附金控除（総所得金額等の 40% までの寄附金から 2千円を引いた額） */
export const donationDeduction = (total: number, totalIncome: number) =>
  Math.max(Math.min(total, Math.floor((Math.max(totalIncome, 0) * 40) / 100)) - 2_000, 0);

/** 基礎控除（合計所得金額で決まる） */
export const basicDeduction = (income: number, year = LATEST) => rulesFor(year).rules.basic.find(([max]) => income <= max)?.[1] ?? 0;

const SPECIAL_LIMIT = 1_330_000;
const SPECIFIC_LIMIT = 1_230_000;

/** 配偶者特別控除（配偶者の合計所得金額が所得要件超 133万円以下。本人の合計所得金額 900万・950万・1,000万円以下で3段階） */
const SPOUSE_SPECIAL: [number, number, number, number][] = [
  [950_000, 380_000, 260_000, 130_000], [1_000_000, 360_000, 240_000, 120_000], [1_050_000, 310_000, 210_000, 110_000],
  [1_100_000, 260_000, 180_000, 90_000], [1_150_000, 210_000, 140_000, 70_000], [1_200_000, 160_000, 110_000, 60_000],
  [1_250_000, 110_000, 80_000, 40_000], [1_300_000, 60_000, 40_000, 20_000], [1_330_000, 30_000, 20_000, 10_000],
];
/** 特定親族特別控除（19歳以上23歳未満で合計所得金額が所得要件超 123万円以下） */
const SPECIFIC_RELATIVE: [number, number][] = [
  [850_000, 630_000], [900_000, 610_000], [950_000, 510_000], [1_000_000, 410_000], [1_050_000, 310_000],
  [1_100_000, 210_000], [1_150_000, 110_000], [1_200_000, 60_000], [1_230_000, 30_000],
];

export interface SpouseResult {
  /** spouse = 配偶者控除、special = 配偶者特別控除 */
  kind: "spouse" | "special" | null;
  amount: number;
  elderly: boolean;
}

export const spouseDeduction = (s: Relative | null, ownIncome: number, year: number): SpouseResult => {
  const none: SpouseResult = { kind: null, amount: 0, elderly: false };
  if (!s || s.familyEmployee || ownIncome > 10_000_000) return none;
  const tier = ownIncome <= 9_000_000 ? 0 : ownIncome <= 9_500_000 ? 1 : 2;
  const elderly = (ageAt(s.birthday, year) ?? 0) >= 70;
  if (s.income <= rulesFor(year).rules.dependentLimit) return { kind: "spouse", amount: (elderly ? [480_000, 320_000, 160_000] : [380_000, 260_000, 130_000])[tier], elderly };
  if (s.income > SPECIAL_LIMIT) return none;
  const row = SPOUSE_SPECIAL.find(([max]) => s.income <= max)!;
  return { kind: "special", amount: row[1 + tier], elderly: false };
};

export type DependentKind = "minor" | "general" | "specific" | "elderly" | "elderlyParent" | "specificRelative" | "none" | "familyEmployee";
export const DEPENDENT_KIND_LABEL: Record<DependentKind, string> = {
  minor: "16歳未満（扶養控除なし）", general: "一般の控除対象扶養親族", specific: "特定扶養親族（19歳以上23歳未満）", elderly: "老人扶養親族（70歳以上）",
  elderlyParent: "同居老親等", specificRelative: "特定親族特別控除", none: "対象外（所得が多い）", familyEmployee: "対象外（事業専従者）",
};

/** 扶養親族ごとの扶養控除・特定親族特別控除 */
export const dependentDeduction = (d: Relative, year: number): { kind: DependentKind; amount: number; age: number | null } => {
  const age = ageAt(d.birthday, year);
  // 事業専従者は扶養親族・特定親族にならない
  if (d.familyEmployee) return { kind: "familyEmployee", amount: 0, age };
  if (d.income > rulesFor(year).rules.dependentLimit) {
    if (age !== null && age >= 19 && age < 23 && d.income <= SPECIFIC_LIMIT) {
      return { kind: "specificRelative", amount: SPECIFIC_RELATIVE.find(([max]) => d.income <= max)![1], age };
    }
    return { kind: "none", amount: 0, age };
  }
  if (age !== null && age < 16) return { kind: "minor", amount: 0, age };
  if (age !== null && age >= 19 && age < 23) return { kind: "specific", amount: 630_000, age };
  if (age !== null && age >= 70) return d.lineal && d.cohabiting ? { kind: "elderlyParent", amount: 580_000, age } : { kind: "elderly", amount: 480_000, age };
  return { kind: "general", amount: 380_000, age };
};

const disabilityAmount = (d: Disability, cohabiting: boolean) => (d === "special" ? (cohabiting ? 750_000 : 400_000) : d === "normal" ? 270_000 : 0);

// ────────────────────────────────────────────
// 税額
// ────────────────────────────────────────────

/** 課税される所得金額（千円未満切り捨て済み）に対する税額 */
export const incomeTaxOn = (taxable: number) => {
  if (taxable <= 0) return 0;
  // [上限, 税率（%）, 控除額]
  const brackets: [number, number, number][] = [
    [1_949_000, 5, 0], [3_299_000, 10, 97_500], [6_949_000, 20, 427_500], [8_999_000, 23, 636_000],
    [17_999_000, 33, 1_536_000], [39_999_000, 40, 2_796_000], [Infinity, 45, 4_796_000],
  ];
  const [, pct, minus] = brackets.find(([max]) => taxable <= max)!;
  return Math.floor((taxable * pct) / 100) - minus;
};

/** 青色申告特別控除の上限（申告の種類から。不動産所得との按分などは考えない） */
export const BLUE_DEDUCTION_LIMIT: Record<FilingType, number> = { blue65: 650_000, blue55: 550_000, blue10: 100_000, white: 0 };

// ────────────────────────────────────────────
// 申告書
// ────────────────────────────────────────────

/** 帳簿と決算書から出す事業所得（営業等）の数字 */
export interface BusinessFigures {
  /** 売上（収入）金額（家事消費・雑収入を含む） */
  revenue: number;
  /** 青色申告特別控除前の所得金額 */
  incomeBeforeBlue: number;
  filingType: FilingType;
  /** 専従者給与の合計 */
  familySalary: number;
}

export interface IncomeTaxRow {
  /** 欄番号（第一表） */
  no: string;
  label: string;
  value: number | null;
  note?: string;
  /** 見出し行 */
  head?: boolean;
  key?: string;
}

export interface IncomeTaxResult {
  rows: IncomeTaxRow[];
  /** 第二表に書く内訳 */
  second: {
    withholding: { kind: string; item: string; payer: string; payerId: string; income: number; withheld: number }[];
    socialInsurance: PremiumRow[];
    smallBusiness: PremiumRow[];
    life: IncomeTaxInput["life"];
    quake: IncomeTaxInput["quake"];
    donations: IncomeTaxInput["donations"];
    relatives: { name: string; relation: string; birthday: string; kind: string; disability: Disability; cohabiting: boolean }[];
  };
  /** 合計所得金額（⑫） */
  totalIncome: number;
  /** 納める税金（＋）・還付される税金（−） */
  balance: number;
  notes: string[];
}

const NOS = "⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";
/** 欄番号（51 以降は丸数字が無いので（51）） */
export const fieldNo = (n: number) => (n <= 50 ? [...NOS][n] : `(${n})`);

export const computeIncomeTax = (input: IncomeTaxInput, biz: BusinessFigures, year: number): IncomeTaxResult => {
  const notes: string[] = [];
  const { rules, fallback } = rulesFor(year);
  if (fallback) {
    notes.push(`${reiwaYear(year)}の決まりはまだ domble に入っていないため、${reiwaYear(rules.year)}の決まり（基礎控除・給与所得控除・所得要件など）で計算した仮の数字です。ソフトの更新で直ります。`);
  }
  const DEPENDENT_LIMIT = rules.dependentLimit;
  const white = biz.filingType === "white";
  const blue = white ? 0 : Math.min(BLUE_DEDUCTION_LIMIT[biz.filingType], Math.max(0, biz.incomeBeforeBlue));
  if (white) notes.push("白色申告の事業専従者控除と収支内訳書には対応していません。事業所得は決算書の所得金額（専従者給与を経費にした額）のままです。");

  // 収入金額等・所得金額等
  const salaryIn = sum(input.salaries.map((r) => r.income));
  const pensionIn = sum(input.pensions.map((r) => r.income));
  const miscBizIn = sum(input.misc.filter((r) => r.kind === "business").map((r) => r.income));
  const miscOtherIn = sum(input.misc.filter((r) => r.kind === "other").map((r) => r.income));
  const r1 = biz.incomeBeforeBlue - blue;
  const r6 = salaryIncome(salaryIn, rules.year);
  const r8 = sum(input.misc.filter((r) => r.kind === "business").map((r) => r.income - r.expenses));
  const r9 = sum(input.misc.filter((r) => r.kind === "other").map((r) => r.income - r.expenses));
  // 公的年金等以外の合計所得金額（雑所得の損失はほかの所得から引けない）
  const other = r1 + r6 + Math.max(r8 + r9, 0);
  const age = ageAt(input.birthday, year);
  if (pensionIn > 0 && age === null) notes.push("公的年金等の控除額は、本人の生年月日が分からないため65歳未満として計算しています。");
  const r7 = pensionIncome(pensionIn, (age ?? 0) >= 65, other);
  const r10 = Math.max(r7 + r8 + r9, 0);
  const r12 = r1 + r6 + r10;
  if (r12 < 0) notes.push("所得金額の合計がマイナスです（純損失）。損失申告（第四表）には対応していません。");
  if (salaryIn > 8_500_000) notes.push("給与の収入が850万円を超えています。所得金額調整控除（23歳未満の扶養親族・特別障害者がいる場合など）には対応していません。");
  const total = Math.max(r12, 0);

  // 所得控除
  const r13 = sum(input.socialInsurance.map((r) => r.amount));
  const r14 = sum(input.smallBusiness.map((r) => r.amount));
  const dependents = input.dependents.map((d) => ({ d, ...dependentDeduction(d, year) }));
  const under23 = rules.lifeUnder23 && dependents.some((x) => !x.d.familyEmployee && x.d.income <= DEPENDENT_LIMIT && x.age !== null && x.age < 23);
  const r15 = lifeInsuranceDeduction(input.life, under23);
  const r16 = quakeDeduction(input.quake);
  let r17 = 0;
  if (input.widow !== "none") {
    if (r12 > 5_000_000) notes.push(`合計所得金額が500万円を超えているため、${input.widow === "widow" ? "寡婦控除" : "ひとり親控除"}は受けられません。`);
    else r17 = input.widow === "widow" ? 270_000 : 350_000;
  }
  let student = 0;
  if (input.student) {
    if (r12 > rules.studentLimit) notes.push(`合計所得金額が${rules.studentLimit / 10_000}万円を超えているため、勤労学生控除は受けられません。`);
    else student = 270_000;
  }
  const spouse = spouseDeduction(input.spouse, r12, year);
  // 障害者控除：本人・同一生計配偶者・扶養親族（16歳未満を含む）
  // 同一生計配偶者・扶養親族には、事業専従者は入らない
  const sameHousehold = input.spouse && !input.spouse.familyEmployee && input.spouse.income <= DEPENDENT_LIMIT ? [input.spouse] : [];
  const disabled = [
    disabilityAmount(input.disability, false),
    ...[...sameHousehold, ...input.dependents.filter((d) => !d.familyEmployee && d.income <= DEPENDENT_LIMIT)].map((d) => disabilityAmount(d.disability, d.cohabiting)),
  ];
  const r19 = student + sum(disabled);
  const r23 = sum(dependents.filter((x) => x.kind !== "specificRelative").map((x) => x.amount));
  const r24 = sum(dependents.filter((x) => x.kind === "specificRelative").map((x) => x.amount));
  const r25 = basicDeduction(r12, rules.year);
  const r26 = r13 + r14 + r15 + r16 + r17 + r19 + spouse.amount + r23 + r24 + r25;
  const r28 = medicalDeduction(input.medical, total);
  const r29 = donationDeduction(sum(input.donations.map((d) => d.amount)), total);
  const r30 = r26 + r28 + r29;

  // 税金の計算
  const r31 = Math.max(floorTo(r12 - r30, 1000), 0);
  const r32 = incomeTaxOn(r31);
  const r35 = Math.min(input.housingLoan, r32);
  const r42 = r32 - r35;
  const r44 = r42;
  const r45 = Math.floor((r44 * 21) / 1000);
  const r46 = r44 + r45;
  const withholding = [
    ...input.businessWithholding.map((r) => ({ kind: "事業（営業等）", ...r })),
    ...input.salaries.map((r) => ({ kind: "給与", ...r })),
    ...input.pensions.map((r) => ({ kind: "雑（公的年金等）", ...r })),
    ...input.misc.map((r) => ({ kind: r.kind === "business" ? "雑（業務）" : "雑（その他）", item: r.item, payer: r.payer, payerId: r.payerId, income: r.income, withheld: r.withheld })),
  ];
  const r49 = sum(withholding.map((r) => r.withheld));
  const diff = r46 - r49;
  const r50 = diff > 0 ? floorTo(diff, 100) : diff;
  const r51 = input.prepaid;
  const third = r50 - r51;
  const r52 = third > 0 ? floorTo(third, 100) : 0;
  const r53 = third < 0 ? -third : 0;

  if (biz.familySalary > 0 && [input.spouse, ...input.dependents].some((r) => r && !r.familyEmployee) && ![input.spouse, ...input.dependents].some((r) => r?.familyEmployee)) {
    notes.push("帳簿に専従者給与があります。事業専従者を配偶者・扶養親族の欄に入れているときは「専従者」に印を付けてください（配偶者控除・扶養控除の対象になりません）。");
  }
  const spouseLabel = spouse.kind === "special" ? "配偶者特別控除" : spouse.elderly ? "配偶者控除（老人控除対象配偶者）" : "配偶者控除";
  const rows: IncomeTaxRow[] = [
    { no: "", label: "収入金額等", value: null, head: true },
    { no: "㋐", label: "事業（営業等）", value: biz.revenue, note: "決算書の売上（収入）金額（家事消費・雑収入を含む）" },
    { no: "㋔", label: "給与", value: salaryIn },
    { no: "㋕", label: "雑（公的年金等）", value: pensionIn },
    { no: "㋖", label: "雑（業務）", value: miscBizIn },
    { no: "㋗", label: "雑（その他）", value: miscOtherIn },
    { no: "", label: "所得金額等", value: null, head: true },
    { no: "①", label: "事業（営業等）", value: r1, note: white ? "決算書の所得金額" : `青色申告特別控除 ${blue.toLocaleString()}円を差し引いた額` },
    { no: "⑥", label: "給与", value: r6, note: `給与所得控除後の金額（${reiwaYear(rules.year)}）` },
    { no: "⑦", label: "雑（公的年金等）", value: r7, note: pensionIn ? `公的年金等控除（${(age ?? 0) >= 65 ? "65歳以上" : "65歳未満"}）後の金額` : undefined },
    { no: "⑧", label: "雑（業務）", value: r8 },
    { no: "⑨", label: "雑（その他）", value: r9 },
    { no: "⑩", label: "⑦から⑨までの計", value: r10, note: r7 + r8 + r9 < 0 ? "雑所得の損失はほかの所得から差し引けないので 0" : undefined },
    { no: "⑫", label: "合計", value: r12, key: "total" },
    { no: "", label: "所得から差し引かれる金額", value: null, head: true },
    { no: "⑬", label: "社会保険料控除", value: r13 },
    { no: "⑭", label: "小規模企業共済等掛金控除", value: r14 },
    { no: "⑮", label: "生命保険料控除", value: r15, note: under23 && input.life.newLife ? "23歳未満の扶養親族がいるため、新生命保険料は上限6万円で計算" : undefined },
    { no: "⑯", label: "地震保険料控除", value: r16 },
    { no: "⑰⑱", label: input.widow === "single_parent" ? "ひとり親控除" : input.widow === "widow" ? "寡婦控除" : "寡婦、ひとり親控除", value: r17 },
    { no: "⑲⑳", label: "勤労学生、障害者控除", value: r19 },
    { no: "㉑㉒", label: spouseLabel, value: spouse.amount },
    { no: "㉓", label: "扶養控除", value: r23 },
    { no: "㉔", label: "特定親族特別控除", value: r24 },
    { no: "㉕", label: "基礎控除", value: r25, note: `${reiwaYear(rules.year)}（合計所得金額に応じた額）` },
    { no: "㉖", label: "⑬から㉕までの計", value: r26 },
    { no: "㉘", label: input.medical.kind === "self" ? "医療費控除（セルフメディケーション税制）" : "医療費控除", value: r28 },
    { no: "㉙", label: "寄附金控除", value: r29 },
    { no: "㉚", label: "合計（㉖＋㉗＋㉘＋㉙）", value: r30 },
    { no: "", label: "税金の計算", value: null, head: true },
    { no: "㉛", label: "課税される所得金額（⑫－㉚）", value: r31, note: "千円未満切り捨て" },
    { no: "㉜", label: "上の㉛に対する税額", value: r32 },
    { no: "㉟", label: "住宅借入金等特別控除", value: r35 },
    { no: "㊷", label: "差引所得税額", value: r42 },
    { no: "㊹", label: "再差引所得税額（基準所得税額）", value: r44 },
    { no: "㊺", label: "復興特別所得税額（㊹×2.1%）", value: r45 },
    { no: "㊻", label: "所得税及び復興特別所得税の額（㊹＋㊺）", value: r46 },
    { no: "㊾", label: "源泉徴収税額", value: r49, note: "第二表の所得の内訳の合計" },
    { no: "㊿", label: diff >= 0 ? "申告納税額（㊻－㊾）" : "申告納税額（㊻－㊾。還付）", value: r50, note: diff > 0 ? "百円未満切り捨て" : undefined },
    { no: fieldNo(51), label: "予定納税額（第1期分・第2期分）", value: r51 },
    { no: fieldNo(52), label: "第3期分の税額：納める税金", value: r52, key: "pay" },
    { no: fieldNo(53), label: "第3期分の税額：還付される税金", value: r53, key: "refund" },
    { no: "", label: "その他", value: null, head: true },
    { no: fieldNo(56), label: "公的年金等以外の合計所得金額", value: pensionIn ? other : 0 },
    { no: fieldNo(57), label: "配偶者の合計所得金額", value: input.spouse && spouse.kind ? input.spouse.income : 0 },
    { no: fieldNo(58), label: "専従者給与（控除）額の合計額", value: biz.familySalary },
    { no: fieldNo(59), label: "青色申告特別控除額", value: blue },
    { no: fieldNo(60), label: "雑所得・一時所得等の源泉徴収税額の合計額", value: sum([...input.pensions, ...input.misc].map((r) => r.withheld)) },
  ];

  const relatives = [
    ...(input.spouse ? [{ ...input.spouse, kind: spouse.kind ? spouseLabel : input.spouse.familyEmployee ? "対象外（事業専従者）" : "対象外（所得が多い）" }] : []),
    ...dependents.map((x) => ({ ...x.d, kind: DEPENDENT_KIND_LABEL[x.kind] })),
  ].map((r) => ({ name: r.name, relation: r.relation, birthday: r.birthday, kind: r.kind, disability: r.disability, cohabiting: r.cohabiting }));

  return {
    rows,
    second: {
      withholding: withholding.filter((r) => r.income || r.withheld),
      socialInsurance: input.socialInsurance, smallBusiness: input.smallBusiness, life: input.life, quake: input.quake, donations: input.donations, relatives,
    },
    totalIncome: r12,
    balance: r52 - r53,
    notes,
  };
};
