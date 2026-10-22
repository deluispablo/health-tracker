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

/** Sends every queued tap, then refreshes the dial; retries keep the same idempotency keys. */
class LogWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val taps = synchronized(cacheLock) { readTaps(ctx) }
        val sent = mutableSetOf<String>()
        var retry = false
        for (tap in taps) {
            when (val code = post(tap)) {
                200, 201 -> sent += tap.id
                // The Worker refused this tap for good (unknown tracker, older than a week).
                400 -> { Log.w(TAG, "dropping tap ${tap.id}"); sent += tap.id }
                else -> { Log.w(TAG, "POST /watch/log -> $code"); retry = true; break }
            }
        }
        if (sent.isNotEmpty() && fetchToday(ctx, sent) != 200) retry = true
        if (retry) Result.retry() else Result.success()
    }

    private fun post(tap: Tap): Int {
        val conn = URL("${BuildConfig.WATCH_BASE_URL}/watch/log").openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 20_000
            conn.readTimeout = 20_000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.WATCH_TOKEN}")
            conn.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("tracker_id", tap.tracker)
                .put("at", Instant.ofEpochSecond(tap.at).toString()).put("idempotency_key", tap.id)
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            conn.responseCode
        } catch (e: IOException) {
            Log.w(TAG, "POST failed", e)
            -1
        } finally {
            conn.disconnect()
        }
    }
}
