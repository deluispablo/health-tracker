/* Hoy (boards A-*): markup and CSS ported from gen/frag.py, the strip from gen/strip4.py. Spec "Hoy", R2.4-R2.11. */
{
const COPY = {
  'hoy.sum': ['Summary', 'Resumen'],
  'hoy.sum.sleep.below': ['You slept less than usual', 'Dormiste menos de lo habitual'],
  'hoy.sum.sleep.above': ['You slept more than usual', 'Dormiste más de lo habitual'],
  'hoy.sum.sleep.in': ['You slept your usual', 'Dormiste lo habitual'],
  'hoy.sum.rec.below': ['your recovery is somewhat low', 'tu recuperación está algo baja'],
  'hoy.sum.rec.above': ['your recovery is high', 'tu recuperación está alta'],
  'hoy.sum.rec.typical': ['your recovery is as usual', 'tu recuperación está como siempre'],
  'hoy.sum.recOnly.below': ['Your recovery is somewhat low', 'Tu recuperación está algo baja'],
  'hoy.sum.recOnly.above': ['Your recovery is high', 'Tu recuperación está alta'],
  'hoy.sum.recOnly.typical': ['Your recovery is as usual', 'Tu recuperación está como siempre'],
  'hoy.sum.and': ['{a} and {b}.', '{a} y {b}.'],
  'hoy.sum.one': ['{a}.', '{a}.'],
  'hoy.sum.pace.at': ['You are on pace for steps.', 'Vas al ritmo de pasos.'],
  'hoy.sum.pace.ahead': ['You are ahead of your step pace.', 'Vas por delante del ritmo de pasos.'],
  'hoy.sum.pace.behind': ['You are behind your step pace.', 'Vas por detrás del ritmo de pasos.'],
  'hoy.sum.none': ['No data for this day yet.', 'Aún no hay datos de este día.'],
  'hoy.sum.last': ['Last night: {x}.', 'Anoche: {x}.'],
  'hoy.sum.drink': ['1 drink at {t}', '1 copa a las {t}'],
  'hoy.sum.drinks': ['{n} drinks, the last at {t}', '{n} copas, la última a las {t}'],
  'hoy.sum.cig': ['1 cigarette after 20:00', '1 cigarro después de las 20:00'],
  'hoy.sum.cigs': ['{n} cigarettes after 20:00', '{n} cigarros después de las 20:00'],
  'hoy.sum.join': ['{a} and {b}', '{a} y {b}'],
  'hoy.key.sleep': ['Sleep', 'Sueño'],
  'hoy.key.steps': ['Steps', 'Pasos'],
  'hoy.key.usual': ['usual {x}', 'habitual {x}'],
  'hoy.key.wait': ["Tonight's sleep hasn't arrived from the watch yet.", 'La noche de hoy aún no ha llegado del reloj.'],
  'hoy.key.goal': ['of {g}', 'de {g}'],
  'hoy.key.at': ['on pace', 'al ritmo'],
  'hoy.key.ahead': ['{n} ahead', '{n} por delante'],
  'hoy.key.behind': ['{n} behind', '{n} por detrás'],
  'hoy.key.azm': ['{n} active min', '{n} min activos'],
  'hoy.st.title': ['From yesterday to today', 'De ayer a hoy'],
  'hoy.st.all': ['yesterday 18:00 → {e}', 'ayer 18:00 → {e}'],
  'hoy.st.now': ['now', 'ahora'],
  'hoy.st.nowAt': ['now · {t}', 'ahora · {t}'],
  'hoy.st.yday': ['yesterday', 'ayer'],
  'hoy.st.today': ['today', 'hoy'],
  'hoy.st.win': ['{a} → {b}', '{a} → {b}'],
  'hoy.st.zoom': ['Zoom', 'Ampliar'],
  'hoy.st.whole': ['All', 'Todo'],
  'hoy.st.h12': ['12 h', '12 h'],
  'hoy.st.h6': ['6 h', '6 h'],
  'hoy.st.lane1': ['Sleep and activity', 'Sueño y actividad'],
  'hoy.st.lane2': ['Logs', 'Registros'],
  'hoy.st.lane3': ['Heart rate', 'Pulso'],
  'hoy.st.sleep': ['Sleep', 'Sueño'],
  'hoy.st.nap': ['Nap', 'Siesta'],
  'hoy.st.workout': ['Workout', 'Entreno'],
  'hoy.st.night': ['Night', 'Noche'],
  'hoy.st.pulse': ['Heart rate', 'Pulso'],
  'hoy.st.mark': ['{x} · {t}', '{x} · {t}'],
  'hoy.st.span': ['{x} {a} → {b}', '{x} {a} → {b}'],
  'hoy.st.aria': ['From yesterday 18:00 to {e}. {s}{n} logs and heart rate.', 'De ayer a las 18:00 a {e}. {s}{n} registros y pulso.'],
  'hoy.st.ariaSleep': ['Sleep from {a} to {b}. ', 'Sueño de {a} a {b}. '],
  'hoy.st.pan': ['Timeline. Enter shows a mark, up and down arrows move between marks, left and right move the window.', 'Línea de tiempo. Intro muestra una marca, las flechas arriba y abajo pasan de una a otra, izquierda y derecha mueven la ventana.'],
  'hoy.st.mini': ['Window: {a} to {b}', 'Ventana: de {a} a {b}'],
  'hoy.st.hint': ['Swipe the chart to move in time. Pinch or use the buttons to zoom.', 'Desliza la gráfica para moverte en el tiempo. Pellizca o usa los botones para ampliar.'],
  'hoy.st.foot': ['Same marks as the watch and the log buttons. Tap one to see the time.', 'Mismas marcas que el reloj y los botones de registro. Toca una para ver la hora.'],
  'hoy.trunc': ['There are more logs than fit; some are not shown.', 'Hay más registros de los que caben; algunos no aparecen.'],
  'hoy.truncH': ['Incomplete history: no comparison with your usual.', 'Historial incompleto: sin comparación con lo habitual.'],
  'hoy.rec.verdict': ['the recovery verdict', 'el veredicto de recuperación'],
  'hoy.rec.inList': ['{x} within your usual.', '{x} dentro de lo habitual.'],
  'hoy.rec.learnList': ['{x}: still learning your usual.', '{x}: aún aprendiendo lo habitual.'],
  'hoy.rec.noneList': ['{x}: no reading that night.', '{x}: sin lectura esa noche.'],
  'hoy.v.resp_rate': ['respiration', 'respiración'],
  'hoy.v.spo2_avg': ['SpO₂', 'SpO₂'],
  'hoy.v.skin_temp_dev': ['temperature', 'temperatura'],
  'hoy.list2': ['{a} and {b}', '{a} y {b}'],
  'hoy.n.alcN': [' ({n}; {note})', ' ({n}; {note})'],
  'hoy.a.s.learn': ['Sleep without a usual yet (your usual comes in {n} days)', 'Sueño sin habitual aún (tu habitual llega en {n} días)'],
  'hoy.a.note': ['These go together in your data, not proof of cause.', 'Van juntos en tus datos, no prueba causa.'],
  'hoy.w.n': ['{d} · {n} of 7 days', '{d} · {n} de 7 días'],
  'hoy.rec.title': ['Recovery', 'Recuperación'],
  'hoy.rec.typical': ['Within your usual', 'Dentro de lo habitual'],
  'hoy.rec.drv.hrv_rmssd': ['Mostly from ', 'Sobre todo por la '],
  'hoy.rec.drv.rhr': ['Mostly from ', 'Sobre todo por el '],
  'hoy.rec.hrv': ['HRV', 'VFC'],
  'hoy.rec.rhr': ['resting heart rate', 'pulso en reposo'],
  'hoy.rec.rhrRow': ['Resting heart rate', 'Pulso en reposo'],
  'hoy.rec.others': ['Respiration, SpO₂ and temperature within your usual.', 'Respiración, SpO₂ y temperatura dentro de lo habitual.'],
  'hoy.rec.below': ['{x} below your usual.', '{x} por debajo de lo habitual.'],
  'hoy.rec.above': ['{x} above your usual.', '{x} por encima de lo habitual.'],
  'hoy.n.title': ['Tonight', 'Esta noche'],
  'hoy.n.sub': ['to sleep 7 h', 'para dormir 7 h'],
  'hoy.n.word': ['Go to bed before {t}', 'Acuéstate antes de las {t}'],
  'hoy.n.why': ['You usually wake around {w} and take about {l} min to fall asleep.', 'Sueles despertarte hacia las {w} y tardas unos {l} min en dormirte.'],
  'hoy.n.plan': ['Plan: sleep from {a} to {b}', 'Plan: dormir de {a} a {b}'],
  'hoy.n.last': [' · last night you went to bed at {t}', ' · anoche te acostaste a las {t}'],
  'hoy.n.cafe': ['Last coffee {t}.', 'Último café {t}.'],
  'hoy.n.cafeOk': [' It should no longer affect your sleep.', ' Ya no debería afectar a tu sueño.'],
  'hoy.n.cafeNo': [' It is less than 8 h before sleep.', ' Queda a menos de 8 h de dormir.'],
  'hoy.n.alc0': ['No alcohol today.', 'Sin alcohol hoy.'],
  'hoy.n.alc': ['Alcohol today: {n} at {t}.', 'Alcohol hoy: {n} a las {t}.'],
  'hoy.n.alcY': [' Yesterday the drink at {t} came with a low HRV.', ' Ayer la copa de las {t} coincidió con la VFC baja.'],
  'hoy.n.nights': ['the bedtime suggestion', 'la hora de acostarte'],
  'hoy.l.title': ["Today's logs", 'Registros de hoy'],
  'hoy.l.cafe': ['Coffee', 'Café'],
  'hoy.l.cigarro': ['Cigarettes', 'Cigarros'],
  'hoy.l.agua': ['Water', 'Agua'],
  'hoy.l.alcohol': ['Alcohol', 'Alcohol'],
  'hoy.l.supl': ['Supplements', 'Suplementos'],
  'hoy.l.animo': ['Mood', 'Ánimo'],
  'hoy.l.last': ['last {t}', 'último {t}'],
  'hoy.l.yday': ['yesterday {n}', 'ayer {n}'],
  'hoy.l.hab': ['usual {n}', 'habitual {n}'],
  'hoy.l.habLearn': ['usual: learning', 'habitual: aprendiendo'],
  'hoy.l.mood': ['usually: {x}', 'suele: {x}'],
  'hoy.l.foot': ['“Usual” is what you usually have by this time of day.', '«Habitual» es lo que sueles llevar a esta hora del día.'],
  'hoy.w.title': ['This week', 'Esta semana'],
  'hoy.w.sub': ['vs the week before', 'frente a la anterior'],
  'hoy.w.cafe': ['{n} days with the last coffee before 14:00', '{n} días con el último café antes de las 14:00'],
  'hoy.w.steps': ['{n} days with more than 6,000 steps', '{n} días con más de 6.000 pasos'],
  'hoy.w.sleep': ['Sleep', 'Sueño'],
  'hoy.w.hrv': ['HRV', 'VFC'],
  'hoy.w.stepsRow': ['Steps', 'Pasos'],
  'hoy.w.cig': ['Cigarettes', 'Cigarros'],
  'hoy.w.perDay': ['{x} / day', '{x} / día'],
  'hoy.w.few': ['Not enough days yet', 'Aún pocos días'],
  'hoy.a.lead': ['{s}, {c} and {a}. This is how you slept the next night:', '{s}, {c} y {a}. Así dormiste la noche siguiente:'],
  'hoy.a.s.below': ['Little sleep', 'Poco sueño'],
  'hoy.a.s.above': ['A lot of sleep', 'Mucho sueño'],
  'hoy.a.s.in': ['Usual sleep', 'Sueño habitual'],
  'hoy.a.c0': ['no cigarettes', 'sin cigarros'],
  'hoy.a.c1': ['1 cigarette', '1 cigarro'],
  'hoy.a.c': ['{n} cigarettes', '{n} cigarros'],
  'hoy.a.a1': ['alcohol the evening before', 'alcohol la víspera'],
  'hoy.a.a0': ['no alcohol the evening before', 'sin alcohol la víspera'],
  'hoy.a.foot': ['{n} of the {k} nights you went to bed before {t}; on {m} of them you slept more than 7 h.', '{n} de las {k} noches te acostaste antes de las {t}; en {m} de ellas dormiste más de 7 h.'],
  'card.hoySum': ['the summary', 'el resumen'],
  'card.hoyStrip': ['the timeline', 'la línea de tiempo'],
  'card.hoyNight': ['tonight', 'esta noche'],
  'card.hoyLogs': ["today's logs", 'los registros de hoy'],
  'card.hoyWeek': ['this week', 'esta semana'],
  'card.hoyLike': ['similar days', 'los días parecidos']
};

/* ---- pure computations (merged into HTLogic; checked in check_hoy.py) ---- */
const L0 = window.HTLogic, fin = (v) => typeof v === 'number' && Number.isFinite(v);
const col = (t, name) => (t?.columns ?? []).indexOf(name);
const rowsOf = (t) => Array.isArray(t?.rows) ? t.rows : [];
const median = (v) => { const s = v.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const s18 = (m) => ((m - 1080) % 1440 + 1440) % 1440;   // minutes after 18:00, so bedtimes across midnight compare
const SUPP = ['melatonin', 'protein', 'creatine'];
const TILE = { caffeine: 'cafe', cigarettes: 'cigarro', water: 'agua', alcohol: 'alcohol', supp: 'supl' };
/* R2.8: count trackers sum units, amounts sum their unit, alcohol in drinks of 10 g, supplements count logs. */
const amount = (tile, evs) => tile === 'supl' ? evs.length : evs.reduce((s, e) => s + e.v, 0) / (tile === 'alcohol' ? 10 : 1);
const parse = (l) => String(l ?? '').split(',').filter(Boolean).map((x) => { const [m, v, id] = x.split(':'); return { min: Number(m), v: Number(v), id }; });

/* Glyphs no more than 20 min after the first mark of their stack stack upwards; x stays the exact time. */
function hoyStack(evs) {
  let first = null, lvl = 0;
  return (evs ?? []).slice().sort((a, b) => a.min - b.min).map((e) => {
    if (first != null && e.min - first <= 20) lvl++; else { first = e.min; lvl = 0; }
    return { ...e, lvl };
  });
}
/* The visible window inside the domain [a, b]; span null (Todo) or a span not shorter than the domain shows it whole. */
function hoyWin(a, b, span, start) {
  if (!span || span >= b - a) return { s: a, e: b };
  const s = Math.min(Math.max(start ?? b - span, a), b - span);
  return { s, e: s + span };
}
/* C2: the main-sleep nights with a wake time among the 14 dates up to the date; latency missing = 0; floor to 5 min. */
function hoyBed(daily, date) {
  const d = col(daily, 'local_date'), w = col(daily, 'waketime_local'), l = col(daily, 'sleep_latency_min'), from = L0.shiftDate(date, -13);
  const ok = rowsOf(daily).filter((r) => r[d] >= from && r[d] <= date && L0.localMinutes(r[w]) != null);
  if (ok.length < 7) return { learning: true, n: ok.length, need: 7 };
  const wake = median(ok.map((r) => L0.localMinutes(r[w]))), lat = median(ok.map((r) => fin(r[l]) ? r[l] : 0));
  return { n: ok.length, wake, lat, bed: ((Math.floor((wake - 420 - lat) / 5) * 5) % 1440 + 1440) % 1440 };
}
/* Events of the shown day and the day before, minutes from the shown day's 00:00 (yesterday is negative). */
function hoyEvents(t, date) {
  const y = L0.shiftDate(date, -1), [d, tt, k, v] = ['d', 't', 'k', 'v'].map((c) => col(t, c));
  return rowsOf(t).filter((r) => (r[d] === date || r[d] === y) && L0.localMinutes(r[tt]) != null)
    .map((r) => ({ min: L0.localMinutes(r[tt]) - (r[d] === y ? 1440 : 0), t: r[tt], k: r[k], v: Number(r[v]) })).sort((a, b) => a.min - b.min);
}
const histDays = (hist, date, k) => { const d = col(hist, 'd'), kk = col(hist, 'k'), l = col(hist, 'l'), from = L0.shiftDate(date, -28);
  return rowsOf(hist).filter((r) => r[kk] === k && r[d] >= from && r[d] < date).map((r) => ({ d: r[d], evs: parse(r[l]) })); };
/* C3: the median total by this minute (inclusive) over the last 28 days, today excluded, that have a log of that tracker. */
function hoyHab(hist, date, min) {
  const out = {};
  for (const [k, tile] of Object.entries(TILE)) {
    const days = histDays(hist, date, k);
    out[tile] = days.length < 7 ? { learning: true, n: days.length, need: 7 } : { v: median(days.map((x) => amount(tile, x.evs.filter((e) => e.min <= min)))), n: days.length };
  }
  return out;
}
/* "suele": the most-logged mood in the last 28 days, a tie to the most recent. */
const hoyMood = (hist, date) => L0.mostMood(histDays(hist, date, 'mood').flatMap((x) => x.evs.map((e) => ({ id: e.id, t: Date.parse(x.d) / 6e4 + e.min }))));
/* Days in a row, back from yesterday, whose last coffee was before 14:00 (a day without coffee breaks it); today joins once 14:00 has passed. */
function hoyCoffee(hist, todayEvs, date, min) {
  const last = new Map(histDays(hist, date, 'caffeine').map((x) => [x.d, Math.max(...x.evs.map((e) => e.min))]));
  const cafe = (todayEvs ?? []).filter((e) => e.k === 'caffeine' && e.min >= 0).map((e) => e.min);
  if (cafe.some((m) => m >= 840)) return 0;
  let n = min >= 840 && cafe.length ? 1 : 0;
  for (let d = L0.shiftDate(date, -1); last.get(d) < 840; d = L0.shiftDate(d, -1)) n++;
  return n;
}
/* Days in a row with more than 6.000 steps; an unfinished day below it does not break the streak. */
function hoyStepStreak(daily, date) {
  const d = col(daily, 'local_date'), s = col(daily, 'steps'), v = new Map(rowsOf(daily).map((r) => [r[d], r[s]]));
  let n = v.get(date) > 6000 ? 1 : 0;
  for (let x = L0.shiftDate(date, -1); v.get(x) > 6000; x = L0.shiftDate(x, -1)) n++;
  return n;
}
/* Esta semana: the 7 days to the date against the 7 before, each needing 4 known days (R2.9); an unfinished today is left out. */
function hoyWeek(series, date, skipToday) {
  const v = new Map((series ?? []).filter((p) => fin(p.v)).map((p) => [p.date, p.v]));
  const days = (a) => Array.from({ length: 7 }, (_, i) => L0.shiftDate(date, i - 6 - a));
  const spark = days(0).map((d) => v.get(d) ?? null);
  const cur = days(0).filter((d) => v.has(d) && !(skipToday && d === date)).map((d) => v.get(d)), prev = days(7).filter((d) => v.has(d)).map((d) => v.get(d));
  if (cur.length < 4 || prev.length < 4) return { learning: true, n: Math.min(cur.length, prev.length), need: 4, spark };
  return { mean: mean(cur), delta: mean(cur) - mean(prev), spark, n: cur.length };
}
/* Step pace against the expected steps by this minute; within 5 % of the goal is "at pace". */
function hoyPace(steps, min, goal) {
  if (!fin(steps)) return null;
  const d = steps - L0.expectedSteps(min, goal);
  return Math.abs(d) < goal * 0.05 ? { k: 'at', d: 0 } : { k: d > 0 ? 'ahead' : 'behind', d: Math.abs(d) };
}
/* I3 Hoy: features sleep that night, cigarettes that day, any alcohol the day before; outcome the next night's sleep and
   its bedtime. The SQL gives c / a as NULL on a day with no log or before that behaviour's first log (unknown, R2.9). */
function hoyAlikeDays(t, date) {
  const [d, s, b, c, a] = ['d', 's', 'b', 'c', 'a'].map((x) => col(t, x)), by = new Map(rowsOf(t).map((r) => [r[d], r]));
  return rowsOf(t).filter((r) => r[d] < date).map((r) => {
    const prev = by.get(L0.shiftDate(r[d], -1)), next = by.get(L0.shiftDate(r[d], 1));
    return { date: r[d], x: { s: r[s], c: fin(r[c]) ? r[c] : null, a: fin(prev?.[a]) ? (prev[a] > 0 ? 1 : 0) : null }, out: next?.[s] ?? null, bed: next?.[b] ?? null };
  }).filter((x) => fin(x.out) && Object.values(x.x).every(fin));
}
/* The mark under a tap, in rendered CSS px, over visible marks only: glyphs {x, y} (centre) and spans {l, r, t, b} (clipped rect).
   A span containing the tap wins unless a glyph centre is within 22 px; otherwise the nearest glyph within 44 px (Euclidean);
   the earlier candidate on a tie; -1 when none. */
function hoyNearest(cands, x, y) {
  let g = -1, gd = Infinity, s = -1;
  (cands ?? []).forEach((c, i) => {
    if (c.l != null) { if (s < 0 && x >= c.l && x <= c.r && y >= c.t && y <= c.b) s = i; return; }
    const d = Math.hypot(c.x - x, c.y - y); if (d < gd) { gd = d; g = i; }
  });
  return s >= 0 && gd > 22 ? s : gd <= 44 ? g : s;
}
/* The bedtime split of the similar days: how many went to bed before the suggested time, and how many of those slept > 7 h. */
function hoyEarly(days, bed) {
  const early = (days ?? []).filter((x) => L0.localMinutes(x.bed) != null && s18(L0.localMinutes(x.bed)) < s18(bed));
  return { k: (days ?? []).length, n: early.length, m: early.filter((x) => x.out > 420).length };
}

/* ---- drawing ---- */
const h = HT.h, esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hm = (m) => { m = ((Math.floor(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const dh = (m, lang) => { m = Math.round(m); const x = Math.floor(m / 60), y = m % 60; return lang === 'es' ? x + ' h ' + String(y).padStart(2, '0') : x + 'h ' + y + 'm'; };
const pc = (x) => Math.round(x * 1000) / 10 + '%';
const SHAPE = {
  cafe: ['<ellipse rx="4.2" ry="5.6"/>', 'var(--fill-caffeine)', '<path d="M0 -4.6Q-2 -2.3 0 0Q2 2.3 0 4.6" fill="none" stroke="var(--on-fill-caffeine)" stroke-width="1.2"/>'],
  agua: ['<path d="M0 -6.2C-1.6 -3.6 -4.2 -1.2 -4.2 1.6A4.2 4.2 0 0 0 4.2 1.6C4.2 -1.2 1.6 -3.6 0 -6.2Z"/>', 'var(--fill-water)', ''],
  alcohol: ['<path d="M-4.6 -6.4H4.6V-3.2A4.6 4.6 0 0 1-4.6 -3.2Z"/>', 'var(--fill-alcohol)', '<path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="var(--m-alcohol)" stroke-width="1.6"/>'],
  supl: ['<rect x="-2.7" y="-5.8" width="5.4" height="11.6" rx="2.7"/>', 'var(--fill-supp)', '<path d="M-2.7 0H2.7" stroke="var(--on-fill-supp)" stroke-width="1"/>'],
  animo: ['<circle r="4.6"/>', 'var(--ink)', ''], other: ['<circle r="4"/>', 'var(--ink)', '']
};
/* A log glyph (G8); halo true adds the surface outline the strip draws over grid lines. */
function glyph(k, mood, halo) {
  if (k === 'cigarro') return (halo ? '<path d="M0 -7V7" stroke="var(--surface)" stroke-width="6.6"/>' : '') + '<path d="M0 -7V7" stroke="var(--m-cig)" stroke-width="3"/>';
  const [shape, fill, over] = SHAPE[k] ?? SHAPE.other, f = k === 'animo' && mood ? 'var(--mood-' + mood + ')' : fill;
  return (halo ? '<g fill="var(--surface)" stroke="var(--surface)" stroke-width="2.2">' + shape + '</g>' : '') + '<g fill="' + f + '" stroke="var(--fill-edge)" stroke-width=".9">' + shape + '</g>' + over;
}
const tileGlyph = (k, mood) => '<svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round"><g transform="scale(1.15)">' + glyph(k, mood, false) + '</g></svg>';
const kindOf = (id) => id === 'caffeine' ? 'cafe' : id === 'cigarettes' ? 'cigarro' : id === 'water' ? 'agua' : id === 'alcohol' ? 'alcohol' : SUPP.includes(id) ? 'supl' : /^mood_/.test(id ?? '') ? 'animo' : 'other';
const moodLabel = (id, lang) => { const m = L0.MOODS.find((x) => x.id === id); return m ? (lang === 'es' ? m.face : m.label) : null; };

/* Strip geometry shared by the drawing and the tap targets (viewBox units). */
const geo = (W, A, B) => ({ X: (m) => Math.round((8 + (m - A) / (B - A) * (W - 16)) * 10) / 10, CL: (m) => Math.min(Math.max(m, A), B) });
const SPAN_W = { workout: 9, nap: 10, sleep: 16 };
/* The visible marks of a window as tap candidates: glyph centres (with their stack level) and clipped span rectangles. */
function stripMarks(W, A, B, spans, logs) {
  const { X, CL } = geo(W, A, B), out = [];
  spans.forEach((s, i) => { if (s.e <= A || s.s >= B) return; const h = SPAN_W[s.kind] / 2;
    out.push({ id: 's' + i, l: Math.max(2, X(CL(s.s)) - h), r: Math.min(W - 2, X(CL(s.e)) + h), t: 48 - h, b: 48 + h }); });
  // A glyph reaches about 8 units from its centre; one fully outside the clip (x 2..W-2, y 0..H) is invisible, so no candidate.
  const H = 200 + (B - A <= 480 ? 30 : 0);
  logs.forEach((e, i) => { const x = X(e.min), y = 96 - e.lvl * 16; if (e.min >= A && e.min <= B && x >= 2 && x <= W - 2 && y + 8 > 0 && y - 8 < H) out.push({ id: 'e' + i, x, y }); });
  return out;
}
/* The strip (gen/strip4.py): window [A, B] in minutes from the shown day's 00:00. */
function stripSvg(W, A, B, o) {
  const SPAN = B - A, ZOOM = SPAN <= 480, { X, CL } = geo(W, A, B);
  const TOP = 16, RB = [36, 60], LOGY = 96, PH = 40, PB = 176 + (ZOOM ? 30 : 0), AX = 192 + (ZOOM ? 30 : 0), H = 200 + (ZOOM ? 30 : 0), cy = 48;
  const lab = (x, y, t, anchor = 'start', w = '400', c = 'var(--muted)', f = 'var(--font-sans)', s = 11) => '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" font-size="' + s + '" font-weight="' + w + '" fill="' + c + '" font-family="' + f + '" stroke="var(--surface)" stroke-width="3" paint-order="stroke">' + esc(t) + '</text>';
  // Marks are not tab stops: the strip is one (arrow keys walk the marks) and a tap picks the nearest mark (hoyNearest).
  const mark = (i, label, inner) => '<g data-i="' + i + '" data-l="' + esc(label) + '">' + inner + '</g>';
  const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(o.aria) + '"><defs><clipPath id="hoy-pc"><rect x="2" y="0" width="' + (W - 4) + '" height="' + H + '"/></clipPath></defs><g clip-path="url(#hoy-pc)">'];
  for (const [a, b] of o.bands) if (b > A && a < B) out.push('<rect x="' + X(CL(a)) + '" y="' + RB[0] + '" width="' + Math.max(0, X(CL(b)) - X(CL(a))) + '" height="' + (RB[1] - RB[0]) + '" rx="3" fill="var(--band)"/>');
  const every = SPAN > 840 ? 360 : SPAN > 480 ? 180 : 60;
  for (let m = Math.ceil((A + 1) / every) * every; m < B; m += every) if (m !== 0) out.push('<path d="M' + X(m) + ' ' + (RB[0] - 4) + 'V' + PB + '" stroke="var(--line)" stroke-width="1"/>');
  if (A < 0 && B > 0) out.push('<path d="M' + X(0) + ' ' + (TOP - 4) + 'V' + PB + '" stroke="var(--line-strong)" stroke-width="1.25" stroke-dasharray="3 3"/>');
  const x0 = X(CL(o.a)), x1 = X(CL(o.end));
  out.push('<path d="M' + x0 + ' ' + LOGY + 'H' + x1 + '" stroke="var(--line)" stroke-width="1"/>', '<path d="M' + x0 + ' ' + PB + 'H' + x1 + '" stroke="var(--line)" stroke-width="1"/>');
  o.spans.forEach((s, i) => {
    if (s.e <= A || s.s >= B) return;
    const w = SPAN_W[s.kind], c = s.kind === 'workout' ? 'var(--m-steps)' : 'var(--m-deep)';
    let inner = '<path d="M' + X(CL(s.s)) + ' ' + cy + 'H' + X(CL(s.e)) + '" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"/>';
    if (s.kind === 'sleep' && CL(s.e) - CL(s.s) > 30 * SPAN / 360) inner += '<text x="' + (X(CL(s.s)) + X(CL(s.e))) / 2 + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="10.5" font-weight="600" fill="#fff" font-family="var(--font-sans)">' + esc(s.text) + '</text>';
    out.push(mark('s' + i, s.label, inner));
  });
  const step = SPAN > 840 ? 20 : SPAN > 480 ? 10 : 5, bk = new Map();
  for (const [m, v] of o.pulse) if (m >= A && m <= B) { const k = Math.floor(m / step) * step, b = bk.get(k) ?? [0, 0]; b[0] += v; b[1]++; bk.set(k, b); }
  for (const [m, [s, n]] of bk) out.push('<path d="M' + X(m) + ' ' + PB + 'V' + Math.round((PB - Math.max(2, Math.min(PH, (s / n - 45) * PH / 80))) * 10) / 10 + '" stroke="var(--m-hr)" stroke-width="' + (ZOOM ? 2.2 : 1.6) + '" stroke-linecap="round" opacity=".7"/>');
  let row = 0, prev = -99;
  o.logs.forEach((e, i) => {
    if (e.min < A || e.min > B) return;
    const x = X(e.min), y = LOGY - e.lvl * 16;
    out.push(mark('e' + i, e.label, '<g transform="translate(' + x + ' ' + y + ')' + (e.k === 'cigarro' ? '' : ' scale(1.25)') + '" stroke-linecap="round" stroke-linejoin="round">' + glyph(e.k, e.mood, true) + '</g>'));
    if (ZOOM && e.lvl === 0) { row = x - prev < 36 ? 1 - row : 0; prev = x; out.push('<text x="' + x + '" y="' + (LOGY + 20 + row * 13) + '" text-anchor="' + (x > W - 22 ? 'end' : x < 22 ? 'start' : 'middle') + '" font-size="10" fill="var(--muted)" font-family="var(--font-mono)">' + hm(e.min) + '</text>'); }
  });
  if (o.sel != null && o.sel >= A && o.sel <= B) out.push('<path d="M' + X(o.sel) + ' ' + (TOP + 4) + 'V' + PB + '" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="2 3"/>');
  if (o.now != null && o.now >= A && o.now <= B) out.push('<path d="M' + X(o.now) + ' ' + (TOP - 4) + 'V' + PB + '" stroke="var(--surface)" stroke-width="5"/><path d="M' + X(o.now) + ' ' + (TOP - 4) + 'V' + PB + '" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>');
  out.push('</g>');
  out.push(lab(X(A), TOP - 2, A < 0 ? o.t.yday : o.t.today));
  if (A < 0 && B > 0) out.push(lab(X(0) + 4, TOP - 2, o.t.today));
  if (o.now != null && o.now >= A && o.now <= B) out.push(lab(X(o.now), TOP - 6, o.t.nowAt, 'end', '600', 'var(--ink)'));
  [[o.t.lane1, RB[0] - 8], [o.t.lane2, LOGY - 22], [o.t.lane3, PB - PH - 6]].forEach(([t, y]) => out.push(lab(X(A), y, t, 'start', '400', 'var(--muted)', 'var(--font-sans)', 10)));
  for (let m = Math.ceil(A / every) * every; m <= B; m += every) out.push(lab(X(m), AX, hm(m).slice(0, 2), 'middle', '400', 'var(--muted)', 'var(--font-mono)'));
  return out.join('') + '</svg>';
}

/* Zoom and pan of the strip stay while the page is open; a new day starts on Todo. */
const VIEW = { z: 0, start: null, date: null };
const SPANS = [null, 720, 360];

function render(ctx) {
  const L = ctx.L, t = ctx.t, lang = ctx.lang, date = ctx.date, y = L.shiftDate(date, -1), fmt = L.fmt, n0 = (v, d) => fmt.num(v, lang, d ?? (v % 1 ? 1 : 0));
  /* through: the last date each source covers; a write dated after it leaves it cached (R2.3). The profile does not follow logs. */
  const sql = (name, q, through = (d) => d) => ctx.source(name, { tool: 'health_sql', through, input: (d) => ({ query: q(d) }) });
  const hr = (name, day, from, to) => ctx.source(name, { tool: 'health_intraday', through: day, input: (d) => ({ metric: 'hr', date: day(d), resolution: '5m', from, to }) });
  const ID = "('caffeine','cigarettes','alcohol','water','" + SUPP.join("','") + "')";
  const S = {
    daily: ctx.source('daily'), sleep: ctx.source('sleep'), workouts: ctx.source('workouts'), trackers: ctx.source('trackers'),
    ev: sql('hoyEv', (d) => "SELECT local_date AS d, strftime('%H:%M', ts + tz_offset_min * 60, 'unixepoch') AS t, tracker_id AS k, value AS v FROM v_events WHERE local_date BETWEEN '" + L.shiftDate(d, -1) + "' AND '" + d + "' ORDER BY ts"),
    hist: sql('hoyHist', (d) => "SELECT local_date AS d, CASE WHEN tracker_id IN ('" + SUPP.join("','") + "') THEN 'supp' WHEN substr(tracker_id, 1, 5) = 'mood_' THEN 'mood' ELSE tracker_id END AS k, " +
      "group_concat((((ts + tz_offset_min * 60) % 86400) / 60) || ':' || value || ':' || tracker_id) AS l FROM v_events WHERE local_date >= '" + L.shiftDate(d, -28) + "' AND local_date < '" + d +
      "' AND (tracker_id IN " + ID + " OR substr(tracker_id, 1, 5) = 'mood_') GROUP BY 1, 2 ORDER BY 1", (d) => L.shiftDate(d, -1)),
    /* R2.9: c / a are NULL on a day with no log at all (no e row) or before that behaviour's first log ever (f). */
    like: sql('hoyLike', (d) => "WITH e AS (SELECT local_date AS d, SUM(CASE WHEN tracker_id = 'cigarettes' THEN value ELSE 0 END) AS c, SUM(CASE WHEN tracker_id = 'alcohol' THEN value ELSE 0 END) AS a FROM v_events WHERE local_date >= '" + L.shiftDate(d, -121) + "' GROUP BY local_date), " +
      "f AS (SELECT MIN(CASE WHEN tracker_id = 'cigarettes' THEN local_date END) AS fc, MIN(CASE WHEN tracker_id = 'alcohol' THEN local_date END) AS fa FROM v_events) " +
      "SELECT v.local_date AS d, v.sleep_min AS s, v.bedtime_local AS b, CASE WHEN v.local_date >= f.fc THEN e.c END AS c, CASE WHEN v.local_date >= f.fa THEN e.a END AS a FROM v_daily v JOIN f ON 1 = 1 LEFT JOIN e ON e.d = v.local_date " +
      "WHERE v.local_date >= '" + L.shiftDate(d, -121) + "' AND v.local_date <= '" + d + "' ORDER BY v.local_date"),
    slY: ctx.source('hoySlY', { tool: 'health_sleep', through: (d) => L.shiftDate(d, -1), input: (d) => ({ start: L.shiftDate(d, -1), end: L.shiftDate(d, -1) }) }),
    hrA: hr('hoyHrA', (d) => L.shiftDate(d, -1), '18:00', '24:00'), hrB: hr('hoyHrB', (d) => d, '00:00', '12:00'), hrC: hr('hoyHrC', (d) => d, '12:00', '24:00'),
    prof: ctx.source('hoyProf', { tool: 'health_profile', through: L.shiftDate(ctx.today, -1), input: () => ({}) })
  };
  const daily = S.daily.data, end = ctx.min, isNow = date === ctx.today && end < 1440;
  const goal = L.stepGoal(S.prof.data), wgoal = L.waterGoal(S.prof.data);
  /* R2.7: a truncated read makes no claim that depends on the missing part. */
  const evTrunc = !!S.ev.data?.truncated, evOk = !!S.ev.data && !evTrunc, evs = evOk ? hoyEvents(S.ev.data, date) : [];
  const hist = S.hist.data?.truncated ? null : S.hist.data, lk = S.like.data?.truncated ? null : S.like.data;
  const truncH = (src) => src.data?.truncated ? h('p', { class: 'hx-note', text: t('hoy.truncH') }) : null;
  const drinks = (list) => amount('alcohol', list.filter((e) => e.k === 'alcohol')), fmtDrinks = (v) => n0(Math.round(v * 10) / 10);   // R2.8: one conversion everywhere
  const today = evs.filter((e) => e.min >= 0), cell = (c, d = date) => { const i = col(daily, c), di = col(daily, 'local_date'), r = rowsOf(daily).find((x) => x[di] === d); return r && i >= 0 ? r[i] : null; };
  const val = (m, d = date) => L.dayValue(daily, m, d), sum = (k, list) => list.filter((e) => e.k === k).reduce((s, e) => s + e.v, 0);
  const trunc = () => evTrunc ? h('p', { class: 'hx-note', text: t('hoy.trunc') }) : null;
  const card = (cls, title, sub, body, foot) => HT.ins.card({ cls, title, sub, body, foot, footCls: 'hx-note hx-sep sx-foot' });
  const strip = (lo, hi, v) => {   // gen/frag.py rng(): band p25-p75 and the value on a padded scale
    const a = Math.min(lo ?? v, v), b = Math.max(hi ?? v, v), pad = (b - a) * 0.25 || 1, P = (x) => (x - a + pad) / (b - a + 2 * pad);
    return h('div', { class: 'hx-strip', 'aria-hidden': 'true' }, h('i', { class: 'hx-line' }), lo != null ? h('i', { class: 'hx-band', style: 'left:' + pc(P(lo)) + ';width:' + pc(P(hi) - P(lo)) }) : null,
      h('i', { class: 'hx-dot', style: 'left:' + pc(P(v)) + ';background:var(--ink)' }));
  };
  const row = (name, bar, v, sub) => h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: name }), bar ?? h('span', {}), h('span', { class: 'hx-v', text: v }), h('span', { class: 'hx-s', text: sub }));
  const usualDur = (r) => r.learning != null ? t('range.learning', { n: r.learning }) : t('hoy.key.usual', { x: dh(r.low, lang) + '–' + dh(r.high, lang) });

  /* 1 Resumen */
  const sleepMin = val('sleep_min'), sleepR = L.typicalRange(daily, 'sleep_min', date), sleepS = L.rangeStatus(sleepMin, sleepR);
  const night = date === ctx.today ? L.recoveryNight(daily, date) ?? date : date;
  const rec = L.recovery(val('z_ln_rmssd', night), val('z_rhr', night));
  const pace = hoyPace(val('steps'), end, goal);
  const sumCard = (() => {
    const st = S.daily.state('hoySum', 2);
    const a = sleepS === 'none' ? null : t('hoy.sum.sleep.' + sleepS), b = rec.word === 'learning' ? null : t((a ? 'hoy.sum.rec.' : 'hoy.sum.recOnly.') + rec.word);
    const lead = [a && b ? t('hoy.sum.and', { a, b }) : a || b ? t('hoy.sum.one', { a: a || b }) : null, pace ? t('hoy.sum.pace.' + pace.k) : null].filter(Boolean).join(' ') || t('hoy.sum.none');
    const alc = evs.filter((e) => e.k === 'alcohol' && e.min >= -360 && e.min < 300), cigs = evs.filter((e) => e.k === 'cigarettes' && e.min >= -240 && e.min < 300), cig = sum('cigarettes', cigs);
    const dr = drinks(alc);
    const parts = [alc.length ? (dr === 1 ? t('hoy.sum.drink', { t: alc[0].t }) : t('hoy.sum.drinks', { n: fmtDrinks(dr), t: alc[alc.length - 1].t })) : null, cigs.length ? (cig === 1 ? t('hoy.sum.cig') : t('hoy.sum.cigs', { n: n0(cig) })) : null].filter(Boolean);
    return h('section', { class: 'hx-sum' }, h('p', { class: 'met-l', text: t('hoy.sum') }), st ?? [h('p', { class: 'hx-lead', text: lead }),
      parts.length ? h('p', { class: 'hx-sub', text: t('hoy.sum.last', { x: parts.length === 2 ? t('hoy.sum.join', { a: parts[0], b: parts[1] }) : parts[0] }) }) : null, evTrunc ? h('p', { class: 'hx-note', text: t('hoy.trunc') }) : null]);
  })();

  /* 2 Clave */
  const keyCard = (() => {
    const st = S.daily.state('sleep', 2); if (st) return h('section', { class: 'hx-key' }, st);
    /* FU1 ruling b-d: today with no main session yet (decided by the sessions source, naps do not count) shows yesterday's night, labelled, with one note. */
    const sl = S.sleep.data, fb = date === ctx.today && !!sl && !sl.truncated && !L.mainSession(sl.sessions, date), sd = fb ? y : date;
    const sMin = val('sleep_min', sd), sR = fb ? L.typicalRange(daily, 'sleep_min', sd) : sleepR;
    const bed = cell('bedtime_local', sd), wake = cell('waketime_local', sd), steps = val('steps'), azm = val('azm');
    const times = L.localMinutes(bed) != null && L.localMinutes(wake) != null ? hm(L.localMinutes(bed)) + ' → ' + hm(L.localMinutes(wake)) : null;
    const sRow = row(t('hoy.key.sleep'), fin(sMin) && sR.learning == null ? strip(sR.low, sR.high, sMin) : null, fin(sMin) ? dh(sMin, lang) : '—',
      [fb && fin(sMin) ? t('ins.night', { d: fmt.wday(sd, lang) }) : null, times, usualDur(sR)].filter(Boolean).join(' · '));
    const wait = fb ? h('p', { class: 'hx-note', text: t('hoy.key.wait') }) : null;
    const bar = fin(steps) ? h('div', { class: 'hx-bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + pc(Math.min(1, steps / goal)) }), isNow ? h('b', { class: 'hx-tick', style: 'left:' + pc(L.expectedSteps(end, goal) / goal) }) : null) : null;
    const pTxt = pace && isNow ? (pace.k === 'at' ? t('hoy.key.at') : t('hoy.key.' + pace.k, { n: n0(pace.d) })) : null;
    const pRow = row(t('hoy.key.steps'), bar, fin(steps) ? n0(steps) : '—', [t('hoy.key.goal', { g: n0(goal) }), pTxt, fin(azm) ? t('hoy.key.azm', { n: n0(azm) }) : null].filter(Boolean).join(' · '));
    return h('section', { class: 'hx-key' }, sRow, wait, pRow, S.daily.stale('sleep'));
  })();

  /* 3 De ayer a hoy */
  const stripCard = (() => {
    const box = h('div', {}), sub = h('span', { class: 'ht-card-s' });
    if (VIEW.date !== date) Object.assign(VIEW, { z: 0, start: null, date });
    const a = -360, at = (s) => { const m = L.localMinutes(s); return m == null ? null : m + (s.slice(0, 10) < date ? -1440 : s.slice(0, 10) > date ? 1440 : 0); };
    const sess = S.sleep.data?.sessions ?? [], main = L.mainSession(sess, date), spans = [];
    const span = (kind, s, e, extra) => { const x = at(s), z = at(e); if (x != null && z != null && z > x) spans.push({ kind, s: x, e: Math.min(z, end), label: t('hoy.st.span', { x: t('hoy.st.' + kind), a: hm(x), b: hm(z) }), ...extra }); };
    if (main) span('sleep', main.start_local, main.end_local, { text: fin(main.minutes_asleep) ? dh(main.minutes_asleep, lang) : '' });
    [...sess, ...(S.slY.data?.sessions ?? [])].filter((s) => s.is_nap && (s.local_date === date || s.local_date === y) && typeof s.start_local === 'string' && typeof s.end_local === 'string')
      .forEach((s) => span('nap', s.start_local, s.end_local));   // yesterday's naps too: the window starts yesterday 18:00
    (S.workouts.data?.workouts ?? []).forEach((w) => typeof w.start_local === 'string' && typeof w.end_local === 'string' && span('workout', w.start_local, w.end_local));
    const live = spans.filter((s) => s.e > a && s.s < end);
    const names = new Map((S.trackers.data?.trackers ?? []).map((x) => [x.id, x.name]));
    const logs = hoyStack(evs.filter((e) => e.min >= a && e.min <= end)).map((e) => {
      const k = kindOf(e.k), mood = k === 'animo' ? e.k.slice(5) : null;
      return { ...e, k, mood, label: t('hoy.st.mark', { x: k === 'animo' ? moodLabel(e.k, lang) ?? e.k : k === 'other' || k === 'supl' ? String(names.get(e.k) ?? e.k) : t('hoy.l.' + k), t: e.t }) };
    });
    const pulse = [S.hrA, S.hrB, S.hrC].flatMap((s) => s.data?.points ?? []).map((p) => [(L.localMinutes(p[0]) ?? NaN) - (String(p[0]).slice(0, 10) < date ? 1440 : 0), p[1]]).filter(([m, v]) => fin(m) && fin(v) && v > 0 && m >= a && m <= end);
    const sun = (d) => L.sunTimes(d, 40.4168, -3.7038);   // Madrid, the dial's fallback location
    const sy = sun(y), sd = sun(date), bands = [sy && sd ? [sy.sunset - 1440, sd.sunrise] : null, sd ? [sd.sunset, end] : null].filter(Boolean);
    const tip = h('p', { class: 'hx-tip', id: 'hoy-tip', role: 'tooltip', hidden: true, 'aria-live': 'polite' });
    /* Every mark in time order (logs at their minute, spans [s, e]); the strip is one tab stop over them. */
    const marks = [...live.map((s, i) => ({ id: 's' + i, m: s.s, m2: s.e, label: s.label })), ...logs.map((e, i) => ({ id: 'e' + i, m: e.min, label: e.label }))].sort((p, q) => p.m - q.m);
    const ms = main ? spans[0] : null, D = end - a, word = (m) => (m < 0 ? t('hoy.st.yday') : t('hoy.st.today')) + ' ' + hm(m);
    let w = hoyWin(a, end, null, null), W = 300, sel = -1, hov = false, drag = null;
    const zoomed = () => w.e - w.s < end - a;
    /* A tap picks among the visible marks in rendered CSS px (x and y, so stacked glyphs differ); offscreen marks are not candidates. */
    const pick = (e) => {
      const r = (pan.querySelector?.('svg') ?? pan).getBoundingClientRect?.(); if (!r?.width) return -1;
      const k = r.width / W, c = stripMarks(W, w.s, w.e, live, logs).map((m) => m.l != null ? { ...m, l: m.l * k, r: m.r * k, t: m.t * k, b: m.b * k } : { ...m, x: m.x * k, y: m.y * k });
      const i = hoyNearest(c, e.clientX - r.left, e.clientY - r.top);
      return i < 0 ? -1 : marks.findIndex((m) => m.id === c[i].id);
    };
    const show = (i) => { sel = i; tip.hidden = i < 0; if (i >= 0) tip.textContent = marks[i].label; };
    const latest = () => { const v = marks.map((k, i) => [k.m, i]).filter(([m]) => m <= w.e); return v.length ? v[v.length - 1][1] : marks.length - 1; };
    const release = (e) => { try { pan.releasePointerCapture?.(e.pointerId); } catch (x) { /* already released */ } drag?.pts.delete(e.pointerId); if (!drag?.pts.size) drag = null; };
    /* The gesture target stays mounted: draw() only swaps the SVG inside it, so touch capture is never lost mid-gesture. */
    const pan = h('div', { class: 'hx-pan', tabindex: '0', 'data-fk': 'hoy-pan', role: 'group', 'aria-label': t('hoy.st.pan'), 'aria-describedby': 'hoy-tip',
      onkeydown: (e) => {
        const k = e.key;
        if (k === 'Escape') { show(-1); draw(); return; }
        if (k === 'Enter' || k === ' ' || k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault(); if (!marks.length) return;
          const i = sel < 0 || k === 'Enter' || k === ' ' ? (sel < 0 ? latest() : sel) : Math.max(0, Math.min(marks.length - 1, sel + (k === 'ArrowUp' ? -1 : 1)));
          show(i); hov = false;
          const m = marks[i].m2 != null ? (Math.max(marks[i].m, a) + Math.min(marks[i].m2, end)) / 2 : marks[i].m;
          if (zoomed() && (m < w.s || m > w.e)) VIEW.start = m - (w.e - w.s) / 2;   // the window follows the chosen mark
          draw(); return;
        }
        if (!zoomed() || (k !== 'ArrowLeft' && k !== 'ArrowRight')) return;
        e.preventDefault(); VIEW.start = w.s + (k === 'ArrowLeft' ? -1 : 1) * (w.e - w.s) / 6; draw();
      },
      onmouseleave: () => { if (hov && !drag) { show(-1); hov = false; draw(); } },
      onpointerdown: (e) => {
        try { pan.setPointerCapture?.(e.pointerId); } catch (x) { /* synthetic or already captured */ }
        drag = drag ?? { pts: new Map() }; drag.pts.set(e.pointerId, e.clientX);
        if (drag.pts.size === 1) Object.assign(drag, { x: e.clientX, s: w.s, moved: false, d: null });
        else { const [p, q] = [...drag.pts.values()]; drag.moved = true; drag.d = Math.max(20, Math.abs(p - q)); }
      },
      onpointermove: (e) => {
        if (!drag?.pts.has(e.pointerId)) {   // a mouse hovering: show the nearest mark
          if (e.pointerType === 'mouse' && !e.buttons) { const i = pick(e); if (i !== sel) { show(i); hov = i >= 0; draw(); } }
          return;
        }
        drag.pts.set(e.pointerId, e.clientX);
        if (drag.pts.size >= 2) {   // pinch: a 30 % change in finger distance moves one zoom step
          const [p, q] = [...drag.pts.values()], dist = Math.abs(p - q);
          if (dist > drag.d * 1.3 || dist < drag.d / 1.3) { const z = VIEW.z + (dist > drag.d ? 1 : -1); drag.d = Math.max(20, dist); if (z >= 0 && z <= 2) zoomTo(z); }
          return;
        }
        if (Math.abs(e.clientX - drag.x) > 5) drag.moved = true;
        if (!drag.moved || !zoomed()) return;
        const width = pan.getBoundingClientRect?.().width || W;
        VIEW.start = drag.s - (e.clientX - drag.x) / width * (w.e - w.s); draw();
      },
      onpointerup: (e) => { if (drag && !drag.moved && drag.pts.size === 1) { show(pick(e)); hov = false; draw(); } release(e); },
      onpointercancel: release });
    const seg = h('div', { class: 'hx-seg', role: 'group', 'aria-label': t('hoy.st.zoom') }, ['whole', 'h12', 'h6'].map((k, i) => h('button', { type: 'button', 'data-fk': 'hoy-z' + i, 'aria-pressed': 'false', onclick: () => zoomTo(i) }, t('hoy.st.' + k))));
    const miniBox = h('div', {});
    const zoomTo = (z) => { VIEW.z = Math.max(0, Math.min(2, z)); VIEW.start = null; draw(); };
    const draw = () => {
      const sp = SPANS[VIEW.z]; w = hoyWin(a, end, sp, VIEW.start); W = Math.max(300, Math.round((ctx.root.clientWidth || 340) - 40));
      VIEW.start = sp ? w.s : null;
      sub.textContent = zoomed() ? t('hoy.st.win', { a: word(w.s), b: w.e === end && isNow ? t('hoy.st.now') : hm(w.e) }) : t('hoy.st.all', { e: isNow ? t('hoy.st.now') : '24:00' });
      const k = marks[sel], selM = k ? (k.m2 != null ? (Math.max(k.m, a) + Math.min(k.m2, end)) / 2 : k.m) : null;
      pan.className = 'hx-pan' + (zoomed() ? ' is-zoom' : '');
      pan.innerHTML = stripSvg(W, w.s, w.e, { a, end, bands, spans: live, pulse, logs, now: isNow ? end : null, sel: selM,
        aria: t('hoy.st.aria', { e: isNow ? t('hoy.st.now') : '24:00', s: ms ? t('hoy.st.ariaSleep', { a: hm(ms.s), b: hm(ms.e) }) : '', n: logs.length }),
        t: { yday: t('hoy.st.yday'), today: t('hoy.st.today'), nowAt: t('hoy.st.nowAt', { t: hm(end) }), lane1: t('hoy.st.lane1'), lane2: t('hoy.st.lane2'), lane3: t('hoy.st.lane3') } });
      [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(VIEW.z === i)));
      miniBox.replaceChildren(...(zoomed() ? [h('div', { class: 'hx-mini', role: 'img', 'aria-label': t('hoy.st.mini', { a: word(w.s), b: word(w.e) }) },
        ms ? h('i', { class: 'hx-mini-sleep', style: 'left:' + pc((Math.max(ms.s, a) - a) / D) + ';width:' + pc((Math.min(ms.e, end) - Math.max(ms.s, a)) / D) }) : null,
        isNow ? h('i', { class: 'hx-mini-now', style: 'left:calc(' + pc(1) + ' - 2px)' }) : null,
        h('i', { class: 'hx-mini-win', style: 'left:' + pc((w.s - a) / D) + ';width:' + pc((w.e - w.s) / D) })), h('p', { class: 'hx-note', text: t('hoy.st.hint') })] : []));
    };
    const st = S.ev.state('hoyStrip', 3);
    if (!st) { box.append(seg, pan, tip, miniBox); draw(); }
    const legend = h('div', { class: 'hx-legend' }, [['sleep', 'width:16px;height:6px;background:var(--m-deep)'], ['workout', 'width:16px;height:6px;background:var(--m-steps)'], ['night', 'width:16px;height:8px;border-radius:2px;background:var(--band)'], ['pulse', 'width:2px;height:10px;border-radius:0;background:var(--m-hr);opacity:.7']]
      .map(([k, s]) => h('span', {}, h('i', { style: s }), t('hoy.st.' + k))));
    const c = HT.ins.card({ cls: 'hx-time', title: t('hoy.st.title'), body: [st ?? box, legend, trunc(), S.ev.stale('hoyStrip')], foot: t('hoy.st.foot'), footCls: 'hx-note' });
    c.firstChild.append(sub);
    return c;
  })();

  /* 4 Recuperación (C1: the night the values belong to) */
  const recCard = (() => {
    const st = S.daily.state('rec', 3), sub = st ? null : t('ins.night', { d: fmt.wday(night, lang) });
    if (st) return card('hx-rec', t('hoy.rec.title'), null, st);
    const r = (m) => L.typicalRange(daily, m, night);
    /* R2.10: the verdict, each row's usual range and the other vitals learn separately; the night's values always show. */
    const vrow = (m, name) => { const v = val(m, night), rr = r(m); return fin(v) ? row(name, rr.learning == null ? strip(rr.low, rr.high, v) : null, fmt.vital(m, v, lang), rr.learning != null ? t('range.learning', { n: rr.learning }) : t('base.normal', { x: fmt.range(m, rr, lang) })) : null; };
    const rows = [vrow('hrv_rmssd', t('hoy.rec.hrv')), vrow('rhr', t('hoy.rec.rhrRow'))];
    const verdict = rec.word === 'learning' ? HT.ins.learning(ctx, Math.max(r('hrv_rmssd').n ?? 0, r('rhr').n ?? 0), 7, { what: t('hoy.rec.verdict') })
      : [h('p', { class: 'ht-word', text: rec.word === 'typical' ? t('hoy.rec.typical') : t('rec.' + rec.word) }),
        rec.word !== 'typical' && rec.driver ? h('p', { class: 'hx-sub' }, t('hoy.rec.drv.' + rec.driver), h('b', { text: t(rec.driver === 'rhr' ? 'hoy.rec.rhr' : 'hoy.rec.hrv') })) : null];
    /* Only vitals that were measured and compared are called usual or not; the rest say why not. */
    const OTHER = ['resp_rate', 'spo2_avg', 'skin_temp_dev'], by = { in: [], below: [], above: [], learn: [], none: [] };
    for (const m of OTHER) { const v = val(m, night), rr = L.typicalRange(daily, m, night, true); by[!fin(v) ? 'none' : rr.learning != null ? 'learn' : L.rangeStatus(v, rr)].push(m); }
    const list = (ms) => { const n = ms.map((m) => t('hoy.v.' + m)), s = n.length > 1 ? (n.length > 2 ? n.slice(0, -1).join(', ') : n[0]) : n[0]; const x = n.length > 1 ? t('hoy.list2', { a: s, b: n[n.length - 1] }) : s; return x.charAt(0).toUpperCase() + x.slice(1); };
    const others = by.in.length === 3 ? [t('hoy.rec.others')] : [...by.below.map((m) => t('hoy.rec.below', { x: list([m]) })), ...by.above.map((m) => t('hoy.rec.above', { x: list([m]) })),
      by.in.length ? t('hoy.rec.inList', { x: list(by.in) }) : null, by.learn.length ? t('hoy.rec.learnList', { x: list(by.learn) }) : null, by.none.length && by.none.length < 3 ? t('hoy.rec.noneList', { x: list(by.none) }) : null].filter(Boolean);
    return card('hx-rec', t('hoy.rec.title'), sub, [...[verdict].flat(), ...rows,
      others.length ? h('p', { class: 'hx-sub hx-sep', text: others.join(' ') }) : null,
      h('button', { class: 'det-go', type: 'button', 'data-fk': 'hoy-health', onclick: () => ctx.navigate(ctx.date, 'health') }, t('rec.seeHealth')), S.daily.stale('rec')]);
  })();

  /* 5 Esta noche (C2) */
  const C2 = hoyBed(daily, date);
  const nightCard = (() => {
    const st = S.daily.state('hoyNight', 3);
    if (st || C2.learning) return card('hx-night', t('hoy.n.title'), t('hoy.n.sub'), st ?? HT.ins.learning(ctx, C2.n, 7, { unit: 'nights', what: t('hoy.n.nights') }));
    const bed = C2.bed, wake = Math.round(C2.wake), lastBed = L.localMinutes(cell('bedtime_local')), P = (m) => ((m - 1320) % 1440 + 1440) % 1440 / 720;
    const cafe = today.filter((e) => e.k === 'caffeine'), alc = today.filter((e) => e.k === 'alcohol'), yAlc = evs.filter((e) => e.k === 'alcohol' && e.min < 0);
    const bedAbs = bed < 720 ? bed + 1440 : bed, gap = cafe.length ? bedAbs - cafe[cafe.length - 1].min : null;
    const finding = (ctx.source('findings').data?.findings ?? []).find((f) => f?.status === 'active' && f.ref?.key?.behavior === 'alcohol' && /hrv|rmssd/.test(String(f.ref?.key?.metric ?? '')));
    const lowHrv = L.rangeStatus(val('hrv_rmssd', night), L.typicalRange(daily, 'hrv_rmssd', night)) === 'below';
    const fr = finding?.result ?? {}, fn = fin(fr.n_a) && fin(fr.n_b) ? t('ins.find.n', { a: fr.n_a, b: fr.n_b }) : null;   // G7: the finding's n and the causation note
    const alcY = finding && yAlc.length && lowHrv ? t('hoy.n.alcY', { t: yAlc[yAlc.length - 1].t }).replace(/\.$/, '') + t('hoy.n.alcN', { n: fn ?? '', note: t('ins.find.note') }).replace('(; ', '(') + '.' : '';
    return card('hx-night', t('hoy.n.title'), t('hoy.n.sub'), [
      h('p', { class: 'ht-word', text: t('hoy.n.word', { t: hm(bed) }) }), h('p', { class: 'hx-sub', text: t('hoy.n.why', { w: hm(wake), l: n0(Math.round(C2.lat)) }) }),
      h('div', { class: 'hx-plan', role: 'img', 'aria-label': t('hoy.n.plan', { a: hm(bed), b: hm(wake) }) },
        h('div', { class: 'hx-plan-t' }, h('i', { class: 'hx-plan-b', style: 'left:' + pc(Math.min(1, P(bed))) + ';width:' + pc(Math.max(0, Math.min(1, P(wake)) - Math.min(1, P(bed)))) })),
        h('div', { class: 'hx-plan-ax', 'aria-hidden': 'true' }, ['22', '01', '04', '07', '10'].map((x) => h('span', { text: x }))),
        h('p', { class: 'hx-sub' }, h('b', { text: hm(bed) + ' → ' + hm(wake) }), lastBed != null ? t('hoy.n.last', { t: hm(lastBed) }) : '')),
      /* R2.7: the checklist needs the complete log of the day; without it, no "last coffee" or "no alcohol" claim. */
      evOk ? h('ul', { class: 'hx-chk' },
        cafe.length ? h('li', {}, h('b', { text: t('hoy.n.cafe', { t: cafe[cafe.length - 1].t }) }), t(gap >= 480 ? 'hoy.n.cafeOk' : 'hoy.n.cafeNo')) : null,
        h('li', {}, h('b', { text: alc.length ? t('hoy.n.alc', { n: fmtDrinks(drinks(alc)), t: alc[alc.length - 1].t }) : t('hoy.n.alc0') }), alcY))
        : evTrunc ? h('p', { class: 'hx-note', text: t('hoy.trunc') }) : null]);
  })();

  /* 6 Registros de hoy (C3) */
  const logsCard = (() => {
    const st = S.ev.state('hoyLogs', 3);
    if (st) return card('hx-logs', t('hoy.l.title'), null, st);
    if (evTrunc) return card('hx-logs', t('hoy.l.title'), null, [trunc(), S.ev.stale('hoyLogs')], t('hoy.l.foot'));   // R2.7: no totals from a partial log
    /* No usual line while the history is loading or partial (no claim); learning only when it is complete but short. */
    const hab = hist ? hoyHab(hist, date, end) : null, mood = hist ? hoyMood(hist, date) : null;
    const habTxt = (k, v, f) => !hab ? null : hab[k].learning ? t('hoy.l.habLearn') : t('hoy.l.hab', { n: f(hab[k].v) });
    const up = (k, v) => !!hab && !hab[k].learning && v > hab[k].v;
    const water = (v) => v >= 1000 ? n0(Math.round(v / 100) / 10) + ' l' : n0(Math.round(v)) + ' ml';
    const of = (ids) => today.filter((e) => ids.includes(e.k)), last = (list) => list.length ? list[list.length - 1] : null;
    const tile = (k, mood, value, sub, gh, isUp) => h('div', {}, h('span', { class: 'hx-gl', html: tileGlyph(k, mood) }), h('span', { class: 'hx-gn', text: t('hoy.l.' + k) }), h('b', { text: value }),
      h('span', { class: 'hx-gs', text: sub || ' ' }), gh ? h('span', { class: 'hx-gh' + (isUp ? ' is-up' : ''), text: gh }) : null);
    const cafe = of(['caffeine']), cig = of(['cigarettes']), wat = of(['water']), alc = of(['alcohol']), sup = of(SUPP), moods = today.filter((e) => /^mood_/.test(e.k));
    const vC = amount('cafe', cafe), vG = amount('cigarro', cig), vW = amount('agua', wat), vA = amount('alcohol', alc), vS = amount('supl', sup), lm = last(moods);
    const yA = amount('alcohol', evs.filter((e) => e.k === 'alcohol' && e.min < 0));
    const names = new Map((S.trackers.data?.trackers ?? []).map((x) => [x.id, x.name])), supNames = [...new Set(sup.map((e) => String(names.get(e.k) ?? e.k)))].join(', ');
    return card('hx-logs', t('hoy.l.title'), null, [h('div', { class: 'hx-grid' },
      tile('cafe', null, n0(cafe.length), cafe.length ? n0(Math.round(vC)) + ' mg' : '', habTxt('cafe', vC, (v) => n0(Math.round(v)) + ' mg'), up('cafe', vC)),
      tile('cigarro', null, n0(vG), last(cig) ? t('hoy.l.last', { t: last(cig).t }) : '', habTxt('cigarro', vG, (v) => n0(v)), up('cigarro', vG)),
      tile('agua', null, water(vW), t('hoy.key.goal', { g: n0(wgoal) }), habTxt('agua', vW, water), up('agua', vW)),
      tile('alcohol', null, alc.length ? fmtDrinks(vA) : '—', t('hoy.l.yday', { n: fmtDrinks(yA) }), habTxt('alcohol', vA, fmtDrinks), up('alcohol', vA)),
      tile('supl', null, n0(vS), supNames, habTxt('supl', vS, (v) => n0(v)), up('supl', vS)),
      tile('animo', lm ? lm.k.slice(5) : null, lm ? moodLabel(lm.k, lang) ?? lm.k : '—', lm ? lm.t : '', mood ? t('hoy.l.mood', { x: moodLabel(mood, lang) }) : null, false)),
      truncH(S.hist), S.ev.stale('hoyLogs')], t('hoy.l.foot'));
  })();

  /* 7 Esta semana */
  const weekCard = (() => {
    const st = S.daily.state('hoyWeek', 4);
    if (st) return card('hx-week', t('hoy.w.title'), t('hoy.w.sub'), st);
    const di = col(daily, 'local_date'), series = (m) => rowsOf(daily).map((r) => ({ date: r[di], v: r[col(daily, m)] }));
    const cigS = rowsOf(lk).map((r) => ({ date: r[col(lk, 'd')], v: r[col(lk, 'c')] }));   // NULL = unknown day (R2.9), dropped by hoyWeek
    const spark = (v) => { const m = Math.max(1, ...v.filter(fin)); return '<svg width="81" height="24" viewBox="0 0 81 24" aria-hidden="true" focusable="false">' + v.map((x, i) => fin(x) ? '<rect x="' + i * 12 + '" y="' + (24 - Math.round(x / m * 22)) + '" width="9" height="' + Math.round(x / m * 22) + '" rx="2" fill="var(--' + (i === 6 ? 'ink' : 'line-strong') + ')" opacity="' + (i === 6 ? 1 : 0.45) + '"/>' : '').join('') + '</svg>'; };
    const partial = end < 1440;
    const wrow = (name, s, skip, f, fd) => { const w = hoyWeek(s, date, skip && partial);
      return w.learning ? h('div', { class: 'hx-wk' }, h('span', { class: 'hx-n', text: name }), h('span', {}), h('span', { class: 'hx-s', text: t('hoy.w.few') }))
        : h('div', { class: 'hx-wk' }, h('span', { class: 'hx-n', text: name }), h('span', { html: spark(w.spark) }), h('span', { class: 'hx-v', text: f(w.mean) }), h('span', { class: 'hx-s', text: t('hoy.w.n', { d: fd(w.delta), n: w.n }) })); };
    const sg = (v, d, u) => fmt.signed(v, lang, d) + (u ? ' ' + u : '');
    const coffee = hist && evOk ? hoyCoffee(hist, evs, date, end) : 0, stepsN = hoyStepStreak(daily, date);   // R2.7: no streak from partial logs
    const pills = [coffee >= 2 ? t('hoy.w.cafe', { n: coffee }) : null, stepsN >= 2 ? t('hoy.w.steps', { n: stepsN }) : null].filter(Boolean);
    return card('hx-week', t('hoy.w.title'), t('hoy.w.sub'), [pills.length ? h('div', { class: 'hx-streaks' }, pills.map((p) => h('span', { class: 'ht-pill', text: p }))) : null,
      wrow(t('hoy.w.sleep'), series('sleep_min'), false, (v) => dh(v, lang), (d) => sg(Math.round(d), 0, 'min')),
      wrow(t('hoy.w.hrv'), series('hrv_rmssd'), false, (v) => n0(Math.round(v)) + ' ms', (d) => sg(Math.round(d), 0, 'ms')),
      wrow(t('hoy.w.stepsRow'), series('steps'), true, (v) => n0(Math.round(v)), (d) => sg(Math.round(d), 0)),
      S.like.data?.truncated ? null : wrow(t('hoy.w.cig'), cigS, true, (v) => t('hoy.w.perDay', { x: fmt.num(v, lang, 1) }), (d) => sg(d, 1)),
      truncH(S.like) ?? truncH(S.hist), S.daily.stale('hoyWeek')]);
  })();

  /* 8 Días como hoy (I3, Hoy) */
  const alikeCard = (() => {
    const st = S.like.state('hoyLike', 3);
    if (st) return card('ix-alike', t('ins.alike.title'), null, st);
    if (S.like.data?.truncated) return card('ix-alike', t('ins.alike.title'), null, truncH(S.like));
    /* Today's features from the same SQL rows as the history, so "before the first log" and "no log" stay unknown (R2.9). */
    const byD = (d) => rowsOf(lk).find((r) => r[col(lk, 'd')] === d), cT = byD(date)?.[col(lk, 'c')], aY = byD(y)?.[col(lk, 'a')];
    const feat = { s: sleepMin, c: fin(cT) ? cT : null, a: fin(aY) ? (aY > 0 ? 1 : 0) : null };
    const band = sleepR.learning == null ? [sleepR.low, sleepR.high] : null;
    const sTxt = sleepR.learning != null ? t('hoy.a.s.learn', { n: sleepR.learning }) : t('hoy.a.s.' + sleepS);   // AC4: no usual claim while it learns
    return HT.ins.alike(ctx, { features: { today: feat, days: hoyAlikeDays(lk, date) }, W: Math.max(300, Math.min(380, Math.round((ctx.root.clientWidth || 340) / 2 - 40))),
      outcome: { fmt: (v) => dh(v, lang), band,
        lead: () => t('hoy.a.lead', { s: sTxt, c: feat.c === 0 ? t('hoy.a.c0') : feat.c === 1 ? t('hoy.a.c1') : t('hoy.a.c', { n: n0(feat.c) }), a: t(feat.a ? 'hoy.a.a1' : 'hoy.a.a0') }),
        foot: (res) => { const e = C2.learning ? null : hoyEarly(res.days, C2.bed); return [e && e.n >= 2 ? t('hoy.a.foot', { n: e.n, k: e.k, t: hm(C2.bed), m: e.m }) : null, t('hoy.a.note')].filter(Boolean).join(' '); } } });
  })();

  HT.ins.layout(ctx.root, [[sumCard, 1, 1, 8], [keyCard, 1, 8, 13], [stripCard, 2, 1, 13], [recCard, 3, 1, 6], [nightCard, 4, 1, 6], [logsCard, 3, 6, 13], [weekCard, 4, 6, 13],
    [alikeCard, 5, 1, 7], [HT.ins.changes(ctx, { max: 2, rows: daily }), 5, 7, 13], [HT.ins.findings(ctx, {}), 6, 1, 13]]);
}

const CSS = `
#g-today .hx-key { display: flex; flex-direction: column; justify-content: center; }
#g-today .hx-key .hx-row:first-child { border-top: 0; padding-top: 0; } #g-today .hx-key .hx-row:last-child { padding-bottom: 0; }
#g-today .hx-bar .hx-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--ink); border-radius: 1px; }
#g-today .hx-time svg { margin: 4px 0 8px; }
#g-today .hx-time .ht-card-h { flex-wrap: wrap; }
#g-today .hx-pan { position: relative; border-radius: var(--radius-sm); }
#g-today .hx-pan.is-zoom { touch-action: pan-y; cursor: grab; }
#g-today .hx-pan:focus-visible, #g-today .hx-pan g[tabindex]:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
#g-today .hx-tip { margin: 0 0 4px; font: 500 13px/18px var(--font-mono); color: var(--ink); }
#g-today .hx-mini { position: relative; height: 24px; border-radius: var(--radius-sm); background: var(--surface-2); margin: 4px 0; }
#g-today .hx-mini i { position: absolute; display: block; }
#g-today .hx-mini-sleep { top: 9px; height: 6px; border-radius: 3px; background: var(--m-deep); opacity: .6; }
#g-today .hx-mini-now { top: 3px; bottom: 3px; width: 2px; background: var(--primary); }
#g-today .hx-mini-win { top: 0; bottom: 0; border-radius: var(--radius-sm); box-shadow: inset 0 0 0 2px var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
#g-today .hx-rec .ht-word, #g-today .hx-night .ht-word { margin: 0 0 2px; } #g-today .hx-rec .hx-sub + .hx-row { margin-top: 12px; }
#g-today .hx-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
#g-today .hx-grid > div { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 0 6px; background: var(--surface-2); border-radius: var(--radius-sm); padding: 10px; min-width: 0; }
#g-today .hx-gn { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#g-today .hx-grid b { grid-column: 1 / -1; font: 500 17px/22px var(--font-mono); margin-top: 4px; white-space: nowrap; }
#g-today .hx-gs { grid-column: 1 / -1; font-size: 11px; line-height: 14px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#g-today .hx-gh { grid-column: 1 / -1; font-size: 11px; line-height: 14px; color: var(--muted); margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#g-today .hx-gh.is-up { color: var(--ink); font-weight: var(--w-strong); }
#g-today .hx-plan { margin-top: 16px; } #g-today .hx-plan b { color: var(--ink); font-weight: var(--w-strong); }
#g-today .hx-plan-t { position: relative; height: 20px; border-radius: var(--radius-sm); background: var(--band); }
#g-today .hx-plan-b { position: absolute; top: 4px; height: 12px; border-radius: var(--radius-full); box-shadow: inset 0 0 0 2px var(--m-deep); background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--m-deep) 35%, transparent) 0 4px, transparent 4px 8px); }
#g-today .hx-plan-ax { display: flex; justify-content: space-between; font: 11px/14px var(--font-mono); color: var(--muted); margin: 4px 0 8px; }
#g-today .hx-chk { list-style: none; margin: 12px 0 0; padding: 12px 0 0; border-top: 1px solid var(--line); display: grid; gap: 8px; font-size: 13px; line-height: 18px; color: var(--muted); }
#g-today .hx-chk b { color: var(--ink); font-weight: var(--w-strong); }
#g-today .hx-streaks { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; } #g-today .hx-streaks .ht-pill { text-align: left; }
#g-today .hx-wk { display: grid; grid-template-columns: 1fr auto 92px; gap: 0 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
#g-today .hx-wk .hx-v { font-size: 15px; } #g-today .hx-wk .hx-s { grid-column: 2 / 4; text-align: right; }
#g-today .hx-pan { touch-action: pan-y; }
#g-today .hx-wk:first-of-type { margin-top: 8px; }
#g-today .hx-sum .met-l { margin: 0; }
@media (min-width: 1200px) {
  #g-today .hx-logs .hx-grid { flex: 1; grid-auto-rows: 1fr; } #g-today .hx-grid > div { align-content: center; }
  #g-today .hx-chk { margin-top: auto; }
  #g-today > .hx-find { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; align-content: start; } #g-today > .hx-find > :not(.hx-f) { grid-column: 1 / -1; }
}`;

HT.registerTab('hoy', { copy: COPY, css: CSS, render,
  logic: { hoyStack, hoyWin, hoyBed, hoyEvents, hoyHab, hoyMood, hoyCoffee, hoyStepStreak, hoyWeek, hoyPace, hoyAlikeDays, hoyEarly, hoyNearest, hoyStripMarks: stripMarks } });
}
