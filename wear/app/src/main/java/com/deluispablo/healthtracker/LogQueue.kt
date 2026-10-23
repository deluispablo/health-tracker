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
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/**
 * A log waiting for the Worker: [id] is its idempotency key, [at] the tap time in epoch seconds.
 * An [undo] tap asks the Worker to delete the already-sent log with the same id. [acked] is the
 * [ticket] taken when the Worker accepted it; it stays queued until a dial shows the outcome.
 */
data class Tap(val id: String, val tracker: String, val at: Long, val undo: Boolean = false, val acked: Long? = null)

/** This process; tickets from an earlier one cannot be compared, so their acks are forgotten. */
val RUN: String = UUID.randomUUID().toString()
private val tickets = AtomicLong()

/** A strictly increasing number for this process, independent of the wall clock. */
fun ticket(): Long = tickets.incrementAndGet()

fun kindOf(tracker: String): String = when {
    tracker == "caffeine" -> "cafe"
    tracker == "cigarettes" -> "cigarro"
    tracker == "alcohol" -> "alcohol"
    tracker == "water" -> "agua"
    tracker.startsWith("mood_") -> "animo"
    // Everything else the watch logs comes from the Suplementos ring; a new face tracker needs its own case.
    else -> "suplemento"
}

/** The mood's name, or the supplement's id, that a mark of [tracker] carries in its `m`. */
fun which(tracker: String): String? = when (kindOf(tracker)) {
    "animo" -> tracker.removePrefix("mood_")
    "suplemento" -> tracker
    else -> null
}

/** Acks from another [run] are dropped: the tap is simply sent again, which the idempotency key makes safe. */
fun parseTaps(json: String, run: String = RUN): List<Tap> = JSONArray(json).let { a ->
    List(a.length()) { i ->
        runCatching {
            a.getJSONObject(i).run {
                Tap(getString("id"), getString("tracker"), getLong("at"), optBoolean("undo"),
                    (opt("acked") as? Number)?.toLong()?.takeIf { optString("run") == run })
            }
        }.getOrNull()
    }.filterNotNull()
}

fun tapsJson(taps: List<Tap>, run: String = RUN): String =
    JSONArray(taps.map {
        JSONObject().put("id", it.id).put("tracker", it.tracker).put("at", it.at).put("undo", it.undo).putOpt("acked", it.acked).putOpt("run", it.acked?.let { run })
    }).toString()

/** Marks exactly [tap] as taken by the Worker; an undo queued for it meanwhile is a different entry and stays. */
fun ackTap(taps: List<Tap>, tap: Tap, ticket: Long): List<Tap> = taps.map { if (it == tap) it.copy(acked = ticket) else it }

/**
 * Drops the taps [data], requested with [fetchTicket], already settles: a log once its key is on the dial;
 * an undo once the Worker took it and the key is gone. Any tap acked before that request goes too,
 * since that dial reflects it even when the key is missing (deleted elsewhere, another day, archived).
 * An undo is never dropped before it is sent, in case its log is still in flight.
 */
fun confirmedBy(taps: List<Tap>, data: DialData, fetchTicket: Long): List<Tap> {
    val shown = data.events.mapNotNull { it.i }.toSet()
    return taps.filterNot {
        val acked = it.acked
        (acked != null && acked < fetchTicket) || if (it.undo) acked != null && it.id !in shown else it.id in shown
    }
}

/** Remembers the newest dial request applied, so a slower, older response cannot overwrite it. */
class FetchOrder {
    private var newest = Long.MIN_VALUE

    @Synchronized fun accept(ticket: Long): Boolean = (ticket > newest).also { if (it) newest = ticket }
}

/** Applies the day's unsent taps to the dial, so a log or an undo shows before the Worker confirms it. */
fun withTaps(data: DialData, taps: List<Tap>): DialData {
    val today = taps.mapNotNull { tap ->
        val local = Instant.ofEpochSecond(tap.at).atZone(USER_ZONE)
        if (local.toLocalDate().toString() == data.date) tap to Mark(minutesSince(data.date, local), kindOf(tap.tracker),
            which(tap.tracker), tap.id) else null
    }
    if (today.isEmpty()) return data
    val shown = data.events.mapNotNull { it.i }.toSet()
    val events = (data.events + today.filter { !it.first.undo && it.first.id !in shown }.map { it.second }).toMutableList()
    // Dials cached before marks carried keys fall back to removing an equal mark.
    for ((tap, mark) in today.filter { it.first.undo }) {
        if (!events.removeAll { it.i == tap.id }) events.remove(mark.copy(i = null))
    }
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

/** Whether any tap still waits for the Worker to take it. */
fun hasUnsent(taps: List<Tap>) = taps.any { it.acked == null }

// Enqueued before the redraw, so a failed render cannot leave a tap unsent.
private fun send(ctx: Context) {
    enqueueSend(ctx)
    refreshCache(ctx, null)
}

/** Queues [LogWorker]; KEEP lets the hourly check rely on a send already pending instead of chaining another. */
fun enqueueSend(ctx: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
    WorkManager.getInstance(ctx).enqueueUniqueWork(
        "log-send",
        policy,
        OneTimeWorkRequestBuilder<LogWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build(),
    )
}

/** The menus as of now: cached totals plus unsent taps, or the built-in trackers before the first sync. */
fun menuNow(ctx: Context): LogMenu = synchronized(cacheLock) {
    val data = chooseCached(null, File(ctx.filesDir, "dial.json").takeIf { it.exists() }?.readText())?.let { dataForToday(it) }
    logMenu(data, readTaps(ctx))
}

