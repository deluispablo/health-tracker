package com.deluispablo.healthtracker

import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Test

class LogMenuTest {
    private val at = ZonedDateTime.parse("2026-10-22T09:30:00+02:00[Europe/Madrid]").toEpochSecond()
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
          {"id":"bad","name":"x","unit":"u","value":1,"surface":"elsewhere","today":0}
        ],
        "hr":""")

    @Test
    fun readsTheCatalogAndToleratesItsAbsence() {
        val d = parseDialData(catalogJson())
        assertEquals(Water(750, 2000), d.water)
        assertEquals(listOf("caffeine", "cigarettes", "alcohol", "water", "mood_bien", "melatonin", "protein", "creatine"), d.trackers.map { it.id })
        val old = parseDialData(sampleJson())
        assertEquals(null, old.water)
        assertEquals(emptyList<CatalogItem>(), old.trackers)
    }

    @Test
    fun splitsFaceAndTileTrackersWithTodaysValues() {
        val menu = logMenu(parseDialData(catalogJson()), emptyList())
        assertEquals(listOf("caffeine" to "2", "cigarettes" to "3", "alcohol" to "0", "water" to "750 ml"), menu.face.map { it.id to it.today })
        assertEquals(listOf("melatonin" to "1 mg", "protein" to "60 g", "creatine" to "0 g"), menu.more.map { it.id to it.today })
        assertEquals(0.375f, menu.face.single { it.id == "water" }.progress)
    }

    @Test
    fun anArchivedTrackerIsSimplyNotOffered() {
        assertEquals(listOf("melatonin", "creatine"), logMenu(parseDialData(catalogJson(archivedProtein = true)), emptyList()).more.map { it.id })
    }

    @Test
    fun unsentTapsCountAtOnceAndUndosTakeBack() {
        val d = parseDialData(catalogJson())
        val taps = listOf(Tap("w1", "water", at), Tap("w2", "water", at), Tap("p1", "protein", at), Tap("tap-1", "cigarettes", at, undo = true))
        val menu = logMenu(d, taps)
        assertEquals("1,3 L", menu.face.single { it.id == "water" }.today)
        assertEquals("90 g", menu.more.single { it.id == "protein" }.today)
        assertEquals("2", menu.face.single { it.id == "cigarettes" }.today)
    }

    @Test
    fun anOldWorkerStillGetsTheFaceTrackers() {
        val menu = logMenu(parseDialData(sampleJson()), listOf(Tap("c1", "caffeine", at)))
        assertEquals(listOf("caffeine" to "2", "cigarettes" to "1", "alcohol" to "1"), menu.face.map { it.id to it.today })
        assertEquals(emptyList<LogItem>(), menu.more)
        assertEquals(listOf("caffeine", "cigarettes", "alcohol"), logMenu(null, emptyList()).face.map { it.id })
    }

    @Test
    fun supplementsNeverReachTheDial() {
        val day = DialData("2026-10-22", 0, emptyList(), emptyList(), emptyList(), List(96) { null })
        assertEquals(listOf("agua"), withTaps(day, listOf(Tap("p1", "protein", at), Tap("w1", "water", at))).events.map { it.k })
    }
}
