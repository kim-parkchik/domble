/**
 * 消費税の還付申告に関する明細書（個人事業者用）（純粋関数）
 * 控除不足還付税額（第一表 ⑧）がある一般用の申告書に添付する（消費税法施行規則22条3項）。書き方は国税庁の記載要領に沿う
 *  1 還付申告となった主な理由：入力（帳簿から候補）
 *  2(1) 主な課税資産の譲渡等：課税売上（輸出免税を除く）のうち、税抜 100万円以上を上位5件。
 *       同じ取引先に続けて売っているものは、その年の合計（税抜 100万円以上）を「継続」として1件にする
 *  2(2) 主な輸出取引等の明細：輸出免税の売上を取引先ごとに合計して上位5件。所轄税関・金融機関・通関業者は入力
 *  3(1) 仕入金額等の明細：所得ごとに、仕入金額・必要経費・固定資産等の取得価額の決算額と、そのうち課税仕入れにならないもの（計算）
 *  3(2) 主な棚卸資産・原材料等の取得：課税仕入（固定資産を除く）のうち、税抜 100万円以上を上位5件（続けて仕入れている取引先は合計して「継続」）
 *  3(3) 主な固定資産等の取得：固定資産の科目への課税仕入のうち、1件あたり税抜 100万円以上を上位5件
 *  4 特殊事情：入力
 * 金額は税込（domble は税込経理）。帳簿から出すものは候補で、画面で直して保存する（TaxRefundDetailInput）
 */
import type { Account, Counterparty, IncomeKind, TaxCode } from "./types";
import type { FlatLine } from "./accounting";
import { CODE, FIXED_ASSET_CODES } from "../constants/accounts";
import { taxCodeDef } from "./tax";
import { includedTax } from "./taxSummary";
import { kindOf } from "./incomeKind";

/** 記載要領の「100万円以上」（税抜） */
export const REFUND_DETAIL_THRESHOLD = 1_000_000;
/** 明細の行は上位5件まで */
export const REFUND_DETAIL_ROWS = 5;
/** 欄の文字数の上限（e-Tax の様式 SHC025） */
export const REFUND_DETAIL_LIMITS = {
  otherReason: 60, saleKind: 10, inventoryKind: 10, assetKind: 10, goods: 40, customs: 20, partnerName: 30, partnerAddress: 100,
  bankName: 15, branchName: 15, accountNo: 14, special: 200,
};

/** 取引の明細の行（2(1)・3(2)・3(3)） */
export interface RefundTradeRow {
  /** 資産の種類等（例：機械用部品、事務所貸付け、建物、車両） */
  kind: string;
  /** 譲渡（取得）年月日（YYYY-MM-DD）。継続のときは空 */
  date: string;
  /** 継続して取引している取引先の、その年の合計 */
  continuous: boolean;
  /** 取引金額等（税込） */
  amount: number;
  /** 取引先の登録番号（T を除いた13桁。3(2)・3(3)だけ） */
  regNo: string;
  name: string;
  address: string;
}

/** 輸出取引等の明細の行（2(2)） */
export interface RefundExportRow {
  name: string;
  address: string;
  /** 取引金額（免税） */
  amount: number;
  /** 主な取引商品等 */
  goods: string;
  /** 所轄税関（支署）名 */
  customs: string;
}

/** 金融機関区分・本支店区分・預金種類（e-Tax の区分の値） */
export const BANK_KINDS: [number, string][] = [[1, "銀行"], [2, "金庫"], [3, "組合"], [4, "農協"], [5, "漁協"]];
export const BRANCH_KINDS: [number, string][] = [[1, "本店"], [2, "支店"], [3, "本所"], [4, "支所"], [5, "出張所"]];
export const DEPOSIT_KINDS: [number, string][] = [[1, "普通"], [2, "当座"], [3, "納税準備"], [4, "通知"], [5, "別段"], [6, "貯蓄"], [9, "その他"]];

/** 明細書の入力（年ごとに保存する） */
export interface TaxRefundDetailInput {
  reasons: { export: boolean; capex: boolean; other: boolean; otherText: string };
  sales: RefundTradeRow[];
  exports: RefundExportRow[];
  /** 輸出取引等に利用する主な金融機関（無ければ name を空に） */
  bank: { name: string; kind: number; branch: string; branchKind: number; deposit: number; number: string };
  /** 輸出取引等に利用する主な通関業者 */
  broker: { name: string; address: string };
  inventory: RefundTradeRow[];
  assets: RefundTradeRow[];
  /** その年の特殊事情（顕著な増減事項とその理由） */
  special: string;
}

export const EMPTY_REFUND_BANK: TaxRefundDetailInput["bank"] = { name: "", kind: 1, branch: "", branchKind: 2, deposit: 1, number: "" };

/** 3(1) 仕入金額等の明細の1行（決算額・そのうち課税仕入れにならないもの・課税仕入高） */
export interface PurchaseFigure {
  total: number;
  notTaxable: number;
  taxable: number;
}

/** 3(1) 仕入金額等の明細（所得ごと） */
export interface PurchaseFigures {
  business: { purchase: PurchaseFigure; expense: PurchaseFigure; asset: PurchaseFigure; subtotal: PurchaseFigure };
  realEstate: { expense: PurchaseFigure; asset: PurchaseFigure; subtotal: PurchaseFigure };
  /** 課税仕入高の合計額 ⑫ */
  taxableTotal: number;
  /** 帳簿の課税仕入（返還を差し引く）のうち、3(1) の科目（仕入・経費・固定資産）に入らないもの。0 でなければ知らせる */
  outside: number;
}

export interface RefundBooks {
  /** その年の明細（削除済みを含んでもよい） */
  lines: FlatLine[];
  accounts: Account[];
  counterparties: Counterparty[];
  /** 課税期間（YYYY-MM-DD）。年の途中から課税事業者になったときは、その日から */
  from: string;
  to: string;
}

const TAXABLE_SALES: TaxCode[] = ["sales10", "sales8"];
const TAXABLE_PURCHASES: TaxCode[] = ["purchase10", "purchase8"];
const rateOf = (code: TaxCode) => taxCodeDef(code).rate;
/** 税抜の額（税込の額から、含まれている消費税等を引く） */
export const withoutTax = (amount: number, code: TaxCode) => amount - includedTax(amount, rateOf(code));

/** 期首の棚卸高（仕入金額に入れない売上原価の科目） */
const OPENING_INVENTORY = "501";
const isPurchaseAccount = (a: Account) => a.category === "cogs" && a.normal_side === "debit" && a.code !== OPENING_INVENTORY;
/** 固定資産等の科目（償却する資産の科目と土地。土地は非課税なので「課税仕入れにならないもの」に入る） */
const isFixedAsset = (a: Account) => FIXED_ASSET_CODES.includes(a.code) || a.code === CODE.LAND;

const inPeriod = (b: RefundBooks) => b.lines.filter((l) => !l.is_deleted && l.date >= b.from && l.date <= b.to);
const signed = (l: FlatLine) => (l.side === "debit" ? l.amount : -l.amount);

const figure = (total: number, taxable: number): PurchaseFigure => ({ total, notTaxable: total - taxable, taxable });
const add = (...xs: PurchaseFigure[]) => figure(xs.reduce((t, x) => t + x.total, 0), xs.reduce((t, x) => t + x.taxable, 0));

/**
 * 3(1) 仕入金額等の明細（決算書の科目と税区分から）
 *  仕入金額：売上原価の仕入の科目（期首・期末の棚卸高を除く）の借方−貸方
 *  必要経費：経費の科目の借方−貸方（決算書の経費の合計と同じ）
 *  固定資産等の取得価額：固定資産の科目の借方（取得）
 *  課税仕入高：そのうち税区分が課税仕入の明細（借方−貸方。家事分の振替や返品は差し引く）。課税仕入れにならないもの = 決算額 − 課税仕入高
 * 固定資産は所得の区分を持たない科目なので、事業所得に入れる（事業所得の科目が1つも動いていない年だけ不動産所得）
 */
export const purchaseFigures = (b: RefundBooks): PurchaseFigures => {
  const acc = new Map(b.accounts.map((a) => [a.id, a]));
  const lines = inPeriod(b);
  const sum = (pick: (a: Account) => boolean, value: (l: FlatLine) => number) =>
    lines.reduce((t, l) => {
      const a = acc.get(l.account_id);
      return a && pick(a) ? t + value(l) : t;
    }, 0);
  const taxablePart = (l: FlatLine) => (l.tax_code && TAXABLE_PURCHASES.includes(l.tax_code) ? signed(l) : 0);
  const pl = (kind: IncomeKind, pick: (a: Account) => boolean) => (a: Account) => pick(a) && kindOf(a) === kind;
  const group = (pick: (a: Account) => boolean) => figure(sum(pick, signed), sum(pick, taxablePart));
  const assetGroup = figure(
    sum(isFixedAsset, (l) => (l.side === "debit" ? l.amount : 0)),
    sum(isFixedAsset, (l) => (l.side === "debit" && l.tax_code && TAXABLE_PURCHASES.includes(l.tax_code) ? l.amount : 0)),
  );
  const none = figure(0, 0);
  const purchase = group(pl("business", isPurchaseAccount));
  const expense = group(pl("business", (a) => a.category === "expense"));
  const reExpense = group(pl("realestate", (a) => a.category === "expense"));
  const businessMoved = lines.some((l) => {
    const a = acc.get(l.account_id);
    return !!a && (a.category === "revenue" || a.category === "cogs" || a.category === "expense") && kindOf(a) === "business";
  });
  const reMoved = lines.some((l) => {
    const a = acc.get(l.account_id);
    return !!a && kindOf(a) === "realestate";
  });
  const assetToRealEstate = !businessMoved && reMoved;
  const business = {
    purchase, expense, asset: assetToRealEstate ? none : assetGroup,
    subtotal: add(purchase, expense, assetToRealEstate ? none : assetGroup),
  };
  const realEstate = { expense: reExpense, asset: assetToRealEstate ? assetGroup : none, subtotal: add(reExpense, assetToRealEstate ? assetGroup : none) };
  const taxableTotal = business.subtotal.taxable + realEstate.subtotal.taxable;
  // 帳簿の課税仕入（返還を差し引く）の全体と比べる（前払金・事業主貸などに課税仕入の税区分があると、3(1) に入らない）
  const allTaxable = lines.reduce((t, l) => {
    if (!l.tax_code || !TAXABLE_PURCHASES.includes(l.tax_code)) return t;
    const a = acc.get(l.account_id);
    if (a && isFixedAsset(a)) return t + (l.side === "debit" ? l.amount : 0);
    return t + signed(l);
  }, 0);
  return { business, realEstate, taxableTotal, outside: allTaxable - taxableTotal };
};

const regNoOf = (c: Counterparty | undefined) => (c?.invoice_no ?? "").replace(/^T/, "");
const clip = (s: string, n: number) => [...s.trim()].slice(0, n).join("");

/**
 * 明細の行の候補：税抜 100万円以上を上位5件。continuous = true なら、同じ取引先との取引が2件以上あるとき合計して「継続」の1件にする
 *  資産の種類等は、摘要（無ければ科目名）から
 */
const tradeRows = (
  b: RefundBooks, picked: FlatLine[], o: { continuous: boolean; kindLimit: number; withRegNo: boolean },
): RefundTradeRow[] => {
  const acc = new Map(b.accounts.map((a) => [a.id, a]));
  const cps = new Map(b.counterparties.map((c) => [c.id, c]));
  const kindOfLine = (l: FlatLine) => clip(l.memo || l.description || acc.get(l.account_id)?.name || "", o.kindLimit);
  type Item = { lines: FlatLine[]; net: number; gross: number };
  const items: Item[] = [];
  const byPartner = new Map<number, FlatLine[]>();
  for (const l of picked) {
    if (o.continuous && l.counterparty_id != null) byPartner.set(l.counterparty_id, [...(byPartner.get(l.counterparty_id) ?? []), l]);
    else items.push({ lines: [l], net: withoutTax(l.amount, l.tax_code!), gross: l.amount });
  }
  for (const ls of byPartner.values()) {
    if (ls.length === 1) items.push({ lines: ls, net: withoutTax(ls[0].amount, ls[0].tax_code!), gross: ls[0].amount });
    else items.push({ lines: ls, net: ls.reduce((t, l) => t + withoutTax(l.amount, l.tax_code!), 0), gross: ls.reduce((t, l) => t + l.amount, 0) });
  }
  return items
    .filter((x) => x.net >= REFUND_DETAIL_THRESHOLD)
    .sort((x, y) => y.gross - x.gross || x.lines[0].date.localeCompare(y.lines[0].date))
    .slice(0, REFUND_DETAIL_ROWS)
    .map((x) => {
      const l = x.lines[0];
      const cp = l.counterparty_id != null ? cps.get(l.counterparty_id) : undefined;
      const continuous = x.lines.length > 1;
      return {
        kind: continuous ? clip(acc.get(l.account_id)?.name ?? "", o.kindLimit) : kindOfLine(l),
        date: continuous ? "" : l.date, continuous, amount: x.gross,
        regNo: o.withRegNo ? regNoOf(cp) : "", name: clip(cp?.name ?? "", REFUND_DETAIL_LIMITS.partnerName), address: "",
      };
    });
};

/** 帳簿から作る候補（明細の行と、還付の理由） */
export const refundCandidates = (b: RefundBooks) => {
  const acc = new Map(b.accounts.map((a) => [a.id, a]));
  const lines = inPeriod(b);
  const code = (l: FlatLine) => l.tax_code ?? "none";
  // 2(1) 課税売上（貸方。輸出免税・非課税は除く）
  const sales = tradeRows(b, lines.filter((l) => l.side === "credit" && TAXABLE_SALES.includes(code(l))), { continuous: true, kindLimit: REFUND_DETAIL_LIMITS.saleKind, withRegNo: false });
  // 2(2) 輸出免税の売上を取引先ごとに合計（取引先の無いものは1件ずつ）
  const cps = new Map(b.counterparties.map((c) => [c.id, c]));
  const exportGroups = new Map<string, { lines: FlatLine[]; amount: number }>();
  for (const l of lines) {
    if (code(l) !== "export") continue;
    const key = l.counterparty_id != null ? `cp:${l.counterparty_id}` : `line:${l.entry_id}:${l.row_no}`;
    const g = exportGroups.get(key) ?? { lines: [], amount: 0 };
    g.lines.push(l);
    g.amount += l.side === "credit" ? l.amount : -l.amount;
    exportGroups.set(key, g);
  }
  const exports: RefundExportRow[] = [...exportGroups.values()]
    .filter((g) => g.amount > 0)
    .sort((x, y) => y.amount - x.amount)
    .slice(0, REFUND_DETAIL_ROWS)
    .map((g) => {
      const l = g.lines[0];
      const cp = l.counterparty_id != null ? cps.get(l.counterparty_id) : undefined;
      return {
        name: clip(cp?.name ?? "", REFUND_DETAIL_LIMITS.partnerName), address: "", amount: g.amount,
        goods: clip(l.memo || acc.get(l.account_id)?.name || "", REFUND_DETAIL_LIMITS.goods), customs: "",
      };
    });
  // 3(2) 固定資産を除く課税仕入（借方）／ 3(3) 固定資産の科目への課税仕入（借方。1件ごと）
  const purchases = lines.filter((l) => l.side === "debit" && TAXABLE_PURCHASES.includes(code(l)));
  const inventory = tradeRows(b, purchases.filter((l) => {
    const a = acc.get(l.account_id);
    return !!a && !isFixedAsset(a) && (a.category === "cogs" || a.category === "expense");
  }), { continuous: true, kindLimit: REFUND_DETAIL_LIMITS.inventoryKind, withRegNo: true });
  const assets = tradeRows(b, purchases.filter((l) => {
    const a = acc.get(l.account_id);
    return !!a && isFixedAsset(a);
  }), { continuous: false, kindLimit: REFUND_DETAIL_LIMITS.assetKind, withRegNo: true });
  // 理由の候補：輸出免税の売上があれば「輸出等」、固定資産の課税仕入があれば「設備投資」、どちらも無ければ「その他」
  const exportTotal = [...exportGroups.values()].reduce((t, g) => t + g.amount, 0);
  const pf = purchaseFigures(b);
  const assetTaxable = pf.business.asset.taxable + pf.realEstate.asset.taxable;
  const reasons = { export: exportTotal > 0, capex: assetTaxable > 0, other: exportTotal <= 0 && assetTaxable <= 0, otherText: "" };
  return { sales, exports, inventory, assets, reasons };
};

/** 保存したものが無いときの明細書（帳簿の候補から） */
export const refundDetailFromBooks = (b: RefundBooks): TaxRefundDetailInput => {
  const c = refundCandidates(b);
  return { ...c, bank: { ...EMPTY_REFUND_BANK }, broker: { name: "", address: "" }, special: "" };
};

/** 入力の確かめ。問題があれば文言を返す */
export const refundDetailProblems = (x: TaxRefundDetailInput): string[] => {
  const out: string[] = [];
  const L = REFUND_DETAIL_LIMITS;
  if (!x.reasons.export && !x.reasons.capex && !x.reasons.other) out.push("還付申告となった主な理由を選んでください");
  if (x.reasons.other && !x.reasons.otherText.trim()) out.push("還付申告となった理由（その他）の内容を入れてください");
  const len = (s: string) => [...s].length;
  const over = (label: string, s: string, n: number) => len(s) > n && out.push(`${label}は${n}文字までです`);
  over("その他の理由", x.reasons.otherText, L.otherReason);
  over("特殊事情", x.special, L.special);
  for (const [label, rows, n] of [["主な課税資産の譲渡等", x.sales, L.saleKind], ["主な棚卸資産・原材料等の取得", x.inventory, L.inventoryKind], ["主な固定資産等の取得", x.assets, L.assetKind]] as const) {
    if (rows.length > REFUND_DETAIL_ROWS) out.push(`${label}は${REFUND_DETAIL_ROWS}件までです`);
    rows.forEach((r, i) => {
      over(`${label}の${i + 1}行目の資産の種類等`, r.kind, n);
      over(`${label}の${i + 1}行目の取引先の氏名（名称）`, r.name, L.partnerName);
      over(`${label}の${i + 1}行目の取引先の住所（所在地）`, r.address, L.partnerAddress);
      if (!r.continuous && !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.push(`${label}の${i + 1}行目の年月日を入れてください（続けて取引しているものは「継続」）`);
      if (r.regNo && !/^\d{13}$/.test(r.regNo)) out.push(`${label}の${i + 1}行目の登録番号は、T を除いた13桁の数字で入れてください`);
      if (!Number.isSafeInteger(r.amount) || r.amount < 0) out.push(`${label}の${i + 1}行目の取引金額が正しくありません`);
    });
  }
  if (x.exports.length > REFUND_DETAIL_ROWS) out.push(`主な輸出取引等の明細は${REFUND_DETAIL_ROWS}件までです`);
  x.exports.forEach((r, i) => {
    over(`主な輸出取引等の${i + 1}行目の主な取引商品等`, r.goods, L.goods);
    over(`主な輸出取引等の${i + 1}行目の所轄税関（支署）名`, r.customs, L.customs);
    if (!Number.isSafeInteger(r.amount) || r.amount < 0) out.push(`主な輸出取引等の${i + 1}行目の取引金額が正しくありません`);
  });
  over("金融機関名", x.bank.name, L.bankName);
  over("支店名", x.bank.branch, L.branchName);
  if (x.bank.number && !/^[0-9-]{1,14}$/.test(x.bank.number)) out.push("口座番号は14文字までの数字（ゆうちょ銀行は記号と番号を「-」で区切る）で入れてください");
  return out;
};
