package com.deluispablo.healthtracker

import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DialGeometryTest {
    @Test
    fun angleOfNoonIs180() = assertEquals(180f, angleOf(720), 0f)

    @Test
    fun angleOfNegativeWraps() = assertEquals(352.5f, angleOf(-30), 0f)

    @Test
    fun singleMarkKeepsItsAngle() {
        val m = Mark(600, "cafe")
        assertEquals(listOf(m to angleOf(600)), fanOut(listOf(m)))
    }

    @Test
    fun fiveCoffeesWithin20MinFanOut() {
        val marks = listOf(600, 604, 608, 612, 616).map { Mark(it, "cafe") }
        val angles = fanOut(marks).map { it.second }
        val centre = angleOf(608)
        listOf(-13f, -6.5f, 0f, 6.5f, 13f).forEachIndexed { i, off ->
            assertEquals(centre + off, angles[i], 0.001f)
        }
        assertTrue(angles.zipWithNext().all { (a, b) -> b > a })
    }

    @Test
    fun marks21MinApartAreSpreadAStepApart() {
        val marks = listOf(Mark(600, "cafe"), Mark(621, "cigarro"))
        val (a, b) = fanOut(marks).map { it.second }
        assertEquals(6.5f, b - a, 0.001f)
        assertEquals((angleOf(600) + angleOf(621)) / 2, (a + b) / 2, 0.001f)
    }

    @Test
    fun overlappingGroupsMergeUntilNoMarksOverlap() {
        val marks = listOf(480, 482, 485, 488, 490, 511).map { Mark(it, "cafe") }
        val placed = fanOut(marks.reversed())
        assertEquals(marks, placed.map { it.first })
        assertTrue(placed.zipWithNext().all { (a, b) -> b.second - a.second >= 6.5f - 0.001f })
        assertEquals(listOf(marks), fanGroups(marks).map { g -> g.map { it.first } })
    }

    @Test
    fun midnightPairStaysApart() {
        assertEquals(listOf(angleOf(0), 1439 / 4f), fanOut(listOf(Mark(1439, "cafe"), Mark(0, "cafe"))).map { it.second })
    }

    @Test
    fun spansClipToTheLastDay() {
        // Last night's sleep seen at 23:00: nothing ahead of the hour hand.
        assertEquals(-15f to 120f, clipSpan(Span(-90, 420), 1380))
        assertEquals(null, clipSpan(Span(-200, -60), 1380))
        assertEquals(null, clipSpan(Span(1400, 1500), 1380))
        // A short workout keeps its 4 degree minimum, but never past now.
        assertEquals(300f to 4f, clipSpan(Span(1200, 1205), 1380, minDeg = 4f))
        assertEquals(342.5f to 1.5f, clipSpan(Span(1370, 1375), 1376, minDeg = 4f))
        assertEquals(-15f to 4f, clipSpan(Span(-100, -55), 1380, minDeg = 4f))
    }

    @Test
    fun pulseRadius() {
        assertEquals(55.3f, pulseOuterRadius(55), 0.01f)
        assertEquals(76.09f, pulseOuterRadius(118), 0.01f)
    }

    @Test
    fun staleAfterThreeHours() {
        assertTrue(isStale(0, 10801))
        assertFalse(isStale(0, 10800))
    }

    @Test
    fun sunTimesUseConfiguredZone() {
        // Reference: full NOAA solar calculator for the default coordinates on 2026-10-22, UTC.
        val date = LocalDate.of(2026, 10, 22)
        val zone = ZoneId.of(BuildConfig.USER_TZ)
        val offset = date.atTime(12, 0).atZone(zone).offset.totalSeconds / 60
        val (rise, set) = sunTimes(date)
        assertTrue("sunrise $rise", abs(rise - (393 + offset)) <= 3)
        assertTrue("sunset $set", abs(set - (1045 + offset)) <= 3)
    }
}
