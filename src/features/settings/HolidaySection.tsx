/**
 * 祝日・休業日（事業者設定）
 *  - 祝日：ソフトに内蔵。新しい年の分は「最新の祝日を取得」で内閣府から取得する（押したときだけ通信する）
 *  - 休業日：年末年始休業など、事業者が自分で足す
 * 営業日（土日・祝日・休業日を除く）は、スキャナ保存の入力期限の数え方に使う
 */
import { useEffect, useState } from "react";
import { CalendarPlus, Download, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppContext } from "../../context/AppContext";
import { useToast } from "../../components/Toast";
import { FullDateInput } from "../../components/Inputs";
import { longDate, todayIso } from "../../lib/format";
import { CAO_HOLIDAYS_URL, parseHolidaysCsv } from "../../lib/holidays";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** 内閣府の祝日の一覧を取得して読む（Rust 側で取得。中身は Shift_JIS） */
const fetchHolidays = async () => {
  const bytes = await invoke<number[]>("fetch_holidays_csv");
  return parseHolidaysCsv(new TextDecoder("shift_jis").decode(new Uint8Array(bytes)));
};

export const HolidaySection = () => {
  const { db, year, bump, dataVersion, can } = useAppContext();
  const toast = useToast();
  const [data, setData] = useState<repo.HolidayData | null>(null);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    repo.getHolidayData(db).then(setData).catch(console.error);
  }, [db, dataVersion]);

  if (!data) return null;
  const nextYear = Number(todayIso().slice(0, 4)) + 1;
  const thisYearHolidays = data.holidays.filter((h) => h.date.startsWith(`${year}-`));

  const fetchLatest = async () => {
    setBusy(true);
    try {
      const list = await fetchHolidays();
      await repo.saveFetchedHolidays(db, list);
      bump();
      const last = list.reduce((y, h) => Math.max(y, Number(h.date.slice(0, 4))), 0);
      toast(`内閣府から祝日を取得しました（${last}年まで）`);
    } catch (e) {
      toast(`祝日を取得できませんでした：${errText(e)}。内蔵の祝日はそのまま使えます`, "error");
    } finally {
      setBusy(false);
    }
  };

  const add = async (d: string, n: string) => {
    try {
      await repo.addCustomHoliday(db, d, n);
      bump();
    } catch (e) {
      toast(errText(e), "error");
      throw e;
    }
  };

  /** 年末年始（12/29〜1/3）をまとめて足す */
  const addNewYear = async () => {
    const days = [`${year}-12-29`, `${year}-12-30`, `${year}-12-31`, `${year + 1}-01-01`, `${year + 1}-01-02`, `${year + 1}-01-03`];
    try {
      for (const d of days) await add(d, "年末年始休業");
      toast(`${year}年末〜${year + 1}年始の休業日を足しました`);
    } catch {
      /* add で知らせている */
    }
  };

  return (
    <section className="sheet">
      <h2 className="sheet-h">祝日・休業日</h2>
      <p className="prose">
        営業日は、土日・祝日・休業日を除いて数えます（スキャナ保存の入力期限など）。祝日はソフトに入っています。
        新しい年の分は、内閣府が例年2月ごろに公表したあと「最新の祝日を取得」で足せます（押したときだけ内閣府に接続します）。
      </p>
      <p className="holiday-status">
        祝日：<b>{data.lastYear}年まで</b>
        <span className="muted">（{data.fetchedAt ? `内閣府から取得：${data.fetchedAt}` : "ソフトに内蔵"}）</span>
      </p>
      {data.lastYear < nextYear && (
        <p className="notice">来年（{nextYear}年）の祝日がまだありません。公表されていれば「最新の祝日を取得」で足してください。</p>
      )}
      <div className="voucher-actions">
        <button className="btn ghost" onClick={fetchLatest} disabled={busy || !can("settings")} title={CAO_HOLIDAYS_URL}>
          <Download size={16} /> {busy ? "取得しています…" : "最新の祝日を取得"}
        </button>
      </div>
      {thisYearHolidays.length > 0 && (
        <details className="holiday-details">
          <summary>{year}年の祝日（{thisYearHolidays.length}日）</summary>
          <ul className="holiday-list">
            {thisYearHolidays.map((h) => <li key={h.date}><span className="mono">{h.date.slice(5).replace("-", "/")}</span>{h.name}</li>)}
          </ul>
        </details>
      )}

      <h3 className="sheet-sub">休業日</h3>
      {data.custom.length === 0 ? (
        <p className="muted small">まだありません（年末年始・お盆休みなど、事業の休みの日を足せます）。</p>
      ) : (
        <ul className="holiday-list custom">
          {data.custom.map((h) => (
            <li key={h.date}>
              <span>{longDate(h.date)}</span>
              <span className="muted">{h.name}</span>
              <button
                className="icon-btn" aria-label={`${h.date} を消す`} disabled={!can("settings")}
                onClick={async () => {
                  try {
                    await repo.deleteCustomHoliday(db, h.date);
                    bump();
                  } catch (e) {
                    toast(errText(e), "error");
                  }
                }}
              ><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="holiday-add"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await add(date, name);
            setDate("");
            setName("");
          } catch {
            /* add で知らせている */
          }
        }}
      >
        <label className="field">
          <span>日付</span>
          <FullDateInput value={date} onChange={setDate} year={year} aria-label="休業日の日付" />
        </label>
        <label className="field">
          <span>名前（任意）</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="例：夏季休業" />
        </label>
        <div className="holiday-add-actions">
          <button className="btn primary" type="submit" disabled={!date || !can("settings")}><CalendarPlus size={16} /> 足す</button>
          <button className="btn ghost" type="button" onClick={addNewYear} disabled={!can("settings")}>年末年始（12/29〜1/3）を足す</button>
        </div>
      </form>
    </section>
  );
};
