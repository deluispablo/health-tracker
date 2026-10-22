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
    fun marks21MinApartDoNotCluster() {
        val marks = listOf(Mark(600, "cafe"), Mark(621, "cigarro"))
        assertEquals(listOf(angleOf(600), angleOf(621)), fanOut(marks).map { it.second })
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
