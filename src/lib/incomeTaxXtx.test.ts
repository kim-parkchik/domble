import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildIncomeTaxXtx, incomeXtxNotices, incomeXtxProblems, incomeXtxVersionFor, myNumberPersons, type IncomeTaxXtxSource } from "./incomeTaxXtx";
import { computeIncomeTax, EMPTY_INCOME_TAX_INPUT, emptyRelative, type BusinessFigures, type IncomeTaxInput } from "./incomeTax";
import type { BlueStatement, DepreciationLine, PayLine } from "./blueStatement";
import type { StatementRow } from "./statementLines";
import type { EtaxFiler } from "./etax";

const XSD = resolve(import.meta.dir, "../../spec/etax/shotoku/RKO0010-250.xsd");
const dir = mkdtempSync(join(tmpdir(), "domble-it-xtx-"));
let n = 0;
/** xmllint で手続 RKO0010 の XSD に照らす。合っていなければエラーの内容 */
const validate = (xml: string) => {
  const file = join(dir, `t${n++}.xtx`);
  writeFileSync(file, xml);
  const p = Bun.spawnSync(["xmllint", "--noout", "--schema", XSD, file]);
  return p.exitCode === 0 ? "" : p.stderr.toString();
};
const val = (xml: string, t: string) => xml.match(new RegExp(`<${t}>(?:<kubun_CD>)?([^<]*)<`))?.[1];
const count = (xml: string, t: string) => xml.split(`<${t}>`).length - 1;

const filer: EtaxFiler = {
  userId: "1234567890123456", officeCode: "01141", officeName: "渋谷", name: "山田 太郎", nameKana: "ヤマダ タロウ", yago: "山田デザイン", yagoKana: "ヤマダデザイン",
  postalCode: "150-0002", address: "東京都渋谷区渋谷1-2-3", phone: "03-1234-5678", myNumber: "", occupation: "デザイナー", householderName: "山田 太郎",
  householderRelation: "本人", jan1Address: "", refund: { kind: "bank", bankName: "みずほ", bankKind: "1", branchName: "渋谷", branchKind: "2", depositKind: "1", accountNo: "1234567" },
  birthday: "", agent: null,
};

const row = (label: string, amount: number, extra = false, opening = 0): StatementRow => ({ label, extra, opening, amount, accountIds: [] });
const pay = (name: string, total: number, o: Partial<PayLine> = {}): PayLine => ({ name, relation: "", age: 30, months: 12, work: "", salary: total, bonus: 0, total, tax: 0, ...o });
const dep = (name: string, d: number): DepreciationLine => ({
  name, quantity: "1台", acquired: "2025-04", cost: d * 4, method: "定額法", life: 4, rate: 0.25, months: 9, depreciation: d, businessRate: 100, business: d, closing: d * 3, memo: "",
});

/** 売上 500万・経費 100万（うち減価償却費・給料賃金）・所得 400万の決算書 */
const statement = (o: Partial<BlueStatement> = {}): BlueStatement => ({
  pl: { revenue: 5_000_000, cogs: 0, grossProfit: 5_000_000, expenses: 1_000_000, beforeSpecial: 4_000_000, special: 0, income: 4_000_000 },
  layout: {
    sections: {
      cogs: [], addition: [row("専従者給与", 0), row("貸倒引当金", 0)], reversal: [row("貸倒引当金", 0)],
      expense: [row("減価償却費", 300_000), row("給料賃金", 600_000), row("雑費", 50_000), row("新聞図書費", 50_000, true)],
      asset: [row("現金", 200_000, false, 100_000), row("その他の預金", 4_850_000, false, 1_000_000), row("事業主貸", 0), row("ソフトウエア", 50_000, true, 0)],
      liability: [row("事業主借", 0), row("元入金", 1_100_000, false, 1_100_000)],
    },
    warnings: [],
  },
  deduction: 650_000,
  monthly: { sales: Array(12).fill(0).map((_, i) => (i === 11 ? 5_000_000 - 11 * 400_000 : 400_000)), purchases: Array(12).fill(0), householdUse: 0, miscIncome: 0 },
  salaries: [], family: [], interest: [], fees: [], rent: [], depreciation: [], special: "",
  ...o,
});

const biz: BusinessFigures = { revenue: 5_000_000, incomeBeforeBlue: 4_000_000, filingType: "blue65", familySalary: 0 };
const source = (input: Partial<IncomeTaxInput> = {}, o: Partial<IncomeTaxXtxSource> = {}): IncomeTaxXtxSource => {
  const x = { ...EMPTY_INCOME_TAX_INPUT, birthday: "1985-06-01", ...input };
  const b = o.biz ?? biz;
  return {
    year: 2025, filer, input: x, result: computeIncomeTax(x, b, 2025), biz: b, statement: statement(), bookKeeping: 2, numbers: {}, createdOn: "2026-02-20",
    settings: { address: filer.address, phone: filer.phone, office_address: "", office_phone: "", union_name: "" },
    ...o,
  };
};

describe("令和7年分の所得税の xtx（申告書＋青色申告決算書）", () => {
  const src = source({ socialInsurance: [{ kind: "国民年金", amount: 210_120 }] }, { numbers: { self: "123456789018" } });
  const xml = buildIncomeTaxXtx(src);
  test("手続 RKO0010 の XSD に合う", () => expect(validate(xml)).toBe(""));
  test("手続・様式の版、IT部の年分・生年月日・個人番号", () => {
    expect(xml).toContain('<RKO0010 VR="25.0.1" id="RKO0010">');
    expect(xml).toContain('<KOA020 VR="23.0" id="KOA020-1"');
    expect(xml).toContain('<KOA210 VR="11.0" id="KOA210-1"');
    expect(xml).toContain('<NENBUN ID="NENBUN"><gen:era>5</gen:era><gen:yy>7</gen:yy></NENBUN>');
    expect(xml).toContain('<BIRTHDAY ID="BIRTHDAY"><gen:era>3</gen:era><gen:yy>60</gen:yy><gen:mm>6</gen:mm><gen:dd>1</gen:dd></BIRTHDAY>');
    expect(xml).toContain("<gen:kojinbango>123456789018</gen:kojinbango>");
    expect(xml).not.toContain("KAZEI_KIKAN");
  });
  test("第一表の数字は申告書の計算と同じ", () => {
    const v = (no: string) => String(src.result.rows.find((r) => r.no === no)!.value);
    expect(val(xml, "ABB00030")).toBe("5000000");
    expect(val(xml, "ABB00300")).toBe(v("①"));
    expect(val(xml, "ABB00550")).toBe(v("㉕"));
    expect(val(xml, "ABB00580")).toBe(v("㉛"));
    expect(val(xml, "ABB01030")).toBe(v("㊻"));
    expect(val(xml, "ABB00750")).toBe(v("(52)"));
    expect(val(xml, "ABB00025")).toBe("2"); // 会計ソフトで記帳
    expect(val(xml, "ABA00240")).toBe("1"); // 青色申告
  });
  test("決算書：損益計算書・月別売上・貸借対照表", () => {
    expect(val(xml, "AMF00290")).toBe("300000");
    expect(val(xml, "AMF00060")).toBe("新聞図書費");
    expect(val(xml, "AMF00500")).toBe("4000000");
    expect(val(xml, "AMF00530")).toBe("3350000");
    expect(val(xml, "AMF00980")).toBe("5000000");
    expect(val(xml, "AMG00030")).toBe("ソフトウエア");
    expect(val(xml, "AMG00440")).toBe("5100000");
    expect(val(xml, "AMG00760")).toBe(String(1_100_000 + 4_000_000));
  });
  test("保険料は、給与が無ければ全部「うち年末調整等以外」", () => {
    expect(val(xml, "ABH00140")).toBe("210120");
    expect(val(xml, "ABH00580")).toBe("210120");
  });
});

describe("明細の行が様式より多いとき", () => {
  const many = <T,>(k: number, f: (i: number) => T) => Array.from({ length: k }, (_, i) => f(i));
  const src = source(
    {
      businessWithholding: many(6, (i) => ({ item: "原稿料", payer: `出版社${i + 1}`, payerId: "東京都千代田区1-1", income: 1_000_000 - i * 10_000, withheld: 102_100 - i * 1_021 })),
      socialInsurance: [{ kind: "国民健康保険", amount: 300_000 }, { kind: "国民年金", amount: 210_120 }, { kind: "介護保険", amount: 40_000 }],
      smallBusiness: [{ kind: "小規模企業共済", amount: 120_000 }],
    },
    {
      statement: statement({
        salaries: many(6, (i) => pay(`従業員${i + 1}`, 100_000)),
        depreciation: many(9, (i) => dep(`資産${i + 1}`, 10_000 + i)),
        rent: many(3, (i) => ({ name: `大家${i + 1}`, address: "東京都", gross: 120_000, business: 120_000, extra: 0, property: "倉庫" })),
      }),
    },
  );
  const xml = buildIncomeTaxXtx(src);
  test("XSD に合う", () => expect(validate(xml)).toBe(""));
  test("所得の内訳は4行、残りは次葉合計。源泉徴収税額の合計は全部の行", () => {
    expect(count(xml, "ABD00010")).toBe(4);
    expect(val(xml, "ABD00066")).toBe(String(102_100 - 4 * 1_021 + 102_100 - 5 * 1_021));
    const total = src.input.businessWithholding.reduce((s, r) => s + r.withheld, 0);
    expect(val(xml, "ABD00070")).toBe(String(total));
    expect(val(xml, "ABB00710")).toBe(String(total)); // ㊾ ＝ 第二表の源泉徴収税額の合計額
  });
  test("社会保険料・小規模企業共済等掛金は3行、残りは「その他」", () => {
    expect(count(xml, "ABH00120")).toBe(3);
    expect(xml).toContain("<ABH00130>その他</ABH00130><ABH00140>160000</ABH00140>");
  });
  test("給料賃金は4人、残りは「その他」の欄（人数・延べ従事月数）", () => {
    expect(count(xml, "AMF01080")).toBe(4);
    expect(val(xml, "AMF01180")).toBe("2");
    expect(val(xml, "AMF01190")).toBe("24");
    expect(val(xml, "AMF01260")).toBe("72");
    expect(val(xml, "AMF01300")).toBe("600000");
  });
  test("減価償却は7件、残りは次葉合計。地代家賃は2件（2件目が「その他」）", () => {
    expect(count(xml, "AMF01600")).toBe(7);
    expect(val(xml, "AMF01793")).toBe(String(10_007 + 10_008));
    expect(count(xml, "AMF02120")).toBe(2);
    expect(xml).toContain("<AMF02150>その他</AMF02150>");
    expect(xml).toContain("<AMF02200>240000</AMF02200>");
  });
});

describe("配偶者・親族・事業専従者と個人番号", () => {
  const kids = Array.from({ length: 5 }, (_, i) => ({ ...emptyRelative("子"), name: `子${i + 1}`, birthday: `20${10 + i}-04-01` }));
  const input = {
    spouse: { ...emptyRelative("妻"), name: "山田 花子", birthday: "1987-01-10", income: 0 },
    dependents: [{ ...emptyRelative("子"), name: "山田 次郎", birthday: "2004-05-01", income: 1_000_000 }, ...kids],
  };
  const st = statement({ family: [pay("山田 和子", 960_000, { relation: "母", work: "経理" })] });
  test("個人番号を入れてもらう人：配偶者・親族（4人まで）・事業専従者", () => {
    const persons = myNumberPersons({ ...source(input), statement: st });
    expect(persons.map((p) => p.key)).toEqual(["spouse", "dep0", "dep1", "dep2", "dep3", "family0"]);
  });
  test("特定親族特別控除の人数と控除額（万円）、16歳未満の印、書けない5人目の知らせ", () => {
    const src = source(input, { statement: st, numbers: { self: "123456789018", spouse: "123456789018", dep0: "123456789018", family0: "123456789018" } });
    const xml = buildIncomeTaxXtx(src);
    expect(validate(xml)).toBe("");
    expect(val(xml, "ABB00546")).toBe("1");
    expect(val(xml, "ABY00253")).toBe("41"); // 合計所得金額100万円：41万円
    expect(count(xml, "ABY00150")).toBe(4);
    expect(xml).toContain("<ABY00270><kubun_CD>1</kubun_CD></ABY00270>");
    expect(val(xml, "ABE00040")).toBe("母");
    expect(incomeXtxNotices(src).join()).toMatch(/子4・子5は書いていません/);
  });
});

describe("還付・1月1日の住所・依頼税理士", () => {
  test("公金受取口座：口座を書かず、口座情報利用同意区分を 1（個人番号が要る）", () => {
    const src = source({ businessWithholding: [{ item: "報酬", payer: "株式会社エー", payerId: "東京都港区1-1", income: 5_000_000, withheld: 510_500 }] }, {
      filer: { ...filer, refund: { kind: "public" } }, numbers: { self: "123456789018" },
    });
    const xml = buildIncomeTaxXtx(src);
    expect(validate(xml)).toBe("");
    expect(Number(val(xml, "ABB00760"))).toBeGreaterThan(0);
    expect(val(xml, "ABZ40000")).toBe("1");
    expect(xml).not.toContain("KANPU_KINYUKIKAN");
  });
  test("1月1日の住所は翌年（令和8年）、依頼税理士は IT部から参照", () => {
    const src = source({ jan1Address: "東京都新宿区1-1" }, { filer: { ...filer, agent: { name: "税理 一郎", address: "東京都港区2-2", phone: "03-5555-6666" } } });
    const xml = buildIncomeTaxXtx(src);
    expect(validate(xml)).toBe("");
    expect(xml).toContain("<ABA00110><gen:era>5</gen:era><gen:yy>8</gen:yy></ABA00110><ABA00120 IDREF=\"ICHIGATSUIPPI_ADR\"/>");
    expect(xml).toContain('<AMC00020 IDREF="DAIRI_NM"/>');
    expect(xml).toContain('<ABS10050 IDREF="DAIRI_NM"/>');
  });
});

describe("書き出せないとき・版", () => {
  test("白色申告・損失・支払者の名称の無い源泉徴収・令和6年分以前・申告者の情報の不足", () => {
    expect(incomeXtxProblems(source({}, { biz: { ...biz, filingType: "white" } })).join()).toMatch(/白色/);
    expect(incomeXtxProblems(source({}, { biz: { ...biz, incomeBeforeBlue: -500_000 } })).join()).toMatch(/損失申告/);
    expect(incomeXtxProblems(source({ businessWithholding: [{ item: "報酬", payer: "", payerId: "", income: 100_000, withheld: 10_210 }] })).join()).toMatch(/支払者の名称/);
    expect(incomeXtxProblems(source({}, { year: 2024 })).join()).toMatch(/令和7年/);
    expect(incomeXtxProblems(source({}, { filer: { ...filer, userId: "" } })).join()).toMatch(/利用者識別番号/);
    expect(() => buildIncomeTaxXtx(source({}, { biz: { ...biz, filingType: "white" } }))).toThrow(/白色/);
  });
  test("表に無い新しい年分は、いちばん新しい版で書き出して知らせる", () => {
    expect(incomeXtxVersionFor(2025)).toEqual({ version: "25.0.1", fallback: false });
    expect(incomeXtxVersionFor(2026)).toEqual({ version: "25.0.1", fallback: true });
    expect(incomeXtxNotices(source({}, { year: 2026 })).join()).toMatch(/令和8年分の e-Tax の版/);
  });
  test("医療費控除・セルフメディケーション税制を受けるときは、明細書が無いことを知らせる", () => {
    const notice = (medical: IncomeTaxInput["medical"]) => incomeXtxNotices(source({ medical })).join();
    expect(notice({ kind: "normal", paid: 300_000, reimbursed: 0 })).toMatch(/医療費控除の明細書は書き出していません/);
    expect(notice({ kind: "self", paid: 30_000, reimbursed: 0 })).toMatch(/セルフメディケーション税制の明細書は書き出していません/);
    // 控除額が 0（10万円などの足切り以下）なら知らせない
    expect(notice({ kind: "normal", paid: 50_000, reimbursed: 0 })).not.toMatch(/明細書/);
    expect(notice({ kind: "normal", paid: 0, reimbursed: 0 })).not.toMatch(/明細書/);
  });
});
