/**
 * 帳簿入力（現金出納帳・預金出納帳など）
 * 1つの科目から見た「入金・出金」で入力する、いちばん手軽な入力画面です。
 * 入力した行は「この科目 ⇔ 相手科目」の2行の仕訳として保存されます。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileUp, Landmark, Settings2 } from "lucide-react";
import type { Page } from "../../App";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { ADJUSTMENT_PERIOD, MonthTabs, periodLabel } from "../../components/MonthRange";
import { AccountWithSub, AmountInput, CounterpartyField, DateInput, MemoInput, TaxSelect } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "./EntryEditModal";
import { buildLedger, monthEnd, monthStart, yearEnd } from "../../lib/accounting";
import { enterToNext } from "../../lib/keyboard";
import { defaultDateInYear, shortDate, todayIso, yen } from "../../lib/format";
import { CODE } from "../../constants/accounts";
import { cashbookTabs } from "../../lib/cashbook";
import { CashbookTabsModal } from "./CashbookTabsModal";
import { BankImportModal } from "./BankImportModal";
import * as repo from "../../db/repo";
import { subKey, type InvoiceKind, type JournalLine, type PurchaseUse, type TaxCode } from "../../lib/types";
import { splitByRate } from "../../lib/homeUse";
import { displayClass, displayUse, taxLongLabel, taxShortLabel } from "../../lib/tax";

/** 科目ごとの列見出し（一般的な出納帳に合わせる） */
const columnLabels = (code: string, normal: "debit" | "credit") => {
  if (code === "101") return { dr: "入金", cr: "出金" };
  if (["102", "103", "104"].includes(code)) return { dr: "預入", cr: "引出" };
  return normal === "debit" ? { dr: "増加", cr: "減少" } : { dr: "減少", cr: "増加" };
};

export const CashBookPage = ({ go }: { go: (p: Page) => void }) => {
  const { db, year, accounts, accountMap, bump, activeSubsOf, labelOf, subMap, homeUseOf, isDateClosed, counterparties, isTaxActive, taxYears, dataVersion } = useAppContext();
  const { lines, opening, subOpening, loading } = useYearData();
  const toast = useToast();

  const cashId = accounts.find((a) => a.code === CODE.CASH)?.id ?? accounts[0].id;
  // タブに出す科目（帳簿ごとに保存。null = まだ決めていない → 既定の科目）
  const [savedTabs, setSavedTabs] = useState<number[] | null>(null);
  const [editingTabs, setEditingTabs] = useState(false);
  useEffect(() => {
    repo.getCashbookAccounts(db).then(setSavedTabs).catch(console.error);
  }, [db]);
  const tabs = useMemo(() => cashbookTabs(accounts, savedTabs), [accounts, savedTabs]);
  const [pickedId, setAccountId] = useState(cashId);
  // 選んでいた科目をタブから外したら、最初のタブにする
  const accountId = tabs.some((a) => a.id === pickedId) ? pickedId : tabs[0]?.id ?? cashId;
  /** 表示する期間。1〜12 = 月、13 = 決算整理（12月のあと）。1〜13 = 全期間 */
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(ADJUSTMENT_PERIOD);
  const fullYear = from === 1 && to === ADJUSTMENT_PERIOD;
  /** 決算整理だけを見ているとき：入力は年度末の決算整理仕訳になる */
  const adjustmentOnly = from === ADJUSTMENT_PERIOD;
  /** 補助科目の帳簿：undefined = 全体、null = 補助なし、数値 = その補助 */
  const [bookSub, setBookSub] = useState<number | null | undefined>(undefined);
  const bookSubs = activeSubsOf(accountId);
  const selectAccount = (id: number) => {
    setAccountId(id);
    setBookSub(undefined);
  };
  const [editing, setEditing] = useState<number | null>(null);
  // 銀行・カードの明細の取り込み（未登録の明細の数を、科目ごとにタブの横に出す）
  const [importing, setImporting] = useState(false);
  const [pendingCounts, setPendingCounts] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    repo.getPendingBankCounts(db).then(setPendingCounts).catch(console.error);
  }, [db, dataVersion, importing]);

  const account = accountMap.get(accountId)!;
  const labels = columnLabels(account.code, account.normal_side);

  // ── 表示する行 ──
  const { carried, rows } = useMemo(() => {
    const base = bookSub === undefined ? opening[account.id] ?? 0 : subOpening[subKey(account.id, bookSub)] ?? 0;
    const all = buildLedger(account, base, lines, accountMap, bookSub);
    if (fullYear) return { carried: base, rows: all };
    // 行の期間：決算整理仕訳は 13（12月のあと）、それ以外は月。行は期間の順に並んでいる（決算整理は最後）
    const periodOf = (r: (typeof all)[number]) => (r.isAdjustment ? ADJUSTMENT_PERIOD : Number(r.date.slice(5, 7)));
    const prefix = all.filter((r) => periodOf(r) < from);
    const carried = prefix.length ? prefix[prefix.length - 1].balance : base;
    return { carried, rows: all.filter((r) => periodOf(r) >= from && periodOf(r) <= to) };
  }, [account, opening, subOpening, lines, accountMap, from, to, fullYear, year, bookSub]);

  // 伝票番号 → 取引先の名前（表示用）
  const cpOfEntry = useMemo(() => {
    const names = new Map(counterparties.map((c) => [c.id, c.name]));
    const m = new Map<number, string>();
    for (const l of lines) if (l.counterparty_id) m.set(l.entry_id, names.get(l.counterparty_id) ?? "");
    return m;
  }, [lines, counterparties]);

  /**
   * 行の税区分の表示：この帳簿の科目の相手側の明細の税区分（相手が複数で税区分が違えば「複数」）。
   * 課税事業者の期間で税区分が入っていない仕訳は「未設定」
   */
  const taxOfRow = useMemo(() => {
    const byEntry = new Map<number, typeof lines>();
    for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
    return (r: (typeof rows)[number]) => {
      const mine = r.debit > 0 ? "debit" : "credit";
      const others = (byEntry.get(r.entry_id) ?? []).filter((l) => l.side !== mine);
      if (others.length === 0) return { text: "", title: "" };
      if (others.some((l) => !l.tax_code)) return isTaxActive(r.date) ? { text: "未設定", title: "税区分が入っていません（仕訳を開いて入れるか、事業者設定の消費税でまとめて入れられます）" } : { text: "対象外", title: "" };
      const keys = new Set(others.map((l) => `${l.tax_code}|${l.invoice_kind ?? ""}|${l.business_class ?? ""}|${l.purchase_use ?? ""}`));
      if (keys.size > 1) return { text: "複数", title: "相手の明細で税区分が違います" };
      const o = others[0];
      const cls = displayClass(taxYears, o);
      const use = displayUse(taxYears, o);
      return { text: taxShortLabel(o.tax_code, o.invoice_kind, r.date, cls, use), title: taxLongLabel(o.tax_code, o.invoice_kind, r.date, cls, use) };
    };
  }, [lines, isTaxActive, taxYears]);

  const totals = rows.reduce((t, r) => ({ dr: t.dr + r.debit, cr: t.cr + r.credit }), { dr: 0, cr: 0 });

  // ── 入力行 ──
  // 入力の日付の初期値：今日が表示中の期間に入っていれば今日、そうでなければ期間の初日
  const firstDate = () => {
    if (fullYear) return defaultDateInYear(year);
    if (adjustmentOnly) return yearEnd(year);
    const t = todayIso();
    return t >= monthStart(year, from) && t <= monthEnd(year, Math.min(to, 12)) ? t : monthStart(year, from);
  };
  const [date, setDate] = useState(firstDate());
  const [counterId, setCounterId] = useState<number | null>(null);
  const [counterSubId, setCounterSubId] = useState<number | null>(null);
  /** 相手科目の税区分（null = 科目・取引先の初期値） */
  const [counterTax, setCounterTax] = useState<{ code: TaxCode | null; invoice: InvoiceKind | null; cls: number | null; use: PurchaseUse | null }>(
    { code: null, invoice: null, cls: null, use: null },
  );
  const [memo, setMemo] = useState("");
  const [dr, setDr] = useState<number | null>(null);
  const [cr, setCr] = useState<number | null>(null);
  const [counterpartyId, setCounterpartyId] = useState<number | null>(null);
  const [cpUnknown, setCpUnknown] = useState(false);
  /** 登録のたびに取引先の欄を空に戻すためのキー */
  const [cpKey, setCpKey] = useState(0);
  const [error, setError] = useState("");
  /** 日付の欄に読めない日付が入っているか（そのままだと前の日付で登録されるので止める） */
  const [dateBad, setDateBad] = useState(false);

  useEffect(() => {
    if (!date.startsWith(`${year}-`)) setDate(firstDate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const inputRowRef = useRef<HTMLTableRowElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, accountId, from, to]);

  const save = async () => {
    setError("");
    // 決算整理だけを見ているときは、年度末の決算整理仕訳として登録する
    const entryDate = adjustmentOnly ? yearEnd(year) : date;
    if (!adjustmentOnly && dateBad) return setError(`日付が正しくありません（${year}年の日付を入れてください）`);
    if (isDateClosed(entryDate)) return setError("締めた月には登録できません（事業者設定で締めを戻してください）");
    if (bookSubs.length > 0 && bookSub === undefined) return setError("上の補助科目を選んでから入力してください（補助科目を使わないときは「補助なし」）");
    if (!counterId) return setError("相手科目を選んでください");
    // 同じ科目どうしは、補助科目が違うときだけ（例：普通預金の A銀行 → B銀行への振替）
    if (counterId === accountId && (typeof bookSub === "number" ? bookSub : 0) === (counterSubId ?? 0)) {
      return setError("相手科目に、この帳簿と同じ科目・補助科目は使えません（補助科目が違えば使えます。例：普通預金の A銀行 → B銀行）");
    }
    if ((dr ?? 0) > 0 && (cr ?? 0) > 0) return setError(`${labels.dr}と${labels.cr}はどちらか一方に入力してください`);
    const amount = (dr ?? 0) || (cr ?? 0);
    if (amount <= 0) return setError("金額を入力してください");
    if (cpUnknown) return setError("取引先が一覧にありません。「取引先に追加」で登録するか、欄を空にしてください");

    const isDebit = (dr ?? 0) > 0;
    const ownSub = typeof bookSub === "number" ? bookSub : null;
    const m = memo.trim();
    // この帳簿の科目側には、選んでいる補助科目をつける（補助科目の無い科目は補助なし）
    // 税区分は相手科目の側だけ持たせる（この帳簿の科目の側は初期値＝ふつうは対象外）
    const tax = {
      ...(counterTax.code ? { tax_code: counterTax.code } : {}), ...(counterTax.invoice ? { invoice_kind: counterTax.invoice } : {}),
      ...(counterTax.cls ? { business_class: counterTax.cls } : {}), ...(counterTax.use ? { purchase_use: counterTax.use } : {}),
    };
    const lines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: isDebit ? accountId : counterId, sub_account_id: isDebit ? ownSub : counterSubId, amount, memo: m, ...(isDebit ? {} : tax) },
      { row_no: 1, side: "credit", account_id: isDebit ? counterId : accountId, sub_account_id: isDebit ? counterSubId : ownSub, amount, memo: m, ...(isDebit ? tax : {}) },
    ];
    // 家事按分（入力のたびに）：支払った経費を、事業分と事業主貸に分ける
    if (split) {
      lines[0] = { ...lines[0], amount: split.business };
      lines.push({ row_no: 2, side: "debit", account_id: drawId, sub_account_id: null, amount: split.private, memo: m ? `${m}（家事分）` : "家事分" });
    }
    try {
      await repo.createEntry(db, entryDate, lines, counterpartyId, "", adjustmentOnly);
      bump();
      toast("登録しました");
      setCounterId(null);
      setCounterTax({ code: null, invoice: null, cls: null, use: null });
      setCounterpartyId(null);
      setCpKey((k) => k + 1);
      setCounterSubId(null);
      setMemo("");
      setDr(null);
      setCr(null);
      // 続けて入力できるよう日付欄に戻る（日付は前回の値を残す）
      requestAnimationFrame(() => {
        const first = inputRowRef.current?.querySelector<HTMLInputElement>("[data-nav]");
        first?.focus();
        first?.select();
      });
    } catch (e) {
      toast(`登録できませんでした：${String(e)}`, "error");
    }
  };
  const nav = enterToNext(save);

  // 家事按分の対象か（出金で、相手が「入力のたびに」按分する経費科目のとき）
  const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)!.id;
  const hu = homeUseOf(counterId);
  const split =
    hu && hu.method === "entry" && (cr ?? 0) > 0 && !(dr ?? 0) && accountMap.get(counterId!)?.category === "expense"
      ? splitByRate(cr ?? 0, hu.rate)
      : null;

  return (
    <div className="page">
      <PageHeader title="帳簿入力" note="出納帳の形で入力します。日付は 4/15・0415・15（当月）のように打てます。">
        <div className="period-bar">
          {/* 期首残高は仕訳ではなく別に持つので、期間ではなく期首残高の画面への入口にする */}
          <button className="opening-link" onClick={() => go("opening")} title="期首残高の画面を開く（帳簿の「前期より繰越」はここで入れた金額です）">
            <Landmark size={13} /> 期首残高
          </button>
          <MonthTabs from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        </div>
      </PageHeader>

      <div className="book-picker" role="tablist" aria-label="帳簿">
        {tabs.map((a) => (
          <button key={a.id} role="tab" aria-selected={a.id === accountId} className={a.id === accountId ? "on" : ""} onClick={() => selectAccount(a.id)}>
            {a.name}
          </button>
        ))}
        <button className="book-edit" onClick={() => setEditingTabs(true)} title="帳簿のタブを追加・削除・並べ替え">
          <Settings2 size={14} /> タブの編集
        </button>
        <button className="book-edit book-import" onClick={() => setImporting(true)} title="銀行・カードの明細（CSV）を読み込んで仕訳にする">
          <FileUp size={14} /> 明細の取り込み
          {(() => {
            const n = [...pendingCounts].filter(([k]) => k.startsWith(`${accountId}|`)).reduce((t, [, v]) => t + v, 0);
            return n > 0 ? <span className="count-badge info" title="未登録の明細">{n}</span> : null;
          })()}
        </button>
      </div>

      <section className="sheet sheet-fill">
        {bookSubs.length > 0 && (
          <div className="sub-picker" role="tablist" aria-label="補助科目">
            <span className="sub-picker-label">補助科目</span>
            <button role="tab" aria-selected={bookSub === undefined} className={bookSub === undefined ? "on" : ""} onClick={() => setBookSub(undefined)}>全体</button>
            {bookSubs.map((sb) => (
              <button key={sb.id} role="tab" aria-selected={bookSub === sb.id} className={bookSub === sb.id ? "on" : ""} onClick={() => setBookSub(sb.id)}>{sb.name}</button>
            ))}
            <button role="tab" aria-selected={bookSub === null} className={bookSub === null ? "on" : ""} onClick={() => setBookSub(null)}>補助なし</button>
          </div>
        )}
        <div className="table-wrap scroll-y" ref={scrollRef}>
          <table className="ledger book-table">
            <colgroup>
              <col style={{ width: 72 }} />
              <col style={{ width: 52 }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: 136 }} />
              <col />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>日付</th>
                <th className="num" title="伝票番号（仕訳日記帳の No. と同じ）">No.</th>
                <th>相手科目</th>
                <th className="tax-th">税区分</th>
                <th>摘要</th>
                <th className="num dr">{labels.dr}</th>
                <th className="num cr">{labels.cr}</th>
                <th className="num">残高</th>
              </tr>
            </thead>
            <tbody>
              <tr className="carried">
                <td colSpan={2} />
                <td colSpan={5}>{from === 1 ? "前期より繰越" : adjustmentOnly ? "12月より繰越" : "前月より繰越"}</td>
                <td className="num">{yen(carried)}</td>
              </tr>
              {rows.map((r, i) => (
                <tr key={`${r.entry_id}-${i}`} className="clickable" onClick={() => setEditing(r.entry_id)} title="クリックで修正">
                  <td>{shortDate(r.date)}</td>
                  <td className="num muted">{r.entry_id}</td>
                  <td>{r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter}</td>
                  <td className={`tax-cell${taxOfRow(r).text === "未設定" || taxOfRow(r).text.endsWith("区分不明") ? " tax-missing" : ""}`} title={taxOfRow(r).title}>{taxOfRow(r).text}</td>
                  <td className="memo">
                    {r.isAdjustment && <span className="badge badge-adjust">決算整理</span>}
                    {bookSub === undefined && r.subId && <span className="sub-tag">{subMap.get(r.subId)?.name}</span>}
                    {r.memo}
                    {cpOfEntry.get(r.entry_id) && <span className="cp-tag">{cpOfEntry.get(r.entry_id)}</span>}
                  </td>
                  <td className="num">{yen(r.debit, { blankZero: true })}</td>
                  <td className="num">{yen(r.credit, { blankZero: true })}</td>
                  <td className={`num${r.balance < 0 ? " negative" : ""}`}>{yen(r.balance)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr className="empty-row"><td colSpan={8}>まだ取引がありません。下の行から入力を始めてください。</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-wrap input-dock" data-navgroup>
          <table className="ledger book-table">
            <colgroup>
              <col style={{ width: 72 }} />
              <col style={{ width: 52 }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: 136 }} />
              <col />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <tbody>
              <tr ref={inputRowRef} className="input-row">
                <td>
                  {adjustmentOnly
                    ? <span className="adjust-date" title="決算整理仕訳は年度末の日付で登録します">12/31</span>
                    : <DateInput value={date} onChange={setDate} year={year} onKeyDown={nav} aria-label="日付" onValidity={(ok) => setDateBad(!ok)} />}
                </td>
                <td />
                <td><AccountWithSub accountId={counterId} subId={counterSubId} onAccount={(v) => { setCounterId(v); setCounterSubId(null); setCounterTax({ code: null, invoice: null, cls: null, use: null }); }} onSub={setCounterSubId} onKeyDown={nav} label="相手科目" /></td>
                <td>
                  {/* 入金なら相手科目は貸方、出金なら借方 */}
                  <TaxSelect
                    label="税区分" value={counterTax.code} invoice={counterTax.invoice} businessClass={counterTax.cls} purchaseUse={counterTax.use} accountId={counterId} side={(dr ?? 0) > 0 ? "credit" : "debit"}
                    date={adjustmentOnly ? yearEnd(year) : date} counterpartyId={counterpartyId} onChange={(code, invoice, cls, use) => setCounterTax({ code, invoice, cls, use })}
                  />
                </td>
                <td>
                  <div className="memo-cp">
                    <MemoInput value={memo} onChange={setMemo} onKeyDown={nav} aria-label="摘要" />
                    <CounterpartyField key={cpKey} value={counterpartyId} onChange={setCounterpartyId} onUnknown={setCpUnknown} onKeyDown={nav} aria-label="取引先" />
                  </div>
                </td>
                {/* 入金・出金はどちらか一方だけ。片方に金額を入れると、もう片方は入れられない（Enter でも飛ばす） */}
                <td><AmountInput value={dr} onChange={setDr} onKeyDown={nav} aria-label={labels.dr} disabled={(cr ?? 0) > 0} title={(cr ?? 0) > 0 ? `${labels.cr}に入れているので入れられません` : undefined} /></td>
                <td><AmountInput value={cr} onChange={setCr} onKeyDown={nav} aria-label={labels.cr} disabled={(dr ?? 0) > 0} title={(dr ?? 0) > 0 ? `${labels.dr}に入れているので入れられません` : undefined} /></td>
                <td>
                  <button className="btn primary block" onClick={save} disabled={isDateClosed(adjustmentOnly ? yearEnd(year) : date)} title={isDateClosed(adjustmentOnly ? yearEnd(year) : date) ? "締めた月です" : undefined}>
                    <CornerDownLeft size={15} /> 登録
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="dock-foot">
            <span className="form-error-inline" role="alert">
              {error ||
                (split ? (
                  <span className="homeuse-hint">家事按分 {hu!.rate}%：事業分 {yen(split.business)} ／ 事業主貸 {yen(split.private)} に分けて登録します</span>
                ) : bookSubs.length > 0 && bookSub === undefined ? (
                  <span className="muted">入力するときは、上で補助科目（または「補助なし」）を選んでください</span>
                ) : "")}
            </span>
            <span className="dock-totals">
              {fullYear ? "期間" : from === to ? periodLabel(from) : `${periodLabel(from)}〜${periodLabel(to)}`}合計　{labels.dr} <b>{yen(totals.dr)}</b>　{labels.cr} <b>{yen(totals.cr)}</b>
            </span>
          </div>
        </div>
      </section>

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
      {importing && <BankImportModal account={account} initialSub={bookSub} onClose={() => setImporting(false)} />}
      {editingTabs && (
        <CashbookTabsModal
          tabs={tabs}
          onClose={() => setEditingTabs(false)}
          onSaved={(ids) => {
            setSavedTabs(ids);
            setEditingTabs(false);
          }}
        />
      )}
    </div>
  );
};
