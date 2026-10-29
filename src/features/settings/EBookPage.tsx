/**
 * 電子帳簿保存法（優良な電子帳簿）の届出・要件の確認
 *  - その年の保存方式（対応しているか）
 *  - 受けられる優遇措置（過少申告加算税の軽減・青色申告特別控除）とその条件
 *  - 要件のチェックリスト：domble が満たしているもの（自動）と、自分で行うこと（チェックを年度ごとに残す）
 *  - 届出書に書く内容（コピー用）と提出期限、事務処理マニュアルのひな形
 * 内容は国税庁の案内（令和8年時点）に基づく。最新の様式・要件は国税庁の案内で確かめてもらう
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Copy, FileDown, ShieldCheck, ShieldOff } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { copyText } from "../../lib/clipboard";
import { longDate } from "../../lib/format";
import { saveAnchorFile } from "../books/IntegrityModal";
import { filingDeadline, filingFormName, isYearCompliant, keepingStartDate, MANUAL_ITEMS, processingManual } from "../../lib/ebook";
import { MODE_LABEL } from "../start/SetupScreen";
import type { Page } from "../../App";
import * as repo from "../../db/repo";
import { isBlue } from "../../lib/filing";
import pkg from "../../../package.json";

/** 国税庁の電子帳簿等保存制度の案内 */
const NTA_URL = "https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/index.htm";

export const EBookPage = ({ go }: { go: (p: Page) => void }) => {
  const { db, year, settings, filePath, dataVersion, isClosed, can, readOnly, filingTypeOf } = useAppContext();
  const toast = useToast();
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [inputDays, setInputDays] = useState(70);
  const [hasAssets, setHasAssets] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    repo.getHolidayData(db).then((h) => setHolidays(new Set(h.holidays.map((x) => x.date)))).catch(console.error);
    repo.getInputPeriodDays(db).then(setInputDays).catch(console.error);
    repo.getAssets(db).then((a) => setHasAssets(a.length > 0)).catch(console.error);
    repo.getStatementNotes(db, year).then(setNotes).catch(console.error);
  }, [db, year, dataVersion]);

  const compliant = isYearCompliant(settings, year);
  const blue = isBlue(filingTypeOf(year));
  const deadline = filingDeadline(year, holidays);
  const fileName = filePath.split(/[\\/]/).pop() ?? "";
  const books = ["仕訳帳", "総勘定元帳", "現金出納帳・預金出納帳", ...(hasAssets ? ["固定資産台帳"] : [])];

  const toggle = async (key: string, on: boolean) => {
    const k = `ebook:${key}`;
    const v = on ? new Date().toISOString().slice(0, 10) : "";
    try {
      await repo.saveStatementNote(db, year, k, v);
      setNotes((n) => ({ ...n, [k]: v }));
    } catch (e) {
      toast(`保存できませんでした：${String(e).replace(/^Error: /, "")}`, "error");
    }
  };

  // 届出書に書く内容（コピー用）
  const formRows: [string, string][] = [
    ["届出書の名称", filingFormName(blue, year)],
    ["提出先", "納税地の所轄税務署（e-Tax でも書面でも提出できます）"],
    ["提出期限", `${longDate(deadline)}（${year}年分の確定申告の期限）`],
    ["住所", settings.address || "（事業者設定で入れてください）"],
    ["氏名・屋号", `${settings.owner_name}　${settings.business_name}`],
    ["帳簿の種類", books.join("、")],
    ["根拠税法", "所得税法"],
    ["備付けを開始する日", longDate(settings.strict_from_year && settings.strict_from_year > year ? keepingStartDate(settings.strict_from_year) : keepingStartDate(year))],
    ["作成・保存の方法", "電子計算機を使用して作成し、電磁的記録により保存"],
    ["使用するソフトウェア", `domble ver ${pkg.version}（JIIMA 認証は受けていません）`],
    ["帳簿ファイル", filePath],
  ];
  const formText = formRows.map(([k, v]) => `${k}：${v}`).join("\n");

  const auto: { label: string; detail: string; page?: Page }[] = [
    { label: "訂正・削除の履歴が残る", detail: "仕訳・勘定科目・期首残高などの訂正前／訂正後と、削除した内容を「訂正・削除履歴」に残します（削除した仕訳も消えません）", page: "history" },
    { label: "通常の業務処理期間を過ぎた入力の履歴が残る", detail: `取引日から ${inputDays} 日を過ぎて登録した仕訳を「遅れて登録」として記録し、仕訳日記帳で絞り込めます（日数は事業者設定で変更）`, page: "journal" },
    { label: "帳簿間の相互関連性", detail: "仕訳帳（仕訳日記帳）と総勘定元帳・補助簿は、同じ伝票番号でつながっています", page: "ledger" },
    { label: "検索機能", detail: "取引年月日・取引金額・取引先で検索でき、日付と金額は範囲で、条件は組み合わせて指定できます", page: "journal" },
    { label: "画面と書面に整然と出力できる", detail: "仕訳日記帳・総勘定元帳（補助元帳）・出納帳・残高試算表・固定資産台帳・訂正削除履歴を、ページ番号と見出しつきの A4 で印刷できます（印刷の画面から PDF にも保存できます）", page: "ledger" },
    { label: "ダウンロードの求めに応じられる", detail: "仕訳日記帳・総勘定元帳・残高試算表・固定資産台帳・訂正削除履歴などを CSV で書き出せます", page: "journal" },
  ];

  return (
    <div className="page">
      <PageHeader title="電子帳簿保存法" note={`${year}年分の、優良な電子帳簿の要件と届出の確認です。内容は国税庁の案内（令和8年時点）に基づきます。`} />

      <section className={`sheet ebook-status ${compliant ? "ok" : "off"}`}>
        {compliant ? <ShieldCheck size={22} /> : <ShieldOff size={22} />}
        <div>
          <h2 className="sheet-h" style={{ margin: 0 }}>
            {year}年：{compliant ? `${MODE_LABEL.strict}で保存しています` : "電子帳簿保存法の対応外（通常の保存）"}
          </h2>
          <p className="prose">
            {compliant
              ? `${year}年の初めから、優良な電子帳簿の要件を満たす保存方式で記録しています。下のチェックリストと届出を済ませると、優遇措置を受けられます。`
              : settings.e_book_mode === "strict" && settings.strict_from_year
                ? `${settings.strict_from_year}年から対応しています。${year}年は通常の保存で記録していたため、優遇措置は受けられません。`
                : "この帳簿は通常の保存方式です。優遇措置は受けられません。電子帳簿保存法に対応したい場合は、翌年への繰越のときに、翌年から切り替えられます（事業者設定）。"}
          </p>
        </div>
      </section>

      <section className="sheet">
        <h2 className="sheet-h">受けられる優遇措置</h2>
        <dl className="ebook-benefits">
          <dt>過少申告加算税の軽減</dt>
          <dd>
            申告漏れがあったときの過少申告加算税が 10% から 5% に軽くなります（隠蔽・仮装があった場合を除く）。
            その年の初めから優良な電子帳簿で保存し、届出書を出していることが条件です。
          </dd>
          <dt>青色申告特別控除</dt>
          <dd>
            {!blue ? "白色申告では受けられません（事業者設定の申告の種類）。" : year <= 2026 ? (
              <>
                65万円の控除は、正規の簿記で記帳して決算書（貸借対照表・損益計算書）を添えて期限内に申告することに加えて、
                <b>e-Tax で申告する</b>か、<b>優良な電子帳簿で保存して届出書を出す</b>かのどちらかが条件です（どちらもなければ55万円）。
              </>
            ) : (
              <>
                令和9年分からは、<b>e-Tax で申告し、かつ優良な電子帳簿で保存して届出書を出す</b>と75万円、e-Tax で申告すると65万円、
                書面で申告すると10万円になる予定です（令和8年度税制改正）。最新の内容は国税庁の案内で確かめてください。
              </>
            )}
          </dd>
        </dl>
      </section>

      <section className="sheet">
        <h2 className="sheet-h">要件のチェックリスト（{year}年）</h2>
        <h3 className="st-h">domble が満たしているもの</h3>
        <ul className="ebook-list">
          {auto.map((x) => (
            <li key={x.label} className={compliant ? "ok" : "off"}>
              {compliant ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
              <div>
                <b>{x.label}</b>
                {x.page && <button className="link-btn" onClick={() => go(x.page!)}>画面を開く</button>}
                <p>{compliant ? x.detail : "この年は通常の保存のため、満たしていません"}</p>
              </div>
            </li>
          ))}
        </ul>
        <h3 className="st-h">ご自身で行うこと</h3>
        <ul className="ebook-list manual">
          {MANUAL_ITEMS.map((x) => {
            const done = notes[`ebook:${x.key}`];
            return (
              <li key={x.key}>
                <input type="checkbox" checked={!!done} onChange={(e) => toggle(x.key, e.target.checked)} disabled={isClosed || readOnly || !can("master")} aria-label={x.label} />
                <div>
                  <b>{x.label}</b>
                  {done && <span className="hint">{done.replace(/-/g, "/")} にチェック</span>}
                  {x.key === "filed" && <span className="hint">期限：{longDate(deadline)}</span>}
                  <p>{x.note}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="sheet">
        <h2 className="sheet-h">届出書に書く内容</h2>
        <table className="ledger st-detail">
          <tbody>
            {formRows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody>
        </table>
        <div className="field-row" style={{ marginTop: 8 }}>
          <button
            className="btn ghost sm"
            onClick={async () => {
              if (await copyText(formText)) toast("コピーしました");
              else toast("コピーできませんでした", "error");
            }}
          >
            <Copy size={14} /> まとめてコピー
          </button>
        </div>
        <p className="field-note">
          届出書の様式と書き方は、国税庁の案内で確かめてください（<a href={NTA_URL} target="_blank" rel="noreferrer">電子帳簿等保存制度の案内</a>）。
          domble は JIIMA の認証を受けていないため、届出書の「認証を受けたソフトウェアか」の欄は「いいえ」になります。その場合も、要件を満たしていれば優遇措置は受けられます。
        </p>
      </section>

      <section className="sheet">
        <h2 className="sheet-h">事務処理マニュアルのひな形</h2>
        <p className="prose">
          システム関係書類として備え付ける事務処理マニュアルのひな形です。入力・訂正・保存の手順を、domble の使い方に合わせて書いてあります。自分の運用に合わせて直してから使ってください。
        </p>
        <button
          className="btn ghost"
          onClick={async () => {
            const text = processingManual({ businessName: settings.business_name, ownerName: settings.owner_name, year, inputDays, fileName });
            try {
              if (await saveAnchorFile(text, `事務処理マニュアル_${year}年.txt`)) toast("保存しました");
            } catch (e) {
              toast(`保存できませんでした：${String(e)}`, "error");
            }
          }}
        >
          <FileDown size={16} /> ひな形を保存
        </button>
      </section>
    </div>
  );
};
