/**
 * When is a schedule next due?
 *
 * Pure arithmetic, no SQL: the same answer is needed by the Due tab, the thing
 * page, the Today screen and the MCP connector, and computing it in one place means
 * it cannot drift. Nothing about "next due" is stored — it is derived every time
 * from the rule, when it was last done, and the latest reading, so it can never be
 * a stale date sitting in a column.
 *
 * A schedule is a rule on a thing, the way an alarm setpoint is a rule on a tag:
 *   every_days     every N days since last done
 *   every_value    every N of a metric (odo, hours) since last done
 *   fixed_month/day  once a year on that date
 * Both of the first two set means whichever comes first — a service interval.
 */

export interface ScheduleRule {
  every_days: number | null;
  every_value: number | null;
  metric: string | null;
  fixed_month: number | null;
  fixed_day: number | null;
  last_done_at: number | null;
  last_value: number | null;
  created_at: number;
}

/** The readings the value side needs: the latest, and an older one to get a rate. */
export interface MetricStats {
  latest: { value: number; at: number } | null;
  earliest: { value: number; at: number } | null;
}

export interface NextDue {
  /** Best estimate of when, epoch ms. Null only when nothing can be computed. */
  when: number | null;
  /** The date side alone, if the rule has one. */
  by_date: number | null;
  /** The value side alone, if the rule has one: due at this reading. */
  by_value: { at: number; now: number | null; left: number | null; unit_less: true } | null;
  /** 0..1 how far through the interval; the bars are drawn from this. */
  progress: number;
  /** Negative when overdue. */
  days_left: number | null;
}

const DAY = 86_400_000;

export function nextDue(s: ScheduleRule, stats: MetricStats | null, now = Date.now()): NextDue {
  const anchor = s.last_done_at ?? s.created_at;

  let byDate: number | null = null;
  if (s.fixed_month && s.fixed_day) {
    // Next occurrence of that calendar day, in the caller's local sense of "year"
    // — good enough: a sprinkler blow-out is due on 1 November, not at a moment.
    const d = new Date(now);
    let cand = new Date(d.getFullYear(), s.fixed_month - 1, s.fixed_day, 9).getTime();
    // Already done this year → next year.
    if (s.last_done_at && s.last_done_at >= cand - 30 * DAY && s.last_done_at <= cand + 30 * DAY) {
      cand = new Date(d.getFullYear() + 1, s.fixed_month - 1, s.fixed_day, 9).getTime();
    } else if (cand < now - 60 * DAY) {
      cand = new Date(d.getFullYear() + 1, s.fixed_month - 1, s.fixed_day, 9).getTime();
    }
    byDate = cand;
  } else if (s.every_days) {
    byDate = anchor + s.every_days * DAY;
  }

  let byValue: NextDue["by_value"] = null;
  let byValueWhen: number | null = null;
  if (s.every_value && s.metric) {
    const base = s.last_value ?? stats?.earliest?.value ?? null;
    if (base != null) {
      const at = base + s.every_value;
      const nowV = stats?.latest?.value ?? null;
      byValue = { at, now: nowV, left: nowV == null ? null : at - nowV, unit_less: true };
      // Estimate the date from the observed rate, if there are two readings.
      if (stats?.latest && stats.earliest && stats.latest.at > stats.earliest.at &&
          stats.latest.value > stats.earliest.value) {
        const perMs = (stats.latest.value - stats.earliest.value) / (stats.latest.at - stats.earliest.at);
        byValueWhen = stats.latest.at + (at - stats.latest.value) / perMs;
      }
    }
  }

  const candidates = [byDate, byValueWhen].filter((x): x is number => x != null);
  const when = candidates.length ? Math.min(...candidates) : null;

  // Progress: the further-along of the two sides.
  let progress = 0;
  if (byDate != null) {
    const span = s.fixed_month ? 365 * DAY : (s.every_days ?? 1) * DAY;
    progress = Math.max(progress, Math.min(1, Math.max(0, 1 - (byDate - now) / span)));
  }
  if (byValue && byValue.now != null && s.every_value) {
    const base = byValue.at - s.every_value;
    progress = Math.max(progress, Math.min(1, Math.max(0, (byValue.now - base) / s.every_value)));
  }

  return {
    when,
    by_date: byDate,
    by_value: byValue,
    progress,
    days_left: when == null ? null : Math.floor((when - now) / DAY),
  };
}
