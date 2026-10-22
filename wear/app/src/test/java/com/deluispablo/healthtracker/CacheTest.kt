package com.deluispablo.healthtracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CacheTest {
    @Test
    fun readsLastGoodJsonWhenNewIsInvalid() {
        val old = sampleJson()
        assertEquals(parseDialData(old), chooseCached("{not json", old))
        assertEquals(parseDialData(old), chooseCached(sampleJson(hrSize = 95), old))
        assertEquals(parseDialData(old), chooseCached(null, old))
    }

    @Test
    fun invalidDateKeepsPreviousGoodJson() {
        val old = sampleJson()
        for (date in listOf("not-a-date", "2026-02-30", "2026-13-01")) {
            val invalid = old.replace("2026-10-22", date)
            assertNull(chooseCached(invalid, null))
            assertEquals(parseDialData(old), chooseCached(invalid, old))
        }
    }

    @Test
    fun prefersValidNewJson() {
        val new = sampleJson().replace("2026-10-22", "2026-10-23")
        assertEquals("2026-10-23", chooseCached(new, sampleJson())?.date)
    }

    @Test
    fun nothingValidGivesNull() = assertNull(chooseCached("", null))
}
