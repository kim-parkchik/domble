/**
 * 訂正・削除履歴
 * すべての仕訳について「いつ・何を・どう変えたか（消したか）」を新しい順に一覧します。
 * 履歴はデータベース側で書き換え・削除ができないようにしてあります。
 */
import { useEffect, useMemo, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { EntryEditModal } from "../entry/EntryEditModal";
import { ACTION_LABEL, SnapshotTable } from "./HistoryView";
import { IntegrityModal } from "./IntegrityModal";
import type { AccessLogRecord, EvidenceHistoryRecord, HistoryAction, HistoryRecord, MasterHistoryRecord } from "../../lib/types";
import { EVIDENCE_ACTION_LABEL, evidenceActionBadge } from "../evidence/EvidenceModals";
import { yen } from "../../lib/format";
import { toCsv, type CsvValue } from "../../lib/csv";
import { loginEnds, type LoginEnd } from "../../lib/accessLog";

/** ログインの終わり方の表示（ログアウトが記録されていれば何も出さない） */
const LOGIN_END_LABEL: Record<LoginEnd, string> = {
  logout: "",
  missing: "ログアウトの記録なし（強制終了など）",
  current: "利用中（または最後に強制終了）",
};
import * as repo from "../../db/repo";

type Filter = "all" | HistoryAction | "changes";

/** 画面に一度に出す件数（履歴は全件読み込むが、描画は少しずつ。CSV は全件） */
const PAGE_SIZE = 500;

/** 残りがあれば「さらに表示」 */
const ShowMore = ({ total, limit, onMore }: { total: number; limit: number; onMore: () => void }) =>
  total > limit ? (
    <div className="show-more">
      <button className="btn ghost sm" onClick={onMore}>さらに表示（残り {total - limit} 件）</button>
    </div>
  ) : null;

/** 一覧を少しずつ出すための件数。deps が変わったら最初に戻る */
const usePaged = (deps: unknown[]) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLimit(PAGE_SIZE), deps);
  return { limit, more: () => setLimit((n) => n + PAGE_SIZE) };
};

export const HistoryPage = () => {
  const { db, dataVersion, settings } = useAppContext();
  const toast = useToast();
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("changes");
  const [entryNo, setEntryNo] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [kind, setKind] = useState<"entries" | "masters" | "evidence" | "access">("entries");
  const [access, setAccess] = useState<AccessLogRecord[]>([]);
  const [masters, setMasters] = useState<MasterHistoryRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceHistoryRecord[]>([]);
  const [checking, setChecking] = useState(false);
  const page = usePaged([filter, entryNo, kind]);

  useEffect(() => {
    repo.getHistory(db).then(setRecords).catch(console.error);
    repo.getMasterHistory(db).then(setMasters).catch(console.error);
    repo.getEvidenceHistory(db).then(setEvidence).catch(console.error);
    repo.getAccessLog(db).then(setAccess).catch(console.error);
  }, [db, dataVersion]);

  /** 訂正の比較元（同じ仕訳の1つ前の版） */
  const prevOf = useMemo(() => {
    const map = new Map<string, HistoryRecord>();
    for (const r of records) map.set(`${r.entry_id}:${r.revision}`, r);
    return (r: HistoryRecord) => map.get(`${r.entry_id}:${r.revision - 1}`);
  }, [records]);

  const shown = records.filter((r) => {
    if (entryNo && String(r.entry_id) !== entryNo.trim()) return false;
    if (filter === "all") return true;
    if (filter === "changes") return r.action !== "create";
    return r.action === filter;
  });

  const counts = {
    update: records.filter((r) => r.action === "update").length,
    delete: records.filter((r) => r.action === "delete").length,
  };

  /** 表示中のタブの CSV（絞り込みはそのまま、件数は全件） */
  const csvOf = (): { name: string; header: string[]; rows: CsvValue[][] } => {
    if (kind === "masters") {
      return {
        name: "変更履歴",
        header: ["記録日時", "年度", "対象", "操作", "名称", "変更前", "変更後", "操作者"],
        rows: masters.map((r) => [r.recorded_at, r.fiscal_year, TARGET_LABEL[r.target_type], MASTER_ACTION[r.action], r.label, r.old_value, r.new_value, r.user_name ?? ""]),
      };
    }
    if (kind === "evidence") {
      return {
        name: "証憑の履歴",
        header: ["記録日時", "証憑No", "版", "操作", "取引年月日", "取引先", "金額", "伝票No", "ファイル名", "SHA-256", "理由・内容", "操作者"],
        rows: evidence.map((r) => [r.recorded_at, r.evidence_id, r.revision, EVIDENCE_ACTION_LABEL[r.action], r.snapshot.txn_date, r.snapshot.counterparty,
          r.snapshot.amount, r.snapshot.entry_ids.join(" "), r.snapshot.file_name, r.snapshot.sha256, r.reason, r.user_name ?? ""]),
      };
    }
    if (kind === "access") {
      const ends = loginEnds(access);
      return {
        name: "利用の記録",
        header: ["記録日時", "操作", "ユーザー", "備考"],
        rows: access.map((r) => [r.recorded_at, r.action === "login" ? "ログイン" : "ログアウト", r.user_name, LOGIN_END_LABEL[ends.get(r.id) ?? "logout"]]),
      };
    }
    return {
      name: "訂正削除履歴",
      header: ["記録日時", "伝票No", "版", "操作", "操作者", "理由", "日付", "取引先", "借貸", "科目", "補助科目", "金額", "摘要"],
      rows: shown.flatMap((r) =>
        r.snapshot.lines.map((l) => [r.recorded_at, r.entry_id, r.revision, ACTION_LABEL[r.action], r.user_name ?? "", r.reason, r.snapshot.date,
          r.snapshot.counterparty ?? "", l.side === "debit" ? "借方" : "貸方", l.account, l.sub, l.amount, l.memo]),
      ),
    };
  };

  const exportCsv = async () => {
    const { name, header, rows } = csvOf();
    const path = await save({
      defaultPath: `${name}_${settings.business_name || "帳簿"}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    try {
      await writeTextFile(path, toCsv(header, rows));
      toast("CSV を書き出しました");
    } catch (e) {
      toast(`書き出せませんでした：${String(e)}`, "error");
    }
  };

  const tabCount = { entries: shown.length, masters: masters.length, evidence: evidence.length, access: access.length }[kind];

  return (
    <div className="page">
      <PageHeader
        title="訂正・削除履歴"
        note="仕訳・勘定科目・期首残高・証憑を変更するたびに記録されます。この履歴は変更も削除もできません。"
      >
        <button className="btn ghost" onClick={() => setChecking(true)}><ShieldCheck size={16} /> 改ざんの確認</button>
        <button className="btn ghost" onClick={exportCsv} disabled={tabCount === 0}>
          <Download size={16} /> CSV 書き出し
        </button>
      </PageHeader>

      <div className="kind-tabs" role="tablist">
        <button role="tab" aria-selected={kind === "entries"} className={kind === "entries" ? "on" : ""} onClick={() => setKind("entries")}>仕訳</button>
        <button role="tab" aria-selected={kind === "masters"} className={kind === "masters" ? "on" : ""} onClick={() => setKind("masters")}>
          勘定科目・期首残高・締め（{masters.length}）
        </button>
        <button role="tab" aria-selected={kind === "evidence"} className={kind === "evidence" ? "on" : ""} onClick={() => setKind("evidence")}>
          証憑（{evidence.length}）
        </button>
        <button role="tab" aria-selected={kind === "access"} className={kind === "access" ? "on" : ""} onClick={() => setKind("access")}>
          利用の記録（{access.length}）
        </button>
      </div>

      {kind === "access" ? <AccessLogTable records={access} limit={page.limit} onMore={page.more} />
        : kind === "evidence" ? <EvidenceHistoryTable records={evidence} limit={page.limit} onMore={page.more} />
        : kind === "masters" ? <MasterHistoryTable records={masters} limit={page.limit} onMore={page.more} /> : <>
      <div className="filters">
        <div className="seg" role="tablist">
          {([
            ["changes", "訂正と削除"],
            ["update", `訂正（${counts.update}）`],
            ["delete", `削除（${counts.delete}）`],
            ["all", "登録も含む"],
          ] as [Filter, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <span>No.</span>
          <input value={entryNo} onChange={(e) => setEntryNo(e.target.value.replace(/\D/g, ""))} placeholder="伝票番号で絞る" style={{ width: 120 }} />
        </label>
        <span className="filter-count">{shown.length} 件</span>
      </div>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {shown.length === 0 ? (
            <p className="empty-note">
              {filter === "changes" ? "まだ訂正・削除された仕訳はありません。" : "該当する履歴はありません。"}
            </p>
          ) : (
            <table className="ledger history-table">
              <colgroup>
                <col style={{ width: 170 }} />
                <col style={{ width: 64 }} />
                <col style={{ width: 70 }} />
                <col style={{ width: 90 }} />
                <col />
              </colgroup>
              <thead>
                <tr><th>記録日時</th><th className="num">No.</th><th>操作</th><th>操作者</th><th>内容</th></tr>
              </thead>
              <tbody>
                {shown.slice(0, page.limit).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEditing(r.entry_id)}>
                    <td className="muted">{r.recorded_at}</td>
                    <td className="num">{r.entry_id}</td>
                    <td>
                      <span className={`badge badge-${r.action}`}>{ACTION_LABEL[r.action]}</span>
                      <div className="muted small">第{r.revision}版</div>
                    </td>
                    <td>{r.user_name ?? ""}</td>
                    <td><div className="history-content">
                      {r.reason && <div className="history-reason">理由：{r.reason}</div>}
                      {r.action === "update" && prevOf(r) && (
                        <div className="snap-before">
                          <span className="snap-tag">訂正前</span>
                          <SnapshotTable snap={prevOf(r)!.snapshot} />
                        </div>
                      )}
                      <div className="snap-after">
                        {r.action === "update" && <span className="snap-tag">訂正後</span>}
                        {r.action === "delete" && <span className="snap-tag">削除した内容</span>}
                        <SnapshotTable snap={r.snapshot} compare={r.action === "update" ? prevOf(r)?.snapshot : undefined} />
                      </div>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ShowMore total={shown.length} limit={page.limit} onMore={page.more} />
        </div>
      </section>

      </>}

      {editing && <EntryEditModal entryId={editing} onClose={() => setEditing(null)} />}
      {checking && <IntegrityModal onClose={() => setChecking(false)} />}
    </div>
  );
};

// ────────────────────────────────────────────
// 勘定科目・補助科目・期首残高の変更履歴
// ────────────────────────────────────────────
const TARGET_LABEL: Record<MasterHistoryRecord["target_type"], string> = { account: "勘定科目", sub: "補助科目", opening: "期首残高", homeuse: "家事按分", closing: "年度の締め", counterparty: "取引先", user: "ユーザー", setting: "設定", asset: "固定資産" };
const MASTER_ACTION: Record<MasterHistoryRecord["action"], string> = {
  create: "追加", rename: "名前変更", hide: "非表示", show: "再表示", delete: "削除", change: "変更", close: "締め", unlock: "締めの解除",
};

interface PagedProps<T> {
  records: T[];
  limit: number;
  onMore: () => void;
}

const MasterHistoryTable = ({ records, limit, onMore }: PagedProps<MasterHistoryRecord>) => {
  const detail = (r: MasterHistoryRecord) => {
    // 締め：月の締めに対応してからは「○月まで締め → △月まで締めに戻す（理由：…）」。それより前の記録は理由だけ
    if (r.target_type === "closing") return r.old_value ? `${r.old_value} → ${r.new_value}` : r.action === "unlock" ? `理由：${r.new_value}` : r.new_value;
    if (r.target_type === "opening") return `${yen(Number(r.old_value))} → ${yen(Number(r.new_value))}`;
    if (r.action === "rename" || r.action === "change") return `${r.old_value} → ${r.new_value}`;
    if (r.action === "create") return r.new_value;
    return "";
  };
  return (
    <section className="sheet sheet-fill">
      <div className="table-wrap scroll-y">
        {records.length === 0 ? (
          <p className="empty-note">まだ変更はありません。</p>
        ) : (
          <table className="ledger">
            <colgroup>
              <col style={{ width: 170 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: "22%" }} />
              <col />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr><th>記録日時</th><th>年度</th><th>対象</th><th>操作</th><th>名称</th><th>内容</th><th>操作者</th></tr>
            </thead>
            <tbody>
              {records.slice(0, limit).map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.recorded_at}</td>
                  <td>{r.fiscal_year}</td>
                  <td>{TARGET_LABEL[r.target_type]}</td>
                  <td><span className={`badge badge-${r.action === "delete" || r.action === "hide" || r.action === "unlock" ? "delete" : r.action === "create" || r.action === "show" || r.action === "close" ? "create" : "update"}`}>{MASTER_ACTION[r.action]}</span></td>
                  <td>{r.label}</td>
                  <td>{detail(r)}</td>
                  <td>{r.user_name ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ShowMore total={records.length} limit={limit} onMore={onMore} />
      </div>
    </section>
  );
};

// ────────────────────────────────────────────
// 証憑の履歴
// ────────────────────────────────────────────
const EvidenceHistoryTable = ({ records, limit, onMore }: PagedProps<EvidenceHistoryRecord>) => (
  <section className="sheet sheet-fill">
    <div className="table-wrap scroll-y">
      {records.length === 0 ? (
        <p className="empty-note">まだ記録はありません。</p>
      ) : (
        <table className="ledger">
          <colgroup>
            <col style={{ width: 170 }} /><col style={{ width: 70 }} /><col style={{ width: 110 }} /><col style={{ width: 104 }} />
            <col /><col style={{ width: 110 }} /><col style={{ width: 90 }} /><col style={{ width: "18%" }} /><col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr><th>記録日時</th><th>証憑No</th><th>操作</th><th>取引年月日</th><th>取引先</th><th className="num">金額</th><th>伝票No</th><th>理由・内容</th><th>操作者</th></tr>
          </thead>
          <tbody>
            {records.slice(0, limit).map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.recorded_at}</td>
                <td>{r.evidence_id}</td>
                <td><span className={`badge badge-${evidenceActionBadge(r.action)}`}>{EVIDENCE_ACTION_LABEL[r.action]}</span></td>
                <td>{r.snapshot.txn_date.replace(/-/g, "/")}</td>
                <td>{r.snapshot.counterparty}</td>
                <td className="num">{yen(r.snapshot.amount)}</td>
                <td>{r.snapshot.entry_ids.join("・")}</td>
                <td>{r.reason}</td>
                <td>{r.user_name ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ShowMore total={records.length} limit={limit} onMore={onMore} />
    </div>
  </section>
);

// ────────────────────────────────────────────
// 利用の記録（ログイン・ログアウト）
// ────────────────────────────────────────────
const AccessLogTable = ({ records, limit, onMore }: PagedProps<AccessLogRecord>) => {
  const ends = loginEnds(records);
  return (
  <section className="sheet sheet-fill">
    <div className="table-wrap scroll-y">
      {records.length === 0 ? (
        <p className="empty-note">まだ記録はありません。</p>
      ) : (
        <table className="ledger">
          <colgroup><col style={{ width: 190 }} /><col style={{ width: 120 }} /><col style={{ width: 200 }} /><col /></colgroup>
          <thead><tr><th>記録日時</th><th>操作</th><th>ユーザー</th><th>備考</th></tr></thead>
          <tbody>
            {records.slice(0, limit).map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.recorded_at}</td>
                <td><span className={`badge badge-${r.action === "login" ? "create" : "update"}`}>{r.action === "login" ? "ログイン" : "ログアウト"}</span></td>
                <td>{r.user_name}</td>
                <td className={ends.get(r.id) === "missing" ? "warn-text" : "muted"}>{LOGIN_END_LABEL[ends.get(r.id) ?? "logout"]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ShowMore total={records.length} limit={limit} onMore={onMore} />
    </div>
  </section>
  );
};
