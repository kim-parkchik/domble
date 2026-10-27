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
import { deductionProblem, isPurchaseCode, isSalesCode, statusProblem, taxActiveOn, taxCodeDef, taxYearOf, transitionalRate } from "./tax";
import { mandatoryReason, methodProblem, type BaseSalesInfo } from "./baseSales";
import { INTERIM_KIND_LABEL, type InterimPlan } from "./taxInterim";

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
    const purchaseUse = ty.status === "standard" && isPurchaseCode(l.tax_code) ? l.purchase_use ?? "unknown" : null;
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
    rows: list.map((r) => ({ ...r, tax: includedTax(r.amount, taxCodeDef(r.code).rate), accounts: r.accounts.sort((x, y) => y.amount - x.amount) })),
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
}

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
  if (ty.status === "exempt") return byLevel(issues);
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
  if (ty.status === "standard") {
    const d = deductionProblem(x.taxYears, x.year, ty.deduction);
    if (d) issues.push({ level: "error", title: "控除の方式を確かめてください", fix: "settings", entryIds: [], detail: `${d}。事業者設定の「消費税」で選び直してください。` });
  }
  return byLevel(issues);
};

/** 直すもの（赤）→ 確かめるもの（黄）→ 念のため（青）の順（同じ重さの中は見つけた順） */
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const byLevel = (issues: TaxIssue[]) => [...issues].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
