package com.deluispablo.healthtracker

import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import java.time.ZoneId
import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tan

/** Dial angle in degrees for local minutes since midnight: 00:00 at the top, clockwise. */
fun angleOf(minute: Int): Float = ((minute / 4f) % 360f + 360f) % 360f

/**
 * Pairs each mark with its drawn angle. Marks at most [gapMin] minutes after the previous one
 * join its cluster; a cluster is spread [stepDeg] apart around its mean angle.
 */
fun fanOut(marks: List<Mark>, gapMin: Int = 20, stepDeg: Float = 6.5f): List<Pair<Mark, Float>> {
    val clusters = mutableListOf<MutableList<Mark>>()
    for (m in marks.sortedBy { it.t }) {
        val last = clusters.lastOrNull()
        if (last != null && m.t - last.last().t <= gapMin) last.add(m) else clusters.add(mutableListOf(m))
    }
    return clusters.flatMap { c ->
        val centre = c.map { it.t / 4f }.average().toFloat()
        c.mapIndexed { i, m -> m to centre + (i - (c.size - 1) / 2f) * stepDeg }
    }
}

/** Outer radius of a pulse tick in the 360 design box. */
fun pulseOuterRadius(bpm: Int): Float = 52f + (bpm - 45) * 0.33f

fun isStale(generatedAt: Long, nowSec: Long): Boolean = nowSec - generatedAt > 3 * 3600

/** Local sunrise and sunset in minutes since midnight (NOAA approximation). */
fun sunTimes(
    date: LocalDate,
    lat: Double = 40.4168,
    lon: Double = -3.7038,
    zone: ZoneId = ZoneId.of("Europe/Madrid"),
): Pair<Int, Int> {
    val g = 2 * Math.PI / 365 * (date.dayOfYear - 1)
    val eqTime = 229.18 * (0.000075 + 0.001868 * cos(g) - 0.032077 * sin(g) -
        0.014615 * cos(2 * g) - 0.040849 * sin(2 * g))
    val decl = 0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2 * g) +
        0.000907 * sin(2 * g) - 0.002697 * cos(3 * g) + 0.00148 * sin(3 * g)
    val latR = Math.toRadians(lat)
    val ha = Math.toDegrees(
        acos((cos(Math.toRadians(90.833)) / (cos(latR) * cos(decl)) - tan(latR) * tan(decl)).coerceIn(-1.0, 1.0)),
    )
    val offset = zone.rules.getOffset(date.atTime(12, 0).atZone(zone).toInstant()).totalSeconds / 60
    val rise = 720 - 4 * (lon + ha) - eqTime + offset
    val set = 720 - 4 * (lon - ha) - eqTime + offset
    return rise.roundToInt() to set.roundToInt()
}

val MADRID: ZoneId = ZoneId.of("Europe/Madrid")

fun belongsToToday(date: String, now: ZonedDateTime = ZonedDateTime.now(MADRID)): Boolean =
    LocalDate.parse(date) == now.withZoneSameInstant(MADRID).toLocalDate()

fun dataForToday(data: DialData, now: ZonedDateTime = ZonedDateTime.now(MADRID)): DialData =
    if (belongsToToday(data.date, now)) data else data.copy(
        date = now.withZoneSameInstant(MADRID).toLocalDate().toString(),
        sleep = emptyList(), workouts = emptyList(), events = emptyList(), hr = List(96) { null },
        // Yesterday's totals do not carry over; the catalog and the goal do.
        water = data.water?.copy(ml = 0), trackers = data.trackers?.map { it.copy(today = 0.0) },
    )

/** Calendar minutes keep dial angles tied to local time across DST changes. */
fun minutesSince(date: String, now: ZonedDateTime = ZonedDateTime.now(MADRID)): Int {
    val local = now.withZoneSameInstant(MADRID)
    return ChronoUnit.DAYS.between(LocalDate.parse(date), local.toLocalDate()).toInt() * 1440 +
        local.hour * 60 + local.minute
}
