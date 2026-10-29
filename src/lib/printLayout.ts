/**
 * 帳簿の印刷（純粋関数）：印刷する中身の形と、A4 のページへの分け方
 *
 * 電子帳簿保存法施行規則2条2項2号は、帳簿を「書面に、整然とした形式及び明瞭な状態で、速やかに出力」できることを求める。
 * 一問一答（帳簿）問11 では、1つの記録が複数枚に分かれる出力は「整然とした形式」に当たらないとしている。そこで：
 *  - 行のまとまり（1つの仕訳の複数行・月計と累計など）はページをまたがせない（1ページに入りきらないときだけ行で分ける）
 *  - 区分（総勘定元帳の科目など）は新しいページから始める
 *  - 元帳は、続きのページの先頭に「前頁より繰越」の行を出す
 * 行の高さは画面で測ってから渡す（摘要の折り返しで高さが変わるため。components/PrintPreview.tsx）
 */

export type PrintAlign = "left" | "right" | "center";

export interface PrintColumn {
  label: string;
  /** 幅（ほかの列との比。表の幅いっぱいに割り振る） */
  width: number;
  align?: PrintAlign;
  /** 折り返さない（日付・番号） */
  nowrap?: boolean;
}

export interface PrintCell {
  text: string;
  /** 2行目に小さく出す文字（補助科目・税区分など） */
  note?: string;
  /** 前に小さく出す印（決算整理・削除済みなど） */
  tag?: string;
  /** 横につなぐ列の数 */
  span?: number;
  align?: PrintAlign;
}

/** 行の種類：繰越・合計など（罫線と太さを変える） */
export type PrintRowKind = "carried" | "month" | "total" | "category" | "subtotal" | "sub" | "deleted" | "first";

export interface PrintRow {
  cells: (string | PrintCell)[];
  kind?: PrintRowKind;
}

/** ページをまたがせない行のまとまり */
export interface PrintGroup {
  rows: PrintRow[];
  /** このまとまりのあとで改ページしたとき、次のページの先頭に出す行（元帳の「前頁より繰越」） */
  carry?: PrintRow;
}

/** 新しいページから始める区分（総勘定元帳の1つの科目、試算表の貸借対照表など） */
export interface PrintSection {
  /** ページの見出しに出す名前（科目名など。無ければ空） */
  heading: string;
  columns: PrintColumn[];
  groups: PrintGroup[];
}

export interface PrintDoc {
  /** 帳簿の名前（仕訳日記帳・総勘定元帳など） */
  title: string;
  /** 屋号と氏名 */
  owner: string;
  /** 期間（2025年1月1日〜2025年12月31日 など） */
  period: string;
  /** 出力日（YYYY-MM-DD） */
  printedOn: string;
  /** 絞り込みの条件（無ければ空）。見出しの下に出す */
  conditions?: string;
  sections: PrintSection[];
}

/** 測った高さ（px）。rows は区分ごと・まとまりごとの行の高さ */
export interface SectionMetrics {
  /** 表の見出しの高さ */
  head: number;
  rows: number[][];
  /** 「前頁より繰越」の行の高さ（まとまりに carry が無い区分は 0 でよい） */
  carry: number;
}

/** 1ページに出す行：まとまり group の from 行目〜to 行目の手前まで */
export interface PageSlice {
  section: number;
  parts: { group: number; from: number; to: number }[];
  /** ページの先頭に「前頁より繰越」を出すとき、その行を持つまとまりの番号 */
  carryOf: number | null;
}

/**
 * ページに分ける。capacity は1ページの表の部分に使える高さ（表の見出しを含む）。
 * まとまりは、今のページに入らなければ次のページへ送る。空のページにも入らないまとまりだけ、行の途中で分ける
 */
export const paginate = (metrics: SectionMetrics[], capacity: number): PageSlice[] => {
  const pages: PageSlice[] = [];
  metrics.forEach((m, section) => {
    let page: PageSlice = { section, parts: [], carryOf: null };
    let used = m.head;
    /** 改ページする。carryOf は次のページの先頭に繰越を出すまとまり */
    const newPage = (carryOf: number | null) => {
      pages.push(page);
      page = { section, parts: [], carryOf };
      used = m.head + (carryOf !== null ? m.carry : 0);
    };
    /** まとまり g のあとで改ページするときの繰越（区分に繰越が無ければ出さない） */
    const carryAfter = (g: number) => (g >= 0 && m.carry > 0 ? g : null);

    m.rows.forEach((heights, group) => {
      const total = heights.reduce((s, h) => s + h, 0);
      if (used + total <= capacity) {
        page.parts.push({ group, from: 0, to: heights.length });
        used += total;
        return;
      }
      // 次のページの先頭からなら入る：改ページして送る
      if (page.parts.length > 0 && m.head + (carryAfter(group - 1) !== null ? m.carry : 0) + total <= capacity) {
        newPage(carryAfter(group - 1));
        page.parts.push({ group, from: 0, to: heights.length });
        used += total;
        return;
      }
      // 空のページにも入らない：行ごとに詰める（まとまりの途中では繰越を出さない）
      let from = 0;
      heights.forEach((h, i) => {
        if (used + h > capacity && (page.parts.length > 0 || i > from)) {
          if (i > from) page.parts.push({ group, from, to: i });
          newPage(i === 0 ? carryAfter(group - 1) : null);
          from = i;
        }
        used += h;
      });
      page.parts.push({ group, from, to: heights.length });
    });
    pages.push(page);
  });
  return pages;
};

/** 期間の表示（2025年1月1日〜2025年12月31日） */
export const periodText = (from: string, to: string) => `${dateText(from)}〜${dateText(to)}`;

const dateText = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年${m}月${d}日`;
};

/** 屋号と氏名（どちらか無ければ片方） */
export const ownerText = (businessName: string, ownerName: string) => [businessName, ownerName].filter((s) => s.trim()).join("　");
