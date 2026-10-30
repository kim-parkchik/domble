/**
 * 帳簿の印刷プレビュー
 * 中身（PrintDoc）を A4 縦（列の多い表は横）のページに分けて並べ、「印刷」で印刷ダイアログを開く（macOS では「PDF として保存」もここから）。
 *  - 各ページに帳簿の名前・屋号と氏名・期間・科目・ページ番号・出力日、表の見出しを繰り返す
 *  - 行の高さは、ページと同じ幅の見えない表に一度並べて測ってから分ける（摘要の折り返しで高さが変わるため）。分け方は lib/printLayout.ts
 * 印刷するときは、画面（#root）を隠してこのページだけを出す（styles/global.css の「帳簿の印刷」）
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Printer, X } from "lucide-react";
import { paginate, type PageSlice, type PrintCell, type PrintColumn, type PrintDoc, type PrintRow, type PrintSection } from "../lib/printLayout";

/** 測った高さの誤差のための余白（px） */
const SLACK = 3;

interface Props {
  /** 印刷する中身（読み込み中は null） */
  doc: PrintDoc | null;
  onClose: () => void;
  /** 道具の帯に出す選択肢（対象の科目など） */
  children?: ReactNode;
}

export const PrintPreview = ({ doc, onClose, children }: Props) => {
  const measureRef = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<{ doc: PrintDoc; pages: PageSlice[] } | null>(null);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    document.body.classList.add("pp-printing");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("pp-printing");
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // 中身が変わるたびに、測ってページに分け直す
  useEffect(() => {
    if (!doc) return;
    let alive = true;
    (async () => {
      await document.fonts?.ready;
      const root = measureRef.current;
      if (!alive || !root) return;
      const capacity = root.querySelector(".pp-body")!.getBoundingClientRect().height - SLACK;
      const metrics = doc.sections.map((sec, i) => {
        const table = root.querySelector(`[data-section="${i}"]`)!;
        const trs = [...table.querySelectorAll("tbody > tr")];
        const h = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().height : 0);
        let k = 0;
        return {
          head: h(table.querySelector("thead")),
          rows: sec.groups.map((g) => g.rows.map(() => h(trs[k++]))),
          carry: h(table.querySelector("tfoot > tr")),
        };
      });
      if (alive) setLaid({ doc, pages: paginate(metrics, capacity) });
    })();
    return () => {
      alive = false;
    };
  }, [doc]);

  const pages = laid?.pages ?? [];
  const landscape = !!doc?.landscape;
  const pageClass = `pp-page${landscape ? " pp-landscape" : ""}`;
  return createPortal(
    <div className="pp-overlay" role="dialog" aria-modal="true" aria-label={`印刷プレビュー：${doc?.title ?? ""}`}>
      <style>{`@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 0; }`}</style>
      <div className="pp-toolbar">
        <h2>印刷プレビュー{doc ? `：${doc.title}` : ""}</h2>
        {children}
        <div className="spacer" />
        <span className="pp-count">{laid && laid.doc === doc ? `${pages.length} ページ（A4 ${landscape ? "横" : "縦"}）` : "ページに分けています…"}</span>
        <button className="btn ghost pp-close" onClick={onClose}><X size={16} /> 閉じる</button>
        <button className="btn primary" onClick={() => window.print()} disabled={!laid || laid.doc !== doc}><Printer size={16} /> 印刷</button>
      </div>

      {doc && (
        <div className="pp-measure" ref={measureRef} aria-hidden="true">
          <div className={pageClass}>
            <PageHead doc={doc} heading="見出し" page={1} total={1} />
            <div className="pp-body" />
          </div>
          {doc.sections.map((sec, i) => (
            <div className={`pp-measure-table${landscape ? " pp-landscape" : ""}`} key={i}>
              <SectionTable section={sec} rows={sec.groups.flatMap((g) => g.rows)} carry={sec.groups.find((g) => g.carry)?.carry} index={i} />
            </div>
          ))}
        </div>
      )}

      {!laid ? (
        <p className="pp-loading">準備しています…</p>
      ) : (
        <div className="pp-pages">
          {laid.pages.map((p, n) => {
            const sec = laid.doc.sections[p.section];
            const carry = p.carryOf !== null ? sec.groups[p.carryOf].carry : undefined;
            const rows = [...(carry ? [carry] : []), ...p.parts.flatMap((x) => sec.groups[x.group].rows.slice(x.from, x.to))];
            return (
              <div className={pageClass} key={n}>
                <PageHead doc={laid.doc} heading={sec.heading} page={n + 1} total={laid.pages.length} />
                <div className="pp-body">
                  <SectionTable section={sec} rows={rows} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
};

const PageHead = ({ doc, heading, page, total }: { doc: PrintDoc; heading: string; page: number; total: number }) => (
  <div className="pp-head">
    <div className="pp-head-top">
      <span className="pp-owner">{doc.owner}</span>
      <h1>{doc.title}</h1>
      <span>{page} / {total} ページ</span>
    </div>
    <div className="pp-head-sub">
      <span className="pp-heading">{heading}</span>
      <span>{doc.period}</span>
      <span>出力日 {doc.printedOn.replace(/-/g, "/")}</span>
    </div>
    {doc.conditions && <div className="pp-conditions">条件：{doc.conditions}</div>}
  </div>
);

const cellClass = (a: PrintColumn["align"], nowrap?: boolean) =>
  [a === "right" ? "pp-r" : a === "center" ? "pp-c" : "", nowrap ? "pp-nw" : ""].filter(Boolean).join(" ") || undefined;

const Row = ({ row, columns }: { row: PrintRow; columns: PrintColumn[] }) => {
  let col = 0;
  return (
    <tr className={row.kind ? `pp-${row.kind}` : undefined}>
      {row.cells.map((c, i) => {
        const cell: PrintCell = typeof c === "string" ? { text: c } : c;
        const column = columns[col];
        col += cell.span ?? 1;
        return (
          <td key={i} colSpan={cell.span} className={cellClass(cell.align ?? column?.align, !cell.span && column?.nowrap)}>
            {cell.tag && <span className="pp-tag">{cell.tag}</span>}
            {cell.text}
            {cell.note && <span className="pp-note">{cell.note}</span>}
          </td>
        );
      })}
    </tr>
  );
};

/** 区分の表。測るとき（index あり）は、繰越の行を tfoot に1つ置いて高さを測る */
const SectionTable = ({ section, rows, carry, index }: { section: PrintSection; rows: PrintRow[]; carry?: PrintRow; index?: number }) => {
  const total = section.columns.reduce((s, c) => s + c.width, 0);
  return (
    <table className="pp-table" data-section={index}>
      <colgroup>
        {section.columns.map((c, i) => <col key={i} style={{ width: `${(c.width / total) * 100}%` }} />)}
      </colgroup>
      <thead>
        <tr>{section.columns.map((c, i) => <th key={i}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => <Row key={i} row={r} columns={section.columns} />)}
      </tbody>
      {carry && (
        <tfoot>
          <Row row={carry} columns={section.columns} />
        </tfoot>
      )}
    </table>
  );
};
