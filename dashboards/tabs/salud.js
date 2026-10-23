/* Salud (boards H-*). Markup, CSS and SVG geometry ported from specs/dashboard-redesign/gen/health.py; computations in HTLogic (sa*). */
(() => {
  const L = window.HTLogic;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const r1 = (x) => Math.round(x * 10) / 10;
  const T0 = (d) => Date.parse(d + 'T00:00:00Z') / 60000;   // local epoch minutes of a date's 00:00 (intraday and v_events are both local wall time)
  const hhmm = (t) => { const m = ((Math.round(t) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const C5 = ['cigarettes', 'caffeine'];
  const VORD = ['hrv_rmssd', 'rhr', 'resp_rate', 'spo2_avg', 'skin_temp_dev'];
  const MARK = { cafe: ['caffeine_mg'], cigarro: ['cigarettes'], alcohol: ['alcohol_g'], animo: L.MOODS.map((m) => m.id) };
  const MARK_GL = { cafe: 'caffeine', cigarro: 'cig', alcohol: 'alcohol', animo: 'other' }, MARK_COL = { cafe: 'fill-caffeine', cigarro: 'm-cig', alcohol: 'fill-alcohol', animo: 'ink' };
  const PAST = { cache: { staleTime: 86400000, gcTime: 7 * 86400000 } };   // a past date's heart rate does not change: no periodic refetch

  /* ---- computations (R2.13; pinned in check_salud.py) ---- */
  /* Intraday payloads → [{t, v}] by local minute; a repeated DST hour keeps its first reading (documented limitation, R2.5). */
  function saSeries(...ps) {
    const seen = new Set(), out = [];
    for (const p of ps) for (const x of p?.points ?? []) {
      const t = Date.parse(String(x?.[0]) + ':00Z') / 60000;
      if (!fin(t) || !fin(x[1]) || x[1] <= 0 || seen.has(t)) continue;
      seen.add(t); out.push({ t, v: x[1] });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  /* before: buckets wholly inside [t-15, t); peak: max bucket mean starting in (t, t+60], earliest on ties; at 30: the bucket holding t+30;
     back: first bucket after the peak <= before + 3 within t+90, else null (censored when the data stops before t+90). Usable: >= 2 before, >= 6 after. */
  /* R2.7 coverage: the spans of local minutes actually read. A window covers its 12 h, a truncated one only up to its last bucket, and nothing beyond `until` (now). */
  function saCover(ws, until = Infinity) {
    const sp = ws.filter((w) => w.data).map((w) => {
      const a = T0(w.date) + (w.half ? 720 : 0), last = w.data.truncated ? saSeries(w.data).at(-1) : null;
      return [a, Math.min(w.data.truncated ? (last ? last.t + 5 : a) : a + 720, until)];
    }).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]), out = [];
    for (const [a, b] of sp) { const p = out.at(-1); if (p && a <= p[1]) p[1] = Math.max(p[1], b); else out.push([a, b]); }
    return out;
  }
  const covered = (cov, a, b) => (cov ?? []).some(([x, y]) => x <= a && y >= b);
  /* cov: saCover spans; usable needs [t-15, t+60] read; the return counts as observed only when [t, t+90] was read with every 5-min bucket present. */
  function saResponse(s, t, cov) {
    const before = s.filter((p) => p.t >= t - 15 && p.t + 5 <= t), after = s.filter((p) => p.t > t && p.t <= t + 60);
    const r = { before: null, peak: null, peakAt: null, at30: null, rise: null, back: null, censored: false, usable: before.length >= 2 && after.length >= 6 && covered(cov, t - 15, t + 60) };
    if (!r.usable) return r;
    r.before = r1(mean(before.map((p) => p.v)));
    const pk = after.reduce((a, p) => p.v > a.v ? p : a);
    r.peak = pk.v; r.peakAt = pk.t - t; r.rise = r1(pk.v - r.before);
    r.at30 = s.find((p) => p.t <= t + 30 && t + 30 < p.t + 5)?.v ?? null;
    const ret = s.find((p) => p.t > pk.t && p.t <= t + 90 && p.v <= r.before + 3);
    r.back = ret ? ret.t - t : null;
    r.censored = !ret && !(covered(cov, t, t + 90) && s.filter((p) => p.t > t && p.t <= t + 90).length >= Math.floor((t + 90) / 5) - Math.floor(t / 5));
    return r;
  }
  /* Pulse chart: tap → the nearest log by minute (ties to the later); arrows → the previous/next log by time, stopping at the ends. */
  const saNearest = (evs, m) => evs.reduce((a, e) => { const d = Math.abs(e.m - m), da = a && Math.abs(a.m - m); return !a || d < da || (d === da && e.m > a.m) ? e : a; }, null);
  const saStep = (evs, id, dir) => { const s = [...evs].sort((a, b) => a.m - b.m), i = s.findIndex((e) => e.id === id); return s[Math.min(s.length - 1, Math.max(0, i + dir))] ?? null; };
  /* SQL rows (local_date, "tracker:localMinute …") → the 14 newest dates with a cigarette or coffee, their events, and the alcohol dates. */
  function saExposure(data, end) {
    const out = { dates: [], events: [], alcohol: [] }, c = data?.columns ?? [], di = c.indexOf('local_date'), ei = c.indexOf('ev');
    const rows = (Array.isArray(data?.rows) ? data.rows : []).filter((r) => typeof r[di] === 'string' && r[di] <= end).sort((a, b) => a[di] < b[di] ? 1 : a[di] > b[di] ? -1 : 0);
    for (const r of rows) {
      const d = r[di], evs = String(r[ei] ?? '').split(' ').map((s) => { const [type, t] = s.split(':'); return { type, t: Number(t), date: d }; }).filter((e) => fin(e.t));
      if (evs.some((e) => e.type === 'alcohol') && !out.alcohol.includes(d)) out.alcohol.push(d);
      const exp = evs.filter((e) => C5.includes(e.type));
      if (!exp.length || (!out.dates.includes(d) && out.dates.length >= 14)) continue;
      if (!out.dates.includes(d)) out.dates.push(d);
      out.events.push(...exp);
    }
    return out;
  }
  /* Heart-rate windows to read: both halves of each exposure date, plus the neighbour half an event's [t-15, t+90] reaches (never after end). */
  function saWindows(x, end) {
    const k = new Map(), add = (d, half) => { if (d <= end) k.set(d + ':' + half, [d, half]); };
    for (const d of x.dates) { add(d, 0); add(d, 1); }
    for (const e of x.events) { const m = e.t - T0(e.date); if (m < 15) add(L.shiftDate(e.date, -1), 1); if (m + 90 > 1440) add(L.shiftDate(e.date, 1), 0); }
    return [...k.values()];
  }
  /* C5 per type over the usable events; each log counts on its own (overlapping logs are not separated); back is the mean of the returns only. */
  function saC5(events, series, cov) {
    const o = {};
    for (const type of C5) {
      const rs = events.filter((e) => e.type === type).map((e) => saResponse(series, e.t, cov)).filter((r) => r.usable), backs = rs.map((r) => r.back).filter(fin);
      o[type] = { n: rs.length, learning: rs.length < 5, rise: rs.length ? r1(mean(rs.map((r) => r.rise))) : null, back: backs.length ? Math.round(mean(backs)) : null, backN: backs.length };
    }
    return o;
  }
  /* Alcohol: the night after each log date (its wake date) once, rhr minus that night's 28-day median; nights without rhr or a usual range are skipped. */
  function saAlcohol(vit, dates, end) {
    const d = [...new Set(dates)].map((x) => L.shiftDate(x, 1)).filter((n) => n <= end).map((n) => {
      const v = L.dayValue(vit, 'rhr', n), r = L.typicalRange(vit, 'rhr', n);
      return v != null && r.learning == null ? v - r.median : null;
    }).filter(fin);
    return { n: d.length, delta: d.length ? r1(mean(d)) : null, learning: d.length < 5 };
  }
  /* Tendencia: a vitals date (the wake date) is marked when the behaviour was logged the day before; out = beyond p10-p90; the association needs >= 3 marked days. */
  function saTrend(vit, m, end, days, cols) {
    const band = L.typicalRange(vit, m, end), wide = L.typicalRange(vit, m, end, true), learning = band.learning != null;
    const marked = (d) => !!cols && cols.some((c) => L.dayValue(vit, c, L.shiftDate(d, -1)) > 0);
    const pts = L.series(vit, m, end, days).map((p) => ({ date: p.date, v: p.v, marked: marked(p.date), out: !learning && p.v != null && L.rangeStatus(p.v, wide) !== 'in' }));
    const mk = pts.filter((p) => p.marked && p.v != null).map((p) => p.v), mm = mean(mk);
    const assoc = cols && !learning && mk.length >= 3 ? { n: mk.length, lo: Math.min(...mk), hi: Math.max(...mk), dir: mm < band.low ? 'down' : mm > band.high ? 'up' : 'in',
      k: pts.filter((p) => p.marked && p.out).length, m: pts.filter((p) => p.out).length } : null;
    return { pts, band, wide, learning, nMarked: mk.length, assoc };
  }
  /* Detalle: the chosen log while it exists on the shown date; else the latest cigarette or coffee logged >= 60 min before now
     (its response window is over); else the latest log. Ties: the later in the list. A past date has now = Infinity. */
  const latest = (evs) => evs.reduce((a, e) => !a || e.t >= a.t ? e : a, null);
  const saPick = (evs, sel, date, now = Infinity) => (sel?.date === date && evs.find((e) => e.id === sel.id))
    || latest(evs.filter((e) => (e.k === 'cig' || e.k === 'caffeine') && now - e.t >= 60)) || latest(evs);
  /* The behaviour whose share of known evenings before the lowest weekday exceeds its share of the other known evenings
     (before the other days with HRV, 56 days) by >= 30 points; the largest excess wins, ties keep the first in the list. */
  function saWeekLow(vit, end, lo) {
    const days = L.series(vit, 'hrv_rmssd', end, 56).filter((p) => p.v != null);
    let best = null;
    for (const col of ['alcohol_g', 'cigarettes', 'caffeine_mg']) {
      const prev = (on) => days.filter((p) => (L.weekday(p.date) === lo) === on).map((p) => L.dayValue(vit, col, L.shiftDate(p.date, -1))).filter((v) => v != null);
      const a = prev(true), b = prev(false), k = a.filter((v) => v > 0).length, kb = b.filter((v) => v > 0).length;
      if (!a.length || !b.length || 10 * (k * b.length - kb * a.length) < 3 * a.length * b.length) continue;   // integer form of k/m - kb/mb >= 0.3
      const x = k / a.length - kb / b.length;
      if (!best || x > best.x) best = { col, k, m: a.length, x };
    }
    return best;
  }

  /* ---- glyphs (G8, gen/sleep.py glyph/place) ---- */
  const filled = (shape, color) => '<g fill="var(--surface)" stroke="var(--surface)" stroke-width="2.2">' + shape + '</g><g fill="' + color + '" stroke="var(--fill-edge)" stroke-width=".9" paint-order="stroke">' + shape + '</g>';
  const GL = {
    caffeine: filled('<ellipse rx="4.2" ry="5.6"/>', 'var(--fill-caffeine)') + '<path d="M0 -4.6Q-2 -2.3 0 0Q2 2.3 0 4.6" fill="none" stroke="var(--on-fill-caffeine)" stroke-width="1.2"/>',
    cig: '<path d="M0 -7V7" stroke="var(--surface)" stroke-width="6.6"/><path d="M0 -7V7" stroke="var(--m-cig)" stroke-width="3"/>',
    alcohol: filled('<path d="M-4.6 -6.4H4.6V-3.2A4.6 4.6 0 0 1-4.6 -3.2Z"/>', 'var(--fill-alcohol)') + '<path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="var(--surface)" stroke-width="3.8"/><path d="M0 1.4V5.6M-2.8 5.6H2.8" fill="none" stroke="var(--m-alcohol)" stroke-width="1.6"/>',
    supp: filled('<rect x="-2.7" y="-5.8" width="5.4" height="11.6" rx="2.7"/>', 'var(--fill-supp)') + '<path d="M-2.7 0H2.7" stroke="var(--on-fill-supp)" stroke-width="1"/>',
    water: filled('<path d="M0 -6.2C-1.6 -3.6 -4.2 -1.2 -4.2 1.6A4.2 4.2 0 0 0 4.2 1.6C4.2 -1.2 1.6 -3.6 0 -6.2Z"/>', 'var(--fill-water)'),
    other: filled('<circle r="4"/>', 'var(--ink)')
  };
  const glyph = (k, face) => k === 'mood' ? filled('<circle r="5.5"/>', 'var(--mood-' + face + ')') : GL[k] ?? GL.other;
  const place = (k, x, y, face) => '<g transform="translate(' + x + ' ' + y + ')' + (k === 'cig' ? '' : ' scale(1.25)') + '" stroke-linecap="round" stroke-linejoin="round">' + glyph(k, face) + '</g>';
  const gsvg = (k) => '<svg width="20" height="20" viewBox="-10 -10 20 20" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round">' + glyph(k) + '</svg>';
  const lab = (x, y, s, anchor = 'start', size = 11, font = 'var(--font-sans)') => '<text x="' + x + '" y="' + y + '" text-anchor="' + anchor + '" font-size="' + size + '" font-weight="400" fill="var(--muted)" font-family="' + font + '" stroke="var(--surface)" stroke-width="3" paint-order="stroke">' + esc(s) + '</text>';
  const disc = (id) => typeof id === 'string' && id.startsWith('mood_') ? 'mood' : L.CHIPS.find((c) => c.id === id)?.disc ?? 'other';
  const path = (pts, X, Y, gap) => pts.reduce((s, p, i) => s + (i && p.x - pts[i - 1].x <= gap ? ' L' : (i ? ' M' : 'M')) + X(p.x) + ' ' + Y(p.v), '');

  /* ---- charts ---- */
  function trendSvg(W, tr, m, mark, aria, vn, day) {
    const n = tr.pts.length, G = 34, H = W > 400 ? 190 : 150, T = 14, B = H - 40, vals = tr.pts.map((p) => p.v).filter(fin);
    const ext = [...vals, ...(tr.learning ? [] : [tr.band.low, tr.band.high])];
    let lo = ext.length ? Math.min(...ext) : 0, hi = ext.length ? Math.max(...ext) : 1; const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
    const Y = (v) => r1(B - (v - lo) / (hi - lo) * (B - T)), X = (i) => r1(G + i / Math.max(1, n - 1) * (W - G - 8));
    const o = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(aria) + '">'];
    if (!tr.learning) o.push('<rect x="' + G + '" y="' + Y(tr.band.high) + '" width="' + (W - G - 8) + '" height="' + r1(Math.max(1, Y(tr.band.low) - Y(tr.band.high))) + '" fill="var(--band)"/>');
    for (const v of [lo + (hi - lo) / 4, lo + 3 * (hi - lo) / 4]) o.push('<path d="M' + G + ' ' + Y(v) + 'H' + (W - 8) + '" stroke="var(--line)" stroke-width="1"/>', lab(G - 6, Y(v) + 4, vn(v), 'end', 10, 'var(--font-mono)'));
    tr.pts.forEach((p, i) => { if (p.marked) o.push('<path d="M' + X(i) + ' ' + T + 'V' + B + '" stroke="var(--' + MARK_COL[mark] + ')" stroke-width="6" opacity=".18"/>'); });
    o.push('<path d="' + path(tr.pts.map((p, i) => ({ x: i, v: p.v })).filter((p) => fin(p.v)), X, Y, 1) + '" fill="none" stroke="var(--ink)" stroke-width="1.75" stroke-linejoin="round"/>');
    tr.pts.forEach((p, i) => { const last = i === n - 1; if (fin(p.v) && (p.out || last)) o.push('<circle cx="' + X(i) + '" cy="' + Y(p.v) + '" r="' + (last ? 4.5 : 3) + '" fill="var(--' + (last ? 'ink' : 'surface') + ')" stroke="var(--ink)" stroke-width="1.5"/>'); });
    tr.pts.forEach((p, i) => { if (p.marked) o.push(place(MARK_GL[mark], X(i), B + 12)); });
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i, j) => o.push(lab(X(i), H - 4, day(tr.pts[i].date), j === 0 ? 'start' : j === 2 ? 'end' : 'middle', 10)));
    return o.join('') + '</svg>';
  }
  function pulseSvg(W, pts, evs, o) {
    const G = 34, H = 170, LOGY = 18, T = 40, B = 140, X = (m) => r1(G + Math.min(1440, Math.max(0, m)) / 1440 * (W - G - 8)), vs = pts.map((p) => p.v);
    const lo = vs.length ? Math.floor((Math.min(...vs) - 5) / 10) * 10 : 40, hi = vs.length ? Math.ceil((Math.max(...vs) + 5) / 10) * 10 : 110, Y = (v) => r1(B - (v - lo) / (hi - lo) * (B - T));
    const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(o.aria) + '">'];
    if (o.sleep) out.push('<rect x="' + X(o.sleep[0]) + '" y="' + T + '" width="' + r1(X(o.sleep[1]) - X(o.sleep[0])) + '" height="' + (B - T) + '" fill="var(--band)"/>', lab(r1((X(o.sleep[0]) + X(o.sleep[1])) / 2), T + 12, o.sleepLabel, 'middle', 10));
    if (o.sel) out.push('<rect x="' + X(o.sel.m - 90) + '" y="' + (LOGY - 12) + '" width="' + r1(X(o.sel.m + 90) - X(o.sel.m - 90)) + '" height="' + (B - LOGY + 12) + '" rx="4" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-dasharray="4 3"/>');
    for (let v = lo + 10; v < hi; v += 20) out.push('<path d="M' + G + ' ' + Y(v) + 'H' + (W - 8) + '" stroke="var(--line)" stroke-width="1"/>', lab(G - 6, Y(v) + 4, String(v), 'end', 10, 'var(--font-mono)'));
    if (pts.length) out.push('<path d="' + path(pts.map((p) => ({ x: p.m, v: p.v })), X, Y, 10) + '" fill="none" stroke="var(--m-hr)" stroke-width="1.75" stroke-linejoin="round"/>');
    if (o.now != null) out.push('<path d="M' + X(o.now) + ' ' + (LOGY - 10) + 'V' + B + '" stroke="var(--primary)" stroke-width="2"/>');
    let last = -99;
    for (const e of [...evs].sort((a, b) => a.m - b.m)) {
      const x = r1(Math.max(X(e.m), last + 9.5)); last = x;
      out.push(place(e.k, x, LOGY, e.face));
    }
    [0, 360, 720, 1080, 1440].forEach((m) => out.push(lab(X(m), H - 6, String(m / 60).padStart(2, '0'), 'middle', 11, 'var(--font-mono)')));
    return out.join('') + '</svg>';
  }
  function detailSvg(W, s, ev, r, o) {
    const G = 8, H = 96, T = 8, B = 72, X = (m) => r1(G + (m + 90) / 180 * (W - 16)), pts = s.filter((p) => Math.abs(p.t - ev.t) <= 90).map((p) => ({ x: p.t - ev.t, v: p.v }));
    const vs = [...pts.map((p) => p.v), ...(fin(r.before) ? [r.before] : [])], lo = (vs.length ? Math.min(...vs) : 50) - 4, hi = (vs.length ? Math.max(...vs) : 90) + 4, Y = (v) => r1(B - (v - lo) / (hi - lo) * (B - T));
    const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(o.aria) + '">'];
    if (fin(r.before)) out.push('<path d="M' + G + ' ' + Y(r.before) + 'H' + (W - 8) + '" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="3 3"/>');
    if (pts.length) out.push('<path d="' + path(pts, X, Y, 10) + '" fill="none" stroke="var(--m-hr)" stroke-width="1.75"/>');
    out.push('<path d="M' + X(0) + ' ' + (T - 4) + 'V' + B + '" stroke="var(--ink)" stroke-width="1"/>', place(ev.k, X(0), T + 2, ev.face));
    [-90, 0, 90].forEach((m) => out.push(lab(X(m), H - 6, hhmm(ev.t + m), m < 0 ? 'start' : m > 0 ? 'end' : 'middle', 10, 'var(--font-mono)')));
    if (fin(r.before)) out.push(lab(W - 8, Y(r.before) - 5, o.base, 'end', 10));
    return out.join('') + '</svg>';
  }

  /* ---- render ---- */
  let shown = null;   // the date of the last render, to reset the Detalle selection when it changes
  function render(ctx) {
    const { t, lang } = ctx, h = HT.h, D = ctx.date, today = D === ctx.today, num = (x, d) => L.fmt.num(x, lang, d), sg = (x) => L.fmt.signed(x, lang, 0);
    const full = ctx.root.clientWidth || 340, desk = typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches;
    const W = (cols) => Math.max(280, Math.round((desk ? (full + 16) * cols / 12 - 16 : full) - 40));
    const card = (cls, title, sub, body, foot) => ctx.ins.card({ cls, title, sub, body, foot, footCls: 'hx-note sx-foot' });
    const fv = (m, x) => m === 'spo2_avg' ? L.fmt.vital(m, x, lang).replace(/^[\d.,]+/, num(x, 0)) : L.fmt.vital(m, x, lang);   // the board shows SpO₂ whole ("97 %")
    const vn = (m, x) => fv(m, x).replace(/( .*|%)$/, '');
    const rng = (m, r) => m === 'skin_temp_dev' ? t('sa.to', { a: vn(m, r.low), b: vn(m, r.high) }) : vn(m, r.low) + '–' + vn(m, r.high);
    const hrSrc = (d, half) => ({ ...ctx.source('saHr:' + d + ':' + half, { tool: 'health_intraday', through: d, watch: d < ctx.today ? PAST : null,
      input: () => ({ metric: 'hr', date: d, resolution: '5m', from: half ? '12:00' : '00:00', to: half ? '24:00' : '12:00' }) }), date: d, half });
    const until = today ? T0(D) + ctx.min : Infinity;   // today is read only up to now
    const partialOf = (srcs) => srcs.some((s) => s.error || s.data?.truncated);
    const loadingOf = (srcs) => srcs.map((s) => s.data == null && !s.error ? s.state('saHr', 3) : null).find(Boolean) ?? null;

    // vitals: 90 days (C1 night for today; a chosen past day keeps its own)
    const vs = ctx.source('vitals'), vst = vs.state('vitals', 4), vit = vst ? null : vs.data;
    const night = !vit ? null : today ? L.recoveryNight(vit, D) : D;
    const hasVit = !!night && VORD.some((m) => L.dayValue(vit, m, night) != null);
    // the shown day's pulse (two windows, R2.6) and logs (v_events, so more than 50 logs keep the latest)
    const day = [hrSrc(D, 0), hrSrc(D, 1)], dayLoading = loadingOf(day), dayPartial = partialOf(day);
    const dayS = saSeries(...day.map((s) => s.data)).filter((p) => p.t >= T0(D) && p.t < T0(D) + 1440), pts = dayS.map((p) => ({ m: p.t - T0(D), v: p.v }));
    const lowP = pts.reduce((a, p) => !a || p.v < a.v ? p : a, null), highP = pts.reduce((a, p) => !a || p.v > a.v ? p : a, null), complete = !dayLoading && !dayPartial && !!pts.length;
    const ds = ctx.source('saDay', { tool: 'health_sql', through: (d) => d, input: (d) => ({ query: "SELECT id, tracker_id, (ts + tz_offset_min * 60) / 60 AS lm FROM v_events WHERE local_date = '" + d + "' ORDER BY ts DESC LIMIT 200" }) });
    const dst = ds.state('saDay', 2), dc = ds.data?.columns ?? [];
    const evs = (dst ? [] : ds.data?.rows ?? []).map((r) => { const id = r[dc.indexOf('tracker_id')], k = disc(id), face = k === 'mood' ? L.MOODS.find((x) => x.id === id)?.face : null;
      return { id: String(r[dc.indexOf('id')]), k, face, t: r[dc.indexOf('lm')], m: r[dc.indexOf('lm')] - T0(D), name: t('sa.k.' + k) }; }).filter((e) => fin(e.t));
    evs.forEach((e) => { e.label = t('sa.evLabel', { x: e.name, t: hhmm(e.t) }); });
    // C5 history (R2.6b): the 14 newest dates with a cigarette or coffee in 30 days, plus the neighbour halves near midnight
    const xs = ctx.source('saExp', { tool: 'health_sql', through: (d) => d, input: (d) => ({ query: "SELECT local_date, group_concat(tracker_id || ':' || ((ts + tz_offset_min * 60) / 60), ' ') AS ev FROM v_events WHERE tracker_id IN ('cigarettes', 'caffeine', 'alcohol') AND local_date BETWEEN '" + L.shiftDate(d, -29) + "' AND '" + d + "' GROUP BY local_date ORDER BY local_date DESC" }) });
    const xst = xs.state('saExp', 3), xCut = !xst && !!xs.data?.truncated, exp = saExposure(xst ? null : xs.data, D), wins = saWindows(exp, D).map(([d, half]) => hrSrc(d, half));
    const c5 = saC5(exp.events, saSeries(...wins.map((s) => s.data)), saCover(wins, until)), alc = saAlcohol(vit, exp.alcohol, D);

    // 1. Resumen
    const outs = hasVit ? L.outliers(vit, night) : [], the = (m) => t('sa.the.' + m);
    const lead = !hasVit ? t('sa.noVit') : VORD.every((m) => L.typicalRange(vit, m, night).learning != null) ? t('sa.leadLearn') : !outs.length ? t('sa.leadIn')
      : outs.length === 1 ? t('sa.leadOne', { x: the(outs[0].metric), s: t('sa.' + outs[0].status), v: fv(outs[0].metric, outs[0].value) })
      : t('sa.leadMany', { x: outs.slice(0, -1).map((o) => the(o.metric) + ' (' + t('sa.' + o.status) + ')').join(', ') + t('sa.and') + the(outs.at(-1).metric) + ' (' + t('sa.' + outs.at(-1).status) + ')' });
    const sumSub = [hasVit ? t('sa.nightSub', { a: L.fmt.wday(L.shiftDate(night, -1), lang), b: L.fmt.wday(night, lang) }) : null,
      complete ? t(today ? 'sa.hrToday' : 'sa.hrDay', { a: num(lowP.v), b: num(highP.v) }) : null].filter(Boolean).join(' ');
    const sum = h('section', { class: 'hx-sum' }, h('p', { class: 'met-l', text: t('sa.sum.t') }), vst ?? h('p', { class: 'hx-lead', text: lead }), sumSub ? h('p', { class: 'hx-sub', text: sumSub }) : null);

    // 2. Constantes
    const strip = (v, r, w) => {
      const ok = r.learning == null, xsx = [v, ...(ok ? [w.low, w.high] : [])].filter(fin); if (!xsx.length) return h('div', { class: 'hx-strip', 'aria-hidden': 'true' }, h('i', { class: 'hx-line' }));
      let a = Math.min(...xsx), b = Math.max(...xsx); const pad = (b - a) * 0.15 || 1; a -= pad; b += pad;
      const P = (x) => r1((x - a) / (b - a) * 100) + '%';
      return h('div', { class: 'hx-strip', 'aria-hidden': 'true' }, h('i', { class: 'hx-line' }), ok ? h('i', { class: 'hx-band', style: 'left:' + P(r.low) + ';width:' + r1((r.high - r.low) / (b - a) * 100) + '%' }) : null,
        fin(v) ? h('i', { class: 'hx-dot', style: 'left:' + P(v) + ';background:var(--ink)' }) : null);
    };
    const vitRow = (m) => {
      const v = L.dayValue(vit, m, night), r = L.typicalRange(vit, m, night), w = L.typicalRange(vit, m, night, true), flag = L.rangeFlag(v, w), ref = L.HREF[m];
      const sub = [r.learning != null ? t('sa.usualLearn', { n: r.n }) : t('sa.usual', { r: rng(m, r) })];
      const clinic = m === 'rhr' || m === 'spo2_avg' ? t('sa.clinic', { r: ref[1] == null ? '≥' + vn(m, ref[0]) : vn(m, ref[0]) + '–' + vn(m, ref[1]) }) : null;
      return h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: t('sa.v.' + m) }), strip(v, r, w), h('span', { class: 'hx-v', text: v == null ? '—' : m === 'resp_rate' ? vn(m, v) + ' ' + t('sa.rpm') : fv(m, v) }),   // the board's short unit keeps the row in 375 px
        h('span', { class: 'hx-s' }, sub[0], flag ? [' · ', h('b', { class: 'hx-up', text: t('sa.' + flag) })] : null, clinic ? ' · ' + clinic : null));
    };
    const vState = () => vs.state('vitals', 4);   // a fresh box per card: one element cannot sit in several cards
    const vitC = card('hx-key hx-vit', t('sa.vit.t'), hasVit ? t('ins.night', { d: L.fmt.wday(L.shiftDate(night, -1), lang) }) : null, vst ? [vState()] : hasVit ? [...VORD.map(vitRow), vs.stale('vitals')] : [h('p', { class: 'hx-sub', text: t('sa.noVit') })]);

    // 3. Tendencia
    const metric = HT.sel.get('salud:metric') ?? 'hrv_rmssd', span = HT.sel.get('salud:days') ?? 30, mark = HT.sel.get('salud:mark') ?? null;
    const pick = (key, v) => () => { HT.sel.set(key, v); ctx.rerender(); };
    const seg = (label, items) => h('div', { class: 'hx-seg hx-seg-s', role: 'group', 'aria-label': label }, items.map(([text, on, fk, f]) => h('button', { type: 'button', 'aria-pressed': String(on), 'data-fk': fk, onclick: f }, text)));
    let trendBody;
    if (vst) trendBody = [vState()];
    else {
      const tr = saTrend(vit, metric, D, span, mark ? MARK[mark] : null), name = t('sa.low.' + metric), last = tr.pts.at(-1)?.v;
      const aria = t('sa.trendAria', { m: t('sa.v.' + metric), n: span, r: tr.learning ? '—' : rng(metric, tr.band), v: fin(last) ? fv(metric, last) : '—' });
      const a = tr.assoc, line = tr.learning ? ctx.ins.learning(ctx, tr.band.n, 7, { unit: 'nights' })
        : h('p', { class: 'hx-sub hx-sep', text: !mark ? t('sa.outN', { k: tr.pts.filter((p) => p.out).length, n: span })
          : !a ? t('sa.assocFew', { n: tr.nMarked })
          : t('sa.assoc', { n: a.n, x: t('sa.after.' + mark), m: name, v: t('sa.dir.' + a.dir), r: a.lo === a.hi ? fv(metric, a.lo) : vn(metric, a.lo) + '–' + fv(metric, a.hi) })
            + (a.m ? ' ' + t('sa.assocOut', { k: a.k, m: a.m }) : '') + ' ' + t('sa.cause') });
      trendBody = [h('div', { class: 'hx-ctl' }, seg(t('sa.metricR'), VORD.map((m) => [t('sa.seg.' + m), m === metric, 'sa-m-' + m, pick('salud:metric', m)])),
        seg(t('sa.periodR'), [30, 90].map((n) => [t('sa.days', { n }), n === span, 'sa-d-' + n, pick('salud:days', n)]))),
        h('div', { html: trendSvg(W(desk ? 7 : 12), tr, metric, mark, aria, (v) => vn(metric, v), (d) => L.fmt.day(d, lang)) }),
        h('div', { class: 'hx-legend', role: 'group', 'aria-label': t('sa.markL') }, h('span', { text: t('sa.markL') }),
          [null, 'cafe', 'cigarro', 'alcohol', 'animo'].map((k) => h('button', { type: 'button', class: 'ht-pill' + (k === mark ? ' hx-on' : ''), 'aria-pressed': String(k === mark), 'data-fk': 'sa-k-' + (k ?? 'none'), onclick: pick('salud:mark', k) },
            k && k === mark ? h('span', { html: gsvg(MARK_GL[k]) }) : null, t('sa.mk.' + (k ?? 'none'))))), line];
    }
    const trend = card('hx-trend', t('sa.trend.t'), t('sa.trend.s'), trendBody);

    // 4. Pulso de hoy, 5. Detalle
    // Detalle selection: forgotten on a date change or once the chosen log is gone (undo), so it falls back to the latest
    if (shown !== D || (HT.sel.get('salud:det') && !dst && !evs.some((e) => e.id === HT.sel.get('salud:det').id))) HT.sel.delete('salud:det');
    shown = D;
    const sel = saPick(evs, HT.sel.get('salud:det'), D, until), session = L.mainSession(ctx.source('sleep').data?.sessions, D);
    const sleep = session && typeof session.start_local === 'string' && typeof session.end_local === 'string'
      ? [session.start_local.slice(0, 10) < D ? 0 : L.localMinutes(session.start_local), session.end_local.slice(0, 10) > D ? 1440 : L.localMinutes(session.end_local)] : null;
    // R1.4/AC10: one hit band over the whole chart (taller than 44 px) picks the nearest log at the tap; one tab stop, arrows move between logs
    const PW = W(desk ? 8 : 12), choose = (e) => { if (!e) return; HT.sel.set('salud:det', { date: D, id: e.id }); ctx.rerender(); };
    const tap = (e) => { const r = e.currentTarget.getBoundingClientRect(), vb = (e.clientX - r.left) * PW / (r.width || PW); choose(saNearest(evs, (vb - 34) / (PW - 42) * 1440)); };
    const key = (e) => { const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, Home: -evs.length, End: evs.length }[e.key]; if (d == null || !sel) return; e.preventDefault?.(); choose(saStep(evs, sel.id, d)); };
    const pulseBody = dayLoading ? [dayLoading] : [
      pts.length || evs.length ? h('div', { class: 'sa-plot' }, h('div', { html: pulseSvg(PW, pts, evs, { sleep: sleep && sleep.every(fin) ? sleep : null, sleepLabel: t('sa.sleep'), now: today ? ctx.min : null, sel,
        aria: complete ? t('sa.pulseAria', { a: num(lowP.v), b: num(highP.v), n: evs.length }) : t('sa.pulseAriaN', { n: evs.length }) }) }),
        sel ? h('div', { class: 'sa-band', tabindex: '0', role: 'slider', 'data-fk': 'sa-evs', 'aria-label': t('sa.evsR'), 'aria-valuemin': '0', 'aria-valuemax': '1440', 'aria-valuenow': String(Math.round(sel.m)),
          'aria-valuetext': sel.label, onclick: tap, onkeydown: key }) : null) : h('p', { class: 'hx-sub', text: t('sa.noHr') }),
      dayPartial ? h('p', { class: 'hx-note', text: t('sa.partial') }) : null,
      evs.length ? h('p', { class: 'hx-note', text: t('sa.pulseNote') }) : null, day[0].stale('saHr')];
    const pulse = card('hx-pulse', t(today ? 'sa.pulse.t' : 'sa.pulse.tD'), complete ? t('sa.minmax', { a: num(lowP.v), at: hhmm(lowP.m), b: num(highP.v), bt: hhmm(highP.m) }) : null, pulseBody);
    let det;
    if (dst) det = card('hx-det', t('sa.det.t'), null, [dst]);
    else if (!sel) det = card('hx-det', t('sa.det.t'), null, [h('p', { class: 'hx-sub', text: t('sa.det.none') })]);
    else {
      // the ±90 min chart reads the neighbour half-day when it crosses midnight (never a date after today)
      const m = sel.t - T0(D), extra = [m < 90 ? hrSrc(L.shiftDate(D, -1), 1) : null, m + 90 > 1440 && L.shiftDate(D, 1) <= ctx.today ? hrSrc(L.shiftDate(D, 1), 0) : null].filter(Boolean);
      const ws = [...day, ...extra], loading = loadingOf(ws), s = saSeries(...ws.map((x) => x.data)), r = saResponse(s, sel.t, saCover(ws, until)), type = { caffeine: 'caffeine', cig: 'cigarettes' }[sel.k];
      const stat = (k, v) => h('div', {}, h('span', { text: t(k) }), h('b', { text: fin(v) ? num(v) : '—' }));
      const text = !r.usable ? [t(sel.t + 60 > until ? 'sa.detWait' : 'sa.detFew')] : [h('b', { text: t('sa.bpm', { x: sg(r.rise) }) }), t('sa.detAt', { m: r.peakAt }) + (r.back != null ? t('sa.detBack', { k: r.back }) : r.censored ? '.' : t('sa.detNoBack'))
        + (type && !c5[type].learning && !xst && !xCut ? t('sa.detMean.' + type, { x: sg(c5[type].rise), n: c5[type].n }) + ' ' + t('sa.cause') : '')];
      det = card('hx-det', sel.name + ' · ' + hhmm(sel.t), t('sa.det.s'), loading ? [loading] : [
        h('div', { html: detailSvg(desk ? W(4) : W(12), s, sel, r, { aria: t('sa.detAria', { x: sel.name, t: hhmm(sel.t) }), base: fin(r.before) ? t('sa.base', { v: num(r.before) }) : '' }) }),
        h('div', { class: 'hx-stats' }, stat('sa.before', r.before), stat('sa.peak', r.peak), stat('sa.at30', r.at30)), h('p', { class: 'hx-sub' }, text)]);
    }

    // 6. Cómo responde tu pulso (C5)
    const mx = Math.max(10, ...[c5.cigarettes, c5.caffeine, alc].filter((x) => !x.learning).map((x) => Math.abs(x.rise ?? x.delta)));
    const rrow = (k, gl, x, v, sub) => h('div', { class: 'hx-rs' }, h('span', { class: 'hx-gl', html: gsvg(gl) }), h('span', { class: 'hx-n', text: t('sa.r.' + k) }),
      h('div', { class: 'hx-bar' }, x.learning ? null : h('i', { style: 'width:' + r1(Math.abs(v) / mx * 100) + '%;background:var(--m-hr)' })),
      h('span', { class: 'hx-v', text: x.learning ? '—' : t('sa.bpm', { x: sg(v) }) }), h('span', { class: 'hx-s', text: x.learning ? t('sa.few', { n: x.n }) : sub }));
    const c5Loading = xst ?? loadingOf(wins);
    // R2.7: every row (alcohol included) rests on the 30-day log history, so a truncated history shows only the partial note
    const resp = card('hx-resp', t('sa.resp.t'), t('sa.resp.s'), c5Loading ? [c5Loading] : xCut ? [h('p', { class: 'hx-sub', text: t('sa.expPartial') }), xs.stale('saExp')] : [
      ...C5.map((k) => rrow(k, k === 'cigarettes' ? 'cig' : 'caffeine', c5[k], c5[k].rise, t(c5[k].back != null ? 'sa.backMean' : 'sa.noBackMean', { m: c5[k].back, k: c5[k].backN, n: c5[k].n }))),
      vst ? null : rrow('alcohol', 'alcohol', alc, alc.delta, t('sa.alcSub', { n: alc.n })),
      partialOf(wins) ? h('p', { class: 'hx-note', text: t('sa.c5Partial') }) : null, xs.stale('saExp')], t('sa.resp.foot') + ' ' + t('sa.cause'));

    // 8. Según el día (I2), 9. Cambios (I1), 7. Hallazgos (I4)
    const ser = vit ? L.series(vit, 'hrv_rmssd', D, 56) : [], band = vit ? L.typicalRange(vit, 'hrv_rmssd', D) : { learning: 7 };
    const st = vit ? L.weekdayStats(ser, D) : null;
    // review 2026-10-23 #4: no weekday claim (extreme or behaviour) until 4 weekdays have a mean (>= 3 samples each)
    const few = st && !st.learning && st.means.filter((m) => m != null).length < 4, low = st && !st.learning && !few && st.loClear ? saWeekLow(vit, D, st.lo) : null;
    const clause = low ? t('sa.wkLow', { k: low.k, m: low.m, d: t('sa.wkDays').split(' ')[(st.lo + 6) % 7], x: t('sa.wkX.' + low.col) }) + ' ' + t('sa.cause') : null;
    // the shared card redraws its sentence on every chip tap, so the "Todos" sentence keys carry the clause or the too-few copy (one paragraph)
    const TODOS = ['ins.wk.ext', 'ins.wk.hi', 'ins.wk.lo', 'ins.wk.flat'];
    const wctx = few ? { ...ctx, t: (k, v) => TODOS.includes(k) ? t('sa.wkFew') : ctx.t(k, v) }
      : clause ? { ...ctx, t: (k, v) => ctx.t(k, v) + (k === 'ins.wk.lo' || k === 'ins.wk.ext' ? ' ' + clause : '') } : ctx;
    const wk = vst ? card('ix-week', t('ins.wk.title'), t('sa.wk.s'), [vState()]) : ctx.ins.weekday(wctx, { id: 'hrv', series: ser,
      variant: { fmt: (x) => num(x), color: 'm-hrv', H: desk ? 170 : 120, W: W(desk ? 6 : 12), ...(band.learning == null ? { band: [band.low, band.high], lo: band.low - 9 } : {}) } });
    wk.querySelector('.ht-card-s')?.replaceChildren(t('sa.wk.s'));
    const chg = ctx.ins.changes(ctx, { metrics: ['rhr', 'hrv', 'resp_rate', 'spo2_avg', 'skin_temp_dev'], rows: vit });
    const find = ctx.ins.findings(ctx, { title: t('sa.find.t'), filter: (f) => ['rhr', 'hrv', 'resp_rate', 'spo2_avg', 'skin_temp_dev'].includes(f?.ref?.key?.metric) });

    // G1: DOM order of the phone board; desktop rows and columns of the 1280 board
    ctx.ins.layout(ctx.root, [[sum, 1, 1, 13], [vitC, 2, 1, 6], [trend, 2, 6, 13], [pulse, 3, 1, 9], [det, 3, 9, 13], [resp, 4, 1, 7], [wk, 5, 1, 7], [chg, 5, 7, 13], [find, 4, 7, 13]]);
  }

  const CSS = `
#g-health .hx-sum .met-l { margin: 0; }
#g-health .hx-vit .hx-row:nth-child(2), #g-health .hx-rs:nth-child(2) { border-top: 0; }
#g-health .hx-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
#g-health .hx-stats div { background: var(--surface-2); border-radius: var(--radius-sm); padding: 8px 10px; display: grid; }
#g-health .hx-stats span { font-size: 11px; color: var(--muted); } #g-health .hx-stats b { font: 500 17px/22px var(--font-mono); }
#g-health .hx-up { color: var(--ink); font-weight: var(--w-strong); }
#g-health .hx-ctl { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 8px; }
#g-health .hx-seg-s { margin: 0; } #g-health .hx-seg-s button { min-width: 0; padding: 0 10px; }
#g-health .hx-trend .hx-legend { margin-top: 8px; align-items: center; }
#g-health .hx-trend .ht-pill { gap: 4px; min-height: 44px; border: 0; font: inherit; cursor: pointer; display: inline-flex; align-items: center; }
#g-health .hx-on { background: var(--container) !important; color: var(--on-container) !important; } #g-health .hx-on svg { width: 16px; height: 16px; display: block; }
#g-health .hx-det { display: flex; flex-direction: column; gap: 8px; } #g-health .hx-det b { color: var(--ink); }
#g-health .hx-rs { display: grid; grid-template-columns: 24px 88px 1fr auto; gap: 2px 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
#g-health .hx-rs .hx-s { grid-column: 2 / -1; } #g-health .hx-rs .hx-v { font-size: 15px; }
#g-health .sa-plot { position: relative; }
#g-health .sa-band { position: absolute; inset: 0; min-height: 44px; cursor: pointer; border-radius: var(--radius-sm); }
#g-health .sa-band:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
@media (min-width: 1200px) { #g-health .hx-trend .ht-pill { min-height: 32px; } #g-health .hx-find { display: block; } #g-health .hx-find .hx-f { margin-bottom: 8px; } }
`;

  const copy = {
    'sa.sum.t': ['Last night’s vitals', 'Constantes de anoche'],
    'sa.leadIn': ['Everything within your usual range.', 'Todo dentro de lo habitual.'],
    'sa.leadOne': ['Everything within your usual range except {x}, which is {s}: {v}.', 'Todo dentro de lo habitual salvo {x}, que está {s}: {v}.'],
    'sa.leadMany': ['Outside your usual range: {x}.', 'Fuera de lo habitual: {x}.'],
    'sa.leadLearn': ['Still learning your usual vitals.', 'Aún estoy aprendiendo tus constantes habituales.'],
    'sa.and': [' and ', ' y '],
    'sa.above': ['above', 'por encima'], 'sa.below': ['below', 'por debajo'],
    'sa.the.hrv_rmssd': ['your HRV', 'la VFC'], 'sa.the.rhr': ['your resting heart rate', 'el pulso en reposo'], 'sa.the.resp_rate': ['your breathing rate', 'la respiración'],
    'sa.the.spo2_avg': ['your SpO₂', 'la SpO₂'], 'sa.the.skin_temp_dev': ['your temperature', 'la temperatura'],
    'sa.nightSub': ['Measured during your sleep from {a} to {b}.', 'Medidas durante el sueño del {a} al {b}.'],
    'sa.hrToday': ['Your heart rate today has ranged from {a} to {b} bpm.', 'Tu pulso hoy ha ido de {a} a {b} lpm.'],
    'sa.hrDay': ['Your heart rate that day ranged from {a} to {b} bpm.', 'Tu pulso ese día fue de {a} a {b} lpm.'],
    'sa.noVit': ['No vitals in the last 14 nights.', 'Sin constantes en las últimas 14 noches.'],
    'sa.vit.t': ['Vitals', 'Constantes'],
    'sa.v.hrv_rmssd': ['HRV', 'VFC'], 'sa.v.rhr': ['Resting heart rate', 'Pulso en reposo'], 'sa.v.resp_rate': ['Breathing', 'Respiración'], 'sa.v.spo2_avg': ['SpO₂', 'SpO₂'], 'sa.v.skin_temp_dev': ['Temperature', 'Temperatura'],
    'sa.rpm': ['brpm', 'rpm'],
    'sa.usual': ['usual {r}', 'habitual {r}'],
    'sa.usualLearn': ['usual range: {n} of 7 nights so far', 'habitual: {n} de 7 noches por ahora'],
    'sa.to': ['{a} to {b}', '{a} a {b}'],
    'sa.clinic': ['clinical {r}', 'clínico {r}'],
    'sa.trend.t': ['Trend', 'Tendencia'], 'sa.trend.s': ['shaded: your usual range', 'sombreado: tu rango habitual'],
    'sa.seg.hrv_rmssd': ['HRV', 'VFC'], 'sa.seg.rhr': ['Resting', 'Reposo'], 'sa.seg.resp_rate': ['Resp.', 'Resp.'], 'sa.seg.spo2_avg': ['SpO₂', 'SpO₂'], 'sa.seg.skin_temp_dev': ['Temp.', 'Temp.'],
    'sa.days': ['{n} d', '{n} d'], 'sa.metricR': ['Metric', 'Métrica'], 'sa.periodR': ['Period', 'Periodo'],
    'sa.markL': ['Mark days with', 'Marcar días con'],
    'sa.mk.none': ['None', 'Ninguno'], 'sa.mk.cafe': ['Coffee', 'Café'], 'sa.mk.cigarro': ['Cigarette', 'Cigarro'], 'sa.mk.alcohol': ['Alcohol', 'Alcohol'], 'sa.mk.animo': ['Mood', 'Ánimo'],
    'sa.after.cafe': ['coffee', 'café'], 'sa.after.cigarro': ['cigarettes', 'cigarros'], 'sa.after.alcohol': ['alcohol', 'alcohol'], 'sa.after.animo': ['a mood log', 'registrar ánimo'],
    'sa.low.hrv_rmssd': ['HRV', 'VFC'], 'sa.low.rhr': ['resting heart rate', 'pulso en reposo'], 'sa.low.resp_rate': ['breathing rate', 'respiración'], 'sa.low.spo2_avg': ['SpO₂', 'SpO₂'], 'sa.low.skin_temp_dev': ['temperature', 'temperatura'],
    'sa.dir.down': ['fell to', 'bajó a'], 'sa.dir.up': ['rose to', 'subió a'], 'sa.dir.in': ['stayed at', 'estuvo en'],
    'sa.assoc': ['On the {n} days after {x} your {m} {v} {r}.', 'Los {n} días tras {x} tu {m} {v} {r}.'],
    'sa.assocOut': ['{k} of the {m} days outside your usual range were those.', '{k} de los {m} días fuera de lo habitual fueron esos.'],
    'sa.assocFew': ['Too few marked days to relate them ({n} of 3).', 'Aún pocos días marcados para relacionarlos ({n} de 3).'],
    'sa.outN': ['{k} of {n} days outside your usual range.', '{k} de {n} días fuera de lo habitual.'],
    'sa.cause': ['They go together; that does not prove cause.', 'Van juntos, no prueba causa.'],
    'sa.trendAria': ['{m} over the last {n} days against your usual range {r}; latest {v}.', '{m} de los últimos {n} días frente a tu rango habitual {r}; último {v}.'],
    'sa.pulse.t': ['Today’s heart rate', 'Pulso de hoy'], 'sa.pulse.tD': ['Heart rate that day', 'Pulso de ese día'],
    'sa.minmax': ['min {a} · {at} · max {b} · {bt}', 'mín {a} · {at} · máx {b} · {bt}'],
    'sa.sleep': ['sleep', 'sueño'],
    'sa.pulseNote': ['Tap a log to see your heart rate 90 min before and after.', 'Toca un registro para ver tu pulso 90 min antes y después.'],
    'sa.partial': ['Heart rate is missing for part of the day.', 'Faltan datos de pulso de parte del día.'],
    'sa.noHr': ['No heart rate for this day yet.', 'Aún no hay pulso de este día.'],
    'sa.pulseAria': ['Heart rate from {a} to {b} bpm; {n} logs to select.', 'Pulso de {a} a {b} lpm; {n} registros para elegir.'],
    'sa.pulseAriaN': ['Heart rate of the day; {n} logs to select.', 'Pulso del día; {n} registros para elegir.'],
    'sa.evLabel': ['{x} at {t}', '{x} a las {t}'],
    'sa.det.t': ['Detail', 'Detalle'], 'sa.det.s': ['±90 min', '±90 min'], 'sa.det.none': ['No logs this day.', 'Sin registros este día.'],
    'sa.before': ['before', 'antes'], 'sa.peak': ['peak', 'pico'], 'sa.at30': ['at 30 min', 'a los 30 min'],
    'sa.base': ['your baseline {v}', 'tu base {v}'], 'sa.bpm': ['{x} bpm', '{x} lpm'],
    'sa.detAt': [' at {m} min', ' a los {m} min'],
    'sa.detBack': ['; back to your baseline in {k} min.', '; volvió a tu base en {k} min.'],
    'sa.detNoBack': ['; not back to your baseline within 90 min.', '; no volvió a tu base en 90 min.'],
    'sa.detMean.cigarettes': [' Your average after a cigarette is {x} ({n} times).', ' Tu media tras un cigarro es {x} ({n} veces).'],
    'sa.detMean.caffeine': [' Your average after a coffee is {x} ({n} times).', ' Tu media tras un café es {x} ({n} veces).'],
    'sa.evsR': ['Logs on the chart: arrows to move, the selected one opens in the detail', 'Registros del gráfico: flechas para moverte, el elegido se abre en el detalle'],
    'sa.detWait': ['The response shows once an hour has passed since this log.', 'La respuesta aparece cuando pase una hora desde este registro.'],
    'sa.detFew': ['Not enough heart rate around this log.', 'No hay pulso suficiente alrededor de este registro.'],
    'sa.detAria': ['Heart rate from 90 minutes before to 90 after the {x} at {t}.', 'Pulso de 90 minutos antes a 90 después del registro de las {t} ({x}).'],
    'sa.resp.t': ['How your heart rate responds', 'Cómo responde tu pulso'], 'sa.resp.s': ['last 30 days', 'últimos 30 días'],
    'sa.r.cigarettes': ['Cigarette', 'Cigarro'], 'sa.r.caffeine': ['Coffee', 'Café'], 'sa.r.alcohol': ['Alcohol', 'Alcohol'],
    'sa.backMean': ['{m} min on average · back in {k} of {n} times', '{m} min de media · volvió en {k} de {n} veces'],
    'sa.noBackMean': ['not seen back within 90 min in {n} times', 'sin vuelta a tu base en 90 min en {n} veces'],
    'sa.alcSub': ['that night on average · {n} times · resting heart rate', 'esa noche de media · {n} veces · pulso en reposo'],
    'sa.few': ['Few logs so far ({n})', 'Aún pocos registros ({n})'],
    'sa.resp.foot': ['Average rise in the following hour against your heart rate before.', 'Subida media en la hora siguiente frente a tu pulso de antes.'],
    'sa.expPartial': ['Some logs from the last 30 days are missing; no averages until they are all in.', 'Faltan registros de los últimos 30 días; no hay medias hasta tenerlos todos.'],
    'sa.c5Partial': ['Heart rate is missing on some days; only logs with full heart rate count.', 'Faltan datos de pulso de algunos días; solo cuentan los registros con pulso completo.'],
    'sa.wk.s': ['mean HRV · last 8 weeks', 'VFC media · últimas 8 semanas'],
    'sa.wkFew': ['Not enough days yet.', 'Aún pocos días.'],
    'sa.wkLow': ['{k} of the last {m} {d} you logged {x}.', '{k} de los últimos {m} {d} registraste {x}.'],
    'sa.wkDays': ['Mondays Tuesdays Wednesdays Thursdays Fridays Saturdays Sundays', 'lunes martes miércoles jueves viernes sábados domingos'],
    'sa.wkX.alcohol_g': ['alcohol', 'alcohol'], 'sa.wkX.cigarettes': ['cigarettes', 'cigarros'], 'sa.wkX.caffeine_mg': ['coffee', 'café'],
    'sa.find.t': ['Health findings', 'Hallazgos de salud'],
    'sa.k.caffeine': ['Coffee', 'Café'], 'sa.k.cig': ['Cigarette', 'Cigarro'], 'sa.k.alcohol': ['Alcohol', 'Alcohol'], 'sa.k.water': ['Water', 'Agua'],
    'sa.k.supp': ['Supplement', 'Suplemento'], 'sa.k.mood': ['Mood', 'Ánimo'], 'sa.k.other': ['Log', 'Registro'],
    'card.saDay': ['the day’s logs', 'los registros del día'], 'card.saHr': ['heart rate', 'el pulso'], 'card.saExp': ['the logs of the last 30 days', 'los registros de los últimos 30 días']
  };

  HT.registerTab('salud', { copy, css: CSS, logic: { saSeries, saCover, saResponse, saNearest, saStep, saExposure, saWindows, saC5, saAlcohol, saTrend, saPick, saWeekLow }, render });
})();
