/**
 * 見積書・請求書（計算は lib/salesDoc.ts、保存は repo の sales_docs・sales_payments）
 *  - 表示中の年に発行した書類の一覧（請求書・見積書の切り替え、状態と言葉で絞り込み。未入金はすべての年から）。
 *    日付（から・まで）と請求額の範囲でも探せ（日付を入れると年をまたぐ）、表示中の一覧を CSV に書き出せる（控えをデータで持つときの検索・ダウンロードの求め）
 *  - 作る・直す：宛名（取引先から）・件名・日付・明細（品名・数量・単位・単価・税率）・単価の税抜／税込・源泉徴収・振込先・備考。
 *    見積書から請求書へ写せる。下書きは削除でき、発行した書類は取り消す（理由は履歴に）
 *  - 発行：請求書は売掛金の仕訳を作り、発行したときの発行者（名前・住所・電話・登録番号）を書類に残す。発行した請求書は直せない
 *    （相手に渡した請求書の写し。消費税法57条の4⑥）。直すときは取り消して、新しい番号で作り直す。入金は「入金」から記録するか、帳簿の仕訳（明細の取り込みなど）を選ぶ
 *  - 印刷：A4 の請求書・見積書（適格請求書の記載事項。免税の年は登録番号・消費税額を出さない。発行した書類は発行したときの発行者で）。PDF は印刷の画面から保存する
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Copy, FileDown, FilePenLine, HandCoins, Pencil, Plus, Printer, RefreshCw, Search, Send, Settings2, Trash2, X } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { Modal } from "../../components/Modal";
import { AmountInput, CounterpartyField, FullDateInput } from "../../components/Inputs";
import { useToast } from "../../components/Toast";
import { longDate, todayIso, yen } from "../../lib/format";
import { exportCsvFile } from "../../components/csvExport";
import { inReduced1, taxYearOf } from "../../lib/tax";
import { CODE } from "../../constants/accounts";
import {
  DOC_KIND_LABEL, DOC_STATE_LABEL, docState, docTotals, isReducedItem, issuerOf, ITEM_TAX_LABEL, ITEM_TAXES, itemTaxOn, nextDocNo, reducedItemNote, remainingOf, ROUNDING_LABEL,
  SALES_DOC_CSV_HEADER, salesDate, salesDocCsvRow, savedTotals,
  type DocItem, type DocKind, type DocState, type DocTotals, type ItemTax, type Rounding, type SalesDoc, type SalesPayment,
} from "../../lib/salesDoc";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const slash = (iso: string | null) => (iso ? iso.replace(/-/g, "/") : "");
const emptyItem = (): DocItem => ({ name: "", qty: 1, unit: "", price: 0, tax: "10" });

type Payment = SalesPayment & { created: number };
type Filter = "all" | "open" | "draft" | "paid" | "void";
const FILTER_LABEL: Record<Filter, string> = { all: "すべて", open: "未入金（すべての年）", draft: "下書き", paid: "入金済み", void: "取消" };

export const SalesDocsPage = () => {
  const { db, year, dataVersion, bump, can, taxYears } = useAppContext();
  const toast = useToast();
  const [kind, setKind] = useState<DocKind>("invoice");
  const [docs, setDocs] = useState<SalesDoc[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [conf, setConf] = useState<repo.InvoiceSettings>({ invoice_bank: "", invoice_rounding: "floor", invoice_notes: "" });
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  // 日付（請求日・見積日）と請求額の範囲。日付を入れると、表示中の年に限らず探す
  const [range, setRange] = useState({ from: "", to: "", min: "", max: "" });
  const [editing, setEditing] = useState<{ doc: SalesDoc | null; draft: repo.SalesDocInput } | null>(null);
  const [printing, setPrinting] = useState<SalesDoc | null>(null);
  const [paying, setPaying] = useState<SalesDoc | null>(null);
  const [voiding, setVoiding] = useState<SalesDoc | null>(null);
  const [setting, setSetting] = useState(false);
  const mayEdit = can("entry");

  useEffect(() => {
    let alive = true;
    Promise.all([repo.getSalesDocs(db), repo.getSalesPayments(db), repo.getInvoiceSettings(db)])
      .then(([d, p, c]) => {
        if (!alive) return;
        setDocs(d);
        setPayments(p);
        setConf(c);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, dataVersion]);

  /** 作っている書類の金額（今の設定の丸め方と、売上の日の年の課税区分で。保存するとこの形で残る） */
  const totalsOf = (d: Pick<SalesDoc, "items" | "price_mode" | "withholding" | "issue_date" | "delivery_date">) =>
    docTotals(d, conf.invoice_rounding, taxYearOf(taxYears, Number(salesDate(d).slice(0, 4))).status === "exempt");
  const rows = useMemo(() => docs.filter((d) => d.kind === kind).map((d) => {
    const t = savedTotals(d);
    const paid = payments.filter((p) => p.doc_id === d.id);
    const remaining = remainingOf(t.billed, paid);
    const converted = d.kind === "estimate" && docs.some((x) => x.source_id === d.id && x.status !== "void");
    return { d, t, paid, remaining, state: docState(d, remaining, t.billed, converted) };
  }), [docs, payments, kind]);
  const open = (s: DocState) => s === "issued" || s === "partial";
  const needle = q.trim().toLowerCase();
  const byDate = !!(range.from || range.to);
  const [min, max] = [range.min === "" ? null : Number(range.min), range.max === "" ? null : Number(range.max)];
  const shown = rows.filter(({ d, t, state }) =>
    (filter === "open" ? kind === "invoice" && open(state) : byDate || d.issue_date.startsWith(String(year)))
    && (!range.from || d.issue_date >= range.from) && (!range.to || d.issue_date <= range.to)
    && (min === null || t.billed >= min) && (max === null || t.billed <= max)
    && (filter === "all" || filter === "open" || (filter === "draft" ? state === "draft" : filter === "paid" ? state === "paid" : state === "void"))
    && (!needle || [d.doc_no, d.to_name, d.subject].some((x) => x.toLowerCase().includes(needle))));
  const exportCsv = () => exportCsvFile(
    `${DOC_KIND_LABEL[kind]}_${byDate ? `${range.from || "初め"}〜${range.to || "今"}` : `${year}年`}.csv`, SALES_DOC_CSV_HEADER,
    shown.map(({ d, state }) => salesDocCsvRow(d, DOC_STATE_LABEL[state])), toast,
  );
  const receivable = rows.filter((r) => kind === "invoice" && open(r.state)).reduce((s, r) => s + r.remaining, 0);
  const overdue = rows.filter((r) => kind === "invoice" && open(r.state) && r.d.due_date && r.d.due_date < todayIso()).length;

  const blank = (k: DocKind): repo.SalesDocInput => ({
    kind: k, doc_no: nextDocNo(docs.filter((d) => d.kind === k).map((d) => d.doc_no), year), issue_date: todayIso().startsWith(String(year)) ? todayIso() : `${year}-12-31`,
    delivery_date: null, due_date: null, counterparty_id: null, to_name: "", honorific: "御中", to_address: "", subject: "", items: [emptyItem()], price_mode: "exclusive",
    withholding: 0, notes: conf.invoice_notes, bank_text: k === "invoice" ? conf.invoice_bank : "", source_id: null, revenue_account_id: null,
  });
  const inputOf = (d: SalesDoc): repo.SalesDocInput => {
    const { id: _id, status: _s, entry_id: _e, rounding: _r, exempt: _x, issuer: _i, ...rest } = d;
    return rest;
  };
  /** 軽減税率の明細を、新しい書類の取引日の税率（8%・1%）に合わせる */
  const itemsOn = (x: repo.SalesDocInput): repo.SalesDocInput => ({ ...x, items: x.items.map((it) => ({ ...it, tax: itemTaxOn(it.tax, salesDate(x)) })) });
  /** 見積書から請求書を作る（下書き）。同じ書類を複製する */
  const toInvoice = (d: SalesDoc) => setEditing({ doc: null, draft: itemsOn({ ...inputOf(d), kind: "invoice", doc_no: blank("invoice").doc_no, issue_date: blank("invoice").issue_date, due_date: null, bank_text: conf.invoice_bank, source_id: d.id }) });
  const duplicate = (d: SalesDoc) => setEditing({ doc: null, draft: itemsOn({ ...inputOf(d), doc_no: blank(d.kind).doc_no, issue_date: blank(d.kind).issue_date, delivery_date: null, due_date: null, source_id: null }) });
  /** 取り消した書類を、同じ中身（取引日・期限も）で新しい番号の下書きにする（修正した請求書） */
  const remake = (d: SalesDoc) => setEditing({ doc: null, draft: itemsOn({ ...inputOf(d), doc_no: blank(d.kind).doc_no, issue_date: blank(d.kind).issue_date, source_id: null }) });

  const run = async (f: () => Promise<unknown>, done: string) => {
    try {
      await f();
      bump();
      toast(done);
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  const issue = (d: SalesDoc) => run(() => repo.issueSalesDoc(db, d.id), d.kind === "invoice" ? `${d.doc_no} を発行し、売掛金の仕訳を作りました` : `${d.doc_no} を発行しました`);
  const remove = (d: SalesDoc) => run(() => repo.deleteSalesDoc(db, d.id), `${d.doc_no} を削除しました`);
  const repost = (d: SalesDoc) => run(() => repo.repostSalesDoc(db, d.id), `${d.doc_no} の売掛金の仕訳を作り直しました`);

  return (
    <div className="page">
      <PageHeader
        title="請求書・見積書"
        note="請求書を発行すると「売掛金 ／ 売上高」の仕訳を作り、入金を記録すると「普通預金 ／ 売掛金」を作ります。発行した請求書は、相手に渡した請求書の写しとして直せず、発行したときの中身と発行者（名前・住所・登録番号）で、いつでも同じ形で印刷できます。直すときは取り消して、新しい番号で作り直します。"
      >
        <button className="btn ghost" onClick={() => setSetting(true)} disabled={!can("settings")}><Settings2 size={16} /> 設定</button>
        <button className="btn primary" onClick={() => setEditing({ doc: null, draft: blank(kind) })} disabled={!mayEdit}><Plus size={16} /> {DOC_KIND_LABEL[kind]}を作る</button>
      </PageHeader>

      <div className="filters">
        <div className="seg" role="tablist">
          {(["invoice", "estimate"] as DocKind[]).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setFilter("all"); }}>{DOC_KIND_LABEL[k]}</button>
          ))}
        </div>
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="状態で絞り込む" style={{ width: "auto" }}>
          {(Object.keys(FILTER_LABEL) as Filter[]).filter((f) => kind === "invoice" || (f !== "open" && f !== "paid")).map((f) => <option key={f} value={f}>{FILTER_LABEL[f]}</option>)}
        </select>
        <label className="search">
          <Search size={15} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="番号・宛名・件名で探す" />
        </label>
        <span className="sales-range" title="日付（請求日・見積日）を入れると、表示中の年に限らず探します">
          <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="日付から" />
          〜
          <input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="日付まで" />
        </span>
        <span className="sales-range">
          <input className="input num" inputMode="numeric" value={range.min} onChange={(e) => setRange({ ...range, min: e.target.value.replace(/[^\d]/g, "") })} placeholder="請求額から" aria-label="請求額から" />
          〜
          <input className="input num" inputMode="numeric" value={range.max} onChange={(e) => setRange({ ...range, max: e.target.value.replace(/[^\d]/g, "") })} placeholder="まで" aria-label="請求額まで" />
        </span>
        {(byDate || range.min || range.max) && <button className="link-btn" onClick={() => setRange({ from: "", to: "", min: "", max: "" })}>条件を消す</button>}
        <button className="btn ghost" onClick={exportCsv} disabled={shown.length === 0} title="表示中の一覧を CSV に書き出します"><FileDown size={15} /> CSV</button>
        <span className="spacer" />
        {kind === "invoice" && (
          <span className="muted">未入金 <b>{yen(receivable)}円</b>{overdue ? <>・<span className="warn-text">支払期限を過ぎたもの {overdue} 件</span></> : null}</span>
        )}
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {shown.length === 0 ? (
            <p className="empty-note">
              {filter === "open" ? "未入金の請求書はありません。" : byDate || range.min || range.max ? "条件に合う書類はありません。" : `${year}年の${DOC_KIND_LABEL[kind]}はありません。「${DOC_KIND_LABEL[kind]}を作る」から作れます。`}
            </p>
          ) : (
            <table className="ledger sales-table">
              <colgroup>
                <col style={{ width: 84 }} /><col style={{ width: 86 }} /><col /><col style={{ width: 96 }} />
                {kind === "invoice" && <col style={{ width: 88 }} />}<col style={{ width: 84 }} /><col style={{ width: 80 }} /><col style={{ width: 184 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>番号</th><th>{kind === "invoice" ? "請求日" : "見積日"}</th><th>宛名・件名</th>
                  <th className="num">{kind === "invoice" ? "請求額" : "見積額"}</th>{kind === "invoice" && <th className="num">残り</th>}
                  <th>{kind === "invoice" ? "支払期限" : "有効期限"}</th><th>状態</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map(({ d, t, remaining, state }) => (
                  <tr key={d.id} className={state === "void" ? "inactive" : ""}>
                    <td className="mono">{d.doc_no}</td>
                    <td>{slash(d.issue_date)}</td>
                    <td className="sales-to" title={`${d.to_name} ${d.honorific}${d.subject ? `\n${d.subject}` : ""}`}>
                      <span>{d.to_name} {d.honorific}</span>
                      {d.subject && <span className="hint">{d.subject}</span>}
                    </td>
                    <td className="num">{yen(t.billed)}</td>
                    {kind === "invoice" && <td className="num">{open(state) ? yen(remaining) : ""}</td>}
                    <td className={open(state) && d.due_date && d.due_date < todayIso() ? "warn-text" : ""}>{slash(d.due_date)}</td>
                    <td>
                      <span className={`badge sales-state ${state}`}>{DOC_STATE_LABEL[state]}</span>
                      {d.kind === "invoice" && d.status === "issued" && !d.entry_id && <span className="badge sales-state void" title="売掛金の仕訳が削除されています。「仕訳を作り直す」で作り直せます">仕訳なし</span>}
                    </td>
                    <td className="row-actions sales-actions">
                      {d.status === "draft" && <button className="link-btn" onClick={() => issue(d)} disabled={!mayEdit}><Send size={14} /> 発行</button>}
                      {d.kind === "invoice" && d.status === "issued" && <button className="link-btn" onClick={() => setPaying(d)} disabled={!mayEdit}><HandCoins size={14} /> 入金</button>}
                      {d.kind === "estimate" && d.status === "issued" && state !== "converted" && <button className="link-btn" onClick={() => toInvoice(d)} disabled={!mayEdit}><FilePenLine size={14} /> 請求書へ</button>}
                      <button className="link-btn" onClick={() => setPrinting(d)} title="印刷" aria-label="印刷"><Printer size={14} /></button>
                      {d.kind === "invoice" && d.status === "issued" && !d.entry_id && (
                        <button className="link-btn" onClick={() => repost(d)} disabled={!mayEdit} title="売掛金の仕訳を作り直す" aria-label="仕訳を作り直す"><RefreshCw size={14} /></button>
                      )}
                      {(d.status === "draft" || (d.kind === "estimate" && d.status !== "void")) && (
                        <button className="link-btn" onClick={() => setEditing({ doc: d, draft: inputOf(d) })} disabled={!mayEdit} title="編集" aria-label="編集"><Pencil size={14} /></button>
                      )}
                      <button className="link-btn" onClick={() => duplicate(d)} disabled={!mayEdit} title="この書類を写して新しく作る" aria-label="複製"><Copy size={14} /></button>
                      {d.status === "draft" && <button className="link-btn danger" onClick={() => remove(d)} disabled={!mayEdit} title="削除" aria-label="削除"><Trash2 size={14} /></button>}
                      {d.status === "issued" && (
                        <button className="link-btn danger" onClick={() => setVoiding(d)} disabled={!mayEdit} title={d.kind === "invoice" ? "取消（直すときは、取り消して作り直す）" : "取消"} aria-label="取消">
                          <Ban size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editing && (
        <DocEditor
          doc={editing.doc} initial={editing.draft} rounding={conf.invoice_rounding} totalsOf={totalsOf}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); bump(); }}
        />
      )}
      {printing && <DocPrint doc={printing} totals={savedTotals(printing)} onClose={() => setPrinting(null)} />}
      {paying && (
        <PaymentModal
          doc={paying} totals={savedTotals(paying)} payments={payments.filter((p) => p.doc_id === paying.id)}
          onClose={() => setPaying(null)} onChanged={bump}
        />
      )}
      {voiding && (
        <VoidModal
          doc={voiding} onClose={() => setVoiding(null)}
          onDone={(again) => { const d = voiding; setVoiding(null); bump(); if (again) remake(d); }}
        />
      )}
      {setting && <InvoiceSettingsModal conf={conf} onClose={() => setSetting(false)} onSaved={() => { setSetting(false); bump(); }} />}
    </div>
  );
};

// ────────────────────────────────────────────
// 作る・直す
// ────────────────────────────────────────────
const DocEditor = ({ doc, initial, rounding, totalsOf, onClose, onSaved }: {
  doc: SalesDoc | null; initial: repo.SalesDocInput; rounding: Rounding; totalsOf: (d: repo.SalesDocInput) => DocTotals; onClose: () => void; onSaved: () => void;
}) => {
  const { db, year, accounts, counterparties } = useAppContext();
  const toast = useToast();
  const [x, setX] = useState<repo.SalesDocInput>(initial);
  const [error, setError] = useState("");
  const [badDates, setBadDates] = useState<Set<string>>(new Set());
  const set = <K extends keyof repo.SalesDocInput>(k: K, v: repo.SalesDocInput[K]) => setX((d) => ({ ...d, [k]: v }));
  const setItem = (i: number, p: Partial<DocItem>) => setX((d) => ({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...p } : it)) }));
  const markDate = (key: string) => (ok: boolean) => setBadDates((s) => {
    const n = new Set(s);
    if (ok) n.delete(key);
    else n.add(key);
    return n;
  });
  const invoice = x.kind === "invoice";
  const t = totalsOf(x);
  // 飲食料品の税率の引下げ：取引日が 1% の期間か、軽減税率の明細と取引日が合っているか
  const reduced1 = inReduced1(salesDate(x));
  const reducedNote = reducedItemNote(x);
  const issued = doc?.status === "issued";
  const revenues = accounts.filter((a) => a.category === "revenue" && a.is_active);

  const pickCounterparty = (id: number | null) => {
    const c = counterparties.find((v) => v.id === id);
    setX((d) => ({ ...d, counterparty_id: id, to_name: c && (!d.to_name || counterparties.some((v) => v.name === d.to_name)) ? c.name : d.to_name }));
  };
  const save = async (andIssue: boolean) => {
    setError("");
    if (badDates.size) return setError("日付が正しくありません（2026/5/31 のように入れてください）");
    try {
      const id = await repo.saveSalesDoc(db, doc?.id ?? null, x);
      if (andIssue) await repo.issueSalesDoc(db, id);
      toast(andIssue ? (invoice ? "発行し、売掛金の仕訳を作りました" : "発行しました") : issued && invoice ? "保存し、仕訳も直しました" : "保存しました");
      onSaved();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Modal title={`${DOC_KIND_LABEL[x.kind]}の${doc ? "編集" : "作成"}`} onClose={onClose} width={1000}>
      <form className="settings-form sales-form" onSubmit={(e) => { e.preventDefault(); save(false); }}>
        {issued && <p className="notice">発行済みの{DOC_KIND_LABEL[x.kind]}です。直すと{invoice ? "売掛金の仕訳も訂正し、" : ""}変更は履歴に残ります（厳密モード）。</p>}
        <div className="field-row wrap">
          <label className="field" style={{ maxWidth: 150 }}>
            <span>番号</span>
            <input className="input mono" value={x.doc_no} onChange={(e) => set("doc_no", e.target.value)} maxLength={30} />
          </label>
          <label className="field" style={{ maxWidth: 170 }}>
            <span>{invoice ? "請求日" : "見積日"}</span>
            <FullDateInput value={x.issue_date} onChange={(v) => set("issue_date", v)} year={year} aria-label={invoice ? "請求日" : "見積日"} onValidity={markDate("issue")} />
          </label>
          {invoice && (
            <label className="field" style={{ maxWidth: 210 }}>
              <span>取引日（納品日など。空なら請求日）</span>
              <FullDateInput value={x.delivery_date ?? ""} onChange={(v) => set("delivery_date", v || null)} year={year} aria-label="取引日" onValidity={markDate("delivery")} />
            </label>
          )}
          <label className="field" style={{ maxWidth: 170 }}>
            <span>{invoice ? "支払期限" : "有効期限"}（任意）</span>
            <FullDateInput value={x.due_date ?? ""} onChange={(v) => set("due_date", v || null)} year={year} aria-label={invoice ? "支払期限" : "有効期限"} onValidity={markDate("due")} />
          </label>
        </div>
        <div className="field-row wrap">
          <label className="field" style={{ maxWidth: 260 }}>
            <span>取引先（任意。仕訳に付けます）</span>
            <CounterpartyField value={x.counterparty_id} onChange={pickCounterparty} aria-label="取引先" />
          </label>
          <label className="field">
            <span>宛名</span>
            <input className="input" value={x.to_name} onChange={(e) => set("to_name", e.target.value)} maxLength={80} placeholder="例：株式会社エー" />
          </label>
          <label className="field" style={{ maxWidth: 110 }}>
            <span>敬称</span>
            <select className="input" value={x.honorific} onChange={(e) => set("honorific", e.target.value)}>
              {["御中", "様", ""].map((h) => <option key={h} value={h}>{h || "（なし）"}</option>)}
            </select>
          </label>
        </div>
        <div className="field-row wrap">
          <label className="field">
            <span>宛先の住所（任意）</span>
            <input className="input" value={x.to_address} onChange={(e) => set("to_address", e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            <span>件名（任意）</span>
            <input className="input" value={x.subject} onChange={(e) => set("subject", e.target.value)} maxLength={80} placeholder="例：ロゴ制作" />
          </label>
        </div>
        <div className="field-row wrap sales-options">
          <div className="seg" role="radiogroup" aria-label="単価">
            {(["exclusive", "inclusive"] as const).map((m) => (
              <button type="button" key={m} role="radio" aria-checked={x.price_mode === m} className={x.price_mode === m ? "on" : ""} onClick={() => set("price_mode", m)}>
                単価は{m === "exclusive" ? "税抜" : "税込"}
              </button>
            ))}
          </div>
          {invoice && (
            <label className="check">
              <input type="checkbox" checked={!!x.withholding} onChange={(e) => set("withholding", e.target.checked ? 1 : 0)} /> 源泉徴収あり（原稿料・デザイン料などの報酬）
            </label>
          )}
          {invoice && (
            <label className="field" style={{ maxWidth: 200 }}>
              <span>売上の科目</span>
              <select className="input" value={x.revenue_account_id ?? ""} onChange={(e) => set("revenue_account_id", Number(e.target.value) || null)}>
                <option value="">売上高</option>
                {revenues.filter((a) => a.code !== "401").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <table className="ledger sales-items">
          <colgroup><col /><col style={{ width: 84 }} /><col style={{ width: 70 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 110 }} /><col style={{ width: 36 }} /></colgroup>
          <thead><tr><th>品名</th><th className="num">数量</th><th>単位</th><th className="num">単価（{x.price_mode === "exclusive" ? "税抜" : "税込"}）</th><th>税</th><th className="num">金額</th><th /></tr></thead>
          <tbody>
            {x.items.map((it, i) => (
              <tr key={i}>
                <td><input className="input" value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} maxLength={80} aria-label={`${i + 1}行目の品名`} /></td>
                <td>
                  <input className="input num" inputMode="decimal" value={String(it.qty)} aria-label={`${i + 1}行目の数量`}
                    onChange={(e) => setItem(i, { qty: Number(e.target.value.normalize("NFKC").replace(/[^\d.]/g, "")) || 0 })} />
                </td>
                <td><input className="input" value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} maxLength={8} aria-label={`${i + 1}行目の単位`} /></td>
                <td><AmountInput value={it.price} onChange={(v) => setItem(i, { price: v ?? 0 })} aria-label={`${i + 1}行目の単価`} /></td>
                <td>
                  <select className="input" value={it.tax} onChange={(e) => setItem(i, { tax: e.target.value as ItemTax })} aria-label={`${i + 1}行目の税`}>
                    {/* 1%（軽減）は取引日が令和9年4月1日〜令和11年3月31日のときだけ（入っていればそれは出す） */}
                    {ITEM_TAXES.filter((k) => k !== "1" || reduced1 || it.tax === "1").map((k) => <option key={k} value={k}>{ITEM_TAX_LABEL[k]}</option>)}
                  </select>
                </td>
                <td className="num">{yen(t.amounts[i] ?? 0)}</td>
                <td>
                  <button type="button" className="btn ghost sm icon" onClick={() => set("items", x.items.filter((_, j) => j !== i))} disabled={x.items.length <= 1} aria-label="行を消す"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sales-under">
          <button type="button" className="btn ghost sm" onClick={() => set("items", [...x.items, emptyItem()])} disabled={x.items.length >= 60}><Plus size={14} /> 行を足す</button>
          <TotalsTable t={t} />
        </div>
        {t.exempt && <p className="field-note">この年は免税事業者なので、消費税額と登録番号は出しません（金額をそのまま合計します）。</p>}
        {!t.exempt && reducedNote && <p className="warn-box">{reducedNote}。</p>}
        <p className="field-note">消費税は税率ごとに合計してから1回だけ端数を処理します（{ROUNDING_LABEL[rounding]}。設定で変えられます）。</p>

        {invoice && (
          <label className="field">
            <span>振込先</span>
            <textarea className="input" rows={2} value={x.bank_text} onChange={(e) => set("bank_text", e.target.value)} maxLength={200} />
          </label>
        )}
        <label className="field">
          <span>備考（任意）</span>
          <textarea className="input" rows={2} value={x.notes} onChange={(e) => set("notes", e.target.value)} maxLength={400} />
        </label>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className={`btn ${doc?.status === "issued" ? "primary" : "ghost"}`} type="submit">{issued && invoice ? "保存する（仕訳も直す）" : doc?.status === "issued" ? "保存する" : "下書きで保存"}</button>
          {doc?.status !== "issued" && (
            <button type="button" className="btn primary" onClick={() => save(true)}><Send size={15} /> 保存して発行{invoice ? "（仕訳を作る）" : ""}</button>
          )}
        </div>
      </form>
    </Modal>
  );
};

/** 合計の表（税率ごとの対価の額と消費税額、合計、源泉徴収、差引） */
const TotalsTable = ({ t, print = false }: { t: DocTotals; print?: boolean }) => (
  <table className={print ? "doc-totals" : "ledger sales-totals"}>
    <tbody>
      {!t.exempt && t.groups.map((g) => (
        <tr key={g.tax}>
          <td>{g.rate ? `${g.rate}%対象${isReducedItem(g.tax) ? "（軽減税率）" : ""}` : ITEM_TAX_LABEL[g.tax]}</td>
          <td className="num">{yen(g.base)}円</td>
          <td className="num">{g.rate ? `消費税 ${yen(g.tax_amount)}円` : ""}</td>
        </tr>
      ))}
      <tr className="sales-total"><td>合計{t.exempt ? "" : "（税込）"}</td><td className="num" colSpan={2}>{yen(t.total)}円</td></tr>
      {t.withholding > 0 && (
        <>
          <tr><td>源泉徴収税額</td><td className="num" colSpan={2}>−{yen(t.withholding)}円</td></tr>
          <tr className="sales-total"><td>差引請求額</td><td className="num" colSpan={2}>{yen(t.billed)}円</td></tr>
        </>
      )}
    </tbody>
  </table>
);

// ────────────────────────────────────────────
// 印刷（A4。帳簿の印刷プレビューと同じ枠）
// ────────────────────────────────────────────
const FIRST_ROWS = 16;
const NEXT_ROWS = 30;
const DocPrint = ({ doc: d, totals: t, onClose }: { doc: SalesDoc; totals: DocTotals; onClose: () => void }) => {
  const { settings } = useAppContext();
  useEffect(() => {
    document.body.classList.add("pp-printing");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("pp-printing");
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const invoice = d.kind === "invoice";
  const date = salesDate(d);
  // 発行者：発行した書類は発行したときのもの（あとで事業者設定を変えても同じ形）。下書きと、形式の版 16 までに発行した書類は今の事業者設定で
  const from = d.issuer ?? issuerOf(settings, d, t.exempt);
  const regNo = from.invoice_no;
  const pages: { from: number; to: number }[] = [];
  for (let i = 0; i === 0 || i < d.items.length; i += pages.length ? NEXT_ROWS : FIRST_ROWS) pages.push({ from: i, to: Math.min(d.items.length, i + (pages.length ? NEXT_ROWS : FIRST_ROWS)) });
  const reduced = d.items.some((it) => isReducedItem(it.tax)) && !t.exempt;
  const title = invoice ? "請求書" : "見積書";

  return createPortal(
    <div className="pp-overlay" role="dialog" aria-modal="true" aria-label={`印刷プレビュー：${title} ${d.doc_no}`}>
      <div className="pp-toolbar">
        <h2>{title} {d.doc_no}</h2>
        <div className="spacer" />
        <span className="pp-count">
          {pages.length} ページ（A4 縦）。PDF は印刷の画面から保存できます。メールで送った PDF は、証憑に取り込んで保存してください（電子取引）
          {d.status !== "draft" && !d.issuer && "。以前の版で発行した書類なので、発行者は今の事業者設定で出しています"}
        </span>
        <button className="btn ghost pp-close" onClick={onClose}><X size={16} /> 閉じる</button>
        <button className="btn primary" onClick={() => window.print()}><Printer size={16} /> 印刷</button>
      </div>
      <div className="pp-pages">
        {pages.map((p, n) => (
          <div className="pp-page doc-page" key={n}>
            {n === 0 && (
              <>
                <h1 className="doc-title">{title}</h1>
                <div className="doc-meta">
                  <div>No. {d.doc_no}</div>
                  <div>{invoice ? "請求日" : "見積日"} {longDate(d.issue_date)}</div>
                </div>
                <div className="doc-head">
                  <div className="doc-to">
                    <div className="doc-to-name">{d.to_name} {d.honorific}</div>
                    {d.to_address && <div className="doc-small">{d.to_address}</div>}
                    {d.subject && <div className="doc-subject">件名：{d.subject}</div>}
                    <p className="doc-lead">{invoice ? "下記のとおりご請求申し上げます。" : "下記のとおりお見積り申し上げます。"}</p>
                    <div className="doc-amount">
                      <span>{invoice ? "ご請求金額" : "お見積金額"}</span>
                      <b>{yen(t.billed)}円</b>
                      {!t.exempt && <span className="doc-small">（税込）</span>}
                    </div>
                    {d.due_date && <div className="doc-small">{invoice ? "お支払期限" : "有効期限"}：{longDate(d.due_date)}</div>}
                    {invoice && <div className="doc-small">取引年月日：{longDate(date)}</div>}
                  </div>
                  <div className="doc-from">
                    <div className="doc-from-name">{from.name}</div>
                    {from.owner && <div>{from.owner}</div>}
                    {from.address && <div className="doc-small">{from.postal ? `〒${from.postal} ` : ""}{from.address}</div>}
                    {from.phone && <div className="doc-small">TEL {from.phone}</div>}
                    {regNo && <div className="doc-small">登録番号 {regNo}</div>}
                  </div>
                </div>
              </>
            )}
            <table className="doc-items">
              <colgroup><col /><col style={{ width: "12%" }} /><col style={{ width: "8%" }} /><col style={{ width: "15%" }} /><col style={{ width: "17%" }} /></colgroup>
              <thead><tr><th>品名</th><th className="num">数量</th><th>単位</th><th className="num">単価{t.exempt ? "" : d.price_mode === "exclusive" ? "（税抜）" : "（税込）"}</th><th className="num">金額</th></tr></thead>
              <tbody>
                {d.items.slice(p.from, p.to).map((it, i) => (
                  <tr key={p.from + i}>
                    <td>{it.name}{!t.exempt && isReducedItem(it.tax) ? " ※" : ""}{!t.exempt && (it.tax === "nontax" || it.tax === "export" || it.tax === "none") ? `（${ITEM_TAX_LABEL[it.tax]}）` : ""}</td>
                    <td className="num">{it.qty.toLocaleString()}</td>
                    <td>{it.unit}</td>
                    <td className="num">{yen(it.price)}</td>
                    <td className="num">{yen(t.amounts[p.from + i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {n === pages.length - 1 ? (
              <div className="doc-foot">
                <div className="doc-notes">
                  {reduced && <div className="doc-small">※ は軽減税率の対象です。</div>}
                  {invoice && d.bank_text && <div className="doc-box"><b>お振込先</b><div>{d.bank_text}</div></div>}
                  {d.notes && <div className="doc-box"><b>備考</b><div>{d.notes}</div></div>}
                </div>
                <TotalsTable t={t} print />
              </div>
            ) : (
              <p className="doc-small doc-cont">次のページに続きます</p>
            )}
            <div className="doc-page-no">{n + 1} / {pages.length}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
};

// ────────────────────────────────────────────
// 入金
// ────────────────────────────────────────────
const PaymentModal = ({ doc: d, totals: t, payments, onClose, onChanged }: {
  doc: SalesDoc; totals: DocTotals; payments: Payment[]; onClose: () => void; onChanged: () => void;
}) => {
  const { db, year, accounts } = useAppContext();
  const toast = useToast();
  const remaining = remainingOf(t.billed, payments);
  const banks = accounts.filter((a) => a.category === "asset" && a.is_active && Number(a.code) >= 101 && Number(a.code) <= 109);
  const feeAccounts = accounts.filter((a) => (a.category === "expense" || a.category === "revenue") && a.is_active);
  // 入金日の初めは、今日か売上の日の遅いほう
  const [paidOn, setPaidOn] = useState(todayIso() >= salesDate(d) ? todayIso() : salesDate(d));
  const [bankId, setBankId] = useState(banks.find((a) => a.code === CODE.BANK)?.id ?? banks[0]?.id ?? 0);
  const [amount, setAmount] = useState<number | null>(remaining > 0 ? remaining : null);
  const [fee, setFee] = useState<number | null>(0);
  const [feeId, setFeeId] = useState(accounts.find((a) => a.code === CODE.FEES)?.id ?? 0);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<{ entry_id: number; date: string; description: string; amount: number }[]>([]);
  useEffect(() => {
    repo.receivableCredits(db, d.id).then(setCandidates).catch(console.error);
  }, [db, d.id, payments.length]);
  const act = async (f: () => Promise<unknown>, done: string) => {
    setError("");
    try {
      await f();
      toast(done);
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };
  const record = () => act(
    () => repo.addSalesPayment(db, d.id, { paid_on: paidOn, amount: amount ?? 0, fee: fee ?? 0, bankAccountId: bankId, feeAccountId: feeId }),
    "入金を記録し、仕訳を作りました",
  );

  return (
    <Modal title={`入金（${DOC_KIND_LABEL[d.kind]} ${d.doc_no}）`} onClose={onClose} width={640}>
      <div className="settings-form">
        <p>請求額 <b>{yen(t.billed)}円</b>・入金済み {yen(t.billed - remaining)}円・残り <b>{yen(remaining)}円</b></p>
        {payments.length > 0 && (
          <table className="ledger">
            <thead><tr><th>入金日</th><th className="num">売掛金から消した額</th><th>仕訳</th><th /></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{slash(p.paid_on)}</td>
                  <td className="num">{yen(p.amount)}</td>
                  <td className="muted">{p.entry_id ? `No.${p.entry_id}${p.created ? "（ここで作成）" : ""}` : ""}</td>
                  <td className="row-actions">
                    <button className="link-btn danger" onClick={() => act(() => repo.removeSalesPayment(db, p.id), p.created ? "入金を取り消し、仕訳を削除しました" : "入金のつなぎを外しました")}>
                      <Trash2 size={14} /> 取消
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {remaining > 0 && (
          <>
            <h4 className="filing-h">入金を記録する（仕訳を作る）</h4>
            <div className="field-row wrap">
              <label className="field" style={{ maxWidth: 170 }}>
                <span>入金日</span>
                <FullDateInput value={paidOn} onChange={setPaidOn} year={year} aria-label="入金日" />
              </label>
              <label className="field" style={{ maxWidth: 180 }}>
                <span>入金した口座</span>
                <select className="input" value={bankId} onChange={(e) => setBankId(Number(e.target.value))}>
                  {banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label className="field" style={{ maxWidth: 150 }}>
                <span>受け取った額</span>
                <AmountInput value={amount} onChange={(v) => { setAmount(v); setFee(v !== null && remaining - v > 0 && remaining - v <= 1000 ? remaining - v : 0); }} aria-label="受け取った額" />
              </label>
              <label className="field" style={{ maxWidth: 130 }}>
                <span>振込手数料</span>
                <AmountInput value={fee} onChange={setFee} aria-label="振込手数料" />
              </label>
              <label className="field" style={{ maxWidth: 160 }}>
                <span>手数料の科目</span>
                <select className="input" value={feeId} onChange={(e) => setFeeId(Number(e.target.value))}>
                  {feeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
            <p className="field-note">相手が振込手数料を差し引いて振り込んだときは、その額を振込手数料に入れます（「{accounts.find((a) => a.id === bankId)?.name ?? "預金"} ＋ 手数料 ／ 売掛金」）。</p>
            <div className="voucher-actions">
              <div className="spacer" />
              <button className="btn primary" onClick={record} disabled={!amount || !bankId}><HandCoins size={15} /> 入金を記録する</button>
            </div>
            {candidates.length > 0 && (
              <>
                <h4 className="filing-h">帳簿にある仕訳を入金にする（明細の取り込みなどで作ったもの）</h4>
                <table className="ledger">
                  <thead><tr><th>日付</th><th>摘要</th><th className="num">売掛金を減らした額</th><th /></tr></thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={c.entry_id}>
                        <td>{slash(c.date)}</td>
                        <td className="ellipsis">{c.description}</td>
                        <td className="num">{yen(c.amount)}</td>
                        <td className="row-actions">
                          <button className="link-btn" onClick={() => act(() => repo.linkSalesPayment(db, d.id, c.entry_id, Math.min(c.amount, remaining)), "入金にしました")}>入金にする</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </Modal>
  );
};

const VoidModal = ({ doc: d, onClose, onDone }: { doc: SalesDoc; onClose: () => void; onDone: (again: boolean) => void }) => {
  const { db } = useAppContext();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [again, setAgain] = useState(d.kind === "invoice");
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      await repo.voidSalesDoc(db, d.id, reason);
      toast(`${d.doc_no} を取り消しました`);
      onDone(again);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Modal title={`${DOC_KIND_LABEL[d.kind]} ${d.doc_no} の取消`} onClose={onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="field-note">
          取り消した書類は残り（「取消」の印）、直せなくなります。{d.kind === "invoice" ? "売掛金の仕訳は削除します（厳密モードでは削除の履歴が残ります）。" : ""}
          相手に渡した書類を取り消すときは、正しい書類を新しく作って渡してください{d.kind === "invoice" ? "（修正した請求書）" : ""}。
        </p>
        <label className="field">
          <span>取消の理由</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={100} autoFocus placeholder="例：金額の誤り（No.2026-0005 で出し直し）" />
        </label>
        <label className="check">
          <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
          取り消したあと、同じ中身で新しい番号の下書きを作る（直して発行する）
        </label>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn danger" type="submit"><Ban size={15} /> 取り消す</button>
        </div>
      </form>
    </Modal>
  );
};

const InvoiceSettingsModal = ({ conf, onClose, onSaved }: { conf: repo.InvoiceSettings; onClose: () => void; onSaved: () => void }) => {
  const { db } = useAppContext();
  const toast = useToast();
  const [x, setX] = useState(conf);
  const [error, setError] = useState("");
  const submit = async () => {
    try {
      await repo.saveInvoiceSettings(db, x);
      toast("請求書の設定を保存しました");
      onSaved();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Modal title="請求書・見積書の設定" onClose={onClose} width={560}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>振込先（新しく作る請求書に入れます）</span>
          <textarea className="input" rows={2} value={x.invoice_bank} onChange={(e) => setX({ ...x, invoice_bank: e.target.value })} maxLength={200} placeholder="例：○○銀行 △△支店 普通 口座番号 口座名義" />
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>端数の丸め方（明細の金額・消費税額）</span>
          <select className="input" value={x.invoice_rounding} onChange={(e) => setX({ ...x, invoice_rounding: e.target.value as Rounding })}>
            {(Object.keys(ROUNDING_LABEL) as Rounding[]).map((r) => <option key={r} value={r}>{ROUNDING_LABEL[r]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>備考の初期値（任意）</span>
          <textarea className="input" rows={2} value={x.invoice_notes} onChange={(e) => setX({ ...x, invoice_notes: e.target.value })} maxLength={400} />
        </label>
        <p className="field-note">発行者の名前・住所・電話・登録番号は、事業者設定のものを使います。丸め方は、このあと作る・直す書類から使います（保存した書類の金額は変わりません）。</p>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit">保存する</button>
        </div>
      </form>
    </Modal>
  );
};
