/**
 * 固定資産台帳・減価償却
 *  - 資産ごとに取得価額・償却方法・耐用年数・事業専用割合を持ち、年度ごとの償却費を計算する（lib/depreciation.ts）
 *  - 年末に「減価償却費（事業分）＋事業主貸（家事分） / 資産の科目」の決算整理仕訳を1本作る。作り直すと同じ仕訳を訂正する
 *  - 帳簿の資産の科目の残高と、台帳の未償却残高を並べて、ずれていないか確かめられる
 * 資産を買った仕訳（工具器具備品 / 普通預金 など）は、振替伝票でふつうに入れる
 */
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { AmountInput, FullDateInput } from "../../components/Inputs";
import { EntryEditModal } from "../entry/EntryEditModal";
import { closingBalances } from "../../lib/accounting";
import { yen } from "../../lib/format";
import { CODE, FIXED_ASSET_CODES } from "../../constants/accounts";
import {
  depreciationFor, depreciationLines, EXPENSE_LIMIT, LUMP3_LIMIT, METHOD_LABEL, SMALL_LIMIT, SMALL_YEAR_LIMIT, smallTotalOfYear, validateAsset,
  type DepreciationMethod, type FixedAsset,
} from "../../lib/depreciation";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const ymd = (iso: string) => iso.replace(/-/g, "/");

export const FixedAssetsPage = () => {
  const { db, year, accounts, settings, bump, dataVersion, isClosed, can, strict } = useAppContext();
  const { lines, opening } = useYearData();
  const toast = useToast();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [runLines, setRunLines] = useState<string | null>(null);
  const [editing, setEditing] = useState<FixedAsset | "new" | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    repo.getAssets(db).then(setAssets).catch(console.error);
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
  };

  // この年度に償却する（台帳に出す）資産と、それ以外
  const rows = assets.map((a) => ({ a, d: depreciationFor(a, year) }));
  const active = rows.filter((r) => r.d && !(r.d.opening === 0 && r.d.depreciation === 0));
  const others = rows.filter((r) => !active.includes(r));
  const sum = (k: "opening" | "depreciation" | "business" | "closing") => active.reduce((s, r) => s + (r.d ? r.d[k] : 0), 0);

  const planned = useMemo(() => depreciationLines(assets, year, ids), [assets, year, ids.expense, ids.draw]); // eslint-disable-line react-hooks/exhaustive-deps
  const outdated = runId !== null && runLines !== lineKey(planned);
  const smallTotal = smallTotalOfYear(assets, year);

  // 帳簿の残高との照合（資産の科目ごと。その年に売却・除却したものは、仕訳で帳簿から外している前提で数えない）
  const balances = useMemo(() => closingBalances(accounts, opening, lines), [accounts, opening, lines]);
  const ledgerByAccount = new Map<number, number>();
  for (const r of active) if (r.d && !r.d.disposed) ledgerByAccount.set(r.a.account_id, (ledgerByAccount.get(r.a.account_id) ?? 0) + r.d.closing);
  const checkAccounts = accounts.filter((a) => ledgerByAccount.has(a.id) || (FIXED_ASSET_CODES.includes(a.code) && (balances.get(a.id) ?? 0) !== 0));

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

  const editButtons = (a: FixedAsset) => (
    <span className="row-actions">
      <button className="link-btn" onClick={() => setEditing(a)} aria-label={`${a.name}を編集`}><Pencil size={13} /> 編集</button>
      <button className="link-btn danger" onClick={() => remove(a)} disabled={!can("master")} aria-label={`${a.name}を削除`}><Trash2 size={13} /></button>
    </span>
  );

  return (
    <div className="page">
      <PageHeader
        title="固定資産台帳"
        note={`10万円以上の備品・車・建物などを登録すると、${year}年の減価償却費を計算します。資産を買った仕訳は振替伝票で入れてください。${strict ? "台帳の変更は履歴に記録されます。" : ""}`}
      >
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
                    <td>{METHOD_LABEL[a.method]}</td>
                    <td className="num">{a.method === "straight" ? `${a.useful_life}年` : a.method === "lump3" ? "3年" : "—"}</td>
                    <td className="num">{d!.rate !== null ? d!.rate.toFixed(3) : "—"}</td>
                    <td className="num">{d!.months}</td>
                    <td className="num">{yen(d!.opening)}</td>
                    <td className="num">{yen(d!.depreciation)}</td>
                    <td className="num">{a.business_rate}%</td>
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
                    <td>{METHOD_LABEL[a.method]}</td>
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

      {editing && <AssetModal asset={editing === "new" ? null : editing} blue={settings.filing_type !== "white"} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); bump(); }} />}
      {viewing && <EntryEditModal entryId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};

/** 仕訳の明細を比べるための文字列（作成済みの仕訳が台帳の計算と同じか） */
const lineKey = (ls: { side: string; account_id: number; amount: number; memo: string }[]) =>
  ls.map((l) => `${l.side}:${l.account_id}:${l.amount}:${l.memo}`).sort().join("|");

/** 耐用年数の目安（よく使うもの） */
const LIFE_EXAMPLES = "例：パソコン 4年、サーバー 5年、普通自動車 6年、軽自動車 4年、事務机・椅子（金属製）15年、ソフトウェア 5年";

const AssetModal = ({ asset, blue, onClose, onSaved }: { asset: FixedAsset | null; blue: boolean; onClose: () => void; onSaved: () => void }) => {
  const { db, year, accounts, can } = useAppContext();
  const toast = useToast();
  const choices = accounts.filter((a) => a.category === "asset" && (FIXED_ASSET_CODES.includes(a.code) || !a.is_system));
  const lumpId = accounts.find((a) => a.code === CODE.LUMP_ASSET)?.id;
  const [name, setName] = useState(asset?.name ?? "");
  const [accountId, setAccountId] = useState<number | null>(asset?.account_id ?? accounts.find((a) => a.code === "134")?.id ?? null);
  const [acquired, setAcquired] = useState(asset?.acquired_on ?? "");
  const [used, setUsed] = useState(asset?.used_on ?? "");
  const [cost, setCost] = useState<number | null>(asset?.cost ?? null);
  const [method, setMethod] = useState<DepreciationMethod>(asset?.method ?? "straight");
  const [life, setLife] = useState(asset && asset.method === "straight" ? String(asset.useful_life) : "");
  const [rate, setRate] = useState(String(asset?.business_rate ?? 100));
  const [hasOpening, setHasOpening] = useState(asset?.opening_year != null);
  const [openingYear, setOpeningYear] = useState(String(asset?.opening_year ?? year));
  const [openingValue, setOpeningValue] = useState<number | null>(asset?.opening_book_value ?? null);
  const [disposed, setDisposed] = useState(asset?.disposed_on ?? "");
  const [memo, setMemo] = useState(asset?.memo ?? "");
  const [error, setError] = useState("");

  const changeMethod = (m: DepreciationMethod) => {
    setMethod(m);
    if (m === "lump3" && lumpId) setAccountId(lumpId);
    else if (accountId === lumpId) setAccountId(accounts.find((a) => a.code === "134")?.id ?? null);
  };

  const input = (): repo.AssetInput => ({
    name, account_id: accountId ?? 0, acquired_on: acquired, used_on: used || acquired, cost: cost ?? 0, method,
    useful_life: Number(life) || 0, business_rate: Number(rate), opening_year: hasOpening ? Number(openingYear) || 0 : null,
    opening_book_value: hasOpening ? openingValue ?? null : null, disposed_on: disposed || null, memo,
  });

  const submit = async () => {
    setError("");
    const a = input();
    const e = validateAsset(a, { blue });
    if (e) return setError(e);
    try {
      await repo.saveAsset(db, asset?.id ?? null, a);
      toast(asset ? "固定資産を更新しました" : "固定資産を追加しました");
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <Modal title={asset ? "固定資産の編集" : "固定資産の追加"} onClose={onClose} width={620}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="例：ノートパソコン、営業車" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>償却方法</span>
            <select className="input" value={method} onChange={(e) => changeMethod(e.target.value as DepreciationMethod)}>
              <option value="straight">{METHOD_LABEL.straight}</option>
              <option value="lump3">{METHOD_LABEL.lump3}（{yen(EXPENSE_LIMIT)}〜{yen(LUMP3_LIMIT)}円未満）</option>
              <option value="small" disabled={!blue}>{METHOD_LABEL.small}（{yen(SMALL_LIMIT)}円未満・青色申告）</option>
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
            <FullDateInput value={acquired} onChange={setAcquired} year={year} aria-label="取得日" />
          </label>
          <label className="field">
            <span>事業に使い始めた日（空なら取得日）</span>
            <FullDateInput value={used} onChange={setUsed} year={year} aria-label="事業に使い始めた日" />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>取得価額（円）</span>
            <AmountInput value={cost} onChange={setCost} aria-label="取得価額" />
          </label>
          {method === "straight" && (
            <label className="field">
              <span>耐用年数（年）</span>
              <input className="input" inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="耐用年数" />
            </label>
          )}
          <label className="field">
            <span>事業専用割合（%）</span>
            <input className="input" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, "").slice(0, 3))} aria-label="事業専用割合" />
          </label>
        </div>
        {method === "straight" && <p className="field-note">{LIFE_EXAMPLES}。耐用年数は国税庁の耐用年数表で確かめてください。</p>}
        {method === "lump3" && <p className="field-note">取得価額の 1/3 ずつを3年で経費にします（月割りしません）。</p>}
        {method === "small" && <p className="field-note">使い始めた年に全額を経費にします（1年の合計 {yen(SMALL_YEAR_LIMIT)} 円まで）。</p>}
        {cost !== null && cost > 0 && cost < EXPENSE_LIMIT && <p className="field-note">{yen(EXPENSE_LIMIT)} 円未満のものは、台帳に入れずに消耗品費などで経費にできます。</p>}
        <p className="field-note">家事でも使うものは、事業で使っている割合を入れてください。償却費のうち残りは事業主貸になります（家事按分の画面ではなく、ここで資産ごとに決めます）。</p>

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
        <div className="field-row">
          <label className="field">
            <span>売却・除却した日（あれば）</span>
            <FullDateInput value={disposed} onChange={setDisposed} year={year} aria-label="売却・除却した日" />
          </label>
          <label className="field">
            <span>備考（任意）</span>
            <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={100} placeholder="例：型番、購入先" />
          </label>
        </div>
        {disposed && <p className="field-note">売却・除却した月まで償却します。帳簿から外す仕訳（売却・除却損など）は振替伝票で入れてください。</p>}
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
