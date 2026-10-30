/**
 * 帳簿に「使用中」の目印（帳簿ファイル.lock）があるとき、開き方を聞く（同じ帳簿を2か所で開かないように）
 *  - ほかの PC（または同期フォルダの先）で開いている：読み取り専用で開く／それでも開く／やめる
 *  - この PC の前回の分：正しく閉じられなかった（強制終了など）か、もう1つ起動している
 */
import { Eye, FolderOpen, MonitorSmartphone } from "lucide-react";
import { Logo } from "./StartScreen";
import type { LockInfo } from "../../lib/backup";

interface Props {
  path: string;
  lock: LockInfo;
  state: "self" | "other";
  busy: boolean;
  onReadOnly: () => void;
  onOpenAnyway: () => void;
  onBack: () => void;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const LockScreen = ({ path, lock, state, busy, onReadOnly, onOpenAnyway, onBack }: Props) => {
  const fileName = path.split(/[\\/]/).pop();
  return (
    <div className="start">
      <div className="start-card login-card">
        <Logo size={56} />
        <h1 className="start-title"><MonitorSmartphone size={20} /> 帳簿が使用中です</h1>
        <p className="start-sub">
          「{fileName}」は、{state === "other" ? <b>ほかの PC（{lock.host || "名前の分からない PC"}）</b> : <b>この PC</b>}で {when(lock.openedAt)} から開かれています。
        </p>
        <p className="field-note lock-note">
          {state === "other"
            ? "同じ帳簿を2か所で同時に開くと、片方の入力が消えたり、帳簿が食い違ったりします。ほかの PC で閉じてから開くか、読み取り専用で開いてください。ほかの PC が止まったままのときは「それでも開く」を選びます。"
            : "前回、正しく閉じられなかった（強制終了・電源が切れたなど）か、domble をもう1つ起動しています。もう1つ起動していなければ「それでも開く」を選んでください。"}
        </p>
        <div className="lock-actions">
          <button className="btn ghost" onClick={onReadOnly} disabled={busy}><Eye size={16} /> 読み取り専用で開く</button>
          <button className={`btn ${state === "self" ? "primary" : "ghost"}`} onClick={onOpenAnyway} disabled={busy}><FolderOpen size={16} /> それでも開く</button>
        </div>
        <button className="link-btn" onClick={onBack} disabled={busy}>やめる</button>
      </div>
    </div>
  );
};
