/**
 * 総勘定元帳
 * 左で科目を選び、右でその科目の動きと残高を確認します。
 * 印刷（この科目・すべての科目、補助科目ごとに分けた補助元帳も）と CSV の書き出し（すべての科目）ができます。
 * 画面では日付（日単位）・金額・摘要でも絞り込める（印刷・CSV は期間のボタンのとおり）。
 */
import { useMemo, useState } from "react";
import { Download, Printer, Search } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { PeriodTabs } from "../../components/MonthRange";
import { PrintPreview } from "../../components/PrintPreview";
import { exportCsvFile } from "../../components/csvExport";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { FullDateInput } from "../../components/Inputs";
import { ADJUSTMENT_PERIOD, buildLedger, closingBalances, periodNote, type LedgerRow } from "../../lib/accounting";
import { parseAmount, shortDate, todayIso, yen } from "../../lib/format";
import { displayClass, displayUse, taxLongLabel, taxShortLabel } from "../../lib/tax";
import { LEDGER_CSV_HEADER, ledgerSection } from "../../lib/printBooks";
import { ownerText, periodsText, type PrintDoc } from "../../lib/printLayout";
import { LEDGER_ORDER, ledgerCsvAll, ledgerHelpers, type BookSource } from "../../lib/bookExport";
import { CATEGORY_LABEL, isBalanceSheet } from "../../constants/accounts";
import { subKey } from "../../lib/types";
import { fileLabel } from "../../lib/business";

export const GeneralLedgerPage = () => {
  const { year, accounts, accountMap, subAccounts, labelOf, subMap, taxYears, settings, counterparties } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();
  const [accountId, setAccountIdRaw] = useState(accounts[0].id);
  const [sub, setSub] = useState<number | null | undefined>(undefined);
  const setAccountId = (id: number) => {
    setAccountIdRaw(id);
    setSub(undefined);
  };
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(ADJUSTMENT_PERIOD);
  const [editing, setEditing] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  // 画面だけの絞り込み：日付（日単位）・金額（借方か貸方）・摘要や相手科目の文字
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minAmt, setMinAmt] = useState("");
  const [maxAmt, setMaxAmt] = useState("");
  const [q, setQ] = useState("");
  // 印刷：対象（この科目 / すべての科目）と、補助科目ごとに分けるか（補助元帳）
  const [printing, setPrinting] = useState(false);
  const [printAll, setPrintAll] = useState(false);
  const [splitSubs, setSplitSubs] = useState(false);

  const balances = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const used = useMemo(() => new Set(lines.map((l) => l.account_id)), [lines]);

  const account = accountMap.get(accountId)!;
  const subs = subAccounts.filter((x) => x.account_id === accountId);
  const base = !isBalanceSheet(account.category)
    ? 0
    : sub === undefined
      ? opening[account.id] ?? 0
      : subOpening[subKey(account.id, sub)] ?? 0;

  /** 伝票番号 → 取引先の名前 */
  const cpOfEntry = useMemo(() => {
    const names = new Map(counterparties.map((c) => [c.id, c.name]));
    const m = new Map<number, string>();
    for (const l of lines) if (l.counterparty_id) m.set(l.entry_id, names.get(l.counterparty_id) ?? "");
    return m;
  }, [lines, counterparties]);
  const narrowed = !!(minAmt.trim() || maxAmt.trim() || q.trim());
  const { carried, rows } = useMemo(() => {
    const all = buildLedger(account, base, lines, accountMap, sub);
    const periodOf = (r: LedgerRow) => (r.isAdjustment ? ADJUSTMENT_PERIOD : Number(r.date.slice(5, 7)));
    // 期間より前と、期間のうち「日付（から）」より前は繰越に入れる（元帳は日付順なので先頭のまとまり）
    const before = (r: LedgerRow) => periodOf(r) < from || (!!dateFrom && r.date < dateFrom);
    const prefix = all.filter(before);
    const lo = parseAmount(minAmt);
    const hi = parseAmount(maxAmt);
    const query = q.trim();
    const hit = (r: LedgerRow) => {
      const amount = r.debit || r.credit;
      if (lo != null && amount < lo) return false;
      if (hi != null && amount > hi) return false;
      if (!query) return true;
      const counter = r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter;
      return `${r.memo} ${counter} ${r.subId ? subMap.get(r.subId)?.name ?? "" : ""} ${cpOfEntry.get(r.entry_id) ?? ""}`.includes(query);
    };
    return {
      carried: prefix.length ? prefix[prefix.length - 1].balance : base,
      rows: all.filter((r) => !before(r) && periodOf(r) <= to && (!dateTo || r.date <= dateTo) && hit(r)),
    };
  }, [account, base, lines, accountMap, from, to, sub, dateFrom, dateTo, minAmt, maxAmt, q, labelOf, subMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = rows.reduce((t, r) => ({ dr: t.dr + r.debit, cr: t.cr + r.credit }), { dr: 0, cr: 0 });

  // 残高か動きがある科目だけ（「すべて表示」で全科目）
  const visible = accounts.filter(
    (a) => showAll || a.id === accountId || used.has(a.id) || (balances.get(a.id) ?? 0) !== 0,
  );

  // ── 印刷・CSV（相手科目・税区分などの名前と、対象の科目は lib/bookExport.ts。まとめての書き出しと同じ） ──
  const book: BookSource = useMemo(() => ({ accounts, subs: subAccounts, counterparties, taxYears, opening, subOpening, lines }), [accounts, subAccounts, counterparties, taxYears, opening, subOpening, lines]);
  const { counterOf, taxOf, subName, baseOf, targets: allTargets } = useMemo(() => ledgerHelpers(book), [book]);
  /** 期間（1〜13。13 = 決算整理） */
  const period = { from, to };
  /** 印刷の対象の科目（すべて = 残高か動きがある科目） */
  const targets = (all: boolean) => (all ? allTargets() : [account]);

  const printDoc = useMemo((): PrintDoc | null => {
    if (!printing) return null;
    const sections = targets(printAll).flatMap((a) => {
      // 分ける単位：補助科目ごと（補助なしを含む。動きか残高があるものだけ）か、画面で選んでいる補助科目か、科目全体
      const subsOf = subAccounts.filter((x) => x.account_id === a.id);
      const units: (number | null | undefined)[] =
        !printAll && sub !== undefined ? [sub]
          : splitSubs && subsOf.length > 0
            ? [...subsOf.map((x) => x.id), null].filter((s) => baseOf(a, s) !== 0 || lines.some((l) => l.account_id === a.id && (l.sub_account_id ?? null) === s))
            : [undefined];
      return units.map((s) => {
        const rows = buildLedger(a, baseOf(a, s), lines, accountMap, s);
        return ledgerSection({
          heading: s === undefined ? a.name : `${a.name}　${s === null ? "補助なし" : subName(s)}`,
          rows, opening: baseOf(a, s), ...period, labels: { dr: "借方", cr: "貸方" }, counterOf, taxOf,
          noteOf: (r) => [s === undefined ? subName(r.subId) : "", cpOfEntry.get(r.entry_id) ?? ""].filter(Boolean).join("　"),
        });
      });
    });
    return {
      title: "総勘定元帳", owner: ownerText(settings.business_name, settings.owner_name),
      period: periodsText(year, from, to), printedOn: todayIso(), sections,
    };
  }, [printing, printAll, splitSubs, account, sub, lines, opening, subOpening, from, to, year, settings, cpOfEntry, accounts, subAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = () => exportCsvFile(`総勘定元帳_${fileLabel(settings)}_${year}.csv`, LEDGER_CSV_HEADER, ledgerCsvAll(book, from, to), toast);

  return (
    <div className="page">
      <PageHeader title="総勘定元帳">
        <PeriodTabs from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        {periodNote(from, to) && <span className="badge badge-adjust period-note">{periodNote(from, to)}</span>}
        <button className="btn ghost" onClick={exportCsv} title="すべての科目の元帳を、表示中の期間で書き出します"><Download size={16} /> CSV 書き出し</button>
        <button className="btn ghost" onClick={() => setPrinting(true)}><Printer size={16} /> 印刷</button>
      </PageHeader>

      <div className="split">
        <aside className="account-rail" aria-label="勘定科目">
          {LEDGER_ORDER.map((cat) => {
            const items = visible.filter((a) => a.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="rail-group">
                <div className="rail-cat">{CATEGORY_LABEL[cat]}</div>
                {items.map((a) => (
                  <button key={a.id} className={`rail-item${a.id === accountId ? " on" : ""}`} onClick={() => setAccountId(a.id)}>
                    <span>{a.name}</span>
                    <span className="num">{yen(balances.get(a.id) ?? 0)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          <label className="rail-toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 動きのない科目も表示
          </label>
        </aside>

        <section className="sheet sheet-fill">
          <div className="sheet-title">
            <h2>{account.name}</h2>
            <span className="muted">{account.code}・{CATEGORY_LABEL[account.category]}</span>
          </div>
          {subs.length > 0 && (
            <div className="sub-picker" role="tablist" aria-label="補助科目">
              <span className="sub-picker-label">補助科目</span>
              <button role="tab" aria-selected={sub === undefined} className={sub === undefined ? "on" : ""} onClick={() => setSub(undefined)}>全体</button>
              {subs.map((x) => (
                <button key={x.id} role="tab" aria-selected={sub === x.id} className={sub === x.id ? "on" : ""} onClick={() => setSub(x.id)}>{x.name}</button>
              ))}
              <button role="tab" aria-selected={sub === null} className={sub === null ? "on" : ""} onClick={() => setSub(null)}>補助なし</button>
            </div>
          )}
          <div className="filters ledger-filters">
            <span className="filter-label">日付</span>
            <FullDateInput value={dateFrom} onChange={setDateFrom} year={year} aria-label="取引年月日（から）" />
            <span>〜</span>
            <FullDateInput value={dateTo} onChange={setDateTo} year={year} aria-label="取引年月日（まで）" />
            <div className="amount-range">
              <input className="input" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} placeholder="金額 下限" inputMode="numeric" aria-label="金額の下限" />
              <span>〜</span>
              <input className="input" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="上限" inputMode="numeric" aria-label="金額の上限" />
            </div>
            <label className="search">
              <Search size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="摘要・相手科目・取引先で探す" />
            </label>
            {(dateFrom || dateTo || narrowed) && <span className="muted small">印刷・CSV は、この絞り込みを使わず期間のボタンのとおりに出します</span>}
          </div>
          <div className="table-wrap scroll-y">
            <table className="ledger">
              <colgroup>
                <col style={{ width: 64 }} />
                <col style={{ width: 56 }} />
                <col style={{ width: "17%" }} />
                <col />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "15%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>日付</th>
                  <th className="num" title="伝票番号（仕訳日記帳の No. と同じ）">No.</th>
                  <th>相手科目</th>
                  <th>摘要</th>
                  <th className="num dr">借方</th>
                  <th className="num cr">貸方</th>
                  <th className="num">残高</th>
                </tr>
              </thead>
              <tbody>
                <tr className="carried">
                  <td colSpan={2} />
                  <td colSpan={4}>{dateFrom ? `${shortDate(dateFrom)} の前日までの残高` : from === 1 ? "前期より繰越" : "前月より繰越"}</td>
                  <td className="num">{yen(carried)}</td>
                </tr>
                {rows.map((r, i) => {
                  const lt = { date: r.date, tax_code: r.taxCode, business_class: r.businessClass, purchase_use: r.purchaseUse };
                  return (
                  <tr key={`${r.entry_id}-${i}`} className="clickable" onClick={() => setEditing(r.entry_id)}>
                    <td>{shortDate(r.date)}</td>
                    <td className="num muted">{r.entry_id}</td>
                    <td>{r.counterAccountId ? labelOf(r.counterAccountId, r.counterSubId) : r.counter}</td>
                    <td className="memo">
                      {sub === undefined && r.subId && <span className="sub-tag">{subMap.get(r.subId)?.name}</span>}
                      {r.memo}
                      {r.taxCode && r.taxCode !== "none" && (
                        <span className="tax-tag" title={taxLongLabel(r.taxCode, r.invoiceKind, r.date, displayClass(taxYears, lt), displayUse(taxYears, lt))}>
                          {taxShortLabel(r.taxCode, r.invoiceKind, r.date, displayClass(taxYears, lt), displayUse(taxYears, lt))}
                        </span>
                      )}
                    </td>
                    <td className="num">{yen(r.debit, { blankZero: true })}</td>
                    <td className="num">{yen(r.credit, { blankZero: true })}</td>
                    <td className={`num${r.balance < 0 ? " negative" : ""}`}>{yen(r.balance)}</td>
                  </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr className="empty-row"><td colSpan={7}>{narrowed || dateFrom || dateTo ? "条件に合う動きはありません。" : "この期間の動きはありません。"}</td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="total-label">{narrowed ? "絞り込んだ行の合計" : "期間合計"}</td>
                  <td className="num">{yen(sum.dr)}</td>
                  <td className="num">{yen(sum.cr)}</td>
                  <td className="num">{narrowed ? "" : yen(rows.length ? rows[rows.length - 1].balance : carried)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </div>

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
      {printing && (
        <PrintPreview doc={printDoc} onClose={() => setPrinting(false)}>
          <select value={printAll ? "all" : "one"} onChange={(e) => setPrintAll(e.target.value === "all")} aria-label="印刷する科目">
            <option value="one">{account.name}{sub !== undefined ? `（${sub === null ? "補助なし" : subName(sub)}）` : ""}</option>
            <option value="all">すべての科目（科目ごとに改ページ）</option>
          </select>
          {(printAll || (sub === undefined && subs.length > 0)) && (
            <label><input type="checkbox" checked={splitSubs} onChange={(e) => setSplitSubs(e.target.checked)} /> 補助科目ごとに分ける（補助元帳）</label>
          )}
        </PrintPreview>
      )}
    </div>
  );
};
