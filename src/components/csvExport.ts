/**
 * CSV をファイルに書き出す（保存先を選んでもらい、結果をトーストで知らせる）
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { toCsv, type CsvValue } from "../lib/csv";

type Toast = (message: string, kind?: "ok" | "error") => void;

export const exportCsvFile = async (defaultPath: string, header: string[], rows: CsvValue[][], toast: Toast) => {
  const path = await save({ defaultPath, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  try {
    await writeTextFile(path, toCsv(header, rows));
    toast("CSV を書き出しました");
  } catch (e) {
    toast(`書き出せませんでした：${String(e)}`, "error");
  }
};
