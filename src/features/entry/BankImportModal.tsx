/**
 * 銀行・カードの明細の取り込み（帳簿入力の画面から開く。計算は lib/bankImport.ts）
 *  - CSV を読む：列の対応を選んで（見出しから推測。口座ごとに覚える）、明細を「未登録の明細」に足す。前に読んだ明細は足さない
 *  - 未登録の明細：相手科目・税区分・摘要・取引先を決めて仕訳にする（ルール → 前の仕訳 の順で推測）。取り込まない明細も決められる
 *  - ルール：摘要に含む言葉ごとに、相手科目などを決めておく
 * 仕訳はこの口座（科目・補助科目）と相手科目の2行。税区分は相手科目の側。家事按分（入力のたびに分ける科目）は事業分と事業主貸に分ける
 */
import { useEffect, useMemo, useState } from "react";
import { CornerDownLeft, FileUp, Plus, Trash2, Undo2, Wand2, X } from "lucide-react";
import { useAppContext, useYearData } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { AccountWithSub, CounterpartyField, MemoInput, TaxSelect } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { decodeText } from "../../lib/evidence";
import { parseCsv } from "../../lib/csv";
import { shortDate, yen } from "../../lib/format";
import {
  columnMapProblem, findBookDuplicate, guessColumns, guessLine, learnFromBooks, parseStatement, type BankRule, type ColumnMap, type HistoryHit,
} from "../../lib/bankImport";
import { entryRateOf, splitLinesByHomeUse } from "../../lib/homeUse";
import { CODE } from "../../constants/accounts";
import type { FlatLine } from "../../lib/accounting";
import { subKey, type Account, type HomeUseRate, type InvoiceKind, type JournalLine, type PurchaseUse, type TaxCode } from "../../lib/types";
import * as repo from "../../db/repo";
import { taxCodeDef } from "../../lib/tax";

type View = "pending" | "read" | "skipped" | "rules";

/** 行ごとに決める中身 */
interface Draft {
  checked: boolean;
  counterId: number | null;
  counterSubId: number | null;
  tax: { code: TaxCode | null; invoice: InvoiceKind | null; cls: number | null; use: PurchaseUse | null };
  memo: string;
  counterpartyId: number | null;
  source: "rule" | "history" | null;
  dupEntry: number | null;
}

const EMPTY_MAP: ColumnMap = { headerRow: 0, date: 0, description: [], mode: "split", increase: null, decrease: null, amount: null, invert: false, balance: null };

/** 口座の列見出し（増える側・減る側） */
const sideLabels = (a: Account) =>
  a.code === CODE.CASH ? { inc: "入金", dec: "出金" }
    : a.category === "asset" ? { inc: "入金", dec: "出金" }
      : { inc: "ご利用（増加）", dec: "返金・支払（減少）" };

export const BankImportModal = ({ account, initialSub, onClose }: { account: Account; initialSub: number | null | undefined; onClose: () => void }) => {
  const { db, accounts, activeSubsOf, subMap, labelOf, isDateClosed, bump, dataVersion, year, can } = useAppContext();
  const toast = useToast();
  const { opening, subOpening } = useYearData();
  const subs = activeSubsOf(account.id);
  const [subId, setSubId] = useState<number | null>(initialSub === undefined ? (subs[0]?.id ?? null) : initialSub);
  const [view, setView] = useState<View>("pending");
  const labels = sideLabels(account);
  const mayEdit = can("entry");
  const accountName = `${account.name}${subId ? `／${subMap.get(subId)?.name ?? ""}` : ""}`;

  // ── 読み込んだ明細・ルール・帳簿（推測と重複の確かめに使う） ──
  const [rows, setRows] = useState<repo.BankLineRow[]>([]);
  const [rules, setRules] = useState<BankRule[]>([]);
  const [allLines, setAllLines] = useState<FlatLine[]>([]);
  const [history, setHistory] = useState<Map<string, HistoryHit>>(new Map());
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([repo.getBankLines(db, account.id, subId), repo.getBankRules(db), repo.getLines(db, "1900-01-01", "2999-12-31"), repo.getBankHistory(db, account.id, subId)])
      .then(([r, ru, ls, h]) => {
        if (!alive) return;
        setRows(r);
        setRules(ru);
        setAllLines(ls);
        setHistory(learnFromBooks(ls, account.id, subId, h));
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, account.id, subId, dataVersion, reload]);

  const pending = rows.filter((r) => r.status === "pending");
  const skipped = rows.filter((r) => r.status === "skipped");

  // ── 行ごとの中身（推測で始める。読み直しても、手で変えた行はそのまま） ──
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  useEffect(() => {
    setDrafts((prev) => {
      const next = new Map<number, Draft>();
      const used = new Set<number>();
      for (const r of pending) {
        const old = prev.get(r.id);
        if (old) { next.set(r.id, old); continue; }
        const g = guessLine(r, account, rules, history);
        const dup = findBookDuplicate(r, allLines, account.id, subId, used);
        if (dup) used.add(dup);
        next.set(r.id, {
          checked: !!g.counterId && !dup, counterId: g.counterId, counterSubId: g.counterSubId,
          tax: { code: g.taxCode, invoice: g.invoice, cls: null, use: null }, memo: g.memo, counterpartyId: g.counterpartyId, source: g.source, dupEntry: dup,
        });
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rules, history, allLines]);
  const patch = (id: number, p: Partial<Draft>) => setDrafts((m) => new Map(m).set(id, { ...m.get(id)!, ...p }));

  /** ルールを当て直す（手で変えた行も、ルールに合えば書き換える） */
  const applyRules = () => {
    const next = new Map(drafts);
    let n = 0;
    for (const r of pending) {
      const g = guessLine(r, account, rules, new Map());
      const d = next.get(r.id);
      if (g.source !== "rule" || !d) continue;
      next.set(r.id, { ...d, counterId: g.counterId, counterSubId: g.counterSubId, tax: { code: g.taxCode, invoice: g.invoice, cls: null, use: null }, memo: g.memo, counterpartyId: g.counterpartyId, source: "rule", checked: !d.dupEntry });
      n++;
    }
    setDrafts(next);
    toast(n ? `${n} 件にルールを当てました` : "ルールに合う明細はありません");
  };

  // ── 仕訳にする ──
  const drawId = accounts.find((a) => a.code === CODE.OWNER_DRAW)?.id;
  const [busy, setBusy] = useState(false);
  const checked = pending.filter((r) => drafts.get(r.id)?.checked);
  const register = async () => {
    const problems: string[] = [];
    const items: { lineId: number; date: string; lines: JournalLine[]; counterpartyId: number | null }[] = [];
    const years = [...new Set(checked.map((r) => Number(r.date.slice(0, 4))))];
    const rates = new Map<number, HomeUseRate[]>(await Promise.all(years.map(async (y) => [y, await repo.getHomeUseRates(db, y)] as const)));
    for (const r of checked) {
      const d = drafts.get(r.id)!;
      const where = `${shortDate(r.date)} ${r.description}`;
      if (!d.counterId) { problems.push(`${where}：相手科目を選んでください`); continue; }
      if (d.counterId === account.id && (d.counterSubId ?? null) === subId) { problems.push(`${where}：相手科目に、この口座と同じ科目・補助科目は使えません`); continue; }
      if (isDateClosed(r.date)) { problems.push(`${where}：締めた月の明細です`); continue; }
      const tax = {
        ...(d.tax.code ? { tax_code: d.tax.code } : {}), ...(d.tax.invoice ? { invoice_kind: d.tax.invoice } : {}),
        ...(d.tax.cls ? { business_class: d.tax.cls } : {}), ...(d.tax.use ? { purchase_use: d.tax.use } : {}),
      };
      const m = d.memo.trim();
      const mine: JournalLine = { row_no: 1, side: r.side, account_id: account.id, sub_account_id: subId, amount: r.amount, memo: m };
      const other: JournalLine = { row_no: 1, side: r.side === "debit" ? "credit" : "debit", account_id: d.counterId, sub_account_id: d.counterSubId, amount: r.amount, memo: m, ...tax };
      let lines = r.side === "debit" ? [mine, other] : [other, mine];
      if (drawId) lines = splitLinesByHomeUse(lines, entryRateOf(rates.get(Number(r.date.slice(0, 4))) ?? [], accounts), drawId).lines;
      items.push({ lineId: r.id, date: r.date, lines, counterpartyId: d.counterpartyId });
    }
    if (problems.length) {
      toast(problems.slice(0, 3).join("／") + (problems.length > 3 ? ` ほか ${problems.length - 3} 件` : ""), "error");
      return;
    }
    setBusy(true);
    try {
      const files = [...new Set(checked.map((r) => r.file_name).filter(Boolean))];
      await repo.registerBankLines(db, items, files.join("・") || "明細");
      bump();
      toast(`${items.length} 件の明細を仕訳にしました`);
    } catch (e) {
      toast(`登録できませんでした（1件も登録していません）：${String(e).replace(/^Error: /, "")}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (ids: number[], status: "pending" | "skipped") => {
    if (!ids.length) return;
    try {
      await repo.setBankLinesStatus(db, ids, status);
      setReload((n) => n + 1);
      bump();
      toast(status === "skipped" ? `${ids.length} 件を取り込まないことにしました` : `${ids.length} 件を未登録に戻しました`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  // ── 残高の確かめ（CSV に残高があるとき：いちばん新しい明細の残高と、その日の帳簿の残高） ──
  const balanceCheck = useMemo(() => {
    const last = [...rows].filter((r) => r.balance !== null).sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1)).pop();
    if (!last || last.date.slice(0, 4) !== String(year)) return null;
    return { date: last.date, csv: last.balance! };
  }, [rows, year]);
  const [bookBalance, setBookBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!balanceCheck) return setBookBalance(null);
    // 補助科目のある科目は補助科目ごと（補助なしを含む）、無い科目は科目の期首残高から
    const base = subs.length || subId !== null ? subOpening[subKey(account.id, subId)] ?? 0 : opening[account.id] ?? 0;
    const sign = (side: string) => (side === account.normal_side ? 1 : -1);
    const moved = allLines.filter((l) => !l.is_deleted && l.account_id === account.id && (subs.length || subId !== null ? (l.sub_account_id ?? null) === subId : true)
      && l.date >= `${year}-01-01` && l.date <= balanceCheck.date).reduce((t, l) => t + sign(l.side) * l.amount, 0);
    setBookBalance(base + moved);
  }, [balanceCheck, allLines, year, account, subId, subs.length, opening, subOpening]);

  // ── ルールにする（その行から） ──
  const [ruleDraft, setRuleDraft] = useState<BankRule | null>(null);
  const ruleFromRow = (r: repo.BankLineRow) => {
    const d = drafts.get(r.id)!;
    setRuleDraft({
      id: 0, keyword: r.description.slice(0, 50), direction: r.side === account.normal_side ? "increase" : "decrease", target_account_id: account.id,
      account_id: d.counterId ?? 0, sub_account_id: d.counterSubId, tax_code: d.tax.code, invoice_kind: d.tax.invoice, counterparty_id: d.counterpartyId,
      memo: d.memo === r.description ? "" : d.memo, sort_order: 0,
    });
    setView("rules");
  };

  return (
    <Modal title="明細の取り込み" onClose={onClose} width={1280}>
      <div className="bank-import">
        <div className="bank-head">
          <span className="bank-account">取り込む口座：<b>{account.name}</b></span>
          {subs.length > 0 && (
            <select className="input sm" value={subId ?? ""} onChange={(e) => { setSubId(e.target.value ? Number(e.target.value) : null); setDrafts(new Map()); }} aria-label="補助科目">
              {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="">補助なし</option>
            </select>
          )}
          <div className="seg" role="tablist">
            {([["pending", `未登録の明細（${pending.length}）`], ["read", "CSV を読む"], ["skipped", `取り込まない（${skipped.length}）`], ["rules", `ルール（${rules.length}）`]] as [View, string][]).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{l}</button>
            ))}
          </div>
        </div>

        {view === "read" && (
          <ReadView account={account} subId={subId} accountName={accountName} disabled={!mayEdit} onRead={() => { setReload((n) => n + 1); setView("pending"); }} />
        )}

        {view === "pending" && (
          pending.length === 0 ? (
            <p className="empty-note">未登録の明細はありません。「CSV を読む」で、銀行・カードの明細の CSV を読み込んでください。</p>
          ) : (
            <>
              {balanceCheck && bookBalance !== null && (
                <p className={balanceCheck.csv === bookBalance ? "field-note" : "notice"}>
                  {shortDate(balanceCheck.date)} の残高：明細 {yen(balanceCheck.csv)}円・帳簿 {yen(bookBalance)}円
                  {balanceCheck.csv === bookBalance ? "（合っています）" : `（差 ${yen(balanceCheck.csv - bookBalance)}円。未登録の明細を仕訳にすると合うはずです）`}
                </p>
              )}
              <div className="table-wrap scroll-y bank-scroll">
                <table className="ledger bank-table">
                  <colgroup>
                    <col style={{ width: 34 }} /><col style={{ width: 58 }} /><col style={{ width: 170 }} /><col style={{ width: 92 }} /><col style={{ width: 92 }} />
                    <col style={{ width: 170 }} /><col style={{ width: 130 }} /><col /><col style={{ width: 92 }} /><col style={{ width: 70 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <input type="checkbox" aria-label="全部を選ぶ" checked={pending.length > 0 && pending.every((r) => drafts.get(r.id)?.checked)}
                          onChange={(e) => setDrafts((m) => new Map([...m].map(([k, d]) => [k, { ...d, checked: e.target.checked }])))} />
                      </th>
                      <th>日付</th><th>明細の摘要</th><th className="num">{labels.inc}</th><th className="num">{labels.dec}</th>
                      <th>相手科目</th><th>税区分</th><th>仕訳の摘要・取引先</th><th>推測</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((r) => {
                      const d = drafts.get(r.id);
                      if (!d) return null;
                      const inc = r.side === account.normal_side;
                      return (
                        <tr key={r.id} className={d.checked ? "" : "bank-off"}>
                          <td><input type="checkbox" checked={d.checked} onChange={(e) => patch(r.id, { checked: e.target.checked })} aria-label={`${r.description}を仕訳にする`} /></td>
                          <td>{shortDate(r.date)}</td>
                          <td className="bank-desc" title={r.file_name}>{r.description}</td>
                          <td className="num">{inc ? yen(r.amount) : ""}</td>
                          <td className="num">{inc ? "" : yen(r.amount)}</td>
                          <td>
                            <AccountWithSub accountId={d.counterId} subId={d.counterSubId} label="相手科目"
                              onAccount={(v) => patch(r.id, { counterId: v, counterSubId: null, tax: { code: null, invoice: null, cls: null, use: null }, checked: !!v || d.checked })}
                              onSub={(v) => patch(r.id, { counterSubId: v })} />
                          </td>
                          <td>
                            <TaxSelect label="税区分" value={d.tax.code} invoice={d.tax.invoice} businessClass={d.tax.cls} purchaseUse={d.tax.use} accountId={d.counterId}
                              side={r.side === "debit" ? "credit" : "debit"} date={r.date} counterpartyId={d.counterpartyId}
                              onChange={(code, invoice, cls, use) => patch(r.id, { tax: { code, invoice, cls, use } })} />
                          </td>
                          <td>
                            <div className="memo-cp">
                              <MemoInput value={d.memo} onChange={(v) => patch(r.id, { memo: v })} aria-label="仕訳の摘要" />
                              <CounterpartyField value={d.counterpartyId} onChange={(v) => patch(r.id, { counterpartyId: v })} aria-label="取引先" />
                            </div>
                          </td>
                          <td>
                            {d.dupEntry ? <span className="badge bank-dup" title={`帳簿に同じ日・同じ金額の仕訳（伝票 No.${d.dupEntry}）があります`}>重複かも</span>
                              : d.source === "rule" ? <span className="badge badge-adjust">ルール</span>
                                : d.source === "history" ? <span className="badge">前の仕訳</span> : null}
                          </td>
                          <td className="row-actions">
                            <button className="link-btn" onClick={() => ruleFromRow(r)} title="この行からルールを作る"><Wand2 size={13} /></button>
                            <button className="link-btn" onClick={() => setStatus([r.id], "skipped")} disabled={!mayEdit} title="取り込まない"><X size={13} /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="bank-foot">
                <span className="muted">
                  チェックした明細を、{accountName} と相手科目の仕訳にします（税区分は相手科目の側。空なら科目・取引先の初期値）。「重複かも」は、帳簿に同じ日・同じ金額の仕訳がある明細です。
                </span>
                <button className="btn ghost" onClick={applyRules} disabled={!rules.length}><Wand2 size={15} /> ルールを当て直す</button>
                <button className="btn ghost" onClick={() => setStatus(checked.map((r) => r.id), "skipped")} disabled={!mayEdit || !checked.length}><X size={15} /> 取り込まない</button>
                <button className="btn primary" onClick={register} disabled={!mayEdit || busy || !checked.length}><CornerDownLeft size={15} /> {checked.length} 件を仕訳にする</button>
              </div>
            </>
          )
        )}

        {view === "skipped" && (
          skipped.length === 0 ? <p className="empty-note">取り込まないことにした明細はありません。</p> : (
            <div className="table-wrap scroll-y bank-scroll">
              <table className="ledger">
                <thead><tr><th style={{ width: 70 }}>日付</th><th>明細の摘要</th><th className="num" style={{ width: 110 }}>{labels.inc}</th><th className="num" style={{ width: 110 }}>{labels.dec}</th><th style={{ width: 120 }} /></tr></thead>
                <tbody>
                  {skipped.map((r) => (
                    <tr key={r.id}>
                      <td>{shortDate(r.date)}</td><td>{r.description}</td>
                      <td className="num">{r.side === account.normal_side ? yen(r.amount) : ""}</td><td className="num">{r.side === account.normal_side ? "" : yen(r.amount)}</td>
                      <td><button className="link-btn" onClick={() => setStatus([r.id], "pending")} disabled={!mayEdit}><Undo2 size={13} /> 未登録に戻す</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {view === "rules" && (
          <RulesView rules={rules} account={account} draft={ruleDraft} setDraft={setRuleDraft} labelOf={labelOf} disabled={!mayEdit} onChanged={() => setReload((n) => n + 1)} />
        )}
      </div>
    </Modal>
  );
};

// ────────────────────────────────────────────
// CSV を読む
// ────────────────────────────────────────────

const ReadView = ({ account, subId, accountName, disabled, onRead }: {
  account: Account; subId: number | null; accountName: string; disabled: boolean; onRead: () => void;
}) => {
  const { db, year } = useAppContext();
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [map, setMap] = useState<ColumnMap>(EMPTY_MAP);
  const [busy, setBusy] = useState(false);
  const table = useMemo(() => (text ? parseCsv(text) : []), [text]);
  const width = Math.max(0, ...table.slice(0, 30).map((r) => r.length));
  const head = map.headerRow >= 0 ? table[map.headerRow] ?? [] : [];
  const colName = (i: number) => `${i + 1}列目${head[i]?.trim() ? `：${head[i].trim()}` : ""}`;
  const parsed = useMemo(() => (text && !columnMapProblem(map) ? parseStatement(text, map, account, year) : null), [text, map, account, year]);
  const labels = sideLabels(account);

  const pick = async (f: File | undefined) => {
    setText("");
    setFileName("");
    if (!f) return;
    const t = decodeText(new Uint8Array(await f.arrayBuffer()));
    setFileName(f.name);
    setText(t);
    const saved = await repo.getBankFormat(db, account.id, subId);
    setMap(saved ?? guessColumns(parseCsv(t)) ?? EMPTY_MAP);
  };
  const read = async () => {
    if (!parsed || parsed.problems.length) return;
    setBusy(true);
    try {
      await repo.saveBankFormat(db, account.id, subId, map);
      const r = await repo.addBankLines(db, account.id, subId, parsed.lines, fileName);
      toast(`${r.added} 件の明細を読み込みました${r.known ? `（前に読んだ ${r.known} 件は除きました）` : ""}`);
      onRead();
    } catch (e) {
      toast(`読み込めませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const col = (value: number | null, onChange: (v: number | null) => void, label: string, optional = true) => (
    <label className="field">
      <span>{label}</span>
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} disabled={disabled}>
        {optional && <option value="">（使わない）</option>}
        {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{colName(i)}</option>)}
      </select>
    </label>
  );

  return (
    <div className="settings-form bank-read">
      <p className="prose">
        銀行・カードのサイトから書き出した明細の CSV を、{accountName} の明細として読み込みます（UTF-8・Shift_JIS）。列の対応は見出しから推測し、口座ごとに覚えます。
        前に読んだ明細（日付・金額・摘要が同じもの）は、もう一度は読み込みません。
      </p>
      <label className="field">
        <span>CSV ファイル</span>
        <input className="input file-input" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => pick(e.target.files?.[0])} disabled={disabled} />
        {fileName && <span className="field-note"><FileUp size={13} /> {fileName}</span>}
      </label>
      {text && (
        <>
          <div className="field-row wrap bank-map">
            <label className="field" style={{ maxWidth: 120 }}>
              <span>見出しの行</span>
              <select className="input" value={map.headerRow} onChange={(e) => setMap({ ...map, headerRow: Number(e.target.value) })} disabled={disabled}>
                <option value={-1}>なし</option>
                {table.slice(0, 20).map((_, i) => <option key={i} value={i}>{i + 1}行目</option>)}
              </select>
            </label>
            {col(map.date, (v) => setMap({ ...map, date: v ?? 0 }), "日付", false)}
            {col(map.description[0] ?? null, (v) => setMap({ ...map, description: [v, map.description[1]].filter((x): x is number => x !== null && x !== undefined) }), "摘要")}
            {col(map.description[1] ?? null, (v) => setMap({ ...map, description: [map.description[0], v].filter((x): x is number => x !== null && x !== undefined) }), "摘要（2つ目）")}
            <label className="field" style={{ maxWidth: 200 }}>
              <span>金額の形</span>
              <select className="input" value={map.mode} onChange={(e) => setMap({ ...map, mode: e.target.value as ColumnMap["mode"] })} disabled={disabled}>
                <option value="split">{labels.inc}と{labels.dec}が別の列</option>
                <option value="signed">金額が1列（＋−）</option>
              </select>
            </label>
            {map.mode === "split" ? (
              <>
                {col(map.increase, (v) => setMap({ ...map, increase: v }), labels.inc)}
                {col(map.decrease, (v) => setMap({ ...map, decrease: v }), labels.dec)}
              </>
            ) : (
              <>
                {col(map.amount, (v) => setMap({ ...map, amount: v }), "金額")}
                <label className="check" style={{ alignSelf: "flex-end" }}>
                  <input type="checkbox" checked={map.invert} onChange={(e) => setMap({ ...map, invert: e.target.checked })} disabled={disabled} />
                  ＋を{labels.dec}として読む
                </label>
              </>
            )}
            {col(map.balance, (v) => setMap({ ...map, balance: v }), "残高")}
          </div>
          {columnMapProblem(map) && <p className="notice">{columnMapProblem(map)}</p>}
          {parsed && (
            <>
              {parsed.problems.length > 0 && (
                <div className="notice" role="alert">
                  {parsed.problems.length} 行を読めません（列の対応を確かめてください）：
                  {parsed.problems.slice(0, 5).map((p) => `${p.row}行目 ${p.message}`).join("／")}
                </div>
              )}
              <p className="import-summary">
                <b>{parsed.lines.length}</b> 件の明細
                {parsed.lines.length > 0 && `（${parsed.lines[0].date.replace(/-/g, "/")}〜${parsed.lines[parsed.lines.length - 1].date.replace(/-/g, "/")}）`}
                {parsed.skipped > 0 && <span className="muted">　日付・金額の無い {parsed.skipped} 行は飛ばします</span>}
              </p>
              {parsed.lines.length > 0 && (
                <div className="table-wrap scroll-y import-scroll">
                  <table className="ledger">
                    <thead><tr><th className="num" style={{ width: 56 }}>行</th><th style={{ width: 110 }}>日付</th><th>摘要</th><th className="num" style={{ width: 110 }}>{labels.inc}</th><th className="num" style={{ width: 110 }}>{labels.dec}</th><th className="num" style={{ width: 120 }}>残高</th></tr></thead>
                    <tbody>
                      {parsed.lines.slice(0, 50).map((l) => (
                        <tr key={l.fingerprint}>
                          <td className="num">{l.row}</td><td>{l.date.replace(/-/g, "/")}</td><td>{l.description}</td>
                          <td className="num">{l.side === account.normal_side ? yen(l.amount) : ""}</td><td className="num">{l.side === account.normal_side ? "" : yen(l.amount)}</td>
                          <td className="num">{l.balance === null ? "" : yen(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div>
                <button className="btn primary" onClick={read} disabled={disabled || busy || parsed.problems.length > 0 || parsed.lines.length === 0}>
                  <FileUp size={16} /> 未登録の明細に読み込む
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

// ────────────────────────────────────────────
// ルール
// ────────────────────────────────────────────

const newRule = (accountId: number): BankRule => ({
  id: 0, keyword: "", direction: "decrease", target_account_id: accountId, account_id: 0, sub_account_id: null, tax_code: null, invoice_kind: null,
  counterparty_id: null, memo: "", sort_order: 0,
});

const RulesView = ({ rules, account, draft, setDraft, labelOf, disabled, onChanged }: {
  rules: BankRule[]; account: Account; draft: BankRule | null; setDraft: (r: BankRule | null) => void;
  labelOf: (id: number, sub?: number | null) => string; disabled: boolean; onChanged: () => void;
}) => {
  const { db, accountMap, counterparties } = useAppContext();
  const toast = useToast();
  const labels = sideLabels(account);
  const save = async () => {
    if (!draft) return;
    try {
      await repo.saveBankRule(db, draft);
      setDraft(null);
      onChanged();
      toast("ルールを保存しました。「未登録の明細」の「ルールを当て直す」で、読み込んである明細にも当てられます");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const remove = async (id: number) => {
    try {
      await repo.deleteBankRule(db, id);
      onChanged();
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  const dirLabel = (d: BankRule["direction"]) => (d === "increase" ? labels.inc : d === "decrease" ? labels.dec : "どちらも");
  return (
    <div className="bank-rules">
      <p className="prose">
        明細の摘要に「含む言葉」がある明細に、相手科目・税区分・取引先・仕訳の摘要を入れます。上のルールから順に当てはめ、最初に合ったものを使います。
        ルールに合わない明細は、同じ口座で前に同じ摘要だった仕訳に合わせます。
      </p>
      {draft ? (
        <div className="settings-form bank-rule-form">
          <div className="field-row wrap">
            <label className="field" style={{ maxWidth: 260 }}>
              <span>摘要に含む言葉</span>
              <input className="input" value={draft.keyword} maxLength={50} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })} disabled={disabled} />
            </label>
            <label className="field" style={{ maxWidth: 170 }}>
              <span>明細</span>
              <select className="input" value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as BankRule["direction"] })} disabled={disabled}>
                <option value="decrease">{labels.dec}だけ</option>
                <option value="increase">{labels.inc}だけ</option>
                <option value="any">どちらも</option>
              </select>
            </label>
            <label className="field" style={{ maxWidth: 200 }}>
              <span>使う口座</span>
              <select className="input" value={draft.target_account_id ?? ""} onChange={(e) => setDraft({ ...draft, target_account_id: e.target.value ? Number(e.target.value) : null })} disabled={disabled}>
                <option value={account.id}>{account.name}だけ</option>
                <option value="">どの口座にも</option>
              </select>
            </label>
          </div>
          <div className="field-row wrap">
            <div className="field" style={{ maxWidth: 240 }}>
              <span>相手科目</span>
              <AccountWithSub accountId={draft.account_id || null} subId={draft.sub_account_id} label="相手科目"
                onAccount={(v) => setDraft({ ...draft, account_id: v ?? 0, sub_account_id: null, tax_code: null, invoice_kind: null })} onSub={(v) => setDraft({ ...draft, sub_account_id: v })} />
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <span>税区分</span>
              <TaxSelect label="税区分" value={draft.tax_code} invoice={draft.invoice_kind} accountId={draft.account_id || null}
                side={draft.direction === "increase" ? (account.normal_side === "debit" ? "credit" : "debit") : account.normal_side} date={`${new Date().getFullYear()}-12-31`}
                counterpartyId={draft.counterparty_id} onChange={(code, invoice) => setDraft({ ...draft, tax_code: code, invoice_kind: invoice })} />
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <span>取引先</span>
              <CounterpartyField value={draft.counterparty_id} onChange={(v) => setDraft({ ...draft, counterparty_id: v })} aria-label="取引先" />
            </div>
            <label className="field">
              <span>仕訳の摘要（空なら明細の摘要）</span>
              <input className="input" value={draft.memo} maxLength={200} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} disabled={disabled} />
            </label>
          </div>
          <div className="voucher-actions">
            <button className="btn ghost" onClick={() => setDraft(null)}>やめる</button>
            <button className="btn primary" onClick={save} disabled={disabled}>ルールを保存する</button>
          </div>
        </div>
      ) : (
        <button className="btn ghost sm" onClick={() => setDraft(newRule(account.id))} disabled={disabled}><Plus size={14} /> ルールを足す</button>
      )}
      {rules.length > 0 && (
        <div className="table-wrap">
          <table className="ledger">
            <thead><tr><th>含む言葉</th><th>明細</th><th>口座</th><th>相手科目</th><th>税区分</th><th>取引先</th><th>仕訳の摘要</th><th style={{ width: 110 }} /></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.keyword}</td>
                  <td>{dirLabel(r.direction)}</td>
                  <td>{r.target_account_id === null ? "どの口座にも" : accountMap.get(r.target_account_id)?.name ?? "（消した科目）"}</td>
                  <td>{accountMap.get(r.account_id) ? labelOf(r.account_id, r.sub_account_id) : "（消した科目）"}</td>
                  <td>{r.tax_code ? taxCodeDef(r.tax_code).label : "初期値"}</td>
                  <td>{counterparties.find((c) => c.id === r.counterparty_id)?.name ?? ""}</td>
                  <td>{r.memo}</td>
                  <td className="row-actions">
                    <button className="link-btn" onClick={() => setDraft(r)} disabled={disabled}>編集</button>
                    <button className="link-btn danger" onClick={() => remove(r.id)} disabled={disabled}><Trash2 size={13} /> 削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
