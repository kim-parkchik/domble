/**
 * repo.ts を、bun:sqlite のメモリ上の DB で動かして確かめる
 * （connection.ts の Database と同じ形の select / execute だけを用意する）
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA, SEED_ACCOUNT_SQL } from "./schema";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import * as repo from "./repo";
import type { JournalLine } from "../lib/types";
import { subKey } from "../lib/types";
import { depreciationFor, depreciationLines } from "../lib/depreciation";
import { inventoryLines } from "../lib/yearEnd";
import { allowanceCalc, allowanceLines } from "../lib/allowance";
import { taxYearOf } from "../lib/tax";
import { emptyRow } from "../lib/accounting";
import { EMPTY_INCOME_TAX_INPUT } from "../lib/incomeTax";

const makeDb = (mode: "strict" | "standard") => {
  const raw = new Sqlite(":memory:");
  raw.run("PRAGMA foreign_keys = ON"); // 本番（db.rs の open_connection）と同じ
  const isTrigger = (s: string) => s.trimStart().startsWith("CREATE TRIGGER");
  for (const s of SCHEMA.filter((x) => !isTrigger(x))) raw.run(s);
  for (const [t, c, d] of COLUMN_MIGRATIONS) {
    const cols = raw.query(`PRAGMA table_info(${t})`).all() as { name: string }[];
    if (!cols.some((x) => x.name === c)) raw.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  }
  for (const s of SCHEMA.filter(isTrigger)) raw.run(s);
  raw.run("INSERT INTO settings (id, fiscal_year, e_book_mode, business_name) VALUES (1, 2026, ?, 'テスト')", [mode]);
  ACCOUNT_SEEDS.forEach((a, i) => raw.run(SEED_ACCOUNT_SQL, [a.code, a.name, a.kana, a.category, a.normal_side, i, a.income_kind ?? "business", a.hidden ? 0 : 1]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (params?: unknown[]) => (params ?? []) as any[];
  const db = {
    select: async (sql: string, params?: unknown[]) => raw.query(sql).all(...p(params)),
    execute: async (sql: string, params?: unknown[]) => {
      const r = raw.query(sql).run(...p(params));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  } as unknown as Database;
  return { db, raw };
};

const pdf = (text: string) => new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n"), ...new TextEncoder().encode(text)]);
const meta = { doc_type: "請求書", txn_date: "2026-01-31", amount: 11000, counterparty: "株式会社A", memo: "" };

let strict: ReturnType<typeof makeDb>;
let lines: JournalLine[];
beforeEach(async () => {
  repo.setActor(null); // 前のテストの操作者を持ち越さない
  strict = makeDb("strict");
  const accts = await repo.getAccounts(strict.db, 2026);
  const id = (n: string) => accts.find((a) => a.name === n)!.id;
  lines = [
    { row_no: 1, side: "debit", account_id: id("外注工賃"), sub_account_id: null, amount: 11000, memo: "外注" },
    { row_no: 1, side: "credit", account_id: id("現金"), sub_account_id: null, amount: 11000, memo: "外注" },
  ];
});

describe("年度の締め（repo）", () => {
  test("締めた年度の仕訳は登録・訂正・削除できず、解除には理由が要る（厳密モード）", async () => {
    const { db } = strict;
    const entry = await repo.createEntry(db, "2025-12-01", lines);
    await repo.closeYear(db, 2025);
    await expect(repo.createEntry(db, "2025-12-02", lines)).rejects.toThrow(/2025年は締め済み/);
    await expect(repo.updateEntry(db, entry, "2025-12-03", lines)).rejects.toThrow(/締め済み/);
    await expect(repo.deleteEntry(db, entry)).rejects.toThrow(/締め済み/);
    // 開いている年度の仕訳を締め済みの年度へ動かすのも不可
    const e2 = await repo.createEntry(db, "2026-01-05", lines);
    await expect(repo.updateEntry(db, e2, "2025-12-31", lines)).rejects.toThrow(/締め済み/);
    expect((await repo.getEntry(db, e2))!.lines).toHaveLength(2); // 明細が消えていない
    await expect(repo.reopenYear(db, 2025, " ")).rejects.toThrow(/理由/);
    await repo.reopenYear(db, 2025, "計上漏れの追加");
    await repo.createEntry(db, "2025-12-02", lines);
    const hist = await repo.getMasterHistory(db);
    expect(hist.map((h) => h.action)).toEqual(["unlock", "close"]);
  });

  test("既存の帳簿は、繰越済みの年度だけ一度だけ自動で締める", async () => {
    const { db } = strict;
    await repo.createEntry(db, "2025-03-01", lines);
    await repo.saveOpening(db, 2026, { "1:0": 1000 });
    await repo.initClosings(db);
    expect((await repo.getClosings(db)).map((c) => c.fiscal_year)).toEqual([2025]);
    await repo.reopenYear(db, 2025, "確認");
    await repo.initClosings(db); // 2回目は何もしない
    expect(await repo.getClosings(db)).toEqual([]);
  });
});

describe("取引先（repo）", () => {
  test("仕訳に付けた取引先は履歴の写しに名前が残り、訂正で省けばそのまま", async () => {
    const { db } = strict;
    const cp = await repo.createCounterparty(db, { name: "株式会社A", kana: "えー", invoice_no: "ｔ1234567890123", memo: "" });
    expect((await repo.getCounterparties(db))[0].invoice_no).toBe("T1234567890123");
    const entry = await repo.createEntry(db, "2026-01-31", lines, cp);
    await repo.updateEntry(db, entry, "2026-02-01", lines, "日付の訂正");
    expect((await repo.getEntry(db, entry))!.counterparty_id).toBe(cp);
    const hist = await repo.getHistory(db, entry);
    expect(hist.map((h) => h.snapshot.counterparty)).toEqual(["株式会社A", "株式会社A"]);
    await repo.updateEntry(db, entry, "2026-02-01", lines, "取引先を外す", null);
    expect((await repo.getEntry(db, entry))!.counterparty_id).toBeNull();
  });

  test("証憑の取引先名が一覧と同じならつながる。使った取引先は削除できない", async () => {
    const { db } = strict;
    const cp = await repo.createCounterparty(db, { name: "株式会社A", kana: "", invoice_no: "", memo: "" });
    const id = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    expect((await repo.getEvidence(db, id))!.counterparty_id).toBe(cp);
    await expect(repo.deleteCounterparty(db, cp)).rejects.toThrow(/使われている/);
    const unused = await repo.createCounterparty(db, { name: "B商店", kana: "", invoice_no: "", memo: "" });
    await repo.deleteCounterparty(db, unused);
    const hist = await repo.getMasterHistory(db);
    expect(hist.filter((h) => h.target_type === "counterparty").map((h) => h.action)).toEqual(["delete", "create", "create"]);
  });
});

describe("証憑（repo）", () => {
  test("登録・訂正・ひも付け・無効が履歴に残り、無効の証憑は変更できない（厳密モード）", async () => {
    const { db } = strict;
    const entry = await repo.createEntry(db, "2026-01-31", lines);
    const id = await repo.createEvidence(db, meta, { name: "invoice.pdf", bytes: pdf("a") });
    await repo.linkEvidence(db, id, entry);
    await repo.updateEvidence(db, id, { ...meta, amount: 12000 }, "金額の入力ミス");
    expect((await repo.getEntryEvidences(db, entry)).map((e) => e.id)).toEqual([id]);
    await repo.voidEvidence(db, id, "二重登録");
    const e = (await repo.getEvidence(db, id))!;
    expect(e.is_void).toBe(1);
    expect((await repo.getEvidenceHistory(db, id)).map((h) => h.action)).toEqual(["void", "update", "link", "create"]);
    await expect(repo.updateEvidence(db, id, meta)).rejects.toThrow(/無効/);
    await expect(repo.linkEvidence(db, id, entry)).rejects.toThrow(/無効/);
    // 中身は残っている
    expect(new TextDecoder().decode(await repo.getEvidenceBytes(db, id))).toBe("%PDF-1.7\na");
  });

  test("対応外のファイル・必須項目の抜けは登録できない", async () => {
    const { db } = strict;
    await expect(repo.createEvidence(db, meta, { name: "a.sh", bytes: new TextEncoder().encode("hello") })).rejects.toThrow(/取り込めません/);
    await expect(repo.createEvidence(db, { ...meta, counterparty: "" }, { name: "a.pdf", bytes: pdf("a") })).rejects.toThrow(/取引先/);
    expect(await repo.getEvidences(db)).toEqual([]);
  });

  test("HEIC・CSV は受け取ったまま保存する（変換しない。ハッシュも元のファイルのもの）", async () => {
    const { db } = strict;
    const { sha256Hex } = await import("../lib/evidence");
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 1, 2, 3, 4]);
    const id = await repo.createEvidence(db, { ...meta, doc_type: "領収書" }, { name: "IMG_0001.HEIC", bytes: heic });
    const e = (await repo.getEvidence(db, id))!;
    expect(e.mime).toBe("image/heic");
    expect(await repo.getEvidenceBytes(db, id)).toEqual(heic);
    expect(e.sha256).toBe(await sha256Hex(heic));
    const csv = await repo.createEvidence(db, meta, { name: "明細.csv", bytes: new Uint8Array([0x8b, 0xe0, 0x8a, 0x7a, 0x0a]) });
    expect((await repo.getEvidence(db, csv))!.mime).toBe("text/csv");
  });

  test("改ざんの確認：中身とハッシュを直接書き換えても、登録時の履歴と食い違えば見つかる", async () => {
    const { db, raw } = strict;
    const id = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    expect((await repo.verifyEvidences(db))[0].status).toBe("ok");
    // トリガーを外して、ファイルとハッシュを両方すり替える（SQLite を直接いじられた想定）
    raw.run("DROP TRIGGER trg_evidence_files_no_update");
    raw.run("DROP TRIGGER trg_evidences_file_fixed");
    raw.run("UPDATE evidence_files SET data = ? WHERE evidence_id = ?", [Buffer.from(pdf("b")).toString("base64"), id]);
    expect((await repo.verifyEvidences(db))[0].detail).toMatch(/中身/);
    const { sha256Hex } = await import("../lib/evidence");
    raw.run("UPDATE evidences SET sha256 = ? WHERE id = ?", [await sha256Hex(pdf("b")), id]);
    expect((await repo.verifyEvidences(db))[0].detail).toMatch(/履歴/);
  });

  test("通常モード：仕訳を削除してもひも付けだけ外れる。証憑の履歴は残り、無効にも本当の削除もできる（削除したことは記録に残る）", async () => {
    const { db, raw } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    const ls = lines.map((l) => ({ ...l, account_id: accts[l.account_id - 1]?.id ?? l.account_id }));
    const entry = await repo.createEntry(db, "2026-01-31", ls);
    const a = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const b = await repo.createEvidence(db, meta, { name: "b.pdf", bytes: pdf("b") });
    await repo.linkEvidence(db, a, entry);
    await repo.deleteEntry(db, entry);
    expect((await repo.getEvidence(db, a))!.entry_ids).toEqual([]);
    // 電子取引データの保存は帳簿の保存方式によらないので、通常モードでも履歴を残す（記録の連鎖には入れない）
    await repo.updateEvidence(db, b, { ...meta, amount: 12_000 });
    await expect(repo.voidEvidence(db, b)).rejects.toThrow(/理由/);
    await repo.voidEvidence(db, b, "二重に取り込んだ");
    expect((await repo.getEvidence(db, b))!.is_void).toBe(1);
    expect((await repo.getEvidenceHistory(db, b)).map((h) => [h.action, h.reason])).toEqual([["void", "二重に取り込んだ"], ["update", ""], ["create", ""]]);
    expect(raw.query("SELECT COUNT(*) AS n FROM audit_chain").get()).toEqual({ n: 0 });
    // 本当に削除：ファイル・ひも付け・履歴は消え、削除したことと最後の内容が残る
    await repo.deleteEvidence(db, b, "不要になった");
    expect(await repo.getEvidence(db, b)).toBeNull();
    expect(await repo.getEvidenceHistory(db, b)).toEqual([]);
    const [d] = await repo.getEvidenceDeletions(db);
    expect(d).toMatchObject({ evidence_id: b, reason: "不要になった", history_count: 3, amount: 12_000, file_name: "b.pdf", is_void: 1 });
    expect(() => raw.run("DELETE FROM evidence_deletions")).toThrow(/削除できません/);
  });

  test("厳密モード：証憑は削除できない（無効にする）。履歴も消せない", async () => {
    const { db, raw } = strict;
    const a = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    await expect(repo.deleteEvidence(db, a)).rejects.toThrow(/削除できません/);
    expect(() => raw.run("DELETE FROM evidence_history WHERE evidence_id = ?", [a])).toThrow(/削除できません/);
    expect(() => raw.run("DELETE FROM evidences WHERE id = ?", [a])).toThrow(/削除できません/);
  });
});

describe("入力期間（repo）", () => {
  test("登録日時は、厳密モードでは登録時の履歴から取る（仕訳の created_at を直接変えても動かない）", async () => {
    const { db, raw } = strict;
    const id = await repo.createEntry(db, "2026-01-05", lines);
    const hist = raw.query("SELECT recorded_at FROM entry_history WHERE entry_id = ? AND action = 'create'").get(id) as { recorded_at: string };
    raw.run("UPDATE journal_entries SET created_at = '2020-01-01 10:00:00' WHERE id = ?", [id]);
    const ls = await repo.getLines(db, "2026-01-01", "2026-12-31");
    expect(ls[0].created_at).toBe(hist.recorded_at);
  });

  test("通常モードは仕訳の登録日時を使う", async () => {
    const { db, raw } = makeDb("standard");
    const id = await repo.createEntry(db, "2026-01-05", lines);
    raw.run("UPDATE journal_entries SET created_at = '2026-04-01 09:00:00' WHERE id = ?", [id]);
    expect((await repo.getLines(db, "2026-01-01", "2026-12-31"))[0].created_at).toBe("2026-04-01 09:00:00");
  });

  test("入力期間は既定 70 日。変更は範囲を確かめ、厳密モードでは履歴に残す", async () => {
    const { db } = strict;
    expect(await repo.getInputPeriodDays(db)).toBe(70);
    await expect(repo.setInputPeriodDays(db, 0)).rejects.toThrow(/1〜365/);
    await expect(repo.setInputPeriodDays(db, 1.5)).rejects.toThrow(/整数/);
    await repo.setInputPeriodDays(db, 40);
    await repo.setInputPeriodDays(db, 40); // 同じ値なら記録しない
    expect(await repo.getInputPeriodDays(db)).toBe(40);
    const h = await repo.getMasterHistory(db);
    expect(h.map((x) => [x.target_type, x.old_value, x.new_value])).toEqual([["setting", "70日", "40日"]]);
  });
});

describe("固定資産台帳・減価償却（repo）", () => {
  const setup = async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const base: repo.AssetInput = {
      name: "パソコン", account_id: id("工具器具備品"), acquired_on: "2026-04-10", used_on: "2026-04-10", cost: 240_000, method: "straight",
      useful_life: 4, business_rate: 80, opening_year: null, opening_book_value: null, disposed_on: null, memo: "",
    };
    return { db, id, base, ids: { expense: id("減価償却費"), draw: id("事業主貸") } };
  };

  test("追加・変更・削除は履歴に残る。資産でない科目や上限を超えた少額減価償却資産は登録できない", async () => {
    const { db, id, base } = await setup();
    expect(id("一括償却資産")).toBeGreaterThan(0);
    const a = await repo.saveAsset(db, null, base);
    await repo.saveAsset(db, a, { ...base, business_rate: 70 });
    await repo.saveAsset(db, a, { ...base, business_rate: 70 }); // 変わらなければ記録しない
    await expect(repo.saveAsset(db, null, { ...base, account_id: id("消耗品費") })).rejects.toThrow(/資産の科目/);
    await expect(repo.saveAsset(db, null, { ...base, method: "small", cost: 400_000 })).rejects.toThrow(/400,000円未満/); // 令和8年4月以後の取得
    expect((await repo.getAssets(db)).map((x) => [x.name, x.business_rate])).toEqual([["パソコン", 70]]);
    expect(await repo.accountUsage(db, id("工具器具備品"))).toBe(1);
    await repo.deleteAsset(db, a);
    expect(await repo.getAssets(db)).toEqual([]);
    const h = (await repo.getMasterHistory(db)).filter((x) => x.target_type === "asset");
    expect(h.map((x) => x.action).reverse()).toEqual(["create", "change", "delete"]);
    expect(h.at(-2)!.new_value).toContain("事業 70%");
  });

  test("年末の減価償却の仕訳：決算整理仕訳で作り、作り直すときは同じ仕訳を訂正する", async () => {
    const { db, base, ids, id } = await setup();
    await repo.saveAsset(db, null, base);
    const make = async () => repo.saveDepreciationRun(db, 2026, depreciationLines(await repo.getAssets(db), 2026, ids));
    const e1 = await make();
    const entry = (await repo.getEntry(db, e1!))!;
    expect([entry.date, entry.is_adjustment]).toEqual(["2026-12-31", 1]);
    const ls = entry.lines;
    expect(ls.map((l) => [l.side, l.account_id, l.amount])).toEqual([
      ["debit", ids.expense, 36_000], ["credit", id("工具器具備品"), 45_000], ["debit", ids.draw, 9_000],
    ]);
    // 割合を変えて作り直す → 同じ仕訳の訂正
    const [a] = await repo.getAssets(db);
    await repo.saveAsset(db, a.id, { ...base, business_rate: 100 });
    expect(await make()).toBe(e1);
    expect((await repo.getEntry(db, e1!))!.lines.map((l) => l.amount)).toEqual([45_000, 45_000]);
    // 資産が無くなったら仕訳を削除する
    await repo.deleteAsset(db, a.id);
    expect(await make()).toBeNull();
    expect(await repo.getDepreciationRun(db, 2026)).toBeNull();
  });

  test("締めた年度の減価償却は作れない。台帳の変更は入力担当にはできない", async () => {
    const { db, base, ids } = await setup();
    await repo.saveAsset(db, null, { ...base, used_on: "2025-04-10", acquired_on: "2025-04-10" });
    await repo.closeYear(db, 2025);
    await expect(repo.saveDepreciationRun(db, 2025, depreciationLines(await repo.getAssets(db), 2025, ids))).rejects.toThrow(/締め/);
    const editor = await repo.createUser(db, "入力", "", "editor");
    repo.setActor(editor, "editor");
    await expect(repo.saveAsset(db, null, base)).rejects.toThrow(/権限/);
    expect(await repo.saveDepreciationRun(db, 2026, depreciationLines(await repo.getAssets(db), 2026, ids))).toBeGreaterThan(0);
  });
});

describe("決算整理（repo）：棚卸・決算整理仕訳の振り戻し", () => {
  test("棚卸を保存して振替の仕訳を作り、作り直すと同じ仕訳を訂正する。締めた年は変えられない", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.saveInventoryCount(db, 2026, { amount: 0, rows: [{ name: "商品A", quantity: 10, unitPrice: 25_000 }] });
    expect(await repo.getInventoryCount(db, 2026)).toEqual({ amount: 0, rows: [{ name: "商品A", quantity: 10, unitPrice: 25_000 }] });
    const ids = { openingAccount: id("期首商品棚卸高"), closingAccount: id("期末商品棚卸高"), stock: id("棚卸資産") };
    const e = await repo.saveYearEndRun(db, 2026, "inventory", inventoryLines(200_000, 250_000, ids));
    const entry = (await repo.getEntry(db, e!))!;
    expect([entry.date, entry.is_adjustment, entry.lines.map((l) => l.amount)]).toEqual(["2026-12-31", 1, [200_000, 200_000, 250_000, 250_000]]);
    expect(await repo.saveYearEndRun(db, 2026, "inventory", inventoryLines(200_000, 260_000, ids))).toBe(e);
    expect(await repo.getYearEndRun(db, 2026, "inventory")).toBe(e);
    await repo.closeYear(db, 2026);
    await expect(repo.saveInventoryCount(db, 2026, { amount: 1, rows: [] })).rejects.toThrow(/締め/);
  });

  test("決算整理仕訳を翌年1月1日付で振り戻す（1回だけ。台帳などから作った仕訳は対象外）", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const accrual = await repo.createEntry(db, "2026-12-31", [
      { row_no: 1, side: "debit", account_id: id("地代家賃"), sub_account_id: null, amount: 50_000, memo: "12月分の家賃", tax_code: "none" },
      { row_no: 1, side: "credit", account_id: id("未払金"), sub_account_id: null, amount: 50_000, memo: "12月分の家賃", tax_code: "none" },
    ], null, "", true);
    const r = await repo.createReversal(db, accrual);
    const rev = (await repo.getEntry(db, r))!;
    expect([rev.date, rev.is_adjustment, rev.lines.map((l) => [l.side, l.account_id])]).toEqual(["2027-01-01", 0, [["debit", id("未払金")], ["credit", id("地代家賃")]]]);
    expect(await repo.getReversal(db, accrual)).toBe(r);
    await expect(repo.createReversal(db, accrual)).rejects.toThrow(/作成済み/);
    const ordinary = await repo.createEntry(db, "2026-05-01", lines);
    await expect(repo.createReversal(db, ordinary)).rejects.toThrow(/決算整理仕訳だけ/);
    const inv = await repo.saveYearEndRun(db, 2026, "inventory", [
      { row_no: 1, side: "debit", account_id: id("棚卸資産"), sub_account_id: null, amount: 1000, memo: "", tax_code: "none" },
      { row_no: 1, side: "credit", account_id: id("期末商品棚卸高"), sub_account_id: null, amount: 1000, memo: "", tax_code: "none" },
    ]);
    await expect(repo.createReversal(db, inv!)).rejects.toThrow(/作り直しの仕組み/);
  });
});

describe("固定資産の売却・除却の仕訳（repo）", () => {
  test("台帳の売却額から仕訳を作り、直したら同じ仕訳を作り直す。除却は固定資産除却損", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const car: repo.AssetInput = {
      name: "営業車", account_id: id("車両運搬具"), acquired_on: "2025-04-01", used_on: "2025-04-01", cost: 1_800_000, method: "straight",
      useful_life: 6, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: "2026-06-30", memo: "",
      disposal_kind: "sale", sale_price: 1_100_000,
    };
    const a = await repo.saveAsset(db, null, car);
    await expect(repo.saveDisposalEntry(db, a, null)).rejects.toThrow(/受け取った科目/);
    const e = await repo.saveDisposalEntry(db, a, id("普通預金"));
    const entry = (await repo.getEntry(db, e!))!;
    expect([entry.date, entry.lines.map((l) => [l.side, l.amount])]).toEqual(["2026-06-30", [["debit", 1_100_000], ["credit", 1_100_000], ["debit", 324_250], ["credit", 324_250]]]);
    expect(await repo.getAssetDisposals(db)).toEqual([{ asset_id: a, entry_id: e!, receive_account_id: id("普通預金") }]);
    // 除却に直して作り直す → 同じ仕訳の訂正
    await repo.saveAsset(db, a, { ...car, disposal_kind: "scrap" }, 2026);
    expect(await repo.saveDisposalEntry(db, a, null)).toBe(e);
    expect((await repo.getEntry(db, e!))!.lines.map((l) => [l.side, l.account_id, l.amount])).toEqual([
      ["debit", id("固定資産除却損"), 1_424_250], ["credit", id("車両運搬具"), 1_424_250],
    ]);
    // 除却に変えたら売却額は消える
    expect((await repo.getAssets(db))[0]).toMatchObject({ disposal_kind: "scrap", sale_price: null });
  });
});

describe("固定資産台帳と年の締め・年ごとの事業専用割合（repo）", () => {
  const setup = async () => {
    const { db, raw } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const car: repo.AssetInput = {
      name: "営業車", account_id: id("車両運搬具"), acquired_on: "2025-04-01", used_on: "2025-04-01", cost: 1_800_000, method: "straight",
      useful_life: 6, business_rate: 60, opening_year: null, opening_book_value: null, disposed_on: null, memo: "",
    };
    const a = await repo.saveAsset(db, null, car);
    return { db, raw, car, a };
  };

  test("事業専用割合は、表示中の年からの割合として残す（前の年はそのまま。前の年と同じに戻せば行を消す）", async () => {
    const { db, car, a } = await setup();
    await repo.saveAsset(db, a, { ...car, business_rate: 80 }, 2026);
    let [x] = await repo.getAssets(db);
    expect([x.business_rate, x.rates]).toEqual([60, [{ from_year: 2026, rate: 80 }]]);
    expect([depreciationFor(x, 2025)!.business, depreciationFor(x, 2026)!.business]).toEqual([135_270, 240_480]);
    // 使い始めた年に変えると、使い始めた年からの割合
    await repo.saveAsset(db, a, { ...car, business_rate: 50 }, 2025);
    [x] = await repo.getAssets(db);
    expect([x.business_rate, x.rates]).toEqual([50, [{ from_year: 2026, rate: 80 }]]);
    await repo.saveAsset(db, a, { ...car, business_rate: 50 }, 2026);
    [x] = await repo.getAssets(db);
    expect([x.business_rate, x.rates]).toEqual([50, undefined]);
    const h = (await repo.getMasterHistory(db)).filter((r) => r.target_type === "asset");
    expect(h[2].new_value).toContain("事業 60%・2026年から 80%");
  });

  test("年の締めをした年に使っている資産は、売却・除却の日と、締めていない年からの割合だけ変えられる（repo とトリガー）", async () => {
    const { db, raw, car, a } = await setup();
    await repo.closeYear(db, 2025);
    await expect(repo.saveAsset(db, a, { ...car, cost: 2_000_000 }, 2026)).rejects.toThrow(/2025年）に使っている資産のため、取得価額は変えられません/);
    await expect(repo.saveAsset(db, a, { ...car, name: "社用車" }, 2026)).rejects.toThrow(/名称は変えられません/);
    await expect(repo.saveAsset(db, a, { ...car, business_rate: 80 }, 2025)).rejects.toThrow(/2025年は締め済み/);
    await expect(repo.deleteAsset(db, a)).rejects.toThrow(/削除できません/);
    await expect(repo.saveAsset(db, null, { ...car, name: "2台目" })).rejects.toThrow(/追加できません/);
    await expect(repo.saveAsset(db, a, { ...car, disposed_on: "2025-12-31" }, 2026)).rejects.toThrow(/売却・除却の日/);
    // 締めていない年からの割合・売却の日はよい
    await repo.saveAsset(db, a, { ...car, business_rate: 80, disposed_on: "2026-09-30" }, 2026);
    const [x] = await repo.getAssets(db);
    expect([x.business_rate, x.rates, x.disposed_on]).toEqual([60, [{ from_year: 2026, rate: 80 }], "2026-09-30"]);
    // ソフトを通さない書き込みもトリガーで止める
    expect(() => raw.run("UPDATE fixed_assets SET cost = 1 WHERE id = ?", [a])).toThrow(/締め済み/);
    expect(() => raw.run("UPDATE fixed_assets SET business_rate = 100 WHERE id = ?", [a])).toThrow(/締め済み/);
    expect(() => raw.run("UPDATE fixed_assets SET disposed_on = '2025-10-31' WHERE id = ?", [a])).toThrow(/締め済み/);
    expect(() => raw.run("DELETE FROM fixed_assets WHERE id = ?", [a])).toThrow(/締め済み/);
    expect(() => raw.run("INSERT INTO asset_rates (asset_id, from_year, rate) VALUES (?, 2025, 10)", [a])).toThrow(/締め済み/);
    raw.run("UPDATE fixed_assets SET disposed_on = '2026-10-31' WHERE id = ?", [a]);
    raw.run("UPDATE asset_rates SET rate = 70 WHERE asset_id = ? AND from_year = 2026", [a]);
    // 締めを戻せば直せる
    await repo.reopenYear(db, 2025, "取得価額の誤り");
    await repo.saveAsset(db, a, { ...car, cost: 2_000_000 }, 2026);
  });

  test("台帳は改ざんの照合に入る。連鎖を始めたあとの帳簿は、開いたときの台帳を基準点にする", async () => {
    const { db, raw, car } = await setup();
    await repo.initChain(db);
    // 台帳を連鎖に入れる前に始めた帳簿のまね：資産は連鎖に記録がない
    raw.run("UPDATE settings SET chain_assets = 0");
    raw.run(`INSERT INTO fixed_assets (id, name, account_id, acquired_on, used_on, cost, method, useful_life, business_rate, memo)
             VALUES (50, '古い資産', ?, '2026-01-10', '2026-01-10', 300000, 'straight', 4, 100, '')`, [car.account_id]);
    const errors = async () => (await repo.verifyIntegrity(db)).issues.filter((i) => i.level === "error").map((i) => i.message);
    expect((await errors()).join()).toMatch(/固定資産 No.50 に記録がありません/);
    await repo.initChain(db);
    expect(await errors()).toEqual([]);
    await repo.saveAsset(db, 50, { ...car, name: "古い資産", acquired_on: "2026-01-10", used_on: "2026-01-10", cost: 300_000, useful_life: 4, business_rate: 90 }, 2027);
    expect(await errors()).toEqual([]);
    raw.run("UPDATE fixed_assets SET cost = 1 WHERE id = 50");
    expect(await errors()).toEqual([expect.stringMatching(/固定資産 No.50 が、最後に記録した内容と一致しません/)]);
    raw.run("UPDATE fixed_assets SET cost = 300000 WHERE id = 50");
    raw.run("UPDATE asset_rates SET rate = 10 WHERE asset_id = 50");
    expect(await errors()).toEqual([expect.stringMatching(/固定資産 No.50/)]);
  });
});

describe("貸倒引当金（repo）", () => {
  test("初期科目に貸倒引当金・繰入・戻入がある。戻入は貸方（繰戻額等）。同じ名前の科目を自分で足していれば、開いたときに足さない", async () => {
    const { db, raw } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const of = (n: string) => accts.find((a) => a.name === n)!;
    expect([of("貸倒引当金"), of("貸倒引当金繰入"), of("貸倒引当金戻入")].map((a) => [a.code, a.category, a.normal_side])).toEqual([
      ["250", "liability", "credit"], ["750", "special", "debit"], ["751", "special", "credit"],
    ]);
    // 古い帳簿で、利用者が「貸倒引当金」を 208 で足していた → 250 には足さない。コードが使われていれば足さない
    raw.run("DELETE FROM accounts WHERE code IN ('250', '751')");
    raw.run("INSERT INTO accounts (code, name, kana, category, normal_side) VALUES ('208', '貸倒引当金', '', 'liability', 'credit'), ('751', '未払費用', '', 'special', 'debit')");
    for (const [code, name] of [["250", "貸倒引当金"], ["751", "貸倒引当金戻入"], ["752", "新しい科目"]]) raw.run(SEED_ACCOUNT_SQL, [code, name, "", "special", "credit", 0, "business", 1]);
    const after = await repo.getAccounts(db, 2026);
    expect(after.filter((a) => a.name === "貸倒引当金").map((a) => a.code)).toEqual(["208"]);
    expect(after.some((a) => a.name === "貸倒引当金戻入")).toBe(false);
    expect(after.find((a) => a.code === "752")?.name).toBe("新しい科目");
  });
  test("自分で足す専従者給与等の科目は、繰入額等（借方）か繰戻額等（貸方）を選べる", async () => {
    const { db } = strict;
    await repo.createAccount(db, { code: "702", name: "退職給与引当金繰入", kana: "", category: "special", side: "debit" });
    await repo.createAccount(db, { code: "703", name: "退職給与引当金戻入", kana: "", category: "special", side: "credit" });
    await repo.createAccount(db, { code: "630", name: "サブスク費", kana: "", category: "expense", side: "credit" }); // 経費は選べない
    const accts = await repo.getAccounts(db, 2026);
    expect(["702", "703", "630"].map((c) => accts.find((a) => a.code === c)!.normal_side)).toEqual(["debit", "credit", "debit"]);
  });
  test("年末の洗替の仕訳：決算整理仕訳で作り、作り直すときは同じ仕訳を訂正し、無くなれば削除する。締めた年度は作れない", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const calc = (notes: Record<string, string>, opening: number) =>
      allowanceCalc(accts, (a) => (a.name === "売掛金" ? 1_000_000 : 0), opening, notes, true);
    const e1 = await repo.saveAllowanceRun(db, 2026, allowanceLines(accts, calc({}, 30_000))!);
    const entry = (await repo.getEntry(db, e1!))!;
    expect([entry.date, entry.is_adjustment, entry.lines.map((l) => l.amount)]).toEqual(["2026-12-31", 1, [30_000, 30_000, 55_000, 55_000]]);
    expect(await repo.saveAllowanceRun(db, 2026, allowanceLines(accts, calc({ "allowance:amount": "40000" }, 30_000))!)).toBe(e1);
    expect((await repo.getEntry(db, e1!))!.lines.map((l) => l.amount)).toEqual([30_000, 30_000, 40_000, 40_000]);
    expect(await repo.saveAllowanceRun(db, 2026, [])).toBeNull();
    expect(await repo.getAllowanceRun(db, 2026)).toBeNull();
    await repo.closeYear(db, 2025);
    await expect(repo.saveAllowanceRun(db, 2025, allowanceLines(accts, calc({}, 0))!)).rejects.toThrow(/締め/);
  });
});

describe("不動産所得（repo）", () => {
  test("不動産所得の初期科目は非表示。事業者設定で「あり」にすると表示し、変更は履歴に残る", async () => {
    const { db } = strict;
    const hidden = (await repo.getAccounts(db, 2026)).filter((a) => a.income_kind === "realestate");
    expect(hidden.length).toBeGreaterThan(5);
    expect(hidden.every((a) => a.is_active === 0)).toBe(true);
    await repo.saveRealEstate(db, "business");
    expect((await repo.getSettings(db)).real_estate).toBe("business");
    expect((await repo.getAccounts(db, 2026)).filter((a) => a.income_kind === "realestate").every((a) => a.is_active === 1)).toBe(true);
    expect((await repo.getMasterHistory(db)).find((x) => x.label === "不動産所得")).toMatchObject({ old_value: "なし", new_value: "あり（事業的規模）（2026年から）" });
    await expect(repo.saveRealEstate(db, "big" as never)).rejects.toThrow(/区分/);
  });
  test("足す科目は損益の科目だけ不動産所得にできる。固定資産は所得の区分を持つ", async () => {
    const { db } = strict;
    await repo.createAccount(db, { code: "463", name: "駐車場収入", kana: "", category: "revenue", income_kind: "realestate" });
    await repo.createAccount(db, { code: "208", name: "預り保証金", kana: "", category: "liability", income_kind: "realestate" });
    const accts = await repo.getAccounts(db, 2026);
    expect(["463", "208"].map((c) => accts.find((a) => a.code === c)!.income_kind)).toEqual(["realestate", "business"]);
    const id = await repo.saveAsset(db, null, {
      name: "アパート", account_id: accts.find((a) => a.name === "建物")!.id, acquired_on: "2026-01-10", used_on: "2026-01-10", cost: 22_000_000, method: "straight",
      useful_life: 22, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "", income_kind: "realestate",
    });
    expect((await repo.getAssets(db)).find((a) => a.id === id)?.income_kind).toBe("realestate");
  });
});

describe("消費税の棚卸資産の調整（repo）", () => {
  test("年度ごとに保存し、金額の無い行は落とす。変えたら履歴に残り、締めた年度は変えられない", async () => {
    const { db } = strict;
    expect(await repo.getInventoryAdjust(db, 2026)).toBeNull();
    await repo.saveInventoryAdjust(db, 2026, { direction: "add", rows: [{ rate: 10, pct: 100, amount: 1_741_000 }, { rate: 8, pct: 80, amount: 0 }] });
    expect(await repo.getInventoryAdjust(db, 2026)).toEqual({ direction: "add", rows: [{ rate: 10, pct: 100, amount: 1_741_000 }] });
    await expect(repo.saveInventoryAdjust(db, 2026, { direction: "add", rows: [{ rate: 10, pct: 60, amount: 1 }] })).rejects.toThrow(/控除できる割合/);
    await expect(repo.saveInventoryAdjust(db, 2026, { direction: "add", rows: [{ rate: 10, pct: 100, amount: -1 }] })).rejects.toThrow(/取得価額/);
    await repo.saveInventoryAdjust(db, 2026, { direction: "add", rows: [] });
    expect(await repo.getInventoryAdjust(db, 2026)).toBeNull();
    const h = (await repo.getMasterHistory(db)).filter((x) => x.label.includes("棚卸資産の調整"));
    expect(h.map((x) => x.new_value).reverse()).toEqual(["加算 10% 1,741,000円", "なし"]);
    await repo.closeYear(db, 2025);
    await expect(repo.saveInventoryAdjust(db, 2025, { direction: "sub", rows: [{ rate: 10, pct: 100, amount: 1 }] })).rejects.toThrow(/締め/);
  });
});

describe("申告の種類（年度ごと。repo）", () => {
  test("年度ごとに保存し、次に変える年まで引き継ぐ。設定の無い年は帳簿を作ったときの設定。変更は履歴に残る", async () => {
    const { db } = strict;
    expect(await repo.filingTypeIn(db, 2026)).toBe("blue65");
    await repo.saveFilingYear(db, 2025, "white");
    await repo.saveFilingYear(db, 2026, "blue65");
    expect(await repo.getFilingYears(db)).toEqual([{ from_year: 2025, filing_type: "white" }, { from_year: 2026, filing_type: "blue65" }]);
    expect([await repo.filingTypeIn(db, 2024), await repo.filingTypeIn(db, 2025), await repo.filingTypeIn(db, 2027)]).toEqual(["blue65", "white", "blue65"]);
    const h = (await repo.getMasterHistory(db)).filter((x) => x.label.includes("申告の種類"));
    expect(h.map((x) => [x.label, x.old_value, x.new_value]).reverse()).toEqual([
      ["2025年の申告の種類", "青色申告（65万円控除）（前の年から引き継ぎ）", "白色申告"],
      ["2026年の申告の種類", "白色申告（前の年から引き継ぎ）", "青色申告（65万円控除）"],
    ]);
    // 年度ごとに決めたあとは、事業者の情報からは変えられない
    await expect(repo.saveSettings(db, { ...(await repo.getSettings(db)), filing_type: "white" })).rejects.toThrow(/年度ごと/);
  });
  test("締めた年度と、締めた年度が引き継ぐ年の設定は変えられない（トリガーでも止める）", async () => {
    const { db, raw } = strict;
    await repo.saveFilingYear(db, 2024, "white");
    await repo.closeYear(db, 2025);
    await expect(repo.saveFilingYear(db, 2025, "blue65")).rejects.toThrow(/締め/);
    await expect(repo.saveFilingYear(db, 2024, "blue65")).rejects.toThrow(/2025年は締め済み/);
    expect(() => raw.run("INSERT INTO filing_years (from_year, filing_type) VALUES (2025, 'blue10')")).toThrow(/締め/);
    await repo.saveFilingYear(db, 2026, "blue10");
    expect(await repo.filingTypeIn(db, 2026)).toBe("blue10");
  });
  test("少額減価償却資産の特例（青色だけ）：白色の年に使い始めた資産には使えず、使っていれば白色にできない", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const asset: repo.AssetInput = {
      name: "タブレット", account_id: accts.find((a) => a.name === "工具器具備品")!.id, acquired_on: "2026-05-01", used_on: "2026-05-01", cost: 150_000,
      method: "small", useful_life: 0, business_rate: 100, opening_year: null, opening_book_value: null, disposed_on: null, memo: "",
    };
    await repo.saveAsset(db, null, asset);
    await expect(repo.saveFilingYear(db, 2026, "white")).rejects.toThrow(/少額減価償却資産/);
    await expect(repo.saveFilingYear(db, 2025, "white")).rejects.toThrow(/2025年以降/);
    await repo.saveFilingYear(db, 2027, "white");
    await expect(repo.saveAsset(db, null, { ...asset, acquired_on: "2027-05-01", used_on: "2027-05-01" })).rejects.toThrow(/青色申告のときだけ/);
  });
});

describe("決算書の書き込み（repo）", () => {
  test("年度ごとに保存し、空にすると消える。締めた年度は変えられない", async () => {
    const { db } = strict;
    await repo.saveStatementNote(db, 2026, "rent:cp:3:address", "  東京都千代田区  ");
    await repo.saveStatementNote(db, 2026, "special", "特になし");
    expect(await repo.getStatementNotes(db, 2026)).toEqual({ "rent:cp:3:address": "東京都千代田区", special: "特になし" });
    await repo.saveStatementNote(db, 2026, "special", "");
    expect(await repo.getStatementNotes(db, 2026)).toEqual({ "rent:cp:3:address": "東京都千代田区" });
    expect(await repo.getStatementNotes(db, 2025)).toEqual({});
    await repo.closeYear(db, 2025);
    await expect(repo.saveStatementNote(db, 2025, "special", "x")).rejects.toThrow(/締め/);
  });
});

describe("通常 → 厳密 の切り替え（repo）", () => {
  test("翌年の仕訳がまだ無いときだけ切り替えられ、戻せない。連鎖を始め、切り替えたことを履歴に残す", async () => {
    const { db, raw } = makeDb("standard");
    await repo.createEntry(db, "2026-03-01", lines.map((l) => ({ ...l, account_id: l.account_id })));
    expect(await repo.canSwitchToStrict(db, 2026)).toBe(false);
    expect(await repo.canSwitchToStrict(db, 2027)).toBe(true);
    await expect(repo.switchToStrict(db, 2026)).rejects.toThrow(/切り替えられません/);
    await repo.switchToStrict(db, 2027);
    const s = await repo.getSettings(db);
    expect([s.e_book_mode, s.strict_from_year, !!s.strict_switched_at]).toEqual(["strict", 2027, true]);
    expect(await repo.canSwitchToStrict(db, 2028)).toBe(false);
    expect(() => raw.run("UPDATE settings SET e_book_mode = 'standard'")).toThrow(/変更できません/);
    expect(() => raw.run("UPDATE settings SET strict_from_year = 2026")).toThrow(/変更できません/);
    const h = (await repo.getMasterHistory(db)).find((x) => x.label === "帳簿の保存方式")!;
    expect([h.old_value, h.new_value]).toEqual(["通常", "電子帳簿保存法に対応（2027年から）"]);
    // 切り替えたあとは履歴が残り、改ざんの確認も通る（切り替える前の仕訳は基準点に入っている）
    const id = await repo.createEntry(db, "2027-01-05", lines);
    expect((await repo.getHistory(db, id)).length).toBe(1);
    expect((await repo.verifyIntegrity(db)).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("作り直して使わなくなったトリガー（古いモード固定）は、消されていたとは数えない", async () => {
    const { db, raw } = strict;
    raw.run("UPDATE settings SET known_triggers = ?", [JSON.stringify(["trg_settings_mode_fixed", "trg_entries_no_delete"])]);
    await repo.checkTriggers(db, ["trg_entries_no_delete"]);
    expect(await repo.getIntegrityEvents(db)).toEqual([]);
  });

  test("最初から厳密モードの帳簿は切り替えの対象外", async () => {
    expect(await repo.canSwitchToStrict(strict.db, 2027)).toBe(false);
  });
});

describe("翌年への繰越（repo）", () => {
  test("既定では締めずに翌年の期首残高だけ作る。締めると選んだときだけ締める", async () => {
    const { db } = strict;
    const capital = (await repo.getAccounts(db, 2026)).find((a) => a.name === "元入金")!.id;
    const opening = { [subKey(capital, null)]: 100_000 };
    await repo.carryForward(db, 2026, opening);
    expect(await repo.hasOpening(db, 2027)).toBe(true);
    expect((await repo.getClosings(db)).map((c) => c.fiscal_year)).toEqual([]);
    // 締めていないので、2026年はそのまま直せる。直したあと繰越をやり直し、今度は締める
    await repo.createEntry(db, "2026-12-20", lines);
    await repo.carryForward(db, 2026, opening, true);
    expect((await repo.getClosings(db)).map((c) => c.fiscal_year)).toEqual([2026]);
    await expect(repo.createEntry(db, "2026-12-21", lines)).rejects.toThrow(/締め/);
  });
});

describe("月の締め（repo）", () => {
  test("何月まで締めたかで止める：締めた月の仕訳だけ変えられず、年度ごとのものは年の締めまで変えられる", async () => {
    const { db, raw } = strict;
    const sept = await repo.createEntry(db, "2026-09-10", lines);
    await repo.closeThrough(db, 2026, 9);
    await expect(repo.createEntry(db, "2026-09-30", lines)).rejects.toThrow(/9月まで締め済み/);
    await expect(repo.updateEntry(db, sept, "2026-10-01", lines)).rejects.toThrow(/締め/);
    expect(await repo.createEntry(db, "2026-10-01", lines)).toBeGreaterThan(0);
    // 期首残高（年度ごとのもの）は、月の締めでは止めない
    const capital = (await repo.getAccounts(db, 2026)).find((a) => a.name === "元入金")!.id;
    await repo.saveOpening(db, 2026, { [subKey(capital, null)]: 1000 });
    // DB のトリガーでも止まる（ソフトを通さない書き込み）
    expect(() => raw.run("UPDATE journal_entries SET date = '2026-08-01' WHERE id = ?", [sept])).toThrow(/締め済み/);
    // 戻すのは前へだけ。締めは先へだけ（同じか前の月を選んでも何もしない）
    await repo.closeThrough(db, 2026, 5);
    expect((await repo.getClosings(db))[0].period_end).toBe("2026-09-30");
    await repo.closeYear(db, 2026);
    await expect(repo.saveOpening(db, 2026, { [subKey(capital, null)]: 2000 })).rejects.toThrow(/締め済み/);
  });

  test("年の締めから1回で月まで戻せる。厳密モードでは理由が要り、締めと戻しは履歴に残る", async () => {
    const { db } = strict;
    await repo.closeYear(db, 2026);
    await expect(repo.reopenTo(db, 2026, 10, "")).rejects.toThrow(/理由/);
    await repo.reopenTo(db, 2026, 10, "11月の売上の計上漏れ");
    expect((await repo.getClosings(db))[0].period_end).toBe("2026-10-31");
    await expect(repo.createEntry(db, "2026-10-31", lines)).rejects.toThrow(/10月まで/);
    expect(await repo.createEntry(db, "2026-11-01", lines)).toBeGreaterThan(0);
    await repo.reopenTo(db, 2026, 0, "全部直す");
    expect(await repo.getClosings(db)).toEqual([]);
    const h = (await repo.getMasterHistory(db)).filter((x) => x.target_type === "closing").reverse();
    expect(h.map((x) => [x.action, x.old_value, x.new_value])).toEqual([
      ["close", "締めなし", "年の締め（12月まで）"],
      ["unlock", "年の締め（12月まで）", "10月まで締めに戻す（理由：11月の売上の計上漏れ）"],
      ["unlock", "10月まで締め", "締めなしに戻す（理由：全部直す）"],
    ]);
    expect((await repo.verifyIntegrity(db)).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("通常モードは理由なしで戻せる", async () => {
    const { db } = makeDb("standard");
    await repo.closeThrough(db, 2026, 3);
    await repo.reopenTo(db, 2026, 1, "");
    expect((await repo.getClosings(db))[0].period_end).toBe("2026-01-31");
  });
});

describe("帳簿ファイルの暗号化（repo）", () => {
  test("かける・パスワードを変える・外すと履歴に残る。管理者以外と読み取り専用ではできない（処理も動かさない）", async () => {
    const { db } = strict;
    let ran = 0;
    const run = async () => { ran++; return "ok"; };
    expect(await repo.changeEncryption(db, "on", run)).toBe("ok");
    await repo.changeEncryption(db, "password", run);
    await repo.changeEncryption(db, "off", run);
    const h = await repo.getMasterHistory(db);
    expect(h.map((x) => [x.label, x.old_value, x.new_value]).reverse()).toEqual([
      ["帳簿ファイルの暗号化", "なし", "あり（パスワードを設定）"],
      ["帳簿ファイルの暗号化", "あり", "あり（パスワードを変更）"],
      ["帳簿ファイルの暗号化", "あり", "なし（暗号化をやめた）"],
    ]);
    const editor = await repo.createUser(db, "編集者", "", "editor");
    repo.setActor(editor, "editor");
    await expect(repo.changeEncryption(db, "on", run)).rejects.toThrow(/権限/);
    repo.setActor(null);
    repo.setReadOnly(true);
    await expect(repo.changeEncryption(db, "on", run)).rejects.toThrow(/読み取り専用/);
    repo.setReadOnly(false);
    expect(ran).toBe(3);
  });

  test("処理が失敗したら履歴に残さない", async () => {
    const { db } = strict;
    await expect(repo.changeEncryption(db, "on", async () => { throw new Error("今のパスワード（または回復キー）が違います"); })).rejects.toThrow(/違います/);
    expect(await repo.getMasterHistory(db)).toEqual([]);
  });
});

describe("仕訳の CSV 取り込み（repo）", () => {
  test("まとめて登録し、厳密モードでは登録の履歴に取り込み元を残す", async () => {
    const { db } = strict;
    const ids = await repo.importEntries(db, [
      { date: "2026-01-05", lines, counterpartyId: null },
      { date: "2026-01-06", lines, counterpartyId: null },
    ], "仕訳.csv");
    expect(ids).toHaveLength(2);
    const h = await repo.getHistory(db);
    expect(h.map((x) => x.reason)).toEqual(["CSV 取り込み（仕訳.csv）", "CSV 取り込み（仕訳.csv）"]);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    // 電子帳簿保存法の画面の「CSV 取り込みで登録」の数（手で入れた仕訳・削除した仕訳・ほかの年は数えない）
    await repo.createEntry(db, "2026-01-07", lines);
    await repo.deleteEntry(db, ids[1], "二重");
    expect([await repo.countImportedEntries(db, 2026), await repo.countImportedEntries(db, 2025)]).toEqual([1, 0]);
  });

  test("途中で失敗したら1件も残らない（締め済みの年度が混ざっていた）", async () => {
    const { db } = strict;
    await repo.closeYear(db, 2025);
    await expect(repo.importEntries(db, [
      { date: "2026-01-05", lines, counterpartyId: null },
      { date: "2025-12-31", lines, counterpartyId: null },
    ], "x.csv")).rejects.toThrow(/締め済み/);
    expect(await repo.getLines(db, "2025-01-01", "2026-12-31")).toEqual([]);
  });
});

describe("履歴の読み込み（repo）", () => {
  test("件数で打ち切らず、すべて返す（訂正・削除履歴は全件確認できること）", async () => {
    const { db, raw } = strict;
    raw.run("INSERT INTO users (name) VALUES ('a')");
    const id = await repo.createEntry(db, "2026-01-05", lines);
    const insHist = raw.prepare("INSERT INTO entry_history (entry_id, revision, action, snapshot) VALUES (?, ?, 'update', '{\"date\":\"2026-01-05\",\"lines\":[]}')");
    const insLog = raw.prepare("INSERT INTO access_log (user_id, action) VALUES (1, 'login')");
    const insMaster = raw.prepare("INSERT INTO master_history (target_type, target_id, action, fiscal_year) VALUES ('account', 1, 'change', 2026)");
    raw.transaction(() => {
      for (let i = 2; i <= 2101; i++) insHist.run(id, i);
      for (let i = 0; i < 2100; i++) insLog.run();
      for (let i = 0; i < 2100; i++) insMaster.run();
    })();
    expect(await repo.getHistory(db)).toHaveLength(2101);
    expect(await repo.getAccessLog(db)).toHaveLength(2100);
    expect(await repo.getMasterHistory(db)).toHaveLength(2100);
  });
});

describe("固定の科目（repo）", () => {
  test("現金は名前を変えられる（厳密モードではその年度から）。非表示とコードの変更はできない", async () => {
    const { db } = strict;
    const cash = (await repo.getAccounts(db, 2026)).find((a) => a.code === "101")!;
    await repo.updateAccount(db, cash.id, { code: "101", name: "現金預金", kana: "げんきんよきん" });
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === cash.id)!.name).toBe("現金預金");
    expect((await repo.getAccounts(db, 2025)).find((a) => a.id === cash.id)!.name).toBe("現金");
    await expect(repo.setAccountActive(db, cash.id, false)).rejects.toThrow(/非表示にできません/);
    await expect(repo.updateAccount(db, cash.id, { code: "105", name: "現金預金", kana: "" })).rejects.toThrow(/コードを変えられません/);
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === cash.id)).toMatchObject({ code: "101", is_active: 1 });
    expect((await repo.getMasterHistory(db)).map((h) => [h.action, h.old_value, h.new_value])).toEqual([["rename", "現金", "現金預金"]]);
  });

  test("固定でない初期科目は非表示にできる", async () => {
    const { db } = strict;
    const bank = (await repo.getAccounts(db, 2026)).find((a) => a.code === "103")!;
    await repo.setAccountActive(db, bank.id, false);
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === bank.id)!.is_active).toBe(0);
  });
});

describe("勘定科目の削除（repo）", () => {
  test("家事按分を設定した科目は「使用済み」として削除できない（非表示にはできる）", async () => {
    const { db } = makeDb("standard");
    const code = repo.nextAccountCode(await repo.getAccounts(db, 2026), "expense")!;
    await repo.createAccount(db, { code, name: "研究費", kana: "けんきゅうひ", category: "expense" });
    const acc = (await repo.getAccounts(db, 2026)).find((a) => a.name === "研究費")!;
    expect(await repo.accountUsage(db, acc.id)).toBe(0);
    await repo.saveHomeUseRate(db, 2026, { account_id: acc.id, rate: 50, method: "entry", basis: "" });
    expect(await repo.accountUsage(db, acc.id)).toBe(1);
    await expect(repo.deleteAccount(db, acc.id)).rejects.toThrow(/使われている/);
    expect((await repo.getAccounts(db, 2026)).some((a) => a.id === acc.id)).toBe(true);
    await repo.setAccountActive(db, acc.id, false);
  });

  test("明細のルール・明細・定型仕訳で使っている科目・補助科目・取引先は、使用件数に入る", async () => {
    const { db } = makeDb("standard");
    const code = repo.nextAccountCode(await repo.getAccounts(db, 2026), "expense")!;
    await repo.createAccount(db, { code, name: "保守料", kana: "", category: "expense" });
    const accts = await repo.getAccounts(db, 2026);
    const acc = accts.find((a) => a.name === "保守料")!;
    const bank = accts.find((a) => a.name === "普通預金")!;
    const cp = await repo.createCounterparty(db, { name: "株式会社B", kana: "", invoice_no: "", memo: "" });
    const rule = { id: 0, keyword: "ﾎｼﾕ", direction: "decrease" as const, target_account_id: null, account_id: acc.id, sub_account_id: null, tax_code: null, invoice_kind: null, counterparty_id: cp, memo: "" };
    await repo.saveBankRule(db, rule);
    expect(await repo.accountUsage(db, acc.id)).toBe(1);
    await expect(repo.deleteAccount(db, acc.id)).rejects.toThrow(/明細のルール/);
    expect(await repo.counterpartyUsage(db, cp)).toBe(1);
    await expect(repo.deleteCounterparty(db, cp)).rejects.toThrow(/明細のルール/);

    const cp2 = await repo.createCounterparty(db, { name: "株式会社C", kana: "", invoice_no: "", memo: "" });
    await repo.createTemplate(db, "保守", [{ ...emptyRow(), debitAccountId: acc.id, debitAmount: 1000, creditAccountId: bank.id, creditAmount: 1000 }], cp2);
    expect(await repo.counterpartyUsage(db, cp2)).toBe(1);

    await repo.createSub(db, bank.id, "C銀行");
    const sub = (await repo.getSubAccounts(db, 2026)).find((x) => x.name === "C銀行")!;
    expect(await repo.subUsage(db, sub.id)).toBe(0);
    await repo.addBankLines(db, bank.id, sub.id, [{ row: 1, date: "2026-10-01", description: "x", side: "debit", amount: 100, balance: null, fingerprint: "f1" }], "a.csv");
    expect(await repo.subUsage(db, sub.id)).toBe(1);
  });

  test("使っていない科目は削除できる", async () => {
    const { db } = makeDb("standard");
    const code = repo.nextAccountCode(await repo.getAccounts(db, 2026), "expense")!;
    await repo.createAccount(db, { code, name: "研究費", kana: "", category: "expense" });
    const acc = (await repo.getAccounts(db, 2026)).find((a) => a.name === "研究費")!;
    await repo.deleteAccount(db, acc.id);
    expect((await repo.getAccounts(db, 2026)).some((a) => a.id === acc.id)).toBe(false);
  });
});

describe("家事按分の年末振替（repo）", () => {
  test("通常モード：振替の仕訳を削除できる（振替の記録も消える）", async () => {
    const { db } = makeDb("standard");
    const id = await repo.saveHomeUseRunEntry(db, 2026, "2026-12-31", lines, null);
    expect(await repo.getHomeUseRun(db, 2026)).toBe(id);
    await repo.deleteEntry(db, id);
    expect(await repo.getEntry(db, id)).toBeNull();
    expect(await repo.getHomeUseRun(db, 2026)).toBeNull();
    // 作り直せる
    const id2 = await repo.saveHomeUseRunEntry(db, 2026, "2026-12-31", lines, null);
    expect(await repo.getHomeUseRun(db, 2026)).toBe(id2);
  });
});

describe("改ざんの検知（repo）", () => {
  const setup = async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const e1 = await repo.createEntry(db, "2026-01-10", lines);
    const e2 = await repo.createEntry(db, "2026-01-20", lines);
    await repo.updateEntry(db, e2, "2026-01-21", lines, "日付の訂正");
    await repo.saveOpening(db, 2026, { "1:0": 5000, [`${(await repo.getAccounts(db, 2026)).find((a) => a.name === "元入金")!.id}:0`]: 5000 });
    const ev = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    await repo.linkEvidence(db, ev, e1);
    await repo.closeYear(db, 2025);
    await repo.reopenYear(db, 2025, "確認");
    return { db, raw, e1, e2, ev };
  };
  const errors = (r: repo.IntegrityReport) => r.issues.filter((i) => i.level === "error").map((i) => i.message);

  test("ソフトを通した操作だけなら、問題なし", async () => {
    const { db } = await setup();
    const r = await repo.verifyIntegrity(db, { files: true });
    expect(r.enabled).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.length).toBeGreaterThan(5);
  });

  test("仕訳の金額を直接書き換えると見つかる", async () => {
    const { db, raw, e1 } = await setup();
    raw.run("UPDATE journal_lines SET amount = 1 WHERE entry_id = ?", [e1]);
    expect(errors(await repo.verifyIntegrity(db))).toEqual([expect.stringMatching(new RegExp(`伝票 No.${e1}.*一致しません`))]);
  });

  test("仕訳を直接足すと見つかる", async () => {
    const { db, raw } = await setup();
    raw.run("INSERT INTO journal_entries (id, date) VALUES (99, '2026-03-01')");
    expect(errors(await repo.verifyIntegrity(db)).join()).toMatch(/伝票 No.99.*記録がありません/);
  });

  test("期首残高・証憑を直接書き換えると見つかる", async () => {
    const { db, raw, ev } = await setup();
    raw.run("UPDATE opening_balances SET amount = 9999 WHERE account_id = 1 AND fiscal_year = 2026");
    raw.run("UPDATE evidences SET amount = 1 WHERE id = ?", [ev]);
    const msgs = errors(await repo.verifyIntegrity(db)).join("\n");
    expect(msgs).toMatch(/2026年の期首残高/);
    expect(msgs).toMatch(new RegExp(`証憑 No.${ev}`));
  });

  test("履歴を書き換え・削除すると見つかる（トリガーを消されても）", async () => {
    const { db, raw } = await setup();
    raw.run("DROP TRIGGER trg_history_no_update");
    raw.run("DROP TRIGGER trg_history_no_delete");
    raw.run("UPDATE entry_history SET reason = '改ざん' WHERE id = 2");
    raw.run("DELETE FROM entry_history WHERE id = 1");
    const msgs = errors(await repo.verifyIntegrity(db)).join("\n");
    expect(msgs).toMatch(/仕訳の履歴 No.2 の内容が.*書き換えられています/);
    expect(msgs).toMatch(/仕訳の履歴 No.1 が消されています/);
  });

  test("連鎖の途中を消すと、つながりが切れて見つかる", async () => {
    const { db, raw } = await setup();
    raw.run("DROP TRIGGER trg_audit_chain_no_delete");
    raw.run("DELETE FROM audit_chain WHERE id = 3");
    expect(errors(await repo.verifyIntegrity(db)).join()).toMatch(/途切れています/);
  });

  test("連鎖をまるごと作り直されると中では見抜けないが、控えた確認コードで見つかる", async () => {
    const { db, raw, e1 } = await setup();
    const code = repo.anchorCode((await repo.getChainHead(db))!.row_hash);
    expect(await repo.findAnchor(db, code)).not.toBeNull();
    // 改ざんしたうえで、連鎖を一から計算し直す（同じソフトのコードを使えば誰でもできる）
    raw.run("UPDATE journal_lines SET amount = 1 WHERE entry_id = ?", [e1]);
    raw.run("DROP TRIGGER trg_audit_chain_no_delete");
    raw.run("DELETE FROM audit_chain");
    raw.run("UPDATE settings SET chain_initialized = 0");
    await repo.initChain(db);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]); // 中だけでは見抜けない
    expect(await repo.findAnchor(db, code)).toBeNull(); // 控えたコードが無くなっている
  });

  test("トリガーが消されていたら、開いたときに記録して知らせる", async () => {
    const { db, raw } = await setup();
    const names = () => (raw.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((x) => x.name);
    await repo.checkTriggers(db, names()); // 前回開いたときの一覧を控える
    raw.run("DROP TRIGGER trg_history_no_update");
    await repo.checkTriggers(db, names()); // 次に開いたとき
    const r = await repo.verifyIntegrity(db);
    expect(r.issues.filter((i) => i.level === "warn").map((i) => i.message).join()).toMatch(/trg_history_no_update/);
    expect(errors(r)).toEqual([]);
  });

  test("連鎖を始める前の履歴も取り込み、その時点を基準にする", async () => {
    const { db } = strict;
    await repo.createEntry(db, "2026-01-10", lines); // 連鎖を始める前
    await repo.initChain(db);
    await repo.createEntry(db, "2026-01-11", lines);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
  });
});

describe("改ざんの確認と書き込みの順番（repo）", () => {
  test("書き込みの途中では確認せず、終わってから確認する（書きかけを「連鎖に入っていない」と誤って知らせない）", async () => {
    const { db } = strict;
    await repo.initChain(db);
    await repo.createEntry(db, "2026-01-05", lines);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let midWrite = false;
    // 履歴を書いたが、連鎖にはまだ積んでいない状態で止まる書き込み（最後は取り消す）
    const writing = repo.tx(db, "テスト", async () => {
      await db.execute("INSERT INTO integrity_events (kind, detail) VALUES ('test', '途中')");
      midWrite = true;
      await gate;
      midWrite = false;
      throw new Error("取り消し");
    }).catch(() => undefined);
    await Bun.sleep(0);
    expect(midWrite).toBe(true);
    const checking = repo.verifyIntegrity(db);
    await Bun.sleep(0);
    release();
    await writing;
    const report = await checking;
    expect(report.issues).toEqual([]);
  });
});

describe("トランザクションと中断の検知（repo）", () => {
  test("途中で失敗したら丸ごと取り消され、保存中の目印も残らない", async () => {
    const { db, raw } = strict;
    const bad = [...lines, { ...lines[0], row_no: 2, account_id: 99999 }]; // 存在しない科目（外部キーで失敗）
    raw.run("PRAGMA foreign_keys = ON");
    await expect(repo.createEntry(db, "2026-01-10", bad)).rejects.toThrow();
    expect(raw.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 0 });
    expect(raw.query("SELECT COUNT(*) AS n FROM journal_lines").get()).toEqual({ n: 0 });
    expect(raw.query("SELECT COUNT(*) AS n FROM pending_ops").get()).toEqual({ n: 0 });
  });

  test("保存中にソフトが止まった（目印が残った）ら、次に開いたときに知らせて記録する", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    raw.run("INSERT INTO pending_ops (label, started_at) VALUES ('伝票 No.12 の訂正', '2026-10-05 10:00:00')");
    const msgs = await repo.checkInterrupted(db);
    expect(msgs).toEqual(["2026-10-05 10:00:00　伝票 No.12 の訂正"]);
    expect(await repo.checkInterrupted(db)).toEqual([]); // 2回目は出ない
    const r = await repo.verifyIntegrity(db);
    expect(r.issues.map((i) => i.message).join()).toMatch(/保存が完了せず、取り消されました.*伝票 No.12/);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("書き込みは順番に1つずつ行われる（同時に呼んでも混ざらない）", async () => {
    const { db } = strict;
    const ids = await Promise.all([1, 2, 3, 4, 5].map((d) => repo.createEntry(db, `2026-01-0${d}`, lines)));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.getHistory(db)).length).toBe(5);
  });
});

describe("ユーザー（repo）", () => {
  test("最初のユーザーは自動で作る。パスワードは任意で、ハッシュで保存する", async () => {
    const { db, raw } = strict;
    await repo.ensureUsers(db, "山田");
    await repo.ensureUsers(db, "山田"); // 2回目は何もしない
    const [yamada] = await repo.getUsers(db);
    expect(yamada).toMatchObject({ name: "山田", has_password: 0, is_active: 1 });
    expect(await repo.checkLogin(db, yamada.id, "")).toBe(true);

    const suzuki = await repo.createUser(db, "鈴木", "secret1");
    const stored = (raw.query("SELECT password_hash FROM users WHERE id = ?").get(suzuki) as { password_hash: string }).password_hash;
    expect(stored).toMatch(/^pbkdf2-sha256\$/);
    expect(stored).not.toContain("secret1");
    expect(await repo.checkLogin(db, suzuki, "secret1")).toBe(true);
    expect(await repo.checkLogin(db, suzuki, "wrong")).toBe(false);
    await expect(repo.createUser(db, "鈴木")).rejects.toThrow(/同じ名前/);
  });

  test("パスワードを変えるには今のパスワードが要る", async () => {
    const { db } = strict;
    const id = await repo.createUser(db, "鈴木", "secret1");
    await expect(repo.setUserPassword(db, id, "wrong", "newpass")).rejects.toThrow(/今のパスワード/);
    await repo.setUserPassword(db, id, "secret1", "newpass");
    expect(await repo.checkLogin(db, id, "newpass")).toBe(true);
    await repo.setUserPassword(db, id, "newpass", ""); // 解除
    expect(await repo.checkLogin(db, id, "")).toBe(true);
  });

  test("誰が操作したかが、履歴・仕訳・証憑・利用の記録に残る", async () => {
    const { db } = strict;
    await repo.initChain(db);
    const a = await repo.createUser(db, "山田");
    const b = await repo.createUser(db, "鈴木");
    repo.setActor(a, "editor");
    await repo.logAccess(db, a, "login");
    const entry = await repo.createEntry(db, "2026-01-10", lines);
    repo.setActor(b, "editor");
    await repo.updateEntry(db, entry, "2026-01-11", lines, "訂正");
    const ev = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const e = (await repo.getEntry(db, entry))!;
    expect([e.created_by_name, e.updated_by_name]).toEqual(["山田", "鈴木"]);
    expect((await repo.getHistory(db, entry)).map((h) => h.user_name)).toEqual(["鈴木", "山田"]);
    expect((await repo.getEvidenceHistory(db, ev))[0].user_name).toBe("鈴木");
    expect((await repo.getAccessLog(db)).map((x) => [x.user_name, x.action])).toEqual([["山田", "login"]]);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]); // 利用の記録も連鎖に入っている
    repo.setActor(null);
  });

  test("使えるユーザーを0人にはできない", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const [u] = await repo.getUsers(db);
    await expect(repo.setUserActive(db, u.id, false)).rejects.toThrow(/1人もいなく/);
  });
});

describe("帳簿入力のタブ（repo）", () => {
  test("まだ決めていなければ null。保存すると並び順どおりに返す（重複は1つに）", async () => {
    const { db } = makeDb("standard");
    expect(await repo.getCashbookAccounts(db)).toBeNull();
    const accts = await repo.getAccounts(db, 2026);
    const id = (code: string) => accts.find((a) => a.code === code)!.id;
    await repo.setCashbookAccounts(db, [id("103"), id("101"), id("103")]);
    expect(await repo.getCashbookAccounts(db)).toEqual([id("103"), id("101")]);
  });

  test("空・損益の科目は保存できない", async () => {
    const { db } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    await expect(repo.setCashbookAccounts(db, [])).rejects.toThrow(/1つ以上/);
    await expect(repo.setCashbookAccounts(db, [accts.find((a) => a.code === "401")!.id])).rejects.toThrow(/資産・負債・資本/);
  });
});

describe("読み取り専用（repo）", () => {
  test("書き込みはすべて止め、年度の切り替えだけ通す", async () => {
    const { db } = strict;
    repo.setReadOnly(true);
    try {
      await expect(repo.createEntry(db, "2026-01-05", lines)).rejects.toThrow(/読み取り専用/);
      await expect(repo.setInputPeriodDays(db, 30)).rejects.toThrow(/読み取り専用/);
      await expect(repo.logAccess(db, 1, "login")).rejects.toThrow(/読み取り専用/);
      await repo.setFiscalYear(db, 2025);
      expect((await repo.getSettings(db)).fiscal_year).toBe(2025);
      expect(await repo.getLines(db, "2026-01-01", "2026-12-31")).toEqual([]);
    } finally {
      repo.setReadOnly(false);
    }
    await repo.createEntry(db, "2026-01-05", lines);
  });
});

describe("決算整理仕訳（repo）", () => {
  test("年度末の日付だけで登録でき、履歴の写しにも残る。訂正で印を省けばそのまま", async () => {
    const { db } = strict;
    await expect(repo.createEntry(db, "2026-12-30", lines, null, "", true)).rejects.toThrow(/年度末/);
    const id = await repo.createEntry(db, "2026-12-31", lines, null, "", true);
    expect((await repo.getEntry(db, id))!.is_adjustment).toBe(1);
    expect((await repo.getLines(db, "2026-01-01", "2026-12-31"))[0].is_adjustment).toBe(1);
    await repo.updateEntry(db, id, "2026-12-31", lines, "金額の訂正");
    expect((await repo.getEntry(db, id))!.is_adjustment).toBe(1);
    await expect(repo.updateEntry(db, id, "2026-12-01", lines, "x")).rejects.toThrow(/年度末/);
    await repo.updateEntry(db, id, "2026-12-01", lines, "通常の仕訳に戻す", undefined, false);
    expect((await repo.getEntry(db, id))!.is_adjustment).toBe(0);
    expect((await repo.getHistory(db, id)).map((h) => !!h.snapshot.adjustment)).toEqual([false, true, true]);
  });

  test("改ざんの確認：決算整理の印も照合し、印の無い仕訳のハッシュは今までどおり", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const normal = await repo.createEntry(db, "2026-06-01", lines);
    const adj = await repo.createEntry(db, "2026-12-31", lines, null, "", true);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    raw.run("UPDATE journal_entries SET is_adjustment = 0 WHERE id = ?", [adj]);
    const issues = (await repo.verifyIntegrity(db)).issues.map((i) => i.message).join("\n");
    expect(issues).toMatch(new RegExp(`伝票 No.${adj}`));
    expect(issues).not.toMatch(new RegExp(`伝票 No.${normal}）`));
  });
});

describe("定型仕訳（repo）", () => {
  test("登録・置き換え・名前変更・削除。名前の重複と科目なしは不可", async () => {
    const { db } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const row = { debitAccountId: id("地代家賃"), debitSubId: null, debitAmount: 80000, creditAccountId: id("普通預金"), creditSubId: null, creditAmount: 80000, memo: "家賃" };
    const t = await repo.createTemplate(db, "家賃", [row], null);
    await expect(repo.createTemplate(db, "家賃", [row], null)).rejects.toThrow(/同じ名前/);
    await expect(repo.createTemplate(db, "空", [{ ...row, debitAccountId: null, creditAccountId: null, debitAmount: null, creditAmount: null, memo: "" }], null)).rejects.toThrow(/科目/);
    await repo.overwriteTemplate(db, t, [{ ...row, debitAmount: null, creditAmount: null }], null);
    await repo.renameTemplate(db, t, "事務所の家賃");
    expect(await repo.getTemplates(db)).toEqual([
      { id: t, name: "事務所の家賃", rows: [{ ...row, debitAmount: null, creditAmount: null }], counterparty_id: null },
    ]);
    await repo.deleteTemplate(db, t);
    expect(await repo.getTemplates(db)).toEqual([]);
  });
});

describe("科目を消すときの定型仕訳（repo）", () => {
  test("使っている定型仕訳がわかり、消すとその部分だけ外れる。科目が残らない定型仕訳は消える", async () => {
    const { db } = makeDb("standard");
    const code = repo.nextAccountCode(await repo.getAccounts(db, 2026), "expense")!;
    await repo.createAccount(db, { code, name: "研究費", kana: "", category: "expense" });
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const blank = { debitAccountId: null, debitSubId: null, debitAmount: null, creditAccountId: null, creditSubId: null, creditAmount: null, memo: "" };
    await repo.createTemplate(db, "研究費と現金", [{ ...blank, debitAccountId: id("研究費"), creditAccountId: id("現金") }], null);
    await repo.createTemplate(db, "研究費だけ", [{ ...blank, debitAccountId: id("研究費") }], null);
    await repo.createTemplate(db, "家賃", [{ ...blank, debitAccountId: id("地代家賃"), creditAccountId: id("現金") }], null);
    expect(await repo.templatesUsing(db, { accountId: id("研究費") })).toEqual(["研究費だけ", "研究費と現金"]);
    const r = await repo.deleteAccount(db, id("研究費"));
    expect(r).toEqual({ changed: ["研究費と現金"], deleted: ["研究費だけ"] });
    const left = await repo.getTemplates(db);
    expect(left.map((t) => t.name)).toEqual(["家賃", "研究費と現金"]);
    expect(left.find((t) => t.name === "研究費と現金")!.rows).toEqual([{ ...blank, creditAccountId: id("現金") }]);
  });

  test("補助科目を消すと、定型仕訳の補助科目だけ外れる", async () => {
    const { db } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    const bank = accts.find((a) => a.code === "103")!.id;
    await repo.createSub(db, bank, "A銀行");
    const sub = (await repo.getSubAccounts(db, 2026)).find((s) => s.name === "A銀行")!.id;
    const blank = { debitAccountId: null, debitSubId: null, debitAmount: null, creditAccountId: null, creditSubId: null, creditAmount: null, memo: "" };
    await repo.createTemplate(db, "振込", [{ ...blank, debitAccountId: accts[0].id, creditAccountId: bank, creditSubId: sub }], null);
    expect(await repo.deleteSub(db, sub)).toEqual({ changed: ["振込"], deleted: [] });
    expect((await repo.getTemplates(db))[0].rows[0].creditSubId).toBeNull();
  });
});

describe("権限（repo）", () => {
  test("入力担当は仕訳を入れられるが、設定・科目・ユーザーは変えられない。閲覧のみは何もできない", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const editor = await repo.createUser(db, "鈴木", "", "editor");
    const viewer = await repo.createUser(db, "佐藤", "", "viewer");
    repo.setActor(editor, "editor");
    await repo.createEntry(db, "2026-01-05", lines);
    await repo.createCounterparty(db, { name: "株式会社A", kana: "", invoice_no: "", memo: "" });
    await expect(repo.setInputPeriodDays(db, 30)).rejects.toThrow(/入力担当/);
    await expect(repo.saveOpening(db, 2026, { "1:0": 100 })).rejects.toThrow(/入力担当/);
    await expect(repo.createUser(db, "田中")).rejects.toThrow(/入力担当/);
    await expect(repo.closeYear(db, 2025)).rejects.toThrow(/入力担当/);
    repo.setActor(viewer, "viewer");
    await expect(repo.createEntry(db, "2026-01-06", lines)).rejects.toThrow(/閲覧のみ/);
    await repo.setFiscalYear(db, 2026); // 見るための年度の切り替えはできる
    await repo.logAccess(db, viewer, "login"); // 利用の記録は誰でも残る
  });

  test("自分のパスワードは誰でも変えられるが、ほかの人のは管理者だけ", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const [admin] = await repo.getUsers(db);
    const editor = await repo.createUser(db, "鈴木", "secret1", "editor");
    repo.setActor(editor, "editor");
    await repo.setUserPassword(db, editor, "secret1", "newpass");
    await expect(repo.setUserPassword(db, admin.id, "", "x12345")).rejects.toThrow(/入力担当/);
    repo.setActor(admin.id, "admin");
    await repo.setUserPassword(db, admin.id, "", "adminpw");
    // 管理者でも、自分のパスワードは今のパスワードが要る
    await expect(repo.setUserPassword(db, admin.id, "wrong", "other1")).rejects.toThrow(/今のパスワード/);
  });

  test("管理者は、ほかの人の忘れたパスワードを今のパスワードなしで上書き・解除できる。履歴に残る", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const [admin] = await repo.getUsers(db);
    const editor = await repo.createUser(db, "鈴木", "forgotten", "editor");
    repo.setActor(admin.id, "admin");
    await repo.setUserPassword(db, editor, "", "newpass1");
    expect(await repo.checkLogin(db, editor, "newpass1")).toBe(true);
    expect(await repo.checkLogin(db, editor, "forgotten")).toBe(false);
    await repo.setUserPassword(db, editor, "", ""); // 解除もできる
    expect(await repo.checkLogin(db, editor, "")).toBe(true);
    const h = (await repo.getMasterHistory(db)).filter((x) => x.label === "鈴木" && x.action === "change");
    expect(h[0].new_value).toMatch(/管理者「山田」が再設定/);
  });

  test("管理者は0人にできない。権限の変更は履歴に残る", async () => {
    const { db } = strict;
    await repo.ensureUsers(db, "山田");
    const [admin] = await repo.getUsers(db);
    expect(admin.role).toBe("admin"); // 最初のユーザーは管理者
    const other = await repo.createUser(db, "鈴木");
    expect((await repo.getUsers(db)).find((u) => u.id === other)!.role).toBe("editor"); // 追加したユーザーの既定は入力担当
    repo.setActor(admin.id, "admin");
    await expect(repo.setUserRole(db, admin.id, "editor")).rejects.toThrow(/管理者が1人も/);
    await expect(repo.setUserActive(db, admin.id, false)).rejects.toThrow(/管理者が1人も/);
    await repo.setUserRole(db, other, "admin");
    await repo.setUserRole(db, admin.id, "viewer"); // ほかに管理者がいれば変えられる
    // 自分を閲覧のみにしたので、以後は変更できない
    await expect(repo.setUserRole(db, other, "editor")).rejects.toThrow(/閲覧のみ/);
    const h = (await repo.getMasterHistory(db)).filter((x) => x.old_value.startsWith("権限"));
    expect(h.map((x) => [x.label, x.old_value, x.new_value])).toEqual([
      ["山田", "権限 管理者", "権限 閲覧のみ"],
      ["鈴木", "権限 入力担当", "権限 管理者"],
    ]);
  });
});

describe("事業者の情報（repo）", () => {
  test("郵便番号はそろえて保存し、形がおかしければ保存しない（登録番号は消費税の設定で別に保存する）", async () => {
    const { db } = makeDb("standard");
    const s = await repo.getSettings(db);
    expect([s.postal_code, s.address, s.invoice_no]).toEqual(["", "", ""]);
    await repo.saveSettings(db, { ...s, postal_code: "１２３４５６７", address: " 東京都千代田区 ", invoice_no: "T1234567890123" });
    const after = await repo.getSettings(db);
    expect([after.postal_code, after.address, after.invoice_no]).toEqual(["123-4567", "東京都千代田区", ""]);
    await expect(repo.saveSettings(db, { ...after, postal_code: "123" })).rejects.toThrow(/郵便番号/);
  });
});

describe("証憑の受領日（repo）", () => {
  test("受領日を保存し、履歴の写しに残る。未来の日付は不可。受領日の無い証憑のハッシュは今までどおり", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const plain = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const id = await repo.createEvidence(db, { ...meta, received_date: "2026-02-03" }, { name: "b.pdf", bytes: pdf("b") });
    expect((await repo.getEvidence(db, id))!.received_date).toBe("2026-02-03");
    expect((await repo.getEvidence(db, plain))!.received_date).toBe("");
    expect((await repo.getEvidenceHistory(db, id))[0].snapshot.received_date).toBe("2026-02-03");
    expect((await repo.getEvidenceHistory(db, plain))[0].snapshot).not.toHaveProperty("received_date");
    await expect(repo.createEvidence(db, { ...meta, received_date: "2999-01-01" }, { name: "c.pdf", bytes: pdf("c") })).rejects.toThrow(/今日より後/);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    // 受領日だけを直接書き換えると見つかる
    raw.run("UPDATE evidences SET received_date = '2026-01-01' WHERE id = ?", [id]);
    expect((await repo.verifyIntegrity(db)).issues.map((i) => i.message).join("\n")).toMatch(new RegExp(`証憑 No.${id}`));
  });
});

describe("ユーザーの備考（repo）", () => {
  test("追加・変更でき、変更は履歴に残る", async () => {
    const { db } = strict;
    const id = await repo.createUser(db, "鈴木", "", "editor", " 経理担当 ");
    expect((await repo.getUsers(db)).find((u) => u.id === id)!.memo).toBe("経理担当");
    await repo.setUserMemo(db, id, "経理担当（月末）");
    expect((await repo.getUsers(db)).find((u) => u.id === id)!.memo).toBe("経理担当（月末）");
    await expect(repo.setUserMemo(db, id, "あ".repeat(201))).rejects.toThrow(/200文字/);
    const h = (await repo.getMasterHistory(db)).find((x) => x.old_value.startsWith("備考"));
    expect([h?.old_value, h?.new_value]).toEqual(["備考：経理担当", "備考：経理担当（月末）"]);
  });
});

describe("スキャナ保存（repo）", () => {
  /** 200dpi・カラーの JPEG の頭（中身の画像は無くてよい） */
  const scanJpeg = (comps = 3, dpi = 200, h = 2339, w = 1654) => new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0,
    0xff, 0xc0, 0x00, 8 + 3 * comps, 8, h >> 8, h & 255, w >> 8, w & 255, comps, ...Array(3 * comps).fill(1), 0xff, 0xd9, Date.now() & 255,
  ]);
  const scanMeta = { ...meta, doc_type: "領収書", received_date: "2026-10-20" };

  test("厳密モードだけ。受領日が要る。画質を中身で確かめる", async () => {
    const std = makeDb("standard");
    await expect(repo.createEvidence(std.db, scanMeta, { name: "a.jpg", bytes: scanJpeg() }, "scan")).rejects.toThrow(/厳密モード/);
    const { db } = strict;
    await expect(repo.createEvidence(db, { ...scanMeta, received_date: "" }, { name: "a.jpg", bytes: scanJpeg() }, "scan")).rejects.toThrow(/受領日/);
    await expect(repo.createEvidence(db, scanMeta, { name: "low.jpg", bytes: scanJpeg(3, 96, 1100, 800) }, "scan")).rejects.toThrow(/96dpi/);
    await expect(repo.createEvidence(db, scanMeta, { name: "gray.jpg", bytes: scanJpeg(1) }, "scan")).rejects.toThrow(/カラー/);
    // PDF は自己申告が要る
    await expect(repo.createEvidence(db, scanMeta, { name: "a.pdf", bytes: pdf("s") }, "scan")).rejects.toThrow(/自動で確かめられません/);
    const p = await repo.createEvidence(db, scanMeta, { name: "a.pdf", bytes: pdf("s") }, "scan", true);
    expect(JSON.parse((await repo.getEvidence(db, p))!.scan_info).method).toBe("declared");
    const id = await repo.createEvidence(db, scanMeta, { name: "ok.jpg", bytes: scanJpeg() }, "scan");
    const ev = (await repo.getEvidence(db, id))!;
    expect([ev.kind, ev.doc_class]).toEqual(["scan", "important"]);
    expect(JSON.parse(ev.scan_info)).toMatchObject({ method: "auto", info: { dpi: 200, color: "color" } });
    expect(ev.registered_at).toBe((await repo.getEvidenceHistory(db, id))[0].recorded_at);
  });

  test("一般書類はグレースケールでもよいが、重要書類には変えられない。読み取りの記録は書き換えられない", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const id = await repo.createEvidence(db, { ...scanMeta, doc_type: "見積書" }, { name: "g.jpg", bytes: scanJpeg(1) }, "scan");
    expect((await repo.getEvidence(db, id))!.doc_class).toBe("general");
    await expect(repo.updateEvidence(db, id, { ...scanMeta, doc_type: "見積書", doc_class: "important" }, "区分の訂正")).rejects.toThrow(/重要書類にできません/);
    expect(() => raw.run("UPDATE evidences SET scan_info = '{}' WHERE id = ?", [id])).toThrow(/変更できません/);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
  });

  test("入力期間の方式は事業者ごとに決め、変更は履歴に残る", async () => {
    const { db } = strict;
    expect(await repo.getScanInputMethod(db)).toBe("early");
    await repo.setScanInputMethod(db, "cycle");
    expect(await repo.getScanInputMethod(db)).toBe("cycle");
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "スキャナ保存の入力期間", old_value: "早期入力方式", new_value: "業務処理サイクル方式・2か月" });
    // サイクルを1か月に
    await repo.setScanInputMethod(db, "cycle1");
    expect(await repo.getScanInputMethod(db)).toBe("cycle1");
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ old_value: "業務処理サイクル方式・2か月", new_value: "業務処理サイクル方式・1か月" });
    await expect(repo.setScanInputMethod(db, "monthly" as never)).rejects.toThrow(/正しくありません/);
  });
});

describe("祝日・休業日（repo）", () => {
  test("内蔵の祝日に、取得した祝日と休業日を足す。変更は履歴に残る", async () => {
    const { db } = strict;
    const before = await repo.getHolidayData(db);
    expect(before.lastYear).toBeGreaterThanOrEqual(2027);
    expect(before.fetchedAt).toBe("");
    expect((await repo.getDaysOff(db)).has("2026-11-03")).toBe(true);

    await expect(repo.saveFetchedHolidays(db, [])).rejects.toThrow(/読み取れません/);
    await repo.saveFetchedHolidays(db, [{ date: "2028-01-01", name: "元日" }, { date: "2028-01-10", name: "成人の日" }]);
    const after = await repo.getHolidayData(db);
    expect(after.lastYear).toBe(2028);
    expect(after.fetchedAt).not.toBe("");

    await repo.addCustomHoliday(db, "2026-12-29", "年末年始休業");
    await repo.addCustomHoliday(db, "2026-12-29", "年末休業"); // 同じ日は名前を変える
    await expect(repo.addCustomHoliday(db, "2026-13-01", "x")).rejects.toThrow(/日付/);
    expect((await repo.getHolidayData(db)).custom).toEqual([{ date: "2026-12-29", name: "年末休業" }]);
    expect((await repo.getDaysOff(db)).has("2026-12-29")).toBe(true);
    await repo.deleteCustomHoliday(db, "2026-12-29");
    expect((await repo.getDaysOff(db)).has("2026-12-29")).toBe(false);
    expect((await repo.getMasterHistory(db)).map((h) => h.label)).toContain("祝日（内閣府から取得）");
  });
});

describe("消費税（repo）", () => {
  const ids = async (db: Database) => {
    const accts = await repo.getAccounts(db, 2026);
    return (n: string) => accts.find((a) => a.name === n)!.id;
  };
  const twenty = { from_year: 2026, status: "twenty" as const, method: "inclusive" as const, business_class: 5, taxable_from: "" };

  test("免税事業者の期間は税区分を持たない。課税事業者にすると科目・取引先の初期値で埋まる", async () => {
    const { db } = strict;
    const id = await ids(db);
    const free = await repo.createEntry(db, "2026-02-01", lines);
    expect((await repo.getEntry(db, free))!.lines.map((l) => l.tax_code)).toEqual([null, null]);

    await repo.saveTaxYear(db, { ...twenty, taxable_from: "2026-04-01" });
    // 課税事業者になった日より前は、そのまま税区分なし
    expect((await repo.getEntry(db, await repo.createEntry(db, "2026-03-31", lines)))!.lines[0].tax_code).toBeNull();
    const cp = await repo.createCounterparty(db, { name: "個人の外注先", kana: "", invoice_no: "", not_registered: true, memo: "" });
    const e = await repo.createEntry(db, "2026-04-01", lines, cp);
    expect((await repo.getEntry(db, e))!.lines.map((l) => [l.tax_code, l.invoice_kind])).toEqual([["purchase10", "transitional"], ["none", null]]);
    // 入れた税区分はそのまま。課税仕入でなければインボイス区分は外す
    const sales: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: id("普通預金"), sub_account_id: null, amount: 1080, memo: "" },
      { row_no: 1, side: "credit", account_id: id("売上高"), sub_account_id: null, amount: 1080, memo: "", tax_code: "sales8", invoice_kind: "qualified" },
    ];
    const s = await repo.createEntry(db, "2026-05-01", sales);
    expect((await repo.getEntry(db, s))!.lines.map((l) => [l.tax_code, l.invoice_kind])).toEqual([["none", null], ["sales8", null]]);
    // 履歴の写し・明細の読み込みにも出る
    expect((await repo.getHistory(db, s))[0].snapshot.lines.find((l) => l.side === "credit")).toMatchObject({ tax: "sales8" });
    expect((await repo.getLines(db, "2026-05-01", "2026-05-01")).map((l) => l.tax_code)).toEqual(["none", "sales8"]);
  });

  test("設定は年度ごと。翌年に引き継ぎ、変更は履歴に残る。2割特例は令和8年分まで。年の締めをした年度は変えられない", async () => {
    const { db } = strict;
    await repo.saveTaxYear(db, twenty);
    expect((await repo.getTaxYears(db)).map((t) => t.status)).toEqual(["twenty"]);
    await expect(repo.saveTaxYear(db, { ...twenty, from_year: 2027 })).rejects.toThrow(/令和8年/);
    await repo.saveTaxYear(db, { ...twenty, from_year: 2027, status: "thirty" });
    const h = (await repo.getMasterHistory(db)).filter((x) => x.target_type === "setting");
    expect(h.map((x) => [x.label, x.old_value, x.new_value])).toEqual([
      ["2027年の消費税", "課税事業者（2割特例）・税込経理（前の年から引き継ぎ）", "課税事業者（3割特例）・税込経理"],
      ["2026年の消費税", "免税事業者", "課税事業者（2割特例）・税込経理"],
    ]);
    await repo.closeYear(db, 2026);
    await expect(repo.saveTaxYear(db, { ...twenty, status: "standard" })).rejects.toThrow(/締め済み/);
  });

  test("税区分の無い仕訳を一括で埋める（訂正の履歴が残る）。締めた月の仕訳は飛ばす", async () => {
    const { db } = strict;
    const a = await repo.createEntry(db, "2026-01-10", lines);
    const b = await repo.createEntry(db, "2026-06-10", lines);
    await repo.saveTaxYear(db, twenty);
    expect((await repo.untaxedEntryIds(db, 2026)).map((x) => x.id)).toEqual([a, b]);
    await repo.closeThrough(db, 2026, 3);
    expect(await repo.fillTaxCodes(db, 2026)).toEqual({ updated: 1, closed: 1 });
    expect((await repo.getEntry(db, b))!.lines[0]).toMatchObject({ tax_code: "purchase10", invoice_kind: "qualified" });
    expect((await repo.getEntry(db, a))!.lines[0].tax_code).toBeNull();
    expect((await repo.getHistory(db, b))[0]).toMatchObject({ action: "update", reason: repo.FILL_TAX_REASON });
  });

  test("改ざんの確認：税区分も照合し、税区分の無い仕訳のハッシュは今までどおり", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const plain = await repo.createEntry(db, "2026-02-01", lines);
    await repo.saveTaxYear(db, twenty);
    const taxed = await repo.createEntry(db, "2026-03-01", lines);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    raw.run("UPDATE journal_lines SET invoice_kind = 'none' WHERE entry_id = ? AND side = 'debit'", [taxed]);
    const issues = (await repo.verifyIntegrity(db)).issues.map((i) => i.message).join("\n");
    expect(issues).toMatch(new RegExp(`伝票 No.${taxed}`));
    expect(issues).not.toMatch(new RegExp(`伝票 No.${plain}）`));
  });

  test("科目の税区分の初期値・取引先・登録番号の変更", async () => {
    const { db } = strict;
    const id = await ids(db);
    await repo.setAccountTaxCode(db, id("地代家賃"), "purchase_nontax");
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === id("地代家賃"))!.default_tax_code).toBe("purchase_nontax");
    await repo.setAccountTaxCode(db, id("地代家賃"), "purchase10"); // 決まった初期値に戻すと null
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === id("地代家賃"))!.default_tax_code).toBeNull();
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ old_value: "税区分の初期値 非課税仕入", new_value: "税区分の初期値 課税仕入 10%" });

    // 登録番号のある取引先は「適格請求書発行事業者ではない」にならない
    const cp = await repo.createCounterparty(db, { name: "B", kana: "", invoice_no: "T1234567890123", not_registered: true, memo: "" });
    expect((await repo.getCounterparties(db)).find((c) => c.id === cp)!.not_registered).toBe(0);

    await expect(repo.saveInvoiceRegistration(db, "T123", "")).rejects.toThrow(/13桁/);
    await expect(repo.saveInvoiceRegistration(db, "", "2026-01-01")).rejects.toThrow(/登録番号も/);
    await repo.saveInvoiceRegistration(db, "t1234-5678-90123", "2023-10-01");
    expect(await repo.getSettings(db)).toMatchObject({ invoice_no: "T1234567890123", invoice_registered_on: "2023-10-01" });
  });

  test("家事按分（入力のたびに）で分けた家事分の行は対象外", async () => {
    const { db } = strict;
    const id = await ids(db);
    await repo.saveTaxYear(db, twenty);
    const e = await repo.createEntry(db, "2026-04-01", [
      { row_no: 1, side: "debit", account_id: id("水道光熱費"), sub_account_id: null, amount: 6000, memo: "電気" },
      { row_no: 2, side: "debit", account_id: id("事業主貸"), sub_account_id: null, amount: 4000, memo: "電気（家事分）" },
      { row_no: 1, side: "credit", account_id: id("普通預金"), sub_account_id: null, amount: 10000, memo: "電気" },
    ]);
    expect((await repo.getEntry(db, e))!.lines.map((l) => l.tax_code)).toEqual(["purchase10", "none", "none"]);
  });
});

describe("消費税の中間納付税額（repo）", () => {
  test("年度ごとに保存し、0 にすると消える。変更は履歴に残り、年の締めをした年度は変えられない", async () => {
    const { db } = strict;
    expect(await repo.getTaxInterim(db, 2026)).toEqual({ national: 0, local: 0 });
    await repo.saveTaxInterim(db, 2026, 120_000, 33_800);
    expect(await repo.getTaxInterim(db, 2026)).toEqual({ national: 120_000, local: 33_800 });
    await expect(repo.saveTaxInterim(db, 2026, -1, 0)).rejects.toThrow(/0 以上/);
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "2026年の消費税の中間納付税額", new_value: "消費税 120,000 円・地方消費税 33,800 円" });
    await repo.saveTaxInterim(db, 2026, 0, 0);
    expect(await repo.getTaxInterim(db, 2026)).toEqual({ national: 0, local: 0 });
    await repo.closeYear(db, 2026);
    await expect(repo.saveTaxInterim(db, 2026, 1, 1)).rejects.toThrow(/締め済み/);
  });
});

describe("基準期間の課税売上高の手入力（repo）", () => {
  test("保存すると優先して使い、null で外す。変更は履歴に残る", async () => {
    const { db } = strict;
    expect(await repo.getTaxBaseManual(db, 2026)).toBeNull();
    await repo.saveTaxBaseManual(db, 2026, 8_321_760);
    expect(await repo.getTaxBaseManual(db, 2026)).toBe(8_321_760);
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "2026年の基準期間（2024年）の課税売上高", old_value: "帳簿から計算", new_value: "8,321,760 円（手で入力）" });
    await expect(repo.saveTaxBaseManual(db, 2026, 1.5)).rejects.toThrow(/整数/);
    await repo.saveTaxBaseManual(db, 2026, null);
    expect(await repo.getTaxBaseManual(db, 2026)).toBeNull();
  });
});

describe("中間申告（repo）", () => {
  test("前年の確定消費税額の手入力：保存すると優先して使い、null で外す。変更は履歴に残り、締めた年は変えられない", async () => {
    const { db } = strict;
    expect(await repo.getTaxPrevManual(db, 2026)).toBeNull();
    await repo.saveTaxPrevManual(db, 2026, 1_200_000);
    expect(await repo.getTaxPrevManual(db, 2026)).toBe(1_200_000);
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({
      label: "2026年の中間申告の判定に使う前年（2025年）の確定消費税額", old_value: "帳簿から計算", new_value: "1,200,000 円（手で入力）",
    });
    await expect(repo.saveTaxPrevManual(db, 2026, -1)).rejects.toThrow(/整数/);
    await repo.saveTaxPrevManual(db, 2026, null);
    expect(await repo.getTaxPrevManual(db, 2026)).toBeNull();
    await repo.closeYear(db, 2026);
    await expect(repo.saveTaxPrevManual(db, 2026, 1)).rejects.toThrow(/締め済み/);
  });

  test("任意の中間申告の届出：年度の設定に持ち、次の年に引き継ぐ。免税事業者にすると外れる", async () => {
    const { db } = strict;
    const t = { from_year: 2026, status: "standard" as const, method: "inclusive" as const, business_class: 5, taxable_from: "", deduction: "individual" as const };
    await repo.saveTaxYear(db, { ...t, voluntary_interim: 1 });
    expect(taxYearOf(await repo.getTaxYears(db), 2027).voluntary_interim).toBe(1);
    expect((await repo.getMasterHistory(db))[0].new_value).toMatch(/任意の中間申告の届出あり/);
    await repo.saveTaxYear(db, { ...t, from_year: 2027, status: "exempt", voluntary_interim: 1 });
    expect(taxYearOf(await repo.getTaxYears(db), 2027).voluntary_interim).toBe(0);
  });
});

describe("銀行・カードの明細（repo）", () => {
  const sl = (date: string, side: "debit" | "credit", amount: number, description: string, n = 1) => ({
    row: 0, date, description, side, amount, balance: null, fingerprint: `${date}|${side}|${amount}|${description}|${n}`,
  });

  test("同じ明細は2回入れない。仕訳にすると履歴に「明細の取り込み」と残り、仕訳を消すと未登録に戻る", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const bank = id("普通預金");
    const first = [sl("2026-10-01", "debit", 330_000, "ﾌﾘｺﾐ"), sl("2026-10-05", "credit", 5_500, "デンキ")];
    expect(await repo.addBankLines(db, bank, null, first, "a.csv")).toEqual({ added: 2, known: 0 });
    expect(await repo.addBankLines(db, bank, null, [...first, sl("2026-10-06", "credit", 1_100, "ｽｲﾄﾞｳ")], "b.csv")).toEqual({ added: 1, known: 2 });
    expect((await repo.getPendingBankCounts(db)).get(`${bank}|0`)).toBe(3);

    const rows = await repo.getBankLines(db, bank, null);
    const electric = rows.find((r) => r.description === "デンキ")!;
    const entryLines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: id("水道光熱費"), sub_account_id: null, amount: 5_500, memo: "電気代" },
      { row_no: 1, side: "credit", account_id: bank, sub_account_id: null, amount: 5_500, memo: "電気代" },
    ];
    const [entryId] = await repo.registerBankLines(db, [{ lineId: electric.id, date: electric.date, lines: entryLines, counterpartyId: null }], "a.csv");
    expect((await repo.getBankLines(db, bank, null)).find((r) => r.id === electric.id)).toMatchObject({ status: "done", entry_id: entryId });
    expect((await repo.getHistory(db, entryId))[0].reason).toBe("明細の取り込み（a.csv）");
    expect(await repo.getBankHistory(db, bank, null)).toEqual([{ entryId, description: "デンキ" }]);
    await expect(repo.registerBankLines(db, [{ lineId: electric.id, date: electric.date, lines: entryLines, counterpartyId: null }], "a.csv")).rejects.toThrow(/もう仕訳/);

    await repo.deleteEntry(db, entryId, "取り消し");
    expect((await repo.getBankLines(db, bank, null)).find((r) => r.id === electric.id)).toMatchObject({ status: "pending", entry_id: null });

    const water = rows.find((r) => r.description === "ｽｲﾄﾞｳ")!;
    await repo.setBankLinesStatus(db, [water.id], "skipped");
    expect((await repo.getBankLines(db, bank, null)).find((r) => r.id === water.id)!.status).toBe("skipped");
    expect((await repo.getPendingBankCounts(db)).get(`${bank}|0`)).toBe(2);
  });

  test("列の対応は口座ごと。ルールは確かめてから保存する", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const map = { headerRow: 0, date: 0, description: [1], mode: "signed" as const, increase: null, decrease: null, amount: 2, invert: false, balance: null };
    await repo.saveBankFormat(db, id("未払金"), null, map);
    expect(await repo.getBankFormat(db, id("未払金"), null)).toEqual(map);
    expect(await repo.getBankFormat(db, id("普通預金"), null)).toBeNull();
    await expect(repo.saveBankFormat(db, id("未払金"), null, { ...map, amount: null })).rejects.toThrow(/金額の列/);

    const rule = { id: 0, keyword: " デンキ ", direction: "decrease" as const, target_account_id: null, account_id: id("水道光熱費"), sub_account_id: null, tax_code: "purchase10" as const, invoice_kind: "qualified" as const, counterparty_id: null, memo: "電気代" };
    const ruleId = await repo.saveBankRule(db, rule);
    expect(await repo.getBankRules(db)).toMatchObject([{ id: ruleId, keyword: "デンキ", sort_order: 1 }]);
    await repo.saveBankRule(db, { ...rule, id: ruleId, memo: "電気料金" });
    expect((await repo.getBankRules(db))[0].memo).toBe("電気料金");
    await expect(repo.saveBankRule(db, { ...rule, keyword: " " })).rejects.toThrow(/言葉/);
    await expect(repo.saveBankRule(db, { ...rule, tax_code: "x" as never })).rejects.toThrow(/税区分/);
    // 分け方：保存し直すと置き換わる。分ける行に使った科目は消せない
    const split = { account_id: id("支払手数料"), sub_account_id: null, tax_code: null, invoice_kind: null, amount: 330, memo: "手数料" };
    await repo.saveBankRule(db, { ...rule, id: ruleId, splits: [split, { ...split, amount: 110, memo: "" }] });
    expect((await repo.getBankRules(db))[0].splits).toEqual([split, { ...split, amount: 110, memo: "" }]);
    await repo.saveBankRule(db, { ...rule, id: ruleId, splits: [split] });
    expect((await repo.getBankRules(db))[0].splits).toEqual([split]);
    expect(await repo.accountUsage(db, id("支払手数料"))).toBeGreaterThan(0);
    await expect(repo.saveBankRule(db, { ...rule, id: ruleId, splits: [{ ...split, amount: 0 }] })).rejects.toThrow(/金額/);
    await repo.deleteBankRule(db, ruleId);
    expect(await repo.getBankRules(db)).toEqual([]);
    expect(await db.select("SELECT * FROM bank_rule_splits")).toEqual([]);
  });
});

describe("決算書の欄（repo）", () => {
  test("科目ごとに選べて履歴に残る。null で自動に戻す。売上の科目・ほかの部分の欄は選べない", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.setAccountStatementLine(db, id("車両費"), "旅費交通費");
    expect((await repo.getAccounts(db, 2026)).find((a) => a.name === "車両費")!.statement_line).toBe("旅費交通費");
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "車両費", old_value: "決算書の欄 自動（追加の欄）", new_value: "決算書の欄 旅費交通費（2026年から）" });
    await repo.setAccountStatementLine(db, id("車両費"), null);
    expect((await repo.getAccounts(db, 2026)).find((a) => a.name === "車両費")!.statement_line).toBeNull();
    await expect(repo.setAccountStatementLine(db, id("売上高"), "雑費")).rejects.toThrow(/売上/);
    await expect(repo.setAccountStatementLine(db, id("車両費"), "現金")).rejects.toThrow(/決算書の欄/);
  });
});

describe("「何年から」の設定と年の締め（repo）", () => {
  const atYear = (raw: Sqlite, y: number) => raw.run("UPDATE settings SET fiscal_year = ?", [y]);

  test("決算書の欄・不動産所得の規模は、表示中の年から。前の年はそのまま。前の年と同じに戻すと、その年の行は消す", async () => {
    const { db, raw } = strict;
    const car = (await repo.getAccounts(db, 2026)).find((a) => a.name === "車両費")!.id;
    const lineIn = async (y: number) => (await repo.getAccounts(db, y)).find((a) => a.id === car)!.statement_line;
    atYear(raw, 2027);
    await repo.setAccountStatementLine(db, car, "旅費交通費");
    expect([await lineIn(2026), await lineIn(2027), await lineIn(2028)]).toEqual([null, "旅費交通費", "旅費交通費"]);
    atYear(raw, 2028);
    await repo.setAccountStatementLine(db, car, null);
    expect([await lineIn(2027), await lineIn(2028)]).toEqual(["旅費交通費", null]);
    atYear(raw, 2027);
    await repo.setAccountStatementLine(db, car, null);
    expect(raw.query("SELECT from_year, line FROM account_lines").all()).toEqual([{ from_year: 2028, line: "" }]);

    await repo.saveRealEstate(db, "small");
    expect([await repo.getRealEstateScale(db, 2026), await repo.getRealEstateScale(db, 2027)]).toEqual(["none", "small"]);
    expect((await repo.getSettings(db)).real_estate).toBe("small");
    atYear(raw, 2026);
    expect((await repo.getSettings(db)).real_estate).toBe("none");
  });

  test("締めた年が引き継いでいる設定は変えられない（消費税・申告の種類・家事按分・科目名・決算書の欄・不動産所得の規模）", async () => {
    const { db, raw } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.createSub(db, id("普通預金"), "A銀行");
    const sub = (await repo.getSubAccounts(db, 2026)).find((x) => x.name === "A銀行")!.id;
    await repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
    await repo.saveHomeUseRate(db, 2026, { account_id: id("水道光熱費"), rate: 40, method: "yearend", basis: "" });
    // 2026年は締めずに、2027年を締める（2027年は 2026年の設定を引き継いでいる）
    await repo.closeYear(db, 2027);
    const msg = (what: string) => new RegExp(`2027年は締め済みで、2026年の${what}を引き継いでいます`);
    await expect(repo.saveTaxYear(db, { from_year: 2026, status: "simplified", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 }))
      .rejects.toThrow(msg("消費税の設定"));
    await expect(repo.saveFilingYear(db, 2026, "white")).rejects.toThrow(msg("申告の種類"));
    await expect(repo.saveHomeUseRate(db, 2026, { account_id: id("水道光熱費"), rate: 80, method: "yearend", basis: "" })).rejects.toThrow(msg("家事按分の設定"));
    await expect(repo.updateAccount(db, id("車両費"), { code: accts.find((a) => a.name === "車両費")!.code, name: "自動車費", kana: "" })).rejects.toThrow(msg("科目名"));
    await expect(repo.renameSub(db, sub, "B銀行")).rejects.toThrow(msg("補助科目の名前"));
    await expect(repo.setAccountStatementLine(db, id("車両費"), "旅費交通費")).rejects.toThrow(msg("決算書の欄"));
    await expect(repo.saveRealEstate(db, "small")).rejects.toThrow(msg("不動産所得の規模"));
    // 値の変わらない保存は何もしない（その年の行を足すと、締めた年の引き継ぎ元が変わるため）
    await repo.saveFilingYear(db, 2026, "blue65");
    await repo.saveHomeUseRate(db, 2026, { account_id: id("水道光熱費"), rate: 40, method: "yearend", basis: "" });
    expect(raw.query("SELECT COUNT(*) AS n FROM filing_years").get()).toEqual({ n: 0 });
    // ソフトを通さない書き込みもトリガーで止める（値の変わらない UPDATE は通す）
    expect(() => raw.run("UPDATE tax_years SET status = 'simplified' WHERE from_year = 2026")).toThrow(/締め済み/);
    expect(() => raw.run("INSERT INTO filing_years (from_year, filing_type) VALUES (2026, 'white')")).toThrow(/締め済み/);
    expect(() => raw.run("DELETE FROM home_use_rates WHERE from_year = 2026")).toThrow(/締め済み/);
    expect(() => raw.run("INSERT INTO account_lines (account_id, from_year, line) VALUES (?, 2025, '雑費')", [id("車両費")])).toThrow(/締め済み/);
    expect(() => raw.run("INSERT INTO real_estate_years (from_year, scale) VALUES (2026, 'small')")).toThrow(/締め済み/);
    raw.run("UPDATE tax_years SET status = 'standard' WHERE from_year = 2026");
    raw.run("UPDATE tax_years SET taxable_from = '2026-04-01' WHERE from_year = 2026"); // その年だけのもの
    // 2027年に自分の設定があれば、2026年は変えられる
    await repo.reopenYear(db, 2027, "設定の確認");
    atYear(raw, 2027);
    await repo.saveRealEstate(db, "business");
    await repo.closeYear(db, 2027);
    atYear(raw, 2026);
    await repo.saveRealEstate(db, "small");
    expect([await repo.getRealEstateScale(db, 2026), await repo.getRealEstateScale(db, 2027)]).toEqual(["small", "business"]);
  });
});

describe("還付申告に関する明細書（repo）", () => {
  test("年ごとに保存して読み直せる。おかしな入力は保存しない。締めた年は変えられない", async () => {
    const { db } = strict;
    expect(await repo.getRefundDetail(db, 2026)).toBeNull();
    const x = {
      reasons: { export: false, capex: true, other: false, otherText: "" }, sales: [], exports: [],
      bank: { name: "", kind: 1, branch: "", branchKind: 2, deposit: 1, number: "" }, broker: { name: "", address: "" },
      inventory: [], assets: [{ kind: "車両", date: "2026-11-15", continuous: false, amount: 4_400_000, regNo: "", name: "", address: "" }], special: "",
    };
    await repo.saveRefundDetail(db, 2026, x);
    expect(await repo.getRefundDetail(db, 2026)).toEqual(x);
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "2026年の還付申告に関する明細書", new_value: "理由：設備投資、明細 1行" });
    await expect(repo.saveRefundDetail(db, 2026, { ...x, reasons: { ...x.reasons, capex: false } })).rejects.toThrow(/理由/);
    await repo.closeYear(db, 2026);
    await expect(repo.saveRefundDetail(db, 2026, { ...x, special: "変更" })).rejects.toThrow(/締め/);
  });
});

describe("所得税の申告書の入力（repo）", () => {
  test("年度ごとに保存して読み直せる。おかしな金額は保存しない。締めた年は変えられない", async () => {
    const { db } = strict;
    expect((await repo.getIncomeTaxInput(db, 2026)).socialInsurance).toEqual([]);
    const input = { ...EMPTY_INCOME_TAX_INPUT, birthday: "1980-04-01", socialInsurance: [{ kind: "国民年金", amount: 210_000 }], prepaid: 30_000 };
    await repo.saveIncomeTaxInput(db, 2026, input);
    expect(await repo.getIncomeTaxInput(db, 2026)).toEqual(input);
    expect((await repo.getIncomeTaxInput(db, 2027)).prepaid).toBe(0);
    await expect(repo.saveIncomeTaxInput(db, 2026, { ...input, prepaid: -1 })).rejects.toThrow(/予定納税額/);
    await repo.closeYear(db, 2026);
    await expect(repo.saveIncomeTaxInput(db, 2026, input)).rejects.toThrow(/締め済み/);
  });
});

describe("簡易課税の事業区分（repo）", () => {
  test("登録のときに 明細 → 科目の初期値 → 主な事業区分 で決めて記録し、履歴の写しと照合に入る。科目の初期値の変更は履歴に残る", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.saveTaxYear(db, { from_year: 2026, status: "simplified", method: "inclusive", business_class: 5, taxable_from: "" });
    await repo.setAccountBusinessClass(db, id("雑収入"), 4);
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === id("雑収入"))!.default_business_class).toBe(4);
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ old_value: "事業区分の初期値 主な事業区分", new_value: "事業区分の初期値 第四種" });
    const e = await repo.createEntry(db, "2026-05-01", [
      { row_no: 1, side: "debit", account_id: id("普通預金"), sub_account_id: null, amount: 3300, memo: "" },
      { row_no: 1, side: "credit", account_id: id("売上高"), sub_account_id: null, amount: 1100, memo: "", business_class: 2 },
      { row_no: 2, side: "credit", account_id: id("雑収入"), sub_account_id: null, amount: 1100, memo: "" },
      { row_no: 3, side: "credit", account_id: id("売上高"), sub_account_id: null, amount: 1100, memo: "" },
    ]);
    expect((await repo.getEntry(db, e))!.lines.map((l) => l.business_class)).toEqual([null, 2, 4, 5]);
    expect((await repo.getHistory(db, e))[0].snapshot.lines.map((l) => l.cls ?? null)).toEqual([null, 2, 4, 5]);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    raw.run("UPDATE journal_lines SET business_class = 6 WHERE entry_id = ? AND business_class = 2", [e]);
    expect((await repo.verifyIntegrity(db)).issues.map((i) => i.message).join()).toMatch(new RegExp(`伝票 No.${e}`));
    await expect(repo.setAccountBusinessClass(db, id("雑収入"), 7)).rejects.toThrow(/第1種/);
  });
});

describe("事業区分の分からない売上（repo）", () => {
  test("CSV 取り込みでは主な事業区分を入れない（科目の初期値は入る）。簡易課税に変えた年の区分の無い売上は一括設定で埋まる", async () => {
    const { db } = strict;
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    const sale = (acc: string): JournalLine[] => [
      { row_no: 1, side: "debit", account_id: id("普通預金"), sub_account_id: null, amount: 1100, memo: "" },
      { row_no: 1, side: "credit", account_id: id(acc), sub_account_id: null, amount: 1100, memo: "" },
    ];
    // 本則課税のときに入れた売上（区分は記録されない）
    await repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "" });
    const before = await repo.createEntry(db, "2026-02-01", sale("売上高"));
    expect((await repo.getEntry(db, before))!.lines[1].business_class).toBeNull();
    // 簡易課税に変える
    await repo.saveTaxYear(db, { from_year: 2026, status: "simplified", method: "inclusive", business_class: 5, taxable_from: "" });
    await repo.setAccountBusinessClass(db, id("雑収入"), 4);
    const [imported, importedMisc] = await repo.importEntries(db, [
      { date: "2026-03-01", lines: sale("売上高"), counterpartyId: null },
      { date: "2026-03-02", lines: sale("雑収入"), counterpartyId: null },
    ], "test.csv");
    expect((await repo.getEntry(db, imported))!.lines[1].business_class).toBeNull();
    expect((await repo.getEntry(db, importedMisc))!.lines[1].business_class).toBe(4);
    expect((await repo.untaxedEntryIds(db, 2026)).map((x) => x.id)).toEqual([before, imported]);
    expect(await repo.fillTaxCodes(db, 2026)).toEqual({ updated: 2, closed: 0 });
    expect((await repo.getEntry(db, before))!.lines[1].business_class).toBe(5);
    expect(await repo.untaxedEntryIds(db, 2026)).toEqual([]);
  });
});

describe("本則課税の用途区分・控除の方式（repo）", () => {
  test("登録のときに 明細 → 科目の初期値 → 共通対応 で記録し、履歴の写しと照合に入る。CSV 取り込みでは共通対応を入れず、一括設定で埋まる", async () => {
    const { db, raw } = strict;
    await repo.initChain(db);
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" });
    await repo.setAccountPurchaseUse(db, id("仕入高"), "taxable");
    expect((await repo.getAccounts(db, 2026)).find((a) => a.id === id("仕入高"))!.default_purchase_use).toBe("taxable");
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ old_value: "用途区分の初期値 共通対応", new_value: "用途区分の初期値 課税対応" });
    const pay = (acc: string, extra: Partial<JournalLine> = {}): JournalLine[] => [
      { row_no: 1, side: "debit", account_id: id(acc), sub_account_id: null, amount: 1100, memo: "", ...extra },
      { row_no: 1, side: "credit", account_id: id("普通預金"), sub_account_id: null, amount: 1100, memo: "" },
    ];
    const e1 = await repo.createEntry(db, "2026-05-01", pay("消耗品費", { purchase_use: "nontaxable" }));
    const e2 = await repo.createEntry(db, "2026-05-02", pay("仕入高"));
    const e3 = await repo.createEntry(db, "2026-05-03", pay("通信費"));
    const useOf = async (e: number) => (await repo.getEntry(db, e))!.lines.map((l) => l.purchase_use ?? null);
    expect(await useOf(e1)).toEqual(["nontaxable", null]);
    expect(await useOf(e2)).toEqual(["taxable", null]);
    expect(await useOf(e3)).toEqual(["common", null]);
    expect((await repo.getHistory(db, e1))[0].snapshot.lines.map((l) => l.use ?? null)).toEqual(["nontaxable", null]);
    expect((await repo.verifyIntegrity(db)).issues).toEqual([]);
    raw.run("UPDATE journal_lines SET purchase_use = 'taxable' WHERE entry_id = ? AND purchase_use = 'nontaxable'", [e1]);
    expect((await repo.verifyIntegrity(db)).issues.map((i) => i.message).join()).toMatch(new RegExp(`伝票 No.${e1}`));
    raw.run("UPDATE journal_lines SET purchase_use = 'nontaxable' WHERE entry_id = ? AND purchase_use = 'taxable'", [e1]);

    const [imported] = await repo.importEntries(db, [{ date: "2026-06-01", lines: pay("通信費"), counterpartyId: null }], "test.csv");
    expect(await useOf(imported)).toEqual([null, null]);
    expect((await repo.untaxedEntryIds(db, 2026)).map((x) => x.id)).toEqual([imported]);
    expect(await repo.fillTaxCodes(db, 2026)).toEqual({ updated: 1, closed: 0 });
    expect(await useOf(imported)).toEqual(["common", null]);
    await expect(repo.setAccountPurchaseUse(db, id("通信費"), "x" as never)).rejects.toThrow(/用途区分/);
  });

  test("一括比例配分方式の翌年は個別対応方式にできない（2年続けて使う決まり）。変更は履歴に残る", async () => {
    const { db } = strict;
    await repo.saveTaxYear(db, { from_year: 2025, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "lump" });
    await expect(repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" }))
      .rejects.toThrow(/2025年に一括比例配分方式にしたため/);
    await repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "lump" });
    expect((await repo.getTaxYears(db)).map((t) => t.deduction)).toEqual(["lump", "lump"]);
    expect((await repo.getMasterHistory(db))[0].new_value).toMatch(/一括比例配分方式/);
    await repo.saveTaxYear(db, { from_year: 2027, status: "standard", method: "inclusive", business_class: 5, taxable_from: "", deduction: "individual" });
  });
});

describe("製造原価を使う・使わない（repo）", () => {
  test("使うで製造原価の科目をまとめて表示。締めていない年に仕訳があれば戻せず、その年を締めれば戻せる（科目の表示の履歴も残る）", async () => {
    const { db } = makeDb("strict");
    const mfg = async () => (await repo.getAccounts(db, 2026)).filter((a) => a.code >= "520" && a.code <= "531");
    expect((await mfg()).map((a) => a.is_active)).toEqual(Array(12).fill(0));
    await repo.setManufacturing(db, true);
    expect((await mfg()).every((a) => a.is_active === 1)).toBe(true);
    // 仕訳が無ければ戻せる
    await repo.setManufacturing(db, false);
    expect((await mfg()).every((a) => a.is_active === 0)).toBe(true);
    await repo.setManufacturing(db, true);
    const accts = await repo.getAccounts(db, 2026);
    const id = (n: string) => accts.find((a) => a.name === n)!.id;
    await repo.createEntry(db, "2025-11-01", [
      { row_no: 1, side: "debit", account_id: id("原材料仕入高"), sub_account_id: null, amount: 30_000, memo: "材料" },
      { row_no: 1, side: "credit", account_id: id("現金"), sub_account_id: null, amount: 30_000, memo: "材料" },
    ]);
    await expect(repo.setManufacturing(db, false)).rejects.toThrow(/締めていない年（2025年）の仕訳があるため/);
    expect((await mfg()).every((a) => a.is_active === 1)).toBe(true);
    await repo.closeYear(db, 2025);
    await repo.setManufacturing(db, false);
    expect((await mfg()).every((a) => a.is_active === 0)).toBe(true);
    const actions = (await repo.getMasterHistory(db)).filter((h) => h.label === "原材料仕入高").map((h) => h.action);
    expect(actions).toEqual(["hide", "show", "hide", "show"]);
  });
});

describe("税抜経理（repo）", () => {
  test("税抜経理にすると仮払・仮受消費税等を表示。手で直した消費税額は税抜経理の年だけ残り、記録の連鎖と履歴に入る。免税事業者の年は税込経理", async () => {
    const { db } = makeDb("strict");
    await repo.initChain(db);
    const accts = await repo.getAccounts(db, 2026);
    const acc = (code: string) => accts.find((a) => a.code === code)!;
    expect([acc("118").is_active, acc("261").is_active]).toEqual([0, 0]);
    await repo.saveTaxYear(db, { from_year: 2026, status: "standard", method: "exclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
    const after = await repo.getAccounts(db, 2026);
    expect(after.filter((a) => a.code === "118" || a.code === "261").map((a) => a.is_active)).toEqual([1, 1]);
    const lines: JournalLine[] = [
      { row_no: 1, side: "debit", account_id: acc("612").id, sub_account_id: null, amount: 1100, memo: "", tax_code: "purchase10", invoice_kind: "qualified", tax_amount: 99 },
      { row_no: 1, side: "credit", account_id: acc("101").id, sub_account_id: null, amount: 1100, memo: "", tax_amount: 5 },
    ];
    const e = await repo.createEntry(db, "2026-05-01", lines);
    expect((await repo.getEntry(db, e))!.lines.map((l) => l.tax_amount)).toEqual([99, null]);
    expect((await repo.getHistory(db, e))[0].snapshot.lines[0].taxAmount).toBe(99);
    expect((await repo.verifyIntegrity(db)).issues.filter((i) => i.level === "error")).toEqual([]);
    await expect(repo.createEntry(db, "2026-05-02", [{ ...lines[0], tax_amount: 2000 }, { ...lines[1], tax_amount: null }])).rejects.toThrow(/消費税額が金額より大きく/);
    await repo.saveTaxYear(db, { from_year: 2027, status: "exempt", method: "exclusive", business_class: 5, taxable_from: "", deduction: "individual", voluntary_interim: 0 });
    expect((await repo.getTaxYears(db)).find((t) => t.from_year === 2027)!.method).toBe("inclusive");
  });
});

describe("一覧の CSV 取り込み（repo）", () => {
  test("科目は CSV のコードが使えればそれ、使えなければ空いているコード。補助科目・取引先も足す。途中で問題があれば1件も足さない", async () => {
    const { db } = makeDb("standard");
    await repo.importAccountList(db, [{ code: "650", name: "保守料", kana: "", category: "expense" }, { code: "101", name: "小口現金", kana: "", category: "asset" }]);
    const accts = await repo.getAccounts(db, 2026);
    expect(accts.find((a) => a.name === "保守料")!.code).toBe("650");
    expect(accts.find((a) => a.name === "小口現金")!.code).not.toBe("101");
    const bank = accts.find((a) => a.code === "103")!;
    await repo.importSubList(db, [{ accountId: bank.id, name: "ゆうちょ銀行", kana: "" }]);
    expect((await repo.getSubAccounts(db, 2026)).some((s) => s.name === "ゆうちょ銀行")).toBe(true);
    await expect(repo.importCounterpartyList(db, [{ name: "株式会社B", kana: "", invoice_no: "", memo: "" }, { name: "", kana: "", invoice_no: "", memo: "" }])).rejects.toThrow(/取引先名/);
    expect((await repo.getCounterparties(db)).some((c) => c.name === "株式会社B")).toBe(false);
  });
});
