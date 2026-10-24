/**
 * repo.ts を、bun:sqlite のメモリ上の DB で動かして確かめる
 * （connection.ts の Database と同じ形の select / execute だけを用意する）
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import type Database from "./connection";
import { COLUMN_MIGRATIONS, SCHEMA } from "./schema";
import { ACCOUNT_SEEDS } from "../constants/accounts";
import * as repo from "./repo";
import type { JournalLine } from "../lib/types";

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
  ACCOUNT_SEEDS.forEach((a, i) =>
    raw.run("INSERT INTO accounts (code, name, kana, category, normal_side, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [a.code, a.name, a.kana, a.category, a.normal_side, i]),
  );
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

  test("通常モード：削除は物理削除。仕訳を削除してもひも付けだけ外れる", async () => {
    const { db } = makeDb("standard");
    const accts = await repo.getAccounts(db, 2026);
    const ls = lines.map((l) => ({ ...l, account_id: accts[l.account_id - 1]?.id ?? l.account_id }));
    const entry = await repo.createEntry(db, "2026-01-31", ls);
    const a = await repo.createEvidence(db, meta, { name: "a.pdf", bytes: pdf("a") });
    const b = await repo.createEvidence(db, meta, { name: "b.pdf", bytes: pdf("b") });
    await repo.linkEvidence(db, a, entry);
    await repo.deleteEntry(db, entry);
    expect((await repo.getEvidence(db, a))!.entry_ids).toEqual([]);
    await repo.voidEvidence(db, b);
    expect(await repo.getEvidence(db, b)).toBeNull();
    expect(await repo.getEvidenceHistory(db)).toEqual([]);
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
  test("郵便番号・登録番号はそろえて保存し、形がおかしければ保存しない", async () => {
    const { db } = makeDb("standard");
    const s = await repo.getSettings(db);
    expect([s.postal_code, s.address, s.invoice_no]).toEqual(["", "", ""]);
    await repo.saveSettings(db, { ...s, postal_code: "１２３４５６７", address: " 東京都千代田区 ", invoice_no: "t1234-5678-90123" });
    const after = await repo.getSettings(db);
    expect([after.postal_code, after.address, after.invoice_no]).toEqual(["123-4567", "東京都千代田区", "T1234567890123"]);
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
  const scanJpeg = (comps = 3, dpi = 200) => new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0,
    0xff, 0xc0, 0x00, 8 + 3 * comps, 8, 2339 >> 8, 2339 & 255, 1654 >> 8, 1654 & 255, comps, ...Array(3 * comps).fill(1), 0xff, 0xd9, Date.now() & 255,
  ]);
  const scanMeta = { ...meta, doc_type: "領収書", received_date: "2026-10-20" };

  test("厳密モードだけ。受領日が要る。画質を中身で確かめる", async () => {
    const std = makeDb("standard");
    await expect(repo.createEvidence(std.db, scanMeta, { name: "a.jpg", bytes: scanJpeg() }, "scan")).rejects.toThrow(/厳密モード/);
    const { db } = strict;
    await expect(repo.createEvidence(db, { ...scanMeta, received_date: "" }, { name: "a.jpg", bytes: scanJpeg() }, "scan")).rejects.toThrow(/受領日/);
    await expect(repo.createEvidence(db, scanMeta, { name: "low.jpg", bytes: scanJpeg(3, 96) }, "scan")).rejects.toThrow(/96dpi/);
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
    expect((await repo.getMasterHistory(db))[0]).toMatchObject({ label: "スキャナ保存の入力期間", old_value: "早期入力方式", new_value: "業務処理サイクル方式" });
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
