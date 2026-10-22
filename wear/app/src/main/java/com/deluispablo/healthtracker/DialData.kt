package com.deluispablo.healthtracker

import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject

data class Span(val start: Int, val end: Int, val nap: Boolean = false)

/** A log at minute [t] of kind [k]; moods also name which one in [m], watch logs their key in [i]. */
data class Mark(val t: Int, val k: String, val m: String? = null, val i: String? = null)

/** Today's water against the profile goal, in ml. */
data class Water(val ml: Int, val goalMl: Int)

/** A tracker the watch can log: [value] is one tap's dose, [today] the day's total in [unit]. */
data class CatalogItem(val id: String, val name: String, val unit: String, val value: Double, val surface: String, val today: Double)

data class DialData(
    val date: String,
    val generatedAt: Long,
    val sleep: List<Span>,
    val workouts: List<Span>,
    val events: List<Mark>,
    val hr: List<Int?>,
    // Absent from Workers older than the tracker catalog.
    val water: Water? = null,
    val trackers: List<CatalogItem> = emptyList(),
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
        sleep = o.getJSONArray("sleep").items { it.span(it.getBoolean("nap")) },
        workouts = o.getJSONArray("workouts").items { it.span() },
        events = o.getJSONArray("events").items { Mark(it.minute("t"), it.getString("k"), it.optString("m").ifEmpty { null }, it.optString("i").ifEmpty { null }) },
        hr = List(96) { i -> if (hr.isNull(i)) null else hr.getInt(i) },
        water = o.optJSONObject("water")?.let { w ->
            runCatching { Water(w.getInt("ml"), w.getInt("goal_ml")).takeIf { it.ml >= 0 && it.goalMl > 0 } }.getOrNull()
        },
        trackers = o.optJSONArray("trackers")?.items {
            CatalogItem(it.getString("id"), it.getString("name"), it.getString("unit"), it.getDouble("value"),
                it.getString("surface").also { s -> require(s == "face" || s == "tile") }, it.getDouble("today"))
        } ?: emptyList(),
    )
}

/** Parses each item on its own; non-objects and malformed rows are dropped. */
private fun <T : Any> JSONArray.items(parse: (JSONObject) -> T): List<T> =
    List(length()) { i -> runCatching { parse(getJSONObject(i)) }.getOrNull() }.filterNotNull()

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
