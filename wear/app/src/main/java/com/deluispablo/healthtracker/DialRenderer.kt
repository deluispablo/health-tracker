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
private val BAND = Color.parseColor("#1a2240")
private val M_DEEP = Color.parseColor("#5470d6")
private val M_LIGHT = Color.parseColor("#d0dbff")
private val M_STEPS = Color.parseColor("#5ccf97")
private val M_HR = Color.parseColor("#ee6a5f")
private val M_CAFFEINE = Color.parseColor("#f2c46b")  // the menu button colours
private val BEAN_SEAM = Color.parseColor("#2a1a00")
private val CIGARETTE = Color.WHITE
private val M_ALCOHOL = Color.parseColor("#b48ae8")
private val M_WATER = Color.parseColor("#38b6ff")
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
    c.drawArc(box(R_TRACK), (set - 1440) / 4f - 90f, (rise - set + 1440) / 4f, false, stroke(BAND, R_BEZEL - R_LOG, Paint.Cap.BUTT))

    // States track: sleep, naps (lighter core) and workouts share one width.
    main.forEach { arc(c, it, nowMin, R_TRACK, stroke(M_DEEP, TRACK_W)) }
    data.sleep.filter { it.nap }.forEach {
        arc(c, it, nowMin, R_TRACK, stroke(M_DEEP, TRACK_W))
        arc(c, it, nowMin, R_TRACK, stroke(M_LIGHT, TRACK_W * 0.7f))
    }
    data.workouts.forEach { arc(c, it, nowMin, R_TRACK, stroke(M_STEPS, TRACK_W), minDeg = 4f) }

    // Log ring with marks; clusters get a bracket inside it with feet at the true times.
    c.drawCircle(0f, 0f, R_LOG, stroke(LINE, 2.25f))
    val groups = fanGroups(data.events.filter { it.t in 0..nowMin && it.k != "other" }, stepDeg = 6.5f * MARK * 102f / R_LOG)
    val placed = groups.flatten()
    groups.filter { it.size > 1 }.forEach { cl ->
        val p = stroke(LINE_STRONG, 1.85f)
        c.drawArc(box(R_LOG - 13f * MARK), cl.first().second - 90f, cl.last().second - cl.first().second, false, p)
        cl.forEach { (m, _) -> radial(c, angleOf(m.t), R_LOG - 13f * MARK - 4f, R_LOG - 13f * MARK, p) }
    }
    placed.forEach { (m, a) -> mark(c, m.k, a, m.m) }

    // Pulse ticks from R_PULSE out to the bpm radius, kept inside the log ring; finished buckets only.
    val hr = stroke(M_HR, 1.86f).apply { alpha = (255 * 0.7f).toInt() }
    data.hr.forEachIndexed { i, bpm ->
        if (bpm != null && 15 * i + 15 <= nowMin) {
            radial(c, angleOf(15 * i) + 1.875f, R_PULSE, pulseOuterRadius(bpm).coerceIn(R_PULSE, R_LOG - 16f), hr)
        }
    }
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

/** Arc on radius [r] for [span] within the last 24 h up to [nowMin]; dial angle 0 is up, Android's 0 is right. */
private fun arc(c: Canvas, span: Span, nowMin: Int, r: Float, p: Paint, minDeg: Float = 0f) {
    val (start, sweep) = clipSpan(span, nowMin, minDeg) ?: return
    c.drawArc(box(r), start - 90f, sweep, false, p)
}

private fun radial(c: Canvas, deg: Float, r0: Float, r1: Float, p: Paint) {
    c.save()
    c.rotate(deg)
    c.drawLine(0f, -r0, 0f, -r1, p)
    c.restore()
}

private val MOOD_COLORS = mapOf(
    "estresado" to "#f08a5d", "genial" to "#f2d06b", "bien" to "#c9dc6a", "tranquilo" to "#6cc9a0",
    "cansado" to "#7fa7e0", "triste" to "#6f8fe8", "ansioso" to "#e86f7a", "enfadado" to "#ee5f5f",
).mapValues { Color.parseColor(it.value) }

// Wine glass: bowl, stem and foot, centred on the ring.
private val GLASS = Path().apply {
    moveTo(-4.6f, -6.4f)
    lineTo(4.6f, -6.4f)
    lineTo(4.6f, -3.2f)
    arcTo(RectF(-4.6f, -7.8f, 4.6f, 1.4f), 0f, 180f)
    close()
}

/** [which] names the mood or the supplement, for their colour. */
private fun mark(c: Canvas, kind: String, deg: Float, which: String?) {
    c.save()
    c.rotate(deg)
    c.scale(MARK, MARK, 0f, -R_LOG)
    c.translate(0f, -R_LOG)
    when (kind) {
        "cigarro" -> {
            c.drawLine(0f, -7f, 0f, 7f, stroke(HALO, 6.6f))
            c.drawLine(0f, -7f, 0f, 7f, stroke(CIGARETTE, 3f))
        }
        "cafe" -> {
            val bean = RectF(-4.2f, -5.6f, 4.2f, 5.6f)
            c.drawOval(bean, stroke(HALO, 2.2f))
            c.drawOval(bean, fill(M_CAFFEINE))
            val seam = Path().apply {
                moveTo(0f, -4.6f)
                quadTo(-2f, -2.3f, 0f, 0f)
                quadTo(2f, 2.3f, 0f, 4.6f)
            }
            c.drawPath(seam, stroke(BEAN_SEAM, 1.2f))
        }
        "alcohol" -> {
            val foot = Path().apply {
                moveTo(0f, 1.4f)
                lineTo(0f, 5.6f)
                moveTo(-2.8f, 5.6f)
                lineTo(2.8f, 5.6f)
            }
            c.drawPath(GLASS, stroke(HALO, 2.2f).apply { strokeJoin = Paint.Join.ROUND })
            c.drawPath(foot, stroke(HALO, 3.8f))
            c.drawPath(GLASS, fill(M_ALCOHOL))
            c.drawPath(foot, stroke(M_ALCOHOL, 1.6f))
        }
        "agua" -> {
            // Shared mark: a drop with its tip outward (docs/assets/brand/trackers/marks/agua.svg).
            val drop = Path().apply {
                moveTo(0f, -6.2f)
                cubicTo(-1.6f, -3.6f, -4.2f, -1.2f, -4.2f, 1.6f)
                arcTo(RectF(-4.2f, -2.6f, 4.2f, 5.8f), 180f, -180f)
                cubicTo(4.2f, -1.2f, 1.6f, -3.6f, 0f, -6.2f)
                close()
            }
            c.drawPath(drop, stroke(HALO, 2.2f).apply { strokeJoin = Paint.Join.ROUND })
            c.drawPath(drop, fill(M_WATER))
        }
        "suplemento" -> {
            // One capsule for every supplement, in its colour token (all share one rose today; marks/suplemento.svg).
            val style = styleOf(which ?: "")
            val capsule = RectF(-2.7f, -5.8f, 2.7f, 5.8f)
            c.drawRoundRect(capsule, 2.7f, 2.7f, stroke(HALO, 2.2f))
            c.drawRoundRect(capsule, 2.7f, 2.7f, fill(style.fill))
            c.drawLine(-2.7f, 0f, 2.7f, 0f, stroke(style.ink, 1f))
        }
        "animo" -> {
            c.drawCircle(0f, 0f, 4.6f, stroke(HALO, 2.2f))
            c.drawCircle(0f, 0f, 4.6f, fill(MOOD_COLORS[which] ?: INK))
        }
        else -> {
            c.drawCircle(0f, 0f, 4.5f, fill(HALO))
            c.drawCircle(0f, 0f, 2.5f, fill(MUTED))
        }
    }
    c.restore()
}
