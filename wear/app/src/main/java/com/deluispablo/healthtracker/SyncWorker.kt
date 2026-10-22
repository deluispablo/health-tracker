package com.deluispablo.healthtracker

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZonedDateTime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "SyncWorker"
internal val cacheLock = Any()

/** The new body when it parses, else the last good one, else null. */
fun chooseCached(newJson: String?, oldJson: String?): DialData? =
    sequenceOf(newJson, oldJson).firstNotNullOfOrNull { json ->
        json?.let { runCatching { parseDialData(it) }.getOrNull() }
    }

class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        when (fetchToday(applicationContext)) {
            200 -> Result.success()
            // A rejected token will not fix itself by retrying.
            401 -> Result.success()
            else -> Result.retry()
        }
    }
}

/**
 * Fetches today's dial and redraws; acknowledged taps leave the queue only together with a body
 * that already includes them. Returns the HTTP status, or -1 when the network failed.
 */
fun fetchToday(ctx: Context): Int {
    val start = System.currentTimeMillis()
    val conn = URL("${BuildConfig.WATCH_BASE_URL}/watch/today").openConnection() as HttpURLConnection
    try {
        conn.connectTimeout = 20_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.WATCH_TOKEN}")
        val code = conn.responseCode
        Log.i(TAG, "GET /watch/today -> $code")
        if (code == 401) Log.w(TAG, "token rejected; check watchToken in local.properties")
        // Redraw the cached day otherwise, so "now" and the stale dimming stay current.
        refreshCache(ctx, if (code == 200) conn.inputStream.bufferedReader().use { it.readText() } else null, start)
        return code
    } catch (e: IOException) {
        Log.w(TAG, "fetch failed", e)
        refreshCache(ctx, null)
        return -1
    } finally {
        conn.disconnect()
    }
}

class RedrawWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        refreshCache(applicationContext, null)
        Result.success()
    }
}

/** Renders before saving a valid new body, then pokes the complication. */
fun refreshCache(ctx: Context, body: String?, fetchStartMs: Long = 0) = synchronized(cacheLock) {
    val dir = ctx.filesDir
    val jsonFile = File(dir, "dial.json")
    val newData = chooseCached(body, null)
    val data = newData ?: chooseCached(null, jsonFile.takeIf { it.exists() }?.readText()) ?: return
    if (newData != null) readTaps(ctx).let { taps -> confirmedBy(taps, fetchStartMs).takeIf { it != taps }?.let { writeTaps(ctx, it) } }
    val now = ZonedDateTime.now(MADRID)
    val today = withTaps(dataForToday(data, now), readTaps(ctx))
    val minutes = minutesSince(today.date, now)
    val png = renderDial(today, minutes, ambient = false).png()
    val ambient = renderDial(today, minutes, ambient = true).png()
    writeAtomic(File(dir, "dial.png"), png)
    writeAtomic(File(dir, "dial-ambient.png"), ambient)
    if (newData != null) writeAtomic(jsonFile, body!!.toByteArray())
    ComplicationDataSourceUpdateRequester
        .create(ctx, ComponentName(ctx, DialComplicationService::class.java))
        .requestUpdateAll()
}

private fun Bitmap.png(): ByteArray =
    ByteArrayOutputStream().also { compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()

// Readers never see a half-written file.
internal fun writeAtomic(file: File, bytes: ByteArray) {
    val tmp = File(file.parentFile, "${file.name}.tmp")
    tmp.writeBytes(bytes)
    if (!tmp.renameTo(file)) throw IOException("rename failed for ${file.name}")
}
