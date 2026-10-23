package com.deluispablo.healthtracker

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AtomicWriteTest {
    private val dir = Files.createTempDirectory("atomic").toFile()

    @Test
    fun replacesExactlyDespiteStaleTempBytes() {
        val file = File(dir, "taps.json").apply { writeText("old") }
        File(dir, "taps.json.tmp").writeText("stale and much longer than the new body")
        writeAtomic(file, "new".toByteArray())
        assertArrayEquals("new".toByteArray(), file.readBytes())
    }

    @Test
    fun aFailedWriteLeavesTheDestinationUntouched() {
        val file = File(dir, "taps.json").apply { writeText("old") }
        File(dir, "taps.json.tmp").mkdir()
        assertThrows(Exception::class.java) { writeAtomic(file, "new".toByteArray()) }
        assertEquals("old", file.readText())
    }
}
