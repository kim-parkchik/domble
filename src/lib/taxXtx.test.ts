/**
 * 消費税の e-Tax データ（xtx）。国税庁の XSD（spec/etax）で検証し、欄の値が申告書の数字と合っているかを確かめる
 * 数字は taxReturn.test.ts と同じ国税庁の設例
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { simplifiedReturn, standardReturn, thirtyReturn, twentyReturn, type TaxBase } from "./taxReturn";
import { buildTaxXtx, xtxProblem } from "./taxXtx";
import { filerProblems, formXml, isValidMyNumber, itXml, normalizeEtaxInfo, toKatakana, warekiXml, type EtaxFiler, type EtaxInfo } from "./etax";

const base = (x: Partial<TaxBase>): TaxBase => ({
  sales: { 8: 0, 10: 0 }, salesReturn: { 8: 0, 10: 0 }, badDebt: { 8: 0, 10: 0 }, badDebtRecovered: { 8: 0, 10: 0 },
  exportSales: 0, nontaxSales: 0, purchase: { 8: 0, 10: 0 }, purchaseReturn: { 8: 0, 10: 0 }, transitional: [], byClass: {}, ...x,
});
const opts = { businessClass: 5, interimNational: 0, interimLocal: 0, baseSales: 8_765_432 };
const filer: EtaxFiler = {
  userId: "1234567890123456", officeCode: "01101", officeName: "麹町",
  name: "山田　太郎", nameKana: "ヤマダ　タロウ", yago: "山田商店 & Co.", yagoKana: "やまだしょうてん",
  postalCode: "100-0001", address: "東京都千代田区千代田１－１", phone: "03-1234-5678",
  myNumber: "", occupation: "", householderName: "", householderRelation: "", jan1Address: "", refund: null,
};
const period = { from: "2026-01-01", to: "2026-12-31", createdOn: "2027-02-01" };

const SPEC = resolve(import.meta.dir, "../../spec/etax/shohi");
const dir = mkdtempSync(join(tmpdir(), "domble-xtx-"));
let n = 0;
/** xmllint で手続の XSD に照らす。合っていなければエラーの内容を返す */
const validate = (xml: string) => {
  const file = join(dir, `t${n++}.xtx`);
  writeFileSync(file, xml);
  const procedure = xml.match(/<(RSH\d{4}) /)![1];
  const p = Bun.spawnSync(["xmllint", "--noout", "--schema", join(SPEC, `${procedure}-260.xsd`), file]);
  return p.exitCode === 0 ? "" : p.stderr.toString();
};
const val = (xml: string, t: string) => xml.match(new RegExp(`<${t}>(?:<kubun_CD>)?([^<]*)<`))?.[1];
const ref = (xml: string, t: string) => xml.match(new RegExp(`<${t} IDREF="([A-Z_]+)"/>`))?.[1];

describe("本則課税（一般用：RSH0010）", () => {
  const b = base({
    sales: { 8: 203_878_000, 10: 135_400_000 }, salesReturn: { 8: 4_521_120, 10: 4_400_005 },
    exportSales: 11_000_000, nontaxSales: 7_000_000,
    purchase: { 8: 98_628_000, 10: 72_730_000 }, purchaseReturn: { 8: 6_410_000, 10: 3_700_000 },
    transitional: [{ pct: 80, purchase: { 8: 21_600_000, 10: 22_000_000 }, ret: { 8: 2_160_000, 10: 2_200_000 } }],
    badDebt: { 8: 0, 10: 1_230_000 },
  });
  const xml = buildTaxXtx(standardReturn(b, { ...opts, interimNational: 5_460_300, interimLocal: 1_540_000 }), filer, period);

  test("XSD に合っている", () => expect(validate(xml)).toBe(""));
  test("手続・様式・IT部", () => {
    expect(xml).toContain('<RSH0010 VR="26.0.0" id="RSH0010">');
    expect(xml).toContain('<SHA010 VR="10.0" id="SHA010-1" page="1" sakuseiDay="2027-02-01" sakuseiNM="山田商店 &amp; Co." softNM="domble">');
    expect(xml).toContain('<rdf:li><rdf:description about="#SHB017-1"/></rdf:li><rdf:li><rdf:description about="#SHB033-1"/></rdf:li>');
    expect(xml).toContain("<NOZEISHA_YAGO_KN ID=\"NOZEISHA_YAGO_KN\">ヤマダショウテン</NOZEISHA_YAGO_KN>");
    expect(ref(xml, "AAI00070")).toBe("NOZEISHA_YAGO");
    expect(ref(xml, "AAI00110")).toBe("NOZEISHA_NM");
    expect(ref(xml, "AAN00080")).toBe("NOZEISHA_NM");
    expect(ref(xml, "DSA00040")).toBe("NOZEISHA_NM");
  });
  test("第一表・第二表", () => {
    expect(val(xml, "AAJ00010")).toBe("311865000");
    expect(val(xml, "AAJ00110")).toBe("5460300");
    expect(val(xml, "AAJ00120")).toBe("3015000");
    expect(val(xml, "AAK00080")).toBe("850400");
    expect(val(xml, "AAK00130")).toBe("3865400");
    expect(val(xml, "AAJ00180")).toBe("314680608");
    expect(val(xml, "AAJ00190")).toBe("321680608");
    expect(val(xml, "AAM00020")).toBe("3"); // 全額控除
    expect(val(xml, "AAM00030")).toBe("8765"); // 千円
    expect(val(xml, "AAU00000")).toBe("573220");
  });
  test("付表1-3・2-3", () => {
    expect([val(xml, "DSC00020"), val(xml, "DSC00030"), val(xml, "DSC00040")]).toEqual(["188775925", "123090909", "311866834"]);
    expect(val(xml, "DSF00240")).toBe("12905204");
    expect(val(xml, "DSH00000")).toBe("8475300");
    expect(val(xml, "DSJ00020")).toBe("2390400");
    expect(val(xml, "DTC00010")).toBe("314680608");
    expect(val(xml, "DTD00000")).toBe("97.82");
    expect(val(xml, "DTE00340")).toBe("2021760");
    expect(val(xml, "DTF00030")).toBe("12244766");
    expect(val(xml, "DTI00040")).toBe("12244766");
  });
});

describe("簡易課税（簡易課税用：RSH0030）", () => {
  test("1種類の事業", () => {
    const b = base({ sales: { 8: 19_192_000, 10: 11_516_000 }, salesReturn: { 8: 1_250_000, 10: 756_000 }, exportSales: 1_100_000, badDebt: { 8: 0, 10: 560_000 } });
    const xml = buildTaxXtx(simplifiedReturn(b, { ...opts, businessClass: 2 }), filer, period);
    expect(validate(xml)).toBe("");
    expect(xml).toContain('<RSH0030 VR="26.0.0" id="RSH0030">');
    expect(val(xml, "DVC00010")).toBe("2"); // 第二種
    expect(val(xml, "DVC00040")).toBe("1439680");
    expect(val(xml, "DUF00160")).toBe("1605218");
    expect(val(xml, "ABI00170")).toBe("27494781");
    expect(val(xml, "ABI00180")).toBe("8765432"); // 簡易課税用は円
    expect(val(xml, "ABL00070")).toBe("26395"); // 第二種の課税売上高（千円。免税売上は含まない）
    expect(val(xml, "ABL00080")).toBe("100.0");
    expect(xml).not.toContain("<ABL00210>");
    expect(val(xml, "ABJ00130")).toBe("410500");
  });

  test("2種類以上の事業（第二種と第四種。特例計算）", () => {
    const b = base({
      sales: { 8: 19_192_000, 10: 11_516_000 }, salesReturn: { 8: 1_250_000, 10: 756_000 },
      exportSales: 1_100_000, badDebt: { 8: 0, 10: 560_000 },
      byClass: {
        2: { sales: { 8: 19_192_000, 10: 7_712_000 }, ret: { 8: 1_250_000, 10: 456_000 } },
        4: { sales: { 8: 0, 10: 3_804_000 }, ret: { 8: 0, 10: 300_000 } },
      },
    });
    const r = simplifiedReturn(b, opts);
    const xml = buildTaxXtx(r, filer, period);
    expect(validate(xml)).toBe("");
    expect([val(xml, "DVD00130"), val(xml, "DVD00140"), val(xml, "DVD00160"), val(xml, "DVD00170")]).toEqual(["16612963", "6596364", "23209327", "87.9"]);
    expect([val(xml, "DVD00250"), val(xml, "DVD00260"), val(xml, "DVD00280"), val(xml, "DVD00290")]).toEqual(["0", "3185454", "3185454", "12.0"]);
    expect(val(xml, "DVD00460")).toBe("1799631");
    expect(val(xml, "DVE00070")).toBe("2"); // ㉑ 第二種で 75% 以上
    expect(val(xml, "DVE00750")).toBe(String(r.forms[0].rows.find((x) => x.no === "㊲")!.c));
    expect(xml).not.toContain("<DVC00010>"); // ⑤ は1種類のときだけ
    expect([val(xml, "ABL00070"), val(xml, "ABL00080"), val(xml, "ABL00130"), val(xml, "ABL00140")]).toEqual(["23209", "87.9", "3185", "12.0"]);
    expect(val(xml, "ABL00210")).toBe("1");
  });
});

describe("2割特例（付表6）", () => {
  const b = base({ sales: { 8: 0, 10: 6_609_330 }, salesReturn: { 8: 0, 10: 192_900 } });
  test("第一表が一般用：控除税額の計算方法が 8", () => {
    const xml = buildTaxXtx(twentyReturn(b, opts, "一般用"), filer, period);
    expect(validate(xml)).toBe("");
    expect(xml).toContain('<rdf:li><rdf:description about="#SHA010-1"/></rdf:li><rdf:li><rdf:description about="#SHB070-1"/></rdf:li>');
    expect(val(xml, "AAM00020")).toBe("8");
    expect(val(xml, "AYC00040")).toBe("363956");
    expect(val(xml, "AYB00230")).toBe("454946");
    expect(val(xml, "AAK00130")).toBe("116500");
    expect(xml).not.toContain("<AAJ00180>");
  });
  test("第一表が簡易課税用：２割特例の欄が 1（該当）、事業区分は書かない", () => {
    const xml = buildTaxXtx(twentyReturn(b, opts, "簡易課税用"), filer, period);
    expect(validate(xml)).toBe("");
    expect(xml).toContain("<RSH0030 ");
    expect(val(xml, "ABY00000")).toBe("1");
    expect(xml).not.toContain("<ABL00040>");
    expect(xml).not.toContain("<ABI00170>");
    expect(val(xml, "ABJ00130")).toBe("116500");
  });
});

test("還付（控除不足還付税額）。合計はマイナス", () => {
  const xml = buildTaxXtx(standardReturn(base({ sales: { 8: 0, 10: 110_000 }, purchase: { 8: 0, 10: 1_100_000 } }), opts), filer, period);
  expect(validate(xml)).toBe("");
  expect(val(xml, "AAJ00090")).toBe("70200");
  expect(val(xml, "AAK00050")).toBe("19800");
  expect(val(xml, "AAK00130")).toBe("-90000");
  expect(val(xml, "AAW00010")).toBe("-70200");
});

describe("課税売上割合が 95% 未満", () => {
  const purchases = { purchase: { 8: 0, 10: 550_000 } as const };
  const b = base({
    sales: { 8: 0, 10: 1_100_000 }, nontaxSales: 500_000, ...purchases,
    byUse: {
      taxable: { purchase: { 8: 0, 10: 110_000 }, ret: { 8: 0, 10: 0 }, transitional: [] },
      common: { purchase: { 8: 0, 10: 440_000 }, ret: { 8: 0, 10: 0 }, transitional: [] },
      nontaxable: { purchase: { 8: 0, 10: 0 }, ret: { 8: 0, 10: 0 }, transitional: [] },
    },
  });
  test("一括比例配分方式（2）", () => {
    const xml = buildTaxXtx(standardReturn(b, { ...opts, deduction: "lump" }), filer, period);
    expect(validate(xml)).toBe("");
    expect(val(xml, "AAM00020")).toBe("2");
    expect(val(xml, "DTD00000")).toBe("66.66");
    expect(val(xml, "DTG00170")).toBe("26000"); // 39,000 × 1,000,000 / 1,500,000
    expect(xml).not.toContain("<DTG00130>");
  });
  test("個別対応方式（1）：⑲⑳㉑", () => {
    const xml = buildTaxXtx(standardReturn(b, { ...opts, deduction: "individual" }), filer, period);
    expect(validate(xml)).toBe("");
    expect(val(xml, "AAM00020")).toBe("1");
    expect([val(xml, "DTG00050"), val(xml, "DTG00090"), val(xml, "DTG00130")]).toEqual(["7800", "31200", "28600"]); // 7,800 ＋ 31,200 × 2/3
    expect(val(xml, "DTI00040")).toBe("28600");
    expect(xml).not.toContain("<DTG00170>");
  });
});

test("申告者の情報が最小限（屋号・フリガナ・電話・郵便番号なし）でも XSD に合う", () => {
  const min: EtaxFiler = { ...filer, nameKana: "", yago: "", yagoKana: "", phone: "", postalCode: "", officeName: "" };
  const xml = buildTaxXtx(twentyReturn(base({ sales: { 8: 0, 10: 1_100_000 } }), opts), min, period);
  expect(validate(xml)).toBe("");
  expect(xml).not.toContain("AAI00070");
  expect(xml).not.toContain("NOZEISHA_TEL");
});

describe("個人番号・還付先の口座", () => {
  // 課税売上 1,100,000・課税仕入 3,300,000 → 控除不足還付
  const refundReturn = standardReturn(base({ sales: { 8: 0, 10: 1_100_000 }, purchase: { 8: 0, 10: 3_300_000 } }), opts);
  const bank = { kind: "bank" as const, bankName: "みずほ", bankKind: "1", branchName: "渋谷", branchKind: "2", depositKind: "1", accountNo: "1234567" };

  test("個人番号は IT部に書き、第一表から参照する（第二表には無い）", () => {
    const xml = buildTaxXtx(twentyReturn(base({ sales: { 8: 0, 10: 1_100_000 } }), opts), { ...filer, myNumber: "123456789018" }, period);
    expect(validate(xml)).toBe("");
    expect(xml).toContain('<NOZEISHA_BANGO ID="NOZEISHA_BANGO"><gen:kojinbango>123456789018</gen:kojinbango></NOZEISHA_BANGO>');
    expect(ref(xml, "AAI00080")).toBe("NOZEISHA_BANGO");
    expect(xml).not.toContain("KANPU_KINYUKIKAN");
  });
  test("還付になるときだけ還付先の口座を書く（銀行等・ゆうちょ銀行）", () => {
    expect(refundReturn.total).toBeLessThan(0);
    const xml = buildTaxXtx(refundReturn, { ...filer, refund: bank }, period);
    expect(validate(xml)).toBe("");
    expect(xml).toContain('<gen:kinyukikan_NM kinyukikan_KB="1">みずほ</gen:kinyukikan_NM><gen:shiten_NM shiten_KB="2">渋谷</gen:shiten_NM><gen:yokin>1</gen:yokin><gen:koza>1234567</gen:koza>');
    expect(ref(xml, "AAI00190")).toBe("KANPU_KINYUKIKAN");
    const yucho = buildTaxXtx(refundReturn, { ...filer, refund: { kind: "yucho", symbol: "10120", number: "12345671" } }, period);
    expect(validate(yucho)).toBe("");
    expect(yucho).toContain("<gen:kigobango1>10120</gen:kigobango1><gen:kigobango2>12345671</gen:kigobango2>");
    const pay = buildTaxXtx(twentyReturn(base({ sales: { 8: 0, 10: 1_100_000 } }), opts), { ...filer, refund: bank }, period);
    expect(pay).not.toContain("KANPU_KINYUKIKAN");
  });
  test("公金受取口座：口座は書かず、口座情報利用同意区分を 1（個人番号があるときだけ）", () => {
    const xml = buildTaxXtx(refundReturn, { ...filer, myNumber: "123456789018", refund: { kind: "public" } }, period);
    expect(validate(xml)).toBe("");
    expect(val(xml, "AAI00250")).toBe("1");
    expect(xml).not.toContain("KANPU_KINYUKIKAN");
    expect(buildTaxXtx(refundReturn, { ...filer, refund: { kind: "public" } }, period)).not.toContain("AAI00250");
  });
  test("個人番号の検査用数字・口座の確かめ", () => {
    expect(isValidMyNumber("123456789018")).toBe(true);
    expect(isValidMyNumber("123456789012")).toBe(false);
    expect(isValidMyNumber("12345678901")).toBe(false);
    const info: EtaxInfo = {
      etax_user_id: "", tax_office: "", phone: "", owner_kana: "", business_kana: "", occupation: "デザイナー", householder_name: "", householder_relation: "",
      jan1_address: "", office_phone: "", refund_mode: "bank", bank_name: "みずほ銀行", bank_kind: "1", branch_name: "渋谷支店", branch_kind: "2", deposit_kind: "1",
      account_no: "１２３４５６７", yucho_symbol: "", yucho_number: "",
    };
    expect(normalizeEtaxInfo(info)).toMatchObject({ bank_name: "みずほ", branch_name: "渋谷", account_no: "1234567" });
    expect(normalizeEtaxInfo({ ...info, account_no: "" })).toMatch(/口座番号/);
    expect(normalizeEtaxInfo({ ...info, refund_mode: "yucho" })).toMatch(/ゆうちょ/);
  });
});

test("年の途中から課税事業者：課税期間の初日", () => {
  expect(itXml(filer, { procedure: "RSH0010", procedureName: "x", from: "2026-10-01", to: "2026-12-31", shinkokuKbn: 1 }))
    .toContain("<KAZEI_KIKAN_FROM ID=\"KAZEI_KIKAN_FROM\"><gen:era>5</gen:era><gen:yy>8</gen:yy><gen:mm>10</gen:mm><gen:dd>1</gen:dd>");
  expect(warekiXml("2019-04-30")).toContain("<gen:era>4</gen:era><gen:yy>31</gen:yy>");
});

test("書き出せないもの：3割特例・令和7年分以前", () => {
  const b = base({ sales: { 8: 0, 10: 1_100_000 } });
  expect(xtxProblem(thirtyReturn(b, opts), 2027)).toMatch(/3割特例/);
  expect(() => buildTaxXtx(thirtyReturn(b, opts), filer, { ...period, from: "2027-01-01", to: "2027-12-31" })).toThrow(/3割特例/);
  expect(xtxProblem(twentyReturn(b, opts), 2025)).toMatch(/令和8年/);
  expect(xtxProblem(twentyReturn(b, opts), 2026)).toBeNull();
});

test("申告者の情報の確かめ", () => {
  expect(filerProblems(filer)).toEqual([]);
  expect(filerProblems({ ...filer, userId: "123", officeCode: "", name: " ", address: "", phone: "0312345678", nameKana: "Yamada" })).toEqual([
    "利用者識別番号（16桁の数字）", "提出先の税務署", "氏名", "住所（納税地）", "電話番号は 03-1234-5678 のようにハイフンで区切って", "氏名のフリガナはカタカナで",
  ]);
  expect(toKatakana("ﾔﾏﾀﾞ たろう")).toBe("ヤマダ タロウ");
});

test("様式に無い欄を書こうとしたらエラー（対応表の書き間違い）", () => {
  expect(() => formXml("SHB070", { AYB99999: 1 }, { author: "x", createdOn: "2027-01-01" })).toThrow(/AYB99999/);
});

