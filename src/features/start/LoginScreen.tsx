/**
 * ユーザーを選ぶ（帳簿を開いたとき・ユーザーを切り替えたとき）
 * ユーザーが1人だけで、パスワードもなければ、この画面は出さずに自動で選ぶ（App.tsx の UserGate。この PC で初めて開く帳簿は除く）
 * 税理士のユーザーがいる帳簿では、パスワードの無い人は、ここでパスワードを決めてから入る（だれが操作したかを確かにするため）
 */
import { useState } from "react";
import { KeyRound, LogIn, UserRound } from "lucide-react";
import type Database from "../../db/connection";
import type { User } from "../../lib/types";
import { Logo } from "./StartScreen";
import * as repo from "../../db/repo";

interface Props {
  db: Database;
  users: User[];
  businessName: string;
  onLogin: (user: User) => void;
  onBack: () => void;
  /** この PC で初めて開く帳簿 */
  firstOnThisPc?: boolean;
  /** パスワードの無い人は、決めてから入る（税理士のユーザーがいる帳簿） */
  requirePassword?: boolean;
}

export const LoginScreen = ({ db, users, businessName, onLogin, onBack, firstOnThisPc = false, requirePassword = false }: Props) => {
  const active = users.filter((u) => u.is_active);
  const [selected, setSelected] = useState<User | null>(active.length === 1 && !firstOnThisPc ? active[0] : null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** パスワードを決めてから入る */
  const setAndLogin = async (u: User) => {
    if (password !== confirm) return setError("確認のパスワードが合いません");
    setBusy(true);
    setError("");
    try {
      await repo.setUserPassword(db, u.id, "", password);
      onLogin({ ...u, has_password: 1 });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const login = async (u: User, pw: string) => {
    setBusy(true);
    setError("");
    try {
      if (await repo.checkLogin(db, u.id, pw)) onLogin(u);
      else setError("パスワードが違います");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="start">
      <div className="start-card login-card">
        <Logo size={56} />
        <h1 className="start-title">{businessName}</h1>
        <p className="start-sub">使う人を選んでください。登録・訂正などの操作は、選んだ人の名前で記録されます。</p>
        <ul className="user-list">
          {active.map((u) => (
            <li key={u.id}>
              <button
                className={`user-pick${selected?.id === u.id ? " on" : ""}`}
                onClick={() => {
                  setSelected(u);
                  setPassword("");
                  setConfirm("");
                  setError("");
                  if (!u.has_password && !requirePassword) login(u, "");
                }}
                disabled={busy}
              >
                <UserRound size={18} /> <span>{u.name}</span>
                {u.role === "accountant" && <span className="badge badge-create">税理士</span>}
                {u.has_password ? <KeyRound size={14} className="muted" aria-label="パスワードあり" /> : null}
              </button>
            </li>
          ))}
        </ul>
        {firstOnThisPc && (
          <p className="field-note login-note">
            この PC で初めて開く帳簿です。自分のユーザー（税理士なら「税理士」のユーザー）を選んでください。
            自分のユーザーが無ければ、帳簿の持ち主（事業者）に作ってもらってください（ほかの人の名前で入ると、その人が操作したことになります）。
          </p>
        )}
        {selected?.has_password ? (
          <form className="login-form" onSubmit={(e) => { e.preventDefault(); login(selected, password); }}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`${selected.name} のパスワード`} autoFocus />
            <button className="btn primary" type="submit" disabled={busy || !password}><LogIn size={16} /> はじめる</button>
          </form>
        ) : selected && requirePassword ? (
          <form className="login-form login-set" onSubmit={(e) => { e.preventDefault(); setAndLogin(selected); }}>
            <p className="field-note">税理士のユーザーがいる帳簿なので、{selected.name} さんのパスワードを決めてください（だれが操作したかを確かにするため）。</p>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="新しいパスワード" autoFocus />
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="もう一度" />
            <button className="btn primary" type="submit" disabled={busy || !password || !confirm}><LogIn size={16} /> 決めてはじめる</button>
          </form>
        ) : null}
        {error && <p className="notice" role="alert">{error}</p>}
        <button className="link-btn" onClick={onBack}>帳簿を閉じる</button>
      </div>
    </div>
  );
};
