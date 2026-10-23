/* Actividad (boards X-*, gen/act.py). Pure computations are ax* in HTLogic, checked by specs/dashboards/check_actividad.py. */
(() => {
  const L = window.HTLogic, h = HT.h;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r1 = (x) => Math.round(x * 10) / 10;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const monday = (d) => L.shiftDate(d, -L.weekday(d));
  /* Steps up to minute `min` of a 24-hour array: missing hours add nothing; the current hour counts linearly. */
  const cum = (v, min) => { const H = Math.floor(min / 60); let s = 0; for (let i = 0; i < Math.min(H, 24); i++) s += fin(v[i]) ? v[i] : 0; return s + (H < 24 && fin(v[H]) ? v[H] * (min % 60) / 60 : 0); };
  /* Past days usable for the usual line and the pace: the 14 days before `end` with at least one measured hour. */
  const usable = (days, end, wd) => (days ?? []).filter((d) => typeof d?.date === 'string' && d.date < end && d.date >= L.shiftDate(end, -14)
    && Array.isArray(d.h) && d.h.some(fin) && (wd == null || L.weekday(d.date) === wd));

  const logic = {
    /* health_intraday steps 1h: an hour with a point is measured (zero allowed), an hour without one is missing (null);
       a repeated local hour (DST) adds up. */
    axHours(points) {
      const v = Array(24).fill(null);
      for (const p of Array.isArray(points) ? points : []) {
        const m = /(\d\d):\d\d$/.exec(String(p?.[0] ?? '')), x = m ? Number(m[1]) : -1;
        if (x >= 0 && x < 24 && fin(p[1])) v[x] = (v[x] ?? 0) + p[1];
      }
      return v;
    },
    /* "Tu día habitual": per-hour median of the measured values over the 14 days before `end` (R2.6a); wd keeps that weekday only.
       Learning under 7 usable days, or 2 for one weekday (all that 14 days hold). */
    axUsual(days, end, wd = null) {
      const ok = usable(days, end, wd), need = wd == null ? 7 : 2;
      if (ok.length < need) return { learning: true, n: ok.length, need };
      return { n: ok.length, line: Array.from({ length: 24 }, (_, i) => { const v = ok.map((d) => d.h[i]).filter(fin); return v.length ? median(v) : null; }) };
    },
    /* Usual cumulative share by minute `min`: median over usable days with steps of (steps so far / day total), measured hours only. */
    axPace(days, end, min) {
      const ok = usable(days, end).filter((d) => cum(d.h, 1440) > 0);
      if (ok.length < 7) return { learning: true, n: ok.length, need: 7 };
      return { n: ok.length, share: min >= 1440 ? 1 : median(ok.map((d) => cum(d.h, min) / cum(d.h, 1440))) };
    },
    /* Today's steps minus the usual line, both up to minute `min`. */
    axAhead: (today, line, min) => Math.round(cum(today, min) - cum(line, min)),
    /* R2.14: the day's largest workout by duration_min (tie: the latest start); share = duration / day azm, capped at 100 %. */
    axShare(workouts, date, azm) {
      const w = (workouts ?? []).filter((x) => x?.local_date === date && fin(x.duration_min) && x.duration_min > 0)
        .sort((a, b) => b.duration_min - a.duration_min || String(b.start_local).localeCompare(String(a.start_local)))[0];
      return w && fin(azm) && azm > 0 ? { w, pct: Math.min(100, Math.round(w.duration_min / azm * 100)) } : null;
    },
    /* Active zone minutes of the ISO week (Monday) up to `date`; null when no day of it has data. */
    axWeekAzm(daily, date) {
      const v = []; for (let d = monday(date); d <= date; d = L.shiftDate(d, 1)) { const x = L.dayValue(daily, 'azm', d); if (x != null) v.push(x); }
      return v.length ? v.reduce((s, x) => s + x, 0) : null;
    },
    /* Tendencia by day: n days ending at `date` (the last one in progress unless `done`). k of n known completed days reach the goal;
       weekend difference (signed %, vs weekdays) only with 3 known days of each and more than 10 %. */
    axDays(daily, date, n, goal, done) {
      const vals = Array.from({ length: n }, (_, i) => { const d = L.shiftDate(date, i - n + 1), v = L.dayValue(daily, 'steps', d); return { date: d, v, ok: v != null && v >= goal, part: !done && i === n - 1 }; });
      const known = vals.filter((x) => x.v != null && !x.part), we = known.filter((x) => L.weekday(x.date) >= 5).map((x) => x.v), wd = known.filter((x) => L.weekday(x.date) < 5).map((x) => x.v);
      const diff = we.length >= 3 && wd.length >= 3 && mean(wd) > 0 ? (mean(we) - mean(wd)) / mean(wd) : 0;
      return { vals, k: known.filter((x) => x.ok).length, n: known.length, mean: known.length ? Math.round(mean(known.map((x) => x.v))) : null, weekend: Math.abs(diff) > 0.1 ? Math.round(diff * 100) : null, we: we.length, wd: wd.length };
    },
    /* Tendencia by ISO week: n weeks of azm ending with the week of `date` (partial until its Sunday is done). k of n full weeks with data reach 150. */
    axWeeks(daily, date, n, done) {
      const last = monday(date);
      const weeks = Array.from({ length: n }, (_, i) => {
        const start = L.shiftDate(last, (i - n + 1) * 7), v = [];
        for (let k = 0; k < 7; k++) { const d = L.shiftDate(start, k); if (d > date) break; const x = L.dayValue(daily, 'azm', d); if (x != null) v.push(x); }
        /* v stays unrounded (149.6 is not 150); it is rounded only for display */
        return { start, v: v.length ? v.reduce((s, x) => s + x, 0) : null, part: start === last && !(done && L.weekday(date) === 6) };
      });
      const full = weeks.filter((w) => w.v != null && !w.part);
      return { weeks: weeks.map((w) => ({ ...w, ok: w.v != null && w.v >= 150 })), k: full.filter((w) => w.v >= 150).length, n: full.length, mean: full.length ? Math.round(mean(full.map((w) => w.v))) : null };
    }
  };

  /* SVG ported from gen/act.py hourly(): today's bars, the dashed usual line, workout bands, the now line. */
  const lab = (x, y, s, anchor = 'start', size = 11, f = 'var(--font-sans)') => '<text x="' + r1(x) + '" y="' + r1(y) + '" text-anchor="' + anchor + '" font-size="' + size + '" font-weight="400" fill="var(--muted)" font-family="' + f + '" stroke="var(--surface)" stroke-width="3" paint-order="stroke">' + esc(s) + '</text>';
  function hourSvg(W, today, line, o) {
    const G = 34, H = 170, T = 16, B = 140, top = Math.max(1, ...today.filter(fin), ...(line ?? []).filter(fin));
    const s = [50, 100, 250, 500, 1000, 2500, 5000].find((x) => 2 * x * 1.2 >= top) ?? 10000, mx = Math.max(2 * s * 1.2, top);
    const bw = (W - G - 8) / 24, Y = (v) => r1(B - v / mx * (B - T)), X = (x) => r1(G + x * bw);
    const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(o.aria) + '">'];
    for (const v of [s, 2 * s]) out.push('<path d="M' + G + ' ' + Y(v) + 'H' + (W - 8) + '" stroke="var(--line)" stroke-width="1"/>', lab(G - 6, Y(v) + 4, o.fmt(v), 'end', 10, 'var(--font-mono)'));
    for (const [a, b, name] of o.bands) out.push('<rect x="' + X(a) + '" y="' + (T - 8) + '" width="' + r1(Math.max(2, X(b) - X(a))) + '" height="' + (B - T + 8) + '" rx="3" fill="var(--m-steps)" opacity=".12"/>', lab((X(a) + X(b)) / 2, T - 11, name, 'middle', 10));
    today.forEach((v, i) => { if (fin(v) && i <= o.cur) out.push('<rect x="' + r1(X(i) + 1.5) + '" y="' + Y(v) + '" width="' + r1(bw - 3) + '" height="' + r1(B - Y(v)) + '" rx="2" fill="var(--m-steps)" opacity="' + (i === o.cur && o.now != null ? .45 : 1) + '"/>'); });
    if (line) { let d = '', on = false; line.forEach((v, i) => { if (fin(v)) d += (on ? ' L' : 'M') + X(i) + ' ' + Y(v) + ' ' + X(i + 1) + ' ' + Y(v); on = fin(v); }); if (d) out.push('<path d="' + d + '" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>'); }
    if (o.now != null) out.push('<path d="M' + X(o.now) + ' ' + (T - 4) + 'V' + B + '" stroke="var(--primary)" stroke-width="2"/>');
    for (const x of [0, 6, 12, 18, 24]) out.push(lab(X(x), H - 6, String(x).padStart(2, '0'), 'middle', 11, 'var(--font-mono)'));
    return out.join('') + '</svg>';
  }
  /* gen/act.py days(): bars coloured by "llegaste / no llegaste", the usual band (board wins, R2.14), the goal line, the partial bar dashed. */
  function barsSvg(W, vals, o) {
    const n = vals.length, G = 40, H = 170, T = 12, B = 136, mx = Math.max(o.goal * 1.5, 1.05 * Math.max(0, ...vals.map((x) => x.v).filter(fin)), 1);
    const bw = (W - G - 8) / n, Y = (v) => r1(B - Math.max(0, v) / mx * (B - T)), X = (i) => r1(G + i * bw);
    const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;overflow:visible" role="img" aria-label="' + esc(o.aria) + '">'];
    if (o.band) out.push('<rect x="' + G + '" y="' + Y(o.band[1]) + '" width="' + (W - G - 8) + '" height="' + r1(Math.max(0, Y(o.band[0]) - Y(o.band[1]))) + '" fill="var(--band)"/>');
    vals.forEach((x, i) => { if (fin(x.v)) out.push('<rect x="' + r1(X(i) + bw * .1) + '" y="' + Y(x.v) + '" width="' + r1(bw * .8) + '" height="' + r1(B - Y(x.v)) + '" rx="2" fill="var(--m-steps)" opacity="' + (x.ok ? 1 : .4) + '"' + (x.part ? ' stroke="var(--m-steps)" stroke-dasharray="3 2" fill-opacity=".25"' : '') + '/>'); });
    out.push('<path d="M' + G + ' ' + Y(o.goal) + 'H' + (W - 8) + '" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 3"/>', lab(G - 6, Y(o.goal) + 4, o.fmt(o.goal), 'end', 10, 'var(--font-mono)'), lab(G - 6, Y(o.goal / 2) + 4, o.fmt(o.goal / 2), 'end', 10, 'var(--font-mono)'));
    for (const [i, s, a] of o.ticks) out.push(lab(X(i) + (a === 'end' ? bw : 0), H - 6, s, a, 10));
    return out.join('') + '</svg>';
  }
  const ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--m-steps)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M8.5 11l3-3 3 2 2.5 2M12 15l-1-4"/></svg>';
  const row = (name, bar, val, sub) => h('div', { class: 'hx-row' }, h('span', { class: 'hx-n', text: name }), bar, h('span', { class: 'hx-v', text: val }), h('span', { class: 'hx-s', text: sub }));
  const bar = (pct) => h('div', { class: 'hx-bar' }, h('i', { style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' }));
  const ACT = (f) => { const k = f?.ref?.key ?? {}; return ['steps', 'workout_min'].includes(k.metric) || ['steps', 'workout'].includes(k.behavior) || ['steps', 'workout_min'].includes(k.exposure?.metric); };
  /* A segmented control whose choice survives re-renders (HT.sel, per card); pressing one redraws only its card. */
  const seg = (ctx, key, opts, draw, label) => h('div', { class: 'hx-seg hx-seg-s', role: 'group', 'aria-label': label }, opts.map(([v, label]) =>
    h('button', { type: 'button', 'data-fk': 'tr-' + v, 'aria-pressed': String((HT.sel.get(key) ?? opts[0][0]) === v), onclick: () => { HT.sel.set(key, v); draw(); } }, label)));
  const keepFocus = (box, fill) => { const fk = box.contains?.(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null; fill(); if (fk) box.querySelector('[data-fk="' + fk + '"]')?.focus(); };

  function render(ctx) {
    const { t, lang, date } = ctx, n0 = (v) => L.fmt.num(Math.round(v), lang), hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const live = ctx.min < 1440, RW = ctx.root.clientWidth || 340, wide = typeof matchMedia === 'function' && matchMedia('(min-width: 1200px)').matches;   // the 12-column grid (G1)
    /* through: the last date each source covers; a write dated after it leaves it cached (R2.3). The profile does not follow logs. */
    const dS = ctx.source('axDaily', { tool: 'health_daily', through: (d) => d, input: (d) => ({ start: L.shiftDate(d, -89), end: d, metrics: ['steps', 'azm', 'workout_min'] }) });
    const wS = ctx.source('axWork', { tool: 'health_workouts', through: (d) => d, input: (d) => ({ start: L.shiftDate(d, -29), end: d }) });
    const pS = ctx.source('axProf', { tool: 'health_profile', through: L.shiftDate(ctx.today, -1), input: () => ({}) });
    const hour = (k) => ctx.source('axH' + k, { tool: 'health_intraday', through: (d) => L.shiftDate(d, -k), input: (d) => ({ metric: 'steps', date: L.shiftDate(d, -k), resolution: '1h' }) });
    const hS = hour(0), hist = Array.from({ length: 14 }, (_, i) => hour(i + 1));
    const goal = L.stepGoal(pS.data), daily = dS.data, workouts = Array.isArray(wS.data?.workouts) ? wS.data.workouts : [];
    const steps = L.dayValue(daily, 'steps', date), azm = L.dayValue(daily, 'azm', date), week = L.axWeekAzm(daily, date);
    const pending = hist.some((s) => !s.data && !s.error);   // no usual-line or pace claim until the 14 days have answered
    const past = hist.map((s, i) => s.data ? { date: L.shiftDate(date, -i - 1), h: L.axHours(s.data.points) } : null).filter(Boolean);
    const pace = !live || pending ? null : L.axPace(past, date, ctx.min), P = pace && !pace.learning ? Math.round(goal * pace.share) : null;
    // v_workouts carries Google exercise ids (WALKING, CARDIO_WORKOUT…) named by the shared wk.* copy; ax.wk.* overrides; unknown ids read as "Entreno"
    const wname = (w) => { const id = String(w.type ?? '').toLowerCase(), tr = (k) => { const x = t(k); return x === k ? null : x; };
      return tr('ax.wk.' + id) ?? tr('wk.' + id) ?? t('ax.wk.other'); };

    /* Resumen */
    const share = L.axShare(workouts, date, azm), dir = (k) => t(k);
    const lead = steps == null ? t(live ? 'ax.leadNone' : 'ax.leadNonePast')
      : !live ? t('ax.leadPast', { n: n0(steps), m: n0(Math.abs(steps - goal)), dir: dir(steps >= goal ? 'ax.over' : 'ax.under'), g: n0(goal) })
      : P == null ? t('ax.leadNoPace', { n: n0(steps), g: n0(goal) })
      : t('ax.lead', { n: n0(steps), m: n0(Math.abs(steps - P)), dir: dir(steps >= P ? 'ax.ahead' : 'ax.behind'), g: n0(goal) });
    const subl = [share ? t('ax.share', { w: wname(share.w), t: String(share.w.start_local ?? '').slice(11, 16), p: share.pct }) : null, week != null ? t('ax.week', { n: n0(week) }) : null].filter(Boolean).join(' ');
    const dState = () => dS.state('axDaily', 2);   // a fresh element per section: one node cannot sit in several cards
    const sum = h('section', { class: 'ax-sum hx-sum' }, h('p', { class: 'met-l', text: date === ctx.today ? t('ax.today') : L.fmt.day(date, lang) }),
      dState() ?? [h('p', { class: 'hx-lead', text: lead }), subl ? h('p', { class: 'hx-sub', text: subl }) : null,
        steps != null && pace?.learning ? HT.ins.learning(ctx, pace.n, pace.need, { what: t('ax.paceWhat') }) : null], dS.stale('axDaily'));

    /* Clave */
    const r = L.typicalRange(daily, 'azm', date), hi = Math.max(r.learning == null ? r.high : 0, azm ?? 0) * 1.25 || 1;
    const strip = h('div', { class: 'hx-strip' }, h('i', { class: 'hx-line' }), r.learning == null ? h('i', { class: 'hx-band', style: 'left:' + r1(r.low / hi * 100) + '%;width:' + r1((r.high - r.low) / hi * 100) + '%' }) : null,
      azm != null ? h('i', { class: 'hx-dot', style: 'left:' + r1(azm / hi * 100) + '%;background:var(--ink)' }) : null);
    const key = h('section', { class: 'ax-key hx-key' }, dState() ?? [
      row(t('ax.steps'), bar(steps != null ? steps / goal * 100 : 0), steps != null ? n0(steps) : '—', P != null ? t('ax.paceNow', { g: n0(goal), p: n0(P) }) : t('ax.ofGoal', { g: n0(goal) })),
      row(t('ax.azmToday'), strip, azm != null ? t('ax.min', { n: n0(azm) }) : '—', r.learning == null ? t('ax.usual', { a: n0(r.low), b: n0(r.high) }) : ''),
      r.learning != null ? HT.ins.learning(ctx, r.n, r.n + r.learning, { what: t('ax.usualWhat') }) : null,
      row(t('ax.weekRow'), bar((week ?? 0) / 150 * 100), week != null ? t('ax.min', { n: n0(week) }) : '—', t('ax.weekSub'))]);

    /* Pasos por hora */
    const cur = live ? Math.floor(ctx.min / 60) : 23, today = L.axHours(hS.data?.points).map((v, i) => i <= cur ? v : null);
    const peak = today.reduce((p, v, i) => fin(v) && (p < 0 || v >= today[p]) ? i : p, -1), span = (i) => hhmm(i * 60) + '–' + hhmm(i * 60 + 60);
    const hoursBox = h('div', {}), hKey = 'actividad:wd';
    const hours = HT.ins.card({ cls: 'ax-hours', title: t('ax.hours'), sub: peak >= 0 ? t('ax.peak', { n: n0(today[peak]), h: span(peak) }) : null, body: [hoursBox, hS.stale('axHour')] });
    const series = Array.from({ length: 56 }, (_, i) => ({ date: L.shiftDate(date, -i), v: L.dayValue(daily, 'steps', L.shiftDate(date, -i)) })).filter((p) => !(live && p.date === date));
    const stats = L.weekdayStats(series, date), names = t('ins.wk.names').split(' '), plural = t('ax.wkPl').split(' ');
    const k1000 = (v) => L.fmt.num(v / 1000, lang, 1) + 'k';
    const drawHours = () => keepFocus(hoursBox, () => {
      const sel = HT.sel.get(hKey) ?? null, usual = pending ? null : L.axUsual(past, date, sel), line = usual && !usual.learning ? usual.line : null;
      const hState = hS.state('axHour', 3);
      const bands = workouts.filter((w) => w.local_date === date).map((w) => { const a = Number(String(w.start_local).slice(11, 13)) + Number(String(w.start_local).slice(14, 16)) / 60, e = String(w.end_local ?? '');
        const b = e.slice(0, 10) === date ? Number(e.slice(11, 13)) + Number(e.slice(14, 16)) / 60 : 24; return [a, Math.max(a, b), wname(w)]; }).filter((x) => fin(x[0]) && fin(x[1]));
      const shape = line && today.some(fin) ? L.axAhead(today, line, live ? ctx.min : 1440) : null;
      const wdText = stats.learning ? null : sel != null ? (stats.means[sel] == null ? t('ins.wk.selFew', { d: names[sel], n: stats.counts[sel] }) : t('ins.wk.sel', { d: names[sel], v: n0(stats.means[sel]), n: stats.counts[sel] }))
        : t(stats.hiClear && stats.loClear ? 'ax.wkExt' : stats.hiClear ? 'ax.wkHi' : stats.loClear ? 'ax.wkLo' : 'ins.wk.flat', { a: plural[stats.hi], va: n0(stats.means[stats.hi]), b: plural[stats.lo], vb: n0(stats.means[stats.lo]) });
      const shapeText = shape == null ? null : t((shape >= 0 ? 'ax.more' : 'ax.fewer') + (live ? '' : 'Past'), { n: n0(Math.abs(shape)) });
      const W = wide ? Math.round((RW + 16) * 8 / 12 - 56) : RW - 40;
      hoursBox.replaceChildren(...[HT.ins.chips(ctx, sel, (i) => { HT.sel.set(hKey, i); drawHours(); }),
        hState ?? (today.some(fin) ? h('div', { html: hourSvg(W, today, line, { cur, now: live ? ctx.min / 60 : null, bands, fmt: n0, aria: t('ax.hourAria', { n: n0(today[peak]), h: span(peak) }) }) })
          : h('p', { class: 'hx-sub', text: t(live ? 'ax.hourNone' : 'ax.hourNonePast') })),
        h('div', { class: 'hx-legend', 'aria-hidden': 'true' }, h('span', {}, h('i', { style: 'width:12px;height:10px;background:var(--m-steps)' }), t('ax.legToday')),
          line ? h('span', {}, h('i', { style: 'width:16px;height:0;border-top:2px dashed var(--ink);border-radius:0' }), t('ax.legUsual')) : null),
        usual?.learning ? HT.ins.learning(ctx, usual.n, usual.need, { what: t('ax.usualDay') }) : null,
        h('p', { class: 'met-l ax-wkl', text: t('ax.wkl') }),
        dState() ?? (stats.learning ? HT.ins.learning(ctx, stats.n, stats.need) : h('div', { html: L.wkbarsSvg(W, stats.means, k1000, { goal, H: 110, sel, days: t('ins.wk.letters').split(' '), aria: wdText }) })),
        shapeText || wdText ? h('p', { class: 'hx-sub hx-sep sx-foot', text: [shapeText, wdText].filter(Boolean).join(' ') }) : null].filter(Boolean));
    });
    drawHours();

    /* Entrenos */
    const list = workouts.slice().sort((a, b) => String(b.start_local ?? '').localeCompare(String(a.start_local ?? '')));
    const wState = wS.state('axWork', 3);
    const works = HT.ins.card({ cls: 'ax-works', title: t('ax.works'), sub: wState ? null : t('ax.worksSub', { n: list.length }), foot: t('ax.worksFoot'), footCls: 'hx-note sx-foot',
      body: [wState ?? (list.length ? list.slice(0, 3).map((w) => {
        const d = String(w.local_date ?? ''), at = String(w.start_local ?? '').slice(11, 16);
        const line = [fin(w.avg_hr) ? t('ax.bpm', { n: n0(w.avg_hr) }) : null, fin(w.azm) ? t('ax.zone', { n: n0(w.azm) }) : null].filter(Boolean).join(' · ');
        return h('div', { class: 'ax-w' }, h('span', { class: 'hx-gl', html: ICON }), h('div', {}, h('b', { text: wname(w) }), ' ', h('span', { class: 'hx-sub', text: d === ctx.today ? t('ax.wkToday', { t: at }) : L.fmt.wday(d, lang) + ' · ' + at }), line ? h('p', { class: 'hx-sub', text: line }) : null),
          h('span', { class: 'hx-v', text: fin(w.duration_min) ? L.fmt.dur(w.duration_min, lang) : '—' }));
      }) : h('p', { class: 'hx-sub', text: t('ax.worksNone') })), wS.stale('axWork')].flat() });

    /* Tendencia */
    const trBox = h('div', {}), mKey = 'actividad:tm', pKey = 'actividad:tp', sub = h('span', { class: 'ht-card-s' });
    const trend = HT.ins.card({ cls: 'ax-trend', title: t('ax.trend'), body: trBox });
    trend.firstChild.append(sub);
    const drawTrend = () => keepFocus(trBox, () => {
      const weeks = (HT.sel.get(mKey) ?? 'days') === 'weeks', p90 = (HT.sel.get(pKey) ?? '30') === '90', W = RW - 40;
      const ctl = h('div', { class: 'hx-ctl' }, seg(ctx, mKey, [['days', t('ax.segDays')], ['weeks', t('ax.segWeeks')]], drawTrend, t('ax.segMetric')), seg(ctx, pKey, [['30', t('ax.p30')], ['90', t('ax.p90')]], drawTrend, t('ax.segPeriod')));
      const st = dState();
      if (st) { sub.textContent = ''; return trBox.replaceChildren(ctl, st); }
      const g = weeks ? 150 : goal, fmt = n0;
      const tr = weeks ? L.axWeeks(daily, date, p90 ? 12 : 5, !live) : L.axDays(daily, date, p90 ? 90 : 30, goal, !live);
      const vals = weeks ? tr.weeks : tr.vals, n = vals.length, rr = weeks ? null : L.typicalRange(daily, 'steps', date), band = rr && rr.learning == null ? [rr.low, rr.high] : null;
      const lastTick = weeks ? L.fmt.day(vals[n - 1].start, lang) : live ? t('ax.today0') : L.fmt.day(date, lang);
      const ticks = [[0, L.fmt.day(weeks ? vals[0].start : vals[0].date, lang), 'start'], [n >> 1, L.fmt.day(weeks ? vals[n >> 1].start : vals[n >> 1].date, lang), 'middle'], [n - 1, lastTick, 'end']];
      sub.textContent = band ? t('ax.trendSub') : '';
      const text = !tr.n ? t('ax.trNone') : weeks ? t('ax.trWeeks', { k: tr.k, n: tr.n, m: n0(tr.mean) }) + (vals[n - 1].part ? t('ax.trWeeksPart') : '') + '.'
        : t('ax.trDays', { k: tr.k, n: tr.n, m: n0(tr.mean) }) + (tr.weekend != null ? t('ax.trWeekend', { p: Math.abs(tr.weekend), dir: t(tr.weekend > 0 ? 'ax.moreW' : 'ax.lessW'), a: tr.we, b: tr.wd }) : '') + '.';
      const aria = weeks ? t('ax.trAriaW', { n, k: tr.k, c: tr.n }) : t('ax.trAriaD', { n, k: tr.k, c: tr.n, g: n0(goal) });
      trBox.replaceChildren(ctl, h('div', { html: barsSvg(W, vals, { goal: g, band, fmt, ticks, aria }) }),
        h('div', { class: 'hx-legend', 'aria-hidden': 'true' }, h('span', {}, h('i', { style: 'width:12px;height:10px;background:var(--m-steps)' }), t('ax.legMet')),
          h('span', {}, h('i', { style: 'width:12px;height:10px;background:var(--m-steps);opacity:.4' }), t('ax.legMiss')),
          h('span', {}, h('i', { style: 'width:16px;height:0;border-top:2px dashed var(--ink);border-radius:0' }), t('ax.legGoal', { g: n0(g) }))),
        h('p', { class: 'hx-sub hx-sep', text }));
    });
    drawTrend();

    HT.ins.layout(ctx.root, [[sum, 1, 1, 8], [key, 1, 8, 13], [hours, 2, 1, 9], [works, 2, 9, 13], [trend, 3, 1, 13],
      // R2.14: "Min. de entreno" only here; the shared ins.m.workout_min label stays for the other tabs
      [HT.ins.changes({ ...ctx, t: (k, v) => t(k === 'ins.m.workout_min' ? 'ax.m.workout_min' : k, v) }, { metrics: ['steps', 'workout_min'], rows: daily }), 4, 1, 6],
      [HT.ins.findings(ctx, { filter: ACT, title: t('ax.find') }), 4, 6, 13]]);
  }

  HT.registerTab('actividad', {
    logic, render,
    css: `
.ax-key .hx-row:first-child { border-top: 0; padding-top: 0; } .ax-key .hx-row:last-child { padding-bottom: 0; }
.ax-trend .hx-ctl { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 8px; }
.ax-trend .hx-seg-s { margin: 0; } .ax-trend .hx-seg-s button { min-width: 0; padding: 0 10px; }
.ax-w { display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; align-items: start; padding: 10px 0; border-top: 1px solid var(--line); }
.ax-w:first-of-type { border-top: 0; padding-top: 0; } .ax-w b { font-weight: var(--w-strong); } .ax-w .hx-v { font-size: 15px; }
.ax-trend .hx-legend { margin-top: 8px; } .ax-wkl { margin: 14px 0 2px; } .ax-hours .ht-state { margin-top: 8px; }
@media (min-width: 1200px) { .ax-key { display: flex; flex-direction: column; justify-content: center; } .ax-trend .hx-seg-s button { min-height: 36px; } }`,
    copy: {
      'card.axDaily': ['activity', 'actividad'], 'card.axHour': ['hourly steps', 'pasos por hora'], 'card.axWork': ['workouts', 'entrenos'],
      'ax.today': ['Today', 'Hoy'],
      'ax.wk.biking': ['Bike', 'Bici'], 'ax.wk.other': ['Workout', 'Entreno'],   // the board's short name; the rest come from the shared wk.*
      'ax.lead': ['You have {n} steps, {m} {dir} the pace to reach {g}.', 'Llevas {n} pasos, {m} {dir} del ritmo para llegar a {g}.'],
      'ax.ahead': ['ahead of', 'por delante'], 'ax.behind': ['behind', 'por detrás'],
      'ax.leadNoPace': ['You have {n} steps of {g}.', 'Llevas {n} pasos de {g}.'],
      'ax.leadPast': ['You walked {n} steps, {m} {dir} your goal of {g}.', 'Hiciste {n} pasos, {m} {dir} del objetivo de {g}.'],
      'ax.over': ['above', 'por encima'], 'ax.under': ['below', 'por debajo'],
      'ax.leadNone': ['No steps recorded yet today.', 'Aún no hay pasos registrados hoy.'], 'ax.leadNonePast': ['No steps recorded that day.', 'Sin pasos registrados ese día.'],
      'ax.share': ['{w} at {t}: {p}% of your active minutes that day.', '{w} de las {t}: el {p} % de tus minutos activos del día.'],
      'ax.week': ['This week you have {n} of 150 active minutes.', 'Esta semana llevas {n} de 150 min activos.'],
      'ax.steps': ['Steps', 'Pasos'], 'ax.ofGoal': ['of {g}', 'de {g}'], 'ax.paceNow': ['of {g} · pace by now {p}', 'de {g} · ritmo a esta hora {p}'],
      'ax.azmToday': ['Active min. today', 'Min. activos hoy'], 'ax.usual': ['usual {a}–{b} min', 'habitual {a}–{b} min'], 'ax.usualWhat': ['your usual', 'tu habitual'],
      'ax.weekRow': ['Week', 'Semana'], 'ax.weekSub': ['of 150 min in the active zone · WHO 150–300', 'de 150 min en zona activa · OMS 150–300'], 'ax.min': ['{n} min', '{n} min'],
      'ax.hours': ['Steps by hour', 'Pasos por hora'], 'ax.peak': ['peak {n} · {h}', 'pico {n} · {h}'],
      'ax.hourAria': ['Steps by hour against your usual day; peak {n} at {h}.', 'Pasos por hora frente a tu día habitual; pico {n} de {h}.'],
      'ax.hourNone': ['No hourly steps yet today.', 'Aún no hay pasos por hora hoy.'], 'ax.hourNonePast': ['No hourly steps that day.', 'Sin pasos por hora ese día.'],
      'ax.legToday': ['Today', 'Hoy'], 'ax.legUsual': ['Your usual day', 'Tu día habitual'], 'ax.usualDay': ['your usual day', 'tu día habitual'],
      'ax.wkl': ['Average by day of the week', 'Media por día de la semana'],
      'ax.more': ['So far you have {n} more steps than your usual day by this hour.', 'Hasta ahora llevas {n} pasos más que tu día habitual a esta hora.'],
      'ax.fewer': ['So far you have {n} fewer steps than your usual day by this hour.', 'Hasta ahora llevas {n} pasos menos que tu día habitual a esta hora.'],
      'ax.morePast': ['That day you walked {n} more steps than your usual day.', 'Ese día hiciste {n} pasos más que tu día habitual.'],
      'ax.fewerPast': ['That day you walked {n} fewer steps than your usual day.', 'Ese día hiciste {n} pasos menos que tu día habitual.'],
      'ax.wkExt': ['{a} are your best day and {b} the weakest ({vb}).', 'Los {a} son tu mejor día y los {b} el más flojo ({vb}).'],
      'ax.wkHi': ['{a} are your best day ({va}).', 'Los {a} son tu mejor día ({va}).'], 'ax.wkLo': ['{b} are your weakest day ({vb}).', 'Los {b} son tu día más flojo ({vb}).'],
      'ax.wkPl': ['Mondays Tuesdays Wednesdays Thursdays Fridays Saturdays Sundays', 'lunes martes miércoles jueves viernes sábados domingos'],
      'ax.works': ['Workouts', 'Entrenos'], 'ax.worksSub': ['last 30 days · {n}', 'últimos 30 días · {n}'],
      'ax.worksFoot': ['The watch records them; they appear after it syncs.', 'Los registra el reloj; aparecen al sincronizar.'], 'ax.worksNone': ['No workouts in the last 30 days.', 'Sin entrenos en los últimos 30 días.'],
      'ax.wkToday': ['today · {t}', 'hoy · {t}'], 'ax.bpm': ['{n} bpm', '{n} lpm'], 'ax.zone': ['{n} min in zone', '{n} min en zona'],
      'ax.trend': ['Trend', 'Tendencia'], 'ax.trendSub': ['shaded: your usual range', 'sombreado: tu rango habitual'],
      'ax.segDays': ['Steps per day', 'Pasos por día'], 'ax.segWeeks': ['Active min. per week', 'Min. activos por semana'], 'ax.p30': ['30 d', '30 d'], 'ax.p90': ['90 d', '90 d'],
      'ax.legMet': ['Reached the goal', 'Llegaste al objetivo'], 'ax.legMiss': ["Didn't reach it", 'No llegaste'], 'ax.legGoal': ['Goal {g}', 'Objetivo {g}'], 'ax.today0': ['today', 'hoy'],
      'ax.trDays': ['{k} of {n} days you reached the goal · average {m} a day', '{k} de {n} días llegaste al objetivo · media {m} al día'],
      'ax.trWeekend': [' · at weekends you walk {p}% {dir} ({a} weekend days vs {b} weekdays; they go together, not proof of cause)', ' · los fines de semana caminas un {p} % {dir} ({a} días de fin de semana frente a {b} entre semana; van juntos, no prueba causa)'], 'ax.moreW': ['more', 'más'], 'ax.lessW': ['less', 'menos'],
      'ax.trWeeks': ['{k} of {n} weeks you reached 150 min · average {m} min a week', '{k} de {n} semanas llegaste a 150 min · media {m} min por semana'],
      'ax.trWeeksPart': [' · this week is still in progress', ' · esta semana aún está en curso'], 'ax.trNone': ['No data in this period yet.', 'Aún no hay datos en este periodo.'],
      'ax.trAriaD': ['Steps over the last {n} days; {k} of {c} days reached the goal of {g}.', 'Pasos de los últimos {n} días; {k} de {c} días llegaste al objetivo de {g}.'],
      'ax.trAriaW': ['Active zone minutes per week, {n} weeks; {k} of {c} full weeks reached 150.', 'Minutos en zona activa por semana, {n} semanas; {k} de {c} semanas completas llegaron a 150.'],
      'ax.find': ['What changes your activity', 'Lo que cambia tu actividad'],
      'ax.m.workout_min': ['Workout min.', 'Min. de entreno'], 'ax.paceWhat': ['the pace', 'el ritmo'],
      'ax.segMetric': ['Measure', 'Medida'], 'ax.segPeriod': ['Period', 'Periodo']
    }
  });
})();
