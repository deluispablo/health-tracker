package com.deluispablo.healthtracker

import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Test

class LogQueueTest {
    private fun at(local: String) = ZonedDateTime.parse("${local}+02:00[Europe/Madrid]").toEpochSecond()
    private val day = DialData("2026-10-22", 0, emptyList(), emptyList(), listOf(Mark(600, "cafe")), List(96) { null })

    @Test
    fun tapsRoundTripAndSkipMalformedRows() {
        val taps = listOf(Tap("a-1", "caffeine", 10), Tap("b-2", "mood_bien", 20))
        assertEquals(taps, parseTaps(tapsJson(taps)))
        assertEquals(listOf(Tap("ok", "alcohol", 5)), parseTaps("""[{"id":"ok","tracker":"alcohol","at":5},{"id":"x"},3]"""))
    }

    @Test
    fun addsOnlyTheDaysTapsInOrder() {
        val taps = listOf(
            Tap("1", "cigarettes", at("2026-10-22T09:30:00")),
            Tap("2", "mood_triste", at("2026-10-22T11:00:00")),
            Tap("3", "caffeine", at("2026-10-21T23:50:00")),
        )
        assertEquals(listOf(Mark(570, "cigarro", i = "1"), Mark(600, "cafe"), Mark(660, "animo", "triste", "2")), withTaps(day, taps).events)
        assertEquals(day, withTaps(day, emptyList()))
    }

    @Test
    fun kindsMatchTheWorker() {
        assertEquals(listOf("cafe", "cigarro", "alcohol", "animo", "other"),
            listOf("caffeine", "cigarettes", "alcohol", "mood_genial", "water").map(::kindOf))
    }
}

class UndoTest {
    private val day = DialData("2026-10-22", 0, emptyList(), emptyList(), listOf(Mark(570, "cigarro")), List(96) { null })
    private val at = java.time.ZonedDateTime.parse("2026-10-22T09:30:00+02:00[Europe/Madrid]").toEpochSecond()

    @Test
    fun undoReplacesTheQueuedLogWithItsDeletion() {
        val log = Tap("x-1", "cigarettes", at)
        val other = Tap("y-2", "caffeine", at)
        assertEquals(listOf(other, log.copy(undo = true)), undoTaps(listOf(log, other), log))
        assertEquals(listOf(log.copy(undo = true)), undoTaps(emptyList(), log))
        assertEquals(listOf(log.copy(undo = true)), parseTaps(tapsJson(listOf(log.copy(undo = true)))))
    }

    private fun dial(vararg keys: String) = day.copy(events = keys.map { Mark(570, "cigarro", i = it) })

    @Test
    fun anUndoTappedWhileItsLogIsInFlightSurvivesTheAck() {
        val log = Tap("x-1", "cigarettes", at)
        val undone = undoTaps(listOf(log), log)
        assertEquals(undone, ackTap(undone, log, 1_000))
        // The log landed and shows on the dial: the undo still has to go out.
        assertEquals(undone, confirmedBy(undone, dial("x-1"), 2_000))
        assertEquals(undone, confirmedBy(undone, dial(), 2_000))
        assertEquals(emptyList<Tap>(), confirmedBy(ackTap(undone, undone[0], 1_000), dial(), 500))
    }

    @Test
    fun aLogLeavesTheQueueOnceTheDialShowsItsKey() {
        val log = Tap("x-1", "cigarettes", at)
        assertEquals(listOf(log), confirmedBy(listOf(log), dial("y-2"), 2_000))
        assertEquals(emptyList<Tap>(), confirmedBy(listOf(log), dial("x-1"), 2_000))
        // A refresh that already has the log never draws it twice, whatever the timing.
        assertEquals(dial("x-1"), withTaps(dial("x-1"), listOf(log.copy(acked = 3_000))))
        assertEquals(listOf(log.copy(acked = 3_000)), parseTaps(tapsJson(listOf(log.copy(acked = 3_000)))))
    }

    @Test
    fun aDialFetchedAfterTheAckSettlesALogItDoesNotShow() {
        // Deleted elsewhere, logged on another day or on an archived tracker: the key never shows up.
        val acked = Tap("x-1", "cigarettes", at, acked = 1_000)
        assertEquals(listOf(acked), confirmedBy(listOf(acked), dial(), 999))
        assertEquals(emptyList<Tap>(), confirmedBy(listOf(acked), dial(), 1_000))
        assertEquals(listOf(Tap("y-2", "caffeine", at)), confirmedBy(listOf(Tap("y-2", "caffeine", at)), dial(), 9_000))
    }

    @Test
    fun anOlderResponseArrivingLateIsIgnored() {
        val inOrder = FetchOrder()
        assertEquals(listOf(true, true), listOf(1_000L, 2_000L).map(inOrder::accept))
        val late = FetchOrder()
        assertEquals(listOf(true, false), listOf(2_000L, 1_000L).map(late::accept))
    }

    @Test
    fun anUndoRemovesItsOwnMarkByKey() {
        assertEquals(dial("y-2"), withTaps(day.copy(events = listOf(Mark(570, "cigarro", i = "y-2"), Mark(570, "cigarro", i = "x-1"))),
            listOf(Tap("x-1", "cigarettes", at, undo = true))))
    }

    @Test
    fun anUndoHidesTheSentMarkUntilTheNextRefresh() {
        assertEquals(emptyList<Mark>(), withTaps(day, listOf(Tap("x-1", "cigarettes", at, undo = true))).events)
    }
}

class SendOutcomeTest {
    @Test
    fun aMissingEndpointNeverDropsALog() {
        assertEquals(false, settled(404, undo = false))
        assertEquals(true, settled(404, undo = true))
        assertEquals(listOf(true, true, true, true, false, false, false), listOf(200, 201, 400, 409, 401, 500, -1).map { settled(it, false) })
    }
}
