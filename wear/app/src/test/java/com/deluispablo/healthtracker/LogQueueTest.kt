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
        assertEquals(listOf(Mark(570, "cigarro"), Mark(600, "cafe"), Mark(660, "animo", "triste")), withTaps(day, taps).events)
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

    @Test
    fun anUndoTappedWhileItsLogIsInFlightSurvivesTheAck() {
        val log = Tap("x-1", "cigarettes", at)
        val undone = undoTaps(listOf(log), log)
        assertEquals(undone, ackTap(undone, log, 1_000))
        assertEquals(undone, confirmedBy(ackTap(undone, log, 1_000), 2_000))
    }

    @Test
    fun onlyADialFetchedAfterTheAckConfirmsATap() {
        val acked = Tap("x-1", "cigarettes", at, acked = 1_000)
        val pending = Tap("y-2", "caffeine", at)
        assertEquals(listOf(acked, pending), confirmedBy(listOf(acked, pending), 999))
        assertEquals(listOf(pending), confirmedBy(listOf(acked, pending), 1_000))
        assertEquals(listOf(acked), parseTaps(tapsJson(listOf(acked))))
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
        assertEquals(listOf(true, true, true, false, false, false), listOf(200, 201, 400, 401, 500, -1).map { settled(it, false) })
    }
}
