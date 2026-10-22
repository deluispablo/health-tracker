package com.deluispablo.healthtracker

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import java.time.LocalDate

// Dark dial set; the face paints #000 under the image, so halos use black.
private const val HALO = Color.BLACK
private val INK = Color.parseColor("#e7e9f0")
private val MUTED = Color.parseColor("#a2a8b8")
private val LINE = Color.parseColor("#2f343f")
private val LINE_STRONG = Color.parseColor("#7d8496")
private val BAND = Color.parseColor("#232a3e")
private val M_DEEP = Color.parseColor("#5470d6")
private val M_LIGHT = Color.parseColor("#d0dbff")
private val M_STEPS = Color.parseColor("#5ccf97")
private val M_HR = Color.parseColor("#ee6a5f")
private val M_CAFFEINE = Color.parseColor("#d4972a")
private val M_CIG = Color.parseColor("#c9ced6")
private val M_ALCOHOL = Color.parseColor("#b48ae8")
private val AMBIENT_SLEEP = Color.parseColor("#2a3363")

// Ring radii in the 360 design box: the log ring sits at R_LOG, the night band fills R_LOG..R_BEZEL
// and every state arc (sleep, nap, workout) is centred in that gap with one width.
private const val SCALE = 1.30f
private const val R_BEZEL = 150f
private const val R_LOG = 118f
private const val R_TRACK = (R_LOG + R_BEZEL) / 2
private const val TRACK_W = (R_BEZEL - R_LOG) * 0.45f
private const val R_PULSE = 50f
private const val MARK = 1.1f  // log marks enlarged so diamonds and mood rings read as shapes at 41 mm

/**
 * Draws the data layers of the dial (night band, states, logs, pulse) on a transparent bitmap.
 * Coordinates are the 360 design box around the centre, scaled by [SCALE] into the 450 WFF box.
 */
fun renderDial(data: DialData, nowMin: Int, ambient: Boolean, size: Int = 450): Bitmap {
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val stale = isStale(data.generatedAt, System.currentTimeMillis() / 1000)
    val saved = if (stale) c.saveLayerAlpha(null, (255 * 0.45f).toInt()) else c.save()
    c.translate(size / 2f, size / 2f)
    c.scale(SCALE * size / 450f, SCALE * size / 450f)
    drawLayers(c, data, nowMin, ambient)
    c.restoreToCount(saved)
    return bmp
}

private fun drawLayers(c: Canvas, data: DialData, nowMin: Int, ambient: Boolean) {
    val main = data.sleep.filter { !it.nap }
    if (ambient) {
        main.forEach { arc(c, it, nowMin, R_TRACK, stroke(AMBIENT_SLEEP, TRACK_W)) }
        return
    }

    // Night band: sunset to sunrise through midnight, filling the gap between the log ring and the bezel.
    val (rise, set) = sunTimes(LocalDate.parse(data.date))
    arc(c, Span(set - 1440, rise), Int.MAX_VALUE, R_TRACK, stroke(BAND, R_BEZEL - R_LOG, Paint.Cap.BUTT))

    // States track: sleep, naps (lighter core) and workouts share one width.
    main.forEach { arc(c, it, nowMin, R_TRACK, stroke(M_DEEP, TRACK_W)) }
    data.sleep.filter { it.nap }.forEach {
        arc(c, it, nowMin, R_TRACK, stroke(M_DEEP, TRACK_W))
        arc(c, it, nowMin, R_TRACK, stroke(M_LIGHT, TRACK_W * 0.7f))
    }
    data.workouts.forEach { arc(c, it, nowMin, R_TRACK, stroke(M_STEPS, TRACK_W), minDeg = 4f) }

    // Log ring with marks; clusters get a bracket inside it with feet at the true times.
    c.drawCircle(0f, 0f, R_LOG, stroke(LINE, 2.25f))
    val placed = fanOut(data.events.filter { it.t in 0..nowMin }, stepDeg = 6.5f * MARK * 102f / R_LOG)
    clusters(placed).filter { it.size > 1 }.forEach { cl ->
        val p = stroke(LINE_STRONG, 1.85f)
        c.drawArc(box(R_LOG - 13f * MARK), cl.first().second - 90f, cl.last().second - cl.first().second, false, p)
        cl.forEach { (m, _) -> radial(c, angleOf(m.t), R_LOG - 13f * MARK - 4f, R_LOG - 13f * MARK, p) }
    }
    placed.forEach { (m, a) -> mark(c, m.k, a) }

    // Pulse ticks from R_PULSE out to the bpm radius, kept inside the log ring; finished buckets only.
    val hr = stroke(M_HR, 1.86f).apply { alpha = (255 * 0.7f).toInt() }
    data.hr.forEachIndexed { i, bpm ->
        if (bpm != null && 15 * i + 15 <= nowMin) {
            radial(c, angleOf(15 * i) + 1.875f, R_PULSE, pulseOuterRadius(bpm).coerceIn(R_PULSE, R_LOG - 16f), hr)
        }
    }
}

private fun clusters(placed: List<Pair<Mark, Float>>): List<List<Pair<Mark, Float>>> {
    val out = mutableListOf<MutableList<Pair<Mark, Float>>>()
    for (p in placed) {
        val last = out.lastOrNull()
        if (last != null && p.first.t - last.last().first.t <= 20) last.add(p) else out.add(mutableListOf(p))
    }
    return out
}

private fun stroke(color: Int, width: Float, cap: Paint.Cap = Paint.Cap.ROUND) =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        this.color = color
        strokeWidth = width
        strokeCap = cap
    }

private fun fill(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

private fun box(r: Float) = RectF(-r, -r, r, r)

/** Arc on radius [r] for [span], cut at [nowMin]; dial angle 0 is up, Android's 0 is right. */
private fun arc(c: Canvas, span: Span, nowMin: Int, r: Float, p: Paint, minDeg: Float = 0f) {
    val end = minOf(span.end, nowMin)
    if (end <= span.start) return
    c.drawArc(box(r), span.start / 4f - 90f, maxOf((end - span.start) / 4f, minDeg), false, p)
}

private fun radial(c: Canvas, deg: Float, r0: Float, r1: Float, p: Paint) {
    c.save()
    c.rotate(deg)
    c.drawLine(0f, -r0, 0f, -r1, p)
    c.restore()
}

private fun mark(c: Canvas, kind: String, deg: Float) {
    c.save()
    c.rotate(deg)
    c.scale(MARK, MARK, 0f, -R_LOG)
    when (kind) {
        "cafe" -> {
            c.drawLine(0f, -(R_LOG - 7f), 0f, -(R_LOG + 7f), stroke(HALO, 7.25f))
            c.drawLine(0f, -(R_LOG - 7f), 0f, -(R_LOG + 7f), stroke(M_CAFFEINE, 3.25f))
        }
        "cigarro" -> {
            c.translate(0f, -R_LOG)
            c.rotate(45f)
            val r = RectF(-4.25f, -4.25f, 4.25f, 4.25f)
            c.drawRect(r, stroke(HALO, 4f, Paint.Cap.SQUARE))
            c.drawRect(r, fill(M_CIG))
        }
        "alcohol" -> {
            c.translate(0f, -R_LOG)
            val t = Path().apply {
                moveTo(0f, -6.8f)
                lineTo(5.8f, 4.4f)
                lineTo(-5.8f, 4.4f)
                close()
            }
            c.drawPath(t, stroke(HALO, 4f).apply { strokeJoin = Paint.Join.ROUND })
            c.drawPath(t, fill(M_ALCOHOL))
        }
        "animo" -> {
            c.drawCircle(0f, -R_LOG, 4.25f, stroke(HALO, 6f))
            c.drawCircle(0f, -R_LOG, 4.25f, stroke(INK, 2.6f))
        }
        else -> {
            c.drawCircle(0f, -R_LOG, 4.5f, fill(HALO))
            c.drawCircle(0f, -R_LOG, 2.5f, fill(MUTED))
        }
    }
    c.restore()
}
