/**
 * 勘定科目と青色申告決算書（一般用）の欄の対応（純粋関数）
 *  - 決算書には決まった名前の欄（租税公課・荷造運賃…・雑費、現金・当座預金…）と、科目名を書く追加の欄がある
 *    追加の欄の数には上限がある（経費 6・各種引当金等の繰入額 2・繰戻額 2・資産 7・負債 7。令和7年分の様式。令和8年分の様式で確かめ直す）
 *  - 科目ごとに書く欄を選べる（accounts.statement_line。null = 自動：科目名が欄の名前と同じならその欄、違えば追加の欄）
 *  - 追加の欄が足りないときは、金額の大きい科目から欄に入れ、残りは経費なら雑費、それ以外は最後の欄「その他」にまとめて知らせる
 *  - 売上（収入）金額の科目は、まとめて「売上（収入）金額」に書く（月別の内訳は2ページ目）
 */
import type { Account } from "./types";
import { CODE } from "../constants/accounts";

/** cogs 売上原価 ／ expense 経費 ／ addition 各種引当金等の繰入額（専従者給与など） ／ reversal 繰戻額 ／ asset 資産 ／ liability 負債・資本 */
export type StatementSection = "cogs" | "expense" | "addition" | "reversal" | "asset" | "liability";

/** 追加の欄（科目名で書く） */
export const EXTRA_LINE = "extra";

export const STATEMENT_SECTIONS: Record<StatementSection, { label: string; fixed: string[]; extra: number; overflow: string }> = {
  cogs: { label: "売上原価", fixed: ["期首商品（製品）棚卸高", "仕入金額（製品製造原価）", "期末商品（製品）棚卸高"], extra: 0, overflow: "仕入金額（製品製造原価）" },
  expense: {
    label: "経費",
    fixed: [
      "租税公課", "荷造運賃", "水道光熱費", "旅費交通費", "通信費", "広告宣伝費", "接待交際費", "損害保険料", "修繕費", "消耗品費",
      "減価償却費", "福利厚生費", "給料賃金", "外注工賃", "利子割引料", "地代家賃", "貸倒金", "雑費",
    ],
    extra: 6,
    overflow: "雑費",
  },
  addition: { label: "各種引当金・準備金等（繰入額等）", fixed: ["専従者給与", "貸倒引当金"], extra: 2, overflow: "" },
  reversal: { label: "各種引当金・準備金等（繰戻額等）", fixed: ["貸倒引当金"], extra: 2, overflow: "" },
  asset: {
    label: "資産の部",
    fixed: [
      "現金", "当座預金", "定期預金", "その他の預金", "受取手形", "売掛金", "有価証券", "棚卸資産", "前払金", "貸付金",
      "建物", "建物附属設備", "機械装置", "車両運搬具", "工具 器具 備品", "土地", "事業主貸",
    ],
    extra: 7,
    overflow: "",
  },
  liability: { label: "負債・資本の部", fixed: ["支払手形", "買掛金", "借入金", "未払金", "前受金", "預り金", "貸倒引当金", "事業主借", "元入金"], extra: 7, overflow: "" },
};

/** 科目がどの部分に入るか（収益は null） */
export const sectionOf = (a: Pick<Account, "category" | "normal_side">): StatementSection | null => {
  switch (a.category) {
    case "cogs": return "cogs";
    case "expense": return "expense";
    case "special": return a.normal_side === "debit" ? "addition" : "reversal";
    case "asset": return "asset";
    case "liability":
    case "equity": return "liability";
    default: return null;
  }
};

const squash = (s: string) => s.normalize("NFKC").replace(/[\s（）()・、]/g, "");
/** 名前は違うが同じ欄に書く科目 */
const ALIASES: Record<string, string> = {
  普通預金: "その他の預金", 通常貯金: "その他の預金", 工具器具備品: "工具 器具 備品", 期首商品棚卸高: "期首商品（製品）棚卸高",
  仕入高: "仕入金額（製品製造原価）", 期末商品棚卸高: "期末商品（製品）棚卸高", 貸倒引当金繰入: "貸倒引当金", 貸倒引当金繰入額: "貸倒引当金",
  貸倒引当金戻入: "貸倒引当金", 貸倒引当金戻入額: "貸倒引当金",
};

/** 自動で決まる欄（科目名が欄の名前と同じならその欄、違えば追加の欄。売上原価は借方なら仕入金額、貸方なら期末棚卸高） */
export const autoLine = (a: Pick<Account, "category" | "normal_side" | "name" | "code">): string => {
  const section = sectionOf(a);
  if (!section) return "";
  const def = STATEMENT_SECTIONS[section];
  const name = squash(a.name);
  const hit = def.fixed.find((l) => squash(l) === name) ?? (ALIASES[name] && def.fixed.includes(ALIASES[name]) ? ALIASES[name] : undefined);
  if (hit) return hit;
  if (section === "cogs") return a.code === CODE.PURCHASES || a.normal_side === "debit" ? "仕入金額（製品製造原価）" : "期末商品（製品）棚卸高";
  return EXTRA_LINE;
};

/** その科目を書く欄（選んだものが使えなければ自動） */
export const lineOf = (a: Pick<Account, "category" | "normal_side" | "name" | "code" | "statement_line">): string => {
  const section = sectionOf(a);
  if (!section) return "";
  const chosen = a.statement_line;
  if (chosen && (chosen === EXTRA_LINE ? STATEMENT_SECTIONS[section].extra > 0 : STATEMENT_SECTIONS[section].fixed.includes(chosen))) return chosen;
  return autoLine(a);
};

/** 欄として選べるもの（[値, 表示]） */
export const lineOptions = (section: StatementSection): [string, string][] => [
  ...STATEMENT_SECTIONS[section].fixed.map((l): [string, string] => [l, l]),
  ...(STATEMENT_SECTIONS[section].extra > 0 ? [[EXTRA_LINE, "追加の欄（科目名で書く）"] as [string, string]] : []),
];

export interface StatementRow {
  label: string;
  /** 決まった欄か、追加の欄か */
  extra: boolean;
  /** 期首・期末（損益の科目は期末だけ） */
  opening: number;
  amount: number;
  accountIds: number[];
}

export interface StatementLayout {
  sections: Record<StatementSection, StatementRow[]>;
  /** 追加の欄が足りずにまとめた科目など */
  warnings: string[];
}

/**
 * 決算書の欄ごとの金額。amount = 期末残高（損益の科目は年間の額）、opening = 期首残高（貸借の科目）
 * 決まった欄は金額が無くても並べる。追加の欄は金額のある科目だけ
 */
export const statementLayout = (accounts: Account[], amount: (a: Account) => number, opening: (a: Account) => number = () => 0): StatementLayout => {
  const warnings: string[] = [];
  const sections = {} as Record<StatementSection, StatementRow[]>;
  for (const section of Object.keys(STATEMENT_SECTIONS) as StatementSection[]) {
    const def = STATEMENT_SECTIONS[section];
    const mine = accounts.filter((a) => sectionOf(a) === section);
    const fixed = def.fixed.map((label): StatementRow => ({ label, extra: false, opening: 0, amount: 0, accountIds: [] }));
    const add = (row: StatementRow, a: Account) => {
      row.opening += opening(a);
      row.amount += amount(a);
      row.accountIds.push(a.id);
    };
    const extras: StatementRow[] = [];
    for (const a of mine) {
      const line = lineOf(a);
      if (line === EXTRA_LINE) {
        if (amount(a) !== 0 || opening(a) !== 0) extras.push({ label: a.name, extra: true, opening: opening(a), amount: amount(a), accountIds: [a.id] });
      } else add(fixed.find((r) => r.label === line)!, a);
    }
    if (extras.length > def.extra) {
      extras.sort((x, y) => Math.max(Math.abs(y.amount), Math.abs(y.opening)) - Math.max(Math.abs(x.amount), Math.abs(x.opening)));
      if (def.overflow) {
        const rest = extras.splice(def.extra);
        const into = fixed.find((r) => r.label === def.overflow)!;
        for (const r of rest) {
          into.opening += r.opening;
          into.amount += r.amount;
          into.accountIds.push(...r.accountIds);
        }
        warnings.push(`${def.label}の追加の欄（${def.extra}つ）が足りないため、${rest.map((r) => r.label).join("・")}を${def.overflow}にまとめます`);
      } else {
        const rest = extras.splice(def.extra - 1);
        extras.push({
          label: "その他", extra: true, opening: rest.reduce((s, r) => s + r.opening, 0), amount: rest.reduce((s, r) => s + r.amount, 0),
          accountIds: rest.flatMap((r) => r.accountIds),
        });
        warnings.push(`${def.label}の追加の欄（${def.extra}つ）が足りないため、${rest.map((r) => r.label).join("・")}を「その他」にまとめます`);
      }
    }
    sections[section] = [...fixed, ...extras];
  }
  return { sections, warnings };
};
