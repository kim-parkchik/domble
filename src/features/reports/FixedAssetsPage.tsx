/**
 * 固定資産台帳・減価償却
 *  - 資産ごとに取得価額・償却方法・耐用年数・事業専用割合を持ち、年度ごとの償却費を計算する（lib/depreciation.ts）
 *  - 年末に「減価償却費（事業分）＋事業主貸（家事分） / 資産の科目」の決算整理仕訳を1本作る。作り直すと同じ仕訳を訂正する
 *  - 帳簿の資産の科目の残高と、台帳の未償却残高を並べて、ずれていないか確かめられる
 *  - 事業専用割合は「表示中の年から」の割合として変える（前の年はそのまま）
 *  - 年の締めをした年に使っている資産は、売却・除却の日と、締めていない年からの事業専用割合だけ変えられる（削除もできない）
 *  - 売却・除却した資産は、台帳の区分と売却額から売却・除却の仕訳を作る（lib/depreciation.ts の disposalLines）
 * 資産を買った仕訳（工具器具備品 / 普通預金 など）は、振替伝票でふつうに入れる
 * 台帳（その年に償却する資産）は印刷と CSV の書き出しができる
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Pencil, Plus, Printer, Trash2, Wand2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { PrintPreview } from "../../components/PrintPreview";
import { exportCsvFile } from "../../components/csvExport";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { EntryEditModal } from "../entry/EntryEditModal";
import { closingBalances } from "../../lib/accounting";
import { todayIso, yen } from "../../lib/format";
import { ASSET_CSV_HEADER, assetCsvRows, assetSection, type AssetPrintLine } from "../../lib/printBooks";
import { ownerText, periodText, type PrintDoc } from "../../lib/printLayout";
import { CODE, FIXED_ASSET_CODES } from "../../constants/accounts";
import { ASSET_LIVES } from "../../constants/assetLives";
import {
  businessRateIn, closedYearsOf, depreciationFor, depreciationLines, DISPOSAL_LABEL, disposalLines, EXPENSE_LIMIT, usedAssetLife, LUMP3_LIMIT, METHOD_LABEL, methodLabel, OLD_STRAIGHT_UNTIL, SMALL_YEAR_LIMIT, smallLimitFor, smallTotalOfYear,
  validateAsset,
  type DepreciationMethod, type DisposalKind, type FixedAsset,
} from "../../lib/depreciation";
import type { IncomeKind } from "../../lib/types";
import * as repo from "../../db/repo";
import { isExclusiveOn } from "../../lib/taxExclusive";
import { isBlue } from "../../lib/filing";
import { closedMonthOf } from "../../lib/closing";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const ymd = (iso: string) => iso.replace(/-/g, "/");

export const FixedAssetsPage = () => {
  const { db, year, accounts, settings, bump, dataVersion, isClosed, can, strict, closings, taxYears } = useAppContext();
  const { lines, opening } = useYearData();
  // 年の締めをした年（その年に使っている資産は守る）
  const closedYears = closings.filter((c) => closedMonthOf(c) === 12).map((c) => c.fiscal_year);
  const toast = useToast();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [runLines, setRunLines] = useState<string | null>(null);
  // 台帳から作った売却・除却の仕訳（資産ごと）と、その明細
  const [disposals, setDisposals] = useState<{ asset_id: number; entry_id: number; receive_account_id: number | null; lines: string }[]>([]);
  const [receiveId, setReceiveId] = useState<number | null>(null);
  const [editing, setEditing] = useState<FixedAsset | "new" | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    repo.getAssets(db).then(setAssets).catch(console.error);
    repo.getAssetDisposals(db)
      .then(async (ds) => setDisposals(await Promise.all(ds.map(async (d) => ({ ...d, lines: lineKey((await repo.getEntry(db, d.entry_id))?.lines ?? []) })))))
      .catch(console.error);
    repo.getDepreciationRun(db, year)
      .then(async (id) => {
        setRunId(id);
        const e = id ? await repo.getEntry(db, id) : null;
        setRunLines(e ? lineKey(e.lines) : null);
      })
      .catch(console.error);
  }, [db, year, dataVersion]);

  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "（科目なし）";
  const ids = {
    expense: accounts.find((a) => a.code === CODE.DEPRECIATION)?.id ?? 0,
    draw: accounts.find((a) => a.code === CODE.OWNER_DRAW)?.id ?? 0,
    // 不動産所得の資産は減価償却費（不動産）
    expenseRealEstate: accounts.find((a) => a.code === CODE.RE_DEPRECIATION)?.id ?? 0,
  };

  // この年度に償却する（台帳に出す）資産と、それ以外
  const rows = assets.map((a) => ({ a, d: depreciationFor(a, year) }));
  const active = rows.filter((r) => r.d && !(r.d.opening === 0 && r.d.depreciation === 0));
  const others = rows.filter((r) => !active.includes(r));
  const sum = (k: "opening" | "depreciation" | "business" | "closing") => active.reduce((s, r) => s + (r.d ? r.d[k] : 0), 0);

  // 印刷・CSV の行（画面の台帳と同じ資産）
  const printLines: AssetPrintLine[] = active.map(({ a, d }) => ({
    name: a.name, account: accountName(a.account_id), acquired: a.acquired_on, used: a.used_on, cost: a.cost, method: methodLabel(a),
    life: a.method === "straight" || a.method === "declining" ? `${a.useful_life}年` : a.method === "lump3" ? "3年" : "—", rate: d!.rate !== null ? d!.rate.toFixed(3) : "—",
    months: d!.months, opening: d!.opening, depreciation: d!.depreciation, businessRate: d!.businessRate, business: d!.business, closing: d!.closing,
    memo: [d!.disposed ? `${ymd(a.disposed_on!)} 売却・除却` : "", a.memo].filter(Boolean).join("　"),
  }));
  const printDoc = useMemo((): PrintDoc | null => printing
    ? {
      title: "固定資産台帳", owner: ownerText(settings.business_name, settings.owner_name),
      period: periodText(`${year}-01-01`, `${year}-12-31`), printedOn: todayIso(), sections: [assetSection(`${year}年の減価償却`, printLines)],
    }
    : null, [printing, assets, accounts, year, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportCsv = () => exportCsvFile(`固定資産台帳_${settings.business_name || "帳簿"}_${year}.csv`, ASSET_CSV_HEADER, assetCsvRows(printLines), toast);

  const planned = useMemo(() => depreciationLines(assets, year, ids), [assets, year, ids.expense, ids.draw, ids.expenseRealEstate]); // eslint-disable-line react-hooks/exhaustive-deps
  const outdated = runId !== null && runLines !== lineKey(planned);
  const smallTotal = smallTotalOfYear(assets, year);

  // 帳簿の残高との照合（資産の科目ごと。その年に売却・除却したものは、仕訳で帳簿から外している前提で数えない）
  const balances = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const ledgerByAccount = new Map<number, number>();
  for (const r of active) if (r.d && !r.d.disposed) ledgerByAccount.set(r.a.account_id, (ledgerByAccount.get(r.a.account_id) ?? 0) + r.d.closing);
  const checkAccounts = accounts.filter((a) => ledgerByAccount.has(a.id) || ((FIXED_ASSET_CODES.includes(a.code) || a.code === CODE.ORGANIZATION_COST) && (balances.get(a.id) ?? 0) !== 0));

  const run = async () => {
    const total = planned.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
    const ok = await ask(
      planned.length === 0
        ? `${year}年に償却する資産がないので、作成済みの減価償却の仕訳を削除します。`
        : `${year}年12月31日付で、減価償却費 ${yen(total)} 円（家事分は事業主貸）の決算整理仕訳を${runId ? "作り直します" : "作ります"}。`,
      { title: "減価償却の仕訳", okLabel: runId ? "作り直す" : "作成する", cancelLabel: "やめる" },
    );
    if (!ok) return;
    try {
      await repo.saveDepreciationRun(db, year, planned);
      bump();
      toast(planned.length === 0 ? "減価償却の仕訳を削除しました" : "減価償却の仕訳を作成しました");
    } catch (e) {
      toast(`作成できませんでした：${errText(e)}`, "error");
    }
  };

  // 売却・除却の仕訳（この年に売却・除却した資産）
  const bankId = accounts.find((a) => a.code === CODE.BANK)?.id ?? null;
  const receiveChoices = accounts.filter((a) => a.category === "asset" && a.is_active && !FIXED_ASSET_CODES.includes(a.code));
  const disposalIds = (receive: number | null) => ({
    receive: receive ?? 0, ownerLoan: accounts.find((a) => a.code === CODE.OWNER_LOAN)?.id ?? 0, ownerDraw: ids.draw,
    loss: accounts.find((a) => a.code === CODE.DISPOSAL_LOSS)?.id ?? 0,
  });
  const disposedThisYear = assets.filter((a) => a.disposed_on && Number(a.disposed_on.slice(0, 4)) === year);
  const makeDisposal = async (a: FixedAsset) => {
    const made = disposals.find((d) => d.asset_id === a.id);
    const receive = a.disposal_kind === "sale" ? receiveId ?? made?.receive_account_id ?? bankId : null;
    try {
      const id = await repo.saveDisposalEntry(db, a.id, receive);
      bump();
      toast(id ? `売却・除却の仕訳（No.${id}）を${made ? "作り直しました" : "作りました"}` : "金額が無いので、仕訳は作りませんでした");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const remove = async (a: FixedAsset) => {
    if (!(await ask(`「${a.name}」を台帳から削除します。売ったり捨てたりしたときは、削除せずに「売却・除却した日」を入れてください。`, { title: "固定資産の削除", okLabel: "削除する", cancelLabel: "やめる" }))) return;
    try {
      await repo.deleteAsset(db, a.id);
      bump();
      toast("削除しました");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const editButtons = (a: FixedAsset) => {
    const locked = closedYearsOf(a, closedYears);
    return (
      <span className="row-actions">
        <button className="link-btn" onClick={() => setEditing(a)} aria-label={`${a.name}を編集`}><Pencil size={13} /> 編集</button>
        <button
          className="link-btn danger" onClick={() => remove(a)} disabled={!can("master") || locked.length > 0} aria-label={`${a.name}を削除`}
          title={locked.length ? `締め済みの年（${locked.map((y) => `${y}年`).join("・")}）に使っている資産は削除できません` : undefined}
        >
          <Trash2 size={13} />
        </button>
      </span>
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="固定資産台帳"
        note={`10万円以上の備品・車・建物などを登録すると、${year}年の減価償却費を計算します。資産を買った仕訳は振替伝票で入れてください。${strict ? "台帳の変更は履歴に記録されます。" : ""}${isExclusiveOn(taxYears, `${year}-12-31`) ? `${year}年は税抜経理なので、その年に取得した資産の取得価額は税抜で入れてください（少額減価償却資産・一括償却資産の判定も税抜の額です）。` : ""}`}
      >
        <button className="btn ghost" onClick={exportCsv} disabled={active.length === 0}><Download size={16} /> CSV 書き出し</button>
        <button className="btn ghost" onClick={() => setPrinting(true)}><Printer size={16} /> 印刷</button>
        <button className="btn primary" onClick={() => setEditing("new")} disabled={!can("master")}><Plus size={16} /> 資産を追加</button>
      </PageHeader>

      <section className="sheet">
        <h2 className="sheet-h">{year}年の減価償却</h2>
        {active.length === 0 ? (
          <p className="muted">{year}年に償却する資産はありません。「資産を追加」から登録してください。</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger asset-table">
              <thead>
                <tr>
                  <th>名称</th><th>科目</th><th>使用開始</th><th className="num">取得価額</th><th>償却方法</th><th className="num">耐用年数</th>
                  <th className="num">償却率</th><th className="num">月数</th><th className="num">期首の<br />未償却残高</th><th className="num">本年分の<br />償却費</th>
                  <th className="num">事業専用<br />割合</th><th className="num">必要経費に<br />入れる額</th><th className="num">期末の<br />未償却残高</th><th />
                </tr>
              </thead>
              <tbody>
                {active.map(({ a, d }) => (
                  <tr key={a.id}>
                    <td>
                      {a.name}
                      {d!.disposed && <span className="hint">{ymd(a.disposed_on!)} 売却・除却</span>}
                      {a.memo && <span className="hint">{a.memo}</span>}
                    </td>
                    <td>{accountName(a.account_id)}</td>
                    <td>{ymd(a.used_on)}</td>
                    <td className="num">{yen(a.cost)}</td>
                    <td>{methodLabel(a)}</td>
                    <td className="num">{a.method === "straight" || a.method === "declining" ? `${a.useful_life}年` : a.method === "lump3" ? "3年" : "—"}</td>
                    <td className="num">{d!.rate !== null ? d!.rate.toFixed(3) : "—"}</td>
                    <td className="num">{d!.months}</td>
                    <td className="num">{yen(d!.opening)}</td>
                    <td className="num">{yen(d!.depreciation)}</td>
                    <td className="num">{d!.businessRate}%</td>
                    <td className="num">{yen(d!.business)}</td>
                    <td className="num">{yen(d!.closing)}</td>
                    <td>{editButtons(a)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={8} className="total-label">合計</td>
                  <td className="num">{yen(sum("opening"))}</td>
                  <td className="num">{yen(sum("depreciation"))}</td>
                  <td />
                  <td className="num">{yen(sum("business"))}</td>
                  <td className="num">{yen(sum("closing"))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {smallTotal > SMALL_YEAR_LIMIT && (
          <p className="notice">
            {year}年に使い始めた少額減価償却資産の合計が {yen(smallTotal)} 円です。この特例で全額を経費にできるのは、1年で合計 {yen(SMALL_YEAR_LIMIT)} 円までです。
          </p>
        )}
        {others.length > 0 && (
          <details className="asset-others">
            <summary>ほかの資産（{others.length}件：{year}年より後に使い始める・償却が終わった・売却や除却が済んだもの）</summary>
            <table className="ledger">
              <tbody>
                {others.map(({ a }) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{accountName(a.account_id)}</td>
                    <td>{ymd(a.used_on)} 使用開始</td>
                    <td className="num">{yen(a.cost)}</td>
                    <td>{methodLabel(a)}</td>
                    <td>{a.disposed_on ? `${ymd(a.disposed_on)} 売却・除却` : ""}</td>
                    <td>{editButtons(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="sheet">
        <div className="sheet-title">
          <h2 className="sheet-h" style={{ margin: 0 }}>年末の減価償却の仕訳（{year}年）</h2>
          {runId && <button className="link-btn" onClick={() => setViewing(runId)}>作成済みの仕訳（No.{runId}）を見る</button>}
        </div>
        <p className="field-note">
          12月31日付の決算整理仕訳を1本作ります。資産ごとに「減価償却費（事業分） ／ 資産の科目（償却費の全額）」、家事分は「事業主貸」にします。
          台帳を直したら「作り直す」を押すと、同じ仕訳が最新の金額に訂正されます。減価償却費を振替伝票で別に入れている場合は、二重にならないよう気をつけてください。
        </p>
        {outdated && <p className="notice">作成済みの仕訳と、いまの台帳の計算が違います。「作り直す」を押してください。</p>}
        <div className="voucher-actions" style={{ marginTop: 8 }}>
          <span className="muted">
            {planned.length > 0 ? `減価償却費 ${yen(sum("business"))} 円・事業主貸 ${yen(sum("depreciation") - sum("business"))} 円` : "仕訳にする償却費はありません"}
          </span>
          <div className="spacer" />
          <button className="btn primary" onClick={run} disabled={isClosed || !can("entry") || (planned.length === 0 && !runId)}>
            <Wand2 size={16} /> {runId ? "仕訳を作り直す" : "仕訳を作成する"}
          </button>
        </div>
      </section>

      {disposedThisYear.length > 0 && (
        <section className="sheet">
          <h2 className="sheet-h">売却・除却の仕訳（{year}年）</h2>
          <p className="field-note">
            売却・除却した日付で仕訳を1本作ります。売却は売却額を課税売上（簡易課税は第4種。家事と兼用する資産は事業用の部分だけ）にし、帳簿価額（その年の期末の未償却残高）との差は事業主貸・事業主借にします
            （個人の事業用資産の売却損益は、事業所得ではなく譲渡所得のため）。除却は帳簿価額を固定資産除却損（家事分は事業主貸）にします。その年の減価償却費は、年末の減価償却の仕訳で売却・除却した月まで計算します。
          </p>
          {disposedThisYear.some((a) => a.disposal_kind === "sale") && (
            <label className="field" style={{ maxWidth: 280 }}>
              <span>売却額を受け取った科目</span>
              <select className="input" value={receiveId ?? bankId ?? ""} onChange={(e) => setReceiveId(Number(e.target.value) || null)}>
                {receiveChoices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <table className="ledger">
            <thead>
              <tr><th>名称</th><th>日付</th><th>区分</th><th className="num">売却額</th><th className="num">帳簿価額</th><th>仕訳</th><th /></tr>
            </thead>
            <tbody>
              {disposedThisYear.map((a) => {
                const made = disposals.find((d) => d.asset_id === a.id);
                const planned = disposalLines(a, disposalIds(a.disposal_kind === "sale" ? receiveId ?? made?.receive_account_id ?? bankId : null), !!a.disposed_on && isExclusiveOn(taxYears, a.disposed_on));
                const book = depreciationFor(a, year)?.closing ?? 0;
                const state = a.method !== "straight" && a.method !== "declining" ? "定額法・定率法の資産だけ作れます（振替伝票で入れてください）"
                  : !a.disposal_kind ? "台帳の「編集」で、売却か除却かを選んでください"
                    : !made ? "未作成"
                      : planned && made.lines !== lineKey(planned) ? `作成済み（No.${made.entry_id}）：台帳の計算と違います。作り直してください`
                        : `作成済み（No.${made.entry_id}）`;
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{ymd(a.disposed_on!)}</td>
                    <td>{a.disposal_kind ? DISPOSAL_LABEL[a.disposal_kind] : "—"}</td>
                    <td className="num">{a.disposal_kind === "sale" ? yen(a.sale_price ?? 0) : ""}</td>
                    <td className="num">{a.method === "straight" || a.method === "declining" ? yen(book) : ""}</td>
                    <td>
                      {made ? <button className="link-btn" onClick={() => setViewing(made.entry_id)}>{state}</button> : <span className={state === "未作成" ? "" : "muted"}>{state}</span>}
                    </td>
                    <td className="row-actions">
                      <button className="btn ghost sm" onClick={() => makeDisposal(a)} disabled={!can("entry") || (a.method !== "straight" && a.method !== "declining") || !a.disposal_kind}>
                        <Wand2 size={14} /> {made ? "作り直す" : "仕訳を作る"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {checkAccounts.length > 0 && (
        <section className="sheet">
          <h2 className="sheet-h">帳簿の残高との照合（{year}年12月31日）</h2>
          <table className="ledger">
            <thead>
              <tr><th>科目</th><th className="num">帳簿の残高</th><th className="num">台帳の未償却残高</th><th className="num">差額</th></tr>
            </thead>
            <tbody>
              {checkAccounts.map((acc) => {
                const book = balances.get(acc.id) ?? 0;
                const ledger = ledgerByAccount.get(acc.id) ?? 0;
                return (
                  <tr key={acc.id}>
                    <td>{acc.name}</td>
                    <td className="num">{yen(book)}</td>
                    <td className="num">{yen(ledger)}</td>
                    <td className={`num${book !== ledger ? " balance-ng" : ""}`}>{book === ledger ? "一致" : yen(book - ledger)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="field-note">
            差額があるときは、減価償却の仕訳を作ったか、資産を買った仕訳・売却や除却の仕訳・期首残高が台帳と合っているかを確かめてください。
          </p>
        </section>
      )}

      {editing && (
        <AssetModal
          asset={editing === "new" ? null : editing} closedYears={closedYears} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); bump(); }}
        />
      )}
      {viewing && <EntryEditModal entryId={viewing} onClose={() => setViewing(null)} />}
      {printing && <PrintPreview doc={printDoc} onClose={() => setPrinting(false)} />}
    </div>
  );
};

/** 仕訳の明細を比べるための文字列（作成済みの仕訳が台帳の計算と同じか） */
const lineKey = (ls: { side: string; account_id: number; amount: number; memo: string }[]) =>
  ls.map((l) => `${l.side}:${l.account_id}:${l.amount}:${l.memo}`).sort().join("|");


const AssetModal = ({ asset, closedYears, onClose, onSaved }: { asset: FixedAsset | null; closedYears: number[]; onClose: () => void; onSaved: () => void }) => {
  const { db, year, accounts, can, filingTypeOf, settings } = useAppContext();
  const toast = useToast();
  // 資産の科目：固定資産の初期科目・開業費（繰延資産）・足した資産の科目
  const choices = accounts.filter((a) => a.category === "asset" && (FIXED_ASSET_CODES.includes(a.code) || a.code === CODE.ORGANIZATION_COST || !a.is_system));
  const lumpId = accounts.find((a) => a.code === CODE.LUMP_ASSET)?.id;
  const deferredId = accounts.find((a) => a.code === CODE.ORGANIZATION_COST)?.id;
  const equipmentId = accounts.find((a) => a.code === "134")?.id ?? null;
  const [name, setName] = useState(asset?.name ?? "");
  const [accountId, setAccountId] = useState<number | null>(asset?.account_id ?? accounts.find((a) => a.code === "134")?.id ?? null);
  const [acquired, setAcquired] = useState(asset?.acquired_on ?? "");
  const [used, setUsed] = useState(asset?.used_on ?? "");
  const [cost, setCost] = useState<number | null>(asset?.cost ?? null);
  const [method, setMethod] = useState<DepreciationMethod>(asset?.method ?? "straight");
  const [life, setLife] = useState(asset && (asset.method === "straight" || asset.method === "declining") ? String(asset.useful_life) : "");
  // 中古資産の耐用年数（簡便法）の計算
  const [usedAsset, setUsedAsset] = useState(false);
  const [legalLife, setLegalLife] = useState("");
  const [elapsed, setElapsed] = useState({ years: "", months: "" });
  // 繰延資産：表示中の年に償却する額（空なら60か月の均等償却）
  const [amortize, setAmortize] = useState<number | null>(asset?.amortization?.[year] ?? null);
  // 事業専用割合は表示中の年の割合（使い始めた年より後なら、変えると表示中の年からの割合になる）
  const [rate, setRate] = useState(String(asset ? businessRateIn(asset, year) : 100));
  const fromYear = asset !== null && year > Number(asset.used_on.slice(0, 4));
  // 年の締めをした年に使っている資産：売却・除却の日と、締めていない年からの割合だけ変えられる
  const locked = asset ? closedYearsOf(asset, closedYears) : [];
  const rateLocked = locked.length > 0 && (!fromYear || closedYears.includes(year));
  const [hasOpening, setHasOpening] = useState(asset?.opening_year != null);
  const [openingYear, setOpeningYear] = useState(String(asset?.opening_year ?? year));
  const [openingValue, setOpeningValue] = useState<number | null>(asset?.opening_book_value ?? null);
  const [disposed, setDisposed] = useState(asset?.disposed_on ?? "");
  const [disposalKind, setDisposalKind] = useState<DisposalKind>(asset?.disposal_kind ?? "sale");
  const [salePrice, setSalePrice] = useState<number | null>(asset?.sale_price ?? null);
  const [memo, setMemo] = useState(asset?.memo ?? "");
  const [kind, setKind] = useState<IncomeKind>(asset?.income_kind ?? "business");
  // 不動産所得があるとき（または不動産所得の資産のとき）だけ、所得の区分を選ぶ
  const showKind = (settings.real_estate ?? "none") !== "none" || kind === "realestate";
  const [error, setError] = useState("");

  const changeMethod = (m: DepreciationMethod) => {
    setMethod(m);
    if (m === "lump3" && lumpId) setAccountId(lumpId);
    else if (m === "deferred" && deferredId) setAccountId(deferredId);
    else if (accountId === lumpId || accountId === deferredId) setAccountId(equipmentId);
  };
  /** 耐用年数表から選んだら、耐用年数と科目を入れる */
  const pickLife = (i: number) => {
    const x = ASSET_LIVES[i];
    if (!x) return;
    setLife(String(x.life));
    setLegalLife(String(x.life));
    const acc = accounts.find((a) => a.code === x.code);
    if (acc && method !== "lump3" && method !== "deferred") setAccountId(acc.id);
  };
  const usedLife = usedAsset && Number(legalLife) >= 2 ? usedAssetLife(Number(legalLife), (Number(elapsed.years) || 0) * 12 + (Number(elapsed.months) || 0)) : null;
  useEffect(() => {
    if (usedLife !== null) setLife(String(usedLife));
  }, [usedLife]);

  // 少額減価償却資産の特例は、事業に使い始めた年が青色申告の年だけ
  const useYear = Number((used || acquired || String(year)).slice(0, 4)) || year;
  const blue = isBlue(filingTypeOf(useYear));

  const input = (): repo.AssetInput => ({
    name, account_id: accountId ?? 0, acquired_on: acquired, used_on: used || acquired, cost: cost ?? 0, method,
    useful_life: Number(life) || 0, business_rate: Number(rate), opening_year: hasOpening ? Number(openingYear) || 0 : null,
    opening_book_value: hasOpening ? openingValue ?? null : null, disposed_on: disposed || null, memo, income_kind: kind,
    disposal_kind: disposed ? disposalKind : null, sale_price: disposed && disposalKind === "sale" ? salePrice : null,
    amortization: method === "deferred" ? (amortize !== null ? { [year]: amortize } : {}) : undefined,
  });
  // 繰延資産：表示中の年の、決めていないときの償却額（60か月の均等償却）
  const evenAmount = method === "deferred" && cost && (used || acquired) ? depreciationFor({ ...input(), id: 0, amortization: undefined }, year)?.depreciation ?? null : null;

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
    const a = input();
    const e = validateAsset(a, { blue, accountCode: accounts.find((x) => x.id === a.account_id)?.code });
    if (e) return setError(e);
    try {
      await repo.saveAsset(db, asset?.id ?? null, a, year);
      toast(asset ? "固定資産を更新しました" : "固定資産を追加しました");
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <Modal title={asset ? "固定資産の編集" : "固定資産の追加"} onClose={onClose} width={620}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {locked.length > 0 && (
          <p className="notice">
            {locked.map((y) => `${y}年`).join("・")}は締め済みのため、この資産は売却・除却した日{rateLocked ? "" : `と、${year}年からの事業専用割合`}だけ変えられます。
            ほかを直すときは、事業者設定で締めを戻してください。
          </p>
        )}
        <fieldset className="plain-fieldset" disabled={locked.length > 0}>
          <label className="field">
            <span>名称</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="例：ノートパソコン、営業車" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>償却方法</span>
              <select className="input" value={method} onChange={(e) => changeMethod(e.target.value as DepreciationMethod)}>
                <option value="straight">{METHOD_LABEL.straight}</option>
                <option value="declining">{METHOD_LABEL.declining}（届出をした人）</option>
                <option value="lump3">{METHOD_LABEL.lump3}（{yen(EXPENSE_LIMIT)}〜{yen(LUMP3_LIMIT)}円未満）</option>
                <option value="small" disabled={!blue}>{METHOD_LABEL.small}（{smallLimitFor(acquired) ? `${yen(smallLimitFor(acquired)!)}円未満` : "令和11年3月までの取得"}・青色申告）</option>
                <option value="deferred">{METHOD_LABEL.deferred}（開業費など）</option>
              </select>
            </label>
            <label className="field">
              <span>科目</span>
              <select className="input" value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value) || null)}>
                {choices.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>取得日</span>
              <FullDateInput value={acquired} onChange={setAcquired} year={year} aria-label="取得日" onValidity={markDate("acquired")} />
            </label>
            <label className="field">
              <span>事業に使い始めた日（空なら取得日）</span>
              <FullDateInput value={used} onChange={setUsed} year={year} aria-label="事業に使い始めた日" onValidity={markDate("used")} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>取得価額（円）</span>
              <AmountInput value={cost} onChange={setCost} aria-label="取得価額" />
            </label>
            {method === "straight" || method === "declining" ? (
              <label className="field">
                <span>耐用年数（年）</span>
                <input className="input" inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="耐用年数" disabled={usedLife !== null} />
              </label>
            ) : <div className="field" />}
          </div>
          {(method === "straight" || method === "declining") && (
            <div className="field-row wrap">
              <label className="field">
                <span>耐用年数表から選ぶ（主なもの）</span>
                <select className="input" value="" onChange={(e) => pickLife(Number(e.target.value))} aria-label="耐用年数表から選ぶ">
                  <option value="">選ぶと耐用年数と科目が入ります</option>
                  {[...new Set(ASSET_LIVES.map((x) => x.group))].map((g) => (
                    <optgroup key={g} label={g}>
                      {ASSET_LIVES.map((x, i) => (x.group === g ? <option key={i} value={i}>{x.label}（{x.life}年）</option> : null))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="check" style={{ alignSelf: "flex-end" }}>
                <input type="checkbox" checked={usedAsset} onChange={(e) => setUsedAsset(e.target.checked)} /> 中古で買った資産（簡便法で耐用年数を出す）
              </label>
            </div>
          )}
          {usedAsset && (method === "straight" || method === "declining") && (
            <div className="field-row wrap">
              <label className="field" style={{ maxWidth: 140 }}>
                <span>法定耐用年数（年）</span>
                <input className="input" inputMode="numeric" value={legalLife} onChange={(e) => setLegalLife(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="法定耐用年数" />
              </label>
              <label className="field" style={{ maxWidth: 220 }}>
                <span>買ったときまでに経過した年数</span>
                <div className="field-row">
                  <input className="input" inputMode="numeric" value={elapsed.years} onChange={(e) => setElapsed((x) => ({ ...x, years: e.target.value.replace(/\D/g, "").slice(0, 3) }))} aria-label="経過年数" placeholder="年" />
                  <input className="input" inputMode="numeric" value={elapsed.months} onChange={(e) => setElapsed((x) => ({ ...x, months: e.target.value.replace(/\D/g, "").slice(0, 2) }))} aria-label="経過月数" placeholder="か月" />
                </div>
              </label>
              <p className="field-note" style={{ alignSelf: "flex-end" }}>
                {usedLife !== null ? `簡便法の耐用年数：${usedLife}年` : "法定耐用年数を入れてください"}
                （（法定 − 経過）＋ 経過 × 20%。全部を経過したものは 法定 × 20%。1年未満切り捨て、2年未満は2年）
              </p>
            </div>
          )}
          {method === "deferred" && (
            <label className="field" style={{ maxWidth: 360 }}>
              <span>{year}年に償却する額（空なら60か月の均等償却{evenAmount !== null ? `：${yen(evenAmount)}円` : ""}）</span>
              <AmountInput value={amortize} onChange={setAmortize} aria-label="償却する額" />
            </label>
          )}
          {showKind && (
            <div className="field-row wrap">
              <label className="check"><input type="radio" name="asset-kind" checked={kind === "business"} onChange={() => setKind("business")} /> 事業所得の資産</label>
              <label className="check"><input type="radio" name="asset-kind" checked={kind === "realestate"} onChange={() => setKind("realestate")} /> 不動産所得の資産（貸家・アパートなど。減価償却費（不動産）にし、不動産所得用の決算書に出します）</label>
            </div>
          )}
          {(method === "straight" || method === "declining") && <p className="field-note">耐用年数は国税庁の耐用年数表で確かめてください（表に無いもの・運送事業用などは手で入れます）。</p>}
          {method === "declining" && (
            <p className="field-note">
              定率法は、所得税の減価償却資産の償却方法の届出書を出した人だけが使えます（出していなければ定額法）。平成24年4月1日以後に取得した資産を200%定率法で計算します
              （期首の未償却残高 × 償却率。償却保証額に満たなくなった年から、改定取得価額 × 改定償却率）。建物・ソフトウェアなどは定額法です。
            </p>
          )}
          {method === "deferred" && (
            <p className="field-note">開業費などの繰延資産は、好きな年に好きな額を償却できます（任意償却）。決めていない年は60か月で均等に償却します（月割り）。0円まで償却します。</p>
          )}
          {method === "straight" && acquired && acquired <= OLD_STRAIGHT_UNTIL && (
            <p className="field-note">
              平成19年3月31日以前に取得した資産なので、旧定額法で計算します（取得価額 × 90% × 旧定額法の償却率。償却費の累計が取得価額の95%に達したら、その翌年から5年間で1円まで均等に償却します）。
            </p>
          )}
          {method === "lump3" && <p className="field-note">取得価額の 1/3 ずつを3年で経費にします（月割りしません）。</p>}
          {method === "small" && <p className="field-note">使い始めた年に全額を経費にします（1年の合計 {yen(SMALL_YEAR_LIMIT)} 円まで）。</p>}
          {cost !== null && cost > 0 && cost < EXPENSE_LIMIT && <p className="field-note">{yen(EXPENSE_LIMIT)} 円未満のものは、台帳に入れずに消耗品費などで経費にできます。</p>}

          <label className="check">
            <input type="checkbox" checked={hasOpening} onChange={(e) => setHasOpening(e.target.checked)} />
            domble を使う前から持っている資産（期首の未償却残高から計算する）
          </label>
          {hasOpening && (
            <div className="field-row">
              <label className="field">
                <span>年</span>
                <input className="input" inputMode="numeric" value={openingYear} onChange={(e) => setOpeningYear(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label="期首の未償却残高の年" />
              </label>
              <label className="field">
                <span>その年の1月1日の未償却残高（円）</span>
                <AmountInput value={openingValue} onChange={setOpeningValue} aria-label="期首の未償却残高" />
              </label>
            </div>
          )}
          <label className="field">
            <span>備考（任意）</span>
            <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={100} placeholder="例：型番、購入先" />
          </label>
        </fieldset>

        <div className="field-row">
          <label className="field">
            <span>{kind === "realestate" ? "貸付割合" : "事業専用割合"}（{fromYear ? `${year}年から・` : ""}%）</span>
            <input
              className="input" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="事業専用割合"
              disabled={rateLocked}
            />
          </label>
          <label className="field">
            <span>売却・除却した日（あれば）</span>
            <FullDateInput value={disposed} onChange={setDisposed} year={year} aria-label="売却・除却した日" onValidity={markDate("disposed")} />
          </label>
        </div>
        <p className="field-note">
          家事でも使うものは、事業で使っている割合を入れてください。償却費のうち残りは事業主貸になります（家事按分の画面ではなく、ここで資産ごとに決めます）。
          {fromYear && `割合を変えると ${year}年からの割合になり、前の年の割合はそのまま残ります。`}
        </p>
        {asset?.rates && (
          <p className="field-note">
            割合の変わり方：{[`${asset.used_on.slice(0, 4)}年から ${asset.business_rate}%`, ...asset.rates.map((r) => `${r.from_year}年から ${r.rate}%`)].join("、")}
          </p>
        )}
        {disposed && (
          <div className="field-row wrap">
            <label className="check"><input type="radio" name="disposal-kind" checked={disposalKind === "sale"} onChange={() => setDisposalKind("sale")} /> 売却した</label>
            <label className="check"><input type="radio" name="disposal-kind" checked={disposalKind === "scrap"} onChange={() => setDisposalKind("scrap")} /> 除却した（捨てた）</label>
            {disposalKind === "sale" && (
              <label className="field" style={{ maxWidth: 220 }}>
                <span>売却した額（税込）</span>
                <AmountInput value={salePrice} onChange={setSalePrice} aria-label="売却した額" />
              </label>
            )}
          </div>
        )}
        {disposed && (
          <p className="field-note">
            売却・除却した月まで償却します。売却・除却の仕訳は、台帳の「売却・除却の仕訳」で作れます（売却損益は事業所得ではなく譲渡所得なので、帳簿価額との差は事業主貸・事業主借にします。除却損は経費）。
          </p>
        )}
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit" disabled={!can("master")}>{asset ? "保存する" : "追加する"}</button>
        </div>
      </form>
    </Modal>
  );
};
