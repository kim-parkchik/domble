/**
 * データベース定義
 *
 * 方針
 *  - 金額はすべて INTEGER（円）。浮動小数点は使わない
 *  - 仕訳は物理削除しない。削除は「削除済み」の印をつけるだけ（論理削除）
 *  - 登録・訂正・削除のたびに、その時点の仕訳の写しを entry_history に積み上げる
 *  - entry_history はトリガーで「書き換え・削除不可」にしている
 *    （電子帳簿保存法の「訂正・削除の事実と内容を確認できること」を意識した作り）
 *  - ただし SQLite ファイル自体を外部ツールで直接いじることは防げない。
 *    ここは「ソフトとして保証できる範囲」と「保存要件」の差として研究上の論点になる
 */

// ── 締め済みの年度への書き込みを拒否するトリガー ──
// 画面側（repo.ts）でも先に確認するが、ここが最後の砦。メッセージは repo.ts の CLOSED_MESSAGE と揃える
const CLOSED_MSG = "締め済みの年度は変更できません";
/** 電子帳簿保存法に対応した保存方式（厳密モード）の帳簿か */
const STRICT_MODE = "(SELECT e_book_mode FROM settings WHERE id = 1) = 'strict'";
const dateClosed = (date: string) =>
  `EXISTS (SELECT 1 FROM fiscal_closings c WHERE ${date} BETWEEN c.period_start AND c.period_end)`;
const entryClosed = (entryId: string) => dateClosed(`(SELECT e.date FROM journal_entries e WHERE e.id = ${entryId})`);
/** 年度が12月まで締めてある（年の締め）。月の締めだけなら、年度ごとのもの（期首残高・家事按分など）は止めない */
const yearClosed = (year: string) => `EXISTS (SELECT 1 FROM fiscal_closings c WHERE c.fiscal_year = ${year} AND c.period_end = (${year} || '-12-31'))`;

const guard = (name: string, timing: "INSERT" | "UPDATE" | "DELETE", table: string, when: string) =>
  `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${timing} ON ${table} WHEN ${when}
   BEGIN SELECT RAISE(ABORT, '${CLOSED_MSG}'); END;`;

/**
 * 年度で区切られるテーブルごとに、INSERT / UPDATE / DELETE を止める
 * （月の締めに対応したときに条件を変えたので、名前に _y をつけて作り直した。古い名前は RETIRED_TRIGGERS）
 */
const YEAR_GUARD_PREFIXES = [
  "trg_closed_opening", "trg_closed_homeuse_rates", "trg_closed_homeuse_runs", "trg_closed_master_names",
  "trg_closed_depreciation_runs", "trg_closed_statement_notes",
];
const yearGuards = (prefix: string, table: string, col: string) => [
  guard(`${prefix}_y_ins`, "INSERT", table, yearClosed(`NEW.${col}`)),
  guard(`${prefix}_y_upd`, "UPDATE", table, `${yearClosed(`OLD.${col}`)} OR ${yearClosed(`NEW.${col}`)}`),
  guard(`${prefix}_y_del`, "DELETE", table, yearClosed(`OLD.${col}`)),
];

// 固定資産：台帳に出る年（使い始めた年〜売却・除却した年。一括償却資産は3年目まで。売っていなければ 9999）に年の締めをした年があるか
// （lib/depreciation.ts の assetYears・assetLockError と同じ条件）
const yearOfCol = (col: string) => `CAST(substr(${col}, 1, 4) AS INTEGER)`;
const assetEnd = (t: string) =>
  `CASE WHEN ${t}.disposed_on IS NULL THEN 9999 ELSE MAX(${yearOfCol(`${t}.disposed_on`)}, CASE WHEN ${t}.method = 'lump3' THEN ${yearOfCol(`${t}.used_on`)} + 2 ELSE 0 END) END`;
const assetClosed = (t: string, extra = "") =>
  `EXISTS (SELECT 1 FROM fiscal_closings c WHERE c.period_end = (c.fiscal_year || '-12-31')
     AND c.fiscal_year BETWEEN ${yearOfCol(`${t}.used_on`)} AND ${assetEnd(t)}${extra})`;
/** 締めた年にかかる資産で変えられない列（売却・除却の日と事業専用割合は別に見る） */
const ASSET_LOCKED_COLUMNS = ["name", "account_id", "acquired_on", "used_on", "cost", "method", "useful_life", "opening_year", "opening_book_value", "memo", "income_kind"];
const disposedFrom = `MIN(COALESCE(${yearOfCol("OLD.disposed_on")}, 9999), COALESCE(${yearOfCol("NEW.disposed_on")}, 9999))`;
/** 売却・除却の日・区分・売却額のどれかが変わったか */
const disposalChanged = "(OLD.disposed_on IS NOT NEW.disposed_on OR OLD.disposal_kind IS NOT NEW.disposal_kind OR OLD.sale_price IS NOT NEW.sale_price)";
/** 事業専用割合を変えた年の行 R が、締めた年の割合を変えるか（R の年から、次に変えた年の前までに締めた年がある） */
const assetRateClosed = (r: string) =>
  `EXISTS (SELECT 1 FROM fiscal_closings c JOIN fixed_assets a ON a.id = ${r}.asset_id
     WHERE c.period_end = (c.fiscal_year || '-12-31') AND c.fiscal_year >= ${r}.from_year AND c.fiscal_year <= ${assetEnd("a")}
       AND NOT EXISTS (SELECT 1 FROM asset_rates x WHERE x.asset_id = ${r}.asset_id AND x.from_year > ${r}.from_year AND x.from_year <= c.fiscal_year))`;

/**
 * 「何年から」で持つ設定：行を足す・変える・消すと、その年から次に設定を変えた年の前まで設定が変わる。
 * その間に年の締めをした年があれば止める（lib/closing.ts の inheritingClosedYears と同じ条件）。値の変わらない UPDATE は通す
 *  keys：同じ設定の行をまとめる列（科目ごとなど）、values：設定の値の列
 */
const inheritGuards = (prefix: string, table: string, keys: string[], values: string[]) => {
  const covers = (r: string) =>
    `EXISTS (SELECT 1 FROM fiscal_closings c WHERE c.period_end = (c.fiscal_year || '-12-31') AND c.fiscal_year >= ${r}.from_year
       AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE ${[...keys.map((k) => `x.${k} = ${r}.${k}`), `x.from_year > ${r}.from_year`, "x.from_year <= c.fiscal_year"].join(" AND ")}))`;
  const changed = [...keys, "from_year", ...values].map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
  return [
    guard(`${prefix}_i_ins`, "INSERT", table, covers("NEW")),
    guard(`${prefix}_i_upd`, "UPDATE", table, `(${changed}) AND (${covers("OLD")} OR ${covers("NEW")})`),
    guard(`${prefix}_i_del`, "DELETE", table, covers("OLD")),
  ];
};

const CLOSED_TRIGGERS: string[] = [
  // 仕訳：日付で判定（訂正で日付を締め済みの年度へ動かす／から動かすのも不可）
  guard("trg_closed_entries_ins", "INSERT", "journal_entries", dateClosed("NEW.date")),
  guard("trg_closed_entries_upd", "UPDATE", "journal_entries", `${dateClosed("OLD.date")} OR ${dateClosed("NEW.date")}`),
  guard("trg_closed_entries_del", "DELETE", "journal_entries", dateClosed("OLD.date")),
  // 明細：親の仕訳の日付で判定
  guard("trg_closed_lines_ins", "INSERT", "journal_lines", entryClosed("NEW.entry_id")),
  guard("trg_closed_lines_upd", "UPDATE", "journal_lines", `${entryClosed("OLD.entry_id")} OR ${entryClosed("NEW.entry_id")}`),
  guard("trg_closed_lines_del", "DELETE", "journal_lines", entryClosed("OLD.entry_id")),
  // 期首残高・家事按分・年度ごとの科目名
  ...yearGuards("trg_closed_opening", "opening_balances", "fiscal_year"),
  ...yearGuards("trg_closed_homeuse_rates", "home_use_rates", "from_year"),
  ...yearGuards("trg_closed_homeuse_runs", "home_use_runs", "fiscal_year"),
  ...yearGuards("trg_closed_depreciation_runs", "depreciation_runs", "fiscal_year"),
  ...yearGuards("trg_closed_allowance_runs", "allowance_runs", "fiscal_year"),
  ...yearGuards("trg_closed_statement_notes", "statement_notes", "fiscal_year"),
  ...yearGuards("trg_closed_master_names", "master_names", "from_year"),
  ...yearGuards("trg_closed_tax_years", "tax_years", "from_year"),
  ...yearGuards("trg_closed_filing_years", "filing_years", "from_year"),
  ...yearGuards("trg_closed_tax_interims", "tax_interims", "fiscal_year"),
  ...yearGuards("trg_closed_tax_return_inputs", "tax_return_inputs", "fiscal_year"),
  ...yearGuards("trg_closed_tax_base_sales", "tax_base_sales", "fiscal_year"),
  ...yearGuards("trg_closed_tax_inventory_adjusts", "tax_inventory_adjusts", "fiscal_year"),
  ...yearGuards("trg_closed_tax_refund_details", "tax_refund_details", "fiscal_year"),
  ...yearGuards("trg_closed_asset_amortizations", "asset_amortizations", "fiscal_year"),
  ...yearGuards("trg_closed_year_end_runs", "year_end_runs", "fiscal_year"),
  ...yearGuards("trg_closed_inventory_counts", "inventory_counts", "fiscal_year"),
  ...yearGuards("trg_closed_tax_prev_amounts", "tax_prev_amounts", "fiscal_year"),
  ...yearGuards("trg_closed_income_tax_inputs", "income_tax_inputs", "fiscal_year"),
  // 固定資産台帳：締めた年に台帳に出る資産の追加・削除、売却・除却の日と事業専用割合のほかの変更、締めた年にかかる売却・除却の日の変更
  guard("trg_closed_assets_ins", "INSERT", "fixed_assets", assetClosed("NEW")),
  guard("trg_closed_assets_del", "DELETE", "fixed_assets", assetClosed("OLD")),
  // 売却・除却の区分と売却額を足したときに条件を変えたので、名前に _2 をつけて作り直した（古い名前は RETIRED_TRIGGERS）
  guard("trg_closed_assets_upd_2", "UPDATE", "fixed_assets",
    `(${assetClosed("OLD")} AND (${ASSET_LOCKED_COLUMNS.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}
       OR (${disposalChanged} AND (${assetClosed("OLD", ` AND c.fiscal_year >= ${disposedFrom}`)} OR ${assetClosed("NEW", ` AND c.fiscal_year >= ${disposedFrom}`)}))
       OR (OLD.business_rate IS NOT NEW.business_rate
           AND ${assetClosed("OLD", " AND NOT EXISTS (SELECT 1 FROM asset_rates x WHERE x.asset_id = OLD.id AND x.from_year <= c.fiscal_year)")})))
     OR (${assetClosed("NEW")} AND NOT ${assetClosed("OLD")})`),
  guard("trg_closed_asset_rates_ins", "INSERT", "asset_rates", assetRateClosed("NEW")),
  guard("trg_closed_asset_rates_upd", "UPDATE", "asset_rates", `${assetRateClosed("OLD")} OR ${assetRateClosed("NEW")}`),
  guard("trg_closed_asset_rates_del", "DELETE", "asset_rates", assetRateClosed("OLD")),
  // 「何年から」の設定：締めた年が引き継いでいる設定は変えられない
  // 年の途中から課税事業者になった日（taxable_from）は、その年だけのもので引き継がない
  ...inheritGuards("trg_closed_tax_years", "tax_years", [], ["status", "method", "business_class", "deduction", "voluntary_interim"]),
  ...inheritGuards("trg_closed_filing_years", "filing_years", [], ["filing_type"]),
  ...inheritGuards("trg_closed_homeuse_rates", "home_use_rates", ["account_id"], ["rate", "method", "basis"]),
  ...inheritGuards("trg_closed_master_names", "master_names", ["target_type", "target_id"], ["name"]),
  ...inheritGuards("trg_closed_account_lines", "account_lines", ["account_id"], ["line"]),
  ...inheritGuards("trg_closed_real_estate_years", "real_estate_years", [], ["scale"]),
];

/**
 * 作り直したために使わなくなったトリガー。開いたときに消す（消されていたかの確認 repo.checkTriggers では数えない）
 */
export const RETIRED_TRIGGERS = [
  "trg_settings_mode_fixed",
  // 通常モードでも証憑の履歴を残すようにしたとき、削除の止め方を厳密モードだけにした（_s）
  "trg_evidence_history_no_delete", "trg_evidences_no_delete", "trg_evidence_files_no_delete",
  // 固定資産に売却・除却の区分と売却額を足したとき
  "trg_closed_assets_upd",
  ...YEAR_GUARD_PREFIXES.flatMap((p) => ["ins", "upd", "del"].map((x) => `${p}_${x}`)),
];

export const SCHEMA: string[] = [
  ...RETIRED_TRIGGERS.map((n) => `DROP TRIGGER IF EXISTS ${n};`),
  `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    business_name TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    fiscal_year INTEGER NOT NULL,
    filing_type TEXT NOT NULL DEFAULT 'blue65',
    tax_status TEXT NOT NULL DEFAULT 'exempt',   -- 使わなくなった列（消費税の設定は年度ごとの tax_years へ）
    tax_method TEXT NOT NULL DEFAULT 'inclusive',
    e_book_mode TEXT CHECK (e_book_mode IN ('strict','standard')),  -- 電子帳簿保存法モード。NULL = 未選択
    schema_version INTEGER NOT NULL DEFAULT 2
  );`,

  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kana TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_system INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE TABLE IF NOT EXISTS sub_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kana TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (account_id, name)
  );`,

  `CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 伝票番号。欠番になっても再利用しない
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,   -- 訂正のたびに +1
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    deleted_at TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    row_no INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('debit','credit')),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    sub_account_id INTEGER REFERENCES sub_accounts(id),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    memo TEXT NOT NULL DEFAULT '',
    tax_code TEXT          -- 税区分（lib/tax.ts。NULL = 未設定：免税事業者の期間の仕訳、消費税に対応する前の仕訳）
  );`,

  /** 訂正・削除履歴。snapshot はその時点の仕訳（科目名つき）の JSON */
  `CREATE TABLE IF NOT EXISTS entry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    reason TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    UNIQUE (entry_id, revision)
  );`,

  `CREATE TABLE IF NOT EXISTS opening_balances (
    fiscal_year INTEGER NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    sub_account_id INTEGER NOT NULL DEFAULT 0,  -- 0 = 補助なしの部分
    amount INTEGER NOT NULL,
    PRIMARY KEY (fiscal_year, account_id, sub_account_id)
  );`,

  /**
   * 科目・補助科目の名前を年度ごとに持つ（厳密モードのみ使用）
   * from_year 以降はこの名前。無ければ accounts / sub_accounts の name（作成時の名前）
   */
  `CREATE TABLE IF NOT EXISTS master_names (
    target_type TEXT NOT NULL CHECK (target_type IN ('account','sub')),
    target_id INTEGER NOT NULL,
    from_year INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (target_type, target_id, from_year)
  );`,

  /** 科目・補助科目・期首残高の変更履歴（厳密モードのみ記録）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS master_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,       -- account / sub / opening
    target_id INTEGER NOT NULL,
    action TEXT NOT NULL,            -- create / rename / hide / show / delete / change
    fiscal_year INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',  -- 対象の表示名（記録時点）
    old_value TEXT NOT NULL DEFAULT '',
    new_value TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 家事按分の設定（科目ごと・年度ごと。from_year 以降に適用）
   * rate = 事業で使っている割合（%）。100 = 按分しない
   * method = entry（入力時に分ける）/ yearend（年末にまとめて振り替える）
   */
  `CREATE TABLE IF NOT EXISTS home_use_rates (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    from_year INTEGER NOT NULL,
    rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 100),
    method TEXT NOT NULL CHECK (method IN ('entry','yearend')),
    basis TEXT NOT NULL DEFAULT '',   -- 按分の根拠（例：床面積 20㎡ / 60㎡）
    PRIMARY KEY (account_id, from_year)
  );`,

  /**
   * 消費税の設定（年度ごと。from_year 以降に適用し、次の設定がある年まで引き継ぐ。計算は lib/tax.ts）
   * status：exempt（免税）/ standard（本則）/ simplified（簡易）/ twenty（2割特例）/ thirty（3割特例）
   * taxable_from：年の途中から課税事業者になった日（空 = その年の初めから）
   * deduction：本則課税で課税売上割合が 95% 未満のときの控除の方式（individual 個別対応方式 / lump 一括比例配分方式）
   * voluntary_interim：任意の中間申告書を提出する旨の届出をしているか（1 = している。lib/taxInterim.ts）
   */
  `CREATE TABLE IF NOT EXISTS tax_years (
    from_year INTEGER PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('exempt','standard','simplified','twenty','thirty')),
    method TEXT NOT NULL DEFAULT 'inclusive' CHECK (method IN ('inclusive','exclusive')),
    business_class INTEGER NOT NULL DEFAULT 5 CHECK (business_class BETWEEN 1 AND 6),
    taxable_from TEXT NOT NULL DEFAULT '',
    deduction TEXT NOT NULL DEFAULT 'individual' CHECK (deduction IN ('individual','lump')),
    voluntary_interim INTEGER NOT NULL DEFAULT 0 CHECK (voluntary_interim IN (0, 1))
  );`,

  /**
   * 申告の種類（年度ごと。from_year 以降に適用し、次の設定がある年まで引き継ぐ。lib/filing.ts）
   * 行の無い年は、帳簿を作ったときの設定（settings.filing_type）
   */
  `CREATE TABLE IF NOT EXISTS filing_years (
    from_year INTEGER PRIMARY KEY,
    filing_type TEXT NOT NULL CHECK (filing_type IN ('blue65','blue55','blue10','white'))
  );`,

  /**
   * 青色申告決算書で書く欄（科目ごと。from_year 以降に適用し、次の設定がある年まで引き継ぐ）。line = '' は科目名から自動
   * 行の無い年は accounts.statement_line（年ごとにする前の設定）
   */
  `CREATE TABLE IF NOT EXISTS account_lines (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    from_year INTEGER NOT NULL,
    line TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, from_year)
  );`,

  /**
   * 不動産所得の有無と規模（年度ごと。from_year 以降に適用し、次の設定がある年まで引き継ぐ）。none / small（事業的規模でない）/ business（事業的規模）
   * 行の無い年は settings.real_estate（年ごとにする前の設定）
   */
  `CREATE TABLE IF NOT EXISTS real_estate_years (
    from_year INTEGER PRIMARY KEY,
    scale TEXT NOT NULL CHECK (scale IN ('none','small','business'))
  );`,

  /** 消費税の申告書で書き込む額（年度ごと）。nontax_export = 非課税資産の輸出等の金額（本則課税の付表2-3 ③） */
  `CREATE TABLE IF NOT EXISTS tax_return_inputs (
    fiscal_year INTEGER PRIMARY KEY,
    nontax_export INTEGER NOT NULL DEFAULT 0 CHECK (nontax_export >= 0)
  );`,

  /** 消費税の中間納付税額（年度ごと。申告した税額。消費税＝国税分と地方消費税＝譲渡割額） */
  `CREATE TABLE IF NOT EXISTS tax_interims (
    fiscal_year INTEGER PRIMARY KEY,
    national INTEGER NOT NULL DEFAULT 0 CHECK (national >= 0),
    local INTEGER NOT NULL DEFAULT 0 CHECK (local >= 0)
  );`,

  /**
   * 基準期間の課税売上高を手で入れた額（申告する年ごと。lib/baseSales.ts）。
   * 基準期間（前々年）の帳簿が domble に無いとき、または帳簿の計算の代わりに使いたいときだけ。入っていれば帳簿の計算より優先する
   */
  /**
   * 消費税の棚卸資産の調整（本則課税の付表2-3 ⑯。申告する年ごと。lib/taxReturn.ts の InventoryAdjust）。
   * direction：add 加算（免税から課税になった年）／ sub 減算（課税から免税になる前の年）。rows：税率・控除できる割合・取得価額（税込）の JSON
   */
  `CREATE TABLE IF NOT EXISTS tax_inventory_adjusts (
    fiscal_year INTEGER PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('add', 'sub')),
    rows TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS tax_base_sales (
    fiscal_year INTEGER PRIMARY KEY,
    amount INTEGER NOT NULL CHECK (amount >= 0)
  );`,

  /** 消費税の還付申告に関する明細書（個人事業者用）の入力（年度ごと。JSON。中身は lib/taxRefundDetail.ts の TaxRefundDetailInput） */
  `CREATE TABLE IF NOT EXISTS tax_refund_details (
    fiscal_year INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );`,

  /**
   * 中間申告の判定に使う前年の確定消費税額（⑨）を手で入れた額（中間申告をする年ごと。lib/taxInterim.ts）。
   * 前年の帳簿が domble に無いとき、または修正申告などで帳簿の計算と違うときだけ。入っていれば帳簿の計算より優先する
   */
  `CREATE TABLE IF NOT EXISTS tax_prev_amounts (
    fiscal_year INTEGER PRIMARY KEY,
    amount INTEGER NOT NULL CHECK (amount >= 0)
  );`,

  /**
   * 所得税の申告書に入れる、帳簿から出せないもの（年度ごと。給与・公的年金等・雑所得、所得控除、配偶者・扶養親族、予定納税額など）。
   * data は JSON（形は lib/incomeTax.ts の IncomeTaxInput。保存の前に normalizeIncomeTaxInput で確かめる）。個人番号は持たない
   */
  `CREATE TABLE IF NOT EXISTS income_tax_inputs (
    fiscal_year INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );`,

  /** 年末の按分振替で作った仕訳（年度ごとに1本。作り直すときはこの仕訳を訂正する） */
  `CREATE TABLE IF NOT EXISTS home_use_runs (
    fiscal_year INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id)
  );`,

  /**
   * 固定資産台帳（減価償却する資産）。計算は lib/depreciation.ts
   * 資産を買った仕訳（工具器具備品 / 普通預金 など）は、ふつうに振替伝票で入れる。台帳は年末の償却の計算に使う
   */
  `CREATE TABLE IF NOT EXISTS fixed_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    acquired_on TEXT NOT NULL,          -- 取得日
    used_on TEXT NOT NULL,              -- 事業に使い始めた日（償却はこの月から）
    cost INTEGER NOT NULL CHECK (cost > 0),
    method TEXT NOT NULL CHECK (method IN ('straight','declining','lump3','small','deferred')),
    useful_life INTEGER NOT NULL DEFAULT 0,
    business_rate INTEGER NOT NULL DEFAULT 100 CHECK (business_rate BETWEEN 0 AND 100),
    opening_year INTEGER,               -- domble を使う前から持っている資産：この年の期首の未償却残高から始める
    opening_book_value INTEGER,
    disposed_on TEXT,                   -- 売却・除却した日
    memo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /** 事業専用割合を、あとの年から変えたもの（その年から。前の年の割合はそのまま。使い始めた年からの割合は fixed_assets.business_rate） */
  `CREATE TABLE IF NOT EXISTS asset_rates (
    asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
    from_year INTEGER NOT NULL,
    rate INTEGER NOT NULL CHECK (rate BETWEEN 0 AND 100),
    PRIMARY KEY (asset_id, from_year)
  );`,

  /** 固定資産台帳から作った売却・除却の仕訳（資産ごとに1本。作り直すときはこの仕訳を訂正する）。receive_account_id = 売却額を受け取った科目 */
  `CREATE TABLE IF NOT EXISTS asset_disposals (
    asset_id INTEGER PRIMARY KEY REFERENCES fixed_assets(id),
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    receive_account_id INTEGER REFERENCES accounts(id)
  );`,

  /** 繰延資産（任意償却）の、年ごとに決めた償却する額（決めていない年は60か月の均等償却。lib/depreciation.ts） */
  `CREATE TABLE IF NOT EXISTS asset_amortizations (
    asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
    fiscal_year INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (asset_id, fiscal_year)
  );`,

  /** 年末の減価償却で作った仕訳（年度ごとに1本。作り直すときはこの仕訳を訂正する） */
  `CREATE TABLE IF NOT EXISTS depreciation_runs (
    fiscal_year INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id)
  );`,

  /**
   * 決算整理の画面から作った仕訳（年度・種類ごとに1本。作り直すときはこの仕訳を訂正する。lib/yearEnd.ts）
   *  kind：inventory = 棚卸の振替 ／ accrued_tax = 未払消費税等（還付なら未収）
   */
  `CREATE TABLE IF NOT EXISTS year_end_runs (
    fiscal_year INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('inventory','accrued_tax')),
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    PRIMARY KEY (fiscal_year, kind)
  );`,

  /** 棚卸（年度ごと）：棚卸表が無いときの期末の棚卸高と、棚卸表（品名・数量・単価の JSON） */
  `CREATE TABLE IF NOT EXISTS inventory_counts (
    fiscal_year INTEGER PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
    rows TEXT NOT NULL DEFAULT '[]'
  );`,

  /** 決算整理仕訳から作った、翌年1月1日付の振り戻しの仕訳（元の仕訳ごとに1本） */
  `CREATE TABLE IF NOT EXISTS entry_reversals (
    entry_id INTEGER PRIMARY KEY REFERENCES journal_entries(id),
    reversal_id INTEGER NOT NULL REFERENCES journal_entries(id)
  );`,

  /** 年末の貸倒引当金（洗替：前年分の戻入と本年分の繰入）で作った仕訳（年度ごとに1本。作り直すときはこの仕訳を訂正する） */
  `CREATE TABLE IF NOT EXISTS allowance_runs (
    fiscal_year INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id)
  );`,

  /**
   * 決算書（2〜3ページ）に手で書き込む欄（年齢・従事月数・支払先の住所・賃借物件・特殊事情など）。
   * 帳簿から出せない項目だけ。note_key は「欄の種類:行:項目」（例 rent:cp:3:address）
   */
  `CREATE TABLE IF NOT EXISTS statement_notes (
    fiscal_year INTEGER NOT NULL,
    note_key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (fiscal_year, note_key)
  );`,

  /**
   * 取引先（任意で使う）。仕訳1件に1つ（journal_entries.counterparty_id）、証憑にも付けられる
   * 補助科目とは別に持つ：同じ相手が売掛金にも外注工賃にも出てくるため。登録番号（インボイス）もここに持つ
   */
  `CREATE TABLE IF NOT EXISTS counterparties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kana TEXT NOT NULL DEFAULT '',
    invoice_no TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 年度の締め。行がある年度は「締め済み」。解除すると行を消す（厳密モードでは master_history に記録）
   * 期間の開始日・終了日を持つのは、法人の任意の会計期間にも同じ仕組みで対応するため
   */
  /**
   * 締め（年度ごとに1行）。period_end までの仕訳は変更できない
   *  - 月の締め：period_end = その月の末日（例 9月まで → 09-30）
   *  - 年の締め：period_end = 12月31日。期首残高・家事按分など年度ごとのものも止める
   */
  `CREATE TABLE IF NOT EXISTS fiscal_closings (
    fiscal_year INTEGER PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    closed_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 証憑（領収書・請求書などの PDF / 画像）
   *  - 取引年月日・取引金額・取引先は、電子取引データの検索要件の項目。仕訳とは別に証憑そのものに持つ
   *  - kind：electronic = 電子取引データ（メールで受け取った PDF など）／ scan = スキャナ保存（紙を読み取ったもの。タイムスタンプは付けないので、紙の原本も保存してもらう。lib/scan.ts）
   *  - ファイルの中身・名前・ハッシュは、登録したあと変えられない（差し替えるときは新しく登録して古い方を無効にする）
   *  - 登録・訂正・無効・ひも付けは、どちらの保存方式でも evidence_history に残す（電子取引データの保存は、帳簿の保存方式によらない義務のため）
   *  - 厳密モードでは削除できない（無効の印をつけるだけ）。通常モードでは本当に削除もできる（履歴も消え、削除したことを evidence_deletions に残す）
   */
  `CREATE TABLE IF NOT EXISTS evidences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 証憑番号。欠番になっても再利用しない
    kind TEXT NOT NULL DEFAULT 'electronic' CHECK (kind IN ('electronic','scan')),
    doc_type TEXT NOT NULL DEFAULT '',
    txn_date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    counterparty TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,                  -- ファイルの SHA-256（16進）。改ざんの確認用
    revision INTEGER NOT NULL DEFAULT 1,
    is_void INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    voided_at TEXT
  );`,

  /**
   * 証憑のファイル本体（base64 の文字列）
   * 画面との受け渡しが JSON のため、BLOB ではなく文字列で持つ。一覧の読み込みを軽くするため別テーブル
   */
  `CREATE TABLE IF NOT EXISTS evidence_files (
    evidence_id INTEGER PRIMARY KEY REFERENCES evidences(id),
    data TEXT NOT NULL
  );`,

  /** 証憑と仕訳のひも付け（多対多：請求書1枚を分割で払う、1つの仕訳に請求書と領収書、など） */
  `CREATE TABLE IF NOT EXISTS evidence_links (
    evidence_id INTEGER NOT NULL REFERENCES evidences(id),
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    PRIMARY KEY (evidence_id, entry_id)
  );`,

  /** 証憑の履歴（厳密モードのみ記録）。snapshot はその時点の項目・ハッシュ・ひも付け先の JSON。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS evidence_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL REFERENCES evidences(id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update','void','link','unlink')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    reason TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    UNIQUE (evidence_id, revision)
  );`,

  /**
   * 削除した証憑の記録（通常モードで本当に削除したとき。ファイルと履歴は消えるので、削除したことと最後の内容だけを残す）
   *  snapshot：削除する前の項目（evidence_history の snapshot と同じ形）、history_count：消した履歴の件数
   */
  `CREATE TABLE IF NOT EXISTS evidence_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    reason TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    history_count INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id)
  );`,

  /**
   * 記録の連鎖（ハッシュチェーン）。厳密モードで履歴を1件書くたびに1行積む。仕組みは lib/integrity.ts
   *  - content_hash：履歴の1行の中身のハッシュ
   *  - state_key / state_hash：変更後の状態（entry:伝票番号、evidence:証憑番号、opening:年度、closing:年度）のハッシュ
   *  - row_hash：1つ前の row_hash を含めたハッシュ（途中を書き換えると先が合わなくなる）
   */
  `CREATE TABLE IF NOT EXISTS audit_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    state_key TEXT NOT NULL DEFAULT '',
    state_hash TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /** 検知した出来事（トリガーが消されていた、など）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS integrity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * ユーザー（権限はまだ分けない。誰が操作したかを記録するため）
   * password_hash：空ならパスワードなし。形式は lib/password.ts（PBKDF2-SHA256）
   * 操作した人は、履歴（entry_history など）の user_id と、仕訳・証憑の created_by / updated_by に残る
   */
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /** 利用の記録（ログイン・ログアウト）。書き換え・削除不可 */
  `CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('login','logout')),
    recorded_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 保存中の目印。書き込みのトランザクションを始める前に置き、終わったら消す（repo.ts の tx）
   * 残っていたら、前回は保存の途中でソフトが止まった（書きかけは SQLite が取り消している）
   */
  `CREATE TABLE IF NOT EXISTS pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    user_id INTEGER,
    started_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 定型仕訳（よく使う仕訳を名前をつけて保存し、振替伝票に呼び出す）
   * rows：振替伝票の行（VoucherRow）の JSON。金額は空でもよい。帳簿そのものではないので履歴には残さない
   */
  `CREATE TABLE IF NOT EXISTS journal_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    rows TEXT NOT NULL,
    counterparty_id INTEGER REFERENCES counterparties(id),
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,

  /**
   * 銀行・カードの明細の取り込み（lib/bankImport.ts）。どれも帳簿そのものではないので履歴には残さない（仕訳にしたときに仕訳の履歴に残る）
   * 口座は科目と補助科目（補助なしは 0）。仕訳・科目を消しても困らないよう、外部キーは張らない
   *  - bank_formats：口座ごとの CSV の列の対応（ColumnMap の JSON）
   *  - bank_lines：読み込んだ明細。status は pending（未登録）/ done（仕訳にした。entry_id）/ skipped（取り込まない）。
   *    fingerprint（日付・増減・金額・摘要と何個目か）が同じ明細は2回入れない
   *  - bank_rules：摘要に keyword を含む明細に入れる相手科目など（direction：increase / decrease / any。target_account_id が NULL ならどの口座にも）
   *  - bank_rule_splits：ルールの分け方（決まった額を別の相手科目に。bank_rules の相手科目には残りの額が入る。ルールを消すときに一緒に消す）
   */
  /**
   * 取り込みの記録（仕訳の CSV 取り込み・明細の登録を1回ごとに。まとめて削除するときに使う）
   *  - import_batches：kind は journal（仕訳の CSV）/ bank（銀行・カードの明細）、source はファイル名や口座、user_id は操作した人
   *  - import_batch_entries：その取り込みで登録した仕訳（仕訳を削除しても行は残す。残っている数は仕訳と合わせて数える）
   */
  `CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('journal','bank')),
    source TEXT NOT NULL DEFAULT '',
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime'))
  );`,
  `CREATE TABLE IF NOT EXISTS import_batch_entries (
    batch_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    PRIMARY KEY (batch_id, entry_id)
  );`,

  `CREATE TABLE IF NOT EXISTS bank_formats (
    account_id INTEGER NOT NULL,
    sub_account_id INTEGER NOT NULL DEFAULT 0,
    mapping TEXT NOT NULL,
    PRIMARY KEY (account_id, sub_account_id)
  );`,
  `CREATE TABLE IF NOT EXISTS bank_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    sub_account_id INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    side TEXT NOT NULL CHECK (side IN ('debit','credit')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    balance INTEGER,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
    entry_id INTEGER,
    file_name TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT (DATETIME('now','localtime')),
    UNIQUE (account_id, sub_account_id, fingerprint)
  );`,
  `CREATE TABLE IF NOT EXISTS bank_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','increase','decrease')),
    target_account_id INTEGER,
    account_id INTEGER NOT NULL,
    sub_account_id INTEGER,
    tax_code TEXT,
    invoice_kind TEXT,
    counterparty_id INTEGER,
    memo TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS bank_rule_splits (
    rule_id INTEGER NOT NULL,
    row_no INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    sub_account_id INTEGER,
    tax_code TEXT,
    invoice_kind TEXT,
    amount INTEGER NOT NULL CHECK (amount > 0),
    memo TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (rule_id, row_no)
  );`,

  /**
   * 祝日（内閣府から取得したもの）と、事業者の休業日（年末年始休業など）。営業日の数え方に使う（lib/holidays.ts）
   * kind：fetched = 取得した祝日、custom = 事業者が足した休業日。内蔵の祝日（constants/holidays.ts）はここには入れない
   */
  `CREATE TABLE IF NOT EXISTS holidays (
    date TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('fetched','custom')),
    PRIMARY KEY (date, kind)
  );`,

  `CREATE INDEX IF NOT EXISTS idx_evidences_date ON evidences(txn_date);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_links_entry ON evidence_links(entry_id);`,

  `CREATE INDEX IF NOT EXISTS idx_entries_date ON journal_entries(date);`,
  `CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);`,
  `CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id, sub_account_id);`,
  `CREATE INDEX IF NOT EXISTS idx_history_entry ON entry_history(entry_id);`,

  // ── 履歴を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_history_no_update BEFORE UPDATE ON entry_history
   BEGIN SELECT RAISE(ABORT, '訂正削除履歴は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_history_no_delete BEFORE DELETE ON entry_history
   BEGIN SELECT RAISE(ABORT, '訂正削除履歴は削除できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_master_history_no_update BEFORE UPDATE ON master_history
   BEGIN SELECT RAISE(ABORT, '変更履歴は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_master_history_no_delete BEFORE DELETE ON master_history
   BEGIN SELECT RAISE(ABORT, '変更履歴は削除できません'); END;`,
  // 電子帳簿保存法モードは一度決めたら変更できない。例外は「通常 → 厳密」だけ（翌年を始めるときに切り替える。戻せない）
  `CREATE TRIGGER IF NOT EXISTS trg_settings_mode_one_way BEFORE UPDATE OF e_book_mode ON settings
   WHEN OLD.e_book_mode IS NOT NULL AND (NEW.e_book_mode IS NULL OR (NEW.e_book_mode <> OLD.e_book_mode AND NOT (OLD.e_book_mode = 'standard' AND NEW.e_book_mode = 'strict')))
   BEGIN SELECT RAISE(ABORT, '電子帳簿保存法モードは変更できません'); END;`,
  // 対応を始めた年は、一度決めたら変えられない
  `CREATE TRIGGER IF NOT EXISTS trg_settings_strict_from_fixed BEFORE UPDATE OF strict_from_year ON settings
   WHEN OLD.strict_from_year IS NOT NULL AND (NEW.strict_from_year IS NULL OR NEW.strict_from_year <> OLD.strict_from_year)
   BEGIN SELECT RAISE(ABORT, '電子帳簿保存法に対応した年は変更できません'); END;`,
  // 履歴が1件でもある仕訳は物理削除させない（登録途中の失敗の後始末だけは許す）
  `CREATE TRIGGER IF NOT EXISTS trg_entries_no_delete BEFORE DELETE ON journal_entries
   WHEN EXISTS (SELECT 1 FROM entry_history WHERE entry_id = OLD.id)
   BEGIN SELECT RAISE(ABORT, '仕訳は削除できません（削除済みの印をつけてください）'); END;`,
  // 削除済みの仕訳は元に戻せない
  `CREATE TRIGGER IF NOT EXISTS trg_entries_no_undelete BEFORE UPDATE ON journal_entries
   WHEN OLD.is_deleted = 1
   BEGIN SELECT RAISE(ABORT, '削除済みの仕訳は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_access_log_no_update BEFORE UPDATE ON access_log
   BEGIN SELECT RAISE(ABORT, '利用の記録は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_access_log_no_delete BEFORE DELETE ON access_log
   BEGIN SELECT RAISE(ABORT, '利用の記録は削除できません'); END;`,

  // ── 記録の連鎖・検知の記録を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_update BEFORE UPDATE ON audit_chain
   BEGIN SELECT RAISE(ABORT, '記録の連鎖は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_chain_no_delete BEFORE DELETE ON audit_chain
   BEGIN SELECT RAISE(ABORT, '記録の連鎖は削除できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_integrity_events_no_update BEFORE UPDATE ON integrity_events
   BEGIN SELECT RAISE(ABORT, '検知の記録は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_integrity_events_no_delete BEFORE DELETE ON integrity_events
   BEGIN SELECT RAISE(ABORT, '検知の記録は削除できません'); END;`,

  // ── 証憑を守るトリガー ──
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_history_no_update BEFORE UPDATE ON evidence_history
   BEGIN SELECT RAISE(ABORT, '証憑の履歴は変更できません'); END;`,
  // 通常モードでは証憑を本当に削除できる（そのときは履歴も消し、削除したことを evidence_deletions に残す）。厳密モードでは削除させない
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_history_no_delete_s BEFORE DELETE ON evidence_history
   WHEN ${STRICT_MODE}
   BEGIN SELECT RAISE(ABORT, '証憑の履歴は削除できません'); END;`,
  // ファイルの中身は、どちらのモードでも書き換えさせない
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_files_no_update BEFORE UPDATE ON evidence_files
   BEGIN SELECT RAISE(ABORT, '証憑のファイルは変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_file_fixed BEFORE UPDATE OF file_name, mime, size, sha256 ON evidences
   BEGIN SELECT RAISE(ABORT, '証憑のファイルは変更できません'); END;`,
  // 厳密モードで、履歴がある証憑は削除させない（登録途中の失敗の後始末だけは許す）。通常モードでは削除できる
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_no_delete_s BEFORE DELETE ON evidences
   WHEN ${STRICT_MODE} AND EXISTS (SELECT 1 FROM evidence_history WHERE evidence_id = OLD.id)
   BEGIN SELECT RAISE(ABORT, '証憑は削除できません（無効の印をつけてください）'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_files_no_delete_s BEFORE DELETE ON evidence_files
   WHEN ${STRICT_MODE} AND EXISTS (SELECT 1 FROM evidence_history WHERE evidence_id = OLD.evidence_id)
   BEGIN SELECT RAISE(ABORT, '証憑は削除できません（無効の印をつけてください）'); END;`,
  // 削除した証憑の記録は書き換え・削除させない
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_deletions_no_update BEFORE UPDATE ON evidence_deletions
   BEGIN SELECT RAISE(ABORT, '削除した証憑の記録は変更できません'); END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_evidence_deletions_no_delete BEFORE DELETE ON evidence_deletions
   BEGIN SELECT RAISE(ABORT, '削除した証憑の記録は削除できません'); END;`,
  // スキャナ保存の画質の確認は、取り込んだときのまま（あとから書き換えさせない）
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_scan_fixed BEFORE UPDATE OF scan_info ON evidences
   WHEN OLD.scan_info <> NEW.scan_info
   BEGIN SELECT RAISE(ABORT, 'スキャナ保存の読み取りの記録は変更できません'); END;`,
  // 無効にした証憑は変更できない
  `CREATE TRIGGER IF NOT EXISTS trg_evidences_no_unvoid BEFORE UPDATE ON evidences
   WHEN OLD.is_void = 1
   BEGIN SELECT RAISE(ABORT, '無効にした証憑は変更できません'); END;`,

  // ── 締め済みの年度を守るトリガー ──
  ...CLOSED_TRIGGERS,
];

/**
 * 既存ファイルへの列追加（古い帳簿を開いたときに足りない列を足す）
 * [テーブル, 列名, 定義]。今後スキーマを変えたらここに足していく
 */
/**
 * 初期科目を入れる（帳簿を開くたび）。コードも名前も無いものだけ足す（将来科目を足しても既存ファイルに自動で入る。
 * 同じ名前の科目を自分で足していれば足さない）。引数：code, name, kana, category, normal_side, sort_order, income_kind, is_active
 */
export const SEED_ACCOUNT_SQL = `INSERT INTO accounts (code, name, kana, category, normal_side, sort_order, is_system, income_kind, is_active)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE code = ?1 OR name = ?2)`;

export const COLUMN_MIGRATIONS: [string, string, string][] = [
  ["settings", "e_book_mode", "TEXT CHECK (e_book_mode IN ('strict','standard'))"],
  // 通常 → 厳密に切り替えた帳簿：対応を始めた年と切り替えた日時（最初から厳密モードの帳簿は NULL = 全部の年が対応）
  ["settings", "strict_from_year", "INTEGER"],
  ["settings", "strict_switched_at", "TEXT"],
  // 事業者の情報：郵便番号・住所・適格請求書発行事業者の登録番号（免税事業者のときは入力できない）
  ["settings", "postal_code", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "address", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "invoice_no", "TEXT NOT NULL DEFAULT ''"],
  // 1 = 繰越済みの年度を自動で締める処理を済ませた（一度だけ行う。解除した年度を開くたびに締め直さないため）
  ["settings", "closings_initialized", "INTEGER NOT NULL DEFAULT 0"],
  // バックアップを残す世代数（既定値は constants/appConfig.ts の DEFAULT_BACKUP_GENERATIONS と揃える）
  ["settings", "backup_generations", "INTEGER NOT NULL DEFAULT 100"],
  // 入力期間（日）。既定値は constants/appConfig.ts の DEFAULT_INPUT_PERIOD_DAYS と揃える
  ["settings", "input_period_days", "INTEGER NOT NULL DEFAULT 70"],
  // 帳簿入力のタブに出す科目（科目IDの JSON 配列。並び順もこの順。空 = 既定の科目）
  ["settings", "cashbook_accounts", "TEXT NOT NULL DEFAULT ''"],
  // 改ざんの検知：記録の連鎖を始めたか（既存の履歴を一度だけ連鎖に取り込む）、前回開いたときにあったトリガー
  ["settings", "chain_initialized", "INTEGER NOT NULL DEFAULT 0"],
  // 固定資産台帳を記録の連鎖に入れたか（入れる前に始めた連鎖には、開いたときの台帳を基準点として足す）
  ["settings", "chain_assets", "INTEGER NOT NULL DEFAULT 0"],
  ["settings", "known_triggers", "TEXT NOT NULL DEFAULT ''"],
  // 締めたときの連鎖の先頭（確認コードのもと）
  ["fiscal_closings", "chain_head", "TEXT NOT NULL DEFAULT ''"],
  // 操作したユーザー
  ["entry_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["master_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["evidence_history", "user_id", "INTEGER REFERENCES users(id)"],
  ["integrity_events", "user_id", "INTEGER REFERENCES users(id)"],
  ["journal_entries", "created_by", "INTEGER REFERENCES users(id)"],
  ["journal_entries", "updated_by", "INTEGER REFERENCES users(id)"],
  ["evidences", "created_by", "INTEGER REFERENCES users(id)"],
  ["evidences", "updated_by", "INTEGER REFERENCES users(id)"],
  // ユーザーの権限（admin = 管理者、editor = 入力担当、viewer = 閲覧のみ）。権限を入れる前のユーザーは管理者
  ["users", "role", "TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer'))"],
  // ユーザーの備考（担当・連絡先など。任意）
  ["users", "memo", "TEXT NOT NULL DEFAULT ''"],
  // 取引先（任意）
  ["journal_entries", "counterparty_id", "INTEGER REFERENCES counterparties(id)"],
  // 決算整理仕訳（1 = 決算整理。日付は年度末。帳簿では 12月 のあとの「決算整理」に出る）
  ["journal_entries", "is_adjustment", "INTEGER NOT NULL DEFAULT 0"],
  ["evidences", "counterparty_id", "INTEGER REFERENCES counterparties(id)"],
  // 証憑の受領日（受け取った日。任意。スキャナ保存の入力期間の起点にもなる）
  ["evidences", "received_date", "TEXT NOT NULL DEFAULT ''"],
  // スキャナ保存：書類の区分（important = 重要書類、general = 一般書類。電子取引は空）と、取り込んだときの画質の確認（JSON。あとから変えられない）
  ["evidences", "doc_class", "TEXT NOT NULL DEFAULT ''"],
  ["evidences", "scan_info", "TEXT NOT NULL DEFAULT ''"],
  // スキャナ保存の入力期間の方式（early = 早期入力方式、cycle = 業務処理サイクル方式）
  ["settings", "scan_input_method", "TEXT NOT NULL DEFAULT 'early'"],
  // 内閣府から祝日を取得した日時（取得していなければ空）
  ["settings", "holidays_fetched_at", "TEXT NOT NULL DEFAULT ''"],
  // 消費税：適格請求書発行事業者の登録日、明細のインボイス区分（qualified / transitional / none。課税仕入だけ）、
  // 科目の税区分の初期値（NULL = 決まった初期値）、適格請求書発行事業者ではない取引先の印
  ["settings", "invoice_registered_on", "TEXT NOT NULL DEFAULT ''"],
  ["journal_lines", "invoice_kind", "TEXT"],
  ["accounts", "default_tax_code", "TEXT"],
  ["counterparties", "not_registered", "INTEGER NOT NULL DEFAULT 0"],
  // 簡易課税の事業区分（1〜6）：明細（課税売上だけ。NULL = 年度の「主な事業区分」）と科目の初期値
  ["journal_lines", "business_class", "INTEGER CHECK (business_class BETWEEN 1 AND 6)"],
  ["accounts", "default_business_class", "INTEGER CHECK (default_business_class BETWEEN 1 AND 6)"],
  // e-Tax のデータを書き出すときの申告者の情報：利用者識別番号（16桁）・提出先の税務署番号（5桁）・電話番号・フリガナ
  ["settings", "etax_user_id", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "tax_office", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "phone", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "owner_kana", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "business_kana", "TEXT NOT NULL DEFAULT ''"],
  // 確定申告書の申告者の欄（職業・世帯主・1月1日の住所・事業所の電話番号）と還付される税金の受取場所（個人番号は持たない）
  ["settings", "occupation", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "householder_name", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "householder_relation", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "jan1_address", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "office_phone", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "refund_mode", "TEXT NOT NULL DEFAULT 'none' CHECK (refund_mode IN ('none','bank','yucho','public'))"],
  ["settings", "bank_name", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "bank_kind", "TEXT NOT NULL DEFAULT '1'"],
  ["settings", "branch_name", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "branch_kind", "TEXT NOT NULL DEFAULT '2'"],
  ["settings", "deposit_kind", "TEXT NOT NULL DEFAULT '1'"],
  ["settings", "account_no", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "yucho_symbol", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "yucho_number", "TEXT NOT NULL DEFAULT ''"],
  // 青色申告決算書の欄（事業所の所在地・加入団体名）と、依頼している税理士等
  ["settings", "office_address", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "union_name", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "agent_name", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "agent_address", "TEXT NOT NULL DEFAULT ''"],
  ["settings", "agent_phone", "TEXT NOT NULL DEFAULT ''"],
  // 本則課税の個別対応方式：課税仕入の明細の用途区分（taxable 課税対応 / nontaxable 非課税対応 / common 共通対応）と科目の初期値、
  // 年度ごとの控除の方式（individual 個別対応方式 / lump 一括比例配分方式）
  ["journal_lines", "purchase_use", "TEXT CHECK (purchase_use IN ('taxable','nontaxable','common'))"],
  // 税抜経理の年の明細の消費税額（手で直した額だけ。NULL = 自動：税込の金額から割戻し・1円未満切り捨て。lib/taxExclusive.ts）
  ["journal_lines", "tax_amount", "INTEGER"],
  ["accounts", "default_purchase_use", "TEXT CHECK (default_purchase_use IN ('taxable','nontaxable','common'))"],
  ["tax_years", "deduction", "TEXT NOT NULL DEFAULT 'individual' CHECK (deduction IN ('individual','lump'))"],
  // 青色申告決算書で書く欄（NULL = 科目名から自動。lib/statementLines.ts）
  ["accounts", "statement_line", "TEXT"],
  // 所得の区分（損益の科目ごと）：business 事業所得 ／ realestate 不動産所得
  ["accounts", "income_kind", "TEXT NOT NULL DEFAULT 'business' CHECK (income_kind IN ('business','realestate'))"],
  // 固定資産の売却・除却の区分（sale / scrap）と売却額（税込）
  ["fixed_assets", "disposal_kind", "TEXT CHECK (disposal_kind IN ('sale','scrap'))"],
  ["fixed_assets", "sale_price", "INTEGER CHECK (sale_price >= 0)"],
  ["fixed_assets", "income_kind", "TEXT NOT NULL DEFAULT 'business' CHECK (income_kind IN ('business','realestate'))"],
  // 不動産所得：none なし ／ small 事業的規模でない ／ business 事業的規模
  ["settings", "real_estate", "TEXT NOT NULL DEFAULT 'none' CHECK (real_estate IN ('none','small','business'))"],
  ["tax_years", "voluntary_interim", "INTEGER NOT NULL DEFAULT 0 CHECK (voluntary_interim IN (0, 1))"],
];
