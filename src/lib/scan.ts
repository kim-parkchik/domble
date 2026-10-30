/**
 * スキャナ保存（純粋関数）
 * 紙で受け取った書類をスキャナ（スマートフォンのカメラを含む）で読み取って保存するときの要件の確認。
 * 令和6年1月1日以後の要件にそって、次を確かめる
 *  - 入力期間：受け取ってからの期限（早期入力方式：おおむね7営業日／業務処理サイクル方式：最長2か月＋おおむね7営業日）
 *  - 画質：解像度 200dpi 以上（dpi が書かれていない・200 未満なら画素数で判断：A4 なら 2,338×1,654 画素以上）、
 *          重要書類はカラー（赤・緑・青 各256階調以上）、一般書類はグレースケールでもよい
 *  - 帳簿との相互関連性：重要書類だけ（仕訳とひも付ける）
 * タイムスタンプ：domble は付けない。登録日時は利用者の PC の時計なので、「入力期間内に保存したことを確認できる」こと（タイムスタンプに代える措置）にもならない
 * （一問一答〔スキャナ保存〕問21・31・32：保存日時を他者が客観的に担保する仕組みでなければ代えられない）。
 * そのため、スキャナ保存した書類も紙の原本を保存してもらう（SCAN_KEEP_PAPER）。入力期間・画質の確かめは参考（認定タイムスタンプを足すときに要る）
 * 営業日は土日と、渡された休みの日（祝日・事業者の休業日。lib/holidays.ts）を除いて数える
 */

/** スキャナ保存の書類には、いつも添える知らせ */
export const SCAN_KEEP_PAPER = "domble はタイムスタンプを付けないため、スキャナ保存の要件を満たしません。読み取って取り込んだ書類も、紙の原本を保存してください";

/** 書類の区分：重要書類（契約書・領収書・請求書・納品書など、お金や物の流れに直結するもの）／一般書類（見積書・注文書など） */
export type DocClass = "important" | "general";
export const DOC_CLASS_LABEL: Record<DocClass, string> = { important: "重要書類", general: "一般書類" };

/** 書類の種類から決める区分の初期値 */
export const docClassOf = (docType: string): DocClass => (["見積書", "注文書"].includes(docType) ? "general" : "important");

/** 入力期間の方式 */
export type ScanInputMethod = "early" | "cycle";
export const SCAN_METHOD_LABEL: Record<ScanInputMethod, string> = {
  early: "早期入力方式（受け取ってからおおむね7営業日以内）",
  cycle: "業務処理サイクル方式（最長2か月＋おおむね7営業日以内）",
};

const toDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** 休みの日（祝日・休業日）の集まり。YYYY-MM-DD */
export type DaysOff = ReadonlySet<string>;
const NO_DAYS_OFF: DaysOff = new Set();

/** 営業日か（土日・休みの日でない） */
export const isBusinessDay = (iso: string, daysOff: DaysOff = NO_DAYS_OFF) => !isWeekend(toDate(iso)) && !daysOff.has(iso.slice(0, 10));

/** その日から n 営業日あと（土日・休みの日を除く） */
export const addBusinessDays = (iso: string, n: number, daysOff: DaysOff = NO_DAYS_OFF) => {
  const d = toDate(iso);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d) && !daysOff.has(toIso(d))) left--;
  }
  return toIso(d);
};

/** from の翌日から to までの営業日の数（to が from 以前なら 0） */
export const businessDaysBetween = (from: string, to: string, daysOff: DaysOff = NO_DAYS_OFF) => {
  let n = 0;
  const d = toDate(from);
  const end = to.slice(0, 10);
  while (toIso(d) < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d) && !daysOff.has(toIso(d))) n++;
  }
  return n;
};

/** その日から n か月あと（月末を越えるときはその月の末日） */
export const addMonths = (iso: string, n: number) => {
  const d = toDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toIso(d);
};

/** 入力期限（この日までに取り込めば期間内） */
export const scanDeadline = (receivedDate: string, method: ScanInputMethod, daysOff: DaysOff = NO_DAYS_OFF) =>
  method === "early" ? addBusinessDays(receivedDate, 7, daysOff) : addBusinessDays(addMonths(receivedDate, 2), 7, daysOff);

/** 入力期間内に取り込んだか（registeredAt は登録日時。日付部分だけ見る） */
export const withinScanPeriod = (receivedDate: string, registeredAt: string, method: ScanInputMethod, daysOff: DaysOff = NO_DAYS_OFF) =>
  registeredAt.slice(0, 10) <= scanDeadline(receivedDate, method, daysOff);

// ────────────────────────────────────────────
// 画像の中身から、大きさ・解像度・色を読む（JPEG・PNG）。読めなければ null
// ────────────────────────────────────────────
export interface ImageInfo {
  format: "jpeg" | "png";
  width: number;
  height: number;
  /** 解像度（dpi）。ファイルに書かれていなければ null */
  dpi: number | null;
  /** color：カラー（各色8ビット以上）／gray：グレースケール／palette：色数の限られた画像 */
  color: "color" | "gray" | "palette";
  /** 1色あたりのビット数 */
  bits: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

const readJpeg = (b: Uint8Array): ImageInfo | null => {
  let i = 2;
  let dpi: number | null = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    // APP0（JFIF）：解像度。単位 1 = dpi、2 = dpcm
    if (marker === 0xe0 && b[i + 4] === 0x4a && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
      const unit = b[i + 11];
      const x = u16be(b, i + 12);
      if (unit === 1 && x > 1) dpi = x;
      if (unit === 2 && x > 1) dpi = Math.round(x * 2.54);
    }
    // SOF（大きさ・色の数）
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const bits = b[i + 4];
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      const comps = b[i + 9];
      return { format: "jpeg", width, height, dpi, color: comps >= 3 ? "color" : "gray", bits };
    }
    i += 2 + len;
  }
  return null;
};

const readPng = (b: Uint8Array): ImageInfo | null => {
  if (b.length < 33) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const bits = b[24];
  const type = b[25];
  let dpi: number | null = null;
  // pHYs：1メートルあたりの画素数（単位 1 = メートル）
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const name = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (name === "pHYs" && b[i + 16] === 1) dpi = Math.round(u32be(b, i + 8) * 0.0254);
    if (name === "IDAT" || name === "IEND") break;
    i += 12 + len;
  }
  const color = type === 2 || type === 6 ? "color" : type === 3 ? "palette" : "gray";
  return { format: "png", width, height, dpi, color, bits };
};

export const readImageInfo = (bytes: Uint8Array): ImageInfo | null => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return readPng(bytes);
  return null;
};

/** A4 を 200dpi で読み取ったときの長い辺・短い辺の画素数（国税庁 一問一答（スキャナ保存）問26） */
export const A4_200DPI_SIDES = { long: 2_338, short: 1_654 };

export interface QualityCheck {
  /** auto：ファイルの中身で確かめた／declared：自己申告（中身を読めない形式） */
  method: "auto" | "declared";
  ok: boolean;
  problems: string[];
  info: ImageInfo | null;
}

/**
 * 画質の確認。JPEG・PNG は中身で確かめる。それ以外（PDF・HEIC など）は自己申告（declared）に頼る
 *  - 解像度：200dpi 以上と書かれているか、画素数が A4 の 200dpi 相当（長い辺 2,338・短い辺 1,654 画素）以上
 *  - 色：重要書類は各色8ビット以上のカラー。一般書類はグレースケール（8ビット以上）でもよい
 */
export const checkScanQuality = (bytes: Uint8Array, docClass: DocClass, declared: boolean): QualityCheck => {
  const info = readImageInfo(bytes);
  if (!info) {
    return {
      method: "declared", ok: declared, info: null,
      problems: declared ? [] : ["この形式は画質を自動で確かめられません。200dpi 以上・カラー（一般書類はグレースケール可）で読み取ったことを確認してください"],
    };
  }
  const problems: string[] = [];
  // 200dpi 以上と書かれていれば足りる。書かれていない・200 未満（写真の 72dpi など、画像の解像度を表さないことが多い）なら、
  // 画素数を A4 の 200dpi 相当（長い辺 2,338・短い辺 1,654 画素。それぞれを満たす）で確かめる（一問一答（スキャナ保存）問26）
  const [long, short] = [Math.max(info.width, info.height), Math.min(info.width, info.height)];
  const sidesOk = long >= A4_200DPI_SIDES.long && short >= A4_200DPI_SIDES.short;
  if (!(info.dpi !== null && info.dpi >= 200) && !sidesOk) {
    problems.push(
      `${info.dpi !== null ? `解像度が ${info.dpi}dpi で、` : ""}画素数が ${long.toLocaleString()}×${short.toLocaleString()} です`
        + "（A4 の書類なら 200dpi 相当の 2,338×1,654 画素以上が必要）",
    );
  }
  if (docClass === "important" && (info.color !== "color" || info.bits < 8)) {
    problems.push("重要書類はカラー（赤・緑・青 各256階調以上）で読み取る必要があります");
  }
  if (docClass === "general" && info.bits < 8) problems.push("256階調以上で読み取る必要があります");
  return { method: "auto", ok: problems.length === 0, problems, info };
};

/** スキャナ保存の証憑の状態（一覧・詳しく見る画面・CSV で使う） */
export interface ScanStatus {
  deadline: string;
  /** 入力期間外に取り込んだ（要件を満たさない。紙の原本も保存する） */
  late: boolean;
  /** 重要書類なのに仕訳とひも付いていない（帳簿との相互関連性） */
  needsLink: boolean;
  /** 取り込んだときの画質の確認 */
  quality: { method: "auto" | "declared"; info: ImageInfo | null } | null;
}

export const scanStatusOf = (
  e: { kind: string; received_date?: string; registered_at: string; doc_class?: string; entry_ids: number[]; scan_info: string },
  method: ScanInputMethod,
  daysOff: DaysOff = NO_DAYS_OFF,
): ScanStatus | null => {
  if (e.kind !== "scan" || !e.received_date) return null;
  const deadline = scanDeadline(e.received_date, method, daysOff);
  let quality: ScanStatus["quality"] = null;
  try {
    quality = e.scan_info ? JSON.parse(e.scan_info) : null;
  } catch {
    quality = null;
  }
  return {
    deadline,
    late: e.registered_at.slice(0, 10) > deadline,
    needsLink: e.doc_class === "important" && e.entry_ids.length === 0,
    quality,
  };
};

/** 画質の表示（例：200dpi・カラー） */
export const qualityLabel = (q: ScanStatus["quality"]) => {
  if (!q) return "";
  if (q.method === "declared" || !q.info) return "自己申告（200dpi 以上で読み取り）";
  const res = q.info.dpi ? `${q.info.dpi}dpi` : `${Math.round((q.info.width * q.info.height) / 10000)}万画素`;
  return `${res}・${q.info.color === "color" ? "カラー" : "グレースケール"}`;
};
