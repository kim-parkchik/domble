import { describe, expect, test } from "bun:test";
import { addBusinessDays, addMonths, businessDaysBetween, checkScanQuality, docClassOf, readImageInfo, scanDeadline, withinScanPeriod } from "./scan";

/** JPEG の頭だけ（SOI・JFIF・SOF0）。中身の画像データは無くてよい */
const jpeg = (o: { width: number; height: number; comps: number; dpi?: number }) => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, o.dpi ? 1 : 0, (o.dpi ?? 1) >> 8, (o.dpi ?? 1) & 255, (o.dpi ?? 1) >> 8, (o.dpi ?? 1) & 255, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * o.comps, 8, o.height >> 8, o.height & 255, o.width >> 8, o.width & 255, o.comps, ...Array(3 * o.comps).fill(1)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
};

/** PNG の頭だけ（署名・IHDR・pHYs） */
const png = (o: { width: number; height: number; type: number; bits?: number; dpi?: number }) => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (name: string, data: number[]) => [...be32(data.length), ...[...name].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const ihdr = chunk("IHDR", [...be32(o.width), ...be32(o.height), o.bits ?? 8, o.type, 0, 0, 0]);
  const phys = o.dpi ? chunk("pHYs", [...be32(Math.round(o.dpi / 0.0254)), ...be32(Math.round(o.dpi / 0.0254)), 1]) : [];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...phys, ...chunk("IEND", [])]);
};

describe("入力期限", () => {
  test("営業日は土日を除いて数える", () => {
    expect(addBusinessDays("2026-10-23", 1)).toBe("2026-10-26"); // 金 → 月
    expect(addBusinessDays("2026-10-19", 7)).toBe("2026-10-28"); // 月 → 翌週水
  });

  test("月を足す（月末は丸める）", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-15", 2)).toBe("2026-12-15");
  });

  test("早期入力方式は7営業日、業務処理サイクル方式は2か月＋7営業日", () => {
    expect(scanDeadline("2026-10-19", "early")).toBe("2026-10-28");
    expect(scanDeadline("2026-10-19", "cycle")).toBe(addBusinessDays("2026-12-19", 7));
    // サイクルが1か月なら、1か月後からおおむね7営業日
    expect(scanDeadline("2026-10-19", "cycle1")).toBe(addBusinessDays("2026-11-19", 7));
    expect(withinScanPeriod("2026-10-19", "2026-12-01 09:00:00", "cycle1")).toBe(false);
    expect(withinScanPeriod("2026-10-19", "2026-10-28 23:00:00", "early")).toBe(true);
    expect(withinScanPeriod("2026-10-19", "2026-10-29 09:00:00", "early")).toBe(false);
    expect(withinScanPeriod("2026-10-19", "2026-10-29 09:00:00", "cycle")).toBe(true);
  });

  test("書類の種類から区分の初期値", () => {
    expect(docClassOf("領収書")).toBe("important");
    expect(docClassOf("見積書")).toBe("general");
  });
});

describe("画像の読み取り", () => {
  test("JPEG：大きさ・解像度・色", () => {
    expect(readImageInfo(jpeg({ width: 1654, height: 2339, comps: 3, dpi: 200 }))).toEqual({ format: "jpeg", width: 1654, height: 2339, dpi: 200, color: "color", bits: 8 });
    expect(readImageInfo(jpeg({ width: 100, height: 100, comps: 1 }))!.dpi).toBeNull();
    expect(readImageInfo(jpeg({ width: 100, height: 100, comps: 1 }))!.color).toBe("gray");
  });

  test("PNG：大きさ・解像度・色", () => {
    expect(readImageInfo(png({ width: 2480, height: 3508, type: 2, dpi: 300 }))).toEqual({ format: "png", width: 2480, height: 3508, dpi: 300, color: "color", bits: 8 });
    expect(readImageInfo(png({ width: 10, height: 10, type: 3 }))!.color).toBe("palette");
    expect(readImageInfo(png({ width: 10, height: 10, type: 0 }))!.color).toBe("gray");
  });

  test("PDF などは読めない", () => {
    expect(readImageInfo(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
  });
});

describe("画質の確認", () => {
  test("重要書類：200dpi 以上のカラーなら OK", () => {
    expect(checkScanQuality(jpeg({ width: 1654, height: 2339, comps: 3, dpi: 200 }), "important", false)).toMatchObject({ method: "auto", ok: true });
  });

  test("解像度が足りない・重要書類が白黒なら NG", () => {
    const low = checkScanQuality(jpeg({ width: 800, height: 1100, comps: 3, dpi: 96 }), "important", false);
    expect(low.ok).toBe(false);
    expect(low.problems[0]).toMatch(/96dpi.*1,100×800/);
    expect(checkScanQuality(jpeg({ width: 1654, height: 2339, comps: 1, dpi: 200 }), "important", false).problems.join()).toMatch(/カラー/);
    expect(checkScanQuality(jpeg({ width: 1654, height: 2339, comps: 1, dpi: 200 }), "general", false).ok).toBe(true);
  });

  test("dpi が書かれていない・72dpi と書かれた写真は、画素数を A4 の 200dpi 相当（2,338×1,654）の辺ごとに判断", () => {
    expect(checkScanQuality(jpeg({ width: 3024, height: 4032, comps: 3 }), "important", false).ok).toBe(true); // 約1200万画素
    expect(checkScanQuality(jpeg({ width: 4032, height: 3024, comps: 3, dpi: 72 }), "important", false).ok).toBe(true);
    expect(checkScanQuality(jpeg({ width: 1000, height: 1300, comps: 3 }), "important", false).problems[0]).toMatch(/1,300×1,000/);
    // 総画素数は足りても、短い辺が足りなければ NG
    expect(checkScanQuality(jpeg({ width: 4000, height: 980, comps: 3 }), "important", false).ok).toBe(false);
  });

  test("中身を読めない形式は自己申告", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7");
    expect(checkScanQuality(pdf, "important", false)).toMatchObject({ method: "declared", ok: false });
    expect(checkScanQuality(pdf, "important", true)).toMatchObject({ method: "declared", ok: true });
  });
});

describe("祝日・休業日を除いた営業日", () => {
  const off = new Set(["2026-11-03", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01"]);

  test("祝日（11/3 文化の日）は営業日に数えない", () => {
    expect(addBusinessDays("2026-10-24", 7)).toBe("2026-11-03");
    expect(addBusinessDays("2026-10-24", 7, off)).toBe("2026-11-04");
    expect(scanDeadline("2026-10-24", "early", off)).toBe("2026-11-04");
  });

  test("年末年始の休業日を飛ばす", () => {
    expect(addBusinessDays("2026-12-25", 3, off)).toBe("2027-01-05"); // 金 → 12/28(月)・1/4(月)・1/5(火)
  });

  test("営業日の数", () => {
    expect(businessDaysBetween("2026-10-30", "2026-11-04", off)).toBe(2); // 11/2・11/4（11/3 は祝日）
    expect(businessDaysBetween("2026-11-04", "2026-11-01", off)).toBe(0);
  });
});
