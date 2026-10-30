import { Fragment } from "react";
import { parseInline, type Block, type MdList } from "../lib/markdown";

/** 改行は改行として、太字とコードはそのまま出す */
const Inlines = ({ text }: { text: string }) => (
  <>
    {text.split("\n").map((line, i) => (
      <Fragment key={i}>
        {i > 0 && <br />}
        {parseInline(line).map((x, j) =>
          x.kind === "bold" ? <b key={j}>{x.text}</b> : x.kind === "code" ? <code key={j}>{x.text}</code> : <Fragment key={j}>{x.text}</Fragment>,
        )}
      </Fragment>
    ))}
  </>
);

const List = ({ list }: { list: MdList }) => {
  const items = list.items.map((it, i) => (
    <li key={i}>
      <Inlines text={it.text} />
      {it.children && <List list={it.children} />}
    </li>
  ));
  return list.kind === "ol" ? <ol>{items}</ol> : <ul>{items}</ul>;
};

/** lib/markdown.ts で読み取った説明書を出す */
export const Markdown = ({ blocks }: { blocks: Block[] }) => (
  <div className="md">
    {blocks.map((b, i) => {
      switch (b.kind) {
        case "heading": {
          const H = `h${b.level}` as const;
          return <H key={i} id={b.id}><Inlines text={b.text} /></H>;
        }
        case "paragraph":
          return <p key={i}><Inlines text={b.text} /></p>;
        case "list":
          return <List key={i} list={b.list} />;
        case "table":
          return (
            <table key={i}>
              <thead>
                <tr>{b.head.map((c, j) => <th key={j}><Inlines text={c} /></th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inlines text={c} /></td>)}</tr>)}
              </tbody>
            </table>
          );
      }
    })}
  </div>
);
