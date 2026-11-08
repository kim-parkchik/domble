/**
 * 給与（純粋関数）
 * 給与の計算（源泉徴収税額表・年末調整・源泉徴収票・法定調書）は給与計算ソフトで行い、domble はその結果を帳簿にして使う
 *  - 給与の CSV：1行 = 1人の1回の支給（支給日・区分・氏名・総支給額・通勤手当・社会保険料・所得税・住民税・その他の控除・差引支給額）。
 *    見出しの名前で列を探し（ほかの給与ソフトの CSV は列を選び直せる）、1行を1つの仕訳にする（payrollEntryLines）
 *  - 決算書の給料賃金・専従者給与の内訳：人ごとの賞与・源泉徴収税額・従事月数を帳簿から（payrollFigures）
 *  - 源泉所得税の納付：期間（毎月／納期の特例）ごとの預かった額・期限・納めたか、納付書（所得税徴収高計算書）に書く数字（withholdingPeriods）。
 *    給与・賞与・税理士等の報酬は「給与所得・退職所得等」の納付書（納期の特例あり）、それ以外の報酬・料金（原稿料・デザイン料など）は
 *    「報酬・料金等」の納付書で、いつも支払った月の翌月10日まで（国税庁 No.2505）
 * 人は、仕訳の取引先（無ければ給料賃金の補助科目）で分ける（決算書の内訳と同じ。lib/statements.ts の payeeBreakdown）
 */
import type { Account, Counterparty, JournalLine } from "./types";
import type { FlatLine } from "./accounting";
import { parseCsv, unguardCell } from "./csv";
import { normName } from "./counterparty";
import { parseImportDate } from "./journalImport";
import { parseStatementAmount } from "./bankImport";
import { nextWeekday } from "./deadlines";

/** 科目（と補助科目） */
export interface AccountRef {
  account_id: number;
  sub_account_id: number | null;
}

/** 給与の設定（事業者ごと） */
export interface PayrollSettings {
  /** 預かった源泉所得税・住民税・社会保険料（本人負担分）・その他の控除の科目 */
  tax: AccountRef | null;
  resident: AccountRef | null;
  social: AccountRef | null;
  other: AccountRef | null;
  /** 差引支給額を払う口座 */
  bank: AccountRef | null;
  /** 通勤手当（非課税）の科目（既定は旅費交通費） */
  commute: number | null;
  /** 専従者給与で記帳する人（給与の CSV の氏名） */
  family: string[];
  /** 源泉所得税の納期の特例の承認を受けているか */
  special: boolean;
  /** 報酬・料金等で預かった源泉所得税の科目（任意。給与と別の補助科目にするとき。無ければ tax で数える） */
  feeTax: AccountRef | null;
  /** 税理士等の報酬の取引先（税理士・弁護士・司法書士など。所得税法204条1項2号。給与と同じ納付書で、納期の特例も使える） */
  advisors: number[];
}

export const EMPTY_PAYROLL_SETTINGS: PayrollSettings = {
  tax: null, resident: null, social: null, other: null, bank: null, commute: null, family: [], special: false, feeTax: null, advisors: [],
};

const sameRef = (a: AccountRef | null, b: AccountRef | null) => !!a && !!b && a.account_id === b.account_id && (a.sub_account_id ?? null) === (b.sub_account_id ?? null);

/** 保存してある設定（JSON）を読む。読めなければ空 */
export const parsePayrollSettings = (json: string | null | undefined): PayrollSettings => {
  if (!json) return { ...EMPTY_PAYROLL_SETTINGS };
  try {
    const v = JSON.parse(json) as Partial<PayrollSettings>;
    const ref = (r: unknown): AccountRef | null =>
      r && typeof r === "object" && Number.isInteger((r as AccountRef).account_id)
        ? { account_id: (r as AccountRef).account_id, sub_account_id: (r as AccountRef).sub_account_id ?? null } : null;
    return {
      tax: ref(v.tax), resident: ref(v.resident), social: ref(v.social), other: ref(v.other), bank: ref(v.bank),
      commute: Number.isInteger(v.commute) ? v.commute! : null,
      family: Array.isArray(v.family) ? v.family.filter((x): x is string => typeof x === "string" && !!x.trim()) : [],
      special: v.special === true,
      feeTax: ref(v.feeTax),
      advisors: Array.isArray(v.advisors) ? [...new Set(v.advisors.filter((x): x is number => Number.isInteger(x)))] : [],
    };
  } catch {
    return { ...EMPTY_PAYROLL_SETTINGS };
  }
};

/** 設定の問題（無ければ null）。源泉所得税の科目は、ほかの控除と分けておく（納付と決算書の源泉徴収税額に使うため） */
export const payrollSettingsProblem = (s: PayrollSettings): string | null => {
  if (s.tax && [s.resident, s.social, s.other].some((r) => sameRef(r, s.tax))) {
    return "源泉所得税は、住民税・社会保険料・その他の控除と別の科目（預り金の補助科目など）にしてください";
  }
  if (s.bank && [s.tax, s.resident, s.social, s.other].some((r) => sameRef(r, s.bank))) return "支払う口座は、預かる科目と別にしてください";
  if (s.feeTax && sameRef(s.feeTax, s.tax)) return "報酬・料金等の源泉所得税を給与と同じ科目にするときは、決めなくてかまいません（「使わない」にしてください）";
  if (s.feeTax && [s.resident, s.social, s.other, s.bank].some((r) => sameRef(r, s.feeTax))) {
    return "報酬・料金等の源泉所得税は、住民税・社会保険料・その他の控除・支払う口座と別の科目にしてください";
  }
  return null;
};

// ────────────────────────────────────────────
// 給与の CSV
// ────────────────────────────────────────────

/** 給与の CSV の見出し（domble の形。ほかの給与ソフトの見出しは PAYROLL_COLUMNS の言い換えで探す） */
export const PAYROLL_CSV_HEADER = [
  "支給日", "区分", "氏名", "総支給額", "通勤手当（非課税）", "健康保険料", "介護保険料", "子ども・子育て支援金", "厚生年金保険料", "雇用保険料",
  "社会保険料", "所得税", "住民税", "その他の控除", "差引支給額",
];

export const PAYROLL_COLUMNS = {
  date: ["支給日", "支払日", "支給年月日", "支払年月日"],
  kind: ["区分", "種類", "給与・賞与"],
  name: ["氏名", "名前", "従業員名", "社員名", "スタッフ名"],
  gross: ["総支給額", "総支給", "支給合計", "支給額合計", "総支給金額"],
  commute: ["通勤手当（非課税）", "通勤手当(非課税)", "非課税通勤手当", "通勤手当", "通勤費"],
  health: ["健康保険料", "健康保険"],
  nursing: ["介護保険料", "介護保険"],
  child: ["子ども・子育て支援金", "子ども子育て支援金", "子育て支援金"],
  pension: ["厚生年金保険料", "厚生年金"],
  employment: ["雇用保険料", "雇用保険"],
  social: ["社会保険料", "社会保険料合計", "社会保険料計"],
  tax: ["所得税", "源泉所得税"],
  resident: ["住民税", "特別徴収住民税"],
  other: ["その他の控除", "その他控除", "控除その他"],
  net: ["差引支給額", "差引支給", "差引支給金額", "手取り", "振込額"],
} as const;
export type PayrollCol = keyof typeof PAYROLL_COLUMNS;
export type PayrollColumnMap = Record<PayrollCol, number>;
export const PAYROLL_REQUIRED: PayrollCol[] = ["date", "name", "gross", "net"];
export const PAYROLL_COLUMN_LABELS: Record<PayrollCol, string> = {
  date: "支給日", kind: "区分（給与・賞与）", name: "氏名", gross: "総支給額", commute: "通勤手当（非課税）", health: "健康保険料", nursing: "介護保険料",
  child: "子ども・子育て支援金", pension: "厚生年金保険料", employment: "雇用保険料", social: "社会保険料（合計）", tax: "所得税", resident: "住民税",
  other: "その他の控除", net: "差引支給額",
};

/** 見出しの名前から列を推測する（無ければ -1） */
export const guessPayrollColumns = (header: string[]): PayrollColumnMap => {
  const h = header.map((x) => normName(x));
  const map = {} as PayrollColumnMap;
  for (const k of Object.keys(PAYROLL_COLUMNS) as PayrollCol[]) map[k] = h.findIndex((v) => PAYROLL_COLUMNS[k].some((n) => normName(n) === v));
  return map;
};

export type PayKind = "salary" | "bonus";
export const PAY_KIND_LABEL: Record<PayKind, string> = { salary: "給与", bonus: "賞与" };

/** 1人の1回の支給 */
export interface PayrollRow {
  /** CSV の行番号（1 = 見出し） */
  row: number;
  date: string;
  kind: PayKind;
  name: string;
  gross: number;
  /** 通勤手当（非課税）。総支給額に含む */
  commute: number;
  /** 社会保険料（本人負担分の合計） */
  social: number;
  tax: number;
  resident: number;
  other: number;
  net: number;
}

export interface PayrollIssue {
  row: number;
  message: string;
}

export interface PayrollParse {
  header: string[];
  map: PayrollColumnMap;
  rows: PayrollRow[];
  issues: PayrollIssue[];
}

const kindOf = (raw: string): PayKind | null => {
  const s = raw.normalize("NFKC").trim();
  if (!s || /給与|給料|月給|salary/i.test(s)) return "salary";
  if (/賞与|ボーナス|bonus/i.test(s)) return "bonus";
  return null;
};

/** 給与の CSV を読む（map = 列の対応。無ければ見出しから推測）。金額の空欄は 0 */
export const parsePayrollCsv = (text: string, map?: PayrollColumnMap): PayrollParse => {
  const table = parseCsv(text).map((r) => r.map((c) => unguardCell(c)));
  const header = table[0] ?? [];
  const m = map ?? guessPayrollColumns(header);
  const issues: PayrollIssue[] = [];
  const missing = PAYROLL_REQUIRED.filter((k) => !(m[k] >= 0));
  if (missing.length) {
    return { header, map: m, rows: [], issues: [{ row: 1, message: `${missing.map((k) => PAYROLL_COLUMN_LABELS[k]).join("・")}の列が見つかりません（列の対応で選んでください）` }] };
  }
  const rows: PayrollRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const row = i + 2;
    if (cells.every((c) => !c.trim())) return;
    const cell = (k: PayrollCol) => (m[k] >= 0 ? (cells[m[k]] ?? "").trim() : "");
    const problems: string[] = [];
    const amount = (k: PayrollCol) => {
      const v = cell(k);
      if (!v) return 0;
      const n = parseStatementAmount(v);
      if (n === null || !Number.isFinite(n) || n < 0) {
        problems.push(`${PAYROLL_COLUMN_LABELS[k]}「${v}」が読めません`);
        return 0;
      }
      return n;
    };
    const date = parseImportDate(cell("date"));
    if (!date) problems.push(`支給日「${cell("date")}」が読めません`);
    const kind = kindOf(cell("kind"));
    if (!kind) problems.push(`区分「${cell("kind")}」は「給与」か「賞与」にしてください`);
    const name = cell("name");
    if (!name) problems.push("氏名がありません");
    const gross = amount("gross");
    const commute = amount("commute");
    // 社会保険料は、内訳の列があれば内訳の合計、無ければ合計の列
    const parts = (["health", "nursing", "child", "pension", "employment"] as const).map((k) => amount(k));
    const hasParts = (["health", "nursing", "child", "pension", "employment"] as const).some((k) => m[k] >= 0);
    const social = hasParts ? parts.reduce((t, x) => t + x, 0) : amount("social");
    const tax = amount("tax");
    const resident = amount("resident");
    const other = amount("other");
    const net = amount("net");
    if (gross <= 0) problems.push("総支給額がありません");
    if (commute > gross) problems.push("通勤手当が総支給額より多くなっています");
    const deductions = social + tax + resident + other;
    if (!problems.length && gross - deductions !== net) {
      problems.push(`差引支給額 ${net.toLocaleString()}円が、総支給額 − 控除の合計（${(gross - deductions).toLocaleString()}円）と合いません`);
    }
    if (problems.length) issues.push({ row, message: problems.join("。") });
    else rows.push({ row, date: date!, kind: kind!, name, gross, commute, social, tax, resident, other, net });
  });
  if (!rows.length && !issues.length) issues.push({ row: 1, message: "給与の行がありません" });
  return { header, map: m, rows, issues };
};

/** 氏名の比べ方（全角半角・空白の違いは無視） */
export const sameName = (a: string, b: string) => normName(a) === normName(b);

/** 給与の CSV の氏名に当たる取引先（無ければ undefined） */
export const counterpartyOfName = (counterparties: Counterparty[], name: string) => counterparties.find((c) => sameName(c.name, name));

/**
 * 1人の1回の支給を仕訳の明細にする（問題があればメッセージ）
 *  借方：給料賃金（専従者は専従者給与）＝ 総支給額 − 通勤手当、通勤手当の科目 ＝ 通勤手当（インボイス区分は帳簿のみ保存の特例）
 *  貸方：社会保険料・源泉所得税・住民税・その他の控除の科目、支払う口座 ＝ 差引支給額
 */
export const payrollEntryLines = (r: PayrollRow, s: PayrollSettings, salaryAccountId: number): JournalLine[] | string => {
  const memo = `${PAY_KIND_LABEL[r.kind]}（${r.name}）`;
  const need: [number, AccountRef | null, string][] = [
    [r.social, s.social, "社会保険料"], [r.tax, s.tax, "源泉所得税"], [r.resident, s.resident, "住民税"], [r.other, s.other, "その他の控除"], [r.net, s.bank, "支払う口座"],
  ];
  const missing = need.filter(([amount, ref]) => amount > 0 && !ref).map(([, , label]) => label);
  if (missing.length) return `給与の設定で、${missing.join("・")}の科目を決めてください`;
  if (r.commute > 0 && !s.commute) return "給与の設定で、通勤手当の科目を決めてください";
  const debits: Omit<JournalLine, "row_no">[] = [
    { side: "debit" as const, account_id: salaryAccountId, sub_account_id: null, amount: r.gross - r.commute, memo },
    // 通勤手当は課税仕入れ（本則課税の年は帳簿のみ保存の特例。課税事業者でない年は税区分ごと外れる）
    ...(r.commute > 0 ? [{ side: "debit" as const, account_id: s.commute!, sub_account_id: null, amount: r.commute, memo: `通勤手当（${r.name}）`, invoice_kind: "book_travel" as const }] : []),
  ].filter((l) => l.amount > 0);
  const credits = need
    .filter(([amount]) => amount > 0)
    .map(([amount, ref]) => ({ side: "credit" as const, account_id: ref!.account_id, sub_account_id: ref!.sub_account_id, amount, memo }));
  return [...debits.map((l, i) => ({ ...l, row_no: i + 1 })), ...credits.map((l, i) => ({ ...l, row_no: i + 1 }))];
};

/** 同じ人・同じ支給日・同じ総支給額の給与が帳簿にあるか（取引先と、給料賃金・専従者給与・通勤手当の借方の合計で比べる） */
export const payrollDuplicate = (r: PayrollRow, counterpartyId: number | null, existing: FlatLine[], salaryAccountIds: number[], commuteId: number | null) => {
  if (!counterpartyId) return false;
  const byEntry = new Map<number, FlatLine[]>();
  for (const l of existing) if (l.date === r.date && l.counterparty_id === counterpartyId) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  const accounts = new Set([...salaryAccountIds, ...(commuteId ? [commuteId] : [])]);
  return [...byEntry.values()].some((ls) => ls.filter((l) => l.side === "debit" && accounts.has(l.account_id)).reduce((t, l) => t + l.amount, 0) === r.gross);
};

// ────────────────────────────────────────────
// 決算書の内訳（人ごとの賞与・源泉徴収税額・従事月数）
// ────────────────────────────────────────────

export interface PayFigure {
  /** 賞与（給与の CSV で賞与として取り込んだ仕訳の給料賃金） */
  bonus: number;
  /** 源泉徴収税額（同じ仕訳で預かった源泉所得税） */
  tax: number;
  /** 給与を払った月の数（賞与を除く。従事月数の目安） */
  months: number;
}

const lineRef = (l: Pick<FlatLine, "account_id" | "sub_account_id">, ref: AccountRef | null) =>
  !!ref && l.account_id === ref.account_id && (l.sub_account_id ?? null) === (ref.sub_account_id ?? null);
const payeeKey = (l: FlatLine) => (l.counterparty_id ? `cp:${l.counterparty_id}` : l.sub_account_id ? `sub:${l.sub_account_id}` : "none");
const groupEntries = (lines: FlatLine[]) => {
  const m = new Map<number, FlatLine[]>();
  for (const l of lines) m.set(l.entry_id, [...(m.get(l.entry_id) ?? []), l]);
  return m;
};
/** 仕訳の中の、預かった源泉所得税（貸方 − 借方） */
const withheldIn = (ls: FlatLine[], tax: AccountRef | null) =>
  ls.filter((l) => lineRef(l, tax)).reduce((t, l) => t + (l.side === "credit" ? l.amount : -l.amount), 0);

/**
 * 人ごとの賞与・源泉徴収税額・給与を払った月の数（鍵は決算書の内訳と同じ cp:取引先ID / sub:補助科目ID / none）
 * 源泉徴収税額は、1つの仕訳に1人の給与だけがあるときに数える（何人分もまとめた仕訳は、人ごとに分けられないので数えない）
 */
export const payrollFigures = (
  lines: FlatLine[], salaryAccountId: number, tax: AccountRef | null, bonusEntryIds: ReadonlySet<number>, excludeEntryIds: number[] = [],
): Map<string, PayFigure> => {
  const exclude = new Set(excludeEntryIds);
  const out = new Map<string, PayFigure & { monthSet: Set<string> }>();
  for (const [id, ls] of groupEntries(lines)) {
    if (exclude.has(id)) continue;
    const pay = ls.filter((l) => l.account_id === salaryAccountId && l.side === "debit");
    if (!pay.length) continue;
    const keys = [...new Set(pay.map(payeeKey))];
    for (const l of pay) {
      const f = out.get(payeeKey(l)) ?? { bonus: 0, tax: 0, months: 0, monthSet: new Set<string>() };
      if (bonusEntryIds.has(id)) f.bonus += l.amount;
      else f.monthSet.add(l.date.slice(0, 7));
      out.set(payeeKey(l), f);
    }
    if (keys.length === 1) out.get(keys[0])!.tax += withheldIn(ls, tax);
  }
  return new Map([...out].map(([k, f]) => [k, { bonus: f.bonus, tax: f.tax, months: f.monthSet.size }]));
};

// ────────────────────────────────────────────
// 源泉所得税の納付
// ────────────────────────────────────────────

/** 納付書の種類：給与所得・退職所得等（給与・賞与・税理士等の報酬。納期の特例あり）／報酬・料金等（それ以外の報酬・料金。いつも翌月10日） */
export type WithholdingSlip = "salary" | "fees";
export const SLIP_NAME: Record<WithholdingSlip, string> = { salary: "給与所得・退職所得等の所得税徴収高計算書", fees: "報酬・料金等の所得税徴収高計算書" };

/** 1回の支払い（税理士等の報酬・報酬・料金等の内訳） */
export interface WithholdingItem {
  date: string;
  counterparty_id: number | null;
  /** 支払った額（源泉徴収する前。仕訳の借方の合計で、消費税を含む） */
  amount: number;
  tax: number;
}

/** 納付書の1つの区分（俸給・給料等／賞与／税理士等の報酬／報酬・料金等）の数字 */
export interface WithholdingClass {
  /** 支払年月日（最初と最後。同じなら1つ） */
  firstDate: string | null;
  lastDate: string | null;
  /** 人員（実人員。納期の特例では月ごとの実人員の合計） */
  people: number;
  /** 支給額（給与・賞与は給料賃金・専従者給与の額で、非課税の通勤手当は別の科目なので入らない。報酬は源泉徴収する前の支払った額） */
  amount: number;
  tax: number;
  /** 報酬の支払いの内訳（給与・賞与では空） */
  items: WithholdingItem[];
}

export interface WithholdingPeriod {
  slip: WithholdingSlip;
  /** 支払った月の範囲（1〜12） */
  fromMonth: number;
  toMonth: number;
  /** 納付の期限（土日・祝日なら次の平日） */
  due: string;
  salary: WithholdingClass;
  bonus: WithholdingClass;
  /** 税理士等の報酬（給与の設定で選んだ取引先。給与所得・退職所得等の納付書の「税理士等の報酬」欄） */
  advisor: WithholdingClass;
  /** 報酬・料金等（原稿料・デザイン料など。slip が fees の期間だけ） */
  fees: WithholdingClass;
  /** 預かった源泉所得税の合計 */
  total: number;
  /** 納めた額（期首の未納と、期限の早い期間から順に当てる） */
  paid: number;
  status: "none" | "paid" | "partial" | "unpaid";
}

const emptyClass = (): WithholdingClass => ({ firstDate: null, lastDate: null, people: 0, amount: 0, tax: 0, items: [] });

export interface WithholdingOptions {
  /** 給料賃金・専従者給与の科目 */
  salaryAccountIds: number[];
  /** 給与の設定のうち、源泉所得税の科目（報酬・料金等を分けていればその科目も）・税理士等の取引先・納期の特例 */
  settings: Pick<PayrollSettings, "tax" | "feeTax" | "advisors" | "special">;
  /** 給与の CSV で賞与として取り込んだ仕訳 */
  bonusEntryIds: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  /** その年の初めの未納（源泉所得税の科目の期首残高。報酬・料金等の科目を分けていればその期首残高も）。納めた額はまずここに当てる */
  carried?: { tax: number; feeTax: number };
}

/** 給与以外で源泉所得税を預かった仕訳の取引先（給与の設定で税理士等を選ぶ候補） */
export const withholdingPayees = (lines: FlatLine[], salaryAccountIds: number[], s: Pick<PayrollSettings, "tax" | "feeTax">): number[] => {
  const out = new Set<number>();
  for (const [, ls] of groupEntries(lines)) {
    if (ls.some((l) => salaryAccountIds.includes(l.account_id) && l.side === "debit")) continue;
    if (withheldIn(ls, s.tax) + withheldIn(ls, s.feeTax) <= 0) continue;
    const cp = entryPayee(ls, s);
    if (cp !== null) out.add(cp);
  }
  return [...out];
};

/** 報酬の仕訳の取引先（源泉所得税の行 → ほかの行の順に探す） */
const entryPayee = (ls: FlatLine[], s: Pick<PayrollSettings, "tax" | "feeTax">) =>
  ls.find((l) => (lineRef(l, s.tax) || lineRef(l, s.feeTax)) && l.counterparty_id)?.counterparty_id ?? ls.find((l) => l.counterparty_id)?.counterparty_id ?? null;

/**
 * その年の源泉所得税の納付の期間。
 *  - 給与所得・退職所得等（給料賃金・専従者給与の仕訳と、税理士等の取引先への報酬）：毎月なら翌月10日まで、納期の特例なら1〜6月分は7月10日・7〜12月分は翌年1月20日まで
 *  - 報酬・料金等（給与以外で源泉所得税を預かった仕訳のうち、税理士等の取引先でないもの・取引先の無いもの）：納期の特例があっても、支払った月の翌月10日まで
 * 納めた額（源泉所得税の科目の借方で、給与の仕訳でないもの）は科目ごとに、その年の初めの未納 → 期限の早い期間の順に当てる
 * （同じ科目で納めた額は、どちらの納付書の分かを仕訳から分けられないため）
 * @param lines その年と翌年の仕訳（翌年の納付も見る）
 */
export const withholdingPeriods = (lines: FlatLine[], year: number, o: WithholdingOptions): WithholdingPeriod[] => {
  const { tax, feeTax, advisors, special } = o.settings;
  const due = (date: string) => nextWeekday(date, o.holidays);
  const monthlyDue = (m: number) => due(m === 12 ? `${year + 1}-01-10` : `${year}-${String(m + 1).padStart(2, "0")}-10`);
  const make = (slip: WithholdingSlip, from: number, to: number, d: string): WithholdingPeriod => ({
    slip, fromMonth: from, toMonth: to, due: d, salary: emptyClass(), bonus: emptyClass(), advisor: emptyClass(), fees: emptyClass(), total: 0, paid: 0, status: "none",
  });
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const salaryPeriods = special
    ? [make("salary", 1, 6, due(`${year}-07-10`)), make("salary", 7, 12, due(`${year + 1}-01-20`))]
    : months.map((m) => make("salary", m, m, monthlyDue(m)));
  const feePeriods = months.map((m) => make("fees", m, m, monthlyDue(m)));
  const periodOf = (ps: WithholdingPeriod[], date: string) => ps.find((p) => Number(date.slice(5, 7)) >= p.fromMonth && Number(date.slice(5, 7)) <= p.toMonth)!;
  /** 期間ごとの、科目ごとに預かった額（[源泉所得税の科目, 報酬・料金等の科目]） */
  const parts = new Map<WithholdingPeriod, [number, number]>([...salaryPeriods, ...feePeriods].map((p) => [p, [0, 0]]));
  // 区分・月ごとの実人員（納期の特例では月ごとの実人員を足す）
  const people = new Map<WithholdingClass, Map<string, Set<string>>>();
  const count = (c: WithholdingClass, date: string, key: string) => {
    const byMonth = people.get(c) ?? new Map<string, Set<string>>();
    const set = byMonth.get(date.slice(0, 7)) ?? new Set<string>();
    set.add(key);
    byMonth.set(date.slice(0, 7), set);
    people.set(c, byMonth);
    if (!c.firstDate || date < c.firstDate) c.firstDate = date;
    if (!c.lastDate || date > c.lastDate) c.lastDate = date;
  };
  const add = (p: WithholdingPeriod, onTax: number, onFee: number) => {
    const x = parts.get(p)!;
    x[0] += onTax;
    x[1] += onFee;
    p.total += onTax + onFee;
  };
  const payments = [0, 0];
  const yearStart = `${year}-01-01`;
  for (const [id, ls] of groupEntries(lines)) {
    const date = ls[0].date;
    const onTax = withheldIn(ls, tax);
    const onFee = feeTax ? withheldIn(ls, feeTax) : 0;
    const pay = ls.filter((l) => o.salaryAccountIds.includes(l.account_id) && l.side === "debit");
    // 納付：源泉所得税の科目の借方で、給与の仕訳でないもの（その年の初めから）
    if (!pay.length && date >= yearStart) {
      if (onTax < 0) payments[0] += -onTax;
      if (onFee < 0) payments[1] += -onFee;
    }
    if (date.slice(0, 4) !== String(year)) continue;
    if (!pay.length) {
      if (Math.max(0, onTax) + Math.max(0, onFee) <= 0) continue;
      const cp = entryPayee(ls, o.settings);
      const isAdvisor = cp !== null && advisors.includes(cp);
      const p = periodOf(isAdvisor ? salaryPeriods : feePeriods, date);
      const c = isAdvisor ? p.advisor : p.fees;
      const withheld = Math.max(0, onTax) + Math.max(0, onFee);
      const amount = ls.filter((l) => l.side === "debit" && !lineRef(l, tax) && !lineRef(l, feeTax)).reduce((t, l) => t + l.amount, 0);
      c.amount += amount;
      c.tax += withheld;
      c.items.push({ date, counterparty_id: cp, amount, tax: withheld });
      add(p, Math.max(0, onTax), Math.max(0, onFee));
      count(c, date, cp !== null ? `cp:${cp}` : `entry:${id}`);
      continue;
    }
    const p = periodOf(salaryPeriods, date);
    const c = o.bonusEntryIds.has(id) ? p.bonus : p.salary;
    c.amount += pay.reduce((t, l) => t + l.amount, 0);
    c.tax += onTax;
    add(p, onTax, 0);
    for (const l of pay) count(c, date, payeeKey(l));
  }
  for (const [c, byMonth] of people) c.people = [...byMonth.values()].reduce((t, set) => t + set.size, 0);
  // 納めた額を、科目ごとに期首の未納 → 期限の早い期間の順に当てる（期限が同じなら給与所得・退職所得等から）
  const byDue = [...salaryPeriods, ...feePeriods].sort((a, b) => a.due.localeCompare(b.due) || (a.slip === b.slip ? a.fromMonth - b.fromMonth : a.slip === "salary" ? -1 : 1));
  const carried = [o.carried?.tax ?? 0, o.carried?.feeTax ?? 0];
  for (const i of [0, 1]) {
    let left = Math.max(0, payments[i] - Math.max(0, carried[i]));
    for (const p of byDue) {
      const x = Math.min(parts.get(p)![i], left);
      p.paid += x;
      left -= x;
    }
  }
  for (const p of byDue) p.status = p.total <= 0 ? "none" : p.paid >= p.total ? "paid" : p.paid > 0 ? "partial" : "unpaid";
  return [...salaryPeriods, ...feePeriods];
};

/** 納付書の「年度」（会計年度：4月〜翌年3月。令和8年4月〜令和9年3月に納めるなら 508） */
export const fiscalYearCode = (date: string) => {
  const y = Number(date.slice(0, 4));
  const fy = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `5${String(fy - 2018).padStart(2, "0")}`;
};

/** 給料賃金・専従者給与の科目（事業所得・不動産所得） */
export const salaryAccountIdsOf = (accounts: Account[], codes: readonly string[]) => accounts.filter((a) => codes.includes(a.code)).map((a) => a.id);
