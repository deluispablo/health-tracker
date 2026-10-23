package com.deluispablo.healthtracker

import org.junit.Assert.assertEquals
import org.junit.Test

class LogRingTest {
    @Test
    fun supplementRingUses48dpWhileItFits() {
        assertEquals(60 to 66.0, supplementRing(4))
        assertEquals(48 to 72.0, supplementRing(5))
        assertEquals(48 to 72.0, supplementRing(9))
        assertEquals(44, supplementRing(10).first)
    }

    @Test
    fun tenSupplementsKeepEveryItem() {
        val spots = ringSpots(10, supplementRing(10).second)
        assertEquals(10, spots.size)
        assertEquals(10, spots.distinct().size)
    }
}
