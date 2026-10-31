/**
 * 申告と納付の期限（純粋関数）
 *  - 所得税の確定申告：翌年3月15日
 *  - 消費税の確定申告（個人事業者）：翌年3月31日
 * 期限が土日・祝日なら次の平日（国税通則法10条2項）
 */

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** その日か、土日・祝日ならそのあとの最初の平日（YYYY-MM-DD） */
export const nextWeekday = (date: string, holidays: ReadonlySet<string>) => {
  const [y, m, d] = date.split("-").map(Number);
  const x = new Date(y, m - 1, d);
  while (x.getDay() === 0 || x.getDay() === 6 || holidays.has(iso(x))) x.setDate(x.getDate() + 1);
  return iso(x);
};

/** その年分の所得税の確定申告の期限 */
export const incomeTaxDeadline = (year: number, holidays: ReadonlySet<string>) => nextWeekday(`${year + 1}-03-15`, holidays);

/** その年分の消費税の確定申告の期限（個人事業者） */
export const consumptionTaxDeadline = (year: number, holidays: ReadonlySet<string>) => nextWeekday(`${year + 1}-03-31`, holidays);

/** today から date までの日数（過ぎていればマイナス） */
export const daysUntil = (today: string, date: string) => {
  const day = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return day(date) - day(today);
};
