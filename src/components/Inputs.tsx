/**
 * 会計入力用の部品
 * どれも「打って Enter」で確定できるよう、テキスト入力ベースで作っています。
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { Account, InvoiceKind, PurchaseUse, Side, TaxCode } from "../lib/types";
import { parseAmount, parseDateInput, shortDate, toHalfWidth } from "../lib/format";
import { useAppContext } from "../context/AppContext";
import { BUSINESS_CLASSES, INVOICE_KINDS, PURCHASE_USES, TAX_CODES, TAX_DISABLED_NOTE } from "../constants/tax";
import {
  defaultInvoiceKind, defaultTaxCode, effectiveBusinessClass, effectivePurchaseUse, isPurchaseCode, isSalesCode, splitsTax, takesPurchaseUse, taxLongLabel, taxShortLabel, taxYearOf, useLabel,
} from "../lib/tax";
import { findCounterparty, normName, validateCounterparty } from "../lib/counterparty";
import * as repo from "../db/repo";
import { autoTaxAmount, isExclusiveOn } from "../lib/taxExclusive";

type NavProps = {
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  /** マウスを乗せたときの説明 */
  title?: string;
};

// ────────────────────────────────────────────
// 勘定科目
// ────────────────────────────────────────────

/** コード・科目名・よみがなのどれでも探せる */
const resolveAccount = (text: string, accounts: Account[]): Account | null => {
  const s = toHalfWidth(text).trim();
  if (!s) return null;
  const exact = accounts.find((a) => `${a.code} ${a.name}` === s || a.code === s || a.name === s);
  if (exact) return exact;
  const hits = accounts.filter(
    (a) => a.code.startsWith(s) || a.name.startsWith(s) || a.kana.startsWith(s),
  );
  return hits.length === 1 ? hits[0] : null;
};

interface AccountInputProps extends NavProps {
  value: number | null;
  onChange: (id: number | null) => void;
  /** 候補を絞りたいとき（帳簿入力の科目選択など） */
  accounts?: Account[];
}

export const AccountInput = ({ value, onChange, accounts, ...rest }: AccountInputProps) => {
  const { activeAccounts, accountMap } = useAppContext();
  const list = accounts ?? activeAccounts;
  const listId = useId();
  const nameOf = (id: number | null) => (id ? accountMap.get(id)?.name ?? "" : "");
  const [text, setText] = useState(nameOf(value));
  const [focused, setFocused] = useState(false);

  // 外から値が変わったとき（フォームのリセットなど）に表示を合わせる
  useEffect(() => {
    if (!focused) setText(nameOf(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    setFocused(false);
    const hit = resolveAccount(text, list);
    if (hit) {
      setText(hit.name);
      if (hit.id !== value) onChange(hit.id);
    } else if (!text.trim()) {
      if (value !== null) onChange(null);
    } else {
      onChange(null);
    }
  };

  const invalid = !focused && text.trim() !== "" && value === null;

  return (
    <>
      <input
        {...rest}
        data-nav
        className={`input account-input${invalid ? " invalid" : ""}`}
        list={listId}
        value={text}
        placeholder="科目"
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const hit = list.find((a) => `${a.code} ${a.name}` === e.target.value);
          if (hit) {
            setText(hit.name);
            onChange(hit.id);
          }
        }}
        onBlur={commit}
      />
      <datalist id={listId}>
        {list.map((a) => (
          <option key={a.id} value={`${a.code} ${a.name}`} />
        ))}
      </datalist>
    </>
  );
};

// ────────────────────────────────────────────
// 金額
// ────────────────────────────────────────────

interface AmountInputProps extends NavProps {
  value: number | null;
  onChange: (v: number | null) => void;
}

export const AmountInput = ({ value, onChange, ...rest }: AmountInputProps) => {
  const [text, setText] = useState(value == null ? "" : value.toLocaleString("ja-JP"));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value == null ? "" : value.toLocaleString("ja-JP"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      {...rest}
      data-nav
      inputMode="numeric"
      className={`input amount-input${!focused && text && parseAmount(text) == null ? " invalid" : ""}`}
      value={text}
      onFocus={(e) => {
        // 表示中の「3,300」のまま全選択する（カンマ付きでも parseAmount で読める）。
        // ここで値を書き換えたり選択を遅らせたりすると、素早く打った数字が消えるので注意。
        setFocused(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseAmount(e.target.value));
      }}
      onBlur={() => {
        setFocused(false);
        const v = parseAmount(text);
        setText(v == null ? text : v.toLocaleString("ja-JP"));
      }}
    />
  );
};

// ────────────────────────────────────────────
// 日付（4/15・0415・15 などで入力できる）
// ────────────────────────────────────────────

interface DateInputProps extends NavProps {
  value: string;
  onChange: (iso: string) => void;
  year: number;
  /** 打った日付が読めるか（読めない間は value が前の日付のままなので、登録の前に止めるのに使う） */
  onValidity?: (ok: boolean) => void;
}

export const DateInput = ({ value, onChange, year, onValidity, ...rest }: DateInputProps) => {
  const [text, setText] = useState(shortDate(value));
  const [invalid, setInvalid] = useState(false);
  const mark = (bad: boolean) => {
    setInvalid(bad);
    onValidity?.(!bad);
  };

  useEffect(() => {
    setText(shortDate(value));
    mark(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    const month = Number(value.slice(5, 7)) || 1;
    const iso = parseDateInput(text, year, month);
    if (iso && iso.startsWith(`${year}-`)) {
      mark(false);
      setText(shortDate(iso));
      if (iso !== value) onChange(iso);
    } else {
      mark(true);
    }
  };

  return (
    <input
      {...rest}
      data-nav
      className={`input date-input${invalid ? " invalid" : ""}`}
      value={text}
      title={`${year}年の日付。4/15・0415・15（当月）の形で入力できます`}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
};

/**
 * 年をまたいでよい日付（証憑の取引年月日など）。
 * 2025/12/20・20251220 のように年まで打てる。年を省くと表示中の年度
 */
export const FullDateInput = ({ value, onChange, year, onValidity, ...rest }: DateInputProps) => {
  const show = (iso: string) => (iso ? iso.replace(/-/g, "/") : "");
  const [text, setText] = useState(show(value));
  const [invalid, setInvalid] = useState(false);
  const mark = (bad: boolean) => {
    setInvalid(bad);
    onValidity?.(!bad);
  };

  useEffect(() => {
    setText(show(value));
    mark(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (!text.trim()) {
      mark(false);
      if (value) onChange("");
      return;
    }
    const iso = parseDateInput(text, year, Number(value.slice(5, 7)) || 1);
    if (iso) {
      mark(false);
      setText(show(iso));
      if (iso !== value) onChange(iso);
    } else {
      mark(true);
    }
  };

  return (
    <input
      {...rest}
      data-nav
      className={`input full-date-input${invalid ? " invalid" : ""}`}
      value={text}
      placeholder="2026/04/15"
      title="2026/4/15・20260415 の形。年を省くと表示中の年度になります"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
    />
  );
};

// ────────────────────────────────────────────
// 摘要（過去の入力から候補を出す）
// ────────────────────────────────────────────

interface MemoInputProps extends NavProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 摘要を確定したとき（Enter で次の欄へ・欄を離れたとき）。摘要からの自動入力に使う */
  onCommit?: (v: string) => void;
}

export const MemoInput = ({ value, onChange, placeholder = "摘要", onCommit, ...rest }: MemoInputProps) => {
  const { memoSuggestions } = useAppContext();
  const listId = useId();
  return (
    <>
      <input
        {...rest}
        data-nav
        className="input memo-input"
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit ? (e) => onCommit(e.target.value) : undefined}
      />
      <datalist id={listId}>
        {memoSuggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
};

// ────────────────────────────────────────────
// 税区分（免税事業者の期間は「対象外」で固定・グレー表示）
//  課税仕入は、インボイス区分（適格・経過措置・控除しない）も同じ欄で選ぶ。本則課税の年は用途区分（課税対応・共通対応・非課税対応）も。
//  値が null のあいだは、科目・取引先から決まる初期値を出す（保存のときも同じ初期値になる。lib/tax.ts の resolveLineTax）。
//  Enter での移動では飛ばす（初期値のままのことが多いため。変えるときはクリックか Tab）
// ────────────────────────────────────────────

/** 選択肢の値：課税仕入は「税区分|インボイス区分」（本則課税の年は「…@用途区分」）、簡易課税の年の課税売上は「税区分#事業区分」 */
const optionValue = (code: TaxCode, invoice: InvoiceKind | null, cls: number | null = null, use: PurchaseUse | null = null) =>
  isPurchaseCode(code) ? `${code}|${invoice ?? "qualified"}${use ? `@${use}` : ""}` : takesPurchaseUse(code) && use ? `${code}@${use}` : cls ? `${code}#${cls}` : code;

export const TaxSelect = ({ label, value, invoice, businessClass, purchaseUse, onChange, accountId, side, date, counterpartyId }: {
  label: string;
  value: TaxCode | null | undefined;
  invoice: InvoiceKind | null | undefined;
  /** 簡易課税の事業区分（課税売上だけ。null = 科目の初期値・年度の「主な事業区分」） */
  businessClass?: number | null;
  /** 本則課税の用途区分（課税仕入だけ。null = 科目の初期値・共通対応） */
  purchaseUse?: PurchaseUse | null;
  onChange: (code: TaxCode | null, invoice: InvoiceKind | null, businessClass: number | null, purchaseUse: PurchaseUse | null) => void;
  accountId: number | null;
  side: Side;
  /** 取引の日付（課税事業者の期間か、経過措置の割合、簡易課税の年か） */
  date: string;
  counterpartyId?: number | null;
}) => {
  const { accountMap, counterparties, isTaxActive, taxYears } = useAppContext();
  const account = accountId ? accountMap.get(accountId) : undefined;
  const active = isTaxActive(date);
  if (!active || !account) {
    return (
      <select className="input tax-select" value="none" disabled title={active ? "科目を選ぶと、科目の初期値が入ります" : TAX_DISABLED_NOTE} aria-label={label} tabIndex={-1} onChange={() => {}}>
        <option value="none">{active ? "" : "対象外"}</option>
      </select>
    );
  }
  const ty = taxYearOf(taxYears, Number(date.slice(0, 4)));
  const simplified = ty.status === "simplified";
  const standard = ty.status === "standard";
  const cp = counterpartyId ? counterparties.find((c) => c.id === counterpartyId) : null;
  const code = value ?? defaultTaxCode(account, side);
  const inv = isPurchaseCode(code) ? invoice ?? defaultInvoiceKind(cp) : null;
  // 簡易課税の年の課税売上は、事業区分も選ぶ（入っていなければ科目の初期値・主な事業区分）
  const cls = simplified && isSalesCode(code) ? effectiveBusinessClass({ business_class: businessClass }, account, ty.business_class) : null;
  // 本則課税の年の課税仕入は、用途区分も選ぶ（入っていなければ科目の初期値・共通対応）
  const use = standard && takesPurchaseUse(code) ? effectivePurchaseUse({ purchase_use: purchaseUse }, account) : null;
  const isDefault = value == null && (!cls || businessClass == null) && (!use || purchaseUse == null);
  const opt = (c: TaxCode, i: InvoiceKind | null = null, k: number | null = null, u: PurchaseUse | null = null) => (
    <option key={optionValue(c, i, k, u)} value={optionValue(c, i, k, u)} title={taxLongLabel(c, i, date, k, u)}>{taxShortLabel(c, i, date, k, u, true)}</option>
  );
  const group = (g: "sales" | "purchase") => TAX_CODES.filter((t) => t.group === g);
  // 帳簿のみ保存の特例は、本則課税の年だけ選べる（ほかの年は、入っているものだけ出す）
  const BOOK_ONLY = INVOICE_KINDS.filter((k) => k.value.startsWith("book_")).map((k) => k.value);
  const invoices: InvoiceKind[] = ["qualified", "transitional", "none", ...(standard ? BOOK_ONLY : inv && BOOK_ONLY.includes(inv) ? [inv] : [])];
  const purchases = (u: PurchaseUse | null) => group("purchase").filter((t) => takesPurchaseUse(t.code))
    .flatMap((t) => (isPurchaseCode(t.code) ? invoices.map((i) => opt(t.code, i, null, u)) : [opt(t.code, null, null, u)]));
  return (
    <select
      className={`input tax-select${isDefault ? " is-default" : ""}`}
      value={optionValue(code, inv, cls, use)}
      aria-label={label}
      title={`${taxLongLabel(code, inv, date, cls, use)}${isDefault ? "（科目の初期値）" : ""}`}
      onChange={(e) => {
        const [head, k] = e.target.value.split("#");
        const [body, u] = head.split("@");
        const [c, i] = body.split("|") as [TaxCode, InvoiceKind | undefined];
        onChange(c, i ?? null, k ? Number(k) : null, (u as PurchaseUse | undefined) ?? null);
      }}
    >
      {opt("none")}
      <optgroup label="売上">
        {group("sales").flatMap((t) => (simplified && isSalesCode(t.code) ? BUSINESS_CLASSES.map((b) => opt(t.code, null, b.value)) : [opt(t.code)]))}
      </optgroup>
      {standard
        ? <>
          {PURCHASE_USES.map((u) => <optgroup key={u.value} label={`仕入（${useLabel(u.value)}）`}>{purchases(u.value)}</optgroup>)}
          <optgroup label="仕入（その他）">{group("purchase").filter((t) => !takesPurchaseUse(t.code)).map((t) => opt(t.code))}</optgroup>
        </>
        : <optgroup label="仕入">{group("purchase").flatMap((t) => (isPurchaseCode(t.code) ? invoices.map((i) => opt(t.code, i)) : [opt(t.code)]))}</optgroup>}
    </select>
  );
};

// ────────────────────────────────────────────
// 補助科目（科目に補助が無いときは「—」でグレー）
// ────────────────────────────────────────────

interface SubSelectProps {
  accountId: number | null;
  value: number | null;
  onChange: (v: number | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLSelectElement>) => void;
  "aria-label"?: string;
}

export const SubSelect = ({ accountId, value, onChange, onKeyDown, ...rest }: SubSelectProps) => {
  const { activeSubsOf, subMap } = useAppContext();
  const subs = activeSubsOf(accountId);
  // 非表示にした補助が既存仕訳で使われている場合も表示できるようにする
  const current = value ? subMap.get(value) : undefined;
  const options = current && !subs.some((s) => s.id === current.id) ? [current, ...subs] : subs;
  const none = options.length === 0;

  // 科目を変えて、今の補助がその科目のものでなくなったら外す
  useEffect(() => {
    if (value && current && current.account_id !== accountId) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  return (
    <select
      {...rest}
      data-nav={none ? undefined : true}
      className="input sub-select"
      value={value ?? ""}
      disabled={none}
      tabIndex={none ? -1 : 0}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      onKeyDown={onKeyDown}
    >
      <option value="">{none ? "—" : "（なし）"}</option>
      {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
};

/** 科目＋補助科目（補助がある科目を選んだときだけ、下に補助の選択が出る） */
export const AccountWithSub = ({
  accountId, subId, onAccount, onSub, onKeyDown, label, accounts,
}: {
  accountId: number | null;
  subId: number | null;
  onAccount: (id: number | null) => void;
  onSub: (id: number | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  label: string;
  accounts?: Account[];
}) => {
  const { activeSubsOf, subMap } = useAppContext();
  const hasSubs = activeSubsOf(accountId).length > 0 || (subId != null && subMap.get(subId)?.account_id === accountId);
  return (
    <div className="acct-cell">
      <AccountInput value={accountId} onChange={onAccount} onKeyDown={onKeyDown} aria-label={label} accounts={accounts} />
      {hasSubs && <SubSelect accountId={accountId} value={subId} onChange={onSub} onKeyDown={onKeyDown} aria-label={`${label}の補助科目`} />}
    </div>
  );
};

// ────────────────────────────────────────────
// 取引先（任意）。一覧から選ぶ。一覧に無い名前はその場で追加できる
// ────────────────────────────────────────────
interface CounterpartyFieldProps extends NavProps {
  value: number | null;
  onChange: (id: number | null) => void;
  /** 一覧に無い名前が入っているか（登録前の確認用） */
  onUnknown?: (unknown: boolean) => void;
}

export const CounterpartyField = ({ value, onChange, onUnknown, ...rest }: CounterpartyFieldProps) => {
  const { db, counterparties, reloadCounterparties } = useAppContext();
  const listId = useId();
  const current = counterparties.find((c) => c.id === value);
  const [text, setText] = useState(current?.name ?? "");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (current && normName(current.name) !== normName(text)) setText(current.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, current?.name]);

  const unknown = text.trim() !== "" && !findCounterparty(counterparties, text);
  useEffect(() => {
    onUnknown?.(unknown);
  }, [unknown, onUnknown]);

  const add = async () => {
    const err = validateCounterparty(counterparties, { name: text, kana: "", invoice_no: "", memo: "" });
    if (err) return;
    setAdding(true);
    try {
      const id = await repo.createCounterparty(db, { name: text, kana: "", invoice_no: "", memo: "" });
      await reloadCounterparties();
      onChange(id);
    } finally {
      setAdding(false);
    }
  };

  return (
    <span className="cp-field">
      <input
        {...rest}
        data-nav
        className={`input cp-input${unknown ? " invalid" : ""}`}
        list={listId}
        value={text}
        placeholder="取引先（任意）"
        title={unknown ? "取引先一覧にない名前です。右の「追加」で登録できます" : undefined}
        onChange={(e) => {
          setText(e.target.value);
          onChange(findCounterparty(counterparties, e.target.value)?.id ?? null);
        }}
      />
      <datalist id={listId}>
        {counterparties.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.name}>{c.invoice_no}</option>)}
      </datalist>
      {unknown && (
        <button type="button" className="btn ghost sm" onClick={add} disabled={adding} tabIndex={-1}>＋ 取引先に追加</button>
      )}
    </span>
  );
};

// ────────────────────────────────────────────
// 消費税額（税抜経理の年だけ。空 = 自動：税込の金額から割戻し。直したいときだけ入れる。lib/taxExclusive.ts）
// ────────────────────────────────────────────
export const TaxAmountField = ({ label, amount, code, invoice, accountId, side, date, counterpartyId, value, onChange }: {
  label: string;
  amount: number | null;
  code: TaxCode | null | undefined;
  invoice: InvoiceKind | null | undefined;
  accountId: number | null;
  side: Side;
  date: string;
  counterpartyId?: number | null;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) => {
  const { accountMap, counterparties, taxYears } = useAppContext();
  const account = accountId ? accountMap.get(accountId) : undefined;
  if (!account || !amount || !isExclusiveOn(taxYears, date)) return null;
  const c = code ?? defaultTaxCode(account, side);
  if (!splitsTax(c)) return null;
  const cp = counterpartyId ? counterparties.find((x) => x.id === counterpartyId) : null;
  const auto = autoTaxAmount({ amount, tax_code: c, invoice_kind: isPurchaseCode(c) ? invoice ?? defaultInvoiceKind(cp) : null, date });
  return (
    <label className="tax-amount-field" title="税抜経理の消費税額。空なら自動（税込の金額から割戻し・1円未満切り捨て）。請求書の税額と違うときだけ入れます">
      <span>税</span>
      <input
        className={`input amount-input tax-amount-input${value == null ? " is-default" : ""}`} inputMode="numeric" tabIndex={-1} aria-label={label}
        placeholder={auto.toLocaleString("ja-JP")} value={value == null ? "" : String(value)}
        onChange={(e) => {
          const t = e.target.value.trim();
          onChange(t === "" ? null : parseAmount(t));
        }}
      />
    </label>
  );
};
