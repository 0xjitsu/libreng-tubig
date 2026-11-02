// Minimal OSM opening_hours evaluator. Returns true/false when the value is simple enough to parse
// (e.g. "24/7", "Mo-Sa 08:00-17:00; Su off"), otherwise null (unknown). Evaluated in Manila time.
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function manilaNow(now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

function parseDays(s: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return null;
    const a = DAYS.indexOf(m[1]);
    const b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let i = a; ; i = (i + 1) % 7) {
      out.add(i);
      if (i === b) break;
    }
  }
  return out;
}

function parseTimes(s: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of s.split(',')) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(part.trim());
    if (!m) return null;
    out.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
  }
  return out;
}

export function isOpenNow(value: string | undefined, now = new Date()): boolean | null {
  if (!value) return null;
  const v = value.trim();
  if (v === '24/7') return true;
  const { day, minutes } = manilaNow(now);
  let result = false;
  for (const rule of v.split(';')) {
    const r = rule.trim();
    if (!r) continue;
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/.exec(r);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const rest = m[2].trim();
    let ranges: [number, number][];
    if (rest === 'off' || rest === 'closed') ranges = [];
    else if (rest === '' || rest === 'open') ranges = [[0, 1440]];
    else {
      const t = parseTimes(rest);
      if (!t) return null;
      ranges = t;
    }
    const prev = (day + 6) % 7;
    let today = false;
    let spill = false;
    for (const [s, e] of ranges) {
      if (e > s) {
        if (minutes >= s && minutes < e) today = true;
      } else {
        // overnight range, e.g. 22:00-02:00
        if (minutes >= s) today = true;
        if (minutes < e && days.has(prev)) spill = true;
      }
    }
    // Later rules override earlier ones for the days they cover.
    if (days.has(day)) result = today;
    if (spill) result = true;
  }
  // If no rule covered today, treat as closed only when we parsed everything successfully.
  return result;
}
