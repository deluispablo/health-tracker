/* Sueño (boards S-*, spec "Sueño"). Markup, CSS and SVG geometry ported from gen/sleep.py; every value comes from the owner's data. */
(() => {
  const L = window.HTLogic, h = HT.h, finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const med = (v) => { const s = v.slice().sort((a, b) => a - b), i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const hh = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };   // minute of the day → HH:MM
  /* Clock times on one night scale: minutes after 18:00 of the evening (01:30 → 450), so a bedtime after midnight sorts after one before it. */
  const b18 = (s) => { const m = L.localMinutes(s); return m == null ? null : (m + 360) % 1440; };
  const w18 = (s) => { const m = L.localMinutes(s); return m == null ? null : m + 360; };
  const SU_SLEEP = ['sleep_min', 'deep_min', 'rem_min', 'light_min', 'awake_min', 'deep_pct', 'rem_pct', 'efficiency', 'latency_min', 'awakenings', 'bedtime'];

  /* Two health_sql reads for 60 nights (R2.6). Dates come from shiftDate, always YYYY-MM-DD.
     nights: one row per wake date; awake_min from the main session, naps = naps that date.
     eve: per night, events on a scale of minutes after 06:00 of the day before waking (t), against the bedtime bt on that scale:
     alcohol 18:00 → bed (t 720), cigarettes 22:00 → bed (t 960) and [bed − 2 h, bed), the last coffee before bed; logs = events of the day before
     and f_* each tracker's first log date (R2.9). */
  function suQueries(date) {
    const a = L.shiftDate(date, -60), a1 = L.shiftDate(date, -61);
    return {
      nights: "SELECT d.local_date, d.sleep_min, d.sleep_eff, d.sleep_latency_min, d.deep_min, d.bedtime_local, d.waketime_local, d.hrv_rmssd, d.steps," +
        " (SELECT s.awake_min FROM v_sleep s WHERE s.local_date = d.local_date AND s.is_nap = 0 ORDER BY s.minutes_in_bed DESC LIMIT 1) AS awake_min," +
        " (SELECT COUNT(*) FROM v_sleep s WHERE s.local_date = d.local_date AND s.is_nap = 1) AS naps" +
        " FROM v_daily d WHERE d.local_date BETWEEN '" + a + "' AND '" + date + "' ORDER BY d.local_date",
      eve: "WITH b AS (SELECT local_date AS n, (CAST(substr(bedtime_local, 1, 2) AS INTEGER) * 60 + CAST(substr(bedtime_local, 4, 2) AS INTEGER) + 1080) % 1440 AS bt" +
        " FROM v_daily WHERE local_date BETWEEN '" + a + "' AND '" + date + "' AND bedtime_local IS NOT NULL)," +
        " e AS (SELECT k, v, CASE WHEN m >= 360 THEN date(d, '+1 day') ELSE d END AS n, CASE WHEN m >= 360 THEN m - 360 ELSE m + 1080 END AS t" +
        " FROM (SELECT tracker_id AS k, value AS v, local_date AS d, ((ts + tz_offset_min * 60) % 86400) / 60 AS m FROM v_events" +
        " WHERE tracker_id IN ('alcohol', 'caffeine', 'cigarettes') AND local_date BETWEEN '" + a1 + "' AND '" + date + "'))" +
        " SELECT b.n, b.bt, (SELECT COUNT(*) FROM v_events x WHERE x.local_date = date(b.n, '-1 day')) AS logs," +
        " (SELECT MIN(local_date) FROM v_events WHERE tracker_id = 'alcohol') AS f_alc, (SELECT MIN(local_date) FROM v_events WHERE tracker_id = 'caffeine') AS f_caf," +
        " (SELECT MIN(local_date) FROM v_events WHERE tracker_id = 'cigarettes') AS f_cig," +
        " SUM(CASE WHEN e.k = 'alcohol' AND e.t >= 720 THEN e.v END) AS alc, MAX(CASE WHEN e.k = 'alcohol' AND e.t >= 720 THEN e.t END) AS alc_t," +
        " MAX(CASE WHEN e.k = 'caffeine' THEN e.t END) AS caf_t, SUM(CASE WHEN e.k = 'cigarettes' AND e.t >= 960 THEN e.v END) AS cig22," +
        " SUM(CASE WHEN e.k = 'cigarettes' AND e.t >= b.bt - 120 THEN e.v END) AS cig2, MAX(CASE WHEN e.k = 'cigarettes' AND e.t >= b.bt - 120 THEN e.t END) AS cig_t" +
        " FROM b LEFT JOIN e ON e.n = b.n AND e.t < b.bt GROUP BY b.n, b.bt ORDER BY b.n"
    };
  }
  /* health_sql {columns, rows} → objects; null when absent or truncated (R2.7: no claim on a partial result). */
  function suRows(res) {
    if (!res || res.truncated || !Array.isArray(res.rows) || !Array.isArray(res.columns)) return null;
    return res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
  }
  /* C4 (R2.12): observed nights of the last 60 with sleep and HRV (ms), score z(sleep) + z(hrv) (population SD, 0 when flat);
     cohort 10, or round(n/6) under 60 nights; learning under 30. Ties: the most recent night first. Evening means use known evenings only (R2.9);
     steps and naps are those of the day before the night; times are minutes of the day. */
  function suBestWorst(nights, eve, date) {
    const from = L.shiftDate(date, -59), by = new Map((nights ?? []).map((r) => [r.local_date, r])), ev = new Map((eve ?? []).map((r) => [r.n, r]));
    const obs = (nights ?? []).filter((r) => r.local_date >= from && r.local_date <= date && finite(r.sleep_min) && finite(r.hrv_rmssd));
    if (obs.length < 30) return { learning: true, n: obs.length, need: 30 };
    const z = (k) => { const v = obs.map((r) => r[k]), m = mean(v), sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))); return (x) => sd ? (x - m) / sd : 0; };
    const zs = z('sleep_min'), zh = z('hrv_rmssd'), k = obs.length >= 60 ? 10 : Math.round(obs.length / 6);
    const scored = obs.map((r) => ({ r, s: zs(r.sleep_min) + zh(r.hrv_rmssd) }));
    const pick = (dir) => scored.slice().sort((a, b) => dir * (b.s - a.s) || b.r.local_date.localeCompare(a.r.local_date)).slice(0, k).map((x) => x.r);
    const of = (v) => v.filter(finite);
    /* An evening is known for a tracker when the day before waking has any log and is on or after that tracker's first log; unknown evenings are left out, never zero. */
    const sum = (rows) => {
      const e = rows.map((r) => ev.get(r.local_date)).filter(Boolean);
      const known = (f) => e.filter((x) => x.logs > 0 && typeof x[f] === 'string' && L.shiftDate(x.n, -1) >= x[f]);
      const avg = (f, k) => { const v = known(f).map((x) => x[k] ?? 0); return [v.length ? mean(v) : null, v.length]; };
      const prev = rows.map((r) => by.get(L.shiftDate(r.local_date, -1))).filter(Boolean), caf = of(e.map((x) => x.caf_t)), steps = of(prev.map((r) => r.steps));
      const naps = prev.filter((r) => finite(r.naps)), beds = rows.map((r) => b18(r.bedtime_local)).filter((x) => x != null), [alc, alcN] = avg('f_alc', 'alc'), [cig22, cigN] = avg('f_cig', 'cig22');
      return { dates: rows.map((r) => r.local_date), alc, alcN, cig22, cigN, caf: caf.length ? (med(caf) + 360) % 1440 : null, cafN: caf.length,
        steps: steps.length ? mean(steps) : null, stepsN: steps.length, naps: naps.length ? naps.filter((r) => r.naps > 0).length : null, napsOf: naps.length,
        bed: beds.length ? (med(beds) + 1080) % 1440 : null, bedN: beds.length };
    };
    return { learning: false, n: obs.length, k, best: sum(pick(1)), worst: sum(pick(-1)) };
  }
  /* I2 sleep variant: per weekday of the evening (wake date − 1), the medians of bedtime, wake time (18:00 scale) and duration over the 56 days
     to the date, with at least 3 complete nights. The latest and the shortest are named only beyond the 28-day usual half-width (G5). */
  function suWeek(nights, date) {
    const from = L.shiftDate(date, -55), per = Array.from({ length: 7 }, () => []), all = [];
    for (const r of nights ?? []) {
      const b = b18(r.bedtime_local), w = w18(r.waketime_local);
      if (r.local_date < from || r.local_date > date || b == null || w == null || !finite(r.sleep_min)) continue;
      per[L.weekday(L.shiftDate(r.local_date, -1))].push([b, w, r.sleep_min]); all.push([r.local_date, b, r.sleep_min]);
    }
    const days = per.map((v) => v.length >= 3 ? { bed: med(v.map((x) => x[0])), wake: med(v.map((x) => x[1])), dur: med(v.map((x) => x[2])), n: v.length } : null);
    const valid = [0, 1, 2, 3, 4, 5, 6].filter((i) => days[i]);
    if (!valid.length) return { learning: true, n: all.length, need: 21, counts: per.map((v) => v.length) };
    const half = (k) => { const r = L.typicalRange({ columns: ['local_date', 'bed', 'dur'], rows: all }, k, date); return r.learning != null ? Infinity : (r.high - r.low) / 2; };
    const late = valid.reduce((a, i) => days[i].bed > days[a].bed ? i : a), short = valid.reduce((a, i) => days[i].dur < days[a].dur ? i : a);
    return { days, counts: per.map((v) => v.length), late, short,
      lateClear: valid.length >= 2 && days[late].bed - mean(valid.map((i) => days[i].bed)) > half('bed'),
      shortClear: valid.length >= 2 && mean(valid.map((i) => days[i].dur)) - days[short].dur > half('dur') };
  }
  /* Últimas noches: `span` nights to the date on the 18:00 scale; usual windows are typicalRange of bed and wake;
     the weekend shift is the median bedtime of nights waking on Saturday or Sunday minus the others', with 2 of each, named beyond 30 min. */
  function suDiary(nights, date, span) {
    const by = new Map((nights ?? []).map((r) => [r.local_date, r]));
    const tbl = { columns: ['local_date', 'bed', 'wake'], rows: (nights ?? []).map((r) => [r.local_date, b18(r.bedtime_local), w18(r.waketime_local)]) };
    const rows = Array.from({ length: span }, (_, i) => { const d = L.shiftDate(date, i - span + 1), r = by.get(d);
      return { date: d, bed: r ? b18(r.bedtime_local) : null, wake: r ? w18(r.waketime_local) : null, dur: finite(r?.sleep_min) ? r.sleep_min : null }; });
    const durs = rows.map((r) => r.dur).filter(finite), we = (r) => L.weekday(r.date) >= 5;
    const a = rows.filter((r) => r.bed != null && we(r)).map((r) => r.bed), b = rows.filter((r) => r.bed != null && !we(r)).map((r) => r.bed);
    const shift = a.length >= 2 && b.length >= 2 ? med(a) - med(b) : null;
    return { rows, n: durs.length, mean: durs.length ? mean(durs) : null, bedR: L.typicalRange(tbl, 'bed', date), wakeR: L.typicalRange(tbl, 'wake', date),
      weekend: shift != null && Math.abs(shift) > 30 ? shift : null };
  }
  /* Qué pudo influir: the evening row of that night; rows with no log are omitted. A row carries a finding only when an active one pairs
     that behaviour with a sleep metric or HRV; a drink is 10 g (R2.8), shown to 0.1. */
  function suInfluence(e, findings) {
    if (!e || !finite(e.bt)) return [];
    const list = (findings ?? []).filter((f) => f?.status === 'active' && [...SU_SLEEP, 'hrv'].includes(f.ref?.key?.metric));
    const row = (k, t, extra) => ({ k, at: hh(t + 360), before: e.bt - t, finding: list.find((f) => f.ref.key.behavior === k) ?? null, ...extra });
    // a log exists when its time does; stored zero, negative and fractional values are shown as stored (R2.8)
    return [finite(e.alc_t) ? row('alcohol', e.alc_t, { drinks: r1((e.alc ?? 0) / 10) }) : null,
      finite(e.cig_t) ? row('cigarettes', e.cig_t, { count: e.cig2 ?? 0 }) : null,
      finite(e.caf_t) ? row('caffeine', e.caf_t) : null].filter(Boolean);
  }

  const copy = {
    'su.last': ['Last night', 'Anoche'], 'su.nightOf': ['Night of {d}', 'Noche del {d}'],
    'su.none': ['No sleep recorded that night.', 'Sin sueño registrado esa noche.'],
    'su.lead': ['You slept {d}.', 'Dormiste {d}.'], 'su.lead.below': ['You slept {d}, less than usual.', 'Dormiste {d}, menos de lo habitual.'],
    'su.lead.above': ['You slept {d}, more than usual.', 'Dormiste {d}, más de lo habitual.'], 'su.lead.in': ['You slept {d}, within your usual.', 'Dormiste {d}, dentro de lo habitual.'],
    'su.bed.same': ['You went to bed at your usual time.', 'Te acostaste a tu hora de siempre.'],
    'su.bed.late': ['You went to bed {d} later than usual.', 'Te acostaste {d} más tarde que de costumbre.'],
    'su.bed.early': ['You went to bed {d} earlier than usual.', 'Te acostaste {d} antes que de costumbre.'],
    'su.awake': ['{d} awake during the night.', '{d} despierto durante la noche.'],
    'su.ph.ok': ['Stages within your usual.', 'Fases dentro de lo habitual.'], 'su.ph.out': ['Outside your usual: {x}.', 'Fuera de lo habitual: {x}.'],
    'su.below': ['below', 'por debajo'], 'su.above': ['above', 'por encima'],
    'su.k.asleep': ['Asleep', 'Dormido'], 'su.k.eff': ['Efficiency', 'Eficiencia'], 'su.k.lat': ['Falling asleep', 'En dormirte'],
    'su.usual': ['usual {r}', 'habitual {r}'], 'su.usualIn': ['your usual in {k} more nights', 'tu habitual, en {k} noches más'],
    'su.span': ['{a} → {b}', '{a} → {b}'], 'su.ctx': ['{a} → {b} · {d} asleep', '{a} → {b} · {d} dormido'],
    'su.night.t': ['The night', 'La noche'],
    'su.st.DEEP': ['Deep', 'Profundo'], 'su.st.REM': ['REM sleep', 'REM'], 'su.st.LIGHT': ['Light', 'Ligero'], 'su.st.AWAKE': ['Awake', 'Despierto'], 'su.pulse': ['Pulse', 'Pulso'],
    'su.tip': ['{x}: {a}–{b}, {d}', '{x}: {a}–{b}, {d}'],
    'su.keys': ['Sleep stages. Use the arrow keys to go through them; Esc closes.', 'Fases del sueño. Usa las flechas para recorrerlas; Esc cierra.'],
    'su.partialHr': ['Partial pulse: some readings from that night are missing.', 'Pulso incompleto: faltan medidas de esa noche.'],
    'su.partial': ['Partial data: some records are missing, so nothing is concluded here.', 'Datos incompletos: faltan registros, así que aquí no se saca ninguna conclusión.'],
    'su.night.aria': ['Sleep stages from {a} to {b} and pulse during the night.', 'Fases del sueño de {a} a {b} y pulso durante la noche.'],
    'su.night.note': ['Tap a stage to see its time and how long it lasted. Stages are the watch’s estimate.', 'Toca una fase para ver la hora y cuánto duró. Las fases son una estimación del reloj.'],
    'su.nap.t': ['Nap', 'Siesta'], 'su.today': ['today, {d}', 'hoy, {d}'], 'su.inBed': ['{a} → {b} · {d} in bed', '{a} → {b} · {d} en cama'],
    'su.napMore': ['+{n} naps', '+{n} siestas'], 'su.napMore1': ['+1 nap', '+1 siesta'],
    'su.nap.aria': ['Nap stages from {a} to {b}.', 'Fases de la siesta de {a} a {b}.'],
    'su.ph.t': ['Stages', 'Fases'], 'su.ph.s': ['vs your 28 nights', 'frente a tus 28 noches'], 'su.ph.usual': ['usual {a}–{b} min', 'habitual {a}–{b} min'],
    'su.ph.learn': ['usual in {k} more nights', 'habitual en {k} noches más'],
    'su.inf.t': ['What may have played a part', 'Qué pudo influir'], 'su.inf.s': ['yesterday evening', 'la tarde de ayer'], 'su.inf.s2': ['the evening before', 'la tarde anterior'],
    'su.inf.alc1': ['One drink at {t}', 'Una copa a las {t}'], 'su.inf.alcN': ['{n} drinks, the last at {t}', '{n} copas, la última a las {t}'],
    'su.inf.cig1': ['One cigarette at {t}', 'Un cigarro a las {t}'], 'su.inf.cigN': ['{n} cigarettes, the last at {t}', '{n} cigarros, el último a las {t}'],
    'su.inf.caf': ['Last coffee at {t}', 'Último café a las {t}'], 'su.inf.before': [', {d} before sleep.', ', {d} antes de dormir.'],
    'su.inf.cafFact': ['Had {d} before sleep.', 'Tomado {d} antes de dormir.'], 'su.inf.none': ['No alcohol, cigarettes or coffee logged before bed.', 'Sin alcohol, cigarros ni café registrados antes de dormir.'],
    'su.inf.noBed': ['No bedtime for that night yet.', 'Aún no hay hora de acostarte esa noche.'],
    'su.inf.foot': ['They go together in your data; they do not prove cause.', 'Van juntos en tus datos; no prueban causa.'], 'su.inf.see': ['See in Findings', 'Ver en Hallazgos'],
    'su.hours': ['{n} h', '{n} h'], 'su.mins': ['{n} min', '{n} min'],
    'su.bw.t': ['Before your best and worst nights', 'Antes de tus mejores y peores noches'], 'su.bw.s': ['{k} and {k} of {n}', '{k} y {k} de {n}'],
    'su.bw.h': ['the evening before', 'la tarde anterior'], 'su.bw.best': ['best', 'mejores'], 'su.bw.worst': ['worst', 'peores'],
    'su.bw.alc': ['Alcohol', 'Alcohol'], 'su.bw.caf': ['Last coffee', 'Último café'], 'su.bw.cig': ['Cigarettes after 22:00', 'Cigarros tras las 22:00'],
    'su.bw.steps': ['Steps', 'Pasos'], 'su.bw.nap': ['Nap', 'Siesta'], 'su.bw.bed': ['Bedtime', 'Hora de acostarte'],
    'su.bw.drinks': ['{n} drinks', '{n} copas'], 'su.bw.n': ['{a} and {b} nights with data', '{a} y {b} noches con datos'], 'su.bw.kof': ['{k} of {n}', '{k} de {n}'],
    'su.bw.foot': ['Best and worst by hours asleep and HRV. They go together; they do not prove cause.', 'Mejores y peores por horas dormidas y VFC. Van juntos, no prueban causa.'],
    'su.wk.both': ['On {a} you go to bed latest ({ta}); {b} is your shortest night ({db}).', 'El {a} te acuestas más tarde ({ta}); el {b} es tu noche más corta ({db}).'],
    'su.wk.late': ['On {a} you go to bed latest ({ta}).', 'El {a} te acuestas más tarde ({ta}).'],
    'su.wk.short': ['{b} is your shortest night ({db}).', 'El {b} es tu noche más corta ({db}).'],
    'su.wk.sel': ['{d}: usually {a} → {b}, {x} asleep ({n} nights).', '{d}: normalmente {a} → {b}, {x} dormido ({n} noches).'],
    'su.wk.few': ['{d}: few nights yet ({n}).', '{d}: aún pocas noches ({n}).'],
    'su.dia.t': ['Recent nights', 'Últimas noches'], 'su.dia.s': ['from bed to getting up', 'de acostarte a levantarte'], 'su.dia.seg': ['Period', 'Periodo'],
    'su.dia.n': ['{n} nights', '{n} noches'], 'su.dia.asleep': ['Asleep', 'Dormido'], 'su.dia.band': ['Your usual schedule', 'Tu horario habitual'],
    'su.dia.sum': ['Average {a} over {n} nights', 'Media {a} en {n} noches'],
    'su.dia.usual': [' · you usually go to bed between {a} and {b} and get up between {c} and {d}.', ' · te acuestas normalmente entre {a} y {b} y te levantas entre {c} y {d}.'],
    'su.dia.wkLate': ['At weekends, {d} later.', 'Los fines de semana, {d} más tarde.'], 'su.dia.wkEarly': ['At weekends, {d} earlier.', 'Los fines de semana, {d} antes.'],
    'su.dia.aria': ['Bed to wake for the last {n} nights.', 'De acostarte a levantarte en las últimas {n} noches.'],
    'su.find.t': ['Sleep findings', 'Hallazgos de sueño'],
    'card.suSleep': ['your nights', 'tus noches'], 'card.suNights': ['the last 60 nights', 'las últimas 60 noches'], 'card.suEve': ['your evening logs', 'tus registros de la tarde']
  };

  /* Log glyphs, the watch shapes (gen/sleep.py glyph()). */
  const SURF = 'var(--surface)';
  const filled = (shape, c) => '<g fill="' + SURF + '" stroke="' + SURF + '" stroke-width="2.2">' + shape + '</g><g fill="' + c + '" stroke="var(--fill-edge)" stroke-width=".9" paint-order="stroke">' + shape + '</g>';
  const GL = {
    caffeine: filled('<ellipse rx="4.2" ry="5.6"/>', 'var(--fill-caffeine)') + '<path d="M0 -4.6Q-2 -2.3 0 0Q2 2.3 0 4.6" fill="none" stroke="var(--on-fill-caffeine)" stroke-width="1.2"/>',
    cigarettes: '<path d="M0 -7V7" stroke="' + SURF + '" stroke-width="6.6"/><path d="M0 -7V7" stroke="var(--m-cig)" stroke-width="3"/>',
    alcohol: filled('<path d="M-4.6 -6.4H4.6V-3.2A4.6 4.6 0 0 1-4.6 -3.2Z"/>', 'var(--fill-alcohol)') + '<path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="' + SURF + '" stroke-width="3.8"/><path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="var(--m-alcohol)" stroke-width="1.6"/>'
  };
  const glyph = (k) => '<svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true" focusable="false"><g transform="' + (k === 'cigarettes' ? '' : 'scale(1.25)') + '" stroke-linecap="round" stroke-linejoin="round">' + GL[k] + '</g></svg>';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const lab = (x, y, s, anchor, size, mono) => '<text x="' + x + '" y="' + y + '" text-anchor="' + (anchor || 'start') + '" font-size="' + (size || 11) + '" fill="var(--muted)" font-family="var(--font-' + (mono ? 'mono' : 'sans') + ')" stroke="' + SURF + '" stroke-width="3" paint-order="stroke">' + esc(s) + '</text>';
  const LV = { AWAKE: 0, REM: 1, LIGHT: 2, DEEP: 3 }, COL = { AWAKE: 'm-awake', REM: 'm-rem', LIGHT: 'm-light', DEEP: 'm-deep' };

  const css = `
.hx-key .hx-row:first-child { border-top: 0; padding-top: 0; } .hx-key .hx-row:last-child { padding-bottom: 0; }
.hx-time svg { margin: 4px 0 8px; }
.sx-fig { position: relative; border-radius: var(--radius-sm); } .sx-fig:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; } .sx-fig [data-hit] { cursor: pointer; }
.sx-tip { position: absolute; z-index: 2; transform: translate(-50%, -100%); padding: 6px 8px; border-radius: var(--radius-sm); background: var(--ink); color: var(--surface); font-size: 12px; line-height: 16px; white-space: nowrap; pointer-events: none; }
.sx-big { margin: 0; font: 500 28px/34px var(--font-sans); letter-spacing: -.02em; } .sx-nap svg { margin-top: 12px; }
.sx-nap .hx-sep { margin-top: auto; }
.sx-stack { display: flex; height: 16px; border-radius: var(--radius-full); overflow: hidden; gap: 2px; margin: 4px 0 12px; } .sx-stack i { display: block; }
.sx-phs { display: grid; }
.sx-ph { display: grid; grid-template-columns: 12px 1fr auto 44px; gap: 2px 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.sx-ph .hx-s { grid-column: 2 / -1; } .sx-sw { width: 12px; height: 12px; border-radius: 3px; }
.ix-bw .sx-n { display: block; font-size: 12px; line-height: 16px; color: var(--muted); }
.sx-pct { font: 400 13px/18px var(--font-mono); color: var(--muted); text-align: right; }
.sx-link { min-height: 44px; padding: 0; border: 0; background: none; color: var(--primary); font: inherit; font-weight: var(--w-strong); cursor: pointer; }
.sx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.sx-list li { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; font-size: 14px; line-height: 20px; }
.sx-list b { font-weight: var(--w-strong); } .sx-list .hx-sub { margin-top: 2px; }
.sx-rows { display: grid; gap: 6px; margin: 4px 0 12px; }
.sx-d { display: grid; grid-template-columns: 52px 1fr 54px; gap: 10px; align-items: center; }
.sx-dd { font-size: 12px; color: var(--muted); white-space: nowrap; } .sx-dv { font: 400 12px/16px var(--font-mono); text-align: right; white-space: nowrap; }
.sx-d.is-today .sx-dd, .sx-d.is-today .sx-dv { color: var(--ink); font-weight: var(--w-strong); }
.sx-dt { position: relative; height: 14px; } .sx-dt i { position: absolute; display: block; }
.sx-win { top: 0; bottom: 0; border-radius: 3px; background: var(--band); }
.sx-db { top: 3px; height: 8px; border-radius: var(--radius-full); background: var(--m-deep); opacity: .55; }
.sx-d.is-today .sx-db { opacity: 1; }
.sx-axl { display: flex; justify-content: space-between; font: 11px/14px var(--font-mono); color: var(--muted); }
@media (min-width: 1200px) {
  .hx-key { display: flex; flex-direction: column; justify-content: center; }
  .sx-d { grid-template-columns: 72px 1fr 64px; } .sx-rows { gap: 8px; }
}`;

  function render(ctx) {
    const { t, lang, date } = ctx, fmt = L.fmt, num = (x, d) => fmt.num(x, lang, d);
    const hm = (m) => { m = Math.round(m); const H = Math.floor(m / 60), x = m % 60; return H ? H + (lang === 'es' ? ' h ' : 'h ') + String(x).padStart(2, '0') : x + (lang === 'es' ? ' min' : 'm'); };
    const ago = (m) => m >= 60 ? t('su.hours', { n: Math.round(m / 60) }) : t('su.mins', { n: Math.max(0, Math.round(m)) });
    const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches;
    const card = (cls, title, sub, body, foot) => HT.ins.card({ cls, title, sub, body, foot, footCls: 'hx-note hx-sep sx-foot' });
    const line = (text, cls) => h('p', { class: cls ?? 'hx-sub', text });
    /* through: the last date each source covers; a write dated after it leaves it cached (R2.3). */
    const sql = (name, key) => ctx.source(name, { tool: 'health_sql', through: (d) => d, input: (d) => ({ query: suQueries(d)[key] }) });

    const sl = ctx.source('slsleep'), nightsSrc = sql('suNights', 'nights'), eveSrc = sql('suEve', 'eve'), finds = ctx.source('findings');
    const hrA = ctx.source('suHrA', { tool: 'health_intraday', through: (d) => L.shiftDate(d, -1), input: (d) => ({ metric: 'hr', date: L.shiftDate(d, -1), resolution: '5m', from: '18:00' }) });
    const hrB = ctx.source('suHrB', { tool: 'health_intraday', through: (d) => d, input: (d) => ({ metric: 'hr', date: d, resolution: '5m', to: '12:00' }) });
    /* A gate is the card's own state element (loading, error) or, for a truncated source, the partial note (R2.7); null when the data is whole.
       Called once per card: a DOM element can sit in one card only. */
    const gate = (src, k) => () => src.state(k, 3) ?? (src.data?.truncated ? line(t('su.partial')) : null);
    const slGate = gate(sl, 'suSleep'), nGate = gate(nightsSrc, 'suNights'), eGate = gate(eveSrc, 'suEve');
    const sessions = sl.data && !sl.data.truncated ? (sl.data.sessions ?? []) : [], s = L.mainSession(sessions, date);
    const nights = suRows(nightsSrc.data), eves = suRows(eveSrc.data), findList = Array.isArray(finds.data?.findings) ? finds.data.findings : [];
    const FIELDS = ['minutes_asleep', 'efficiency', 'latency_min', 'deep_min', 'rem_min', 'light_min', 'awake_min'];
    const tbl = L.sleepTable(sessions, FIELDS), rng = (f, w) => L.typicalRange(tbl, f, date, w);
    const bedTbl = { columns: ['local_date', 'bed'], rows: tbl.rows.map((r) => { const m = L.mainSession(sessions, r[0]); return [r[0], b18(m?.start_local)]; }) };
    const times = s ? { a: s.start_local.slice(11, 16), b: s.end_local.slice(11, 16) } : null;
    const STG = [['DEEP', 'deep_min'], ['REM', 'rem_min'], ['LIGHT', 'light_min'], ['AWAKE', 'awake_min']];

    /* 1. Resumen: duration vs usual and the bedtime shift (within 15 min = "your usual time"); sub line: awake time and any stage out of p10–p90. */
    const sumGate = slGate(), sumBody = sumGate ? [sumGate] : !s ? [line(t('su.none'), 'hx-lead')] : (() => {
      const r = rng('minutes_asleep'), st = L.rangeStatus(s.minutes_asleep, r), br = L.typicalRange(bedTbl, 'bed', date), bed = b18(s.start_local);
      const lead = [t(finite(s.minutes_asleep) ? (st === 'none' ? 'su.lead' : 'su.lead.' + st) : 'su.none', { d: hm(s.minutes_asleep ?? 0) })];
      if (br.learning == null && bed != null) { const d = bed - br.median; lead.push(t(Math.abs(d) < 15 ? 'su.bed.same' : d > 0 ? 'su.bed.late' : 'su.bed.early', { d: hm(Math.abs(d)) })); }
      const out = STG.map(([k, f]) => [k, L.rangeFlag(s[f], rng(f, true))]).filter((x) => x[1]), known = STG.every(([, f]) => rng(f).learning == null);
      const sub = [finite(s.awake_min) ? t('su.awake', { d: hm(s.awake_min) }) : null,
        out.length ? t('su.ph.out', { x: out.map(([k, fl]) => t('su.st.' + k).toLowerCase() + ' ' + t('su.' + fl)).join(', ') }) : known ? t('su.ph.ok') : null].filter(Boolean);
      return [line(lead.join(' '), 'hx-lead'), sub.length ? line(sub.join(' ')) : null];
    })();
    const sum = h('section', { class: 'hx-sum' }, h('p', { class: 'met-l', text: date === ctx.today ? t('su.last') : t('su.nightOf', { d: fmt.wday(date, lang) }) }), sumBody, sl.stale('suSleep'));

    /* 2. Clave: value, strip (band p25–p75, scale padded by the band width) and "habitual". */
    const strip = (v, r) => {
      if (!finite(v)) return h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }));
      if (r.learning != null) return h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }), h('i', { class: 'hx-dot', style: 'left:50%;background:var(--ink)' }));
      const pad = (r.high - r.low) || Math.abs(r.median) * .1 || 1, a = Math.min(v, r.low) - pad, b = Math.max(v, r.high) + pad, P = (x) => r1((x - a) / (b - a) * 100);
      return h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }), h('i', { class: 'hx-band', style: 'left:' + P(r.low) + '%;width:' + r1(P(r.high) - P(r.low)) + '%' }),
        h('i', { class: 'hx-dot', style: 'left:' + P(v) + '%;background:var(--ink)' }));
    };
    const pct = (x) => num(x) + (lang === 'es' ? ' %' : '%');
    const krow = (name, f, show, showR, pre) => { const v = s?.[f], r = rng(f);
      return h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: name }), strip(v, r), h('span', { class: 'hx-v', text: finite(v) ? show(v) : '—' }),
        h('span', { class: 'hx-s', text: (pre ?? '') + (r.learning != null ? t('su.usualIn', { k: r.learning }) : t('su.usual', { r: showR(r) })) })); };
    const key = h('section', { class: 'hx-key' }, slGate() ?? (!s ? line(t('su.none')) : [
      krow(t('su.k.asleep'), 'minutes_asleep', hm, (r) => hm(r.low) + '–' + hm(r.high), t('su.span', times) + ' · '),
      krow(t('su.k.eff'), 'efficiency', pct, (r) => num(r.low) + '–' + pct(r.high)),
      krow(t('su.k.lat'), 'latency_min', hm, (r) => num(r.low) + '–' + num(r.high) + (lang === 'es' ? ' min' : 'm'))]));

    /* Hypnogram rows (sleep.py hyp()); x in night minutes. Returns the markup and the phases as marks {x0, x1, y, tip} in viewBox units. */
    const hyp = (g, X, H0) => {
      const o = [], marks = [];
      let prev = null;
      for (const bar of g.bars) {
        const a = g.bed + bar.a, b = g.bed + bar.b, y = H0 + LV[bar.stage] * 18;
        if (prev != null) o.push('<path d="M' + X(a) + ' ' + (H0 + prev * 18 + 6) + 'V' + (y + 6) + '" stroke="var(--line-strong)" stroke-width="1"/>');
        o.push('<rect x="' + X(a) + '" y="' + y + '" width="' + Math.max(1.5, r1(X(b) - X(a))) + '" height="12" rx="2" fill="var(--' + COL[bar.stage] + ')"/>');
        marks.push({ x0: X(a), x1: X(b), y, tip: t('su.tip', { x: t('su.st.' + bar.stage), a: L.clock(a), b: L.clock(b), d: hm(bar.b - bar.a) }) });
        prev = LV[bar.stage];
      }
      for (const k of L.STAGES) o.push(lab(8, H0 + LV[k] * 18 + 10, t('su.st.' + k), 'start', 10));
      return { o, marks };
    };
    /* G10 and ruling 6: the chart is one tab stop; arrows (Home/End) move between phases, Esc hides the tip. A tap or hover anywhere on the chart,
       whose transparent hit band is at least 44 px tall, selects the phase nearest the pointer's x. */
    let tipN = 0;
    const tipFig = (svg, marks, W, fk) => {   // fk: a stable focus key, so a redraw keeps focus on the chart (ruling 8)
      const id = 'su-tip-' + (++tipN), fig = h('div', { class: 'sx-fig', html: svg, tabindex: '0', role: 'group', 'data-fk': fk, 'aria-label': t('su.keys'), 'aria-describedby': marks.length ? id : null }),
        tip = h('div', { class: 'sx-tip', id, role: 'tooltip', 'aria-live': 'polite', hidden: true });
      if (marks.length) fig.append(tip);   // no marks, no tooltip (ruling 2)
      let cur = -1;
      const show = (i) => { if (!marks.length) return; cur = Math.max(0, Math.min(marks.length - 1, i)); const m = marks[cur], b = fig.getBoundingClientRect(), k = b.width / W;
        tip.textContent = m.tip; tip.hidden = false;
        tip.style.left = Math.min(Math.max((m.x0 + m.x1) / 2 * k, 70), b.width - 70) + 'px'; tip.style.top = (m.y * k - 4) + 'px'; };
      const hide = () => { tip.hidden = true; };
      const near = (e) => { const b = fig.getBoundingClientRect(), x = (e.clientX - b.left) * W / b.width, d = (m) => Math.max(m.x0 - x, 0, x - m.x1);
        show(marks.reduce((best, m, i) => d(m) < d(marks[best]) ? i : best, 0)); };
      fig.addEventListener('pointerdown', near); fig.addEventListener('pointermove', near);
      fig.addEventListener('keydown', (e) => {
        const to = { ArrowRight: cur + 1, ArrowDown: cur + 1, ArrowLeft: cur - 1, ArrowUp: cur - 1, Home: 0, End: marks.length - 1, Enter: Math.max(cur, 0), ' ': Math.max(cur, 0) }[e.key];
        if (e.key === 'Escape') hide(); else if (to != null) { e.preventDefault(); show(to); }
      });
      fig.addEventListener('pointerleave', hide); fig.addEventListener('focusout', hide);
      return fig;
    };

    /* 3. La noche (sleep.py night()): bed − 30 min to wake + 30 min, hour grid, stages, the night pulse in 5-min ticks. */
    const g = s ? L.hypnogram(s) : null;
    const nightGate = slGate(), nightBody = nightGate ? [nightGate] : !g || !g.bars.length ? [line(t('su.none'))] : (() => {
      const W = wide ? 680 : 326, A = g.bed - 30, B = g.wake + 30, G = 64, HY0 = 14, PB = 140, PH = 40, AX = 156, Hh = 162;
      const X = (m) => r1(G + (m - A) / (B - A) * (W - G - 8)), o = [], ticks = [];
      for (let m = Math.ceil(A / 60) * 60; m <= B; m += 60) { ticks.push(m); o.push('<path d="M' + X(m) + ' ' + (HY0 - 6) + 'V' + PB + '" stroke="var(--line)" stroke-width="1"/>'); }
      const hy = hyp(g, X, HY0);
      o.push(...hy.o, '<rect data-hit x="' + G + '" y="' + (HY0 - 8) + '" width="' + (W - G - 8) + '" height="' + (PB - HY0 + 8) + '" fill="transparent"/>');
      const pts = [...(hrA.data?.points ?? []), ...(hrB.data?.points ?? [])];
      for (const p of pts) {
        const m = L.localMinutes(p?.[0]), v = p?.[1];
        if (m == null || !finite(v) || v <= 0 || typeof p[0] !== 'string') continue;
        const nm = m + (p[0].slice(0, 10) === date ? 720 : -720);
        if (nm < A || nm > B) continue;
        o.push('<path d="M' + X(nm) + ' ' + PB + 'V' + r1(PB - Math.max(2, Math.min(PH, (v - 45) * PH / 40))) + '" stroke="var(--m-hr)" stroke-width="2" stroke-linecap="round" opacity=".7"/>');
      }
      o.push('<path d="M' + X(A) + ' ' + PB + 'H' + X(B) + '" stroke="var(--line)" stroke-width="1"/>', lab(8, PB - PH / 2 + 4, t('su.pulse'), 'start', 10));
      ticks.forEach((m) => o.push(lab(X(m), AX, L.clock(m).slice(0, 2), 'middle', 11, true)));
      o.push(lab(X(g.bed), HY0 - 10, times.a, 'middle', 10, true), lab(X(g.wake), HY0 - 10, times.b, 'middle', 10, true));
      const svg = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('su.night.aria', times)) + '">' + o.join('') + '</svg>';
      const key = (k, st) => h('span', {}, h('i', { style: st }), k);
      return [tipFig(svg, hy.marks, W, 'su-night'), h('div', { class: 'hx-legend' }, STG.map(([k]) => key(t('su.st.' + k), 'width:12px;height:8px;background:var(--' + COL[k] + ')')),
        key(t('su.pulse'), 'width:2px;height:10px;border-radius:0;background:var(--m-hr);opacity:.7')),
        // R2.7: a capped intraday read (e.g. a clock-change morning over 150 points) draws what came, and says the pulse is partial
        hrA.data?.truncated || hrB.data?.truncated ? line(t('su.partialHr')) : null];
    })();
    const night = card('hx-time', t('su.night.t'), s && finite(s.minutes_asleep) ? t('su.ctx', { ...times, d: hm(s.minutes_asleep) }) : null, [...nightBody, sl.stale('suSleep')], t('su.night.note'));

    /* 4. Siesta: only with a nap that date; the longest, then "+N siestas" (R2.12). */
    const naps = sessions.filter((x) => x.is_nap && x.local_date === date).sort((a, b) => (b.minutes_asleep ?? -1) - (a.minutes_asleep ?? -1) || b.start_local.localeCompare(a.start_local));
    const nap = naps.length ? (() => {
      const n = naps[0], ng = L.hypnogram(n), ab = { a: n.start_local.slice(11, 16), b: n.end_local.slice(11, 16) }, W = wide ? 300 : 326, o = [];
      let svg = null, hrNote = null;
      if (ng && !ng.bars.length) {
        /* Design review #7: real naps carry no stages. One Dormido bar from start to end, and the nap's pulse from a 5-min read of its interval only.
           shortcut: a nap across midnight reads only its start date's readings; read both days if one ever shows up. */
        const hr = ctx.source('suHrN:' + n.start_local + ':' + n.end_local, { tool: 'health_intraday', through: n.start_local.slice(0, 10), input: () => ({ metric: 'hr', date: n.start_local.slice(0, 10), resolution: '5m', from: ab.a, to: ab.b }) });
        const A = Math.floor(ng.bed / 30) * 30, B = Math.max(A + 30, Math.ceil(ng.wake / 30) * 30), X = (m) => r1(64 + (m - A) / (B - A) * (W - 72)), PB = 78, PH = 40, t0 = Date.parse(n.start_local + 'Z');
        for (let m = A + 30; m < B; m += 30) o.push('<path d="M' + X(m) + ' 2V80" stroke="var(--line)" stroke-width="1"/>');
        const asleep = t('su.k.asleep'), marks = [{ x0: X(ng.bed), x1: X(ng.wake), y: 8, tip: t('su.tip', { x: asleep, a: ab.a, b: ab.b, d: hm(ng.wake - ng.bed) }) }];
        o.push('<rect x="' + X(ng.bed) + '" y="8" width="' + Math.max(1.5, r1(X(ng.wake) - X(ng.bed))) + '" height="12" rx="2" fill="var(--m-light)"/>', lab(8, 18, asleep, 'start', 10));
        for (const p of hr.data?.points ?? []) {
          const nm = typeof p?.[0] === 'string' ? ng.bed + (Date.parse(p[0] + 'Z') - t0) / 60000 : NaN, v = p?.[1];
          // a point is a 5-min bucket [nm, nm + 5): keep any that overlaps the nap, drawn clipped to the bar
          if (!(nm + 5 > ng.bed && nm < ng.wake) || !finite(v) || v <= 0) continue;
          o.push('<path d="M' + X(Math.max(nm, ng.bed)) + ' ' + PB + 'V' + r1(PB - Math.max(2, Math.min(PH, (v - 45) * PH / 40))) + '" stroke="var(--m-hr)" stroke-width="2" stroke-linecap="round" opacity=".7"/>');
        }
        o.push('<path d="M' + X(A) + ' ' + PB + 'H' + X(B) + '" stroke="var(--line)" stroke-width="1"/>', lab(8, PB - PH / 2 + 4, t('su.pulse'), 'start', 10),
          '<rect data-hit x="64" y="2" width="' + (W - 72) + '" height="78" fill="transparent"/>');
        for (let m = A; m <= B; m += 30) o.push(lab(X(m), 98, L.clock(m), m === A ? 'start' : m === B ? 'end' : 'middle', 11, true));
        svg = tipFig('<svg viewBox="0 0 ' + W + ' 104" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('su.nap.aria', ab)) + '">' + o.join('') + '</svg>', marks, W, 'su-nap');
        if (hr.data?.truncated) hrNote = line(t('su.partialHr'));
      }
      if (ng && ng.bars.length) {
        const A = Math.floor(ng.bed / 30) * 30, B = Math.max(A + 30, Math.ceil(ng.wake / 30) * 30), X = (m) => r1(64 + (m - A) / (B - A) * (W - 72));
        for (let m = A + 30; m < B; m += 30) o.push('<path d="M' + X(m) + ' 2V80" stroke="var(--line)" stroke-width="1"/>');
        const hy = hyp(ng, X, 8);
        o.push(...hy.o, '<rect data-hit x="64" y="2" width="' + (W - 72) + '" height="78" fill="transparent"/>');
        for (let m = A; m <= B; m += 30) o.push(lab(X(m), 98, L.clock(m), m === A ? 'start' : m === B ? 'end' : 'middle', 11, true));
        svg = tipFig('<svg viewBox="0 0 ' + W + ' 104" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(t('su.nap.aria', ab)) + '">' + o.join('') + '</svg>', hy.marks, W, 'su-nap');
      }
      return card('sx-nap', t('su.nap.t'), date === ctx.today ? t('su.today', { d: fmt.wday(date, lang) }) : fmt.wday(date, lang), [
        h('p', { class: 'sx-big', text: finite(n.minutes_asleep) ? hm(n.minutes_asleep) : '—' }),
        line(t('su.inBed', { ...ab, d: hm(n.minutes_in_bed ?? 0) }) + (naps.length > 1 ? ' · ' + (naps.length === 2 ? t('su.napMore1') : t('su.napMore', { n: naps.length - 1 })) : '')), svg, hrNote]);
      // shortcut: no nap footnote, the findings engine has no nap behaviour today; add one when it does
    })() : null;

    /* 5. Fases: one stacked bar, then each stage's duration, share and usual range (pill text beyond p10–p90). */
    const phases = card('sx-phases', t('su.ph.t'), t('su.ph.s'), slGate() ?? (!s ? line(t('su.none')) : (() => {
      const vals = STG.map(([k, f]) => [k, f, finite(s[f]) ? s[f] : 0]), tot = vals.reduce((a, x) => a + x[2], 0) || 1;
      return [h('div', { class: 'sx-stack', 'aria-hidden': 'true' }, vals.map(([k, , v]) => h('i', { style: 'flex:' + v + ';background:var(--' + COL[k] + ')' }))),
        h('div', { class: 'sx-phs' }, vals.map(([k, f, v]) => { const r = rng(f), fl = L.rangeFlag(s[f], rng(f, true));
          return h('div', { class: 'sx-ph' }, h('span', { class: 'sx-sw', style: 'background:var(--' + COL[k] + ')' }), h('span', { class: 'hx-n', text: t('su.st.' + k) }),
            h('span', { class: 'hx-v', text: finite(s[f]) ? hm(v) : '—' }), h('span', { class: 'sx-pct', text: pct(Math.round(v * 100 / tot)) }),
            h('span', { class: 'hx-s', text: r.learning != null ? t('su.ph.learn', { k: r.learning }) : t('su.ph.usual', { a: num(r.low), b: num(r.high) }) + (fl ? ' · ' + t('su.' + fl) : '') })); }))];
    })()));

    /* 6. Qué pudo influir. */
    const eveRow = eves?.find((r) => r.n === date) ?? null, infl = suInfluence(eveRow, findList);
    const inflBody = !eves ? [eGate() ?? line(t('su.partial'))] : !eveRow ? [line(t('su.inf.noBed'))] : !infl.length ? [line(t('su.inf.none'))]
      : [h('ul', { class: 'sx-list' }, infl.map((r) => {
        const what = r.k === 'alcohol' ? t(r.drinks === 1 ? 'su.inf.alc1' : 'su.inf.alcN', { n: num(r.drinks, r.drinks % 1 ? 1 : 0), t: r.at })
          : r.k === 'cigarettes' ? t(r.count === 1 ? 'su.inf.cig1' : 'su.inf.cigN', { n: num(r.count, r.count % 1 ? 1 : 0), t: r.at }) : t('su.inf.caf', { t: r.at });
        const fact = r.k === 'caffeine' && !r.finding && r.before >= 480, f = r.finding?.result ?? {};
        const sub = r.finding ? String(r.finding.statement ?? '') + (finite(f.n_a) && finite(f.n_b) ? ' (' + t('ins.find.n', { a: f.n_a, b: f.n_b }) + ')' : '') : fact ? t('su.inf.cafFact', { d: ago(r.before) }) : null;
        return h('li', {}, h('span', { class: 'hx-gl', html: glyph(r.k) }), h('div', {}, h('b', { text: what }), fact ? '.' : t('su.inf.before', { d: ago(r.before) }), sub ? line(sub) : null));
      }))];
    const infl6 = HT.ins.card({ cls: 'sx-infl', title: t('su.inf.t'), sub: date === ctx.today ? t('su.inf.s') : t('su.inf.s2'), body: [...inflBody, eveSrc.stale('suEve')] });
    infl6.append(h('p', { class: 'hx-note sx-foot' }, t('su.inf.foot') + ' ', h('button', { type: 'button', class: 'sx-link', 'data-fk': 'su-find', text: t('su.inf.see'),
      onclick: () => { const f = ctx.root.querySelector('.hx-find'); f?.scrollIntoView?.({ block: 'start' }); f?.querySelector?.('h2')?.focus?.(); } })));

    /* 7. Según el día (sleep.py sl_week()): bars from the median bedtime to the median wake on a 21 → 12 axis, chips per card (AC5). */
    const dia = nights ? suDiary(nights, date, 30) : null;
    const pos = (x) => r1(Math.min(100, Math.max(0, (x - 180) / 900 * 100)));
    const band = (cls, tag) => dia && dia.bedR.learning == null && dia.wakeR.learning == null ? h(tag, { class: cls, style: 'left:' + pos(dia.bedR.low) + '%;width:' + r1(pos(dia.wakeR.high) - pos(dia.bedR.low)) + '%' }) : null;
    const AXIS = ['21', '00', '03', '06', '09', '12'];
    const weekBox = h('div', {}), names = t('ins.wk.names').split(' '), letters = t('ins.wk.letters').split(' ');
    const drawWeek = () => {
      if (!nights) return weekBox.replaceChildren(nGate() ?? line(t('su.partial')));
      const w = suWeek(nights, date);
      if (w.learning) return weekBox.replaceChildren(HT.ins.learning(ctx, w.n, w.need, { unit: 'nights' }));
      const sel = HT.sel.get('sueno:wk') ?? null, d = sel == null ? null : w.days[sel];
      const text = sel != null ? (d ? t('su.wk.sel', { d: names[sel], a: hh(d.bed + 1080), b: hh(d.wake + 1080), x: hm(d.dur), n: d.n }) : t('su.wk.few', { d: names[sel], n: w.counts[sel] }))
        : w.lateClear || w.shortClear ? t(w.lateClear && w.shortClear ? 'su.wk.both' : w.lateClear ? 'su.wk.late' : 'su.wk.short',
          { a: names[w.late], ta: hh(w.days[w.late].bed + 1080), b: names[w.short], db: hm(w.days[w.short].dur) }) : t('ins.wk.flat');
      const had = weekBox.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
      weekBox.replaceChildren(HT.ins.chips(ctx, sel, (i) => { HT.sel.set('sueno:wk', i); drawWeek(); }),
        h('div', { class: 'ix-wd', role: 'img', 'aria-label': text }, w.days.flatMap((x, i) => {
          const on = sel == null ? (i === w.late && w.lateClear) || (i === w.short && w.shortClear) : i === sel, op = sel != null && i !== sel ? 'opacity:.35;' : '';
          return [h('span', { class: 'd' + (on ? ' is-on' : ''), text: letters[i] }),
            h('div', { class: 'ix-wt' }, band(null, 'b'), x ? h('i', { class: on ? 'on' : null, style: op + 'left:' + pos(x.bed) + '%;width:' + r1(pos(x.wake) - pos(x.bed)) + '%' }) : null),
            h('span', { class: 'v' + (on ? ' is-on' : ''), text: x ? hm(x.dur) : '—' })];
        }), h('span', { class: 'ix-ax' }, AXIS.map((a) => h('span', { text: a })))),
        line(text, 'hx-sub hx-sep'));
      if (had) weekBox.querySelector('[data-fk="' + had + '"]')?.focus();
    };
    drawWeek();
    const week = HT.ins.card({ cls: 'ix-week', title: t('ins.wk.title'), sub: t('ins.wk.sub'), body: [weekBox, nightsSrc.stale('suNights')] });

    /* 8. Antes de tus mejores y peores noches (C4). */
    const bw = nights && eves ? suBestWorst(nights, eves, date) : null;
    const bwVal = { alc: (x) => t('su.bw.drinks', { n: num(x / 10, 1) }), caf: hh, cig22: (x) => num(r1(x), r1(x) % 1 ? 1 : 0), steps: (x) => num(Math.round(x)), naps: null, bed: hh };
    const BWN = { alc: 'alcN', caf: 'cafN', cig22: 'cigN', steps: 'stepsN', bed: 'bedN' };   // AC7: each row's denominators, best and worst
    const cell = (c, k) => k === 'naps' ? (c.napsOf ? t('su.bw.kof', { k: c.naps, n: c.napsOf }) : '—') : c[k] == null ? '—' : bwVal[k](c[k]);
    const bwBody = !bw ? [nGate() ?? eGate() ?? line(t('su.partial'))] : bw.learning ? [HT.ins.learning(ctx, bw.n, bw.need, { unit: 'nights' })]
      : [h('div', { class: 'ix-bw' }, h('span', { class: 'ix-h', text: t('su.bw.h') }), h('span', { class: 'ix-h num', text: t('su.bw.best') }), h('span', { class: 'ix-h num', text: t('su.bw.worst') }),
        [['alc', 'su.bw.alc'], ['caf', 'su.bw.caf'], ['cig22', 'su.bw.cig'], ['steps', 'su.bw.steps'], ['naps', 'su.bw.nap'], ['bed', 'su.bw.bed']].flatMap(([k, n]) =>
          [h('span', {}, t(n), k === 'naps' ? null : h('small', { class: 'sx-n', text: t('su.bw.n', { a: bw.best[BWN[k]], b: bw.worst[BWN[k]] }) })), h('span', { class: 'num', text: cell(bw.best, k) }), h('span', { class: 'num is-bad', text: cell(bw.worst, k) })]))];
    const bwc = HT.ins.card({ cls: 'ix-bwc', title: t('su.bw.t'), sub: bw && !bw.learning ? t('su.bw.s', { k: bw.k, n: bw.n }) : null, body: [...bwBody, nightsSrc.stale('suNights')],
      foot: bw && !bw.learning ? t('su.bw.foot') : null, footCls: 'hx-note sx-foot' });

    /* 9–10. Cambios (I1) and Hallazgos de sueño (I4). */
    // a truncated night table would make "no sustained change" a claim on missing rows (R2.7): same card, the partial note instead
    const chg = nightsSrc.data?.truncated ? HT.ins.card({ cls: 'rx-chg', title: t('ins.chg.title'), sub: t('ins.chg.sub'), body: line(t('su.partial')) })
      : HT.ins.changes(ctx, { metrics: ['bedtime', 'deep_min', 'awake_min', 'sleep_min', 'efficiency', 'latency_min'], rows: nights ? nightsSrc.data : null });
    const find = HT.ins.findings(ctx, { title: t('su.find.t'), filter: (f) => SU_SLEEP.includes(f.ref?.key?.metric) });

    /* 11. Últimas noches: 14 / 30 toggle, one bed → wake row per night over the usual window. */
    const diaBox = h('div', {});
    const drawDia = () => {
      if (!nights) return diaBox.replaceChildren(nGate() ?? line(t('su.partial')));
      const span = HT.sel.get('sueno:span') ?? 14, d = suDiary(nights, date, span), had = diaBox.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null;
      const seg = h('div', { class: 'hx-seg', role: 'group', 'aria-label': t('su.dia.seg') }, [14, 30].map((n) => h('button', { type: 'button', 'data-fk': 'su-span-' + n, 'aria-pressed': String(n === span),
        onclick: () => { HT.sel.set('sueno:span', n); drawDia(); } }, t('su.dia.n', { n }))));
      if (!d.n) { diaBox.replaceChildren(seg, HT.ins.learning(ctx, 0, 7, { unit: 'nights' })); return; }
      const usual = d.bedR.learning == null && d.wakeR.learning == null;
      const text = t('su.dia.sum', { a: hm(d.mean), n: d.n }) + (usual ? t('su.dia.usual', { a: hh(d.bedR.low + 1080), b: hh(d.bedR.high + 1080), c: hh(d.wakeR.low + 1080), d: hh(d.wakeR.high + 1080) }) : '.')
        + (d.weekend != null ? ' ' + t(d.weekend > 0 ? 'su.dia.wkLate' : 'su.dia.wkEarly', { d: hm(Math.abs(d.weekend)) }) : '');
      const key = (st, k) => h('span', {}, h('i', { style: st }), k);
      diaBox.replaceChildren(seg,
        h('div', { class: 'sx-rows', role: 'img', 'aria-label': t('su.dia.aria', { n: span }) + ' ' + text }, d.rows.map((r) => h('div', { class: 'sx-d' + (r.date === date ? ' is-today' : '') },
          h('span', { class: 'sx-dd', text: fmt.wday(r.date, lang) }),
          h('div', { class: 'sx-dt' }, band('sx-win', 'i'), r.bed != null && r.wake != null && r.wake > r.bed ? h('i', { class: 'sx-db', style: 'left:' + pos(r.bed) + '%;width:' + r1(pos(r.wake) - pos(r.bed)) + '%' }) : null),
          h('span', { class: 'sx-dv', text: r.dur != null ? hm(r.dur) : '—' }))),
          h('div', { class: 'sx-d sx-ax' }, h('span', {}), h('div', { class: 'sx-axl' }, AXIS.map((a) => h('span', { text: a }))), h('span', {}))),
        h('div', { class: 'hx-legend' }, key('width:16px;height:8px;background:var(--m-deep)', t('su.dia.asleep')), key('width:16px;height:8px;border-radius:2px;background:var(--band)', t('su.dia.band'))),
        line(text, 'hx-sub hx-sep'));
      if (had) diaBox.querySelector('[data-fk="' + had + '"]')?.focus();
    };
    drawDia();
    const diary = card('sx-diary', t('su.dia.t'), t('su.dia.s'), [diaBox, nightsSrc.stale('suNights')]);

    HT.ins.layout(ctx.root, [[sum, 1, 1, 8], [key, 1, 8, 13], [night, 2, 1, 9], [nap, 2, 9, 13], [phases, 3, 1, 6], [infl6, 3, 6, 13],
      [week, 4, 1, 7], [bwc, 4, 7, 13], [chg, 5, 1, 6], [diary, 6, 1, 13], [find, 5, 6, 13]]);   // phone order: Hallazgos last, as on the boards
  }

  HT.registerTab('sueno', { copy, css, logic: { suQueries, suRows, suBestWorst, suWeek, suDiary, suInfluence }, render });
})();
