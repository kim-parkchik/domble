/**
 * 消費税の集計表と確認の一覧（純粋関数）
 *  - 対象は課税事業者の期間の、削除済みでない明細（税区分が入っているもの）。税区分の無い明細は「未設定」として確認に出す
 *  - 値引き・返品は区分を増やさず、貸借の側で判定する
 *      売上の区分：貸方 = 売上、借方 = 売上の返還
 *      貸倒れの区分：借方 = 貸倒れ、貸方 = 貸倒れの回収
 *      仕入の区分：借方 = 仕入、貸方 = 仕入の返還（家事按分の年末の振替もここ）
 *  - 対象外は、損益の科目のものだけ出す（現金・預金などの相手側まで並べると読めないため）
 *  - 消費税等の額は「参考」：税込の金額 × 税率 /（100 + 税率）の 1 円未満切り捨て。申告の計算（端数処理・国税と地方税の分け方）は別
 */
import type { Account, Counterparty, InvoiceKind, PurchaseUse, TaxCode, TaxStatus, TaxYear } from "./types";
import type { FlatLine } from "./accounting";
import { INVOICE_KINDS, TAX_CODES, TAX_STATUS_OPTIONS } from "../constants/tax";
import { deductionProblem, isImportCode, isPurchaseCode, isSalesCode, statusProblem, takesPurchaseUse, taxActiveOn, taxCodeDef, taxYearOf, transitionalRate } from "./tax";
import { mandatoryReason, methodProblem, type BaseSalesInfo } from "./baseSales";
import { INTERIM_KIND_LABEL, type InterimPlan } from "./taxInterim";
import type { InventoryAdjust } from "./taxReturn";
import { businessRateIn, type FixedAsset } from "./depreciation";
import { CODE } from "../constants/accounts";

export type TaxKind = "sales" | "salesReturn" | "badDebt" | "badDebtRecovered" | "purchase" | "purchaseReturn" | "other";

export const TAX_KIND_LABEL: Record<TaxKind, string> = {
  sales: "売上",
  salesReturn: "売上の返還（値引き・返品）",
  badDebt: "貸倒れ",
  badDebtRecovered: "貸倒れの回収",
  purchase: "仕入",
  purchaseReturn: "仕入の返還（値引き・返品・家事分）",
  other: "対象外",
};
const KIND_ORDER: TaxKind[] = ["sales", "salesReturn", "badDebt", "badDebtRecovered", "purchase", "purchaseReturn", "other"];

/** 明細の区分（貸借の側で判定） */
export const taxKindOf = (code: TaxCode, side: "debit" | "credit"): TaxKind => {
  if (code === "none") return "other";
  if (code === "baddebt10" || code === "baddebt8") return side === "debit" ? "badDebt" : "badDebtRecovered";
  if (taxCodeDef(code).group === "sales") return side === "credit" ? "sales" : "salesReturn";
  return side === "debit" ? "purchase" : "purchaseReturn";
};

/** 集計表の消費税等の欄：輸入は金額が国税の額そのもの、特定課税仕入れは税抜の額 × 10%、ほかは税込の額に含まれる額 */
const rowTax = (code: TaxCode, amount: number) =>
  isImportCode(code) ? amount : code === "reverse10" ? Math.floor(amount / 10) : includedTax(amount, taxCodeDef(code).rate);

/** 税込の金額に含まれる消費税等（参考。1 円未満切り捨て） */
export const includedTax = (amount: number, rate: number) => (rate > 0 ? Math.floor((amount * rate) / (100 + rate)) : 0);

export interface TaxSummaryRow {
  code: TaxCode;
  kind: TaxKind;
  /** インボイス区分（課税仕入だけ） */
  invoice: InvoiceKind | null;
  /** 経過措置で控除できる割合（%。経過措置の行だけ） */
  transitional: number | null;
  /** 簡易課税の事業区分（簡易課税の年の課税売上・返還の行だけ。0 = 区分が分からない） */
  businessClass: number | null;
  /** 用途区分（本則課税の年で課税売上割合が 95% 未満のときの課税仕入・返還の行だけ。unknown = 区分が無い＝共通対応として計算） */
  purchaseUse: PurchaseUse | "unknown" | null;
  /** 税込の金額 */
  amount: number;
  /** うち消費税等（参考） */
  tax: number;
  lines: number;
  /** 科目ごとの内訳（金額の多い順） */
  accounts: { account_id: number; amount: number; lines: number }[];
}

export interface TaxSummary {
  rows: TaxSummaryRow[];
  /** 課税売上割合（税抜・返還を差し引いた額）。分母が 0 なら null */
  ratio: { taxable: number; exportSales: number; nontax: number; value: number | null };
}

const isPL = (a: Account | undefined) => !!a && (a.category === "revenue" || a.category === "cogs" || a.category === "expense" || a.category === "special");
const codeOrder = (c: TaxCode) => TAX_CODES.findIndex((t) => t.code === c);
const invoiceOrder = (i: InvoiceKind | null) => (i ? INVOICE_KINDS.findIndex((k) => k.value === i) : -1);

/** 集計の対象：課税事業者の期間の、削除済みでない明細 */
const inScope = (lines: FlatLine[], taxYears: TaxYear[]) => lines.filter((l) => !l.is_deleted && taxActiveOn(taxYears, l.date));

export const buildTaxSummary = (lines: FlatLine[], accounts: Account[], taxYears: TaxYear[]): TaxSummary => {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const scoped = inScope(lines, taxYears);
  const rows = new Map<string, TaxSummaryRow>();
  for (const l of scoped) {
    if (!l.tax_code) continue;
    const kind = taxKindOf(l.tax_code, l.side);
    if (kind === "other" && !isPL(accountMap.get(l.account_id))) continue;
    const invoice = isPurchaseCode(l.tax_code) ? l.invoice_kind ?? "qualified" : null;
    const transitional = invoice === "transitional" ? transitionalRate(l.date) : null;
    const ty = taxYearOf(taxYears, Number(l.date.slice(0, 4)));
    const businessClass = ty.status === "simplified" && isSalesCode(l.tax_code) ? l.business_class ?? 0 : null;
    const purchaseUse = ty.status === "standard" && takesPurchaseUse(l.tax_code) ? l.purchase_use ?? "unknown" : null;
    const key = rowKeyOf({ code: l.tax_code, kind, invoice, transitional, businessClass, purchaseUse });
    const r = rows.get(key) ?? { code: l.tax_code, kind, invoice, transitional, businessClass, purchaseUse, amount: 0, tax: 0, lines: 0, accounts: [] };
    r.amount += l.amount;
    r.lines++;
    const a = r.accounts.find((x) => x.account_id === l.account_id);
    if (a) {
      a.amount += l.amount;
      a.lines++;
    } else r.accounts.push({ account_id: l.account_id, amount: l.amount, lines: 1 });
    rows.set(key, r);
  }
  let list = [...rows.values()];
  list.sort((x, y) =>
    KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || codeOrder(x.code) - codeOrder(y.code)
    || invoiceOrder(x.invoice) - invoiceOrder(y.invoice) || (y.transitional ?? 0) - (x.transitional ?? 0) || (x.businessClass ?? 0) - (y.businessClass ?? 0)
    || useOrder(x.purchaseUse) - useOrder(y.purchaseUse));

  // 課税売上割合（税抜。売上の返還を差し引く）
  const net = (code: TaxCode) =>
    list.filter((r) => r.code === code && (r.kind === "sales" || r.kind === "salesReturn"))
      .reduce((s, r) => s + (r.kind === "sales" ? r.amount : -r.amount), 0);
  const taxable = Math.floor((net("sales10") * 100) / 110) + Math.floor((net("sales8") * 100) / 108);
  const exportSales = net("export");
  const nontax = net("sales_nontax");
  const denom = taxable + exportSales + nontax;
  const value = denom > 0 ? (taxable + exportSales) / denom : null;
  // 用途区分は個別対応方式でだけ使うので、課税売上割合が 95% 未満のときだけ分けて出す
  if (value === null || value >= 0.95) list = mergeUses(list);
  return {
    rows: list.map((r) => ({ ...r, tax: rowTax(r.code, r.amount), accounts: r.accounts.sort((x, y) => y.amount - x.amount) })),
    ratio: { taxable, exportSales, nontax, value },
  };
};

const rowKeyOf = (r: Pick<TaxSummaryRow, "code" | "kind" | "invoice" | "transitional" | "businessClass" | "purchaseUse">) =>
  `${r.code}|${r.kind}|${r.invoice ?? ""}|${r.transitional ?? ""}|${r.businessClass ?? ""}|${r.purchaseUse ?? ""}`;
const USE_ORDER = ["taxable", "common", "unknown", "nontaxable"];
const useOrder = (u: TaxSummaryRow["purchaseUse"]) => (u ? USE_ORDER.indexOf(u) : -1);

/** 用途区分で分けた行をまとめ直す（並び順は保つ） */
const mergeUses = (list: TaxSummaryRow[]) => {
  const out = new Map<string, TaxSummaryRow>();
  for (const r of list) {
    const key = rowKeyOf({ ...r, purchaseUse: null });
    const m = out.get(key);
    if (!m) {
      out.set(key, { ...r, purchaseUse: null, accounts: r.accounts.map((a) => ({ ...a })) });
      continue;
    }
    m.amount += r.amount;
    m.lines += r.lines;
    for (const a of r.accounts) {
      const x = m.accounts.find((y) => y.account_id === a.account_id);
      if (x) {
        x.amount += a.amount;
        x.lines += a.lines;
      } else m.accounts.push({ ...a });
    }
  }
  return [...out.values()];
};

// ────────────────────────────────────────────
// 確認の一覧
// ────────────────────────────────────────────

export interface TaxIssue {
  /** error = 申告の前に直すもの ／ warn = 確かめるもの ／ info = 念のため */
  level: "error" | "warn" | "info";
  title: string;
  detail: string;
  /** 関係する仕訳（伝票番号。日付順） */
  entryIds: number[];
  /** 直す場所（return = 申告書タブ、interim = 中間申告タブ） */
  fix?: "settings" | "counterparties" | "entries" | "return" | "interim";
}

const entryIdsOf = (ls: FlatLine[]) => {
  const seen = new Map<number, string>();
  for (const l of ls) if (!seen.has(l.entry_id)) seen.set(l.entry_id, l.date);
  return [...seen.entries()].sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] < b[1] ? -1 : 1)).map(([id]) => id);
};

/** 科目の区分と税区分の組み合わせがおかしいか（おかしければ理由） */
export const codeMismatch = (a: Account, code: TaxCode): string | null => {
  if (code === "none") return null;
  const group = taxCodeDef(code).group;
  const bad = code === "baddebt10" || code === "baddebt8";
  if (a.category === "revenue" && (group === "purchase" || bad)) return "収益の科目に仕入・貸倒れの税区分";
  if ((a.category === "cogs" || a.category === "expense") && group === "sales" && !bad) return "経費・売上原価の科目に売上の税区分";
  if (a.category === "liability" || a.category === "equity" || a.category === "special") return "負債・資本・専従者給与の科目に対象外以外の税区分";
  return null;
};

export interface TaxCheckInput {
  year: number;
  lines: FlatLine[];
  accounts: Account[];
  counterparties: Counterparty[];
  taxYears: TaxYear[];
  /** 帳簿の登録番号・登録日 */
  invoiceNo: string;
  registeredOn: string;
  summary: TaxSummary;
  /** 基準期間・特定期間の課税売上高（読み込み中は null） */
  baseSales?: BaseSalesInfo | null;
  /** 中間申告の予定と、申告書に入れてある中間納付税額（読み込み中は null） */
  interim?: { plan: InterimPlan; entered: { national: number; local: number } } | null;
  /** 棚卸資産の調整（付表2-3 ⑯）と、帳簿の期首・期末の棚卸高（読み込み中は null） */
  inventory?: { adjust: InventoryAdjust | null; opening: number; closing: number } | null;
  /** 固定資産台帳（売却の漏れ・家事と兼用する資産の取得を確かめる。読み込み中は null） */
  assets?: FixedAsset[] | null;
}

/**
 * 固定資産と、課税・非課税の取り違えやすい科目の確かめ
 *  - 売却した固定資産：その年の資産の科目に課税売上の明細が無ければ知らせる（事業用の資産の売却は課税売上。簡易課税は第4種）
 *  - 本則課税で家事と兼用する資産を取得した年：資産の科目の課税仕入が、取得価額 × 事業専用割合 を超えていれば知らせる（事業用の部分だけが課税仕入）
 *  - 念のため：雑収入の課税売上（預金利息・補助金・保険金・還付金）、本則課税の地代家賃・福利厚生費の課税仕入（地代・住宅の家賃・社会保険料）、給料賃金の通勤手当
 */
const assetAndAccountIssues = (x: TaxCheckInput, scoped: FlatLine[], status: TaxStatus): TaxIssue[] => {
  const out: TaxIssue[] = [];
  const idOf = (code: string) => x.accounts.find((a) => a.code === code)?.id;
  const linesOf = (ids: (number | undefined)[], pick: (l: FlatLine) => boolean) => scoped.filter((l) => ids.includes(l.account_id) && pick(l));
  const assets = x.assets ?? [];
  // 売却した固定資産（課税事業者の期間に売ったもの）
  const sold = assets.filter((a) => a.disposed_on && a.disposal_kind !== "scrap" && a.disposed_on.slice(0, 4) === String(x.year) && taxActiveOn(x.taxYears, a.disposed_on));
  const missing = sold.filter((a) => linesOf([a.account_id], (l) => l.side === "credit" && isSalesCode(l.tax_code) && taxCodeDef(l.tax_code!).rate > 0).length === 0);
  if (missing.length) {
    out.push({
      level: "warn", title: "売却した固定資産の売却額が、課税売上に入っていません", entryIds: [],
      detail: `${missing.map((a) => `${a.name}（${a.disposed_on!.slice(5).replace("-", "/")}）`).join("、")}。事業用の資産の売却は課税売上です（簡易課税は第4種）。`
        + "固定資産台帳の「売却・除却の仕訳」で作れます。捨てたもの（除却）なら、台帳で「除却した」を選んでください。",
    });
  }
  if (status === "standard") {
    // 家事と兼用する資産を取得した科目ごとに、課税仕入が事業用の部分を超えていないか
    const shared = assets.filter((a) => a.acquired_on.slice(0, 4) === String(x.year) && businessRateIn(a, x.year) < 100);
    const over: { names: string[]; lines: FlatLine[] }[] = [];
    for (const accountId of new Set(shared.map((a) => a.account_id))) {
      const bought = assets.filter((a) => a.account_id === accountId && a.acquired_on.slice(0, 4) === String(x.year));
      const allowed = bought.reduce((t, a) => t + Math.floor((a.cost * businessRateIn(a, x.year)) / 100), 0);
      const purchase = linesOf([accountId], (l) => l.side === "debit" && isPurchaseCode(l.tax_code));
      if (purchase.reduce((t, l) => t + l.amount, 0) > allowed) over.push({ names: shared.filter((a) => a.account_id === accountId).map((a) => `${a.name}（事業 ${businessRateIn(a, x.year)}%）`), lines: purchase });
    }
    if (over.length) {
      out.push({
        level: "warn", title: "家事と兼用する資産の取得が、全額課税仕入になっています", fix: "entries", entryIds: entryIdsOf(over.flatMap((o) => o.lines)),
        detail: `${over.flatMap((o) => o.names).join("、")}。事業用の部分だけが課税仕入です。仕訳を、事業用（課税仕入）と家事用（対象外）の行に分けてください。`,
      });
    }
  }
  // 念のため：課税・非課税・不課税を取り違えやすい科目
  const misc = linesOf([idOf(CODE.MISC_INCOME)], (l) => l.side === "credit" && isSalesCode(l.tax_code) && taxCodeDef(l.tax_code!).rate > 0);
  if (misc.length) {
    out.push({
      level: "info", title: "念のため：雑収入が課税売上になっています", fix: "entries", entryIds: entryIdsOf(misc),
      detail: "預金の利息は非課税、補助金・保険金・消費税の還付金は対象外（不課税）で、課税売上ではありません。そうしたものがあれば、明細の税区分を直してください。",
    });
  }
  if (status === "standard") {
    const rent = linesOf([idOf(CODE.RENT), idOf(CODE.RE_RENT)], (l) => l.side === "debit" && isPurchaseCode(l.tax_code) && taxCodeDef(l.tax_code!).rate > 0);
    if (rent.length) {
      out.push({
        level: "info", title: "念のため：地代家賃が課税仕入になっています", fix: "entries", entryIds: entryIdsOf(rent),
        detail: "土地の賃借料（地代）と住宅の家賃は非課税です（事務所・店舗の家賃は課税）。そうしたものがあれば、明細の税区分を「非課税仕入」にしてください。",
      });
    }
    const welfare = linesOf([idOf(CODE.WELFARE)], (l) => l.side === "debit" && isPurchaseCode(l.tax_code) && taxCodeDef(l.tax_code!).rate > 0);
    if (welfare.length) {
      out.push({
        level: "info", title: "念のため：福利厚生費が課税仕入になっています", fix: "entries", entryIds: entryIdsOf(welfare),
        detail: "労災保険・雇用保険など社会保険料の事業主負担や慶弔見舞金は、対象外です（社会保険料は法定福利費の科目を使えます）。",
      });
    }
    const salaries = linesOf([idOf(CODE.SALARIES)], (l) => l.side === "debit");
    if (salaries.length && !salaries.some((l) => isPurchaseCode(l.tax_code))) {
      out.push({
        level: "info", title: "念のため：給料賃金の通勤手当は課税仕入です", fix: "entries", entryIds: [],
        detail: "通勤手当（通勤に通常必要な額）は課税仕入になります。給料と分けて、明細の税区分を「課税仕入 10%」にしてください（補助科目で分けると入れやすくなります）。",
      });
    }
  }
  return out;
};

const yenText = (n: number) => `${n.toLocaleString()}円`;

/** 中間納付税額が中間申告の予定と合っているか */
const interimIssues = (year: number, i: NonNullable<TaxCheckInput["interim"]>): TaxIssue[] => {
  const { plan, entered } = i;
  const none = entered.national === 0 && entered.local === 0;
  const planned = `消費税 ${yenText(plan.national)}・地方消費税 ${yenText(plan.local)}`;
  const prev = `前年（${year - 1}年）の確定消費税額 ${yenText(plan.prevTax ?? 0)}`;
  if (plan.kind === "unknown") {
    return [{
      level: "info", title: `前年（${year - 1}年）の確定消費税額が分かりません`, fix: "interim", entryIds: [],
      detail: `${year - 1}年の帳簿が domble に無いため、中間申告が要るか判定できません。「中間申告」で前年の確定申告書の ⑨ 差引税額を入れてください。`,
    }];
  }
  if (plan.periods.length === 0) {
    return none ? [] : [{
      level: "info", title: "中間申告が要らない年ですが、中間納付税額が入っています", fix: "return", entryIds: [],
      detail: `${prev}は48万円以下です。任意の中間申告をしたときは、事業者設定の「消費税」で届出の印を付けてください。`,
    }];
  }
  if (none) {
    return [{
      level: plan.kind === "voluntary" ? "info" : "warn", title: "中間納付税額が入っていません", fix: "return", entryIds: [],
      detail: `${prev}から、${year}年の中間申告は${INTERIM_KIND_LABEL[plan.kind]}（合計 ${planned}）です。`
        + "申告書の「中間納付税額」に、中間申告で納める税額を入れてください（「判定した額を入れる」で入れられます）。"
        + (plan.kind === "voluntary" ? "任意の中間申告書を期限までに出さなかったときは、0 のままで構いません。" : ""),
    }];
  }
  if (entered.national !== plan.national || entered.local !== plan.local) {
    return [{
      level: "info", title: "中間納付税額が、前年の実績で計算した額と違います", fix: "return", entryIds: [],
      detail: `前年の実績で計算すると ${planned} です（入っている額：消費税 ${yenText(entered.national)}・地方消費税 ${yenText(entered.local)}）。`
        + "仮決算で中間申告をしたときや、前年の税額が修正申告で変わったときは、そのままで構いません。",
    }];
  }
  return [];
};

/** 棚卸資産の調整（付表2-3 ⑯）：免税から課税になった年の加算、課税から免税になる前の年の減算が入っているか */
const inventoryIssues = (year: number, taxYears: TaxYear[], inv: NonNullable<TaxCheckInput["inventory"]>): TaxIssue[] => {
  const ty = taxYearOf(taxYears, year);
  const dir = inv.adjust?.rows.length ? inv.adjust.direction : null;
  if (ty.status !== "standard") {
    return dir ? [{
      level: "info", title: "棚卸資産の調整が入っていますが、本則課税ではありません", fix: "return", entryIds: [],
      detail: "棚卸資産の調整（付表2-3 ⑯）は本則課税だけのものです。簡易課税・2割特例では使いません。",
    }] : [];
  }
  const out: TaxIssue[] = [];
  const became = taxYearOf(taxYears, year - 1).status === "exempt" || !!ty.taxable_from;
  if (became && dir !== "add" && (inv.opening > 0 || ty.taxable_from)) {
    out.push({
      level: ty.taxable_from ? "info" : "warn", title: "免税事業者から課税事業者になった年の棚卸資産の調整が入っていません", fix: "return", entryIds: [],
      detail: (ty.taxable_from
        ? `${ty.taxable_from} から課税事業者なので、その前日に持っていた棚卸資産のうち、免税の期間に仕入れたものの消費税額を加算できます。`
        : `期首の棚卸高 ${yenText(inv.opening)} のうち、免税の期間（${year - 1}年まで）に仕入れたものの消費税額を加算できます。`)
        + "申告書の「棚卸資産の調整」で入れます（付表2-3 ⑯。棚卸資産の明細の記録と保存が要ります）。",
    });
  }
  const next = taxYearOf(taxYears, year + 1);
  if (next.status === "exempt" && !next.inherited && dir !== "sub" && inv.closing > 0) {
    out.push({
      level: "warn", title: "免税事業者になる前の年の棚卸資産の調整が入っていません", fix: "return", entryIds: [],
      detail: `${year + 1}年から免税事業者なので、年末の棚卸高 ${yenText(inv.closing)} のうち、${year}年に仕入れたものの消費税額を減算します（申告書の「棚卸資産の調整」。付表2-3 ⑯）。`,
    });
  }
  return out;
};

/** 高額特定資産（税抜 1,000万円以上の固定資産。消法12の4） */
export const HIGH_VALUE_ASSET = 10_000_000;

/**
 * 高額特定資産：本則課税の年に取得した、税抜 1,000万円以上の固定資産（土地・繰延資産を除く）。取得した年を返す
 * （税込経理の年の取得価額は税込なので 100/110 にする）
 */
export const highValueAssetYears = (assets: FixedAsset[], taxYears: TaxYear[], landAccountIds: number[]): { asset: FixedAsset; year: number }[] =>
  assets
    .filter((a) => a.method !== "deferred" && !landAccountIds.includes(a.account_id) && a.opening_year === null)
    .map((a) => ({ asset: a, year: Number(a.acquired_on.slice(0, 4)) }))
    .filter(({ asset, year }) => {
      const ty = taxYearOf(taxYears, year);
      const excl = ty.method === "exclusive" ? asset.cost : Math.floor((asset.cost * 100) / 110);
      return ty.status === "standard" && excl >= HIGH_VALUE_ASSET;
    });

/**
 * 方式を選ぶ前提（C-06）
 *  - 2割特例・3割特例は、適格請求書発行事業者（その年の12月31日までに登録）だけ
 *  - 登録日が年の途中で、前の年が免税事業者なのに「課税事業者になった日」が空なら、念のため（登録日から課税）
 *  - 簡易課税は2年続けて使う（消法37⑥）。始める年・やめる年は前の年の12月31日までに届出が要る
 *  - 本則課税の年に高額特定資産を取得したら、その年から3年間は免税事業者・簡易課税・2割特例・3割特例にならない（消法12の4・37③）
 */
export const regimeIssues = (year: number, taxYears: TaxYear[], reg: { invoiceNo: string; registeredOn: string }, assets: FixedAsset[] | null | undefined, landAccountIds: number[]): TaxIssue[] => {
  const out: TaxIssue[] = [];
  const st = (y: number) => taxYearOf(taxYears, y).status;
  // その年の課税区分が帳簿にあるか（domble を使い始める前の年は分からないので、届出・2年継続は確かめない）
  const known = (y: number) => taxYears.some((r) => r.from_year <= y);
  const ty = taxYearOf(taxYears, year);
  const label = (s: TaxStatus) => TAX_STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;
  if ((ty.status === "twenty" || ty.status === "thirty") && (!reg.invoiceNo || !reg.registeredOn || reg.registeredOn > `${year}-12-31`)) {
    out.push({
      level: "error", title: `${ty.status === "twenty" ? "2割特例" : "3割特例"}は登録した事業者だけが使えます`, fix: "settings", entryIds: [],
      detail: `適格請求書発行事業者の登録番号と登録日（${year}年12月31日以前）が入っていません。登録していれば事業者設定の「消費税」で入れ、登録していなければ課税区分を選び直してください。`,
    });
  }
  if (ty.status !== "exempt" && !ty.taxable_from && st(year - 1) === "exempt" && reg.registeredOn > `${year}-01-01` && reg.registeredOn <= `${year}-12-31`) {
    out.push({
      level: "info", title: "年の途中に登録した年の「課税事業者になった日」", fix: "settings", entryIds: [],
      detail: `登録日（${reg.registeredOn}）より前は免税事業者なら、事業者設定の「消費税」で「課税事業者になった日」に登録日を入れてください（空のままだと1月1日からの売上に課税されます）。`,
    });
  }
  // 簡易課税の2年継続と届出
  if (ty.status === "standard" && st(year - 1) === "simplified" && known(year - 2) && st(year - 2) !== "simplified") {
    out.push({
      level: "warn", title: "簡易課税は2年続けて使う決まりです", fix: "settings", entryIds: [],
      detail: `${year - 1}年から簡易課税にしているので、${year}年は本則課税に戻せません（簡易課税制度選択不適用届出書は、簡易課税を始めた年の翌年以後に出し、その翌年から本則課税に戻ります）。`,
    });
  }
  if (ty.status === "simplified" && known(year - 1) && st(year - 1) !== "simplified" && !ty.inherited) {
    out.push({
      level: "info", title: `${year}年から簡易課税にするには届出が要ります`, fix: "settings", entryIds: [],
      detail: `簡易課税制度選択届出書を ${year - 1}年12月31日までに出しているか確かめてください（出していなければ本則課税か2割特例です）。`,
    });
  }
  if (ty.status === "standard" && st(year - 1) === "simplified") {
    out.push({
      level: "info", title: `${year}年から本則課税に戻すには届出が要ります`, fix: "settings", entryIds: [],
      detail: `簡易課税制度選択不適用届出書を ${year - 1}年12月31日までに出しているか確かめてください（出していなければ簡易課税のままです。2割特例は届出が無くても選べます）。`,
    });
  }
  // 高額特定資産の3年
  const high = (assets ? highValueAssetYears(assets, taxYears, landAccountIds) : []).filter((h) => year > h.year && year <= h.year + 2);
  if (high.length && ty.status !== "standard") {
    const h = high[0];
    out.push({
      level: "error", title: `${year}年は本則課税です（高額特定資産を取得したため）`, fix: "settings", entryIds: [],
      detail: `${h.year}年（本則課税）に「${h.asset.name}」（税抜 1,000万円以上）を取得したので、${h.year}年から${h.year + 2}年までは免税事業者・簡易課税・2割特例・3割特例になれません。` +
        `「${label(ty.status)}」から本則課税に選び直してください。`,
    });
  }
  return out;
};

export const taxChecks = (x: TaxCheckInput): TaxIssue[] => {
  const issues: TaxIssue[] = [];
  const ty = taxYearOf(x.taxYears, x.year);
  const statusLabel = (s: TaxStatus) => TAX_STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;

  // 設定
  const p = statusProblem(ty.status, x.year);
  if (p) {
    issues.push({
      level: "error", title: `${x.year}年の課税区分が使えません`, fix: "settings", entryIds: [],
      detail: `前の年の「${statusLabel(ty.status)}」を引き継いでいますが、${p}。事業者設定の「消費税」で選び直してください。`,
    });
  }
  if (x.invoiceNo && ty.status === "exempt" && (!x.registeredOn || x.registeredOn <= `${x.year}-12-31`)) {
    issues.push({
      level: "error", title: "登録番号があるのに免税事業者になっています", fix: "settings", entryIds: [],
      detail: `適格請求書発行事業者の登録日（${x.registeredOn || "未入力"}）からは課税事業者です。事業者設定の「消費税」で課税区分を選んでください。`,
    });
  }
  const mandatory = x.baseSales ? mandatoryReason(x.baseSales) : null;
  if (ty.status === "exempt" && mandatory) {
    issues.push({
      level: "error", title: `${x.year}年は課税事業者です`, fix: "settings", entryIds: [],
      detail: `${mandatory}。免税事業者にはなれないので、事業者設定の「消費税」で課税区分を選んでください。`,
    });
  }
  // 方式を選ぶ前提（登録・簡易課税の届出と2年継続・高額特定資産）
  const landIds = x.accounts.filter((a) => a.code === CODE.LAND).map((a) => a.id);
  issues.push(...regimeIssues(x.year, x.taxYears, { invoiceNo: x.invoiceNo, registeredOn: x.registeredOn }, x.assets, landIds));
  if (ty.status === "exempt") return byLevel(issues);
  if (x.inventory) issues.push(...inventoryIssues(x.year, x.taxYears, x.inventory));
  if (x.baseSales && (ty.status === "twenty" || ty.status === "thirty" || ty.status === "simplified")) {
    const m = methodProblem(ty.status, x.baseSales);
    if (m) issues.push({ level: "error", title: `${statusLabel(ty.status)}は使えません`, fix: "settings", entryIds: [], detail: `${m}。事業者設定の「消費税」で課税区分を選び直してください。` });
  }
  if (x.baseSales && x.baseSales.source === "none") {
    issues.push({
      level: "info", title: `基準期間（${x.year - 2}年）の課税売上高が分かりません`, fix: "settings", entryIds: [],
      detail: `${x.year - 2}年の帳簿が domble に無いため計算できません。申告書の第一表に書くほか、2割特例・3割特例・簡易課税が使えるかの確認に使うので、事業者設定の「消費税」で入れてください。`,
    });
  }

  if (x.interim) issues.push(...interimIssues(x.year, x.interim));

  const accountMap = new Map(x.accounts.map((a) => [a.id, a]));
  const cpMap = new Map(x.counterparties.map((c) => [c.id, c]));
  const scoped = inScope(x.lines, x.taxYears);

  // 税区分が入っていない
  const untaxed = scoped.filter((l) => !l.tax_code);
  if (untaxed.length) {
    issues.push({
      level: "error", title: "税区分が入っていない仕訳", fix: "settings", entryIds: entryIdsOf(untaxed),
      detail: "課税事業者にする前に入れた仕訳などです。事業者設定の「消費税」の「科目の初期値で入れる」でまとめて入れるか、仕訳を開いて入れてください。",
    });
  }

  // 簡易課税の年：事業区分の分からない売上（本則課税から変えた年の売上、区分を指定せずに取り込んだ売上など）
  if (ty.status === "simplified") {
    const unknown = scoped.filter((l) => isSalesCode(l.tax_code) && !l.business_class);
    if (unknown.length) {
      issues.push({
        level: "error", title: "事業区分の分からない売上", fix: "settings", entryIds: entryIdsOf(unknown),
        detail: "簡易課税に変える前に入れた売上や、事業区分を指定せずに取り込んだ売上です。申告書の数字は、その年の売上に出てくる区分のうちみなし仕入率がいちばん低い区分で計算しています。"
          + "事業者設定の「消費税」の「科目の初期値で入れる」で（科目の初期値 → 主な事業区分 の順に）まとめて入れるか、仕訳を開いて選んでください。",
      });
    }
  }

  // 科目と税区分の組み合わせ
  const mismatched = scoped.filter((l) => {
    const a = accountMap.get(l.account_id);
    return !!a && !!l.tax_code && !!codeMismatch(a, l.tax_code);
  });
  if (mismatched.length) {
    const reasons = [...new Set(mismatched.map((l) => codeMismatch(accountMap.get(l.account_id)!, l.tax_code!)))];
    issues.push({
      level: "warn", title: "科目と税区分の組み合わせを確かめてください", fix: "entries", entryIds: entryIdsOf(mismatched),
      detail: `${reasons.join("、")}があります。入力の誤りでなければ、そのままでかまいません。`,
    });
  }

  // インボイス区分と取引先
  const purchases = scoped.filter((l) => isPurchaseCode(l.tax_code) && l.side === "debit");
  const qualifiedFromNonRegistered = purchases.filter((l) => (l.invoice_kind ?? "qualified") === "qualified" && cpMap.get(l.counterparty_id ?? 0)?.not_registered);
  if (qualifiedFromNonRegistered.length) {
    issues.push({
      level: "warn", title: "「適格請求書発行事業者ではない」取引先からの仕入れが「適格」になっています", fix: "entries",
      entryIds: entryIdsOf(qualifiedFromNonRegistered),
      detail: "インボイス（適格請求書）が無ければ、インボイス区分を「経過措置」にしてください。",
    });
  }
  const transitionalFromRegistered = purchases.filter((l) => l.invoice_kind === "transitional" && cpMap.get(l.counterparty_id ?? 0)?.invoice_no);
  if (transitionalFromRegistered.length) {
    issues.push({
      level: "warn", title: "登録番号のある取引先からの仕入れが「経過措置」になっています", fix: "entries",
      entryIds: entryIdsOf(transitionalFromRegistered),
      detail: "インボイス（適格請求書）を受け取っていれば、インボイス区分を「適格」にしてください。",
    });
  }
  const noNumber = purchases.filter((l) => {
    const c = cpMap.get(l.counterparty_id ?? 0);
    return (l.invoice_kind ?? "qualified") === "qualified" && !!c && !c.invoice_no && !c.not_registered;
  });
  if (noNumber.length) {
    const names = [...new Set(noNumber.map((l) => cpMap.get(l.counterparty_id!)!.name))];
    issues.push({
      level: "info", title: "登録番号が入っていない取引先からの「適格」の仕入れ", fix: "counterparties", entryIds: entryIdsOf(noNumber),
      detail: `${names.slice(0, 5).join("、")}${names.length > 5 ? ` ほか${names.length - 5}件` : ""}。受け取ったインボイスの登録番号を取引先に入れるか、登録していない相手なら取引先を「適格請求書発行事業者ではない」にしてください。`,
    });
  }

  // 本則課税：帳簿に課税仕入の相手方の氏名又は名称を書く（消法30⑦⑧）。取引先も補助科目も無い課税仕入は、摘要に書いてあるか念のため
  if (ty.status === "standard") {
    const unknownParty = purchases.filter((l) => (l.invoice_kind ?? "qualified") !== "none" && !l.counterparty_id && !l.sub_account_id);
    if (unknownParty.length) {
      issues.push({
        level: "info", title: "相手方の分からない課税仕入", fix: "entries", entryIds: entryIdsOf(unknownParty),
        detail: "本則課税で仕入税額を控除するには、帳簿に相手方の氏名又は名称を書きます。取引先も補助科目も入っていない課税仕入です。"
          + "摘要に相手方を書いていれば、そのままでかまいません（帳簿のみ保存の特例の仕入れは、インボイス区分で特例を選んでください）。",
      });
    }
  }

  // 課税売上割合（本則課税のときだけ仕入税額の計算に効く）
  const ratio = x.summary.ratio.value;
  if (ty.status === "standard" && ratio !== null && ratio < 0.95) {
    const methodName = ty.deduction === "individual" ? "個別対応方式" : "一括比例配分方式";
    issues.push({
      level: "warn", title: `課税売上割合が ${(Math.floor(ratio * 10000) / 100).toFixed(2)}%（95% 未満）です`, entryIds: [], fix: "settings",
      detail: `95% 未満のときは、仕入税額を個別対応方式か一括比例配分方式で計算します。申告書の数字は事業者設定の「消費税」の控除の方式（今は${methodName}）で出しています。`
        + "「申告書」で両方の額を比べられます。一括比例配分方式にすると、2年続けて使う決まりがあります。",
    });
    // 個別対応方式：用途区分の入っていない課税仕入
    if (ty.deduction === "individual") {
      const noUse = scoped.filter((l) => isPurchaseCode(l.tax_code) && (l.invoice_kind ?? "qualified") !== "none" && !l.purchase_use);
      if (noUse.length) {
        issues.push({
          level: "warn", title: "用途区分の入っていない課税仕入", fix: "settings", entryIds: entryIdsOf(noUse),
          detail: "個別対応方式では、課税仕入を課税対応・共通対応・非課税対応に分けます。入っていない課税仕入は共通対応として計算しています。"
            + "事業者設定の「消費税」の「科目の初期値で入れる」で（科目の初期値 → 共通対応 の順に）まとめて入れるか、仕訳を開いて選んでください。",
        });
      }
    }
  }
  issues.push(...assetAndAccountIssues(x, scoped, ty.status));
  if (ty.status === "standard") {
    const d = deductionProblem(x.taxYears, x.year, ty.deduction);
    if (d) issues.push({ level: "error", title: "控除の方式を確かめてください", fix: "settings", entryIds: [], detail: `${d}。事業者設定の「消費税」で選び直してください。` });
  }
  return byLevel(issues);
};

/** 直すもの（赤）→ 確かめるもの（黄）→ 念のため（青）の順（同じ重さの中は見つけた順） */
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const byLevel = (issues: TaxIssue[]) => [...issues].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
