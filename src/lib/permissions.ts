/**
 * ユーザーの権限（純粋関数）
 *  - admin（管理者）：すべて
 *  - editor（入力担当）：日々の入力（仕訳・証憑・取引先・定型仕訳・CSV 取り込み・帳簿入力のタブ）
 *  - viewer（閲覧のみ）：見るだけ
 * 自分のパスワードの変更は、どの権限でもできる（repo.ts の setUserPassword_）
 */
export type Role = "admin" | "editor" | "viewer";

/** 操作の種類 */
export type Perm =
  | "entry"    // 仕訳・証憑・取引先・定型仕訳・CSV 取り込み・帳簿入力のタブ
  | "master"   // 勘定科目・補助科目・期首残高・家事按分の設定
  | "settings" // 事業者設定・年度の締め・繰越・入力期間・バックアップ（世代数・2か所目・戻す）
  | "users";   // ユーザーの追加・名前・権限・非表示

export const ROLES: Role[] = ["admin", "editor", "viewer"];

export const ROLE_LABEL: Record<Role, string> = { admin: "管理者", editor: "入力担当", viewer: "閲覧のみ" };

export const ROLE_NOTE: Record<Role, string> = {
  admin: "すべての操作ができます（事業者設定・締め・繰越・ユーザーの管理を含む）",
  editor: "仕訳・証憑・取引先・定型仕訳などの日々の入力ができます。設定・勘定科目・期首残高・ユーザーの管理はできません",
  viewer: "見ることだけできます。変更はできません",
};

const ALLOWED: Record<Role, Perm[]> = {
  admin: ["entry", "master", "settings", "users"],
  editor: ["entry"],
  viewer: [],
};

export const can = (role: Role | null | undefined, perm: Perm) => !!role && ALLOWED[role].includes(perm);

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export const permissionMessage = (role: Role) => `「${ROLE_LABEL[role]}」の権限では、この操作はできません`;
