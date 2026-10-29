import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildIncomeTaxXtx, incomeXtxNotices, incomeXtxProblems, incomeXtxVersionFor, myNumberPersons, type IncomeTaxXtxSource } from "./incomeTaxXtx";
import { computeIncomeTax, EMPTY_INCOME_TAX_INPUT, emptyRelative, type BusinessFigures, type CarriedLoss, type IncomeTaxInput } from "./incomeTax";
import type { BlueStatement, DepreciationLine, PayLine } from "./blueStatement";
import type { StatementRow } from "./statementLines";
import type { EtaxFiler } from "./etax";
import type { FlatLine } from "./accounting";
import type { Account } from "./types";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import { buildWhiteStatement, familyMembers } from "./whiteStatement";

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
  name, quantity: "1台", acquired: "2025-04", cost: d * 4, base: d * 4, method: "定額法", life: 4, rate: 0.25, months: 9, depreciation: d, businessRate: 100, business: d, closing: d * 3, memo: "",
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
  sales: { rows: [{ key: "cp:1", name: "株式会社エー", address: "", invoiceNo: "1234567890123", amount: 3_000_000 }], other: 2_000_000, total: 5_000_000 },
  purchases: { rows: [], other: 0, total: 0 }, salesPartners: [], purchasePartners: [],
  allowance: { receivables: [], adjust: 0, base: 0, finance: false, limit: 0, bulk: 0, individual: 0, total: 0, reversal: 0, problems: [] },
  ...o,
});

const biz: BusinessFigures = { revenue: 5_000_000, incomeBeforeBlue: 4_000_000, filingType: "blue65", familySalary: 0 };
const source = (input: Partial<IncomeTaxInput> = {}, o: Partial<IncomeTaxXtxSource> = {}, carried: CarriedLoss[] = []): IncomeTaxXtxSource => {
  const x = { ...EMPTY_INCOME_TAX_INPUT, birthday: "1985-06-01", ...input };
  const b = o.biz ?? biz;
  return {
    year: 2025, filer, input: x, result: computeIncomeTax(x, b, 2025, carried), biz: b, statement: statement(), bookKeeping: 2, numbers: {}, createdOn: "2026-02-20",
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
  test("3ページ：売上先の明細（登録番号は T を除いた13桁）と上記以外の計。仕入の無い明細は書かない", () => {
    expect(xml).toContain("<AMF02240>株式会社エー</AMF02240><AMF02260><AMF02270>1234567890123</AMF02270></AMF02260><AMF02290>3000000</AMF02290>");
    expect(val(xml, "AMF02300")).toBe("2000000");
    expect(val(xml, "AMF02310")).toBe("5000000");
    expect(xml).not.toContain("AMF02320");
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
    // 青色は従事月数だけ（程度・仕事の内容は白色申告者だけが書く）
    expect(val(xml, "ABE00060")).toBe("12月");
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
  test("支払者の名称の無い源泉徴収・令和6年分以前・申告者の情報の不足（損失の年は第四表を付けて書き出せる）", () => {
    expect(incomeXtxProblems(source({}, { biz: { ...biz, incomeBeforeBlue: -500_000 } }))).toEqual([]);
    expect(incomeXtxProblems(source({ businessWithholding: [{ item: "報酬", payer: "", payerId: "", income: 100_000, withheld: 10_210 }] })).join()).toMatch(/支払者の名称/);
    expect(incomeXtxProblems(source({}, { year: 2024 })).join()).toMatch(/令和7年/);
    expect(incomeXtxProblems(source({}, { filer: { ...filer, userId: "" } })).join()).toMatch(/利用者識別番号/);
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

describe("白色申告（申告書＋収支内訳書）", () => {
  const seeds: Account[] = ACCOUNT_SEEDS.map((x, i) => ({
    ...x, id: i + 1, sort_order: i, is_active: 1, is_system: 1, default_tax_code: null, default_business_class: null, default_purchase_use: null, statement_line: null,
  }));
  const acc = (name: string) => seeds.find((a) => a.name === name)!;
  let id = 0;
  const je = (debit: string, credit: string, amount: number, cp: number | null = null): FlatLine[] => {
    id += 1;
    const base = { entry_id: id, date: "2025-06-30", description: "", memo: "", amount, counterparty_id: cp, row_no: 1, sub_account_id: null };
    return [{ ...base, side: "debit", account_id: acc(debit).id }, { ...base, side: "credit", account_id: acc(credit).id }];
  };
  // 売上 500万（取引先1 300万・取引先2 120万・相手なし 80万）、家事消費 2万、雑収入 3万、仕入 100万、給料賃金 60万・地代家賃 24万・支払手数料 3万、専従者給与 100万
  const lines = [
    ...je("売掛金", "売上高", 3_000_000, 1), ...je("売掛金", "売上高", 1_200_000, 2), ...je("現金", "売上高", 800_000),
    ...je("事業主貸", "家事消費等", 20_000), ...je("普通預金", "雑収入", 30_000), ...je("仕入高", "買掛金", 1_000_000, 3),
    ...je("給料賃金", "普通預金", 600_000), ...je("地代家賃", "普通預金", 240_000), ...je("支払手数料", "普通預金", 30_000), ...je("専従者給与", "普通預金", 1_000_000),
  ];
  const spouse = { ...emptyRelative("妻"), name: "山田 花子", birthday: "1988-04-01", familyEmployee: true, months: 12, work: "毎日・経理" };
  const white = buildWhiteStatement({
    year: 2025, accounts: seeds, opening: {}, lines, notes: { "sales:cp:2:address": "大阪府大阪市1-1" }, assets: [], homeUseRates: [], excludeEntryIds: [],
    payeeName: (r) => `取引先${r.counterpartyId}`, invoiceNoOf: (c) => (c === 1 ? "T1234567890123" : ""),
    family: familyMembers({ spouse, dependents: [] }), periodMonths: 12,
  });
  const wbiz: BusinessFigures = { revenue: white.revenue.total, incomeBeforeBlue: white.income, filingType: "white", familySalary: white.familyDeduction };
  const src = source({ spouse }, { biz: wbiz, white, numbers: { self: "123456789018", family0: "123456789018" } });
  const xml = buildIncomeTaxXtx(src);

  test("手続 RKO0010 の XSD に合う", () => expect(validate(xml)).toBe(""));
  test("決算書は収支内訳書（KOA110）。第一表に青色の印と青色申告特別控除は無い", () => {
    expect(xml).toContain('<KOA110 VR="12.0" id="KOA110-1"');
    expect(xml).not.toContain("<KOA210");
    expect(xml).not.toContain("ABA00240");
    expect(xml).not.toContain("ABB00800");
    expect(val(xml, "ABB00030")).toBe("5050000");
    expect(val(xml, "ABB00300")).toBe("2320000");
    expect(val(xml, "ABB00790")).toBe("860000");
  });
  test("第二表の事業専従者：従事月数・程度・仕事の内容と専従者控除額。配偶者は配偶者の欄に書かない", () => {
    expect(val(xml, "ABE00020")).toBe("山田 花子");
    expect(val(xml, "ABE00060")).toBe("12月・毎日・経理");
    expect(val(xml, "ABE00070")).toBe("860000");
    expect(xml).not.toContain("ABY00020");
    expect(myNumberPersons(src).map((p) => p.key)).toEqual(["family0"]);
  });
  test("収支内訳書の1ページ：収入金額・経費（追加の欄）・専従者控除・所得金額、事業専従者の氏名等", () => {
    expect(val(xml, "AIR00000")).toBe("1");
    expect(val(xml, "AIG00030")).toBe("5000000");
    expect(val(xml, "AIG00040")).toBe("20000");
    expect(val(xml, "AIG00050")).toBe("30000");
    expect(val(xml, "AIG00060")).toBe("5050000");
    expect(val(xml, "AIG00090")).toBe("1000000");
    expect(val(xml, "AIG00130")).toBe("4050000");
    expect(val(xml, "AIG00150")).toBe("600000");
    expect(val(xml, "AIG00190")).toBe("240000");
    expect(xml).toContain("<AIG00325><AIG00010>支払手数料</AIG00010><AIG00330>30000</AIG00330></AIG00325>");
    expect(val(xml, "AIG00350")).toBe("30000");
    expect(val(xml, "AIG00360")).toBe("870000");
    expect(val(xml, "AIG00370")).toBe("3180000");
    expect(val(xml, "AIG00380")).toBe("860000");
    expect(val(xml, "AIG00400")).toBe("2320000");
    expect(val(xml, "AIJ00020")).toBe("山田 花子");
    expect(val(xml, "AIJ00030")).toBe("37");
    expect(val(xml, "AIJ00050")).toBe("12");
    expect(val(xml, "AIJ00060")).toBe("12");
  });
  test("収支内訳書の2ページ：売上先の明細の計は①（家事消費・その他の収入を含まない）", () => {
    expect(count(xml, "AIK00010")).toBe(2);
    expect(xml).toContain("<AIK00020>取引先1</AIK00020><AIK00070><AIK00080>1234567890123</AIK00080></AIK00070><AIK00040>3000000</AIK00040>");
    expect(xml).toContain("<AIK00020>取引先2</AIK00020><AIK00030>大阪府大阪市1-1</AIK00030><AIK00040>1200000</AIK00040>");
    expect(val(xml, "AIK00050")).toBe("800000");
    expect(val(xml, "AIK00060")).toBe("5000000");
    expect(val(xml, "AIL00040")).toBe("1000000");
    expect(val(xml, "AIL00060")).toBe("1000000");
  });
  test("専従者給与を経費に入れていないことを知らせる", () => {
    expect(incomeXtxNotices(src).join()).toMatch(/専従者給与の科目に記帳した額は/);
  });
});

describe("貸倒引当金（青色申告決算書の1・2ページ）", () => {
  const allowance = {
    receivables: [{ name: "売掛金", amount: 1_000_000 }], adjust: 0, base: 1_000_000, finance: false, limit: 55_000, bulk: 44_000, individual: 10_000, total: 54_000,
    reversal: 30_000, problems: [],
  };
  const st = (add: number, back: number) => {
    const base = statement();
    const sections = { ...base.layout.sections, addition: [row("専従者給与", 0), row("貸倒引当金", add)], reversal: [row("貸倒引当金", back)] };
    return statement({ allowance, layout: { ...base.layout, sections } });
  };
  test("2ページの貸倒引当金繰入額の計算（①〜⑤）と、1ページの繰戻額等・繰入額等", () => {
    const src = source({}, { statement: st(54_000, 30_000) });
    const xml = buildIncomeTaxXtx(src);
    expect(validate(xml)).toBe("");
    expect(["AMF01010", "AMF01030", "AMF01040", "AMF01050", "AMF01060", "AMF00420", "AMF00470"].map((t) => val(xml, t))).toEqual([
      "10000", "1000000", "55000", "44000", "54000", "30000", "54000",
    ]);
    expect(incomeXtxNotices(src).join()).not.toMatch(/貸倒引当金/);
  });
  test("帳簿の繰入・戻入が計算と違えば知らせる", () => {
    expect(incomeXtxNotices(source({}, { statement: st(40_000, 30_000) })).join()).toMatch(/貸倒引当金の帳簿の額（繰入 40,000円・戻入 30,000円）/);
  });
});

describe("減価償却費の計算（旧定額法）", () => {
  test("償却の基礎になる金額は取得価額 × 90%、償却方法は「旧定額法」", () => {
    const shop = { ...dep("店舗", 414_000), acquired: "2000-04", cost: 10_000_000, base: 9_000_000, method: "旧定額法", life: 22, rate: 0.046, months: 12 };
    const xml = buildIncomeTaxXtx(source({}, { statement: statement({ depreciation: [shop] }) }));
    expect(validate(xml)).toBe("");
    expect([val(xml, "AMF01640"), val(xml, "AMF01650"), val(xml, "AMF01660")]).toEqual(["10000000", "9000000", "旧定額法"]);
  });
});

describe("損失申告（第四表）と繰越控除", () => {
  const lossBiz: BusinessFigures = { revenue: 3_000_000, incomeBeforeBlue: -800_000, filingType: "blue65", familySalary: 0 };
  test("本年の純損失：第四表（一）（二）を書き、第一表の ⑫・㉛ は書かず ㉜ は 0", () => {
    const xml = buildIncomeTaxXtx(source({ salaries: [{ item: "給料", payer: "A社", payerId: "東京都千代田区", income: 1_000_000, withheld: 30_000 }] }, { biz: lossBiz }));
    expect(validate(xml)).toBe("");
    // 給与所得 350,000（令和7年分：100万 − 65万）− 事業の損失 800,000 = −450,000
    expect(val(xml, "ABN00030")).toBe("-450000");
    expect(val(xml, "ABN01520")).toBe("-450000");
    expect(val(xml, "ABP00020")).toBe("450000");
    expect(xml).toContain('<ABM00080 IDREF="NOZEISHA_NM"/>');
    expect(xml).not.toContain("<ABB00410>");
    expect(xml).not.toContain("<ABB00580>");
    expect(val(xml, "ABB00590")).toBe("0");
    // 源泉徴収税額は還付
    expect(val(xml, "ABB00760")).toBe("30000");
  });
  test("繰越損失が翌年に残る：4 の Ⓐ・Ⓑ・Ⓒ と年分", () => {
    const b: BusinessFigures = { ...lossBiz, incomeBeforeBlue: 1_450_000 };
    const xml = buildIncomeTaxXtx(source({}, { biz: b }, [{ year: 2022, amount: 300_000 }, { year: 2023, amount: 1_000_000 }]));
    expect(validate(xml)).toBe("");
    expect(xml).toContain("<ABP00320><gen:era>5</gen:era><gen:yy>4</gen:yy></ABP00320>");
    expect([val(xml, "ABP00500"), val(xml, "ABP00870")]).toEqual(["300000", "300000"]);
    expect([val(xml, "ABP00620"), val(xml, "ABP00990"), val(xml, "ABP01240")]).toEqual(["1000000", "500000", "500000"]);
    expect(xml).not.toContain("ABP00400");
    expect(xml).not.toContain("<ABP00020>");
    expect(val(xml, "ABP01445")).toBe("0");
    expect(xml).not.toContain("<ABB00830>");
  });
  test("繰越損失を使い切る：第四表は書かず、第一表の (62) に書く", () => {
    const b: BusinessFigures = { ...lossBiz, incomeBeforeBlue: 2_000_000 };
    const xml = buildIncomeTaxXtx(source({}, { biz: b }, [{ year: 2024, amount: 500_000 }]));
    expect(validate(xml)).toBe("");
    expect(xml).not.toContain("ABM00000");
    expect(val(xml, "ABB00830")).toBe("500000");
    expect(val(xml, "ABB00410")).toBe("850000");
  });
});
