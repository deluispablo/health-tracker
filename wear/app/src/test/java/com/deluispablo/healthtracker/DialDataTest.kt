package com.deluispablo.healthtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal fun sampleJson(hrSize: Int = 96): String {
    val hr = (0 until hrSize).joinToString(",") { i -> if (i == 0) "60" else if (i == 72) "120" else "null" }
    return """
        {"date":"2026-10-22","generatedAt":1792652400,
         "sleep":[{"start":-30,"end":430,"nap":false},{"start":900,"end":940,"nap":true}],
         "workouts":[{"start":1080,"end":1140}],
         "events":[{"t":460,"k":"cafe"},{"t":675,"k":"cigarro"},{"t":1170,"k":"alcohol"}],
         "hr":[$hr]}
    """.trimIndent()
}

class DialDataTest {
    @Test
    fun parsesEndpointJson() {
        val d = parseDialData(sampleJson())
        assertEquals("2026-10-22", d.date)
        assertEquals(1792652400L, d.generatedAt)
        assertEquals(Span(-30, 430, false), d.sleep[0])
        assertEquals(Span(900, 940, true), d.sleep[1])
        assertEquals(listOf(Span(1080, 1140)), d.workouts)
        assertEquals(listOf("cafe", "cigarro", "alcohol"), d.events.map { it.k })
        assertEquals(60, d.hr[0])
        assertEquals(120, d.hr[72])
        assertNull(d.hr[1])
    }

    @Test
    fun skipsMalformedSpansAndKeepsTheRest() {
        val good = parseDialData(sampleJson())
        for (span in listOf(
            "{\"start\":1140,\"end\":1080}",
            "{\"start\":1080,\"end\":1080}",
            "{\"start\":1080.5,\"end\":1140}",
            "{\"start\":\"1080\",\"end\":1140}",
            "{\"start\":1080}",
        )) {
            val parsed = parseDialData(sampleJson().replace("{\"start\":1080,\"end\":1140}", span))
            assertEquals(good.workouts.size - 1, parsed.workouts.size)
            assertEquals(good.sleep, parsed.sleep)
            assertEquals(good.events, parsed.events)
        }
        assertEquals(good.sleep.size - 1, parseDialData(sampleJson().replace("\"end\":430", "\"end\":-30")).sleep.size)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsShortHr() {
        parseDialData(sampleJson(hrSize = 95))
    }

    @Test
    fun skipsNonObjectItemsAroundValidRows() {
        val good = parseDialData(sampleJson())
        val json = sampleJson()
            .replace("\"sleep\":[", "\"sleep\":[null,\"x\",7,")
            .replace("\"workouts\":[", "\"workouts\":[null,")
            .replace("{\"start\":1080,\"end\":1140}", "{\"start\":1080,\"end\":1140},\"y\"")
            .replace("\"events\":[", "\"events\":[3,null,")
        val parsed = parseDialData(json)
        assertEquals(good.sleep, parsed.sleep)
        assertEquals(good.workouts, parsed.workouts)
        assertEquals(good.events, parsed.events)
    }
}
