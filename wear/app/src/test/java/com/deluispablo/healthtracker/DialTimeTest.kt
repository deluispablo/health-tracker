package com.deluispablo.healthtracker

import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DialTimeTest {
    @Test
    fun springForwardUsesLocalMinutes() {
        val now = ZonedDateTime.parse("2026-03-29T13:00:00+02:00[Europe/Madrid]")
        assertEquals(780, minutesSince("2026-03-29", now))
        assertEquals(1440 + 780, minutesSince("2026-03-28", now))
    }

    @Test
    fun fallBackUsesLocalMinutes() {
        val now = ZonedDateTime.parse("2026-10-25T13:00:00+01:00[Europe/Madrid]")
        assertEquals(780, minutesSince("2026-10-25", now))
        assertEquals(1440 + 780, minutesSince("2026-10-24", now))
    }

    @Test
    fun cachedDayExpiresAtMadridMidnight() {
        assertTrue(belongsToToday("2026-10-22", ZonedDateTime.parse("2026-10-22T21:59:00Z")))
        val midnight = ZonedDateTime.parse("2026-10-22T22:00:00Z")
        assertFalse(belongsToToday("2026-10-22", midnight))
        assertTrue(belongsToToday("2026-10-23", midnight))
        assertFalse(belongsToToday("2026-10-24", midnight))
    }

    @Test
    fun oldDataBecomesEmptyTodayAndKeepsItsAge() {
        val data = parseDialData(sampleJson())
        val now = ZonedDateTime.parse("2026-10-23T00:00:00+02:00[Europe/Madrid]")
        val empty = dataForToday(data, now)
        assertEquals("2026-10-23", empty.date)
        assertTrue(empty.sleep.isEmpty())
        assertTrue(empty.workouts.isEmpty())
        assertTrue(empty.events.isEmpty())
        assertEquals(List<Int?>(96) { null }, empty.hr)
        assertEquals(data.generatedAt, empty.generatedAt)
        assertTrue(isStale(empty.generatedAt, now.toEpochSecond()))
        assertEquals(0, minutesSince(empty.date, now))
    }

    @Test
    fun todaysDataStaysIntactWhileItAges() {
        val data = parseDialData(sampleJson())
        val now = ZonedDateTime.parse("2026-10-22T23:59:00+02:00[Europe/Madrid]")
        assertEquals(data, dataForToday(data, now))
        assertTrue(isStale(dataForToday(data, now).generatedAt, now.toEpochSecond()))
    }
}
