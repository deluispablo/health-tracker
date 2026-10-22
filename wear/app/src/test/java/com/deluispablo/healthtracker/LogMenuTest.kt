package com.deluispablo.healthtracker

import java.time.LocalDateTime
import org.junit.Assert.assertEquals
import org.junit.Test

class LogMenuTest {
    private val at = LocalDateTime.parse("2026-10-22T09:30:00").atZone(USER_ZONE).toEpochSecond()
    private fun catalogJson(archivedProtein: Boolean = false) = sampleJson().replace("\"hr\":", """
        "water":{"ml":750,"goal_ml":2000},
        "trackers":[
          {"id":"caffeine","name":"Cafeína","unit":"mg","value":80,"surface":"face","today":160},
          {"id":"cigarettes","name":"Cigarrillos","unit":"u","value":1,"surface":"face","today":3},
          {"id":"alcohol","name":"Alcohol","unit":"g","value":13,"surface":"face","today":0},
          {"id":"water","name":"Agua","unit":"ml","value":250,"surface":"face","today":750},
          {"id":"mood_bien","name":"Ánimo: bien","unit":"u","value":1,"surface":"face","today":1},
          {"id":"melatonin","name":"Melatonina","unit":"mg","value":1,"surface":"tile","today":1},
          ${if (archivedProtein) "" else """{"id":"protein","name":"Batido de proteína","unit":"g","value":30,"surface":"tile","today":60},"""}
          {"id":"creatine","name":"Creatina","unit":"g","value":5,"surface":"tile","today":0},
          {"id":"bad","name":"x","unit":"u","value":1,"surface":"elsewhere","today":0},
          {"id":"zero","name":"x","unit":"g","value":0,"surface":"tile","today":0}
        ],
        "hr":""")

    @Test
    fun readsTheCatalogAndToleratesItsAbsence() {
        val d = parseDialData(catalogJson())
        assertEquals(Water(750, 2000), d.water)
        assertEquals(listOf("caffeine", "cigarettes", "alcohol", "water", "mood_bien", "melatonin", "protein", "creatine"), d.trackers?.map { it.id })
        val old = parseDialData(sampleJson())
        assertEquals(null, old.water)
        assertEquals(null, old.trackers)
    }

    @Test
    fun splitsFaceAndTileTrackersWithTodaysValues() {
        val menu = logMenu(parseDialData(catalogJson()), emptyList())
        // Coffees and drinks are counted as logs on the dial (one each in the sample), cigarettes as units.
        assertEquals(listOf("caffeine" to "1", "cigarettes" to "3", "alcohol" to "1", "water" to "750 ml"), menu.face.map { it.id to it.today })
        assertEquals(listOf("melatonin" to "1 mg", "protein" to "60 g", "creatine" to "0 g"), menu.supplements.map { it.id to it.today })
        assertEquals(0.375f, menu.face.single { it.id == "water" }.progress)
    }

    @Test
    fun aCoffeeOfAnyDoseCountsAsOne() {
        val d = parseDialData(catalogJson().replace("\"value\":80,\"surface\":\"face\",\"today\":160", "\"value\":80,\"surface\":\"face\",\"today\":200"))
        assertEquals("1", logMenu(d, emptyList()).face.first().today)
    }

    @Test
    fun aCatalogOfOnlyMoodsOffersNoTrackerButtons() {
        val d = parseDialData(sampleJson()).copy(trackers = listOf(CatalogItem("mood_bien", "Ánimo: bien", "u", 1.0, "face", 1.0)))
        assertEquals(emptyList<LogItem>(), logMenu(d, emptyList()).face)
    }

    @Test
    fun anEmptyCatalogOffersNothingRatherThanTheOldTrackers() {
        val d = parseDialData(sampleJson()).copy(trackers = emptyList())
        assertEquals(LogMenu(emptyList(), emptyList()), logMenu(d, emptyList()))
    }

    @Test
    fun anUndoOnADialWithoutKeysStillTakesBackTheCount() {
        assertEquals("0", logMenu(parseDialData(sampleJson().replace(",\"i\":\"tap-1\"", "")), listOf(Tap("x-9", "caffeine", at, undo = true))).face.first().today)
    }

    @Test
    fun beforeTheFirstSyncOnlyTodaysTapsCount() {
        val yesterday = at - 86400
        assertEquals("0", logMenu(null, listOf(Tap("c1", "caffeine", yesterday))).face.first().today)
    }

    @Test
    fun anArchivedTrackerIsSimplyNotOffered() {
        assertEquals(listOf("melatonin", "creatine"), logMenu(parseDialData(catalogJson(archivedProtein = true)), emptyList()).supplements.map { it.id })
    }

    @Test
    fun unsentTapsCountAtOnceAndUndosTakeBack() {
        val d = parseDialData(catalogJson())
        val taps = listOf(Tap("w1", "water", at), Tap("w2", "water", at), Tap("p1", "protein", at), Tap("tap-1", "cigarettes", at, undo = true))
        val menu = logMenu(d, taps)
        assertEquals("1,3 L", menu.face.single { it.id == "water" }.today)
        assertEquals("90 g", menu.supplements.single { it.id == "protein" }.today)
        assertEquals("2", menu.face.single { it.id == "cigarettes" }.today)
    }

    @Test
    fun anOldWorkerStillGetsTheFaceTrackers() {
        val menu = logMenu(parseDialData(sampleJson()), listOf(Tap("c1", "caffeine", at)))
        assertEquals(listOf("caffeine" to "2", "cigarettes" to "1", "alcohol" to "1"), menu.face.map { it.id to it.today })
        assertEquals(emptyList<LogItem>(), menu.supplements)
        assertEquals(listOf("caffeine", "cigarettes", "alcohol"), logMenu(null, emptyList()).face.map { it.id })
    }

    @Test
    fun aNewDayStartsTheTotalsAtZero() {
        val tomorrow = LocalDateTime.parse("2026-10-23T08:00:00").atZone(USER_ZONE)
        val d = dataForToday(parseDialData(catalogJson()), tomorrow)
        assertEquals(Water(0, 2000), d.water)
        assertEquals(listOf("0", "0", "0", "0 ml"), logMenu(d, emptyList()).face.map { it.today })
    }

    @Test
    fun supplementsShowAsOneMarkNamingWhichOne() {
        val day = DialData("2026-10-22", 0, emptyList(), emptyList(), emptyList(), List(96) { null })
        assertEquals(listOf("suplemento" to "protein", "agua" to null),
            withTaps(day, listOf(Tap("p1", "protein", at), Tap("w1", "water", at + 60))).events.map { it.k to it.m })
        assertEquals("creatine", parseDialData(sampleJson().replace("{\"t\":460,\"k\":\"cafe\"}", "{\"t\":460,\"k\":\"suplemento\",\"id\":\"creatine\"}")).events[0].m)
    }
}
