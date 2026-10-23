package com.deluispablo.healthtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LogRequestTest {
    private val tap = Tap("key-1", "coffee", 1_800_000_000)

    @Test
    fun postCarriesTheWatchHeadersAndTheLog() = inZone("Australia/Sydney") {
        val r = logRequest(tap)
        assertEquals("POST", r.method)
        assertEquals("Australia/Sydney", r.headers["X-Time-Zone"])
        assertEquals(todayHeaders()["Authorization"], r.headers["Authorization"])
        assertEquals("application/json", r.headers["Content-Type"])
        assertTrue(r.body, r.body.contains("\"idempotency_key\":\"key-1\""))
        assertTrue(r.body, r.body.contains("\"tracker_id\":\"coffee\""))
        assertTrue(r.body, r.body.contains("\"at\":\"2027-01-15T08:00:00Z\""))
    }

    @Test
    fun deleteKeepsTheSameHeaders() = inZone("Australia/Perth") {
        val r = logRequest(tap.copy(undo = true))
        assertEquals("DELETE", r.method)
        assertEquals("Australia/Perth", r.headers["X-Time-Zone"])
        assertEquals("application/json", r.headers["Content-Type"])
        assertTrue(r.body, r.body.contains("\"idempotency_key\":\"key-1\""))
    }
}
