/**
 * 銀行が公式に公開している明細の形式：見分け方と読み方（ゆうちょダイレクト・ゆうちょBizダイレクト・三菱UFJ銀行 BizSTATION・全銀協の固定長）
 * 例の中身は、それぞれの公開資料の見本・項目の並びに合わせた架空の明細
 */
import { describe, expect, test } from "bun:test";
import { parseCsv } from "./csv";
import { columnMapProblem, guessColumns, parseColumnMap, parseStatement } from "./bankImport";
import { BANK_FORMATS, detectFormat, mapForFormat, statementTable, warekiYymmdd, zenginToTable } from "./bankFormats";

const bank = { normal_side: "debit" as const };
const read = (text: string, year = 2026) => {
  const map = detectFormat(statementTable(text, parseCsv));
  if (!map) throw new Error("形式を見分けられない");
  return { map, parsed: parseStatement(text, map, bank, year) };
};

describe("ゆうちょダイレクト", () => {
  // 口座の情報の行のあとに見出し（ゆうちょダイレクトの操作ガイドの CSV の見本と同じ並び）
  const csv = [
    "お客さま口座情報", "現在高:,151432,円", "出力日時:平成27年10月31日11時57分", "お客さま口座番号:00000-00000000", "照会対象:平成27年9月1日～平成27年10月31日", "明細件数:3",
    "取引日,入出金明細ID,受入金額（円）,払出金額（円）,詳細１,詳細２,現在（貸付）高",
    "20150901,201509010000001,50000,,カード,,151432",
    "20150901,201509010000002,,10000,通帳,ゆうちょ 二郎,141432",
    "20150905,201509050000001,,5000,カード,ゆうちょ 一郎,136432",
  ].join("\r\n");
  test("見出しで見分け、受入・払出の列、詳細1・詳細2を摘要に、現在（貸付）高を残高に", () => {
    const { map, parsed } = read(csv);
    expect(map).toMatchObject({ format: "yucho-direct", headerRow: 6, mode: "split" });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lines.map((l) => [l.date, l.description, l.side, l.amount, l.balance])).toEqual([
      ["2015-09-01", "カード", "debit", 50000, 151432],
      ["2015-09-01", "通帳 ゆうちょ 二郎", "credit", 10000, 141432],
      ["2015-09-05", "カード ゆうちょ 一郎", "credit", 5000, 136432],
    ]);
    expect(parsed.balanceCheck).toMatchObject({ compared: 2, matched: 2 });
  });
});

describe("ゆうちょBizダイレクト", () => {
  // 18.4 ファイル出力時のファイル仕様の項目の並び。新しい順
  const csv = [
    "取引日,入出金区分,取引内容,送金人名等,受入明細番号,取扱口数,取引金額,現在（貸付）高,EDI情報等",
    "2026/01/20,払出,送金,カ）マルマル,,,30000,170000,",
    "2026/01/10,受入,振込,ヤマダ タロウ,0001,1,100000,200000,",
  ].join("\n");
  test("入出金区分（受入・払出）と取引金額。取引内容と送金人名等を摘要に。新しい順でも残高と合う", () => {
    const { map, parsed } = read(csv);
    expect(map).toMatchObject({ format: "yucho-biz", mode: "kind" });
    expect(parsed.lines.map((l) => [l.date, l.description, l.side, l.amount])).toEqual([
      ["2026-01-20", "送金 カ）マルマル", "credit", 30000],
      ["2026-01-10", "振込 ヤマダ タロウ", "debit", 100000],
    ]);
    expect(parsed.balanceCheck).toMatchObject({ compared: 1, matched: 1, reversed: 0 });
  });
});

describe("三菱UFJ銀行 BizSTATION", () => {
  // 入出金明細（CSV形式）出力フォーマット：見出しは決まった名前、各項目は " で挟む、取引日は和暦 YYMMDD、入払区分は 1 入金・2 出金
  const head = ["金融機関コード", "金融機関名", "支店コード", "支店名", "科目", "口座番号", "口座名", "取引日", "入払区分", "取引区分", "取引金額", "内他店券金額",
    "手形・小切手区分", "手形・小切手番号", "振込依頼人番号", "振込依頼人名", "仕向金融機関名", "仕向支店名", "摘要", "EDI情報"];
  const row = (date: string, kind: string, amount: string, sender: string, memo: string) =>
    ["0005", "ﾐﾂﾋﾞｼﾕ-ｴﾌｼﾞｴｲ   ", "001", "ﾎﾝﾃﾝ", "1", "0001234567", "ﾃｽﾄ ｼﾖｳﾃﾝ", date, kind, "11", amount, "000000000000", "", "", "", sender, "", "", memo, ""];
  const csv = [head, row("080105", "1", "000000110000", "ﾔﾏﾀﾞ ﾀﾛｳ", "ﾌﾘｺﾐ"), row("080131", "2", "000000033000", "", "ﾃﾞﾝｷﾀﾞｲ")]
    .map((r) => r.map((c) => `"${c}"`).join(",")).join("\r\n");
  test("和暦の取引日と入払区分。摘要と振込依頼人名を摘要に", () => {
    const { map, parsed } = read(csv);
    expect(map).toMatchObject({ format: "mufg-biz", mode: "kind", dateStyle: "wareki6" });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lines.map((l) => [l.date, l.description, l.side, l.amount])).toEqual([
      ["2026-01-05", "ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ", "debit", 110000],
      ["2026-01-31", "ﾃﾞﾝｷﾀﾞｲ", "credit", 33000],
    ]);
  });
  test("見出しからの推測だけだと入払区分を金額の列と取り違えないよう、区分の列として読む", () => {
    const g = guessColumns(parseCsv(csv))!;
    expect(g.mode).toBe("kind");
  });
});

describe("全銀協の入出金取引明細（固定長）", () => {
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  const num = (v: number | string, n: number) => String(v).padStart(n, "0");
  const header = pad(`103` + `0` + `080201` + `080101` + `080131` + `0144` + pad("ﾎｸﾘｸ", 15) + `001` + pad("ﾎﾝﾃﾝ", 15) + `000` + `1` + num(1234567, 10) + pad("ﾃｽﾄ", 40) + `1` + ` ` + num(500000, 14), 200);
  const data = (no: number, date: string, kind: string, amount: number, sender: string, memo: string) =>
    pad(`2` + num(no, 8) + date + date + kind + `11` + num(amount, 12) + num(0, 12) + "000000" + "000000" + "0" + "0000000" + "000" + num(0, 10) + pad(sender, 48) + pad("", 15) + pad("", 15) + pad(memo, 20) + pad("", 20), 200);
  const trailer = pad(`8` + num(1, 6) + num(80000, 13) + num(1, 6) + num(5500, 13) + `1` + num(574500, 14) + num(2, 7), 200);
  const end = pad(`9` + num(4, 10) + num(1, 5), 200);
  const records = [header, data(1, "080110", "1", 80000, "ﾔﾏﾀﾞ ﾀﾛｳ", "ﾌﾘｺﾐ"), data(2, "080125", "2", 5500, "", "ﾃｽｳﾘﾖｳ"), trailer, end];
  test("改行あり・なしのどちらも、データレコードだけを表にする", () => {
    for (const text of [records.join("\r\n"), records.join("")]) {
      const t = zenginToTable(text)!;
      expect(t.accounts).toBe(1);
      expect(t.rows).toHaveLength(3);
      const { map, parsed } = read(text);
      expect(map.format).toBe("zengin");
      expect(parsed.lines.map((l) => [l.date, l.description, l.side, l.amount])).toEqual([
        ["2026-01-10", "ﾌﾘｺﾐ ﾔﾏﾀﾞ ﾀﾛｳ", "debit", 80000],
        ["2026-01-25", "ﾃｽｳﾘﾖｳ", "credit", 5500],
      ]);
    }
  });
  test("固定長でないもの・入出金取引明細でないもの（種別コードが違う）は null", () => {
    expect(zenginToTable("日付,金額\n2026/01/05,100")).toBeNull();
    expect(zenginToTable([`121` + header.slice(3), ...records.slice(1)].join("\n"))).toBeNull();
  });
});

describe("読み方", () => {
  test("和暦の YYMMDD：令和（令和の年が今の年の次を超えれば平成）", () => {
    expect(warekiYymmdd("080105", 2026)).toBe("2026-01-05");
    expect(warekiYymmdd("010501", 2026)).toBe("2019-05-01");
    expect(warekiYymmdd("310430", 2026)).toBe("2019-04-30");
    expect(warekiYymmdd("090105", 2026)).toBe("2027-01-05");
    expect(warekiYymmdd("080230", 2026)).toBeNull();
    expect(warekiYymmdd("2026/01/05", 2026)).toBeNull();
  });
  test("形式を選び直す：見出しが足りなければ null", () => {
    const yucho = BANK_FORMATS.find((f) => f.id === "yucho-direct")!;
    expect(mapForFormat(yucho, parseCsv("日付,摘要,金額\n2026/1/5,a,1"))).toBeNull();
  });
  test("区分の列：入金・出金を表す値に無い値は問題。保存した対応を読み直せる", () => {
    const csv = "日付,入出金区分,金額,摘要\n2026/1/5,入金,1000,a\n2026/1/6,不明,500,b";
    const g = guessColumns(parseCsv(csv))!;
    expect(g).toMatchObject({ mode: "kind", kind: 1, amount: 2 });
    const p = parseStatement(csv, g, bank, 2026);
    expect(p.lines.map((l) => l.side)).toEqual(["debit"]);
    expect(p.problems[0].message).toMatch(/入払区分を読めません：不明/);
    expect(parseColumnMap(JSON.stringify(g))).toMatchObject({ mode: "kind", kind: 1, kindIncrease: expect.arrayContaining(["入金"]) });
    expect(columnMapProblem({ ...g, kind: null })).toMatch(/入払区分の列/);
  });
});
