package com.deluispablo.healthtracker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val TAG = "LogWorker"

/**
 * Whether the Worker's answer ends a tap: accepted, or refused for good (a bad log, a key taken by another log, an undo with
 * nothing left). A 404 on a log means the endpoint is missing, so the log waits instead of vanishing.
 */
internal fun settled(code: Int, undo: Boolean) = code == 200 || code == 201 || code == 400 || code == 409 || (code == 404 && undo)

/** Sends every queued tap, then refreshes the dial; retries keep the same idempotency keys. */
class LogWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val taps = synchronized(cacheLock) { readTaps(ctx) }
        var retry = false
        for (tap in taps.filter { it.acked == null }) {
            val code = send(tap)
            if (!settled(code, tap.undo)) { Log.w(TAG, "/watch/log -> $code"); retry = true; break }
            synchronized(cacheLock) {
                val queue = readTaps(ctx)
                if (code >= 300) Log.w(TAG, "dropping tap ${tap.id} after $code")
                writeTaps(ctx, if (code >= 300) queue - tap else ackTap(queue, tap, System.currentTimeMillis()))
            }
        }
        if (taps.isNotEmpty() && fetchToday(ctx) != 200) retry = true
        if (retry) Result.retry() else Result.success()
    }

    private fun send(tap: Tap): Int {
        val conn = URL("${BuildConfig.WATCH_BASE_URL}/watch/log").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 20_000
            conn.readTimeout = 20_000
            conn.requestMethod = if (tap.undo) "DELETE" else "POST"
            conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.WATCH_TOKEN}")
            conn.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("idempotency_key", tap.id)
            if (!tap.undo) body.put("tracker_id", tap.tracker).put("at", Instant.ofEpochSecond(tap.at).toString())
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            conn.responseCode
        } catch (e: IOException) {
            Log.w(TAG, "send failed", e)
            -1
        } finally {
            conn.disconnect()
        }
    }
}
