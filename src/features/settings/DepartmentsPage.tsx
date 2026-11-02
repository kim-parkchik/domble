/**
 * 部門の管理（任意で使う。lib/departments.ts）
 *  - 店舗・事業の種類など。仕訳の明細ごとに付けて、残高試算表で部門ごとの損益を見る（決算書・申告書は全部まとめて1枚のまま）
 *  - 1つでも作ると、帳簿入力・振替伝票などに部門の欄が出る。部門の無い明細は「共通」
 *  - 使った部門は削除できない（非表示にはできる）。厳密モードでは変更を履歴に残す
 */
import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppContext } from "../../context/AppContext";
import { PageHeader } from "../../components/PageHeader";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { validateDepartment, type DepartmentInput } from "../../lib/departments";
import type { Department } from "../../lib/types";
import * as repo from "../../db/repo";

const errText = (e: unknown) => String(e).replace(/^Error: /, "");

export const DepartmentsPage = () => {
  const { db, departments, reloadDepartments, strict, dataVersion, can, readOnly } = useAppContext();
  const toast = useToast();
  const [editing, setEditing] = useState<Department | "new" | null>(null);
  const [usage, setUsage] = useState<Map<number, number>>(new Map());
  const mayEdit = can("master") && !readOnly;

  useEffect(() => {
    Promise.all(departments.map(async (d) => [d.id, await repo.departmentUsage(db, d.id)] as const))
      .then((xs) => setUsage(new Map(xs)))
      .catch(console.error);
  }, [db, departments, dataVersion]);

  const toggle = async (d: Department, active: boolean) => {
    try {
      await repo.setDepartmentActive(db, d.id, active);
      await reloadDepartments();
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  const remove = async (d: Department) => {
    if (!(await ask(`「${d.name}」を削除します。`, { title: "部門の削除", kind: "warning", okLabel: "削除", cancelLabel: "やめる" }))) return;
    try {
      await repo.deleteDepartment(db, d.id);
      await reloadDepartments();
      toast("部門を削除しました");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="部門"
        note={`使うかどうかは任意です。店舗・事業の種類などを部門にして仕訳の明細に付けると、残高試算表の「部門別」で部門ごとの損益を見られます（決算書・申告書は全部まとめて1枚のままです）。部門の無い明細（家賃など共通の経費）は「共通」になります。チェックを外した部門は入力候補に出なくなります。${strict ? "変更はすべて履歴に記録されます。" : ""}`}
      >
        <button className="btn primary" onClick={() => setEditing("new")} disabled={!mayEdit}><Plus size={16} /> 部門を追加</button>
      </PageHeader>

      <section className="sheet sheet-fill">
        <div className="table-wrap scroll-y">
          {departments.length === 0 ? (
            <p className="empty-note">
              まだ部門がありません。部門を1つ作ると、帳簿入力・振替伝票・明細の取り込みなどに部門の欄が出ます（行に1つ選び、借方・貸方の両方に付きます）。
            </p>
          ) : (
            <table className="ledger">
              <colgroup>
                <col style={{ width: 52 }} /><col style={{ width: 72 }} /><col /><col style={{ width: "14%" }} /><col style={{ width: "16%" }} />
                <col style={{ width: 56 }} /><col style={{ width: 128 }} />
              </colgroup>
              <thead>
                <tr><th>使う</th><th>コード</th><th>部門名</th><th>よみ</th><th>メモ</th><th className="num">使用</th><th /></tr>
              </thead>
              <tbody>
                {departments.map((d) => (
                  <tr key={d.id} className={d.is_active ? "" : "inactive"}>
                    <td><input type="checkbox" checked={!!d.is_active} onChange={(e) => toggle(d, e.target.checked)} disabled={!mayEdit} aria-label={`${d.name}を使う`} /></td>
                    <td className="mono muted">{d.code}</td>
                    <td>{d.name}</td>
                    <td className="muted">{d.kana}</td>
                    <td className="muted ellipsis" title={d.memo}>{d.memo}</td>
                    <td className="num muted">{usage.get(d.id) ?? ""}</td>
                    <td className="row-actions">
                      {mayEdit && <button className="link-btn" onClick={() => setEditing(d)}><Pencil size={14} /> 編集</button>}
                      {mayEdit && !usage.get(d.id) && <button className="link-btn danger" onClick={() => remove(d)}><Trash2 size={14} /> 削除</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {editing && <DepartmentForm target={editing} onClose={() => setEditing(null)} />}
    </div>
  );
};

const DepartmentForm = ({ target, onClose }: { target: Department | "new"; onClose: () => void }) => {
  const { db, departments, reloadDepartments } = useAppContext();
  const toast = useToast();
  const isNew = target === "new";
  const [d, setD] = useState<DepartmentInput>(isNew ? { code: "", name: "", kana: "", memo: "" } : { code: target.code, name: target.name, kana: target.kana, memo: target.memo });
  const [error, setError] = useState("");
  const set = <K extends keyof DepartmentInput>(k: K, v: DepartmentInput[K]) => setD((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    const err = validateDepartment(departments, d, isNew ? undefined : target.id);
    if (err) return setError(err);
    try {
      if (isNew) await repo.createDepartment(db, d);
      else await repo.updateDepartment(db, target.id, d);
      await reloadDepartments();
      toast(isNew ? "部門を追加しました" : "部門を更新しました");
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <Modal title={isNew ? "部門の追加" : "部門の編集"} onClose={onClose} width={520}>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field-row">
          <label className="field" style={{ maxWidth: 120 }}>
            <span>コード（任意）</span>
            <input className="input mono" value={d.code} onChange={(e) => set("code", e.target.value)} maxLength={10} placeholder="例：01" />
          </label>
          <label className="field">
            <span>部門名</span>
            <input className="input" value={d.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={30} placeholder="例：本店、キッチンカー" />
          </label>
        </div>
        <p className="field-note">コードは並び順です（入力の候補・部門別の表の列の順。空ならコードのある部門のあと、名前の順）。</p>
        <label className="field">
          <span>よみ（任意）</span>
          <input className="input" value={d.kana} onChange={(e) => set("kana", e.target.value)} maxLength={30} />
        </label>
        <label className="field">
          <span>メモ（任意）</span>
          <input className="input" value={d.memo} onChange={(e) => set("memo", e.target.value)} maxLength={200} />
        </label>
        {!isNew && <p className="field-note">名前を変えると、過去の仕訳の部門の表示も新しい名前になります（履歴の写しには記録した時点の名前が残ります）。</p>}
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="voucher-actions">
          <div className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>やめる</button>
          <button className="btn primary" type="submit">{isNew ? "追加する" : "保存する"}</button>
        </div>
      </form>
    </Modal>
  );
};
