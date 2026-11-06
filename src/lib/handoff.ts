/**
 * 税理士との受け渡し（バトン方式）の決まり。帳簿の操作は db/handoff.ts
 *
 * 事業者と税理士がどちらも domble を使い、帳簿ファイル（.dmbl）をメールやファイル共有で渡し合う。
 * 正本はどちらか1人が持つ：
 *  1. 事業者が「税理士に渡す」：渡すための写しを書き出し、自分の帳簿は「渡している」（sent）にする。受け取るまでは入力しない
 *  2. 税理士が写しを開いて確かめ・直し、「事業者に返す」：返すための写しを書き出し、自分の手元の帳簿は「返した」（returned）にする
 *  3. 事業者が「税理士から受け取る」：返ってきた帳簿が、最後に渡したものから続いているか（合言葉）、渡したあとにこちらで入れたものが
 *     無いかを確かめ、変わったものを見てから、自分の帳簿を返ってきた帳簿で置き換える（置き換える前の帳簿はバックアップに残す）
 */
import type { Holder } from "./types";

export type HandoffKind = "send" | "return" | "receive" | "cancel";

export interface Handoff {
  id: number;
  kind: HandoffKind;
  at: string;
  user_id: number | null;
  user_name: string | null;
  token: string;
  file: string;
  memo: string;
  local_changes: number;
}

export const HANDOFF_KIND_LABEL: Record<HandoffKind, string> = {
  send: "税理士に渡した",
  return: "事業者に返した",
  receive: "税理士から受け取った",
  cancel: "渡すのをやめた",
};

/** 入れた分が正本に入らない帳簿（sent = 税理士に渡している事業者の帳簿、returned = 返したあとの税理士の帳簿）。ふだんは null */
export type Hold = "sent" | "returned";
export const holdOf = (h: Holder | null | undefined): Hold | null => (h === "sent" || h === "returned" ? h : null);

/** 渡している（返した）帳簿に書き込もうとしたとき（画面上部の「それでも入力する」を押すまで止める） */
export const holdMessage = (hold: Hold) =>
  hold === "sent"
    ? "税理士に渡している帳簿です。受け取るときに税理士から返ってきた帳簿で置き換えるため、ここで入れた分は消えます。入力するときは、画面上部の「それでも入力する」を押してください"
    : "事業者に返したあとの帳簿です。ここで入れた分は事業者の帳簿には入りません。入力するときは、画面上部の「それでも入力する」を押してください";

const stamp = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/**
 * 書き出すファイルの名前：帳簿名_税理士へ_YYYYMMDD.dmbl（返すときは _事業者へ_）。
 * 前に付けた「_税理士へ_日付」「_事業者へ_日付」は外す（やり取りのたびに名前が長くならないように）
 */
export const handoffFileName = (bookFile: string, to: "accountant" | "owner", d: Date, ext: string) => {
  const base = (bookFile.split(/[\\/]/).pop() ?? bookFile).replace(/\.[^.]+$/, "").replace(/(_(税理士|事業者)へ_\d{8}(-\d+)?)+$/, "");
  return `${base}_${to === "accountant" ? "税理士" : "事業者"}へ_${stamp(d)}.${ext}`;
};

/** 受け取るときに見る、帳簿の状態 */
export interface BookState {
  book_id: string | null | undefined;
  holder: Holder | null | undefined;
  handoff_token: string | null | undefined;
  schema_version: number;
  handoffs: Handoff[];
}

/**
 * 返ってきた帳簿（returned）を、今の帳簿（master）の代わりに受け取れるか。できなければ、わけ（空 = 受け取れる）
 * appVersion：このソフトの形式の版（新しい版で使った帳簿は、この版では受け取らない）
 */
export const receiveProblem = (master: BookState, returned: BookState, appVersion: number): string => {
  if (holdOf(master.holder) !== "sent") return "この帳簿は税理士に渡していません（「税理士に渡す」で渡した帳簿だけ受け取れます）";
  if (returned.schema_version > appVersion) return "新しい版の domble で使った帳簿です。domble を最新の版に更新してから受け取ってください";
  if (!returned.book_id || returned.book_id !== master.book_id) return "別の帳簿です（この帳簿から渡したものではありません）";
  if (!master.handoff_token || returned.handoff_token !== master.handoff_token) {
    return "最後に渡したものではありません（前に渡した帳簿か、渡すのをやめたあとの帳簿です）。最後に渡した帳簿を返してもらってください";
  }
  if (returned.holder === "accountant") return "税理士が「事業者に返す」をしていない帳簿です。税理士の方で「事業者に返す」を押して書き出した帳簿を送ってもらってください";
  const send = returned.handoffs.find((h) => h.kind === "send" && h.token === master.handoff_token);
  const back = send && returned.handoffs.find((h) => h.kind === "return" && h.token === master.handoff_token && h.id > send.id);
  if (returned.holder !== "owner" || !back) return "事業者に返した帳簿ではありません";
  return "";
};

/** 最後に渡した記録（今の合言葉のもの） */
export const lastSend = (handoffs: Handoff[], token: string | null | undefined) =>
  [...handoffs].reverse().find((h) => h.kind === "send" && !!token && h.token === token) ?? null;

/**
 * 古い形式の帳簿を、この版の形式に新しくする前に聞くか（G-07）。
 * 税理士と受け渡す帳簿は、片方だけ新しい版で開くと、古い版のもう片方では読み取り専用でしか開けなくなる
 */
export const askBeforeUpgrade = (version: number, current: number, shared: boolean) => version > 0 && version < current && shared;

// ────────────────────────────────────────────
// 変わったもの（受け取る前に、今の帳簿と返ってきた帳簿を比べる）
// ────────────────────────────────────────────

/** 表の名前（画面に出す）。ここに無い表は比べない（履歴・記録・ファイルの中身など。仕訳は別に数える） */
export const TABLE_LABEL: Record<string, string> = {
  settings: "事業者設定",
  accounts: "勘定科目",
  sub_accounts: "補助科目",
  master_names: "科目・補助科目の年ごとの名前",
  opening_balances: "期首残高",
  counterparties: "取引先",
  departments: "部門",
  users: "ユーザー",
  journal_templates: "定型仕訳",
  evidences: "証憑",
  evidence_links: "証憑と仕訳のひも付け",
  sales_docs: "請求書・見積書",
  sales_payments: "請求書の入金",
  payroll_entries: "給与の仕訳",
  home_use_rates: "家事按分の割合",
  home_use_runs: "家事按分の振替",
  fixed_assets: "固定資産台帳",
  asset_rates: "固定資産の事業割合",
  asset_disposals: "固定資産の売却・除却",
  asset_amortizations: "繰延資産の償却",
  depreciation_runs: "減価償却の計上",
  year_end_runs: "決算整理",
  inventory_counts: "棚卸",
  allowance_runs: "貸倒引当金",
  entry_reversals: "振り戻しの仕訳",
  fiscal_closings: "年度の締め",
  filing_years: "申告の種類（年ごと）",
  real_estate_years: "不動産所得の区分（年ごと）",
  account_lines: "決算書の欄（科目ごと）",
  statement_notes: "決算書に書き込む欄",
  tax_years: "消費税の設定（年ごと）",
  tax_return_inputs: "消費税の申告の入力",
  tax_interims: "消費税の中間納付税額",
  tax_interim_provisionals: "仮決算の中間申告",
  tax_inventory_adjusts: "棚卸資産の調整（消費税）",
  tax_base_sales: "基準期間の課税売上高",
  tax_refund_details: "還付申告の明細書",
  tax_prev_amounts: "前年の確定消費税額",
  income_tax_inputs: "所得税の入力",
  tax_filings: "申告の控え",
  bank_formats: "明細の形式",
  bank_lines: "取り込んだ明細",
  bank_rules: "明細のルール",
  bank_rule_splits: "明細のルールの分け方",
  import_batches: "取り込みの記録",
  holidays: "休業日",
  entry_notes: "付箋",
  month_checks: "月ごとの確認済み",
};

/** 比べない列（帳簿を持っている人・開いている年など、受け渡しで変わるのが当たり前のもの） */
export const IGNORED_COLUMNS: Record<string, string[]> = {
  settings: ["fiscal_year", "schema_version", "holder", "handoff_token", "known_triggers", "holidays_fetched_at"],
  users: ["password_hash"],
};

export type Row = Record<string, unknown>;

export interface TableDiff {
  table: string;
  label: string;
  added: number;
  changed: number;
  removed: number;
}

/** 行の見分け方：主キーの列（無い表は行の中身そのもの。中身が変われば、消えて増えたことになる） */
const keyOf = (pk: string[], r: Row) => JSON.stringify(pk.length ? pk.map((c) => r[c]) : r);

/** 2つの帳簿の同じ表を比べる */
export const diffRows = (pk: string[], before: Row[], after: Row[], ignore: string[] = []) => {
  const strip = (r: Row) => JSON.stringify(Object.entries(r).filter(([k]) => !ignore.includes(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const b = new Map(before.map((r) => [keyOf(pk, r), r]));
  const a = new Map(after.map((r) => [keyOf(pk, r), r]));
  const added: Row[] = [];
  const changed: [Row, Row][] = [];
  const removed: Row[] = [];
  for (const [k, r] of a) {
    const old = b.get(k);
    if (!old) added.push(r);
    else if (strip(old) !== strip(r)) changed.push([old, r]);
  }
  for (const [k, r] of b) if (!a.has(k)) removed.push(r);
  return { added, changed, removed };
};

export interface EntryRow {
  id: number;
  date: string;
  description: string;
  revision: number;
  is_deleted: number;
  is_adjustment?: number;
  created_by: number | null;
  updated_by: number | null;
}
export interface LineRow {
  id: number;
  entry_id: number;
  side: string;
  amount: number;
  [k: string]: unknown;
}

export interface EntryChange {
  id: number;
  kind: "added" | "changed" | "deleted";
  date: string;
  description: string;
  /** 借方の合計 */
  amount: number;
  /** 最後に操作した人（返ってきた帳簿のユーザー） */
  user: string;
}

export const ENTRY_CHANGE_LABEL: Record<EntryChange["kind"], string> = { added: "追加", changed: "訂正", deleted: "削除" };

/**
 * 仕訳ごとの変わったもの（before = 今の帳簿、after = 返ってきた帳簿）。
 * 削除は、削除の印（厳密モード）か、行が無くなったもの（通常モードで消した仕訳）。訂正は、仕訳か明細のどこかが変わったもの
 */
export const entryChanges = (
  before: { entries: EntryRow[]; lines: LineRow[] },
  after: { entries: EntryRow[]; lines: LineRow[] },
  userName: (id: number | null) => string,
): EntryChange[] => {
  const linesOf = (lines: LineRow[]) => {
    const m = new Map<number, string[]>();
    for (const l of [...lines].sort((x, y) => x.id - y.id)) {
      const { id: _id, ...rest } = l;
      void _id;
      m.set(l.entry_id, [...(m.get(l.entry_id) ?? []), JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)))]);
    }
    return m;
  };
  const debit = (lines: LineRow[], id: number) => lines.filter((l) => l.entry_id === id && l.side === "debit").reduce((s, l) => s + l.amount, 0);
  const bl = linesOf(before.lines);
  const al = linesOf(after.lines);
  const b = new Map(before.entries.map((e) => [e.id, e]));
  const out: EntryChange[] = [];
  const row = (e: EntryRow, kind: EntryChange["kind"], lines: LineRow[]): EntryChange => ({
    id: e.id, kind, date: e.date, description: e.description, amount: debit(lines, e.id), user: userName(e.updated_by ?? e.created_by),
  });
  for (const e of after.entries) {
    const old = b.get(e.id);
    if (!old) {
      if (!e.is_deleted) out.push(row(e, "added", after.lines));
      continue;
    }
    if (e.is_deleted && !old.is_deleted) out.push(row(e, "deleted", before.lines));
    else if (!e.is_deleted && (old.is_deleted || e.revision !== old.revision || e.date !== old.date || e.description !== old.description
      || JSON.stringify(al.get(e.id) ?? []) !== JSON.stringify(bl.get(e.id) ?? []))) out.push(row(e, "changed", after.lines));
  }
  const a = new Set(after.entries.map((e) => e.id));
  for (const e of before.entries) if (!a.has(e.id) && !e.is_deleted) out.push({ ...row(e, "deleted", before.lines), user: "" });
  return out.sort((x, y) => x.id - y.id);
};

/** 変わったものの件数の言い方（追加 2件・訂正 1件） */
export const countText = (d: { added: number; changed: number; removed: number }) =>
  [d.added ? `追加 ${d.added}件` : "", d.changed ? `変更 ${d.changed}件` : "", d.removed ? `削除 ${d.removed}件` : ""].filter(Boolean).join("・");
