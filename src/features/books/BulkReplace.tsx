/**
 * 仕訳のまとめての置き換え（仕訳日記帳で選んだ仕訳。考え方は lib/bulkReplace.ts、保存は repo.replaceEntries）
 *  - 科目（と補助科目）・税区分・取引先・部門を、それぞれ置き換えるかを選ぶ
 *  - 置き換える前に、変わる仕訳の数と、外す仕訳（決算整理の画面・固定資産台帳で作ったもの）の数を出す
 *  - 1つのトランザクションなので、締めた月の仕訳が混ざっていたら1件も変えない。厳密モードは理由が要り、1件ずつ訂正の履歴に残る
 */
import { useEffect, useMemo, useState } from "react";
import { Replace } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { AccountInput, SubSelect, TaxSelect } from "../../components/Inputs";
import { groupByEntry, type FlatLine } from "../../lib/accounting";
import { replaceInEntry, replaceSpecProblem, sameSlotRow, type ReplaceSpec } from "../../lib/bulkReplace";
import type { InvoiceKind, PurchaseUse, TaxCode } from "../../lib/types";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
/** 前の補助科目・取引先の選び方：all = どれでも、none = 無いものだけ、数 = それだけ */
type Choice = "all" | "none" | number;
const pickValue = (p: Choice) => (p === "all" ? undefined : p === "none" ? null : p);
const toPick = (v: string): Choice => (v === "all" || v === "none" ? v : Number(v));

export const ReplaceDialog = ({ ids, lines, defaultAccountId, onDone, onClose }: {
  ids: number[];
  /** 表示中の年の仕訳（置き換わる数を先に数える） */
  lines: FlatLine[];
  /** 仕訳日記帳で絞り込んでいる科目（置き換える前の科目の初期値） */
  defaultAccountId: number | null;
  onDone: () => void;
  onClose: () => void;
}) => {
  const { db, strict, bump, accounts, activeSubsOf, counterparties, departments, subMap } = useAppContext();
  const toast = useToast();
  const [useAccount, setUseAccount] = useState(true);
  const [fromAcc, setFromAcc] = useState<number | null>(defaultAccountId);
  const [fromSub, setFromSub] = useState<Choice>("all");
  const [toAcc, setToAcc] = useState<number | null>(null);
  const [toSub, setToSub] = useState<number | null>(null);
  const [useTax, setUseTax] = useState(false);
  const [tax, setTax] = useState<{ code: TaxCode | null; invoice: InvoiceKind | null; cls: number | null; use: PurchaseUse | null }>({ code: null, invoice: null, cls: null, use: null });
  const [useCp, setUseCp] = useState(false);
  const [fromCp, setFromCp] = useState<Choice>("all");
  const [toCp, setToCp] = useState<number | null>(null);
  const [useDept, setUseDept] = useState(false);
  const [fromDept, setFromDept] = useState<Choice>("all");
  const [toDept, setToDept] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<Set<number>>(new Set());
  useEffect(() => {
    repo.getGeneratedEntryIds(db).then(setGenerated).catch(console.error);
  }, [db]);

  // 税区分を変える科目：科目を置き換えるなら後の科目、そうでなければ前の科目
  const taxAcc = useAccount && toAcc ? toAcc : fromAcc;
  const taxSide = accounts.find((a) => a.id === taxAcc)?.category === "revenue" ? "credit" : "debit";
  const byEntry = useMemo(() => groupByEntry(lines), [lines]);
  const lastDate = ids.map((id) => byEntry.get(id)?.[0]?.date ?? "").sort().pop() || `${new Date().getFullYear()}-12-31`;

  const spec: ReplaceSpec = {
    ...(useAccount && fromAcc && toAcc ? { account: { from: { accountId: fromAcc, subId: pickValue(fromSub) }, to: { accountId: toAcc, subId: toSub } } } : {}),
    ...(useTax && taxAcc && tax.code ? { tax: { accountId: taxAcc, ...tax, code: tax.code } } : {}),
    ...(useCp ? { counterparty: { from: pickValue(fromCp), to: toCp } } : {}),
    ...(useDept ? { department: { from: pickValue(fromDept), to: toDept } } : {}),
  };
  const incomplete = (useAccount && (!fromAcc || !toAcc)) ? "科目の置き換える前と後を選んでください"
    : useTax && (!taxAcc || !tax.code) ? "税区分を変える科目と税区分を選んでください" : null;
  const problem = incomplete ?? replaceSpecProblem(spec);

  // 置き換わる仕訳の数（作った仕訳は外す）と、借方・貸方が同じ科目になってしまう仕訳
  const preview = useMemo(() => {
    const out = { changed: 0, generated: 0, clash: [] as number[] };
    if (problem) return out;
    for (const id of ids) {
      if (generated.has(id)) {
        out.generated++;
        continue;
      }
      const ls = byEntry.get(id);
      if (!ls) continue;
      const r = replaceInEntry(ls, ls[0].counterparty_id ?? null, spec);
      if (!r.changed) continue;
      if (sameSlotRow(r.lines) != null) out.clash.push(id);
      out.changed++;
    }
    return out;
  }, [problem, ids, generated, byEntry, JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true);
    try {
      const r = await repo.replaceEntries(db, ids, spec, reason);
      bump();
      toast(`${r.changed} 件の仕訳を置き換えました${r.generated ? `（決算整理などで作った仕訳 ${r.generated} 件は変えていません）` : ""}`);
      onDone();
      onClose();
    } catch (e) {
      toast(`置き換えられませんでした（1件も変えていません）：${errText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const fromSubs = fromAcc ? [...activeSubsOf(fromAcc)] : [];
  const usedSub = typeof fromSub === "number" ? subMap.get(fromSub) : undefined;
  if (usedSub && !fromSubs.some((s) => s.id === usedSub.id)) fromSubs.unshift(usedSub);
  const cpName = (id: number) => counterparties.find((c) => c.id === id)?.name ?? "";

  return (
    <Modal title="選んだ仕訳のまとめての置き換え" onClose={onClose} width={640}>
      <div className="settings-form replace-form">
        <p className="prose">
          選んだ {ids.length.toLocaleString()} 件の仕訳を、1件ずつ訂正します。
          {strict && "訂正の事実と理由は「訂正・削除履歴」に1件ずつ残ります。"}
          締めた月の仕訳が混ざっているときは、1件も変えません。
        </p>

        <fieldset className="replace-part">
          <label className="check"><input type="checkbox" checked={useAccount} onChange={(e) => setUseAccount(e.target.checked)} /> 科目を置き換える</label>
          {useAccount && (
            <div className="replace-grid">
              <span className="replace-label">前</span>
              <AccountInput value={fromAcc} onChange={(v) => { setFromAcc(v); setFromSub("all"); }} accounts={accounts} aria-label="置き換える前の科目" />
              <select className="input" value={String(fromSub)} onChange={(e) => setFromSub(toPick(e.target.value))} aria-label="置き換える前の補助科目" disabled={!fromSubs.length}>
                <option value="all">{fromSubs.length ? "どの補助科目も" : "—"}</option>
                {fromSubs.length > 0 && <option value="none">補助なしだけ</option>}
                {fromSubs.map((s) => <option key={s.id} value={s.id}>{s.name}だけ</option>)}
              </select>
              <span className="replace-label">後</span>
              <AccountInput value={toAcc} onChange={(v) => { setToAcc(v); setToSub(null); }} aria-label="置き換えたあとの科目" />
              <SubSelect accountId={toAcc} value={toSub} onChange={setToSub} aria-label="置き換えたあとの補助科目" />
            </div>
          )}
          {useAccount && <p className="field-note">前の科目の明細だけが変わります。科目が変わる明細の税区分は、新しい科目の初期値になります（補助科目だけ変えるときは、そのまま）。</p>}
        </fieldset>

        <fieldset className="replace-part">
          <label className="check"><input type="checkbox" checked={useTax} onChange={(e) => setUseTax(e.target.checked)} /> 税区分を変える</label>
          {useTax && (
            <div className="replace-grid">
              <span className="replace-label">科目</span>
              <span className="replace-fixed">{taxAcc ? accounts.find((a) => a.id === taxAcc)?.name : "（科目を選んでください）"}</span>
              <TaxSelect
                label="変えたあとの税区分" value={tax.code} invoice={tax.invoice} businessClass={tax.cls} purchaseUse={tax.use} accountId={taxAcc} side={taxSide}
                date={lastDate} counterpartyId={null} onChange={(code, invoice, cls, use) => setTax({ code, invoice, cls, use })}
              />
            </div>
          )}
          {useTax && <p className="field-note">{useAccount ? "置き換えたあとの科目" : "上の科目"}の明細の税区分を変えます。免税事業者の年の仕訳は、税区分を持たないので変わりません。</p>}
        </fieldset>

        <fieldset className="replace-part">
          <label className="check"><input type="checkbox" checked={useCp} onChange={(e) => setUseCp(e.target.checked)} /> 取引先を置き換える</label>
          {useCp && (
            <div className="replace-grid">
              <span className="replace-label">前</span>
              <select className="input" value={String(fromCp)} onChange={(e) => setFromCp(toPick(e.target.value))} aria-label="置き換える前の取引先">
                <option value="all">どの取引先も（無いものも）</option>
                <option value="none">取引先の無い仕訳だけ</option>
                {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name}だけ</option>)}
              </select>
              <span />
              <span className="replace-label">後</span>
              <select className="input" value={toCp ?? ""} onChange={(e) => setToCp(e.target.value ? Number(e.target.value) : null)} aria-label="置き換えたあとの取引先">
                <option value="">（取引先を外す）</option>
                {counterparties.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span />
            </div>
          )}
        </fieldset>

        {(departments.length > 0 || useDept) && (
          <fieldset className="replace-part">
            <label className="check"><input type="checkbox" checked={useDept} onChange={(e) => setUseDept(e.target.checked)} /> 部門を置き換える</label>
            {useDept && (
              <div className="replace-grid">
                <span className="replace-label">前</span>
                <select className="input" value={String(fromDept)} onChange={(e) => setFromDept(toPick(e.target.value))} aria-label="置き換える前の部門">
                  <option value="all">どの部門も（共通も）</option>
                  <option value="none">共通（部門なし）だけ</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}だけ</option>)}
                </select>
                <span />
                <span className="replace-label">後</span>
                <select className="input" value={toDept ?? ""} onChange={(e) => setToDept(e.target.value ? Number(e.target.value) : null)} aria-label="置き換えたあとの部門">
                  <option value="">共通（部門を外す）</option>
                  {departments.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <span />
              </div>
            )}
            {useDept && <p className="field-note">選んだ仕訳の明細（借方・貸方とも）の部門を変えます。</p>}
          </fieldset>
        )}

        <label className="field">
          <span>置き換えの理由{strict ? "（必須）" : "（任意）"}</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：消耗品費で入れていた事務用品を事務用品費に" maxLength={200} />
        </label>

        {problem ? (
          <p className="field-note">{problem}</p>
        ) : (
          <p className={preview.clash.length ? "warn-box" : "field-note"}>
            {preview.changed.toLocaleString()} 件の仕訳が変わります
            {ids.length - preview.changed - preview.generated > 0 && `（${(ids.length - preview.changed - preview.generated).toLocaleString()} 件は置き換えるものが無いのでそのまま）`}。
            {preview.generated > 0 && `決算整理の画面・固定資産台帳で作った仕訳 ${preview.generated} 件は変えません（それぞれの画面で作り直します）。`}
            {preview.clash.length > 0 && `伝票 No.${preview.clash.slice(0, 5).join("・")}${preview.clash.length > 5 ? " など" : ""} は借方と貸方が同じ科目になるので、置き換えられません。`}
            {useCp && toCp && `取引先「${cpName(toCp)}」にします。`}
          </p>
        )}

        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button
            type="button" className="btn primary" onClick={submit}
            disabled={busy || !!problem || preview.changed === 0 || preview.clash.length > 0 || (strict && !reason.trim())}
          >
            <Replace size={16} /> {preview.changed.toLocaleString()} 件を置き換える
          </button>
        </div>
      </div>
    </Modal>
  );
};
