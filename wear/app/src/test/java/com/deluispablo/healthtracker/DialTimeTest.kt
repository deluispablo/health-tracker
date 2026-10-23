package com.deluispablo.healthtracker

import java.time.ZonedDateTime
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal fun inZone(id: String, body: () -> Unit) {
    val saved = TimeZone.getDefault()
    try { TimeZone.setDefault(TimeZone.getTimeZone(id)); body() } finally { TimeZone.setDefault(saved) }
}

class DialTimeTest {
    @Test
    fun userZoneFollowsSystemZone() {
        inZone("Australia/Sydney") { assertEquals(ZoneId.of("Australia/Sydney"), USER_ZONE) }
        inZone("Europe/Madrid") { assertEquals(ZoneId.of("Europe/Madrid"), USER_ZONE) }
    }

    @Test
    fun todayRequestReportsSystemZone() {
        inZone("Australia/Sydney") {
            assertEquals("Australia/Sydney", todayHeaders()["X-Time-Zone"])
            assertTrue(todayHeaders()["Authorization"]!!.startsWith("Bearer "))
        }
    }

    @Test
    fun todayUsesSystemZone() {
        val zone = USER_ZONE
        val data = parseDialData(sampleJson())
        for (hour in 0..23) {
            val now = ZonedDateTime.parse("2026-10-23T00:00:00Z").plusHours(hour.toLong())
            val local = now.withZoneSameInstant(zone)
            val date = local.toLocalDate().toString()
            assertTrue(belongsToToday(date, now))
            assertFalse(belongsToToday(local.toLocalDate().minusDays(1).toString(), now))
            assertEquals(date, dataForToday(data, now).date)
            assertEquals(local.hour * 60 + local.minute, minutesSince(date, now))
        }
    }

    @Test
    fun springForwardUsesLocalMinutes() = inZone("Europe/Madrid") {
        val now = LocalDateTime.parse("2026-03-29T13:00:00").atZone(USER_ZONE)
        assertEquals(780, minutesSince("2026-03-29", now))
        assertEquals(1440 + 780, minutesSince("2026-03-28", now))
    }

    @Test
    fun fallBackUsesLocalMinutes() = inZone("Europe/Madrid") {
        val now = LocalDateTime.parse("2026-10-25T13:00:00").atZone(USER_ZONE)
        assertEquals(780, minutesSince("2026-10-25", now))
        assertEquals(1440 + 780, minutesSince("2026-10-24", now))
    }

    @Test
    fun cachedDayExpiresAtConfiguredMidnight() {
        val midnight = LocalDateTime.parse("2026-10-23T00:00:00").atZone(USER_ZONE)
            .withZoneSameInstant(ZoneId.of("UTC"))
        assertTrue(belongsToToday("2026-10-22", midnight.minusMinutes(1)))
        assertFalse(belongsToToday("2026-10-22", midnight))
        assertTrue(belongsToToday("2026-10-23", midnight))
        assertFalse(belongsToToday("2026-10-24", midnight))
    }

    @Test
    fun oldDataBecomesEmptyTodayAndKeepsItsAge() {
        val data = parseDialData(sampleJson())
        val now = LocalDateTime.parse("2026-10-23T00:00:00").atZone(USER_ZONE)
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
        val now = LocalDateTime.parse("2026-10-22T23:59:00").atZone(USER_ZONE)
        assertEquals(data, dataForToday(data, now))
        assertTrue(isStale(dataForToday(data, now).generatedAt, now.toEpochSecond()))
    }
}
