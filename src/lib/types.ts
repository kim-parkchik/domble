import type { Role } from "./permissions";
import type { DocClass } from "./scan";

/** 勘定科目の区分 */
export type AccountCategory =
  | "asset"      // 資産
  | "liability"  // 負債
  | "equity"     // 資本（元入金・事業主借）
  | "revenue"    // 収益
  | "cogs"       // 売上原価
  | "expense"    // 経費
  | "special";   // 専従者給与など（所得計算の後段）

export type Side = "debit" | "credit";

export interface Account {
  id: number;
  code: string;
  name: string;
  kana: string;
  category: AccountCategory;
  normal_side: Side;
  sort_order: number;
  is_active: number; // 0 / 1
  /** 初期から入っている科目（削除・区分変更はできない） */
  is_system: number; // 0 / 1
  /** 税区分の初期値（null = 決まった初期値。constants/tax.ts の ACCOUNT_TAX_DEFAULTS か区分から） */
  default_tax_code: TaxCode | null;
}

/** 補助科目（例：普通預金 → ○○銀行、売掛金 → 取引先） */
export interface SubAccount {
  id: number;
  account_id: number;
  name: string;
  kana: string;
  sort_order: number;
  is_active: number;
}

export interface JournalLine {
  id?: number;
  entry_id?: number;
  row_no: number;
  side: Side;
  account_id: number;
  sub_account_id: number | null;
  amount: number; // 円（整数）
  memo: string;
  /** 税区分（null = 未設定。免税事業者の期間の仕訳や、消費税に対応する前の仕訳） */
  tax_code?: TaxCode | null;
  /** インボイス区分（課税仕入の明細だけ。それ以外は null） */
  invoice_kind?: InvoiceKind | null;
}

export interface JournalEntry {
  id: number;
  date: string; // YYYY-MM-DD
  description: string;
  /** 取引先（任意） */
  counterparty_id: number | null;
  revision: number;
  is_deleted: number;
  /** 決算整理仕訳か（1 = 決算整理。日付は年度末） */
  is_adjustment: number;
  created_at: string;
  updated_at: string;
  /** 登録した人・最後に変更した人（ユーザー名。ユーザーの機能を入れる前の仕訳は null） */
  created_by_name?: string | null;
  updated_by_name?: string | null;
  lines: JournalLine[];
}

/** 訂正・削除履歴の1件（電子帳簿保存法の「訂正削除履歴」に相当） */
export type HistoryAction = "create" | "update" | "delete";

export interface SnapshotLine {
  side: Side;
  account: string;
  sub: string;
  amount: number;
  memo: string;
  /** 税区分・インボイス区分（入っているときだけ。消費税に対応する前の履歴には無い） */
  tax?: TaxCode;
  invoice?: InvoiceKind;
}

/** 履歴に残す仕訳の写し。科目名は記録時点の名前で保存する */
export interface EntrySnapshot {
  date: string;
  /** 取引先の名前（記録時点。取引先の機能を入れる前の履歴には無い） */
  counterparty?: string;
  /** 決算整理仕訳（決算整理のときだけ true） */
  adjustment?: true;
  lines: SnapshotLine[];
}

export interface HistoryRecord {
  id: number;
  entry_id: number;
  revision: number;
  action: HistoryAction;
  recorded_at: string;
  reason: string;
  snapshot: EntrySnapshot;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 振替伝票の1行（借方・貸方のペア） */
export interface VoucherRow {
  debitAccountId: number | null;
  debitSubId: number | null;
  debitAmount: number | null;
  creditAccountId: number | null;
  creditSubId: number | null;
  creditAmount: number | null;
  memo: string;
  /** 税区分・インボイス区分。null（または無い）= 科目・取引先から決まる初期値に従う */
  debitTax?: TaxCode | null;
  debitInvoice?: InvoiceKind | null;
  creditTax?: TaxCode | null;
  creditInvoice?: InvoiceKind | null;
}

export type FilingType = "blue65" | "blue55" | "blue10" | "white";
/** 課税区分：免税・本則課税・簡易課税・2割特例・3割特例 */
export type TaxStatus = "exempt" | "standard" | "simplified" | "twenty" | "thirty";
/** 経理方式：税込・税抜 */
export type TaxMethod = "inclusive" | "exclusive";
/** 明細の税区分（定義は constants/tax.ts の TAX_CODES） */
export type TaxCode =
  | "none" | "sales10" | "sales8" | "export" | "sales_nontax"
  | "purchase10" | "purchase8" | "purchase_nontax" | "baddebt10" | "baddebt8";
/** インボイス区分：適格請求書あり／経過措置（適格請求書発行事業者以外からの仕入れ）／控除しない */
export type InvoiceKind = "qualified" | "transitional" | "none";

/**
 * 消費税の設定（年度ごと。from_year 以降に適用し、次の設定がある年まで引き継ぐ）
 */
export interface TaxYear {
  from_year: number;
  status: TaxStatus;
  method: TaxMethod;
  /** 簡易課税の主な事業区分（1〜6） */
  business_class: number;
  /** 年の途中から課税事業者になった日（YYYY-MM-DD。空 = その年の初めから） */
  taxable_from: string;
}
/** strict = 電子帳簿保存法（優良な電子帳簿）対応、standard = 通常 */
export type EBookMode = "strict" | "standard";

export interface Settings {
  business_name: string;
  owner_name: string;
  /** 郵便番号（123-4567） */
  postal_code: string;
  address: string;
  /** 適格請求書発行事業者の登録番号（T + 13桁）と登録日（YYYY-MM-DD）。消費税の設定で入れる */
  invoice_no: string;
  invoice_registered_on: string;
  fiscal_year: number;
  filing_type: FilingType;
  industry: string;
  /** 帳簿作成時に決める。null = 未選択。通常 → 厳密 だけは、翌年を始めるときに切り替えられる */
  e_book_mode: EBookMode | null;
  /** 通常 → 厳密に切り替えた帳簿：電子帳簿保存法に対応を始めた年（最初から厳密なら null = 全部の年が対応） */
  strict_from_year: number | null;
  /** 切り替えた日時 */
  strict_switched_at: string | null;
}

/** 期首残高: account_id → 金額（科目の正常残高側をプラスとする。補助科目の分も合算） */
export type OpeningBalances = Record<number, number>;

/** 補助科目ごとの期首残高: "科目ID:補助ID" → 金額（補助ID 0 は「補助なし」） */
export type SubOpeningBalances = Record<string, number>;
export const subKey = (accountId: number, subId: number | null) => `${accountId}:${subId ?? 0}`;

/** 科目・補助科目・期首残高の変更履歴 */
export interface MasterHistoryRecord {
  id: number;
  target_type: "account" | "sub" | "opening" | "homeuse" | "closing" | "counterparty" | "user" | "setting" | "asset";
  target_id: number;
  /** close / unlock は年度の締め（target_type = closing、target_id = 年度） */
  action: "create" | "rename" | "hide" | "show" | "delete" | "change" | "close" | "unlock";
  fiscal_year: number;
  label: string;
  old_value: string;
  new_value: string;
  recorded_at: string;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 家事按分の設定（その年度に有効なもの） */
export type HomeUseMethod = "entry" | "yearend";
export interface HomeUseRate {
  account_id: number;
  from_year: number;
  /** 事業で使っている割合（%） */
  rate: number;
  method: HomeUseMethod;
  basis: string;
}

/** 証憑 */
export type EvidenceKind = "electronic" | "scan";
/** 利用者が入力・訂正できる項目 */
export interface EvidenceMeta {
  doc_type: string;
  /** 取引年月日 */
  txn_date: string;
  /** 取引金額（円） */
  amount: number;
  /** 取引先 */
  counterparty: string;
  memo: string;
  /** 受領日（受け取った日。任意。空なら記録なし。スキャナ保存では必須） */
  received_date?: string;
  /** スキャナ保存の書類の区分（重要書類／一般書類）。電子取引は空 */
  doc_class?: DocClass | "";
}
export interface Evidence extends EvidenceMeta {
  id: number;
  /** 取引先一覧の取引先（取引先名が一覧の名前と一致したときに入る。任意） */
  counterparty_id: number | null;
  kind: EvidenceKind;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  revision: number;
  is_void: number;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  /** ひも付いている仕訳の伝票番号 */
  entry_ids: number[];
  /** スキャナ保存：取り込んだときの画質の確認（JSON。電子取引は空） */
  scan_info: string;
  /** 取り込んだ日時（厳密モードでは登録時の履歴から。スキャナ保存の入力期間の確認に使う） */
  registered_at: string;
}
/** 証憑の履歴に残す写し */
export interface EvidenceSnapshot extends EvidenceMeta {
  kind: EvidenceKind;
  file_name: string;
  mime: string;
  size: number;
  sha256: string;
  entry_ids: number[];
}
export type EvidenceAction = "create" | "update" | "void" | "link" | "unlink";
export interface EvidenceHistoryRecord {
  id: number;
  evidence_id: number;
  revision: number;
  action: EvidenceAction;
  recorded_at: string;
  reason: string;
  snapshot: EvidenceSnapshot;
  /** 操作したユーザー */
  user_name?: string | null;
}

/** 取引先（任意で使う）。仕訳1件に1つ、証憑にも付けられる */
export interface Counterparty {
  id: number;
  name: string;
  kana: string;
  /** 適格請求書発行事業者の登録番号（T + 13桁。無ければ空） */
  invoice_no: string;
  /** 1 = 適格請求書発行事業者ではない（免税事業者など）。この取引先からの課税仕入は初期値が「経過措置」になる */
  not_registered: number;
  memo: string;
  is_active: number;
}

/** 年度の締め（行があれば締め済み） */
export interface FiscalClosing {
  fiscal_year: number;
  period_start: string;
  period_end: string;
  closed_at: string;
  /** 締めたときの記録の連鎖の先頭（確認コードのもと。厳密モードのみ） */
  chain_head: string;
}

/** ユーザー（権限はまだ分けない。誰が操作したかを記録するため） */
export interface User {
  id: number;
  name: string;
  /** パスワードを設定しているか */
  has_password: number;
  /** 権限（lib/permissions.ts） */
  role: Role;
  /** 備考（担当・連絡先など。任意） */
  memo: string;
  is_active: number;
  created_at: string;
}

export interface AccessLogRecord {
  id: number;
  user_id: number;
  user_name: string;
  action: "login" | "logout";
  recorded_at: string;
}
