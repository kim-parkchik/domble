/**
 * 仕訳の付箋（事業者と税理士の質問・回答・解決済み）と、月ごとの確認済みの印の画面の部品。帳簿の操作は db/review.ts
 */
import { useEffect, useState } from "react";
import { CircleCheck, MessageSquareText, StickyNote } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { addNote, changedSinceCheck, checkMonth, getMonthChecks, getNotes, resolveNotes, uncheckMonth } from "../../db/review";
import { NOTE_MAX, noteStatuses, type MonthCheck, type NoteRow, type NoteStatus } from "../../lib/review";
import { ADJUSTMENT_PERIOD } from "../../lib/accounting";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
/** 2026-11-06 17:40:00 → 11/6 17:40 */
const when = (at: string) => (at ? `${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))} ${at.slice(11, 16)}` : "");

/** 一覧の印（付箋の数。未解決は目立つ色、解決済みは薄く） */
export const NoteBadge = ({ status }: { status: NoteStatus | undefined }) =>
  status ? (
    <span className={`note-badge${status.open ? " open" : ""}`} title={`付箋 ${status.count}件${status.open ? "（未解決）" : "（解決済み）"}${status.last ? `\n最後：${status.last.user_name ?? ""}「${status.last.body.slice(0, 60)}」` : ""}`}>
      {status.open ? <StickyNote size={12} /> : <CircleCheck size={12} />}{status.count}
    </span>
  ) : null;

/** 仕訳を開いたときの付箋の欄（EntryEditModal） */
export const EntryNotesSection = ({ entryId }: { entryId: number }) => {
  const { db, can, readOnly, bump, dataVersion } = useAppContext();
  const toast = useToast();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const reload = () => getNotes(db, entryId).then((n) => {
    setNotes(n);
    if (n.length) setOpen(true);
  }).catch(console.error);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, entryId, dataVersion]);

  const status = noteStatuses(notes).get(entryId);
  const writable = can("entry") && !readOnly;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      await reload();
      bump();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="entry-notes">
      <button className="link-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾" : "▸"} <MessageSquareText size={14} /> 付箋（質問・回答）{status ? `（${status.count}件・${status.open ? "未解決" : "解決済み"}）` : ""}
      </button>
      {open && (
        <div className="entry-notes-body">
          {notes.length === 0 && <p className="field-note">まだありません。税理士への質問や、事業者への確認を書いておけます（帳簿の内容ではないので、締めた年の仕訳にも書けます）。</p>}
          <ul className="note-list">
            {notes.map((n) => (
              <li key={n.id} className={n.kind === "resolve" ? "resolve" : undefined}>
                <span className="note-who">{n.user_name ?? "（記録なし）"}・{when(n.created_at)}</span>
                {n.kind === "resolve" ? <span className="note-resolved"><CircleCheck size={13} /> 解決済みにしました</span> : <span className="note-text">{n.body}</span>}
              </li>
            ))}
          </ul>
          {writable && (
            <form className="note-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await addNote(db, entryId, body); setBody(""); }); }}>
              <textarea className="input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={NOTE_MAX}
                placeholder={status?.open ? "回答・追記" : "質問・確認したいこと（例：この支払いの領収書はありますか？）"} aria-label="付箋に書く" />
              <div className="note-actions">
                <button className="btn primary sm" type="submit" disabled={busy || !body.trim()}>書く</button>
                {status?.open && <button className="btn ghost sm" type="button" onClick={() => run(() => resolveNotes(db, entryId))} disabled={busy}><CircleCheck size={14} /> 解決済みにする</button>}
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
};

const periodName = (m: number) => (m === ADJUSTMENT_PERIOD ? "決算整理" : `${m}月`);

/** その年の確認済みの月（仕訳日記帳の月のボタンの印・ホームのお知らせ）。dataVersion が変わると読み直す */
export const useMonthChecks = () => {
  const { db, year, dataVersion } = useAppContext();
  const [checks, setChecks] = useState<MonthCheck[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    getMonthChecks(db, year).then(setChecks).catch(console.error);
  }, [db, year, dataVersion, n]);
  return { checks, reload: () => setN((x) => x + 1) };
};

/**
 * 仕訳日記帳で1つの月（決算整理）を選んでいるときの、確認済みの帯：確認した人・日時、確認したあとに変わった仕訳、付け外しのボタン
 */
export const MonthCheckBar = ({ month, checks, reload, onShowChanged }: {
  month: number; checks: MonthCheck[]; reload: () => void; onShowChanged: (ids: number[]) => void;
}) => {
  const { db, year, can, readOnly } = useAppContext();
  const toast = useToast();
  const c = checks.find((x) => x.month === month);
  const allowed = can("settings") && !readOnly;
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      reload();
    } catch (e) {
      toast(errText(e), "error");
    }
  };
  return (
    <div className={`month-check-bar${c ? (c.changed ? " changed" : " checked") : ""}`}>
      {c ? (
        <span>
          <CircleCheck size={14} /> <b>{periodName(month)}は確認済み</b>（{c.user_name ?? "記録なし"}・{when(c.checked_at)}）。
          {c.changed > 0 && (
            <>確認したあとに <button className="link-btn" onClick={async () => onShowChanged(await changedSinceCheck(db, year, month))}>{c.changed}件</button> の仕訳が変わっています。</>
          )}
        </span>
      ) : (
        <span className="muted">{periodName(month)}はまだ確認済みにしていません。</span>
      )}
      {allowed && (
        <>
          <button className="btn ghost sm" onClick={() => run(() => checkMonth(db, year, month))}>
            <CircleCheck size={14} /> {c ? "今の内容で確認済みにし直す" : "この月を確認済みにする"}
          </button>
          {c && <button className="btn ghost sm" onClick={() => run(() => uncheckMonth(db, year, month))}>確認済みを外す</button>}
        </>
      )}
    </div>
  );
};
