/**
 * 税理士と受け渡している帳簿が、古い版の domble の形式のとき、この版の形式にしてよいか聞く（lib/handoff.ts の askBeforeUpgrade）。
 * 片方だけ新しい版で開いて形式を新しくすると、古い版を使っている相手は読み取り専用でしか開けなくなる
 */
import { ArrowUpCircle, Eye, FolderOpen } from "lucide-react";
import { Logo } from "./StartScreen";
import { SCHEMA_VERSION } from "../../constants/appConfig";

interface Props {
  path: string;
  version: number;
  busy: boolean;
  onUpgrade: () => void;
  onReadOnly: () => void;
  onBack: () => void;
}

export const UpgradeScreen = ({ path, version, busy, onUpgrade, onReadOnly, onBack }: Props) => {
  const fileName = path.split(/[\\/]/).pop();
  return (
    <div className="start">
      <div className="start-card login-card">
        <Logo size={56} />
        <h1 className="start-title"><ArrowUpCircle size={20} /> 古い版の domble の帳簿です</h1>
        <p className="start-sub">
          「{fileName}」は、税理士と受け渡している帳簿で、古い版の domble の形式（形式の版 {version}）です。この版で開くと、形式の版 {SCHEMA_VERSION} に新しくなります。
        </p>
        <p className="field-note lock-note">
          形式を新しくすると、古い版の domble では読み取り専用でしか開けなくなります。相手（事業者・税理士）がまだ古い版を使っているなら、
          先に domble の版をそろえてください。見るだけなら「読み取り専用で開く」を選ぶと、帳簿ファイルは変わりません。
        </p>
        <div className="lock-actions">
          <button className="btn ghost" onClick={onReadOnly} disabled={busy}><Eye size={16} /> 読み取り専用で開く</button>
          <button className="btn primary" onClick={onUpgrade} disabled={busy}><FolderOpen size={16} /> 新しい形式にして開く</button>
        </div>
        <button className="link-btn" onClick={onBack} disabled={busy}>やめる</button>
      </div>
    </div>
  );
};
