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

/** A log waiting for the Worker: [id] is its idempotency key, [at] the tap time in epoch seconds. */
data class Tap(val id: String, val tracker: String, val at: Long)

fun kindOf(tracker: String): String = when {
    tracker == "caffeine" -> "cafe"
    tracker == "cigarettes" -> "cigarro"
    tracker == "alcohol" -> "alcohol"
    tracker.startsWith("mood_") -> "animo"
    else -> "other"
}

fun parseTaps(json: String): List<Tap> = JSONArray(json).let { a ->
    List(a.length()) { i ->
        runCatching { a.getJSONObject(i).run { Tap(getString("id"), getString("tracker"), getLong("at")) } }.getOrNull()
    }.filterNotNull()
}

fun tapsJson(taps: List<Tap>): String =
    JSONArray(taps.map { JSONObject().put("id", it.id).put("tracker", it.tracker).put("at", it.at) }).toString()

/** Adds the day's unsent taps to the dial, so a log shows before the Worker confirms it. */
fun withTaps(data: DialData, taps: List<Tap>): DialData {
    val marks = taps.mapNotNull { tap ->
        val local = Instant.ofEpochSecond(tap.at).atZone(MADRID)
        if (local.toLocalDate().toString() == data.date) Mark(minutesSince(data.date, local), kindOf(tap.tracker)) else null
    }
    return if (marks.isEmpty()) data else data.copy(events = (data.events + marks).sortedBy { it.t })
}

private fun tapsFile(ctx: Context) = File(ctx.filesDir, "taps.json")

/** Callers hold [cacheLock]. */
internal fun readTaps(ctx: Context): List<Tap> =
    tapsFile(ctx).takeIf { it.exists() }?.let { runCatching { parseTaps(it.readText()) }.getOrNull() } ?: emptyList()

internal fun writeTaps(ctx: Context, taps: List<Tap>) = writeAtomic(tapsFile(ctx), tapsJson(taps).toByteArray())

/** Queues one log, redraws at once and asks [LogWorker] to send it. */
fun logTap(ctx: Context, tracker: String, nowSec: Long = System.currentTimeMillis() / 1000) {
    synchronized(cacheLock) { writeTaps(ctx, readTaps(ctx) + Tap(UUID.randomUUID().toString(), tracker, nowSec)) }
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
