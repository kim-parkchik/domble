/**
 * 税理士との受け渡し（事業者設定）と、渡している（受け取った・返した）帳簿の画面上部のお知らせ。
 * 決まりは lib/handoff.ts、帳簿の操作は db/handoff.ts、置き換えて開き直すのは App.tsx の receiveBook
 */
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { ArrowLeftRight, FileInput, FileOutput, Handshake, KeyRound, Undo2 } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import * as repo from "../../db/repo";
import type Database from "../../db/connection";
import { cancelHandoff, changedSince, getHandoffs, inspectReturned, returnToOwner, sendToAccountant, type Inspection } from "../../db/handoff";
import { folderOf, openDatabase, pickHandoffDest, pickReturnedFile, writeBookCopy } from "../../db/database";
import { encryptionStatus, NEEDS_KEY, WRONG_KEY } from "../../db/encryption";
import { countText, ENTRY_CHANGE_LABEL, HANDOFF_KIND_LABEL, handoffFileName, lastSend, type EntryChange, type Handoff } from "../../lib/handoff";
import { EXT_MAIN, SCHEMA_VERSION } from "../../constants/appConfig";
import { yen } from "../../lib/format";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** 2026-11-06 10:00:00 → 2026/11/6 10:00 */
const when = (at: string) => (at ? `${at.slice(0, 4)}/${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))} ${at.slice(11, 16)}` : "");
const SECTION_ID = "handoff-section";
/** 事業者設定の「税理士との受け渡し」まで動かす（画面上部のお知らせから。上の欄を読み込むと位置がずれるので、少しあとにもう一度） */
const scrollToSection = () => {
  for (const ms of [60, 400]) setTimeout(() => document.getElementById(SECTION_ID)?.scrollIntoView({ block: "start" }), ms);
};

/** 仕訳の変わったもの（多いときは先頭だけ） */
const EntryTable = ({ rows, limit = 100 }: { rows: EntryChange[]; limit?: number }) => (
  <>
    <table className="ledger handoff-entries">
      <thead><tr><th>No.</th><th></th><th>日付</th><th>摘要</th><th className="num">金額</th><th>操作した人</th></tr></thead>
      <tbody>
        {rows.slice(0, limit).map((e) => (
          <tr key={`${e.kind}-${e.id}`} className={e.kind === "deleted" ? "deleted" : undefined}>
            <td className="num">{e.id}</td>
            <td><span className={`badge ${e.kind === "added" ? "badge-create" : e.kind === "changed" ? "badge-update" : "badge-delete"}`}>{ENTRY_CHANGE_LABEL[e.kind]}</span></td>
            <td>{e.date}</td>
            <td>{e.description}</td>
            <td className="num">{yen(e.amount)}</td>
            <td>{e.user}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {rows.length > limit && <p className="field-note">ほか {rows.length - limit} 件</p>}
  </>
);

/** 渡す（事業者）・返す（税理士）：メモを書き、保存先を選んで写しを書き出す */
const HandOverModal = ({ to, onClose, onDone }: { to: "accountant" | "owner"; onClose: () => void; onDone: (dest: string) => void }) => {
  const { db, filePath, users, settings } = useAppContext();
  const toast = useToast();
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [since, setSince] = useState<EntryChange[] | null>(null);
  const noAccountant = to === "accountant" && !users.some((u) => u.is_active && u.role === "accountant");
  useEffect(() => {
    encryptionStatus(filePath).then((s) => setEncrypted(s.encrypted)).catch(() => setEncrypted(null));
    // 返すとき：受け取ってから入れた・直した仕訳
    if (to === "owner") {
      getHandoffs(db).then((l) => lastSend(l, settings.handoff_token)).then((s) => (s ? changedSince(db, s.at) : [])).then(setSince).catch(console.error);
    }
  }, [db, filePath, to, settings.handoff_token]);

  const run = async () => {
    const dest = await pickHandoffDest(await join(folderOf(filePath), handoffFileName(filePath, to, new Date(), EXT_MAIN)));
    if (!dest) return;
    if (dest === filePath) return toast("今の帳簿ファイルとは別の名前にしてください", "error");
    setBusy(true);
    try {
      const write = () => writeBookCopy(filePath, dest);
      if (to === "accountant") await sendToAccountant(db, dest, memo.trim(), write);
      else await returnToOwner(db, dest, memo.trim(), write);
      onDone(dest);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };

  return (
    <Modal title={to === "accountant" ? "税理士に渡す" : "事業者に返す"} onClose={onClose} width={640}>
      {to === "accountant" ? (
        <div className="prose">
          <p>
            帳簿の写し（<b>{handoffFileName(filePath, "accountant", new Date(), EXT_MAIN)}</b>）を書き出します。メールやファイル共有で税理士に送ってください。
            税理士は domble で写しを開き、「税理士」の権限のユーザーで入ります。
          </p>
          <p><b>渡している間は、この帳簿に入力しないでください。</b>受け取るとき、税理士から返ってきた帳簿でこの帳簿を置き換えるため、ここで入れた分は消えます（入力しようとすると止めます）。</p>
          {encrypted === false && (
            <p className="warn-box">この帳簿は暗号化していません。メールなどで送るなら、先に下の「帳簿ファイルの暗号化」で暗号化しておくと安心です。パスワードは、帳簿とは別の方法（電話など）で税理士に伝えてください。</p>
          )}
          {encrypted && <p className="field-note"><KeyRound size={13} /> 写しも同じパスワードで暗号化されています。パスワードは、帳簿とは別の方法（電話など）で税理士に伝えてください。</p>}
          {noAccountant && <p className="form-error-inline" role="alert">税理士のユーザーがいません。先に「ユーザー」の画面で、権限を「税理士」にしたユーザーを足してください。</p>}
        </div>
      ) : (
        <div className="prose">
          <p>
            返すための写し（<b>{handoffFileName(filePath, "owner", new Date(), EXT_MAIN)}</b>）を書き出します。メールやファイル共有で事業者に送ってください。
            事業者は「税理士から受け取る」で、変わったものを確かめてから受け取ります。
          </p>
          <p>返したあとのこの帳簿は、見るだけにしてください（ここで入れた分は事業者の帳簿に入りません）。</p>
          {since && (since.length === 0
            ? <p className="field-note">受け取ってから入れた・直した仕訳はありません。</p>
            : <><h3 className="sheet-sub">受け取ってから入れた・直した仕訳（{since.length}件）</h3><EntryTable rows={since} limit={30} /></>)}
        </div>
      )}
      <label className="field">
        <span>メモ（任意。{to === "accountant" ? "「10月分まで確認をお願いします」など" : "「12月分の決算整理を入れました」など"}）</span>
        <textarea className="input" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} />
      </label>
      <div className="voucher-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>やめる</button>
        <button className="btn primary" onClick={run} disabled={busy || noAccountant}>
          {to === "accountant" ? <FileOutput size={16} /> : <Undo2 size={16} />} 保存先を選んで{to === "accountant" ? "渡す" : "返す"}
        </button>
      </div>
    </Modal>
  );
};

/** 税理士から受け取る（事業者）：返ってきた帳簿を選び、読み取り専用で開いて確かめ、変わったものを見てから置き換える */
const ReceiveModal = ({ onClose }: { onClose: () => void }) => {
  const { db, filePath, receiveBook } = useAppContext();
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [other, setOther] = useState<Database | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Inspection | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  // 閉じるときに、読み取り専用で開いた帳簿も閉じる
  const closeOther = async (d: Database | null = other) => {
    if (d) await d.close().catch(() => undefined);
  };
  const close = async () => {
    await closeOther();
    onClose();
  };

  const openReturned = async (p: string, key?: string) => {
    setBusy(true);
    setError("");
    try {
      const { db: rdb } = await openDatabase(p, true, key ? { secret: key } : {});
      setNeedKey(false);
      setOther(rdb);
      setResult(await inspectReturned(db, rdb, SCHEMA_VERSION));
    } catch (e) {
      if (String(e).includes(NEEDS_KEY)) setNeedKey(true);
      else if (String(e).includes(WRONG_KEY)) {
        setNeedKey(true);
        setError("パスワード（または回復キー）が違います");
      } else setError(`開けませんでした：${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const p = await pickReturnedFile(folderOf(filePath));
    if (!p) return;
    if (p === filePath) return setError("今の帳簿ファイルです。税理士から返ってきた帳簿（「事業者へ」の付いたファイルなど）を選んでください");
    await closeOther();
    setOther(null);
    setResult(null);
    setAck(false);
    setSecret("");
    setPath(p);
    await openReturned(p);
  };

  const receive = async () => {
    if (!path || !result || result.problem) return;
    setBusy(true);
    try {
      await closeOther();
      await receiveBook(path);
    } catch (e) {
      toast(errText(e), "error");
      setBusy(false);
    }
  };

  const nothing = result && !result.problem && result.entries.length === 0 && result.tables.length === 0;
  return (
    <Modal title="税理士から受け取る" onClose={close} width={860}>
      <p className="prose">
        税理士から返ってきた帳簿を選ぶと、読み取り専用で開いて、最後に渡したものが返ってきたか・渡したあとにこの帳簿で入れたものが無いかを確かめ、変わったものを出します。
        受け取ると、今の帳簿を「受け取る前」の印をつけてバックアップしてから、返ってきた帳簿で置き換えます。
      </p>
      <div className="field-row wrap">
        <button className="btn primary" onClick={pick} disabled={busy}><FileInput size={16} /> 返ってきた帳簿を選ぶ</button>
        {path && <span className="path-text handoff-path" title={path}>{baseName(path)}</span>}
      </div>
      {needKey && path && (
        <form className="field-row" onSubmit={(e) => { e.preventDefault(); openReturned(path, secret); }}>
          <label className="field">
            <span>暗号化した帳簿です。パスワード（または回復キー）</span>
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
          </label>
          <div style={{ alignSelf: "flex-end" }}><button className="btn primary" type="submit" disabled={busy || !secret}>開く</button></div>
        </form>
      )}
      {error && <p className="form-error-inline" role="alert">{error}</p>}
      {result?.problem && <p className="form-errors" role="alert">受け取れません：{result.problem}</p>}
      {result && !result.problem && (
        <div className="handoff-result">
          <p>
            {result.back ? <>「{result.back.user_name ?? "税理士"}」が <b>{when(result.back.at)}</b> に返した帳簿です。</> : null}
            {result.send && <>（{when(result.send.at)} に渡したもの）</>}
            {result.back?.memo && <><br />メモ：{result.back.memo}</>}
          </p>
          {result.localCount > 0 && (
            <div className="warn-box handoff-local">
              <div>
                <b>渡したあとに、この帳簿で {result.localCount} 回入力・変更しています。</b>受け取ると、それらは消えます
                （受け取る前の帳簿はバックアップに残るので、あとで見て入れ直せます）。
                {result.local.length > 0 && <EntryTable rows={result.local} limit={30} />}
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  ここで入れた分が消えることを確かめました
                </label>
              </div>
            </div>
          )}
          <h3 className="sheet-sub">変わったもの</h3>
          {nothing && <p className="field-note">変わったものはありません。</p>}
          {result.entries.length > 0 && (
            <>
              <p className="field-note">
                仕訳：{countText({
                  added: result.entries.filter((e) => e.kind === "added").length,
                  changed: result.entries.filter((e) => e.kind === "changed").length,
                  removed: result.entries.filter((e) => e.kind === "deleted").length,
                })}
              </p>
              <EntryTable rows={result.entries} />
            </>
          )}
          {result.tables.length > 0 && (
            <table className="ledger handoff-tables">
              <thead><tr><th>そのほか</th><th>変わったもの</th></tr></thead>
              <tbody>{result.tables.map((t) => <tr key={t.table}><td>{t.label}</td><td>{countText(t)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
      <div className="voucher-actions">
        <button className="btn ghost" onClick={close} disabled={busy}>やめる</button>
        <button className="btn primary" onClick={receive} disabled={busy || !result || !!result.problem || (result.localCount > 0 && !ack)}>
          <FileInput size={16} /> 受け取る（今の帳簿を置き換える）
        </button>
      </div>
    </Modal>
  );
};

export const HandoffSection = () => {
  const { db, settings, readOnly, can, reloadSettings, dataVersion } = useAppContext();
  const toast = useToast();
  const holder = settings.holder ?? "owner";
  const [list, setList] = useState<Handoff[]>([]);
  const [open, setOpen] = useState<"send" | "return" | "receive" | null>(null);
  const reload = () => getHandoffs(db).then(setList).catch(console.error);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, holder, dataVersion]);

  const done = async (dest: string, to: "accountant" | "owner") => {
    setOpen(null);
    await reloadSettings();
    await reload();
    toast(`${to === "accountant" ? "税理士に渡しました" : "事業者に返しました"}。「${baseName(dest)}」をメールやファイル共有で送ってください`);
  };

  const cancel = async () => {
    const ok = await ask(
      "税理士に渡すのをやめて、この帳簿で続けます。\n\n渡した帳簿は、あとで返ってきても受け取れなくなります（税理士が直した分は、この帳簿には入りません）。よろしいですか？",
      { title: "渡すのをやめる", kind: "warning", okLabel: "やめる", cancelLabel: "戻る" },
    );
    if (!ok) return;
    try {
      await cancelHandoff(db);
      await reloadSettings();
      await reload();
      toast("渡すのをやめました。この帳簿に入力できます");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const owner = can("owner") && !readOnly;
  return (
    <section className="sheet" id={SECTION_ID}>
      <h2 className="sheet-h"><Handshake size={17} /> 税理士との受け渡し</h2>
      <p className="prose">
        税理士も domble を使うときに、帳簿ファイルをメールやファイル共有で渡し合います。正本はどちらか1人が持ちます：
        事業者が「税理士に渡す」で写しを送り、税理士が確かめ・直してから「事業者に返す」で送り返し、事業者が「税理士から受け取る」で変わったものを確かめてから置き換えます。
        渡している間は、事業者の帳簿には入力しません。
      </p>
      {readOnly ? (
        <p className="field-note">読み取り専用で開いているため、ここでは操作できません。</p>
      ) : (
        <>
          <p className={`handoff-state ${holder}`}>
            <ArrowLeftRight size={15} />{" "}
            {holder === "owner" && "今は事業者が帳簿を持っています（ふだんの状態）。"}
            {holder === "sent" && "今は税理士に渡しています。受け取るまでは、この帳簿に入力しないでください。"}
            {holder === "accountant" && "事業者から受け取った帳簿です（税理士が確かめ・直しているところ）。終わったら「事業者に返す」で返してください。"}
            {holder === "returned" && "事業者に返したあとの帳簿です。ここで入れた分は事業者の帳簿に入りません。"}
          </p>
          <div className="field-row wrap">
            {holder === "owner" && <button className="btn primary" onClick={() => setOpen("send")} disabled={!owner}><FileOutput size={16} /> 税理士に渡す</button>}
            {holder === "sent" && <button className="btn primary" onClick={() => setOpen("receive")} disabled={!owner}><FileInput size={16} /> 税理士から受け取る</button>}
            {holder === "accountant" && <button className="btn primary" onClick={() => setOpen("return")} disabled={!can("entry")}><Undo2 size={16} /> 事業者に返す</button>}
            {(holder === "sent" || (holder === "accountant" && owner)) && (
              <button className="btn ghost" onClick={cancel} disabled={!owner}>渡すのをやめる（この帳簿で続ける）</button>
            )}
          </div>
          {!owner && (holder === "owner" || holder === "sent") && <p className="field-note">税理士に渡す・受け取るは、管理者（事業者）だけができます。</p>}
        </>
      )}
      {list.length > 0 && (
        <>
          <h3 className="sheet-sub">受け渡しの記録</h3>
          <ul className="handoff-log">
            {[...list].reverse().map((h) => (
              <li key={h.id}>
                <div>
                  <b>{when(h.at)}</b>　{HANDOFF_KIND_LABEL[h.kind]}{h.user_name ? `（${h.user_name}）` : ""}
                  {h.local_changes > 0 && <span className="badge badge-update" title="渡している間に、この帳簿で入力・変更した数（受け取ると消えた分）">渡したあとの入力 {h.local_changes}</span>}
                </div>
                {(h.file || h.memo) && (
                  <div className="muted handoff-log-sub">
                    {h.file && <span title={h.file}>{baseName(h.file)}</span>}
                    {h.memo && (h.kind === "receive"
                      ? <span title={h.memo}>受け取る前の帳簿：{baseName(h.memo)}</span>
                      : <span>メモ：{h.memo}</span>)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {(open === "send" || open === "return") && (
        <HandOverModal to={open === "send" ? "accountant" : "owner"} onClose={() => setOpen(null)} onDone={(dest) => done(dest, open === "send" ? "accountant" : "owner")} />
      )}
      {open === "receive" && <ReceiveModal onClose={() => setOpen(null)} />}
    </section>
  );
};

/** 画面上部のお知らせ：渡している帳簿（事業者）・受け取った帳簿（税理士）・返したあとの帳簿（税理士） */
export const HandoffNotice = ({ goSettings }: { goSettings: () => void }) => {
  const { db, settings, readOnly, dataVersion } = useAppContext();
  const holder = settings.holder ?? "owner";
  const [ack, setAck] = useState(repo.handoffState().ack);
  const [list, setList] = useState<Handoff[]>([]);
  useEffect(() => {
    setAck(repo.handoffState().ack);
    if (holder !== "owner") getHandoffs(db).then(setList).catch(console.error);
  }, [db, holder, dataVersion]);
  if (readOnly || holder === "owner") return null;

  const send = lastSend(list, settings.handoff_token);
  const back = [...list].reverse().find((h) => h.kind === "return");
  const go = () => {
    goSettings();
    scrollToSection();
  };
  const allow = async () => {
    const ok = await ask(
      holder === "sent"
        ? "税理士に渡している帳簿に入力します。\n\n受け取るとき、税理士から返ってきた帳簿でこの帳簿を置き換えるため、ここで入れた分は消えます（受け取る前に、入れたものを一覧で知らせます）。よろしいですか？"
        : "事業者に返したあとの帳簿に入力します。\n\nここで入れた分は、事業者の帳簿には入りません。よろしいですか？",
      { title: "それでも入力する", kind: "warning", okLabel: "入力する", cancelLabel: "やめる" },
    );
    if (!ok) return;
    repo.ackHandoff();
    setAck(true);
  };

  return (
    <div className="year-notice">
      <div className={`year-notice-row ${holder === "accountant" ? "closed" : "warn"}`}>
        <Handshake size={15} />
        <span>
          {holder === "sent" && (
            <>
              <b>税理士に渡しています</b>{send ? `（${when(send.at)}・${send.user_name ?? ""}）` : ""}。
              {ack ? "この帳簿に入力できるようにしています（受け取るとき、ここで入れた分は消えます）。" : "受け取るまでは、この帳簿に入力しないでください（受け取るとき、ここで入れた分は消えます）。"}
            </>
          )}
          {holder === "accountant" && (
            <>
              <b>事業者から受け取った帳簿です</b>{send ? `（${when(send.at)} に ${send.user_name ?? "事業者"} が渡しました${send.memo ? `。メモ：${send.memo}` : ""}）` : ""}。
              確かめ・直しが終わったら「事業者に返す」で返してください。
            </>
          )}
          {holder === "returned" && (
            <>
              <b>事業者に返したあとの帳簿です</b>{back ? `（${when(back.at)}）` : ""}。
              {ack ? "入力できるようにしていますが、ここで入れた分は事業者の帳簿に入りません。" : "ここで入れた分は事業者の帳簿に入らないので、見るだけにしてください。"}
            </>
          )}
        </span>
        {holder === "sent" && <button className="btn ghost sm" onClick={go}>税理士から受け取る</button>}
        {holder === "accountant" && <button className="btn ghost sm" onClick={go}>事業者に返す</button>}
        {holder !== "accountant" && !ack && <button className="btn ghost sm" onClick={allow}>それでも入力する</button>}
      </div>
    </div>
  );
};
