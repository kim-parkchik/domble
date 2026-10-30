/**
 * 証憑の登録・訂正フォーム
 * 取引年月日・取引金額・取引先は検索要件の項目なので必須
 * スキャナ保存（紙を読み取って保存）では、受領日が必須で、書類の区分・入力期限・画質の確認を出す（lib/scan.ts）。
 * domble はタイムスタンプを付けないので、紙の原本も保存するよう知らせる（入力期限・画質は参考）
 */
import { useEffect, useId, useState } from "react";
import { CheckCircle2, FileUp, Save, TriangleAlert } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { EVIDENCE_DOC_TYPES, EVIDENCE_MAIN_FORMATS } from "../../constants/evidence";
import { MAX_EVIDENCE_BYTES } from "../../constants/appConfig";
import { formatBytes, sha256Hex, validateEvidenceFile, validateEvidenceMeta } from "../../lib/evidence";
import type { EvidenceKind, EvidenceMeta } from "../../lib/types";
import {
  businessDaysBetween, checkScanQuality, DOC_CLASS_LABEL, docClassOf, scanDeadline, SCAN_KEEP_PAPER, SCAN_METHOD_LABEL, type DocClass, type ScanInputMethod,
} from "../../lib/scan";
import { todayIso } from "../../lib/format";
import * as repo from "../../db/repo";

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

interface Props {
  initial: EvidenceMeta;
  /** 最初から入れておくファイル（証憑の画面にドラッグ＆ドロップしたとき） */
  initialFile?: File;
  /** 新規登録（ファイルを選ぶ欄を出す） */
  withFile: boolean;
  /** 訂正の理由を聞く（厳密モードの訂正） */
  askReason?: boolean;
  /** 区分（訂正のときは登録したときの区分。新しく取り込むときは画面で選ぶ） */
  initialKind?: EvidenceKind;
  submitLabel: string;
  onSubmit: (meta: EvidenceMeta, file: PickedFile | null, reason: string, opts: { kind: EvidenceKind; declared: boolean }) => Promise<void>;
  onCancel?: () => void;
}

export const EvidenceForm = ({ initial, initialFile, withFile, askReason, initialKind = "electronic", submitLabel, onSubmit, onCancel }: Props) => {
  const { db, year, counterparties, strict, daysOff } = useAppContext();
  const [m, setM] = useState<EvidenceMeta>(initial);
  // スキャナ保存
  const [kind, setKind] = useState<EvidenceKind>(initialKind);
  const scan = kind === "scan";
  const [scanMethod, setScanMethod] = useState<ScanInputMethod>("early");
  const [declared, setDeclared] = useState(false);
  /** 書類の区分を自分で選んだか（選んでいなければ、書類の種類に合わせて変える） */
  const [classTouched, setClassTouched] = useState(!!initial.doc_class);
  const docClass: DocClass = (m.doc_class || docClassOf(m.doc_type)) as DocClass;
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dupOf, setDupOf] = useState<number[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();
  const set = <K extends keyof EvidenceMeta>(k: K, v: EvidenceMeta[K]) => setM((x) => ({ ...x, [k]: v }));

  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    repo.getEvidenceCounterparties(db).then(setSuggestions).catch(console.error);
    repo.getScanInputMethod(db).then(setScanMethod).catch(console.error);
  }, [db]);

  useEffect(() => {
    if (initialFile) pick(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  const pick = async (f: File | undefined) => {
    setError("");
    setFile(null);
    setDupOf([]);
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const err = validateEvidenceFile(bytes, f.name);
    if (err) return setError(err);
    setFile({ name: f.name, bytes });
    setDupOf(await repo.findEvidenceByHash(db, await sha256Hex(bytes)));
  };

  /** 日付の欄に読めない日付が入っているもの（そのままだと前の日付で保存されるので止める） */
  const [badDates, setBadDates] = useState<Set<string>>(new Set());
  const markDate = (key: string) => (ok: boolean) => setBadDates((s) => {
    const n = new Set(s);
    if (ok) n.delete(key);
    else n.add(key);
    return n;
  });
  const submit = async () => {
    setError("");
    if (badDates.size) return setError("日付が正しくありません（2026/4/15 のように入れてください）");
    if (withFile && !file) return setError("ファイルを選んでください");
    const err = validateEvidenceMeta(m);
    if (err) return setError(err);
    if (askReason && !reason.trim()) return setError("訂正の理由を入れてください");
    if (scan && !m.received_date) return setError("スキャナ保存では受領日（紙を受け取った日）を入れてください");
    if (scan && quality && !quality.ok) return setError(quality.problems.join("。"));
    setBusy(true);
    try {
      await onSubmit({ ...m, doc_class: scan ? docClass : "" }, file, reason, { kind, declared });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  // 入力期限（新しく取り込むときは、今日取り込んだとして見る）と画質の確認
  const deadline = scan && m.received_date ? scanDeadline(m.received_date, scanMethod, daysOff) : null;
  const late = withFile && deadline !== null && todayIso() > deadline;
  const quality = scan && withFile && file ? checkScanQuality(file.bytes, docClass, declared) : null;
  const daysLeft = deadline && !late ? businessDaysBetween(todayIso(), deadline, daysOff) : null;

  return (
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {withFile && (
        <div className="field">
          <span>区分</span>
          <div className="kind-choice" role="radiogroup" aria-label="区分">
            <label className="check">
              <input type="radio" checked={!scan} onChange={() => setKind("electronic")} /> 電子取引データ（メールなどで受け取ったファイル）
            </label>
            <label className="check" title={strict ? undefined : repo.SCAN_STRICT_ONLY}>
              <input type="radio" checked={scan} disabled={!strict} onChange={() => setKind("scan")} /> スキャナ保存（紙を読み取ったもの。紙の原本も保存）
            </label>
          </div>
          {!strict && <small className="field-note">スキャナ保存は、電子帳簿保存法に対応した保存方式（厳密モード）の帳簿でだけ使えます。</small>}
        </div>
      )}
      {scan && <p className="notice">{SCAN_KEEP_PAPER}。入力期限と画質の確かめは参考として出します（入力期限は PC の時計で判定します）。</p>}
      {withFile && (
        <label
          className={`field drop-zone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files?.[0]);
          }}
        >
          <span>ファイル（{EVIDENCE_MAIN_FORMATS}。{formatBytes(MAX_EVIDENCE_BYTES)} まで。受け取ったファイルのまま保存します）</span>
          <input className="input file-input" type="file" onChange={(e) => pick(e.target.files?.[0])} />
          <span className="field-note">ここにファイルをドラッグ＆ドロップしても選べます</span>
          {file && <span className="field-note"><FileUp size={13} /> {file.name}（{formatBytes(file.bytes.length)}）</span>}
          {dupOf.length > 0 && (
            <span className="field-note warn-text">同じ中身のファイルが登録済みです（No.{dupOf.join("・")}）。二重に登録していないか確認してください。</span>
          )}
        </label>
      )}
      {quality && (
        <div className={`scan-check ${quality.ok ? "ok" : "ng"}`} role="status">
          {quality.method === "auto" ? (
            quality.ok ? (
              <span><CheckCircle2 size={14} /> 画質：{quality.info!.dpi ? `${quality.info!.dpi}dpi` : `${Math.round((quality.info!.width * quality.info!.height) / 10000)}万画素`}・{quality.info!.color === "color" ? "カラー" : "グレースケール"}（要件を満たしています）</span>
            ) : (
              <span><TriangleAlert size={14} /> 画質が要件を満たしていません：{quality.problems.join("。")}。読み取り直してください。</span>
            )
          ) : (
            <label className="check">
              <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
              この形式は画質を自動で確かめられません。200dpi 以上・{docClass === "important" ? "カラー" : "カラーまたはグレースケール（256階調以上）"}で読み取りました
            </label>
          )}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>書類の種類</span>
          <select className="input" value={m.doc_type} onChange={(e) => setM((x) => ({ ...x, doc_type: e.target.value, ...(classTouched ? {} : { doc_class: docClassOf(e.target.value) }) }))}>
            {EVIDENCE_DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {scan && (
          <label className="field" title="重要書類：契約書・領収書・請求書・納品書など、お金や物の流れに直結するもの。一般書類：見積書・注文書など">
            <span>書類の区分</span>
            <select className="input" value={docClass} onChange={(e) => { setClassTouched(true); set("doc_class", e.target.value as DocClass); }}>
              {(Object.keys(DOC_CLASS_LABEL) as DocClass[]).map((c) => <option key={c} value={c}>{DOC_CLASS_LABEL[c]}</option>)}
            </select>
          </label>
        )}
        <label className="field">
          <span>取引年月日</span>
          <FullDateInput value={m.txn_date} onChange={(v) => set("txn_date", v)} year={year} aria-label="取引年月日" onValidity={markDate("txn")} />
        </label>
        <label className="field">
          <span>取引金額（円）</span>
          <AmountInput value={m.amount} onChange={(v) => set("amount", v ?? 0)} aria-label="取引金額" />
        </label>
      </div>
      <div className="field-row">
        <label className="field" style={{ maxWidth: 220 }}>
          <span>{scan ? "受領日（紙を受け取った日・必須）" : "受領日（受け取った日・任意）"}</span>
          <FullDateInput value={m.received_date ?? ""} onChange={(v) => set("received_date", v)} year={year} aria-label="受領日" onValidity={markDate("received")} />
        </label>
        {scan && deadline && (
          <div className={`field scan-deadline${late ? " late" : ""}`}>
            <span>入力期限（参考・{SCAN_METHOD_LABEL[scanMethod].split("（")[0]}）</span>
            <div>
              {deadline.replace(/-/g, "/")}
              {withFile && (late
                ? <b>　期限を過ぎています</b>
                : daysLeft !== null && <span className="muted">　あと {daysLeft} 営業日</span>)}
            </div>
          </div>
        )}
      </div>
      {scan && late && (
        <p className="notice">
          入力期限を過ぎています。登録はできますが「入力期間外」の印がつきます。
        </p>
      )}
      <label className="field">
        <span>取引先</span>
        <input className="input" list={listId} value={m.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="例：株式会社〇〇" maxLength={60} />
        <datalist id={listId}>
          {[...new Set([...counterparties.filter((c) => c.is_active).map((c) => c.name), ...suggestions])].map((s) => <option key={s} value={s} />)}
        </datalist>
        <span className="field-note">取引先一覧の名前と同じにすると、取引先（登録番号など）とつながります。</span>
      </label>
      <label className="field">
        <span>メモ（任意）</span>
        <input className="input" value={m.memo} onChange={(e) => set("memo", e.target.value)} maxLength={200} placeholder="例：1月分の外注費" />
      </label>
      {askReason && (
        <label className="field">
          <span>訂正の理由（必須・履歴に残ります）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="例：金額の入力ミス" />
        </label>
      )}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="voucher-actions">
        <div className="spacer" />
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>やめる</button>}
        <button className="btn primary" type="submit" disabled={busy}>
          <Save size={16} /> {submitLabel}
        </button>
      </div>
    </form>
  );
};
