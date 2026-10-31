/**
 * 給与の画面・ホーム・決算整理で使う、源泉所得税の納付の期間（lib/payroll.ts の withholdingPeriods）
 * その年と前の年の期間を出す（前の年の7〜12月分・12月分は、その年の1月が期限のため）。
 * 納付は翌年の仕訳まで見る。前の年の期首の未納（源泉所得税の科目の期首残高）から順に当てる
 */
import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { yearEnd, yearStart, type FlatLine } from "../../lib/accounting";
import { salaryAccountIdsOf, withholdingPeriods, type PayrollSettings, type WithholdingPeriod } from "../../lib/payroll";
import { subKey, type SubOpeningBalances } from "../../lib/types";
import { CODE } from "../../constants/accounts";
import * as repo from "../../db/repo";

/** 給料賃金・専従者給与の科目（事業所得・不動産所得） */
export const SALARY_CODES = [CODE.SALARIES, CODE.FAMILY_SALARY, CODE.RE_SALARIES, CODE.RE_FAMILY_SALARY] as const;

export interface WithholdingData {
  settings: PayrollSettings;
  bonusEntryIds: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  /** 前の年からその翌年までの仕訳 */
  lines: FlatLine[];
  /** その年・前の年の期間 */
  periods: WithholdingPeriod[];
  previous: WithholdingPeriod[];
  /** その年の初めの未納（源泉所得税の科目の期首残高） */
  carried: number;
}

export const useWithholding = (year: number): WithholdingData | null => {
  const { db, accounts, dataVersion } = useAppContext();
  const [raw, setRaw] = useState<{ settings: PayrollSettings; bonusEntryIds: ReadonlySet<number>; holidays: Set<string>; lines: FlatLine[]; opening: SubOpeningBalances; prevOpening: SubOpeningBalances } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      repo.getPayrollSettings(db), repo.getPayrollBonusIds(db), repo.getHolidayData(db), repo.getLines(db, yearStart(year - 1), yearEnd(year + 1)),
      repo.getOpening(db, year), repo.getOpening(db, year - 1),
    ])
      .then(([settings, bonusEntryIds, h, lines, op, prev]) => alive && setRaw({
        settings, bonusEntryIds, holidays: new Set(h.holidays.map((x) => x.date)), lines, opening: op.bySub, prevOpening: prev.bySub,
      }))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [db, year, dataVersion]);
  return useMemo(() => {
    if (!raw) return null;
    const { settings: s } = raw;
    const carriedOf = (o: SubOpeningBalances) => (s.tax ? o[subKey(s.tax.account_id, s.tax.sub_account_id)] ?? 0 : 0);
    const ids = salaryAccountIdsOf(accounts, SALARY_CODES);
    const run = (y: number, carried: number) => (s.tax ? withholdingPeriods(raw.lines, y, ids, s.tax, raw.bonusEntryIds, s.special, raw.holidays, carried) : []);
    return {
      settings: s, bonusEntryIds: raw.bonusEntryIds, holidays: raw.holidays, lines: raw.lines,
      periods: run(year, carriedOf(raw.opening)), previous: run(year - 1, carriedOf(raw.prevOpening)), carried: carriedOf(raw.opening),
    };
  }, [raw, accounts, year]);
};

/** 期間の名前（例：1〜6月分・10月分） */
export const periodLabel = (p: Pick<WithholdingPeriod, "fromMonth" | "toMonth">) => (p.fromMonth === p.toMonth ? `${p.fromMonth}月分` : `${p.fromMonth}〜${p.toMonth}月分`);
