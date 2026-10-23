/* Rutina (boards R-*, spec "Rutina"). Markup, CSS and SVG geometry ported from gen/rut.py; every value comes from the owner's data. */
(() => {
  const L = window.HTLogic, h = HT.h, finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const med = (v) => { const s = v.slice().sort((a, b) => a - b), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const clock = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const b18 = (s) => { const m = L.localMinutes(s); return m == null ? null : (m + 360) % 1440; };   // bedtime as minutes after 18:00, so 00:30 sorts after 23:50
  const m6 = (m) => m < 360 ? m + 1440 : m;   // minute of the day on the 06:00 → 06:00 axis
  const SUPP = L.SUPPS.map((c) => c.id), MOOD = L.MOODS.map((m) => m.id);
  const GROUPS = [['caffeine', ['caffeine']], ['cigarettes', ['cigarettes']], ['alcohol', ['alcohol']], ['water', ['water']], ['supp', SUPP]];
  const COUNT = new Set(['caffeine', 'alcohol', ...SUPP]);   // owner ruling 2026-10-23 (#3, #10): one event = one cup, drink or intake in Día a día and A qué horas
  const amt = (e) => COUNT.has(e.k) ? 1 : e.v;
  const within = (d, date, n) => d > L.shiftDate(date, -n) && d <= date;   // the n days ending at date

  /* Reads (R2.6). Events of the 56 days to the date in two health_sql halves of 28 days, one row per tracker:
     ev = "t:value" with t = (day index from date − 55) * 1440 + local minute, first = the tracker's first log ever (R2.9). Nights: 57 rows of v_daily. */
  function rtQueries(date) {
    const s = L.shiftDate(date, -55);
    const ev = (a, b) => "SELECT tracker_id AS k, (SELECT MIN(x.local_date) FROM v_events x WHERE x.tracker_id = e.tracker_id) AS first," +
      " group_concat((CAST(julianday(e.local_date) - julianday('" + s + "') AS INTEGER) * 1440 + ((e.ts + e.tz_offset_min * 60) % 86400) / 60) || ':' || e.value, ',') AS ev" +
      " FROM (SELECT tracker_id, local_date, ts, tz_offset_min, value FROM v_events WHERE local_date BETWEEN '" + a + "' AND '" + b + "' ORDER BY ts) e GROUP BY tracker_id ORDER BY tracker_id";
    return { evA: ev(L.shiftDate(date, -27), date), evB: ev(s, L.shiftDate(date, -28)),
      days: "SELECT local_date, sleep_min, bedtime_local, waketime_local, hrv_rmssd FROM v_daily WHERE local_date BETWEEN '" + L.shiftDate(date, -56) + "' AND '" + date + "' ORDER BY local_date" };
  }
  /* Both halves → { list: [{k, t, d, min, v}] in time order, first: {id: date}, logged: Set of dates with any log }; null while loading or when truncated (R2.7). */
  function rtEvents(a, b, date) {
    if ([a, b].some((r) => !r || r.truncated || !Array.isArray(r.rows) || !Array.isArray(r.columns))) return null;
    const s = L.shiftDate(date, -55), list = [], first = {};
    for (const r of [a, b]) {
      const ci = (c) => r.columns.indexOf(c), K = ci('k'), F = ci('first'), E = ci('ev');
      if (K < 0 || E < 0) continue;
      for (const row of r.rows) {
        const k = row[K];
        if (typeof k !== 'string') continue;
        if (typeof row[F] === 'string' && !(first[k] <= row[F])) first[k] = row[F];
        for (const x of String(row[E] ?? '').split(',')) {
          const [tt, vv] = x.split(':'), t = Number(tt), v = Number(vv);
          if (tt === '' || !Number.isInteger(t) || !finite(v)) continue;
          list.push({ k, t, d: L.shiftDate(s, Math.floor(t / 1440)), min: ((t % 1440) + 1440) % 1440, v });
        }
      }
    }
    list.sort((x, y) => x.t - y.t || x.k.localeCompare(y.k));
    return { list, first, logged: new Set(list.map((e) => e.d)), s };
  }
  /* health_sql nights → Map date → row; null when absent or truncated. */
  function rtNights(res) {
    if (!res || res.truncated || !Array.isArray(res.rows) || !Array.isArray(res.columns)) return null;
    return new Map(res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))).filter((o) => typeof o.local_date === 'string').map((o) => [o.local_date, o]));
  }
  const of = (ev, d, ids) => ev.list.filter((e) => e.d === d && ids.includes(e.k));
  /* R2.9: a tracker's day total is known when the day has any log and is on or after that tracker's first log; else null (unknown, not zero). */
  const total = (ev, d, ids, upto = 1440, val = (e) => e.v) => {
    if (!ev.logged.has(d) || !ids.some((k) => ev.first[k] && d >= ev.first[k])) return null;
    return of(ev, d, ids).filter((e) => e.min < upto).reduce((s, e) => s + val(e), 0);
  };
  const wakeOf = (nights, d) => L.localMinutes(nights?.get(d)?.waketime_local);
  /* First log of `ids` on d at or after waking, minus the wake minute. */
  const afterWake = (ev, nights, d, ids) => { const w = wakeOf(nights, d); if (w == null) return null; const e = of(ev, d, ids).find((x) => x.min >= w); return e ? e.min - w : null; };
  const range = (pts, date) => L.typicalRange({ columns: ['local_date', 'v'], rows: pts }, 'v', date);

  /* Día a día: `span` days to the date, newest first. Column max over the shown rows; means over known values with their day count (R2.9). */
  function rtTable(ev, nights, date, span) {
    const K = ['caffeine', 'cigarettes', 'alcohol', 'water'], rows = [];
    for (let i = 0; i < span; i++) {
      const d = L.shiftDate(date, -i), r = { date: d, we: L.weekday(d) >= 5, sleep: finite(nights?.get(d)?.sleep_min) ? nights.get(d).sleep_min : null };
      for (const k of K) r[k] = ev ? total(ev, d, [k], 1440, amt) : null;
      r.mood = ev ? L.mostMood(of(ev, d, MOOD).map((e) => ({ id: e.k, t: e.t }))) : null;
      rows.push(r);
    }
    const max = {}, avg = {}, cnt = {};
    for (const k of ['sleep', ...K]) { const v = rows.map((r) => r[k]).filter(finite); max[k] = v.length ? Math.max(0, ...v) : 0; avg[k] = v.length ? mean(v) : null; cnt[k] = v.length; }
    return { rows, max, mean: avg, cnt, n: ev ? rows.filter((r) => ev.logged.has(r.date)).length : 0 };
  }

  /* Tu día tipo: medians over the 14 nights before the date, 7 needed (as C2); the first-cigarette delay also needs 7 days.
     Today's wake differs when more than 15 min off; the weekend shift (Sat/Sun wakes vs the rest, 28 days, 2 of each) is named beyond 30 min. */
  function rtTypical(nights, ev, date) {
    const dates = Array.from({ length: 14 }, (_, i) => L.shiftDate(date, -i - 1));
    const wakes = dates.map((d) => wakeOf(nights, d)).filter((x) => x != null);
    if (wakes.length < 7) return { learning: true, n: wakes.length, need: 7 };
    const beds = dates.map((d) => b18(nights.get(d)?.bedtime_local)).filter((x) => x != null), wake = med(wakes);
    const cigs = ev ? dates.map((d) => afterWake(ev, nights, d, ['cigarettes'])).filter((x) => x != null) : [];
    const tw = wakeOf(nights, date), c = tw != null && ev ? afterWake(ev, nights, date, ['cigarettes']) : null;
    const w28 = Array.from({ length: 28 }, (_, i) => L.shiftDate(date, -i - 1)).filter((d) => wakeOf(nights, d) != null);
    const we = w28.filter((d) => L.weekday(d) >= 5).map((d) => wakeOf(nights, d)), wd = w28.filter((d) => L.weekday(d) < 5).map((d) => wakeOf(nights, d));
    const shift = we.length >= 2 && wd.length >= 2 ? med(we) - med(wd) : null;
    return { learning: false, n: wakes.length, wake, cig: cigs.length >= 7 ? med(cigs) : null, bed: beds.length >= 7 ? (med(beds) + 1080) % 1440 : null,
      today: { wake: tw, cig: c == null ? null : tw + c }, dev: tw == null ? null : tw - wake > 15 ? 'late' : wake - tw > 15 ? 'early' : 'same',
      weekend: shift != null && Math.abs(shift) > 30 ? shift : null };
  }

  /* Clave: today's value and the 28-day usual (typicalRange) of wake → cigarette, wake → coffee and last coffee → bed (the night ending on the date);
     bedtime: the population SD over the 14 nights to the date (7 needed), with its usual range and last night's bedtime. */
  function rtKey(nights, ev, date) {
    const ds = Array.from({ length: 29 }, (_, i) => L.shiftDate(date, -i)), idx = (d) => Math.round((Date.parse(d) - Date.parse(ev.s)) / 86400000);
    const cafBed = (d) => {
      const bm = L.localMinutes(nights?.get(d)?.bedtime_local); if (bm == null || !ev) return null;
      const lo = idx(L.shiftDate(d, -1)) * 1440, bed = bm >= 720 ? lo + bm : lo + 1440 + bm;   // an evening bedtime is the day before; after midnight, the date
      const c = ev.list.filter((e) => e.k === 'caffeine' && e.t >= lo && e.t < bed).pop();
      return c ? bed - c.t : null;
    };
    const ser = (f) => ds.map((d) => [d, f(d)]).filter(([, v]) => v != null);
    const row = (id, f, d) => { const s = ser(f); return { id, v: s.find(([x]) => x === d)?.[1] ?? null, r: range(s, date) }; };
    const beds = ser((d) => b18(nights?.get(d)?.bedtime_local)), b14 = beds.filter(([d]) => within(d, date, 14)).map(([, v]) => v);
    const m = b14.length ? mean(b14) : 0;
    return [row('cig', (d) => ev ? afterWake(ev, nights, d, ['cigarettes']) : null, date), row('caf', (d) => ev ? afterWake(ev, nights, d, ['caffeine']) : null, date),
      row('cafBed', cafBed, date),
      { id: 'bed', v: b14.length >= 7 ? Math.sqrt(mean(b14.map((x) => (x - m) ** 2))) : null, n: b14.length, r: range(beds, date), dot: beds.find(([d]) => d === date)?.[1] ?? null }];
  }

  /* C6 (R2.15): per row, a Gaussian KDE (bandwidth 30 min) of event minutes, wrapped circularly over 24 h, last 30 days, divided by the row's known days
     (a per-day rate). Learning under 7 logged days. A selected weekday uses the 8 weeks and needs 3 logged days of it; both curves share the row max.
     pts: 161 points from 06:00 to 06:00; peak: the first minute of the max from 06:00 on. busiest: the weekday with most events per logged day (3 days). */
  const KDE = (mins) => { const out = new Float64Array(1440); for (const x of mins) for (let g = 0; g < 1440; g++) { const d = ((g - x) % 1440 + 2160) % 1440 - 720; out[g] += Math.exp(-d * d / 1800); } return out; };
  const raw = (dens) => Array.from({ length: 161 }, (_, j) => dens[(360 + j * 9) % 1440]);
  const norm = (...gs) => { const M = Math.max(0, ...gs.flat()); return gs.map((g) => g.map((x) => M > 0 ? x / M : 0)); };   // the row max over the drawn points
  function rtRidge(ev, nights, date, sel) {
    const list = ev?.list ?? [], logged = ev?.logged ?? new Set();
    const known = (ids, n, wd) => [...logged].filter((d) => within(d, date, n) && (wd == null || L.weekday(d) === wd) && ids.some((k) => ev.first[k] && d >= ev.first[k]));
    const rows = GROUPS.map(([k, ids]) => {
      const e30 = list.filter((e) => ids.includes(e.k) && within(e.d, date, 30)), days = new Set(e30.map((e) => e.d)).size, k30 = Math.max(1, known(ids, 30).length);
      const all = KDE(e30.map((e) => e.min)).map((x) => x / k30);
      let peak = null; for (let i = 0; i < 1440; i++) { const g = (360 + i) % 1440; if (all[g] > 0 && (peak == null || all[g] > all[peak])) peak = g; }
      const perWd = Array.from({ length: 7 }, (_, w) => { const kd = known(ids, 56, w); return kd.length >= 3 ? list.filter((e) => ids.includes(e.k) && kd.includes(e.d)).reduce((s, e) => s + amt(e), 0) / kd.length : null; });
      const rate = e30.reduce((s, e) => s + amt(e), 0) / k30, valid = perWd.map((v, i) => [v, i]).filter(([v]) => v != null);
      const top = valid.length ? valid.reduce((a, b) => b[0] > a[0] ? b : a) : null;
      const row = { k, days, learning: days < 7, peak, rate, more: top && top[0] > rate * 1.1 ? top[1] : null, today: list.filter((e) => ids.includes(e.k) && e.d === date).map((e) => e.min) };
      if (sel == null) return { ...row, pts: norm(raw(all))[0] };
      const es = list.filter((e) => ids.includes(e.k) && within(e.d, date, 56) && L.weekday(e.d) === sel), sd = new Set(es.map((e) => e.d)).size;
      const [a, s] = norm(raw(all), raw(KDE(es.map((e) => e.min)).map((x) => x / Math.max(1, known(ids, 56, sel).length))));
      return { ...row, pts: a, all: a, sel: s, selLearning: sd < 3, selRate: perWd[sel] };
    });
    const per = Array.from({ length: 7 }, (_, w) => { const kd = [...logged].filter((d) => within(d, date, 56) && L.weekday(d) === w); return kd.length >= 3 ? list.filter((e) => kd.includes(e.d) && GROUPS.some(([, ids]) => ids.includes(e.k))).length / kd.length : null; });
    const best = per.map((v, i) => [v, i]).filter(([v]) => v != null).reduce((a, b) => !a || b[0] > a[0] ? b : a, null);
    const ws = Array.from({ length: 14 }, (_, i) => L.shiftDate(date, -i - 1)), wk = ws.map((d) => wakeOf(nights, d)).filter((x) => x != null), bd = ws.map((d) => b18(nights?.get(d)?.bedtime_local)).filter((x) => x != null);
    return { rows, busiest: best ? best[1] : null, sleep: wk.length >= 7 && bd.length >= 7 ? { bed: (med(bd) + 1080) % 1440, wake: med(wk) } : null };
  }

  /* C7 (R2.15): over the last 30 days, each A event is paired once with the first event of each other kind B in (0, 60] min after it;
     an event may be the B of several As. Nodes: the known trackers, moods and Despertar (the main sleep's wake time). A >= 5; ranked by share,
     then matches, then A count, then name. delay: the median of the matched delays.
     R2.9: an A counts only on a known day (any log) on or after B's first log; Despertar as B has no first log. */
  function rtChains(ev, nights, date) {
    if (!ev) return [];
    const ids = [...L.CHIPS.map((c) => c.id).filter(Boolean), ...MOOD], idx = (d) => Math.round((Date.parse(d) - Date.parse(ev.s)) / 86400000);
    const evs = ev.list.filter((e) => ids.includes(e.k) && within(e.d, date, 30)).map((e) => ({ k: e.k, t: e.t, d: e.d }));
    for (const [d, r] of nights ?? []) { const w = L.localMinutes(r.waketime_local); if (w != null && within(d, date, 30)) evs.push({ k: 'wake', t: idx(d) * 1440 + w, d }); }
    evs.sort((a, b) => a.t - b.t);
    const pairs = new Map(), elig = (a, b) => ev.logged.has(a.d) && (b === 'wake' || a.d >= ev.first[b]);
    evs.forEach((a, i) => {
      const seen = new Set();
      for (let j = i + 1; j < evs.length && evs[j].t - a.t <= 60; j++) {
        const b = evs[j];
        if (b.t === a.t || b.k === a.k || seen.has(b.k) || !elig(a, b.k)) continue;
        seen.add(b.k); const key = a.k + '>' + b.k; (pairs.get(key) ?? pairs.set(key, []).get(key)).push(b.t - a.t);
      }
    });
    return [...pairs].map(([key, ds]) => { const [a, b] = key.split('>'), n = evs.filter((e) => e.k === a && elig(e, b)).length; return { a, b, n, k: ds.length, share: ds.length / n, delay: med(ds) }; })
      .filter((r) => r.n >= 5).sort((x, y) => y.share - x.share || y.k - x.k || y.n - x.n || (x.a + x.b).localeCompare(y.a + y.b)).slice(0, 5);
  }

  /* Agua: 14 days, oldest first; v null on unknown days (R2.9). n known days, k days at the goal, mean over n; am/pm: shares of the 14 days' water
     before 13:00 and from 18:00. The sentence needs 7 known days. */
  function rtWater(ev, date, goal) {
    const days = Array.from({ length: 14 }, (_, i) => { const d = L.shiftDate(date, i - 13); return { date: d, v: ev ? total(ev, d, ['water']) : null }; });
    const kn = days.filter((d) => d.v != null), w = (ev?.list ?? []).filter((e) => e.k === 'water' && within(e.d, date, 14)), all = w.reduce((s, e) => s + e.v, 0);
    return { days, n: kn.length, k: kn.filter((d) => d.v >= goal).length, mean: kn.length ? mean(kn.map((d) => d.v)) : null, learning: kn.length < 7,
      am: all > 0 ? w.filter((e) => e.min < 780).reduce((s, e) => s + e.v, 0) / all : null, pm: all > 0 ? w.filter((e) => e.min >= 1080).reduce((s, e) => s + e.v, 0) / all : null };
  }
  /* Suplementos: per supplement tracker logged in the 14 days: 14 cells (oldest first), days taken, and the median time (06:00 axis, 3 logs needed). */
  function rtSupps(ev, date) {
    return SUPP.map((id) => {
      const e = (ev?.list ?? []).filter((x) => x.k === id && within(x.d, date, 14)), on = new Set(e.map((x) => x.d));
      const den = [...(ev?.logged ?? [])].filter((d) => within(d, date, 14) && d >= ev.first[id]).length;   // R2.9: known days from the first log
      return { id, cells: Array.from({ length: 14 }, (_, i) => on.has(L.shiftDate(date, i - 13))), k: on.size, n: e.length, den, learning: den < 7, time: e.length >= 3 ? med(e.map((x) => m6(x.min))) % 1440 : null };
    }).filter((r) => r.n > 0);
  }
  /* Ánimo: mood logs of the 30 days, counts sorted (a tie: the mood logged most recently first). Peak: among moods with 5 logs, the most logged
     whose logs fall more than half in one part of the day (morning 06–12, afternoon 12–20, night 20–06). */
  function rtMoods(ev, date) {
    const e = (ev?.list ?? []).filter((x) => MOOD.includes(x.k) && within(x.d, date, 30)), by = new Map();
    e.forEach((x) => { const s = by.get(x.k) ?? { face: x.k.slice(5), n: 0, last: 0, mins: [] }; s.n++; s.last = x.t; s.mins.push(x.min); by.set(x.k, s); });
    const counts = [...by.values()].sort((a, b) => b.n - a.n || b.last - a.last);
    const part = (m) => m >= 360 && m < 720 ? 'morning' : m >= 720 && m < 1200 ? 'afternoon' : 'night';
    let peak = null;
    for (const c of counts) {
      if (c.n < 5) continue;
      const p = ['morning', 'afternoon', 'night'].map((q) => [q, c.mins.filter((m) => part(m) === q).length]).find(([, k]) => k > c.n / 2);
      if (p) { peak = { face: c.face, part: p[0], k: p[1], n: c.n }; break; }
    }
    return { counts: counts.map(({ face, n }) => ({ face, n })), total: e.length, pts: e.map((x) => ({ face: x.k.slice(5), min: x.min })), peak };
  }
  /* health_scan rows for mood_negative and mood_tired labelled sólido or probable, with a known behaviour; up to 2 in the engine's order.
     more: diff > 0, i.e. the mood is more frequent in the behaviour's group (a). */
  const BEH = ['cigarettes', 'caffeine', 'alcohol', 'water', 'melatonin', 'protein', 'creatine', 'workout', 'steps', 'short_sleep'];
  const rtScan = (scan) => (Array.isArray(scan?.rows) ? scan.rows : []).filter((r) => ['mood_negative', 'mood_tired'].includes(r?.metric) && ['sólido', 'probable'].includes(r.label)
    && BEH.includes(r.behavior) && finite(r.diff) && finite(r.n_a) && finite(r.n_b)).slice(0, 2).map((r) => ({ metric: r.metric, behavior: r.behavior, more: r.diff > 0, n_a: r.n_a, n_b: r.n_b, label: r.label }));

  /* I3 Rutina features (R2.6a): coffee and cigarettes (stored values) and steps up to the minute, the most-logged mood so far (0/1 per mood).
     Candidates are the 14 days with hourly steps; a day without step points, without logs or before a tracker's first log is out; a tracker never logged
     is not a feature. An hour of steps counts in proportion to the part before the minute. Outcome: the following night's sleep, with its HRV. */
  function rtAlike(ev, nights, steps, date, min) {
    const used = ['caffeine', 'cigarettes'].filter((k) => ev.first[k]);
    const feat = (d, upto) => {
      const p = steps[d];
      if (!Array.isArray(p) || !p.length || !ev.logged.has(d)) return null;
      const x = { steps: p.reduce((s, q) => { const a = L.localMinutes(q?.[0]); return a == null || !finite(q[1]) ? s : s + q[1] * Math.min(1, Math.max(0, (upto - a) / 60)); }, 0) };
      for (const k of used) { x[k] = total(ev, d, [k], upto); if (x[k] == null) return null; }
      const m = L.mostMood(of(ev, d, MOOD).filter((e) => e.min < upto).map((e) => ({ id: e.k, t: e.t })));
      for (const id of MOOD) x['m_' + id.slice(5)] = m === id ? 1 : 0;
      return x;
    };
    const days = [];
    for (let i = 1; i <= 14; i++) {
      const d = L.shiftDate(date, -i), x = feat(d, min), nx = nights?.get(L.shiftDate(d, 1));
      if (x) days.push({ date: d, x, out: finite(nx?.sleep_min) ? nx.sleep_min : null, hrv: finite(nx?.hrv_rmssd) ? nx.hrv_rmssd : null });
    }
    return { today: feat(date, min) ?? {}, days };
  }

  const copy = {
    'ru.typ': ['Your typical day', 'Tu día tipo'],
    'ru.typ.wake': ['You get up around {w}.', 'Te levantas hacia {w}.'],
    'ru.typ.cig': ['You get up around {w} and have your first cigarette about {d} later.', 'Te levantas hacia {w} y fumas el primer cigarro unos {d} después.'],
    'ru.typ.bed': ['You go to bed around {b}.', 'Te acuestas sobre {b}.'],
    'ru.typ.late': ['Today you were a little late: woke at {w}', 'Hoy fuiste algo tarde: despertar {w}'],
    'ru.typ.early': ['Today you were a little early: woke at {w}', 'Hoy fuiste algo pronto: despertar {w}'],
    'ru.typ.same': ['Today on your usual time: woke at {w}', 'Hoy, a tu hora: despertar {w}'],
    'ru.typ.cigT': [' and first cigarette at {c}', ' y primer cigarro {c}'],
    'ru.typ.weLate': ['At weekends you get up {d} later.', 'Los fines de semana te levantas {d} más tarde.'],
    'ru.typ.weEarly': ['At weekends you get up {d} earlier.', 'Los fines de semana te levantas {d} antes.'],
    'ru.k.cig': ['Wake → cigarette', 'Despertar → cigarro'], 'ru.k.caf': ['Wake → coffee', 'Despertar → café'],
    'ru.k.cafBed': ['Last coffee → sleep', 'Último café → dormir'], 'ru.k.bed': ['Bedtime', 'Hora de dormir'],
    'ru.k.usual': ['usual {r} · {w}', 'habitual {r} · {w}'], 'ru.k.learn': ['usual in {k} more days · {w}', 'habitual en {k} días más · {w}'],
    'ru.k.today': ['today', 'hoy'], 'ru.k.yday': ['yesterday', 'ayer'], 'ru.k.that': ['that day', 'ese día'], 'ru.k.eve': ['the day before', 'el día antes'],
    'ru.k.sd': ['variation between nights · 14 days', 'variación entre noches · 14 días'],
    'ru.r.t': ['At what times', 'A qué horas'], 'ru.r.s': ['last 30 days', 'últimos 30 días'],
    'ru.r.aria': ['At what times of day you log each thing: one curve per log, higher where you do it more.', 'A qué horas del día registras cada cosa: una curva por registro, más alta donde más lo haces.'],
    'ru.r.caffeine': ['Coffee', 'Café'], 'ru.r.cigarettes': ['Cigarettes', 'Cigarros'], 'ru.r.alcohol': ['Alcohol', 'Alcohol'], 'ru.r.water': ['Water', 'Agua'], 'ru.r.supp': ['Supplements', 'Suplementos'],
    'ru.r.few': ['Few days yet', 'Aún pocos días'], 'ru.r.sleep': ['sleep', 'sueño'],
    'ru.r.day': ['{v} / day', '{v} / día'], 'ru.r.on': ['{v} / {d}', '{v} / {d}'], 'ru.r.avg': ['average {v}', 'media {v}'],
    'ru.r.more': ['most: {d}', 'más: {d}'], 'ru.r.same': ['same every day', 'igual todos'],
    'ru.r.legend': ['The higher the curve, the more often at that time', 'Cuanto más alta la curva, más veces a esa hora'],
    'ru.r.today': ['Today', 'Hoy'], 'ru.r.allDays': ['All days', 'Todos los días'], 'ru.r.band': ['Your sleep schedule', 'Tu horario de sueño'],
    'ru.r.at': ['{n} around {t}', '{n} hacia {t}'], 'ru.r.peaks': ['Peaks: {x}.', 'Picos: {x}.'], 'ru.r.busy': ['You log most on {d}.', 'Registras más los {d}.'],
    'ru.r.sel': ['{d}: {x}.', '{d}: {x}.'], 'ru.r.selIt': ['{n} {a} against {b} on average', '{n} {a} frente a {b} de media'],
    'ru.r.selFew': ['Not enough {d} yet to compare.', 'Aún pocos {d} para comparar.'],
    'ru.wd3': ['Mon Tue Wed Thu Fri Sat Sun', 'lun mar mié jue vie sáb dom'],
    'ru.wdP': ['Mondays Tuesdays Wednesdays Thursdays Fridays Saturdays Sundays', 'lunes martes miércoles jueves viernes sábados domingos'],
    'ru.and': [' and ', ' y '],
    'ru.c.t': ['What leads to what', 'Qué lleva a qué'],
    'ru.c.row': ['after {d} · {x}', 'a los {d} · {x}'], 'ru.c.of': ['{k} of {n}', '{k} de {n}'], 'ru.c.all': ['every time ({n})', 'todas ({n})'],
    'ru.c.foot': ['How often one thing is followed by the other within the next hour.', 'Cuántas veces a una cosa le sigue la otra en la hora siguiente.'],
    'ru.c.note': ['They go together; that does not prove cause.', 'Van juntos, no prueba causa.'],
    'ru.c.what': ['the chains', 'las cadenas'],
    'ru.n.wake': ['Wake', 'Despertar'], 'ru.n.caffeine': ['Coffee', 'Café'], 'ru.n.cigarettes': ['Cigarette', 'Cigarro'], 'ru.n.alcohol': ['Drink', 'Copa'], 'ru.n.water': ['Water', 'Agua'],
    'ru.mood.genial': ['Great', 'Genial'], 'ru.mood.bien': ['Good', 'Bien'], 'ru.mood.tranquilo': ['Calm', 'Tranquilo'], 'ru.mood.cansado': ['Tired', 'Cansado'],
    'ru.mood.estresado': ['Stressed', 'Con estrés'], 'ru.mood.ansioso': ['Anxious', 'Ansioso'], 'ru.mood.triste': ['Sad', 'Triste'], 'ru.mood.enfadado': ['Angry', 'Enfadado'],
    'ru.al.lead': ['Today, up to {t}: {x}. The most similar days were {d}.', 'Hoy, hasta las {t}: {x}. Los días más parecidos fueron {d}.'],
    'ru.al.day': ['That day: {x}. The most similar days were {d}.', 'Ese día: {x}. Los días más parecidos fueron {d}.'],
    'ru.al.caf': ['{n} mg of coffee', '{n} mg de café'], 'ru.al.cig': ['{n} cigarettes', '{n} cigarros'], 'ru.al.steps': ['{n} steps', '{n} pasos'],
    'ru.al.out': ['Those nights you slept {m} on average', 'Esas noches dormiste {m} de media'], 'ru.al.below': [', below your usual', ', por debajo de lo habitual'],
    'ru.al.above': [', above your usual', ', por encima de lo habitual'], 'ru.al.hrv': [', and HRV was {v} ms', ', y la VFC fue {v} ms'],
    'ru.al.note': ['It is what happened on similar days, not a sure prediction.', 'Es lo que pasó en días parecidos, no una predicción segura.'],
    'ru.f.t': ['Routine findings', 'Hallazgos de rutina'],
    'ru.d.t': ['Day by day', 'Día a día'], 'ru.d.s': ['last {n} days', 'últimos {n} días'], 'ru.d.n': ['{n} d', '{n} d'], 'ru.d.seg': ['Period', 'Periodo'],
    'ru.d.day': ['Day', 'Día'], 'ru.d.sleep': ['Sleep', 'Sueño'], 'ru.d.mood': ['Mood', 'Ánimo'], 'ru.d.avg': ['average', 'media'], 'ru.d.today': ['today', 'hoy'],
    'ru.d.open': ['Open {d} in Today', 'Abrir {d} en Hoy'],
    'ru.d.note': ['The stronger the background, the higher the value that day. The mood dot is the one you logged most. Weekends shaded. Tap a day to open it in Today.',
      'Cuanto más intenso el fondo, más alto el valor ese día. El punto de ánimo es el que más registraste. Fines de semana sombreados. Toca un día para abrirlo en Hoy.'],
    'ru.d.den': [' Averages over the days with data in each column: {x}.', ' Medias sobre los días con datos de cada columna: {x}.'],
    'ru.w.t': ['Water', 'Agua'], 'ru.w.s': ['last 14 days', 'últimos 14 días'],
    'ru.w.aria': ['Water over the last 14 days against the goal of {g}.', 'Agua de los últimos 14 días frente al objetivo de {g}.'],
    'ru.w.sum': ['You reach {g} on {k} of {n} days · average {m}.', 'Llegas a {g} {k} de {n} días · media {m}.'],
    'ru.w.none': ['No day reached {g} · average {m}.', 'Ningún día llegaste a {g} · media {m}.'],
    'ru.w.am': ['You drink {p} before 13:00', 'Bebes el {p} antes de las 13:00'], 'ru.w.pm': [' and almost nothing after 18:00', ' y casi nada después de las 18:00'],
    'ru.w.what': ['your water average', 'tu media de agua'],
    'ru.s.t': ['Supplements', 'Suplementos'], 'ru.s.s': ['last 14 days', 'últimos 14 días'], 'ru.s.at': ['usual {t}', 'habitual {t}'], 'ru.s.few': ['usual time after 3 logs', 'hora habitual tras 3 registros'],
    'ru.s.none': ['No supplements logged in the last 14 days.', 'Sin suplementos registrados en los últimos 14 días.'],
    'ru.m.t': ['Mood', 'Ánimo'], 'ru.m.s': ['last 30 days · {n} logs', 'últimos 30 días · {n} registros'], 'ru.m.s1': ['last 30 days · 1 log', 'últimos 30 días · 1 registro'],
    'ru.m.how': ['How much', 'Cuánto'], 'ru.m.when': ['When', 'Cuándo'],
    'ru.m.aria': ['When you log each mood through the day, last 30 days.', 'Cuándo registras cada ánimo a lo largo del día, últimos 30 días.'],
    'ru.m.none': ['No mood logged in the last 30 days.', 'Sin ánimo registrado en los últimos 30 días.'],
    'ru.m.peak.morning': ['{m} shows up mostly in the morning.', '{m} sale sobre todo por la mañana.'],
    'ru.m.peak.afternoon': ['{m} shows up mostly in the afternoon.', '{m} sale sobre todo por la tarde.'],
    'ru.m.peak.night': ['{m} shows up mostly at night.', '{m} sale sobre todo por la noche.'],
    'ru.m.peakN': ['{k} of {n} logs', '{k} de {n} registros'],
    'ru.m.more': ['{m} is more frequent with {b}.', '{m} es más frecuente con {b}.'], 'ru.m.less': ['{m} is less frequent with {b}.', '{m} es menos frecuente con {b}.'],
    'ru.m.mood_negative': ['Low mood', 'El ánimo bajo'], 'ru.m.mood_tired': ['Tiredness', 'El cansancio'],
    'ru.b.cigarettes': ['more cigarettes', 'más cigarros'], 'ru.b.caffeine': ['more coffee', 'más café'], 'ru.b.alcohol': ['alcohol', 'alcohol'], 'ru.b.water': ['more water', 'más agua'],
    'ru.b.melatonin': ['melatonin', 'melatonina'], 'ru.b.protein': ['protein', 'proteína'], 'ru.b.creatine': ['creatine', 'creatina'], 'ru.b.workout': ['a workout', 'entreno'],
    'ru.b.steps': ['more steps', 'más pasos'], 'ru.b.short_sleep': ['short sleep', 'poco sueño'],
    'ru.partial': ['Part of your logs could not be read; nothing is shown that depends on them.', 'Parte de tus registros no se pudo leer; no se muestra nada que dependa de ellos.'],
    'card.ruEv': ['your logs', 'tus registros'], 'card.ruDays': ['your nights', 'tus noches'], 'card.ruSteps': ['your hourly steps', 'tus pasos por hora'], 'card.ruProf': ['your water goal', 'tu objetivo de agua']
  };

  /* Log glyphs, the watch shapes (gen/sleep.py glyph(), gen/rut.py glyph2()). */
  const SURF = 'var(--surface)';
  const filled = (shape, c) => '<g fill="' + SURF + '" stroke="' + SURF + '" stroke-width="2.2">' + shape + '</g><g fill="' + c + '" stroke="var(--fill-edge)" stroke-width=".9" paint-order="stroke">' + shape + '</g>';
  const GL = {
    caffeine: filled('<ellipse rx="4.2" ry="5.6"/>', 'var(--fill-caffeine)') + '<path d="M0 -4.6Q-2 -2.3 0 0Q2 2.3 0 4.6" fill="none" stroke="var(--on-fill-caffeine)" stroke-width="1.2"/>',
    cigarettes: '<path d="M0 -7V7" stroke="' + SURF + '" stroke-width="6.6"/><path d="M0 -7V7" stroke="var(--m-cig)" stroke-width="3"/>',
    alcohol: filled('<path d="M-4.6 -6.4H4.6V-3.2A4.6 4.6 0 0 1-4.6 -3.2Z"/>', 'var(--fill-alcohol)') + '<path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="' + SURF + '" stroke-width="3.8"/><path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="var(--m-alcohol)" stroke-width="1.6"/>',
    water: filled('<path d="M0 -6.2C-1.6 -3.6 -4.2 -1.2 -4.2 1.6A4.2 4.2 0 0 0 4.2 1.6C4.2 -1.2 1.6 -3.6 0 -6.2Z"/>', 'var(--fill-water)'),
    supp: filled('<rect x="-2.7" y="-5.8" width="5.4" height="11.6" rx="2.7"/>', 'var(--fill-supp)') + '<path d="M-2.7 0H2.7" stroke="var(--on-fill-supp)" stroke-width="1"/>'
  };
  const inner = (k) => GL[k] ?? (k.startsWith('mood_') ? filled('<circle r="4.6"/>', 'var(--mood-' + k.slice(5) + ')') : GL.supp);
  const gsvg = (k) => k === 'wake'
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 4v3M5 9l2 2M19 9l-2 2"/></svg>'
    : '<svg width="18" height="18" viewBox="-10 -10 20 20" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round">' + inner(k) + '</svg>';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const lab = (x, y, s, o = {}) => '<text x="' + r1(x) + '" y="' + r1(y) + '" text-anchor="' + (o.a ?? 'start') + '" font-size="' + (o.s ?? 11) + '" font-weight="' + (o.w ?? '400') + '" fill="' + (o.c ?? 'var(--muted)') +
    '" font-family="var(--font-' + (o.mono ? 'mono' : 'sans') + ')" stroke="' + SURF + '" stroke-width="3" paint-order="stroke">' + esc(s) + '</text>';
  const RCOL = { caffeine: ['fill-caffeine', 'm-caffeine'], cigarettes: ['m-cig', 'm-cig'], alcohol: ['fill-alcohol', 'm-alcohol'], water: ['fill-water', 'm-water'], supp: ['fill-supp', 'm-supp'] };

  const css = `
#g-routine .hx-key .hx-row:first-child { border-top: 0; padding-top: 0; } #g-routine .hx-key .hx-row:last-child { padding-bottom: 0; }
#g-routine .rx-typ .hx-legend span { gap: 4px; }
#g-routine .rx-days .hx-ctl { display: flex; align-items: center; }
#g-routine .rx-t { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
#g-routine .rx-t th, #g-routine .rx-t td { padding: 3px 2px; text-align: center; font-weight: var(--w); }
#g-routine .rx-t thead th { color: var(--muted); font-size: 12px; padding-bottom: 6px; } #g-routine .rx-t thead svg { vertical-align: middle; }
#g-routine .rx-t tbody th { text-align: left; color: var(--muted); font-size: 12px; white-space: nowrap; width: 52px; }
#g-routine .rx-t thead th:first-child { text-align: left; width: 52px; }
#g-routine .rx-c { display: block; border-radius: 4px; padding: 3px 0; font: 400 12px/16px var(--font-mono); white-space: nowrap; }
#g-routine .rx-t tbody tr { cursor: pointer; } #g-routine .rx-t tbody tr:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
#g-routine .rx-t tr.is-we { background: var(--surface-2); } #g-routine .rx-t tr.is-today th, #g-routine .rx-t tr.is-today .rx-c { color: var(--ink); font-weight: var(--w-strong); }
#g-routine .rx-t tr.is-today { box-shadow: inset 0 0 0 2px var(--primary); border-radius: 6px; }
#g-routine .rx-md { display: inline-block; width: 12px; height: 12px; border-radius: 50%; vertical-align: middle; }
#g-routine .rx-avg td { white-space: nowrap; }
#g-routine .rx-avg th, #g-routine .rx-avg td { border-top: 1px solid var(--line); padding-top: 8px; font: 500 12px/16px var(--font-mono); color: var(--ink); } #g-routine .rx-avg th { font-family: var(--font-sans); color: var(--muted); text-align: left; }
#g-routine .rx-t thead th:nth-child(2) { width: 22%; }
@media (max-width: 599px) { #g-routine .rx-t tbody tr { height: 44px; } }
#g-routine .rx-chain { display: flex; flex-direction: column; }
#g-routine .rx-ch { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
#g-routine .rx-ch:first-of-type { border-top: 0; padding-top: 0; } #g-routine .rx-ch .hx-bar { grid-column: 1 / -1; height: 6px; } #g-routine .rx-ch .hx-s { grid-column: 1 / -1; }
#g-routine .rx-chn { display: inline-flex; align-items: center; gap: 6px; font-weight: var(--w-strong); } #g-routine .rx-arr { color: var(--muted); margin: 0 2px; }
#g-routine .rx-ch .hx-v { font-size: 15px; }
#g-routine .rx-water, #g-routine .rx-supp { display: flex; flex-direction: column; } #g-routine .rx-water .hx-sep, #g-routine .rx-supp .hx-sep { margin-top: auto; }
#g-routine .rx-sp { display: grid; grid-template-columns: 88px 1fr auto; gap: 2px 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
#g-routine .rx-sp:first-of-type { border-top: 0; } #g-routine .rx-sp .hx-s { grid-column: 2 / -1; } #g-routine .rx-sp .hx-v { font-size: 15px; } #g-routine .rx-sp .hx-n { overflow-wrap: anywhere; }
#g-routine .rx-cells { display: grid; grid-template-columns: repeat(14, 1fr); gap: 3px; } #g-routine .rx-cells i { height: 14px; border-radius: 3px; box-shadow: inset 0 0 0 1px var(--line-strong); }
#g-routine .rx-cells i.on { background: var(--fill-supp); box-shadow: none; }
#g-routine .sx-stack { display: flex; border-radius: var(--radius-full); overflow: hidden; gap: 2px; } #g-routine .sx-stack i { display: block; }
#g-routine .rx-mbar { height: 14px; margin: 4px 0 10px; }
#g-routine .rx-ms { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: var(--muted); }
#g-routine .rx-m { display: inline-flex; align-items: center; gap: 6px; } #g-routine .rx-m i { width: 10px; height: 10px; border-radius: 50%; } #g-routine .rx-m b { color: var(--ink); font: 500 13px var(--font-mono); }
#g-routine .rx-mgrid { display: grid; gap: 16px; } #g-routine .rx-mgrid .met-l { margin: 0 0 6px; }
#g-routine .sx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
#g-routine .sx-list li { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; font-size: 14px; line-height: 20px; }
#g-routine .sx-list b { font-weight: var(--w-strong); } #g-routine .sx-list .hx-sub { margin-top: 2px; }
#g-routine .rx-mins { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
@media (min-width: 1200px) {
  #g-routine .hx-key { display: flex; flex-direction: column; justify-content: center; }
  #g-routine .rx-t { font-size: 14px; } #g-routine .rx-c { font-size: 13px; padding: 4px 0; } #g-routine .rx-t tbody th, #g-routine .rx-t thead th:first-child { width: 90px; } #g-routine .rx-t thead th:nth-child(2) { width: auto; }
  #g-routine .hx-find { display: block; }
  #g-routine .rx-mgrid { grid-template-columns: 1fr 1fr; gap: 32px; } #g-routine .rx-mins { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
}`;

  function render(ctx) {
    const { t, lang, date } = ctx, fmt = L.fmt, num = (x, d) => fmt.num(x, lang, d), es = lang === 'es';
    /* R2.8: stored values keep their full precision in the locale format (0.0001 → 0,0001; 1250.5 ml → 1,2505 l). */
    const places = (v) => { const [m, e] = String(Math.abs(v)).split('e'); return Math.min(20, Math.max(0, (m.split('.')[1] ?? '').length - Number(e ?? 0))); };
    const nv = (v) => num(v, places(v));
    const litres = (ml) => num(ml / 1000, Math.min(20, Math.max(1, places(ml) + 3))).replace(new RegExp('(\\' + (es ? ',' : '.') + '\\d*?)0+$'), '$1').replace(/[.,]$/, (s) => s + '0') + ' l';
    const hm = (m) => { m = Math.round(m); const H = Math.floor(m / 60), x = m % 60; return H ? H + (es ? ' h ' : 'h ') + String(x).padStart(2, '0') : x + (es ? ' min' : 'm'); };
    const art = (m) => (es ? (Math.floor(((Math.round(m) % 1440) + 1440) % 1440 / 60) === 1 ? 'la ' : 'las ') : '') + clock(m);   // "la 01:10", "las 08:00"
    const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
    const pct = (x) => num(Math.round(x * 100)) + (es ? ' %' : '%');
    const full = ctx.root.clientWidth || 340, desk = typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches;
    const W = (cols) => Math.max(280, Math.round((desk ? (full + 16) * cols / 12 - 16 : full) - 40));
    const line = (text, cls) => h('p', { class: cls ?? 'hx-sub', text });
    const card = (cls, title, sub, body, foot) => HT.ins.card({ cls, title, sub, body, foot, footCls: 'hx-note sx-foot' });
    const wd3 = t('ru.wd3').split(' '), wdP = t('ru.wdP').split(' '), names = t('ins.wk.names').split(' ');
    const join = (xs) => xs.length > 1 ? xs.slice(0, -1).join(', ') + t('ru.and') + xs[xs.length - 1] : xs[0] ?? '';

    /* through: the last date each source covers; a write dated after it leaves it cached (R2.3). The profile does not follow logs. */
    const sql = (name, key, through = (d) => d) => ctx.source(name, { tool: 'health_sql', through, input: (d) => ({ query: rtQueries(d)[key] }) });
    const sA = sql('rtEvA', 'evA'), sB = sql('rtEvB', 'evB', (d) => L.shiftDate(d, -28)), sD = sql('rtDays', 'days');
    const prof = ctx.source('rtProf', { tool: 'health_profile', through: L.shiftDate(ctx.today, -1), input: () => ({}) }), cat = ctx.source('trackers');
    const PAST = { cache: { staleTime: 86400000, gcTime: 7 * 86400000 } };   // a past day's hourly steps do not change
    const stepSrc = Array.from({ length: 15 }, (_, i) => { const d = L.shiftDate(date, -i); return [d, ctx.source('rtSt:' + d, { tool: 'health_intraday', through: d, watch: d < ctx.today ? PAST : null, input: () => ({ metric: 'steps', date: d, resolution: '1h' }) })]; });
    const ev = rtEvents(sA.data, sB.data, date), nights = rtNights(sD.data);
    /* One fresh element per card (a node cannot sit in two cards): the loading/error state, else the partial note (R2.7). */
    const evMissing = () => sA.state('ruEv', 3) ?? sB.state('ruEv', 3) ?? line(t('ru.partial'));
    const nMissing = () => sD.state('ruDays', 3) ?? line(t('ru.partial'));
    const stale = () => [sA.stale('ruEv'), sD.stale('ruDays')];
    const trName = (id) => { const c = (cat.data?.trackers ?? []).find((x) => x?.id === id); if (c && typeof c.name === 'string' && c.name) return c.name; const k = L.trackerKey(id); return k ? t('trk.' + k) : String(id); };
    const nodeName = (k) => k.startsWith('mood_') ? t('ru.mood.' + k.slice(5)) : SUPP.includes(k) ? trName(k) : t('ru.n.' + k);
    const isToday = date === ctx.today;

    /* 1. Tu día tipo. */
    const typ = nights ? rtTypical(nights, ev, date) : null;
    const sumBody = !nights ? [nMissing()] : typ.learning ? [HT.ins.learning(ctx, typ.n, typ.need, { unit: 'nights' })] : (() => {
      const lead = [typ.cig != null ? t('ru.typ.cig', { w: art(typ.wake), d: hm(typ.cig) }) : t('ru.typ.wake', { w: art(typ.wake) }), typ.bed != null ? t('ru.typ.bed', { b: art(typ.bed) }) : null].filter(Boolean).join(' ');
      const sub = [typ.dev ? t('ru.typ.' + typ.dev, { w: clock(typ.today.wake) }) + (typ.today.cig != null ? t('ru.typ.cigT', { c: clock(typ.today.cig) }) : '') + '.' : null,
        typ.weekend != null ? t(typ.weekend > 0 ? 'ru.typ.weLate' : 'ru.typ.weEarly', { d: hm(Math.abs(typ.weekend)) }) : null].filter(Boolean);
      return [line(lead, 'hx-lead'), sub.length ? line(sub.join(' ')) : null, !ev ? evMissing() : null];
    })();
    const sum = h('section', { class: 'hx-sum' }, h('p', { class: 'met-l', text: t('ru.typ') }), sumBody, sD.stale('ruDays'));

    /* 2. Clave: four rows; value, strip (usual band) and "habitual". */
    const strip = (v, r) => {
      if (!finite(v) || r.learning != null) return h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }), finite(v) ? h('i', { class: 'hx-dot', style: 'left:50%;background:var(--ink)' }) : null);
      const pad = (r.high - r.low) || Math.abs(r.median) * .1 || 1, a = Math.min(v, r.low) - pad, b = Math.max(v, r.high) + pad, P = (x) => r1((x - a) / (b - a) * 100);
      return h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }), h('i', { class: 'hx-band', style: 'left:' + P(r.low) + '%;width:' + r1(P(r.high) - P(r.low)) + '%' }), h('i', { class: 'hx-dot', style: 'left:' + P(v) + '%;background:var(--ink)' }));
    };
    const keyBody = !nights ? nMissing() : (() => {
      const k = Object.fromEntries(rtKey(nights, ev ?? { list: [], first: {}, logged: new Set(), s: L.shiftDate(date, -55) }, date).map((r) => [r.id, r]));
      const when = (id) => t(id === 'cafBed' ? (isToday ? 'ru.k.yday' : 'ru.k.eve') : isToday ? 'ru.k.today' : 'ru.k.that');
      const row = (id) => { const r = k[id];
        return h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: t('ru.k.' + id) }), strip(r.v, r.r), h('span', { class: 'hx-v', text: finite(r.v) ? hm(r.v) : '—' }),
          h('span', { class: 'hx-s', text: !ev ? null : r.r.learning != null ? t('ru.k.learn', { k: r.r.learning, w: when(id) }) : t('ru.k.usual', { r: hm(r.r.low) + '–' + hm(r.r.high), w: when(id) }) })); };
      const b = k.bed;
      return [!ev ? evMissing() : null, row('cig'), row('caf'), row('cafBed'),
        h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: t('ru.k.bed') }), strip(b.dot, b.r), h('span', { class: 'hx-v', text: finite(b.v) ? '±' + hm(b.v) : '—' }),
          h('span', { class: 'hx-s', text: finite(b.v) ? t('ru.k.sd') : t('ru.k.learn', { k: 7 - b.n, w: t('ru.k.sd') }) }))];
    })();
    const key = h('section', { class: 'hx-key' }, keyBody);

    /* 3. A qué horas (C6): ridgeline, weekday chips per card (AC5). */
    const ridgeBox = h('div', {});
    const drawRidge = () => {
      if (!ev) return ridgeBox.replaceChildren(evMissing());
      const sel = HT.sel.get('rutina:ridge') ?? null, rd = rtRidge(ev, nights, date, sel), Wd = W(12);
      const G = Wd < 500 ? 118 : 150, RH = 54, T0 = 14, n = rd.rows.length, H = T0 + n * RH + 28, X = (m) => r1(G + (m - 360) / 1440 * (Wd - G - 10)), o = [];
      if (rd.sleep) {
        const b = m6(rd.sleep.bed), w = m6(rd.sleep.wake), band = (a, z) => o.push('<rect x="' + X(a) + '" y="' + (T0 - 6) + '" width="' + r1(Math.max(0, X(z) - X(a))) + '" height="' + (n * RH + 6) + '" fill="var(--band)"/>');
        if (b > w) { band(b, 1800); band(360, w); o.push(lab((X(b) + X(1800)) / 2, T0 + 4, t('ru.r.sleep'), { a: 'middle', s: 10 })); } else { band(b, w); o.push(lab((X(b) + X(w)) / 2, T0 + 4, t('ru.r.sleep'), { a: 'middle', s: 10 })); }
      }
      for (let m = 540; m < 1800; m += 180) o.push('<path d="M' + X(m) + ' ' + (T0 - 6) + 'V' + (T0 + n * RH) + '" stroke="var(--line)" stroke-width="1"/>');
      const fv = (r, v) => r.k === 'water' ? num(v / 1000, 1) + ' l' : num(v, 1);
      rd.rows.forEach((r, i) => {
        const base = T0 + (i + 1) * RH - 8, top = RH - 14, [fill, edge] = RCOL[r.k];
        const path = (p, sc = 1) => p.map((y, j) => X(360 + j * 9) + ' ' + r1(base - y * top * sc));
        if (!r.learning && sel == null) o.push('<path d="M' + X(360) + ' ' + base + ' L' + path(r.pts).join(' L') + ' L' + X(1800) + ' ' + base + ' Z" fill="var(--' + fill + ')" fill-opacity=".55" stroke="var(--' + edge + ')" stroke-width="1.5" stroke-linejoin="round"/>');
        if (!r.learning && sel != null) {
          if (!r.selLearning) o.push('<path d="M' + X(360) + ' ' + base + ' L' + path(r.sel).join(' L') + ' L' + X(1800) + ' ' + base + ' Z" fill="var(--' + fill + ')" fill-opacity=".55" stroke="var(--' + edge + ')" stroke-width="1.5" stroke-linejoin="round"/>');
          o.push('<path d="M' + path(r.all).join(' L') + '" fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-dasharray="3 3"/>');
        }
        o.push('<path d="M' + X(360) + ' ' + base + 'H' + X(1800) + '" stroke="var(--line-strong)" stroke-width="1"/>');
        if (!r.learning && sel == null && r.peak != null) { const p = Math.floor(r.peak / 60) * 60; o.push(lab(X(m6(r.peak)), base - top - 3, clock(p) + '–' + clock(p + 60), { a: 'middle', s: 10, mono: true, c: 'var(--ink)' })); }
        if (sel == null) for (const m of r.today) o.push('<path d="M' + X(m6(m)) + ' ' + (base + 2) + 'V' + (base + 7) + '" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>');
        o.push('<g transform="translate(16 ' + (base - 12) + ') scale(.95)" stroke-linecap="round" stroke-linejoin="round">' + inner(r.k) + '</g>');
        o.push(lab(30, base - 20, t('ru.r.' + r.k), { s: 12, c: 'var(--ink)', w: '600' }));
        if (r.learning) o.push(lab(30, base - 7, t('ru.r.few'), { s: 10 }));
        else if (sel == null) { o.push(lab(30, base - 7, t('ru.r.day', { v: fv(r, r.rate) }), { s: 10 }), lab(30, base + 5, r.more != null ? t('ru.r.more', { d: wd3[r.more] }) : t('ru.r.same'), { s: 10 })); }
        else { o.push(lab(30, base - 7, r.selRate != null && !r.selLearning ? t('ru.r.on', { v: fv(r, r.selRate), d: wd3[sel] }) : t('ru.r.few'), { s: 10, c: 'var(--ink)' }), lab(30, base + 5, t('ru.r.avg', { v: t('ru.r.day', { v: fv(r, r.rate) }) }), { s: 10 })); }
      });
      for (let m = 360; m <= 1800; m += 180) o.push(lab(X(m), H - 6, clock(m).slice(0, 2), { a: 'middle', s: 10, mono: true }));
      const ok = rd.rows.filter((r) => !r.learning);
      const text = sel == null
        ? [ok.length ? t('ru.r.peaks', { x: join(ok.map((r) => t('ru.r.at', { n: lower(t('ru.r.' + r.k)), t: art(r.peak) }))) }) : null, rd.busiest != null ? t('ru.r.busy', { d: wdP[rd.busiest] }) : null].filter(Boolean).join(' ')
        : (() => { const s = ok.filter((r) => r.selRate != null && !r.selLearning); return s.length ? t('ru.r.sel', { d: names[sel].charAt(0).toUpperCase() + names[sel].slice(1), x: s.map((r) => t('ru.r.selIt', { n: lower(t('ru.r.' + r.k)), a: fv(r, r.selRate), b: fv(r, r.rate) })).join('; ') }) : t('ru.r.selFew', { d: wdP[sel] }); })();
      const had = ridgeBox.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
      const key = (st, k) => h('span', {}, h('i', { style: st }), k);
      ridgeBox.replaceChildren(HT.ins.chips(ctx, sel, (i) => { HT.sel.set('rutina:ridge', i); drawRidge(); }),
        h('div', { html: '<svg viewBox="0 0 ' + Wd + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('ru.r.aria') + (text ? ' ' + text : '')) + '">' + o.join('') + '</svg>' }),
        h('div', { class: 'hx-legend' }, h('span', { text: t('ru.r.legend') }), sel != null ? key('width:16px;height:0;border-top:2px dashed var(--ink);border-radius:0', t('ru.r.allDays')) : key('width:2px;height:8px;border-radius:0;background:var(--ink)', t('ru.r.today')),
          rd.sleep ? key('width:14px;height:10px;border-radius:2px;background:var(--band)', t('ru.r.band')) : null),
        ...(text ? [line(text, 'hx-sub hx-sep')] : []), ...(nights ? [] : [nMissing()]));   // the sleep band needs the nights (R2.7)
      if (had) ridgeBox.querySelector('[data-fk="' + had + '"]')?.focus();
    };
    drawRidge();
    const ridge = card('rx-typ', t('ru.r.t'), t('ru.r.s'), [ridgeBox, ...stale()]);

    /* 4. Qué lleva a qué (C7), with the causation note (R2.15, AC7). */
    const ch = ev && nights ? rtChains(ev, nights, date) : [];   // Despertar comes from the nights: no ranking without them (R2.7)
    const chBody = !ev ? [evMissing()] : !nights ? [nMissing()] : !ch.length ? [HT.ins.learning(ctx, [...ev.logged].filter((d) => within(d, date, 30)).length, 5, { what: t('ru.c.what') })]
      : ch.map((r) => h('div', { class: 'rx-ch' }, h('span', { class: 'rx-chn' }, h('span', { class: 'hx-gl', html: gsvg(r.a) }), h('span', { text: nodeName(r.a) }), h('span', { class: 'rx-arr', text: '→' }),
        h('span', { class: 'hx-gl', html: gsvg(r.b) }), h('span', { text: lower(nodeName(r.b)) })),
        h('span', { class: 'hx-v', text: pct(r.share) }), h('div', { class: 'hx-bar' }, h('i', { style: 'width:' + r1(r.share * 100) + '%;background:var(--ink)' })),
        h('span', { class: 'hx-s', text: t('ru.c.row', { d: hm(r.delay), x: r.k === r.n ? t('ru.c.all', { n: r.n }) : t('ru.c.of', { k: r.k, n: r.n }) }) })));
    const chain = HT.ins.card({ cls: 'rx-chain', title: t('ru.c.t'), sub: t('ru.r.s'), body: [...chBody, sA.stale('ruEv'), line(t('ru.c.foot'), 'hx-note sx-foot'), ch.length ? line(t('ru.c.note'), 'hx-note') : null] });

    /* 5. Cambios (I1): behaviours (D3) and bedtime, on known days only (R2.9). */
    const chgRows = ev && nights ? { columns: ['local_date', 'bedtime_local', 'cigarettes', 'caffeine_mg', 'alcohol_g', 'water'],
      rows: Array.from({ length: 56 }, (_, i) => { const d = L.shiftDate(date, -i); return [d, nights.get(d)?.bedtime_local ?? null, total(ev, d, ['cigarettes']), total(ev, d, ['caffeine']), total(ev, d, ['alcohol']), total(ev, d, ['water'])]; }) } : null;
    /* Without both reads the shared card would say "no lasting changes": show the state or the partial note instead (R2.7). */
    const chg = chgRows ? HT.ins.changes(ctx, { metrics: ['cigarettes', 'caffeine', 'alcohol', 'water', 'bedtime'], rows: chgRows })
      : HT.ins.card({ cls: 'rx-chg', title: t('ins.chg.title'), sub: t('ins.chg.sub'), body: [!ev ? evMissing() : nMissing()] });

    /* 6. Días como hoy (I3, Rutina). */
    const steps = Object.fromEntries(stepSrc.map(([d, s]) => [d, s.data?.truncated ? null : s.data?.points ?? null]));
    const min = isToday ? ctx.min : 1440;
    /* Every hourly read must be complete: a truncated or failed day shows the partial note; one still loading shows its state (R2.7). */
    const stBad = stepSrc.some(([, s]) => s.error || s.data?.truncated), stWait = stepSrc.map(([, s]) => s).find((s) => s.data == null && !s.error);
    const alike = !ev || !nights || stBad || stWait ? card('ix-alike', t('ins.alike.title'), null, [!ev ? evMissing() : !nights ? nMissing() : stBad ? line(t('ru.partial')) : stWait.state('ruSteps', 3) ?? line(t('ru.partial'))]) : (() => {
      const f = rtAlike(ev, nights, steps, date, min), sl = L.typicalRange({ columns: ['local_date', 'v'], rows: [...nights].map(([d, r]) => [d, r.sleep_min]) }, 'v', date);
      const tx = f.today, mood = Object.keys(tx).find((k) => k.startsWith('m_') && tx[k] === 1);
      const what = [finite(tx.caffeine) ? t('ru.al.caf', { n: nv(tx.caffeine) }) : null, finite(tx.cigarettes) ? t('ru.al.cig', { n: nv(tx.cigarettes) }) : null,
        finite(tx.steps) ? t('ru.al.steps', { n: num(Math.round(tx.steps)) }) : null, mood ? lower(t('ru.mood.' + mood.slice(2))) : null].filter(Boolean).join(' · ');
      return HT.ins.alike(ctx, { W: W(7), features: f, outcome: { fmt: hm, band: sl.learning == null ? [sl.low, sl.high] : null,
        lead: (res) => t(isToday ? 'ru.al.lead' : 'ru.al.day', { t: clock(min), x: what, d: res.days.map((d) => fmt.day(d.date, lang)).join(', ') }),
        foot: (res) => { const hv = res.days.map((d) => d.hrv).filter(finite), st = L.rangeStatus(res.mean, sl);
          return t('ru.al.out', { m: hm(res.mean) }) + (st === 'below' ? t('ru.al.below') : st === 'above' ? t('ru.al.above') : '') + (hv.length ? t('ru.al.hrv', { v: num(mean(hv)) }) : '') + '. ' + t('ru.al.note'); } } });
    })();

    /* 7. Hallazgos de rutina (I4): behaviour × mood or bedtime. */
    const find = HT.ins.findings(ctx, { title: t('ru.f.t'), filter: (f) => { const m = f.ref?.key?.metric; return m === 'bedtime' || (typeof m === 'string' && m.startsWith('mood_')); } });

    /* 8. Día a día: 14 / 30 toggle; a row opens Hoy on that date (click, Enter or Space). */
    const dayBox = h('div', {});
    const drawDays = () => {
      const span = HT.sel.get('rutina:span') ?? 14, had = dayBox.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
      const seg = h('div', { class: 'hx-ctl' }, h('div', { class: 'hx-seg hx-seg-s', role: 'group', 'aria-label': t('ru.d.seg') }, [14, 30].map((n) => h('button', { type: 'button', 'data-fk': 'ru-span-' + n, 'aria-pressed': String(n === span),
        onclick: () => { HT.sel.set('rutina:span', n); drawDays(); } }, t('ru.d.n', { n })))));
      if (!ev) return dayBox.replaceChildren(seg, evMissing());
      const tb = rtTable(ev, nights, date, span);
      const cell = (v, m, tok, txt) => { const a = finite(v) && v > 0 && m > 0 ? Math.round((.08 + .4 * Math.min(1, v / m)) * 100) : 0;
        return h('td', {}, h('span', { class: 'rx-c', style: a ? 'background:color-mix(in srgb, var(--' + tok + ') ' + a + '%, transparent)' : null, text: txt })); };
      const C = [['sleep', 'm-deep', (v) => hm(v)], ['caffeine', 'fill-caffeine', nv], ['cigarettes', 'm-cig', nv], ['alcohol', 'fill-alcohol', nv], ['water', 'fill-water', litres]];
      const colName = { sleep: t('ru.d.sleep'), caffeine: t('ru.n.caffeine'), cigarettes: t('ru.r.cigarettes'), alcohol: t('ru.r.alcohol'), water: t('ru.r.water') };
      const open = (d) => ctx.navigate(d, 'today');
      const body = tb.rows.map((r) => h('tr', { class: [r.we ? 'is-we' : '', r.date === date ? 'is-today' : ''].join(' ').trim() || null, tabindex: '0', 'data-fk': 'ru-d-' + r.date,
        'aria-label': t('ru.d.open', { d: fmt.wday(r.date, lang) }), onclick: () => open(r.date), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.date); } } },
        h('th', { text: r.date === ctx.today ? t('ru.d.today') : fmt.wday(r.date, lang) }), C.map(([k, tok, f]) => cell(r[k], tb.max[k], tok, r[k] == null ? '—' : f(r[k]))),
        h('td', {}, r.mood ? h('span', { class: 'rx-md', style: 'background:var(--mood-' + r.mood.slice(5) + ')', title: t('ru.mood.' + r.mood.slice(5)) }) : null)));
      dayBox.replaceChildren(seg, h('table', { class: 'rx-t' },
        h('thead', {}, h('tr', {}, h('th', { text: t('ru.d.day') }), h('th', { text: t('ru.d.sleep') }), ['caffeine', 'cigarettes', 'alcohol', 'water'].map((k) => h('th', { html: gsvg(k), 'aria-label': t('ru.r.' + k) })), h('th', { text: t('ru.d.mood') }))),
        h('tbody', {}, body),
        h('tfoot', {}, h('tr', { class: 'rx-avg' }, h('th', { text: t('ru.d.avg') }), C.map(([k]) => h('td', { text: tb.mean[k] == null ? '—' : k === 'sleep' ? hm(tb.mean[k]) : k === 'water' ? num(tb.mean[k] / 1000, 1) + ' l' : num(tb.mean[k], tb.mean[k] < 10 ? 1 : 0) })), h('td', {})))),
        ...(nights ? [] : [nMissing()]),
        line(t('ru.d.note') + (C.some(([k]) => tb.cnt[k]) ? t('ru.d.den', { x: C.filter(([k]) => tb.cnt[k]).map(([k]) => lower(colName[k]) + ' ' + tb.cnt[k]).join(', ') }) : ''), 'hx-note'));
      if (had) dayBox.querySelector('[data-fk="' + had + '"]')?.focus();
    };
    drawDays();
    const dayCard = card('rx-days', t('ru.d.t'), t('ru.d.s', { n: HT.sel.get('rutina:span') ?? 14 }), [dayBox, ...stale()]);

    /* 9. Agua: 14 bars against the goal from the profile. */
    const goalKnown = prof.data != null || !!prof.error;   // until the profile answers, no goal claim (a failed read keeps the documented 2 l default)
    const goal = L.waterGoal(prof.data), gl =num(goal / 1000, goal % 1000 ? 1 : 0) + ' l';
    const water = card('rx-water', t('ru.w.t'), t('ru.w.s'), !ev ? [evMissing()] : (() => {
      const w = rtWater(ev, date, goal), Wd = W(6), G = 40, H = 140, T0 = 10, B = 110, mx = Math.max(goal * 1.5, ...w.days.map((d) => d.v ?? 0)), bw = (Wd - G - 8) / 14;
      const Y = (v) => r1(B - Math.max(0, v) / mx * (B - T0)), X = (i) => r1(G + i * bw), o = [];
      w.days.forEach((d, i) => { if (d.v == null) return; const last = i === 13 && isToday;
        o.push('<rect x="' + r1(X(i) + 2) + '" y="' + Y(d.v) + '" width="' + r1(bw - 4) + '" height="' + r1(B - Y(d.v)) + '" rx="2" fill="var(--fill-water)" opacity="' + (d.v >= goal ? 1 : .45) + '"' + (last ? ' fill-opacity=".3" stroke="var(--m-water)" stroke-dasharray="3 2"' : '') + '/>'); });
      if (goalKnown) o.push('<path d="M' + G + ' ' + Y(goal) + 'H' + (Wd - 8) + '" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 3"/>', lab(G - 6, Y(goal) + 4, gl, { a: 'end', s: 10, mono: true }),
        lab(G - 6, Y(goal / 2) + 4, num(goal / 2000, goal % 2000 ? 1 : 0) + ' l', { a: 'end', s: 10, mono: true }));
      o.push(lab(X(0), H - 6, fmt.wday(w.days[0].date, lang), { s: 10 }), lab(X(13) + bw, H - 6, isToday ? t('ru.d.today') : fmt.wday(date, lang), { a: 'end', s: 10 }));
      const svg = h('div', { html: '<svg viewBox="0 0 ' + Wd + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('ru.w.aria', { g: gl })) + '">' + o.join('') + '</svg>' });
      if (w.learning) return [svg, HT.ins.learning(ctx, w.n, 7, { what: t('ru.w.what') })];
      if (!goalKnown) return [svg, prof.state('ruProf', 3)];
      const split = w.am != null ? ' ' + t('ru.w.am', { p: pct(w.am) }) + (w.pm < .1 ? t('ru.w.pm') : '') + '.' : '';
      return [svg, line(t(w.k ? 'ru.w.sum' : 'ru.w.none', { g: gl, k: w.k, n: w.n, m: num(w.mean / 1000, 1) + ' l' }) + split, 'hx-sub hx-sep')];
    })());

    /* 10. Suplementos: k of the known days (learning under 7), usual time and the 14-day strip; a sentence only from a matching active finding (AC7, AC8). */
    const sp = rtSupps(ev, date), fl = (Array.isArray(ctx.source('findings').data?.findings) ? ctx.source('findings').data.findings : []).filter((f) => f?.status === 'active');
    const sf = fl.find((f) => sp.some((r) => r.id === f.ref?.key?.behavior));
    const supp = card('rx-supp', t('ru.s.t'), t('ru.s.s'), !ev ? [evMissing()] : [
      ...(sp.length ? sp.map((r) => h('div', { class: 'rx-sp' }, h('span', { class: 'hx-n', text: trName(r.id) }), h('div', { class: 'rx-cells', 'aria-hidden': 'true' }, r.cells.map((x) => h('i', { class: x ? 'on' : null }))),
        h('span', { class: 'hx-v', text: r.learning ? t('ru.r.few') : r.k + '/' + r.den }), h('span', { class: 'hx-s', text: r.time != null ? t('ru.s.at', { t: clock(r.time) }) : t('ru.s.few') }))) : [line(t('ru.s.none'))]),
      sf ? h('div', { class: 'hx-sub hx-sep' }, h('p', { class: 'hx-sub', text: String(sf.statement ?? '') }),
        h('p', { class: 'hx-note', text: [finite(sf.result?.n_a) && finite(sf.result?.n_b) ? t('ins.find.n', { a: sf.result.n_a, b: sf.result.n_b }) : null, t('ins.find.note')].filter(Boolean).join(' · ') })) : null]);

    /* 11. Ánimo: how much, when, and up to 3 lines (the time-of-day peak, then health_scan rows with n and the causation note). */
    const scD = ctx.source('scan').data, mo = rtMoods(ev, date), scan = scD?.truncated ? [] : rtScan(scD);   // a truncated scan list may omit the rows: no scan line (R2.7)
    const mood = card('rx-mood', t('ru.m.t'), ev ? (mo.total === 1 ? t('ru.m.s1') : t('ru.m.s', { n: mo.total })) : t('ru.r.s'), !ev ? [evMissing()] : !mo.total ? [line(t('ru.m.none'))] : (() => {
      const Wd = W(6), G = 8, H = 92, T0 = 8, B = 64, end = Math.max(1440, Math.ceil(Math.max(...mo.pts.map((p) => m6(p.min))) / 180) * 180), X = (m) => r1(G + (m - 360) / (end - 360) * (Wd - 16)), o = [];
      for (let m = 540; m < end; m += 180) o.push('<path d="M' + X(m) + ' ' + (T0 - 4) + 'V' + (B + 6) + '" stroke="var(--line)" stroke-width="1"/>');
      mo.pts.forEach((p, i) => o.push('<circle cx="' + X(m6(p.min)) + '" cy="' + (T0 + 6 + (i * 37) % (B - 2 - T0 - 6)) + '" r="5" fill="var(--mood-' + p.face + ')" stroke="var(--fill-edge)" stroke-width=".8"/>'));
      for (let m = 360; m <= end; m += 180) o.push(lab(X(m), H - 6, clock(m).slice(0, 2), { a: m === 360 ? 'start' : m === end ? 'end' : 'middle', s: 10, mono: true }));
      const lis = [mo.peak ? h('li', {}, h('span', { class: 'hx-gl', html: gsvg('mood_' + mo.peak.face) }), h('div', {}, h('b', { text: t('ru.m.peak.' + mo.peak.part, { m: t('ru.mood.' + mo.peak.face) }) }), line(t('ru.m.peakN', { k: mo.peak.k, n: mo.peak.n })))) : null,
        ...scan.map((r) => h('li', {}, h('span', { class: 'hx-gl', html: gsvg(r.metric === 'mood_tired' ? 'mood_cansado' : 'mood_estresado') }),
          h('div', {}, h('b', { text: t(r.more ? 'ru.m.more' : 'ru.m.less', { m: t('ru.m.' + r.metric), b: t('ru.b.' + r.behavior) }) }),
            line([t('ins.find.n', { a: r.n_a, b: r.n_b }), t('ins.lab.' + r.label.replace('ó', 'o')), t('ins.find.note')].join(' · ')))))].filter(Boolean);
      return [h('div', { class: 'rx-mgrid' },
        h('div', {}, h('p', { class: 'met-l', text: t('ru.m.how') }), h('div', { class: 'sx-stack rx-mbar', 'aria-hidden': 'true' }, mo.counts.map((c) => h('i', { style: 'flex:' + c.n + ';background:var(--mood-' + c.face + ')' }))),
          h('div', { class: 'rx-ms' }, mo.counts.map((c) => h('span', { class: 'rx-m' }, h('i', { style: 'background:var(--mood-' + c.face + ')' }), t('ru.mood.' + c.face), h('b', { text: String(c.n) }))))),
        h('div', {}, h('p', { class: 'met-l', text: t('ru.m.when') }), h('div', { html: '<svg viewBox="0 0 ' + Wd + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('ru.m.aria')) + '">' + o.join('') + '</svg>' }))),
        lis.length ? h('ul', { class: 'sx-list rx-mins' }, lis) : null, scD?.truncated ? line(t('ru.partial'), 'hx-note') : null];
    })());

    /* Board order (R2.15): Hallazgos comes last in the DOM and sits in row 4 on desktop. */
    HT.ins.layout(ctx.root, [[sum, 1, 1, 7], [key, 1, 7, 13], [ridge, 2, 1, 13], [chain, 3, 1, 7], [chg, 3, 7, 13], [alike, 4, 1, 8],
      [dayCard, 5, 1, 13], [water, 6, 1, 7], [supp, 6, 7, 13], [mood, 7, 1, 13], [find, 4, 8, 13]]);
  }

  HT.registerTab('rutina', { copy, css, logic: { rtQueries, rtEvents, rtNights, rtTypical, rtKey, rtRidge, rtChains, rtTable, rtWater, rtSupps, rtMoods, rtScan, rtAlike }, render });
})();
