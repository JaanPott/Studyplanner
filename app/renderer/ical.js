/* Small iCalendar (.ics) reader: events, recurring events (RRULE / EXDATE / moved or cancelled
   instances) and time zones. Exposes ICal.parse(text) and ICal.expand(events, from, to).

   Date-times are kept as "wall" values: the clock reading as written in the file, stored as
   milliseconds with UTC fields so date arithmetic never trips over daylight-saving changes.
   They become real instants only at the end, using the zone they were written in. */
(function (root) {
  const DAY = 864e5;
  const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /* ---------- Reading the file ---------- */

  // NAME;PARAM=a;PARAM="b:c":value – the value starts at the first colon outside quotes
  function parseLine(line) {
    let i = 0, quoted = false;
    for (; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ':' && !quoted) break;
    }
    const [name, ...rest] = line.slice(0, i).split(';');
    const params = {};
    for (const p of rest) {
      const j = p.indexOf('=');
      if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
    }
    return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
  }

  const unescapeText = s => s.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));

  // Google stores descriptions typed in its web UI as HTML
  function htmlToText(s) {
    if (!/<\/?[a-z][^>]*>/i.test(s)) return s;
    return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  // { wall, allDay, tz } – tz is 'UTC', a zone name like 'Europe/Tallinn', or null for local time
  function parseDate(value, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    return {
      wall: Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)),
      allDay: !m[4] || params.VALUE === 'DATE',
      tz: m[7] ? 'UTC' : params.TZID || null,
    };
  }

  function parseDuration(value) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
    if (!m) return null;
    const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 * 3600 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
  }

  function parse(text) {
    const events = [];
    let cur = null, nested = 0;
    // Long lines are folded onto continuation lines that start with a space or tab
    for (const line of String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
      if (!line) continue;
      const { name, params, value } = parseLine(line);
      const kind = value.toUpperCase();
      if (name === 'BEGIN' && kind === 'VEVENT' && !cur) { cur = { exdates: [] }; continue; }
      if (name === 'END' && kind === 'VEVENT' && cur && !nested) {
        if (cur.start) events.push(cur);
        cur = null;
        continue;
      }
      if (!cur) continue;
      // Skip components inside an event (reminders have a DESCRIPTION of their own)
      if (name === 'BEGIN') { nested++; continue; }
      if (name === 'END') { nested--; continue; }
      if (nested) continue;
      switch (name) {
        case 'UID': cur.uid = value; break;
        case 'SUMMARY': cur.title = unescapeText(value).trim(); break;
        case 'DESCRIPTION': cur.description = htmlToText(unescapeText(value)).trim(); break;
        case 'DTSTART': cur.start = parseDate(value, params); break;
        case 'DTEND': cur.end = parseDate(value, params); break;
        case 'DURATION': cur.duration = parseDuration(value); break;
        case 'RECURRENCE-ID': cur.recurrenceId = parseDate(value, params); break;
        case 'STATUS': cur.status = kind; break;
        case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map(kv => kv.split('='))); break;
        case 'EXDATE': value.split(',').forEach(v => { const d = parseDate(v, params); if (d) cur.exdates.push(d); }); break;
      }
    }
    return events;
  }

  /* ---------- Time zones ---------- */

  const formatters = {};
  // Minutes the zone is ahead of UTC at the given instant
  function offsetAt(tz, instant) {
    const f = formatters[tz] ||= new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const p = Object.fromEntries(f.formatToParts(instant).map(x => [x.type, +x.value]));
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(instant / 1000) * 1000) / 6e4;
  }

  function toInstant(wall, tz) {
    if (tz === 'UTC') return wall;
    if (tz) {
      try {
        // Guess with the offset at the wall time, then correct once in case that crossed a DST change
        const guess = wall - offsetAt(tz, wall) * 6e4;
        return wall - offsetAt(tz, guess) * 6e4;
      } catch (e) { /* unknown zone name (e.g. Outlook's Windows names): use local time */ }
    }
    const d = new Date(wall);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
  }

  const instantOf = d => toInstant(d.wall, d.allDay ? null : d.tz);

  /* ---------- Recurrence ---------- */

  // Days of month y/m picked by BYDAY (e.g. MO, 2TU, -1FR) and/or BYMONTHDAY, else the start's day
  function monthDays(y, m, byDay, byMonthDay, startDom) {
    const len = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const fromEnd = md => (md > 0 ? md : len + 1 + md);
    let days;
    if (byDay) {
      days = [];
      for (const b of byDay) {
        const all = [];
        for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === b.wd) all.push(d);
        if (!b.n) days.push(...all);
        else { const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (d) days.push(d); }
      }
      if (byMonthDay) days = days.filter(d => byMonthDay.some(md => fromEnd(md) === d));
    } else if (byMonthDay) {
      days = byMonthDay.map(fromEnd).filter(d => d >= 1 && d <= len);
    } else {
      days = startDom <= len ? [startDom] : [];
    }
    return [...new Set(days)].sort((a, b) => a - b).map(d => Date.UTC(y, m, d));
  }

  // Wall start times of every occurrence from DTSTART up to `limit` (a wall value)
  function* occurrences(start, rule, limit) {
    const interval = Math.max(1, +rule.INTERVAL || 1);
    const count = rule.COUNT ? +rule.COUNT : Infinity;
    const until = rule.UNTIL ? (parseDate(rule.UNTIL, {}) || { wall: Infinity }).wall : Infinity;
    const end = Math.min(limit, until);
    const list = (s, f) => (s ? s.split(',').map(f).filter(x => x != null) : null);
    const byDay = list(rule.BYDAY, x => {
      const m = /^([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
      return m ? { n: m[1] ? +m[1] : 0, wd: WEEKDAYS[m[2]] } : null;
    });
    const byMonthDay = list(rule.BYMONTHDAY, Number);
    const byMonth = list(rule.BYMONTH, x => +x - 1);
    const wkst = WEEKDAYS[rule.WKST] ?? 1;

    const time = start.wall % DAY;
    const startDay = start.wall - time;
    const s = new Date(startDay);
    const sy = s.getUTCFullYear(), sm = s.getUTCMonth(), sd = s.getUTCDate(), swd = s.getUTCDay();
    const weekStart = startDay - ((swd - wkst + 7) % 7) * DAY;

    let n = 0;
    for (let period = 0; period < 100000; period++) {
      let first, days;
      switch (rule.FREQ) {
        case 'DAILY':
          first = startDay + period * interval * DAY;
          days = [first];
          break;
        case 'WEEKLY':
          first = weekStart + period * interval * 7 * DAY;
          days = (byDay ? byDay.map(b => b.wd) : [swd]).map(wd => first + ((wd - wkst + 7) % 7) * DAY).sort((a, b) => a - b);
          break;
        case 'MONTHLY': {
          const t = sm + period * interval;
          first = Date.UTC(sy + Math.floor(t / 12), t % 12, 1);
          days = monthDays(sy + Math.floor(t / 12), t % 12, byDay, byMonthDay, sd);
          break;
        }
        case 'YEARLY': {
          const y = sy + period * interval;
          first = Date.UTC(y, 0, 1);
          days = (byMonth || [sm]).flatMap(m => monthDays(y, m, byMonth && byDay, byMonthDay, sd));
          break;
        }
        default:
          yield start.wall; // unsupported rule: keep at least the first occurrence
          return;
      }
      if (first > end) return;
      for (const day of days) {
        const wd = new Date(day).getUTCDay();
        if (rule.FREQ === 'DAILY' && byDay && !byDay.some(b => b.wd === wd)) continue;
        if (byMonth && !byMonth.includes(new Date(day).getUTCMonth())) continue;
        const w = day + time;
        if (w < start.wall) continue;
        if (w > end || n >= count) return;
        n++;
        yield w;
      }
    }
  }

  /* ---------- Expanding into dated occurrences ---------- */

  function eventLength(ev) {
    if (ev.end) return ev.start.allDay ? ev.end.wall - ev.start.wall : instantOf(ev.end) - instantOf(ev.start);
    if (ev.duration != null) return ev.duration;
    return ev.start.allDay ? DAY : 0;
  }

  const wallDate = wall => new Date(wall).toISOString().slice(0, 10);

  // Every occurrence overlapping [from, to), sorted by start. `key` stays the same across syncs:
  // the UID, plus the original date for instances of a recurring event.
  function expand(events, from, to) {
    const fromT = +from, toT = +to;
    const out = [];
    const push = (ev, wall, key) => {
      const len = eventLength(ev);
      const allDay = ev.start.allDay;
      const start = toInstant(wall, allDay ? null : ev.start.tz);
      const end = allDay ? toInstant(wall + len, null) : start + len;
      if (start < toT && Math.max(end, start + 1) > fromT) {
        out.push({ key, uid: ev.uid, title: ev.title || '', description: ev.description || '',
                   allDay, start: new Date(start), end: new Date(end) });
      }
    };

    // Moved or cancelled instances of recurring events, by UID and original start
    const overrides = {};
    for (const ev of events) {
      if (ev.recurrenceId) (overrides[ev.uid] ||= {})[instantOf(ev.recurrenceId)] = ev;
    }

    for (const ev of events) {
      if (ev.recurrenceId || ev.status === 'CANCELLED') continue;
      const uid = ev.uid || `${ev.title}|${ev.start.wall}`;
      if (!ev.rrule) { push(ev, ev.start.wall, uid); continue; }
      const skip = new Set(ev.exdates.map(instantOf));
      const moved = overrides[ev.uid] || {};
      // Wall and real time differ by at most a day, so this limit is safely past `to`
      for (const wall of occurrences(ev.start, ev.rrule, toT + 2 * DAY)) {
        const t = toInstant(wall, ev.start.allDay ? null : ev.start.tz);
        if (skip.has(t)) continue;
        const key = uid + '|' + wallDate(wall);
        const o = moved[t];
        if (!o) push(ev, wall, key);
        else if (o.status !== 'CANCELLED') push(o, o.start.wall, key);
      }
    }
    return out.sort((a, b) => a.start - b.start || b.allDay - a.allDay);
  }

  const ICal = { parse, expand };
  if (typeof module !== 'undefined' && module.exports) module.exports = ICal;
  else root.ICal = ICal;
})(this);
