/**
 * ボタンを押すと下に開く小さな窓（メニューなど）。外を押すか Esc で閉じる
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** 開くボタンの中身 */
  label: ReactNode;
  /** 開くボタンの説明（読み上げ・マウスを乗せたとき） */
  title: string;
  className?: string;
  /** 窓の中身。close を呼ぶと閉じる */
  children: (close: () => void) => ReactNode;
}

export const Popover = ({ label, title, className = "", children }: Props) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover" ref={ref}>
      <button className={`popover-trigger ${className}`} onClick={() => setOpen((v) => !v)} title={title} aria-expanded={open} aria-haspopup="true">
        {label}
      </button>
      {open && <div className="popover-panel" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
};
