/**
 * 暗号化した帳簿を開くときに、パスワード（または回復キー）を聞く
 * 「この PC に記憶する」にすると、次からこの PC では聞かずに開く（鍵は OS の鍵の保管庫に預ける）
 */
import { useState } from "react";
import { LockKeyhole, LockOpen } from "lucide-react";
import { Logo } from "./StartScreen";

interface Props {
  path: string;
  busy: boolean;
  error: string;
  onUnlock: (secret: string, remember: boolean) => void;
  onBack: () => void;
}

export const UnlockScreen = ({ path, busy, error, onUnlock, onBack }: Props) => {
  const [recovery, setRecovery] = useState(false);
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const fileName = path.split(/[\\/]/).pop();

  return (
    <div className="start">
      <div className="start-card login-card">
        <Logo size={56} />
        <h1 className="start-title"><LockKeyhole size={20} /> 暗号化された帳簿</h1>
        <p className="start-sub">「{fileName}」はパスワードで暗号化されています。{recovery ? "回復キー" : "パスワード"}を入れてください。</p>
        <form className="unlock-form" onSubmit={(e) => { e.preventDefault(); onUnlock(secret, remember); }}>
          <input
            key={recovery ? "recovery" : "password"}
            className={`input${recovery ? " recovery-input" : ""}`}
            type={recovery ? "text" : "password"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={recovery ? "XXXXXXXX-XXXXXXXX-…（64文字）" : "帳簿のパスワード"}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            この PC に記憶する（次からこの PC ではパスワードなしで開けます）
          </label>
          <button className="btn primary" type="submit" disabled={busy || !secret}><LockOpen size={16} /> 開く</button>
        </form>
        {error && <p className="notice" role="alert">{error}</p>}
        <button className="link-btn" onClick={() => { setRecovery(!recovery); setSecret(""); }}>
          {recovery ? "パスワードで開く" : "パスワードを忘れたとき（回復キーで開く）"}
        </button>
        <button className="link-btn" onClick={onBack}>戻る</button>
      </div>
    </div>
  );
};
