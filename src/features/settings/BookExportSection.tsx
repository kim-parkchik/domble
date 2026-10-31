/**
 * 帳簿をまとめて書き出す（事業者設定）
 * 年を選び、帳簿と証憑を1つのフォルダへ書き出す（税務調査での「ダウンロードの求め」、ほかのソフトへの乗り換え、控え）。
 *  - 年ごと：仕訳日記帳・総勘定元帳・残高試算表（1月〜決算整理）・固定資産台帳の CSV（各帳簿の画面の CSV と同じ形。lib/bookExport.ts）
 *  - 厳密モード：訂正削除履歴・変更履歴・証憑の履歴の CSV（選んだ年の分）
 *  - 証憑：取引年月日が選んだ年の証憑のファイルと証憑一覧.csv（「証憑」フォルダ）
 *  - 書き出しの内容.txt：何を書き出したかと、帳簿と証憑のつながり（伝票No）
 */
import { useEffect, useState } from "react";
import { FolderDown } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { ADJUSTMENT_PERIOD, yearEnd, yearStart } from "../../lib/accounting";
import { toCsv } from "../../lib/csv";
import { todayIso } from "../../lib/format";
import { fileLabel } from "../../lib/business";
import { bookLines, exclusiveAccountsOf } from "../../lib/taxExclusive";
import {
  assetPrintLine, assetsOfYear, JOURNAL_CSV_HEADER, journalCsvRows, journalRowsAll, ledgerCsvAll, trialCsvRows, trialLines, type BookSource,
} from "../../lib/bookExport";
import { ASSET_CSV_HEADER, assetCsvRows, LEDGER_CSV_HEADER, TRIAL_CSV_HEADER } from "../../lib/printBooks";
import { entryHistoryCsv, evidenceHistoryCsv, masterHistoryCsv } from "../books/HistoryPage";
import { writeEvidenceFolder } from "../evidence/evidenceIO";
import * as repo from "../../db/repo";
import pkg from "../../../package.json";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
const inYears = (date: string, from: number, to: number) => date.slice(0, 10) >= yearStart(from) && date.slice(0, 10) <= yearEnd(to);

export const BookExportSection = () => {
  const { db, year, settings, strict, daysOff } = useAppContext();
  const toast = useToast();
  const [years, setYears] = useState<number[]>([year]);
  const [from, setFrom] = useState(year);
  const [to, setTo] = useState(year);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    repo.getYears(db, year).then((ys) => setYears([...ys].sort((a, b) => a - b))).catch(console.error);
    setFrom(year);
    setTo(year);
  }, [db, year]);

  const run = async () => {
    const parent = await open({ directory: true, multiple: false, title: "書き出し先のフォルダを選ぶ" });
    if (typeof parent !== "string") return;
    const span = from === to ? `${from}年` : `${from}年-${to}年`;
    const dir = await join(parent, `帳簿_${fileLabel(settings)}_${span}_${todayIso().replace(/-/g, "")}`);
    const written: string[] = [];
    const put = async (name: string, header: string[], rows: Parameters<typeof toCsv>[1]) => {
      await writeTextFile(await join(dir, name), toCsv(header, rows));
      written.push(`${name}（${rows.length} 行）`);
    };
    try {
      setBusy("書き出しています…");
      await mkdir(dir, { recursive: true });
      const [counterparties, taxYears, assets, inputDays] = await Promise.all([
        repo.getCounterparties(db), repo.getTaxYears(db), repo.getAssets(db), repo.getInputPeriodDays(db),
      ]);
      for (let y = from; y <= to; y++) {
        setBusy(`${y}年を書き出しています…`);
        const [accounts, subs, raw, op, reasons] = await Promise.all([
          repo.getAccounts(db, y), repo.getSubAccounts(db, y), repo.getLines(db, yearStart(y), yearEnd(y)), repo.getOpening(db, y),
          repo.getCreateReasons(db, yearStart(y), yearEnd(y)),
        ]);
        const book: BookSource = {
          accounts, subs, counterparties, taxYears, opening: op.byAccount, subOpening: op.bySub,
          lines: bookLines(raw, taxYears, exclusiveAccountsOf(accounts)),
        };
        // 仕訳日記帳は入れたとおり（税込）に。元帳・試算表は帳簿の明細（税抜経理の年は税抜）
        await put(`${y}年_仕訳日記帳.csv`, JOURNAL_CSV_HEADER, journalCsvRows(journalRowsAll(raw, counterparties, inputDays, reasons), accounts, subs, counterparties));
        await put(`${y}年_総勘定元帳.csv`, LEDGER_CSV_HEADER, ledgerCsvAll(book, 1, ADJUSTMENT_PERIOD));
        const opts = { showSubs: true, hideZero: true };
        await put(`${y}年_残高試算表.csv`, TRIAL_CSV_HEADER, (["bs", "pl"] as const).flatMap((v) => trialCsvRows(v, trialLines(v, book, 1, ADJUSTMENT_PERIOD, opts))));
        const yearAssets = assetsOfYear(assets, y);
        if (yearAssets.length) {
          const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? "（科目なし）";
          await put(`${y}年_固定資産台帳.csv`, ASSET_CSV_HEADER, assetCsvRows(yearAssets.map(({ a, d }) => assetPrintLine(a, d, name))));
        }
      }
      // 履歴（厳密モード。選んだ年の分）
      if (strict) {
        setBusy("履歴を書き出しています…");
        const [history, masters, evHistory] = await Promise.all([repo.getHistory(db), repo.getMasterHistory(db), repo.getEvidenceHistory(db)]);
        for (const f of [
          entryHistoryCsv(history.filter((r) => inYears(r.snapshot.date, from, to))),
          masterHistoryCsv(masters.filter((r) => r.fiscal_year >= from && r.fiscal_year <= to)),
          evidenceHistoryCsv(evHistory.filter((r) => inYears(r.snapshot.txn_date, from, to))),
        ]) await put(`${f.name}.csv`, f.header, f.rows);
      }
      // 証憑（取引年月日が選んだ年のもの）
      const evidences = (await repo.getEvidences(db)).filter((e) => inYears(e.txn_date, from, to));
      if (evidences.length) {
        setBusy(`証憑 ${evidences.length} 件を書き出しています…`);
        const evDir = await join(dir, "証憑");
        await mkdir(evDir, { recursive: true });
        await writeEvidenceFolder(db, evDir, evidences, counterparties, await repo.getScanInputMethod(db), daysOff);
        written.push(`証憑（ファイル ${evidences.length} 件と 証憑一覧.csv）`);
      }
      await writeTextFile(await join(dir, "書き出しの内容.txt"), [
        `帳簿の書き出し：${fileLabel(settings)}　${span}`,
        `書き出した日：${todayIso()}　domble ver ${pkg.version}`,
        "",
        ...written.map((w) => `・${w}`),
        "",
        "CSV は各帳簿の画面の「CSV 書き出し」と同じ形です（文字コードは UTF-8）。総勘定元帳・残高試算表は1月から決算整理までです。",
        "",
        "帳簿と証憑のつながり（伝票No）",
        "・仕訳日記帳と総勘定元帳の「伝票No」は同じ番号です。総勘定元帳（補助科目ごとの行も）の1行が、どの仕訳かをたどれます。",
        ...(evidences.length
          ? ["・証憑一覧.csv の「伝票No」は、その証憑をひも付けた仕訳の番号です（何件かあれば空白で区切る）。「書き出し名」が「証憑」フォルダの中のファイル名です。"]
          : []),
      ].join("\n"));
      toast(`${span}の帳簿を書き出しました（${written.length} 項目）`);
    } catch (e) {
      toast(`書き出せませんでした：${errText(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">帳簿をまとめて書き出す</h2>
      <p className="prose">
        選んだ年の帳簿（仕訳日記帳・総勘定元帳・残高試算表・固定資産台帳の CSV）{strict && "と訂正・削除などの履歴"}、証憑のファイルと一覧を、1つのフォルダに書き出します。
        税務調査で電子データの提出（ダウンロードの求め）を受けたときや、ほかのソフトへ乗り換えるとき、年ごとの控えに使えます。
      </p>
      <div className="field-row">
        <label className="field" style={{ maxWidth: 140 }}>
          <span>はじめの年</span>
          <select className="input" value={from} onChange={(e) => { const v = Number(e.target.value); setFrom(v); if (v > to) setTo(v); }}>
            {years.map((y) => <option key={y} value={y}>{y}年</option>)}
          </select>
        </label>
        <label className="field" style={{ maxWidth: 140 }}>
          <span>おわりの年</span>
          <select className="input" value={to} onChange={(e) => { const v = Number(e.target.value); setTo(v); if (v < from) setFrom(v); }}>
            {years.map((y) => <option key={y} value={y}>{y}年</option>)}
          </select>
        </label>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn ghost" onClick={run} disabled={!!busy}>
            <FolderDown size={16} /> フォルダを選んで書き出す
          </button>
        </div>
      </div>
      {busy && <p className="field-note" role="status">{busy}</p>}
    </section>
  );
};
