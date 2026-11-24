// Timestamps and days, as learn/store.py handles them.
//
// Log timestamps are ISO 8601 with their own UTC offset
// ("2026-11-20T17:20:59+00:00"). The epoch comes from the instant. The *day*
// an answer counts towards comes from the wall-clock time as written, 4 hours
// earlier, so a day starts at 4 a.m. in whatever offset the entry was written
// with (store.day_of).

export const DAY_STARTS_HOUR = 4;

// YYYY-MM-DD, then T or a space, HH:MM[:SS[.fraction]], then Z or +-HH:MM.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))?)?$/;

/** The parts of a timestamp; ``offsetMinutes`` is null when it has none. */
export function parseTs(ts) {
  const m = ISO.exec(ts);
  if (!m) throw new Error(`not an ISO timestamp: '${ts}'`);
  const [, y, mo, d, h, mi, s, frac, z, sign, oh, om] = m;
  let offsetMinutes = null;
  if (z) offsetMinutes = 0;
  else if (sign) offsetMinutes = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  return {
    y: Number(y), mo: Number(mo), d: Number(d),
    h: Number(h || 0), mi: Number(mi || 0), s: Number(s || 0),
    micro: Number(((frac || '') + '000000').slice(0, 6)),
    offsetMinutes,
  };
}

/** Seconds since the epoch. A timestamp without an offset is local time. */
export function epoch(ts) {
  const t = parseTs(ts);
  if (t.offsetMinutes === null) {
    return new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s).getTime() / 1000 + t.micro / 1e6;
  }
  const micros = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) * 1000 + t.micro - t.offsetMinutes * 60e6;
  return micros / 1e6;
}

/** The day (YYYY-MM-DD) an entry counts towards: its wall-clock date 4 hours
 * earlier. */
export function dayOf(ts) {
  const t = parseTs(ts);
  return new Date(Date.UTC(t.y, t.mo - 1, t.d, t.h - DAY_STARTS_HOUR, t.mi, t.s)).toISOString().slice(0, 10);
}

function two(n) {
  return String(n).padStart(2, '0');
}

/** Now as the log writes it: local time to the second, with the local offset. */
export function nowTs(date = new Date()) {
  const off = -date.getTimezoneOffset();
  const a = Math.abs(off);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
    + `${off < 0 ? '-' : '+'}${two(Math.floor(a / 60))}:${two(a % 60)}`;
}

/** Today's day on this device's clock. */
export function today(date = new Date()) {
  return dayOf(nowTs(date));
}

/** Now in seconds since the epoch. */
export function nowEpoch(date = new Date()) {
  return date.getTime() / 1000;
}
