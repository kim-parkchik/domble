import { expect, test } from "bun:test";
import { paginate, periodText, periodsText, ownerText } from "./printLayout";

/** ページごとの [まとまり, from, to] */
const shape = (pages: ReturnType<typeof paginate>) => pages.map((p) => ({ s: p.section, c: p.carryOf, parts: p.parts.map((x) => [x.group, x.from, x.to]) }));

test("入るだけ詰めて、入らないまとまりは次のページへ送る（まとまりは分けない）", () => {
  // 見出し 10、容量 100：10 + 30 + 30 = 70、次の 40 は入らない
  const pages = paginate([{ head: 10, rows: [[30], [15, 15], [20, 20], [30]], carry: 0 }], 100);
  expect(shape(pages)).toEqual([
    { s: 0, c: null, parts: [[0, 0, 1], [1, 0, 2]] },
    { s: 0, c: null, parts: [[2, 0, 2], [3, 0, 1]] },
  ]);
});

test("続きのページの先頭に繰越を出す（繰越の高さも数える）", () => {
  // 見出し 10・繰越 10・容量 50：1ページ目は 10+20+20=50、2ページ目からは 10+10（繰越）+20=40 で1行ずつ
  const pages = paginate([{ head: 10, rows: [[20], [20], [20], [20], [20]], carry: 10 }], 50);
  expect(shape(pages)).toEqual([
    { s: 0, c: null, parts: [[0, 0, 1], [1, 0, 1]] },
    { s: 0, c: 1, parts: [[2, 0, 1]] },
    { s: 0, c: 2, parts: [[3, 0, 1]] },
    { s: 0, c: 3, parts: [[4, 0, 1]] },
  ]);
});

test("空のページにも入らないまとまりだけ、行の途中で分ける", () => {
  const pages = paginate([{ head: 10, rows: [[20], [30, 30, 30, 30]], carry: 0 }], 100);
  expect(shape(pages)).toEqual([
    { s: 0, c: null, parts: [[0, 0, 1], [1, 0, 2]] },
    { s: 0, c: null, parts: [[1, 2, 4]] },
  ]);
});

test("区分ごとに新しいページから始める", () => {
  const pages = paginate([{ head: 10, rows: [[10]], carry: 0 }, { head: 10, rows: [[10], [10]], carry: 0 }], 100);
  expect(shape(pages)).toEqual([
    { s: 0, c: null, parts: [[0, 0, 1]] },
    { s: 1, c: null, parts: [[0, 0, 1], [1, 0, 1]] },
  ]);
});

test("1行が1ページより高いときも止まらない（そのまま1ページに置く）", () => {
  const pages = paginate([{ head: 10, rows: [[200], [10]], carry: 0 }], 100);
  expect(shape(pages)).toEqual([
    { s: 0, c: null, parts: [[0, 0, 1]] },
    { s: 0, c: null, parts: [[1, 0, 1]] },
  ]);
});

test("期間と事業者の表示", () => {
  expect(periodText("2025-01-01", "2025-12-31")).toBe("2025年1月1日〜2025年12月31日");
  expect(periodsText(2025, 1, 12)).toBe("2025年1月1日〜2025年12月31日（決算整理前）");
  expect(periodsText(2025, 1, 13)).toBe("2025年1月1日〜2025年12月31日");
  expect(periodsText(2025, 13, 13)).toBe("2025年12月31日〜2025年12月31日（決算整理仕訳のみ）");
  expect(ownerText("デザイン室", "山田 花子")).toBe("デザイン室　山田 花子");
  expect(ownerText("", "山田 花子")).toBe("山田 花子");
});
