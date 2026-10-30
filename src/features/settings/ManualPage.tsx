/**
 * 操作説明書（電子帳簿保存法のシステム関係書類）
 *  docs/manual の操作説明書・システム概要書を、アプリの版と一緒に持ち、画面で読む・印刷する
 *  画面や仕組みを変えたら、説明書の節も同じ変更で直す（README の開発方針）
 */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Markdown } from "../../components/Markdown";
import { parseMarkdown, plainText } from "../../lib/markdown";
import { longDate, todayIso } from "../../lib/format";
import operationMd from "../../../docs/manual/operation.md?raw";
import systemMd from "../../../docs/manual/system.md?raw";
import pkg from "../../../package.json";

type Doc = "operation" | "system";
const DOCS: Record<Doc, { label: string; source: string }> = {
  operation: { label: "操作説明書", source: operationMd },
  system: { label: "システム概要書", source: systemMd },
};

export const ManualPage = () => {
  const [doc, setDoc] = useState<Doc>("operation");
  const blocks = useMemo(() => parseMarkdown(DOCS[doc].source), [doc]);
  const toc = blocks.filter((b) => b.kind === "heading" && b.level === 2);

  return (
    <div className="page">
      <PageHeader
        title="操作説明書"
        note={`domble ver ${pkg.version} の操作説明書とシステム概要書です。電子帳簿保存法のシステム関係書類として、印刷して（または PDF に保存して）備え付けられます。`}
      >
        <div className="seg" role="tablist">
          {(Object.keys(DOCS) as Doc[]).map((d) => (
            <button key={d} role="tab" aria-selected={doc === d} className={doc === d ? "on" : ""} onClick={() => setDoc(d)}>
              {DOCS[d].label}
            </button>
          ))}
        </div>
        <button className="btn ghost" onClick={() => window.print()}>
          <Printer size={16} /> 印刷
        </button>
      </PageHeader>

      <div className="manual-layout">
        <nav className="manual-toc print-skip" aria-label="目次">
          {toc.map((h) => h.kind === "heading" && (
            <button key={h.id} className="link-btn" onClick={() => document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {plainText(h.text)}
            </button>
          ))}
        </nav>
        <article className="sheet manual-doc">
          <p className="manual-print-meta">domble ver {pkg.version}　{longDate(todayIso())} 出力</p>
          <Markdown blocks={blocks} />
        </article>
      </div>
    </div>
  );
};
