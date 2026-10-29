/**
 * 事業者設定 と 年度の繰越
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Save, ArrowRightLeft, Lock, LockOpen, FileDown } from "lucide-react";
import { anchorText, saveAnchorFile } from "../books/IntegrityModal";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext, useYearData } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import { carryForwardWithSubs, closingBalances, subClosingBalances, summarizeIncome } from "../../lib/accounting";
import { subKey } from "../../lib/types";
import { yen } from "../../lib/format";
import { normalizePostalCode, validateBusinessInfo } from "../../lib/business";
import { SCAN_METHOD_LABEL, type ScanInputMethod } from "../../lib/scan";
import { HolidaySection } from "./HolidaySection";
import { EncryptionSection } from "./EncryptionSection";
import { CODE } from "../../constants/accounts";
import type { FilingType, Settings } from "../../lib/types";
import { FILING_LABEL } from "../../lib/filing";
import * as repo from "../../db/repo";
import { closedLabel, closedMonthOf } from "../../lib/closing";
import { MODE_LABEL } from "../start/SetupScreen";
import { APP_DIR_NAME, BACKUP_DIR_NAME, DEFAULT_INPUT_PERIOD_DAYS, EXT_BACKUP, MAX_BACKUP_GENERATIONS, MAX_INPUT_PERIOD_DAYS } from "../../constants/appConfig";
import { TaxSection } from "./TaxSection";
import { EtaxSection } from "./EtaxSection";

export const SettingsForm = ({ initial, onSubmit, submitLabel, extra, filing = true }: {
  initial: Settings;
  onSubmit: (s: Settings) => Promise<void>;
  submitLabel: string;
  /** 送信ボタンの直前に差し込む欄（初期設定の保存方式など） */
  extra?: ReactNode;
  /** 申告の種類の欄を出すか（帳簿を作るときだけ。そのあとは年度ごとの設定 FilingSection で変える） */
  filing?: boolean;
}) => {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const err = validateBusinessInfo(s);
        if (err) return setError(err);
        setError("");
        setBusy(true);
        try {
          await onSubmit({ ...s, postal_code: normalizePostalCode(s.postal_code) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>屋号</span>
        <input className="input" value={s.business_name} onChange={(e) => set("business_name", e.target.value)} placeholder="例：山田デザイン事務所" required />
      </label>
      <label className="field">
        <span>氏名</span>
        <input className="input" value={s.owner_name} onChange={(e) => set("owner_name", e.target.value)} placeholder="例：山田 太郎" />
      </label>
      <div className="field-row">
        <label className="field" style={{ maxWidth: 140 }}>
          <span>郵便番号</span>
          <input
            className="input" value={s.postal_code} inputMode="numeric" placeholder="例：123-4567" maxLength={10}
            onChange={(e) => set("postal_code", e.target.value)} onBlur={(e) => set("postal_code", normalizePostalCode(e.target.value))}
          />
        </label>
        <label className="field">
          <span>住所</span>
          <input className="input" value={s.address} onChange={(e) => set("address", e.target.value)} placeholder="例：東京都千代田区○○1-2-3" maxLength={200} />
        </label>
      </div>
      <label className="field">
        <span>業種</span>
        <input className="input" value={s.industry} onChange={(e) => set("industry", e.target.value)} placeholder="例：デザイン業" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>会計年度</span>
          <input className="input" type="number" min={2000} max={2100} value={s.fiscal_year} onChange={(e) => set("fiscal_year", Number(e.target.value))} />
        </label>
        {filing && (
          <label className="field">
            <span>申告の種類</span>
            <select className="input" value={s.filing_type} onChange={(e) => set("filing_type", e.target.value as FilingType)}>
              {Object.entries(FILING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        )}
      </div>
      {extra}
      {error && <p className="form-error-inline" role="alert">{error}</p>}
      <div>
        <button className="btn primary" type="submit" disabled={busy}>
          <Save size={16} /> {submitLabel}
        </button>
      </div>
    </form>
  );
};

/** 申告の種類（年度ごと。決めた設定は、次に変える年まで引き継ぐ） */
const FilingSection = () => {
  const { db, year, filing, filingYears, settings, reloadFilingYears, isClosed, readOnly, can, bump } = useAppContext();
  const toast = useToast();
  const [type, setType] = useState<FilingType>(filing.type);
  useEffect(() => setType(filing.type), [filing.type]);
  const disabled = isClosed || readOnly || !can("settings");
  const save = async () => {
    try {
      await repo.saveFilingYear(db, year, type);
      await reloadFilingYears();
      bump();
      toast(`${year}年からの申告の種類を「${FILING_LABEL[type]}」にしました`);
    } catch (e) {
      toast(`保存できませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };
  return (
    <>
      <h2 className="sheet-h">申告の種類（{year}年）</h2>
      <p className="prose">
        申告の種類は年ごとに決めます。決めた種類は、次に変える年まで引き継がれます。白色申告の年は、決算書が収支内訳書の形になり、家族への給与の代わりに事業専従者控除を計算します。
        青色申告にするには、青色申告承認申請書を出しておきます（その年の3月15日まで。1月16日以後に開業した年は、開業の日から2か月以内）。
      </p>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field">
          <span>{year}年の申告の種類</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as FilingType)} disabled={disabled}>
            {Object.entries(FILING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div>
          <button className="btn primary" type="submit" disabled={disabled || (type === filing.type && !filing.inherited)}>
            <Save size={16} /> {year}年から、この種類にする
          </button>
        </div>
      </form>
      {filing.inherited && !isClosed && <p className="field-note">{filingYears.length ? "前の年" : "帳簿を作ったとき"}の設定を引き継いでいます。保存すると {year}年からの設定になります。</p>}
      {isClosed && <p className="field-note">{year}年は締め済みのため変更できません。</p>}
      {filingYears.length > 0 && (
        <dl className="kv mode-years">
          {settings.filing_type !== filingYears[0].filing_type && (
            <><dt>{filingYears[0].from_year - 1}年まで</dt><dd>{FILING_LABEL[settings.filing_type]}</dd></>
          )}
          {filingYears.map((r) => (
            <Fragment key={r.from_year}><dt>{r.from_year}年から</dt><dd>{FILING_LABEL[r.filing_type]}</dd></Fragment>
          ))}
        </dl>
      )}
    </>
  );
};

export const BusinessSettingsPage = () => {
  const { db, settings, year, accounts, closings, reloadSettings, bump } = useAppContext();
  const { lines, opening, subOpening } = useYearData();
  const toast = useToast();

  const end = closingBalances(accounts, opening, lines);
  const income = summarizeIncome(accounts, end).income;
  const next = carryForwardWithSubs(accounts, end, subClosingBalances(accounts, subOpening, lines));
  const capital = accounts.find((a) => a.code === CODE.CAPITAL)!;

  /** 繰越のときに、この年を締めるか（最初は締めない：前の年を直しながら翌年の入力を始められるように） */
  const [closeToo, setCloseToo] = useState(false);

  const runCarryForward = async () => {
    const nextYear = year + 1;
    if (closedMonthOf(closings.find((c) => c.fiscal_year === nextYear)) === 12) {
      toast(`${nextYear}年は締め済みのため、期首残高を書き換えられません。先に${nextYear}年の締めを戻してください。`, "error");
      return;
    }
    const exists = await repo.hasOpening(db, nextYear);
    const ok = await ask(
      (exists
        ? `${nextYear}年の期首残高はすでにあります。${year}年末の残高で上書きして、${nextYear}年に切り替えますか？`
        : `${year}年末の残高を ${nextYear}年の期首残高として繰り越し、${nextYear}年に切り替えます。`) +
        (closeToo ? `\n${year}年は締め済みになります。` : `\n${year}年は締めません（あとで直したら、繰越をやり直してください）。`),
      { title: "繰越処理", kind: exists ? "warning" : "info", okLabel: "繰り越す", cancelLabel: "やめる" },
    );
    if (!ok) return;
    // 通常モードの帳簿：翌年を始めるこのときだけ、電子帳簿保存法に対応した保存方式へ切り替えるか聞く
    // （翌年の仕訳がまだ無いときだけ。その年の初めから履歴を残せる）
    let switched = false;
    if (settings.e_book_mode === "standard" && (await repo.canSwitchToStrict(db, nextYear))) {
      switched = await ask(
        `${nextYear}年から、帳簿の保存方式を「${MODE_LABEL.strict}」に切り替えますか？\n\n` +
          `切り替えると、${nextYear}年からの仕訳・勘定科目・期首残高の訂正や削除がすべて履歴に残ります。一度切り替えると、通常には戻せません。\n` +
          `${year}年までは通常の保存のまま（電子帳簿保存法の対応外）です。\n` +
          `この確認は、翌年を始める繰越のときにだけ出ます。`,
        { title: "電子帳簿保存法への切り替え", kind: "info", okLabel: "切り替える", cancelLabel: "通常のまま" },
      );
    }
    try {
      // 切り替えてから繰り越す（翌年の期首残高も履歴に残るように）
      if (switched) await repo.switchToStrict(db, nextYear);
      // 期首残高の保存と締めを1つのトランザクションで（途中で失敗したら両方取り消す）
      await repo.carryForward(db, year, next, closeToo);
    } catch (e) {
      toast(`繰り越せませんでした：${String(e)}`, "error");
      await reloadSettings();
      return;
    }
    await repo.saveSettings(db, { ...(await repo.getSettings(db)), fiscal_year: nextYear });
    await reloadSettings();
    bump();
    toast(switched ? `${nextYear}年に繰り越し、${nextYear}年から電子帳簿保存法に対応した保存方式にしました` : `${nextYear}年に繰り越しました`);
  };

  return (
    <div className="page">
      <PageHeader title="事業者設定" />
      <div className="settings-layout">
        <section className="sheet">
          <h2 className="sheet-h">事業者の情報</h2>
          <SettingsForm
            key={JSON.stringify(settings)}
            initial={settings}
            submitLabel="保存する"
            filing={false}
            onSubmit={async (s) => {
              await repo.saveSettings(db, s);
              await reloadSettings();
              toast("設定を保存しました");
            }}
          />
          <FilingSection />
        </section>

        <section className="sheet">
          <h2 className="sheet-h">帳簿の保存方式</h2>
          {settings.e_book_mode === "strict" && settings.strict_from_year ? (
            <>
              <dl className="kv mode-years">
                <dt>{settings.strict_from_year - 1}年まで</dt>
                <dd className="mode-off">{MODE_LABEL.standard}（電子帳簿保存法の対応外）</dd>
                <dt>{settings.strict_from_year}年から</dt>
                <dd>{MODE_LABEL.strict}</dd>
              </dl>
              <p className="prose">
                {settings.strict_switched_at?.slice(0, 10).replace(/-/g, "/")} に、{settings.strict_from_year}年からこの方式に切り替えました（戻せません）。
                {settings.strict_from_year}年からの仕訳・勘定科目・期首残高の訂正と削除は「訂正・削除履歴」に記録されます。
                {settings.strict_from_year - 1}年までは通常の保存で記録していたため、切り替えより前の訂正・削除の履歴はありません。
              </p>
            </>
          ) : (
            <>
              <p className="mode-current">
                {settings.e_book_mode ? MODE_LABEL[settings.e_book_mode] : "未設定"}
              </p>
              <p className="prose">
                {settings.e_book_mode === "strict"
                  ? "仕訳・勘定科目・期首残高の訂正と削除は「訂正・削除履歴」に記録されます。この方式は帳簿を作成したときに決めたもので、変更できません。"
                  : "履歴を残さない方式です（電子帳簿保存法の対応外）。電子帳簿保存法に対応したい場合は、翌年への繰越のときに、翌年から切り替えられます（その年の仕訳を入れる前だけ。戻せません）。"}
              </p>
            </>
          )}

          <h2 className="sheet-h">翌年への繰越</h2>
          <p className="prose">
            {year}年12月31日の残高を {year + 1}年1月1日の期首残高にして、{year + 1}年を始めます。
            事業主貸・事業主借は元入金に振り替えて 0 に戻します。補助科目ごとの残高も引き継ぎます。
            {year}年を締めずに繰り越せば、{year}年の決算を直しながら {year + 1}年の入力を始められます（直したら繰越をやり直してください。ずれは画面上部でお知らせします）。繰越は何度でもやり直せます。
          </p>
          <dl className="kv">
            <dt>{year}年の所得金額（控除前）</dt><dd className="num">{yen(income)}</dd>
            <dt>{year + 1}年の元入金</dt><dd className="num">{yen(next[subKey(capital.id, null)] ?? 0)}</dd>
          </dl>
          <label className="check" style={{ margin: "8px 0" }}>
            <input type="checkbox" checked={closeToo} onChange={(e) => setCloseToo(e.target.checked)} />
            {year}年を締める（決算が終わったとき。締めると {year}年の仕訳などは変更できなくなります）
          </label>
          <button className="btn primary" onClick={runCarryForward}>
            <ArrowRightLeft size={16} /> {year + 1}年へ繰り越す
          </button>
        </section>

        <TaxSection />
        <EtaxSection />
        <ClosingSection />
        <InputPeriodSection />
        <ScanSection />
        <HolidaySection />
        <BackupSection />
        <EncryptionSection />
      </div>
    </div>
  );
};

/**
 * 締め（年度ごとに「何月まで締めたか」）
 *  - 月の締め：締めた月までの仕訳は変更できない（通帳と照らし合わせた月、確認が済んだ月など）
 *  - 年の締め（12月まで）：期首残高・家事按分なども変更できない。厳密モードでは確認コードを出す
 *  - 戻すときは「何月までに戻すか」を1回選ぶだけ（年の締めから 10月までに戻せば、11・12月だけ直せる）。
 *    厳密モードでは理由が必須で、履歴に残る
 */
const ClosingSection = () => {
  const { db, year, strict, closings, dataVersion, bump, settings, filePath, can } = useAppContext();
  const toast = useToast();
  const [years, setYears] = useState<number[]>([]);
  const [target, setTarget] = useState<Record<number, number>>({});
  const [reopening, setReopening] = useState<{ year: number; month: number } | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    repo.getYears(db, year).then(setYears).catch(console.error);
  }, [db, year, dataVersion]);

  const all = [...new Set([...years, ...closings.map((c) => c.fiscal_year)])].sort((a, b) => b - a);
  const closingOfYear = (y: number) => closings.find((c) => c.fiscal_year === y);
  const admin = can("settings");

  const close = async (y: number, month: number) => {
    try {
      await repo.closeThrough(db, y, month, "手動で締め");
      bump();
      toast(month === 12 ? `${y}年を締めました（年の締め）` : `${y}年を${month}月まで締めました`);
    } catch (e) {
      toast(`締められませんでした：${String(e)}`, "error");
    }
  };

  const reopen = async (y: number, month: number, why: string) => {
    try {
      await repo.reopenTo(db, y, month, why);
      setReopening(null);
      setReason("");
      bump();
      toast(month === 0 ? `${y}年の締めを外しました` : `${y}年の締めを${month}月までに戻しました`);
    } catch (e) {
      toast(`戻せませんでした：${String(e)}`, "error");
    }
  };

  return (
    <section className="sheet span-all">
      <h2 className="sheet-h">締め（月・年度）</h2>
      <p className="prose">
        締めた月までの仕訳は変更できなくなります。通帳と照らし合わせた月や、確認が済んだ月を締めておくと、うっかり変えてしまうのを防げます。
        12月まで締めると<b>年の締め</b>になり、期首残高・家事按分なども変更できなくなります（繰越のときに「この年を締める」を選んでも年の締めになります）。
        直すときは「締めを戻す」で、どの月までの締めに戻すかを選びます。締めと戻しは管理者だけができます。
        {strict && "締めと戻しは「訂正・削除履歴」に記録されます（戻すには理由が必要です）。年の締めの確認コードは、決算書の控えなど帳簿ファイルの外に残しておいてください（改ざんの確認に使います）。"}
      </p>
      <table className="ledger closing-table">
        <thead>
          <tr><th>年度</th><th>状態</th><th>締めた日時</th>{strict && <th>確認コード</th>}<th></th></tr>
        </thead>
        <tbody>
          {all.map((y) => {
            const c = closingOfYear(y);
            const m = closedMonthOf(c);
            const next = Math.min(12, Math.max(m + 1, target[y] ?? m + 1));
            return (
              <tr key={y}>
                <td>{y}年{y === year && <span className="hint">表示中</span>}</td>
                <td>
                  {m === 0
                    ? <span className="status-open">未締め</span>
                    : <span className={m === 12 ? "status-closed" : "status-month"}><Lock size={13} /> {closedLabel(m)}</span>}
                </td>
                <td className="muted">{c?.closed_at ?? ""}</td>
                {strict && (
                  <td>
                    {m === 12 && c?.chain_head && (
                      <span className="anchor-cell">
                        <code className="mono">{repo.anchorCode(c.chain_head)}</code>
                        <button
                          className="icon-btn"
                          title="確認コードを書き出す"
                          aria-label={`${y}年の確認コードを書き出す`}
                          onClick={async () => {
                            const head = { row_hash: c.chain_head, recorded_at: c.closed_at };
                            const text = anchorText({ business: settings.business_name, file: filePath.split(/[\\/]/).pop() ?? "", head, label: `${y}年の締め` });
                            if (await saveAnchorFile(text, `確認コード_${settings.business_name || "帳簿"}_${y}年締め.txt`)) toast("書き出しました");
                          }}
                        ><FileDown size={14} /></button>
                      </span>
                    )}
                  </td>
                )}
                <td>
                  <span className="closing-actions">
                    {m < 12 && (
                      <>
                        <select className="input sm" value={next} onChange={(e) => setTarget((t) => ({ ...t, [y]: Number(e.target.value) }))} aria-label={`${y}年を何月まで締めるか`} disabled={!admin}>
                          {Array.from({ length: 12 - m }, (_, i) => m + 1 + i).map((x) => (
                            <option key={x} value={x}>{x === 12 ? "12月まで（年の締め）" : `${x}月まで`}</option>
                          ))}
                        </select>
                        <button className="btn ghost sm" onClick={() => close(y, next)} disabled={!admin}><Lock size={14} /> 締める</button>
                      </>
                    )}
                    {m > 0 && (
                      <button className="btn ghost sm" onClick={() => { setReason(""); setReopening({ year: y, month: m - 1 }); }} disabled={!admin}>
                        <LockOpen size={14} /> 締めを戻す
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {reopening !== null && (
        <Modal title={`${reopening.year}年の締めを戻す`} onClose={() => setReopening(null)} width={520}>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              reopen(reopening.year, reopening.month, reason);
            }}
          >
            <p className="prose">
              今は「{closedLabel(closedMonthOf(closingOfYear(reopening.year)))}」です。どこまでの締めに戻すかを選んでください。
              戻した月より後の仕訳{closedMonthOf(closingOfYear(reopening.year)) === 12 ? "と、期首残高・家事按分など" : ""}が変更できるようになります。
              {strict && "戻したことと理由は「訂正・削除履歴」に記録されます。"}
            </p>
            <label className="field">
              <span>戻す先</span>
              <select className="input" value={reopening.month} onChange={(e) => setReopening({ ...reopening, month: Number(e.target.value) })} autoFocus>
                {Array.from({ length: closedMonthOf(closingOfYear(reopening.year)) }, (_, i) => closedMonthOf(closingOfYear(reopening.year)) - 1 - i).map((x) => (
                  <option key={x} value={x}>{x === 0 ? "締めなし（全部の月を直せるようにする）" : `${x}月まで締め（${x + 1}月から後を直せるようにする）`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>理由{strict ? "（必須）" : "（任意）"}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：11月分の売上の計上漏れを追加するため" maxLength={200} />
            </label>
            <div className="voucher-actions">
              <div className="spacer" />
              <button type="button" className="btn ghost" onClick={() => setReopening(null)}>やめる</button>
              <button className="btn primary" type="submit" disabled={strict && !reason.trim()}>
                <LockOpen size={16} /> 戻す
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
};

/** 入力期間：取引日からこの日数を過ぎて登録した仕訳を、仕訳日記帳で「遅れて登録」として確認・抽出できる */
const InputPeriodSection = () => {
  const { db, strict, bump } = useAppContext();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    repo.getInputPeriodDays(db).then((n) => {
      setSaved(n);
      setValue(String(n));
    }).catch(console.error);
  }, [db]);

  const save = async () => {
    try {
      await repo.setInputPeriodDays(db, Number(value));
      setSaved(Number(value));
      bump();
      toast("入力期間を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">入力期間</h2>
      <p className="prose">
        取引日からこの日数を過ぎて登録した仕訳は、仕訳日記帳で「遅れて登録」と表示され、絞り込みや CSV で確認できます。
        既定の {DEFAULT_INPUT_PERIOD_DAYS} 日は「最長2か月 + おおむね7営業日」の目安です。事務処理規程などで決めた期間に合わせてください。
        {strict && "変更は「訂正・削除履歴」に記録されます。登録日時は登録時の履歴（記録の連鎖に入っている）から取るので、直接書き換えると改ざんの確認で見つかります。"}
      </p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field">
          <span>入力期間（1〜{MAX_INPUT_PERIOD_DAYS} 日）</span>
          <input className="input" type="number" min={1} max={MAX_INPUT_PERIOD_DAYS} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn primary" type="submit" disabled={saved === null || String(saved) === value}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>
    </section>
  );
};

/** スキャナ保存の入力期間の方式（厳密モードの帳簿だけ） */
const ScanSection = () => {
  const { db, strict, bump } = useAppContext();
  const toast = useToast();
  const [method, setMethod] = useState<ScanInputMethod | null>(null);

  useEffect(() => {
    repo.getScanInputMethod(db).then(setMethod).catch(console.error);
  }, [db]);

  if (!strict) return null;

  const change = async (m: ScanInputMethod) => {
    try {
      await repo.setScanInputMethod(db, m);
      setMethod(m);
      bump();
      toast("スキャナ保存の入力期間の方式を保存しました");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">スキャナ保存</h2>
      <p className="prose">
        紙で受け取った書類を読み取って保存するときの、入力期間の方式です。期限を過ぎて取り込んだものには「入力期間外」の印がつきます（紙の原本も保存してください）。
        業務処理サイクル方式を使うときは、事務処理の規程を定めておく必要があります。変更は「訂正・削除履歴」に記録されます。
      </p>
      <div className="field">
        {(Object.keys(SCAN_METHOD_LABEL) as ScanInputMethod[]).map((m) => (
          <label key={m} className="check">
            <input type="radio" checked={method === m} onChange={() => change(m)} disabled={method === null} /> {SCAN_METHOD_LABEL[m]}
          </label>
        ))}
      </div>
    </section>
  );
};

/** バックアップの世代数（帳簿を開くたびにバックアップを作り、古いものから消す） */
const BackupSection = () => {
  const { db } = useAppContext();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    repo.getBackupGenerations(db).then((n) => {
      setSaved(n);
      setValue(String(n));
    }).catch(console.error);
  }, [db]);

  const save = async () => {
    try {
      await repo.setBackupGenerations(db, Number(value));
      setSaved(Number(value));
      toast("バックアップの世代数を保存しました。次に帳簿を開いたときから適用されます");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""), "error");
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">バックアップ</h2>
      <p className="prose">
        帳簿を開くたびに、書類フォルダの「{APP_DIR_NAME}/{BACKUP_DIR_NAME}」へ丸ごと複製（.{EXT_BACKUP}）を作ります。
        決めた世代数を超えたら、古いものから消します。
      </p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field">
          <span>残す世代数（1〜{MAX_BACKUP_GENERATIONS}）</span>
          <input className="input" type="number" min={1} max={MAX_BACKUP_GENERATIONS} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn primary" type="submit" disabled={saved === null || String(saved) === value}>
            <Save size={16} /> 保存する
          </button>
        </div>
      </form>
    </section>
  );
};
