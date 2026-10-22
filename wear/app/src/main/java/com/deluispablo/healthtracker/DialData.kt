package com.deluispablo.healthtracker

import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject

data class Span(val start: Int, val end: Int, val nap: Boolean = false)

data class Mark(val t: Int, val k: String)

data class DialData(
    val date: String,
    val generatedAt: Long,
    val sleep: List<Span>,
    val workouts: List<Span>,
    val events: List<Mark>,
    val hr: List<Int?>,
)

/** Parses the Worker's `GET /watch/today` body. */
fun parseDialData(json: String): DialData {
    val o = JSONObject(json)
    val date = o.getString("date")
    require(LocalDate.parse(date).toString() == date) { "date must be YYYY-MM-DD" }
    val hr = o.getJSONArray("hr")
    require(hr.length() == 96) { "hr must have 96 buckets, got ${hr.length()}" }
    return DialData(
        date = date,
        generatedAt = o.getLong("generatedAt"),
        // A malformed item is skipped so one bad row cannot blank the whole day.
        sleep = o.getJSONArray("sleep").objects().mapNotNull {
            runCatching { it.span(it.getBoolean("nap")) }.getOrNull()
        },
        workouts = o.getJSONArray("workouts").objects().mapNotNull { runCatching { it.span() }.getOrNull() },
        events = o.getJSONArray("events").objects().mapNotNull {
            runCatching { Mark(it.minute("t"), it.getString("k")) }.getOrNull()
        },
        hr = List(96) { i -> if (hr.isNull(i)) null else hr.getInt(i) },
    )
}

private fun JSONArray.objects(): List<JSONObject> = List(length()) { getJSONObject(it) }

private fun JSONObject.minute(key: String): Int {
    val value = get(key)
    require(value is Int) { "$key must be an integer minute" }
    return value
}

private fun JSONObject.span(nap: Boolean = false): Span {
    val start = minute("start")
    val end = minute("end")
    require(end > start) { "span end must be after start" }
    return Span(start, end, nap)
}
