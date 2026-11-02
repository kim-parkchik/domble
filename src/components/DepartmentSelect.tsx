/**
 * 部門を選ぶ欄（帳簿入力・振替伝票・明細のルールなど。lib/departments.ts）
 *  - 空 = 共通（部門なし）。非表示の部門は、いま選ばれているときだけ出す
 *  - mixed = 借方と貸方で違う部門（CSV で取り込んだ仕訳など）。選び直すまでそのまま持つ
 */
import type { KeyboardEvent } from "react";
import { useAppContext } from "../context/AppContext";
import { MIXED } from "../lib/departments";

export const DepartmentSelect = ({ value, onChange, label, onKeyDown, disabled, className = "input dept-select" }: {
  value: number | null | typeof MIXED;
  onChange: (v: number | null) => void;
  label: string;
  onKeyDown?: (e: KeyboardEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  className?: string;
}) => {
  const { departments } = useAppContext();
  const shown = departments.filter((d) => d.is_active || d.id === value);
  return (
    <select
      className={`${className}${value ? "" : " is-default"}`} value={value === null ? "" : String(value)}
      onChange={(e) => e.target.value !== MIXED && onChange(e.target.value ? Number(e.target.value) : null)}
      onKeyDown={onKeyDown} aria-label={label} disabled={disabled}
      title={value === MIXED ? "借方と貸方で部門が違います。選ぶと両方をその部門にします" : undefined}
    >
      <option value="">共通</option>
      {value === MIXED && <option value={MIXED}>借方と貸方で違う</option>}
      {shown.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_active ? "" : "（非表示）"}</option>)}
    </select>
  );
};
