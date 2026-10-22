package com.deluispablo.healthtracker

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.io.File
import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * A log waiting for the Worker: [id] is its idempotency key, [at] the tap time in epoch seconds.
 * An [undo] tap asks the Worker to delete the already-sent log with the same id.
 */
data class Tap(val id: String, val tracker: String, val at: Long, val undo: Boolean = false)

fun kindOf(tracker: String): String = when {
    tracker == "caffeine" -> "cafe"
    tracker == "cigarettes" -> "cigarro"
    tracker == "alcohol" -> "alcohol"
    tracker.startsWith("mood_") -> "animo"
    else -> "other"
}

fun parseTaps(json: String): List<Tap> = JSONArray(json).let { a ->
    List(a.length()) { i ->
        runCatching {
            a.getJSONObject(i).run { Tap(getString("id"), getString("tracker"), getLong("at"), optBoolean("undo")) }
        }.getOrNull()
    }.filterNotNull()
}

fun tapsJson(taps: List<Tap>): String =
    JSONArray(taps.map { JSONObject().put("id", it.id).put("tracker", it.tracker).put("at", it.at).put("undo", it.undo) }).toString()

/** Applies the day's unsent taps to the dial, so a log or an undo shows before the Worker confirms it. */
fun withTaps(data: DialData, taps: List<Tap>): DialData {
    val today = taps.mapNotNull { tap ->
        val local = Instant.ofEpochSecond(tap.at).atZone(MADRID)
        if (local.toLocalDate().toString() == data.date) tap to Mark(minutesSince(data.date, local), kindOf(tap.tracker), tap.tracker.removePrefix("mood_").takeIf { tap.tracker.startsWith("mood_") }) else null
    }
    if (today.isEmpty()) return data
    val events = (data.events + today.filter { !it.first.undo }.map { it.second }).toMutableList()
    for ((_, mark) in today.filter { it.first.undo }) events.remove(mark)
    return data.copy(events = events.sortedBy { it.t })
}

private fun tapsFile(ctx: Context) = File(ctx.filesDir, "taps.json")

/** Callers hold [cacheLock]. */
internal fun readTaps(ctx: Context): List<Tap> =
    tapsFile(ctx).takeIf { it.exists() }?.let { runCatching { parseTaps(it.readText()) }.getOrNull() } ?: emptyList()

internal fun writeTaps(ctx: Context, taps: List<Tap>) = writeAtomic(tapsFile(ctx), tapsJson(taps).toByteArray())

private fun lastFile(ctx: Context) = File(ctx.filesDir, "last.json")

/** The last log made on the watch while it can still be undone, else null. */
fun lastTap(ctx: Context, nowSec: Long = System.currentTimeMillis() / 1000): Tap? = synchronized(cacheLock) {
    lastFile(ctx).takeIf { it.exists() }?.let { runCatching { parseTaps(it.readText()).single() }.getOrNull() }
        ?.takeIf { nowSec - it.at <= UNDO_WINDOW_SEC }
}

const val UNDO_WINDOW_SEC = 15 * 60

/**
 * Drops [last] from the queue and always queues its deletion: a queued log may already have reached
 * the Worker (it stays queued until a refresh confirms it), and deleting an unknown key is harmless.
 */
fun undoTaps(taps: List<Tap>, last: Tap): List<Tap> = taps.filter { it.id != last.id } + last.copy(undo = true)

/** Queues one log, redraws at once and asks [LogWorker] to send it. */
fun logTap(ctx: Context, tracker: String, nowSec: Long = System.currentTimeMillis() / 1000) {
    val tap = Tap(UUID.randomUUID().toString(), tracker, nowSec)
    synchronized(cacheLock) {
        writeTaps(ctx, readTaps(ctx) + tap)
        writeAtomic(lastFile(ctx), tapsJson(listOf(tap)).toByteArray())
    }
    send(ctx)
}

/** Takes back the last watch log, whether or not it was sent yet. */
fun undoLast(ctx: Context) {
    synchronized(cacheLock) {
        val last = lastTap(ctx) ?: return
        writeTaps(ctx, undoTaps(readTaps(ctx), last))
        lastFile(ctx).delete()
    }
    send(ctx)
}

private fun send(ctx: Context) {
    refreshCache(ctx, null)
    WorkManager.getInstance(ctx).enqueueUniqueWork(
        "log-send",
        ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequestBuilder<LogWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build(),
    )
}

/** Today's dial as drawn, unsent taps included; null before the first sync. */
fun todayWithTaps(ctx: Context): DialData? = synchronized(cacheLock) {
    val data = chooseCached(null, File(ctx.filesDir, "dial.json").takeIf { it.exists() }?.readText()) ?: return null
    withTaps(dataForToday(data), readTaps(ctx))
}
