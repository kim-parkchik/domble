import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type Database from "./db/connection";
import { exists } from "@tauri-apps/plugin-fs";
import {
  House, BookOpen, FileText, ScrollText, BookText, Scale, FileSpreadsheet, Landmark, Tags, Settings as SettingsIcon, LogOut, History, ShieldCheck, Percent, Paperclip, Building2, Users, UserRound, Repeat,
  ChevronDown, Copy, FolderOpen, Eye, Boxes, ShieldOff, Receipt,
} from "lucide-react";
import { Popover } from "./components/Popover";
import { copyText } from "./lib/clipboard";
import { AppProvider, useAppContext } from "./context/AppContext";
import { openDatabase, pruneBackups, pickExistingFile, pickNewFile, pushRecentFile, removeRecentFile } from "./db/database";
import { EXT_BACKUP, EXT_MAIN, isBackupFile, isBookFile } from "./constants/appConfig";
import { ROLE_LABEL, type Perm } from "./lib/permissions";
import { isBeforeStrict, isYearCompliant } from "./lib/ebook";

/** 画面ごとに、変更に要る権限（無い人には画面上部で知らせる） */
const PAGE_PERM: Partial<Record<Page, Perm>> = {
  opening: "master", accounts: "master", homeuse: "master", assets: "master", settings: "settings", users: "users",
};
import * as repo from "./db/repo";
import type { Account, Settings, SubAccount, User } from "./lib/types";
import { useToast } from "./components/Toast";
import { StartScreen, Logo } from "./features/start/StartScreen";
import { DashboardPage } from "./features/home/DashboardPage";
import { CashBookPage } from "./features/entry/CashBookPage";
import { JournalVoucherPage } from "./features/entry/JournalVoucherPage";
import { JournalListPage } from "./features/books/JournalListPage";
import { GeneralLedgerPage } from "./features/books/GeneralLedgerPage";
import { HistoryPage } from "./features/books/HistoryPage";
import { EvidencePage } from "./features/evidence/EvidencePage";
import { TrialBalancePage } from "./features/reports/TrialBalancePage";
import { StatementsPage } from "./features/reports/StatementsPage";
import { HomeUsePage } from "./features/reports/HomeUsePage";
import { FixedAssetsPage } from "./features/reports/FixedAssetsPage";
import { TaxPage } from "./features/reports/TaxPage";
import { OpeningBalancesPage } from "./features/settings/OpeningBalancesPage";
import { AccountsPage } from "./features/settings/AccountsPage";
import { CounterpartiesPage } from "./features/settings/CounterpartiesPage";
import { BusinessSettingsPage } from "./features/settings/BusinessSettingsPage";
import { SetupScreen } from "./features/start/SetupScreen";
import { LoginScreen } from "./features/start/LoginScreen";
import { UnlockScreen } from "./features/start/UnlockScreen";
import { NEEDS_KEY, WRONG_KEY, type Unlock } from "./db/encryption";
import { UsersPage } from "./features/settings/UsersPage";
import { EBookPage } from "./features/settings/EBookPage";
import { YearNotice } from "./components/YearNotice";
import { IntegrityNotice } from "./components/IntegrityNotice";

export type Page =
  | "home" | "cashbook" | "voucher" | "journal" | "ledger" | "evidence" | "history" | "trial" | "homeuse" | "assets" | "tax" | "statements" | "opening" | "accounts" | "counterparties" | "users" | "settings" | "ebook";

const NAV: { group: string; items: { id: Page; label: string; icon: ReactNode }[] }[] = [
  { group: "", items: [{ id: "home", label: "ホーム", icon: <House size={17} /> }] },
  {
    group: "入力",
    items: [
      { id: "cashbook", label: "帳簿入力", icon: <BookOpen size={17} /> },
      { id: "voucher", label: "振替伝票", icon: <FileText size={17} /> },
    ],
  },
  {
    group: "帳簿",
    items: [
      { id: "journal", label: "仕訳日記帳", icon: <ScrollText size={17} /> },
      { id: "ledger", label: "総勘定元帳", icon: <BookText size={17} /> },
      { id: "evidence", label: "証憑", icon: <Paperclip size={17} /> },
      { id: "history", label: "訂正・削除履歴", icon: <History size={17} /> },
    ],
  },
  {
    group: "集計",
    items: [
      { id: "trial", label: "残高試算表", icon: <Scale size={17} /> },
      { id: "homeuse", label: "家事按分", icon: <Percent size={17} /> },
      { id: "assets", label: "固定資産台帳", icon: <Boxes size={17} /> },
      { id: "tax", label: "消費税", icon: <Receipt size={17} /> },
      { id: "statements", label: "決算書", icon: <FileSpreadsheet size={17} /> },
    ],
  },
  {
    group: "設定",
    items: [
      { id: "opening", label: "期首残高", icon: <Landmark size={17} /> },
      { id: "accounts", label: "勘定科目", icon: <Tags size={17} /> },
      { id: "counterparties", label: "取引先", icon: <Building2 size={17} /> },
      { id: "users", label: "ユーザー", icon: <Users size={17} /> },
      { id: "settings", label: "事業者設定", icon: <SettingsIcon size={17} /> },
      { id: "ebook", label: "電子帳簿保存法", icon: <ShieldCheck size={17} /> },
    ],
  },
];

interface Session {
  db: Database;
  path: string;
  settings: Settings;
  accounts: Account[];
  subs: SubAccount[];
  /** 操作している人（選ぶまでは null） */
  user: User | null;
  /** 前回、保存の途中で止まって取り消された操作 */
  interrupted: string[];
  /** 読み取り専用（バックアップ .dmbk を開いたとき）。何も書き込まない */
  readOnly: boolean;
}

/** 帳簿を閉じる：ログアウトを記録して（読み取り専用でなければ）、接続を閉じる */
const endSession = async (s: Session) => {
  try {
    if (s.user && !s.readOnly) await repo.logAccess(s.db, s.user.id, "logout");
    repo.setActor(null);
    await s.db.close();
  } catch {
    /* すでに閉じていれば無視 */
  }
};

/** ウィンドウを閉じるとき、ログアウトの記録を待つ上限（記録できなくても閉じられるように） */
const CLOSE_WAIT_MS = 3000;

/** 読み取り専用で開いたときの利用者（ユーザーが1人もいない古いバックアップなど） */
const VIEWER: User = { id: 0, name: "閲覧のみ", has_password: 0, is_active: 1, role: "viewer", memo: "", created_at: "" };

export default function App() {
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  /** 暗号化した帳簿で、パスワードを聞いているところ */
  const [locked, setLocked] = useState<{ path: string; error: string } | null>(null);

  // 画面の操作で失敗したまま受け止められなかったもの（権限・読み取り専用・締め済みなど）は、
  // 何も起きないように見えないよう、まとめて知らせる
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : typeof e.reason === "string" ? e.reason : "";
      if (!msg) return;
      e.preventDefault();
      console.error(e.reason);
      toast(`できませんでした：${msg}`, "error");
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [toast]);

  // ウィンドウを閉じる（赤いボタン・⌘W・メニューの「domble を終了」）ときも、ログアウトを記録してから閉じる。
  // 閉じる直前の帳簿は ref で持つ（登録は最初の1回だけ）
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    try {
      getCurrentWindow()
        .onCloseRequested(async () => {
          const s = sessionRef.current;
          if (!s) return;
          await Promise.race([endSession(s), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
        })
        .then((u) => (cancelled ? u() : (unlisten = u)))
        .catch(() => undefined);
    } catch {
      /* Tauri の外（ブラウザでの確認など）では何もしない */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const load = async (path: string, isNew = false, unlock: Unlock = {}) => {
    // domble のファイル（帳簿・バックアップ）だけを開く
    if (!isBookFile(path) && !isBackupFile(path)) {
      removeRecentFile(path);
      toast(`domble の帳簿ファイル（.${EXT_MAIN}）かバックアップ（.${EXT_BACKUP}）ではないため、開けません`, "error");
      return;
    }
    setBusy(true);
    try {
      if (!isNew && !(await exists(path))) {
        removeRecentFile(path);
        toast("ファイルが見つかりません。移動または削除された可能性があります。", "error");
        return;
      }
      // バックアップは読み取り専用：ファイルのメモリ上の写しを開き、開いたときの記録・整理（書き込み）は何もしない
      const readOnly = isBackupFile(path);
      repo.setReadOnly(readOnly);
      const { db, triggersBefore } = await openDatabase(path, readOnly, unlock);
      setLocked(null);
      repo.setActor(null);
      let interrupted: string[] = [];
      if (!readOnly) {
        await repo.checkTriggers(db, triggersBefore);
        await repo.initChain(db);
        interrupted = await repo.checkInterrupted(db);
        await repo.initClosings(db);
        try {
          await pruneBackups(path, await repo.getBackupGenerations(db));
        } catch (e) {
          console.warn("バックアップの整理に失敗しました", e);
        }
      }
      const settings = await repo.getSettings(db);
      const [accounts, subs] = await Promise.all([
        repo.getAccounts(db, settings.fiscal_year),
        repo.getSubAccounts(db, settings.fiscal_year),
      ]);
      pushRecentFile(path);
      setSession({ db, path, settings, accounts, subs, user: null, interrupted, readOnly });
    } catch (e) {
      // 暗号化した帳簿：パスワードを聞く（違っていたら、聞き直す）
      if (String(e).includes(NEEDS_KEY)) return setLocked({ path, error: "" });
      if (String(e).includes(WRONG_KEY)) return setLocked({ path, error: "パスワード（または回復キー）が違います" });
      console.error(e);
      setLocked(null);
      toast(`帳簿を開けませんでした：${String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!session && locked) {
    return (
      <UnlockScreen
        key={locked.path}
        path={locked.path}
        busy={busy}
        error={locked.error}
        onUnlock={(secret, remember) => load(locked.path, false, { secret, remember })}
        onBack={() => setLocked(null)}
      />
    );
  }

  if (!session) {
    return (
      <StartScreen
        busy={busy}
        onCreate={async () => {
          const p = await pickNewFile();
          if (p) await load(p, true);
        }}
        onOpen={async () => {
          const p = await pickExistingFile();
          if (p) await load(p);
        }}
        onOpenPath={(p) => load(p)}
      />
    );
  }

  const close = async () => {
    await endSession(session);
    repo.setReadOnly(false);
    setSession(null);
  };

  // 新しい帳簿（または保存方式が未設定の帳簿）は、まず初期設定（読み取り専用のときは設定できないので、そのまま見る）
  if (!session.readOnly && (!session.settings.business_name || !session.settings.e_book_mode)) {
    return (
      <SetupScreen
        db={session.db}
        settings={session.settings}
        onDone={(settings) => setSession({ ...session, settings })}
        onBack={close}
      />
    );
  }

  // 使う人を選ぶ（1人だけでパスワードもなければ自動）
  if (!session.user) {
    return (
      <UserGate
        db={session.db}
        settings={session.settings}
        readOnly={session.readOnly}
        onLogin={async (user) => {
          repo.setActor(user.id || null, user.role);
          if (!session.readOnly) await repo.logAccess(session.db, user.id, "login");
          setSession({ ...session, user });
        }}
        onBack={close}
      />
    );
  }

  const switchUser = async () => {
    if (session.user && !session.readOnly) await repo.logAccess(session.db, session.user.id, "logout");
    repo.setActor(null);
    setSession({ ...session, user: null, interrupted: [] });
  };

  return (
    <AppProvider key={session.path} db={session.db} filePath={session.path} initialSettings={session.settings} initialAccounts={session.accounts} initialSubs={session.subs} user={session.user} readOnly={session.readOnly}>
      <Shell onClose={close} onSwitchUser={switchUser} interrupted={session.interrupted} />
    </AppProvider>
  );
}

/** ファイル名。押すと絶対パスの全体とコピーのボタンを出す */
const FilePath = ({ path, name }: { path: string; name: string }) => {
  const toast = useToast();
  return (
    <Popover className="file-name" title="帳簿ファイルの場所を表示" label={<><FolderOpen size={13} /> {name}</>}>
      {() => (
        <div className="file-path-panel">
          <div className="popover-note">帳簿ファイルの場所</div>
          <code className="file-path">{path}</code>
          <button
            className="btn ghost sm"
            onClick={async () => {
              if (await copyText(path)) toast("場所をコピーしました");
              else toast("コピーできませんでした", "error");
            }}
          >
            <Copy size={14} /> コピー
          </button>
        </div>
      )}
    </Popover>
  );
};

/**
 * ユーザーがいなければ最初の1人を作り、1人だけでパスワードもなければそのまま選ぶ。それ以外は選ぶ画面
 * 読み取り専用のときはユーザーを作らない（ユーザーがいない古いバックアップは「閲覧のみ」で開く）
 */
const UserGate = ({ db, settings, readOnly, onLogin, onBack }: {
  db: Database;
  settings: Settings;
  readOnly: boolean;
  onLogin: (u: User) => void;
  onBack: () => void;
}) => {
  const [users, setUsers] = useState<User[] | null>(null);
  // 開発時の StrictMode では effect が2回走るので、ログイン（の記録）が二重にならないよう1回だけにする
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      if (!readOnly) await repo.ensureUsers(db, settings.owner_name);
      const list = await repo.getUsers(db);
      const active = list.filter((u) => u.is_active);
      if (active.length === 0 && readOnly) onLogin(VIEWER);
      else if (active.length === 1 && !active[0].has_password) onLogin(active[0]);
      else setUsers(list);
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);
  if (!users) return null;
  return <LoginScreen db={db} users={users} businessName={settings.business_name} onLogin={onLogin} onBack={onBack} />;
};

const Shell = ({ onClose, onSwitchUser, interrupted }: { onClose: () => void; onSwitchUser: () => void; interrupted: string[] }) => {
  const { db, settings, year, filePath, reloadSettings, dataVersion, strict, currentUser, users, readOnly, can } = useAppContext();
  const [showInterrupted, setShowInterrupted] = useState(interrupted.length > 0);
  const [page, setPage] = useState<Page>("home");
  const [years, setYears] = useState<number[]>([year]);

  useEffect(() => {
    repo.getYears(db, year).then(setYears).catch(console.error);
  }, [db, year, dataVersion]);

  const switchYear = async (y: number) => {
    await repo.setFiscalYear(db, y);
    await reloadSettings();
  };

  const fileName = filePath.split(/[\\/]/).pop();
  const current = NAV.flatMap((g) => g.items).find((i) => i.id === page)!;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="メニュー">
        <div className="brand">
          <Logo size={30} />
          <div className="brand-text">
            <strong>{settings.business_name}</strong>
            <span>{settings.owner_name}</span>
          </div>
        </div>
        {isYearCompliant(settings, year) ? (
          <div className="mode-badge" title="電子帳簿保存法（優良な電子帳簿）に対応した保存方式です">
            <ShieldCheck size={13} /> 電子帳簿保存法 対応
          </div>
        ) : (
          <div className="mode-badge off" title={`${year}年は通常の保存です。訂正・削除の履歴は残っていません`}>
            <ShieldOff size={13} /> {year}年は電子帳簿保存法の対応外
          </div>
        )}
        {NAV.map((g) => (
          <div key={g.group || "top"} className="nav-group">
            {g.group && <div className="nav-label">{g.group}</div>}
            {g.items.filter((i) => strict || i.id !== "history").map((i) => (
              <button key={i.id} className={`nav-item${page === i.id ? " on" : ""}`} onClick={() => setPage(i.id)} aria-current={page === i.id ? "page" : undefined}>
                {i.icon}
                <span>{i.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{current.label}</span>
          <div className="topbar-right">
            <FilePath path={filePath} name={fileName ?? filePath} />
            <label className="year-pick">
              <span className="sr-only">会計年度</span>
              <select value={year} onChange={(e) => switchYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}年{isBeforeStrict(settings, y) ? "（電帳法の対応外）" : ""}</option>)}
              </select>
            </label>
            <Popover
              className="user-trigger"
              title="ユーザーのメニュー（操作はこの人の名前で記録されます）"
              label={<><UserRound size={15} /> <span className="user-name">{currentUser.name}</span> <ChevronDown size={14} /></>}
            >
              {(closeMenu) => (
                <>
                  <div className="popover-note">
                    権限：<b>{ROLE_LABEL[currentUser.role]}</b><br />
                    操作は「{currentUser.name}」の名前で記録されます
                  </div>
                  {users.filter((u) => u.is_active).length > 1 || currentUser.has_password ? (
                    <button className="popover-item" role="menuitem" onClick={() => { closeMenu(); onSwitchUser(); }}>
                      <Repeat size={15} /> ユーザーの切り替え
                    </button>
                  ) : null}
                  <button className="popover-item" role="menuitem" onClick={() => { closeMenu(); onClose(); }}>
                    <LogOut size={15} /> 帳簿を閉じる
                  </button>
                </>
              )}
            </Popover>
          </div>
        </header>
        {isBeforeStrict(settings, year) && (
          <div className="year-notice">
            <div className="year-notice-row off">
              <ShieldOff size={15} />
              <span>
                <b>{year}年は電子帳簿保存法の対応外</b>です。この年は通常の保存で記録していたため、訂正・削除の履歴は残っていません（{settings.strict_from_year}年から対応）。
              </span>
            </div>
          </div>
        )}
        {readOnly && (
          <div className="year-notice">
            <div className="year-notice-row readonly">
              <Eye size={15} />
              <span>バックアップを<b>読み取り専用</b>で開いています。見ることはできますが、変更はできません（元のファイルには一切書き込みません）。</span>
            </div>
          </div>
        )}
        {!readOnly && currentUser.role === "viewer" && (
          <div className="year-notice">
            <div className="year-notice-row readonly">
              <span>「{currentUser.name}」は<b>閲覧のみ</b>のユーザーです。見ることはできますが、変更はできません。</span>
            </div>
          </div>
        )}
        {!readOnly && currentUser.role !== "viewer" && PAGE_PERM[page] && !can(PAGE_PERM[page]!) && (
          <div className="year-notice">
            <div className="year-notice-row closed">
              <span>この画面の変更は管理者だけができます（「{currentUser.name}」の権限は「{ROLE_LABEL[currentUser.role]}」です）。</span>
            </div>
          </div>
        )}
        {showInterrupted && (
          <div className="year-notice">
            <div className="year-notice-row warn">
              <span>
                前回、次の保存が完了しないままソフトが止まりました。書きかけの内容は取り消されているので、必要なら入力し直してください：
                {interrupted.join("、")}
              </span>
              <button className="btn ghost sm" onClick={() => setShowInterrupted(false)}>閉じる</button>
            </div>
          </div>
        )}
        <IntegrityNotice goHistory={() => setPage("history")} />
        <YearNotice goSettings={() => setPage("settings")} switchYear={switchYear} />
        <main className="content">
          {page === "home" && <DashboardPage go={setPage} />}
          {page === "cashbook" && <CashBookPage go={setPage} />}
          {page === "voucher" && <JournalVoucherPage />}
          {page === "journal" && <JournalListPage />}
          {page === "ledger" && <GeneralLedgerPage />}
          {page === "evidence" && <EvidencePage />}
          {page === "history" && <HistoryPage />}
          {page === "trial" && <TrialBalancePage />}
          {page === "homeuse" && <HomeUsePage />}
          {page === "assets" && <FixedAssetsPage />}
          {page === "tax" && <TaxPage go={setPage} />}
          {page === "statements" && <StatementsPage />}
          {page === "opening" && <OpeningBalancesPage />}
          {page === "accounts" && <AccountsPage />}
          {page === "counterparties" && <CounterpartiesPage />}
          {page === "users" && <UsersPage />}
          {page === "settings" && <BusinessSettingsPage />}
          {page === "ebook" && <EBookPage go={setPage} />}
        </main>
      </div>
    </div>
  );
};
