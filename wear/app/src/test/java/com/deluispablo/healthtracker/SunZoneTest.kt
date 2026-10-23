package com.deluispablo.healthtracker

import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SunZoneTest {
    // Sunrise and sunset in minutes since local midnight, from the NOAA solar calculator for the shown date.
    private val dec = LocalDate.of(2026, 12, 21)
    private val jun = LocalDate.of(2026, 6, 21)
    private val table = listOf(
        Triple("Europe/Madrid", dec, 514 to 1071),
        Triple("Europe/Madrid", jun, 405 to 1308),
        Triple("Australia/Sydney", dec, 341 to 1205),
        Triple("Australia/Sydney", jun, 420 to 1014),
        Triple("Australia/Melbourne", dec, 354 to 1242),
        Triple("Australia/Melbourne", jun, 456 to 1028),
        Triple("Australia/Brisbane", dec, 289 to 1122),
        Triple("Australia/Brisbane", jun, 398 to 1022),
        Triple("Australia/Perth", dec, 307 to 1162),
        Triple("Australia/Perth", jun, 437 to 1040),
        Triple("Australia/Adelaide", dec, 358 to 1229),
        Triple("Australia/Adelaide", jun, 443 to 1031),
        Triple("Australia/Hobart", dec, 328 to 1249),
        Triple("Australia/Hobart", jun, 462 to 1003),
        Triple("Australia/Darwin", dec, 379 to 1150),
        Triple("Australia/Darwin", jun, 427 to 1110),
    )

    @Test
    fun everyTableZoneMatchesNoaaInSummerAndWinter() {
        for ((id, date, expected) in table) {
            val (rise, set) = sunTimes(date, ZoneId.of(id))!!
            assertTrue("$id $date sunrise $rise", abs(rise - expected.first) <= 3)
            assertTrue("$id $date sunset $set", abs(set - expected.second) <= 3)
        }
    }

    @Test
    fun sunTimesReadTheUserZoneAtCallTime() = inZone("Australia/Sydney") {
        val (rise, set) = sunTimes(dec)!!
        assertEquals(341.0, rise.toDouble(), 3.0)
        assertEquals(1205.0, set.toDouble(), 3.0)
    }

    @Test
    fun zoneOutsideTheTableHasNoSunTimes() {
        assertNull(sunTimes(dec, ZoneId.of("America/New_York")))
    }

    @Test
    fun unknownZoneDropsOnlyTheNightBand() {
        val data = parseDialData(sampleJson())
        val ny = ZoneId.of("America/New_York")
        val madrid = ZoneId.of("Europe/Madrid")
        assertNull(nightBand(LocalDate.parse(data.date), ny))
        assertNotNull(nightBand(LocalDate.parse(data.date), madrid))
        assertEquals(listOf("sleep", "workouts", "logs", "pulse"), dialLayers(data, false, ny))
        assertEquals(listOf("sleep"), dialLayers(data, true, madrid))
        assertEquals(listOf("night", "sleep", "workouts", "logs", "pulse"), dialLayers(data, false, madrid))
    }
}
