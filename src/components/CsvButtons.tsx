/**
 * CSV の書き出し・取り込みのボタン（期首残高・勘定科目・補助科目・取引先の一覧。lib/masterCsv.ts）
 * 取り込みはファイルを選んで文字を読み（UTF-8・Shift_JIS）、onText に渡す。問題は CsvIssues で行番号つきで出す
 */
import { useRef } from "react";
import { Download, Upload } from "lucide-react";
import { decodeText } from "../lib/evidence";
import type { CsvIssue } from "../lib/masterCsv";

export const CsvImportButton = ({ label, onText, disabled }: { label: string; onText: (text: string, fileName: string) => void; disabled?: boolean }) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => input.current?.click()} disabled={disabled}><Upload size={14} /> {label}</button>
      <input
        ref={input} type="file" accept=".csv,text/csv" hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onText(decodeText(new Uint8Array(await f.arrayBuffer())), f.name);
        }}
      />
    </>
  );
};

export const CsvExportButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="btn ghost sm" onClick={onClick}><Download size={14} /> {label}</button>
);

/** 取り込めなかったわけ（行番号つき） */
export const CsvIssues = ({ issues, onClose }: { issues: CsvIssue[]; onClose: () => void }) =>
  issues.length === 0 ? null : (
    <div className="notice csv-issues" role="alert">
      <p>{issues.length} か所に問題があるため、取り込んでいません。CSV を直してから、もう一度選んでください。</p>
      <ul>{issues.slice(0, 50).map((x, i) => <li key={i}>{x.row}行目：{x.message}</li>)}</ul>
      {issues.length > 50 && <p className="muted small">ほか {issues.length - 50} か所</p>}
      <button type="button" className="link-btn" onClick={onClose}>閉じる</button>
    </div>
  );
