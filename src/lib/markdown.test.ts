import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseInline, parseMarkdown, plainText, type Block } from "./markdown";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "../..", path), "utf8");

describe("説明書の Markdown の読み取り", () => {
  test("見出し・段落（改行はそのまま）・表", () => {
    const b = parseMarkdown("# 題\n\n1行目\n2行目\n\n## 節\n\n| 画面 | 内容 |\n|---|---|\n| ホーム | **売上** |\n");
    expect(b).toEqual([
      { kind: "heading", level: 1, text: "題", id: "md-0" },
      { kind: "paragraph", text: "1行目\n2行目" },
      { kind: "heading", level: 2, text: "節", id: "md-2" },
      { kind: "table", head: ["画面", "内容"], rows: [["ホーム", "**売上**"]] },
    ]);
  });

  test("箇条書き：2文字下げで入れ子、項目でない下げた行は前の項目の続き。番号つきも", () => {
    const b = parseMarkdown("- 上\n  - 下1\n  - 下2\n- 次\n  続き\n\n1. 一\n2. 二\n");
    expect(b).toEqual([
      {
        kind: "list",
        list: {
          kind: "ul",
          items: [
            { text: "上", children: { kind: "ul", items: [{ text: "下1", children: null }, { text: "下2", children: null }] } },
            { text: "次\n続き", children: null },
          ],
        },
      },
      { kind: "list", list: { kind: "ol", items: [{ text: "一", children: null }, { text: "二", children: null }] } },
    ]);
  });

  test("太字とコード。印の無い * はそのまま", () => {
    expect(parseInline("**登録する**（`⌘ + Enter`）で 2 * 3")).toEqual([
      { kind: "bold", text: "登録する" },
      { kind: "text", text: "（" },
      { kind: "code", text: "⌘ + Enter" },
      { kind: "text", text: "）で 2 * 3" },
    ]);
    expect(plainText("**締める** を押す")).toBe("締める を押す");
  });
});

describe("docs/manual の説明書", () => {
  const operation = parseMarkdown(read("docs/manual/operation.md"));
  const system = parseMarkdown(read("docs/manual/system.md"));
  const headings = (b: Block[]) => b.flatMap((x) => (x.kind === "heading" ? [x.text] : []));

  test("どちらも題で始まる", () => {
    expect(headings(operation)[0]).toBe("domble 操作説明書");
    expect(headings(system)[0]).toBe("domble システム概要書");
  });

  test("電子帳簿保存法で求められる操作の節がある", () => {
    for (const h of ["全体の流れ", "日々の入力", "訂正・削除", "検索", "帳簿の出力（画面・印刷・CSV）", "締め", "バックアップ"]) {
      expect(headings(operation)).toContain(h);
    }
  });

  test("左のメニューの画面は、すべて「画面の一覧」にある（画面を足したら説明書も直す）", () => {
    const labels = [...read("src/App.tsx").matchAll(/\{ id: "\w+", label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(15);
    const at = operation.findIndex((x) => x.kind === "heading" && x.text === "画面の一覧");
    const table = operation.slice(at).find((x) => x.kind === "table");
    const listed = table?.kind === "table" ? table.rows.map((r) => r[0]) : [];
    expect(listed.sort()).toEqual([...labels].sort());
  });
});
