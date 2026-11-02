/**
 * 年度の締め・繰越の確認（純粋関数）
 *
 *  - 繰越した年度は締め済みにし、そのままでは編集できない
 *  - 編集するには「締めの解除」を明示的に行う（厳密モードでは理由つきで履歴に残す）
 *  - 前の年度を直したら、翌年の期首残高が繰越額とずれるので、それを見つけて知らせる
 */
import type { Account, Evidence, FiscalClosing, OpeningBalances, SubOpeningBalances } from "./types";
import { carryForwardWithSubs, closingBalances, subClosingBalances, type FlatLine } from "./accounting";

/** 何月まで締めたか（締めていなければ 0、年の締めなら 12） */
export const closedMonthOf = (c: Pick<FiscalClosing, "period_end"> | undefined) => (c ? Number(c.period_end.slice(5, 7)) : 0);

/** その月の末日（YYYY-MM-DD） */
export const monthEnd = (year: number, month: number) => {
  const d = new Date(year, month, 0);
  return `${year}-${String(month).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 締めた状態の言い方（「締めなし」「9月まで締め」「年の締め（12月まで）」） */
export const closedLabel = (month: number) => (month === 0 ? "締めなし" : month === 12 ? "年の締め（12月まで）" : `${month}月まで締め`);

/**
 * 「何年から」で持つ設定（消費税・申告の種類・家事按分・科目名・決算書の欄・不動産所得の規模など）で、
 * year 年の行を変えると設定が変わってしまう、年の締めをした年（year 年から、次に設定を変えた年の前まで。year 年そのものを含む）
 *  fromYears：同じ設定（科目ごとのものは、その科目）の行の年
 * schema.ts の inheritGuards と同じ条件
 */
export const inheritingClosedYears = (fromYears: readonly number[], year: number, closedYears: readonly number[]) => {
  const next = Math.min(Infinity, ...fromYears.filter((y) => y > year));
  return closedYears.filter((y) => y >= year && y < next).sort((a, b) => a - b);
};

/** 締めた年の設定が変わるので変えられない、の知らせ */
export const inheritMessage = (what: string, year: number, closed: readonly number[]) => {
  if (closed[0] === year) return `${year}年は締め済みのため変更できません。事業者設定で締めを戻してください。`;
  const ys = closed.map((y) => `${y}年`).join("・");
  return `${ys}は締め済みで、${year}年の${what}を引き継いでいます。変えると${ys}の${what}も変わるため、変更できません。事業者設定で${ys}の締めを戻してください。`;
};

/** その日付を含む締め（無ければ undefined） */
export const closingOf = (closings: FiscalClosing[], date: string) =>
  closings.find((c) => c.period_start <= date && date <= c.period_end);

/**
 * 既存の帳簿で、自動で締める年度。
 * 翌年度の期首残高がある（＝繰越済み）かつ、その年度自体にデータがある年度
 * （データの無い年度まで締めると、一覧に空の年度が並んでしまうため）
 */
export const yearsToAutoClose = (openingYears: number[], dataYears: number[], closedYears: number[]) => {
  const opening = new Set(openingYears);
  const closed = new Set(closedYears);
  return [...new Set(dataYears)].filter((y) => opening.has(y + 1) && !closed.has(y)).sort((a, b) => a - b);
};

/** 年度末の残高から作った「翌年の期首残高」（繰越処理と同じ計算） */
export const expectedNextOpening = (
  accounts: Account[],
  opening: OpeningBalances,
  subOpening: SubOpeningBalances,
  lines: FlatLine[],
): SubOpeningBalances =>
  carryForwardWithSubs(accounts, closingBalances(accounts, opening, lines), subClosingBalances(accounts, subOpening, lines));

export interface OpeningMismatch {
  /** "科目ID:補助ID" */
  key: string;
  /** 繰越処理をやり直したときの金額 */
  expected: number;
  /** いま保存されている期首残高 */
  actual: number;
}

/** 期首残高の食い違い（0 と「なし」は同じとみなす） */
export const openingMismatches = (expected: SubOpeningBalances, actual: SubOpeningBalances): OpeningMismatch[] => {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const out: OpeningMismatch[] = [];
  for (const key of keys) {
    const e = expected[key] ?? 0;
    const a = actual[key] ?? 0;
    if (e !== a) out.push({ key, expected: e, actual: a });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key, "en", { numeric: true }));
};

// ────────────────────────────────────────────
// 確認コードの控え（厳密モードの年の締め）
// ────────────────────────────────────────────

/** 控えた方法：file = ファイルに保存、mail = メールソフトで送った、manual = 書き写した・印刷した */
export type AnchorSaveHow = "file" | "mail" | "manual";
export const ANCHOR_HOW_LABEL: Record<AnchorSaveHow, string> = { file: "ファイルに保存", mail: "メールで送った", manual: "書き写した・印刷した" };

/** 確認コードを控えた記録。head = 控えたときの締めの連鎖の先頭（締め直すと先頭が変わるので、控え直しになる） */
export interface AnchorSave {
  head: string;
  at: string;
  how: AnchorSaveHow;
}

/** 年の締めの、今の確認コードを控えた記録（控えていない・締め直したあとなら null） */
export const anchorSaveOf = (c: Pick<FiscalClosing, "chain_head" | "anchor_saved"> | undefined): AnchorSave | null => {
  if (!c?.chain_head || !c.anchor_saved) return null;
  try {
    const x = JSON.parse(c.anchor_saved) as Partial<AnchorSave>;
    return x.head === c.chain_head && typeof x.at === "string" && x.how && x.how in ANCHOR_HOW_LABEL ? (x as AnchorSave) : null;
  } catch {
    return null;
  }
};

/** 確認コードを控えていない、年の締めをした年（確認コードのある年。古い順） */
export const unsavedAnchorYears = (closings: FiscalClosing[]) =>
  closings.filter((c) => closedMonthOf(c) === 12 && c.chain_head && !anchorSaveOf(c)).map((c) => c.fiscal_year).sort((a, b) => a - b);

/**
 * 締めた年の証憑を、その年を締めたあとに登録・変更したか（証憑の一覧の「締めたあと」の印・CSV）。
 * 証憑の登録・訂正・ひも付けは締めたあとも止めない（電子取引のデータや、あとから見つかった領収書を残す義務は締めと関係なく続くため）
 *  - 取引年月日の年が年の締めをしてあり、登録した日時（registered_at）か、最後に変えた日時（updated_at：訂正・無効・ひも付け・解除）が締めた日時より後
 *  - 締めを戻して締め直したときは、最後に締めた日時で見る
 */
export type AfterClosing = "create" | "change";
export const AFTER_CLOSING_LABEL: Record<AfterClosing, string> = { create: "締めたあとに登録", change: "締めたあとに変更" };
export const afterClosingOf = (e: Pick<Evidence, "txn_date" | "registered_at" | "updated_at">, closings: FiscalClosing[]): AfterClosing | null => {
  const c = closings.find((x) => x.fiscal_year === Number(e.txn_date.slice(0, 4)));
  if (!c || closedMonthOf(c) !== 12) return null;
  return e.registered_at > c.closed_at ? "create" : e.updated_at > c.closed_at ? "change" : null;
};
/** 印の説明（一覧の title） */
export const afterClosingTitle = (a: AfterClosing, c: Pick<FiscalClosing, "fiscal_year" | "closed_at">) =>
  a === "create"
    ? `${c.fiscal_year}年を締めたあと（${c.closed_at}）に登録しました。帳簿の数字は変わりません`
    : `${c.fiscal_year}年を締めたあと（${c.closed_at}）に、訂正・無効・仕訳とのひも付けなどをしました。中身は証憑の履歴で確かめられます。帳簿の数字は変わりません`;

/** メールアドレスとして使えるか（空はよい） */
export const isMailAddress = (s: string) => !s.trim() || /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s.trim());

/** メールソフトを開くための mailto:（宛先・件名・本文。改行は CRLF） */
export const mailtoUrl = (to: string, subject: string, body: string) =>
  `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`;
