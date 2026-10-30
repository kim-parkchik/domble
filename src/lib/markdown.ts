/**
 * 操作説明書・システム概要書（docs/manual の Markdown）を画面に出すための、小さな Markdown の読み取り
 *  説明書で使う書き方だけに絞っている：見出し（# 〜 ###）・段落・箇条書き（- と 1.。2文字下げで入れ子）・表・太字（**）・コード（`）
 *  段落と箇条書きの中の改行は、そのまま改行にする（1行に1文で書いているため）
 */

export type Inline = { kind: "text" | "bold" | "code"; text: string };
export type ListItem = { text: string; children: MdList | null };
export type MdList = { kind: "ul" | "ol"; items: ListItem[] };
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; list: MdList }
  | { kind: "table"; head: string[]; rows: string[][] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE = /^\s*\|/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** 箇条書き：同じ下げの項目を並べ、深く下げた項目は直前の項目の入れ子にする。項目でない下げた行は直前の項目の続き */
const parseList = (lines: string[], from: number): [MdList, number] => {
  const first = ITEM.exec(lines[from])!;
  const indent = first[1].length;
  const list: MdList = { kind: /\d/.test(first[2]) ? "ol" : "ul", items: [] };
  let i = from;
  while (i < lines.length) {
    const last = list.items[list.items.length - 1];
    const m = ITEM.exec(lines[i]);
    if (m) {
      if (m[1].length < indent) break;
      if (m[1].length > indent && last) {
        const [child, next] = parseList(lines, i);
        last.children = child;
        i = next;
        continue;
      }
      list.items.push({ text: m[3], children: null });
      i++;
      continue;
    }
    if (last && /^\s+\S/.test(lines[i])) {
      last.text += `\n${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  return [list, i];
};

export const parseMarkdown = (source: string): Block[] => {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length as 1 | 2 | 3, text: h[2].trim(), id: `md-${blocks.length}` });
      i++;
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const [list, next] = parseList(lines, i);
      blocks.push({ kind: "list", list });
      i = next;
      continue;
    }
    if (TABLE.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && TABLE.test(lines[i])) rows.push(lines[i++]);
      const body = rows.slice(1).filter((r) => !TABLE_RULE.test(r));
      blocks.push({ kind: "table", head: cells(rows[0]), rows: body.map(cells) });
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return blocks;
};

/** 1行の中の太字とコード */
export const parseInline = (text: string): Inline[] =>
  text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .filter((s) => s !== "")
    .map((s): Inline =>
      s.length > 4 && s.startsWith("**") && s.endsWith("**")
        ? { kind: "bold", text: s.slice(2, -2) }
        : s.length > 2 && s.startsWith("`") && s.endsWith("`")
          ? { kind: "code", text: s.slice(1, -1) }
          : { kind: "text", text: s },
    );

/** 太字などの印を外した文字（目次や確かめに使う） */
export const plainText = (text: string) => parseInline(text).map((x) => x.text).join("");
