/**
 * 所得の区分（事業所得・不動産所得）ごとに科目を分ける（純粋関数）
 *  - 損益の科目（収益・売上原価・経費・専従者給与等）は、科目ごとの所得の区分（accounts.income_kind）で分ける
 *  - 貸借対照表の科目（預金・事業主貸借・元入金など）は共通。貸借対照表は事業所得があれば一般用の決算書に、無ければ不動産所得用に書く
 */
import type { Account, IncomeKind } from "./types";
import { PL_CATEGORIES } from "../constants/accounts";

export const isProfitLoss = (a: Pick<Account, "category">) => PL_CATEGORIES.includes(a.category);

/** 科目の所得の区分（貸借対照表の科目は事業所得として扱う） */
export const kindOf = (a: Pick<Account, "category" | "income_kind">): IncomeKind => (isProfitLoss(a) && a.income_kind === "realestate" ? "realestate" : "business");

/** その所得の区分の決算書に使う科目（損益の科目はその区分のもの、貸借対照表の科目は全部） */
export const accountsOfKind = (accounts: Account[], kind: IncomeKind): Account[] => accounts.filter((a) => !isProfitLoss(a) || kindOf(a) === kind);

/** 不動産所得の科目に、金額のあるものがあるか */
export const hasRealEstate = (accounts: Account[], amount: (a: Account) => number) => accounts.some((a) => kindOf(a) === "realestate" && amount(a) !== 0);
