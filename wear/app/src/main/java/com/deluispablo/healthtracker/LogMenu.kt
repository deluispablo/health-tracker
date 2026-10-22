package com.deluispablo.healthtracker

import java.util.Locale
import kotlin.math.roundToInt

/** One loggable tracker as the menus show it: [today] is ready to print, [progress] only for goals. */
data class LogItem(val id: String, val name: String, val today: String, val progress: Float? = null)

/**
 * What the face menu, the Tile and the «more» list offer: [face] in catalog order (moods are one
 * separate button), [more] the trackers only the Tile and the list carry.
 */
data class LogMenu(val face: List<LogItem>, val more: List<LogItem>)

// Before the Worker sends its catalog, the watch still offers what it always had.
private val FALLBACK = listOf(
    CatalogItem("caffeine", "Café", "mg", 80.0, "face", 0.0),
    CatalogItem("cigarettes", "Cigarro", "u", 1.0, "face", 0.0),
    CatalogItem("alcohol", "Copa", "g", 13.0, "face", 0.0),
)

/** Builds the menus from the cached dial plus the taps the Worker has not shown yet. */
fun logMenu(data: DialData?, taps: List<Tap>): LogMenu {
    val catalog = data?.trackers?.filterNot { it.id.startsWith("mood_") }?.takeIf { it.isNotEmpty() } ?: FALLBACK
    val shown = data?.events?.mapNotNull { it.i }?.toSet() ?: emptySet()
    val day = taps.filter { data == null || tapDate(it) == data.date }
    val items = catalog.map { t ->
        // Unsent logs count at once; an unsent undo takes back a log the dial already shows.
        val delta = day.count { it.tracker == t.id && !it.undo && it.id !in shown } -
            day.count { it.tracker == t.id && it.undo && it.id in shown }
        val today = if (data?.trackers.isNullOrEmpty()) fallbackLogs(data, t.id) * t.value else t.today
        val total = (today + delta * t.value).coerceAtLeast(0.0)
        val water = data?.water?.takeIf { t.id == "water" }
        LogItem(t.id, t.name, display(t, total), water?.let { (total / it.goalMl).toFloat().coerceIn(0f, 1f) })
    }
    return LogMenu(items.filter { i -> catalog.first { it.id == i.id }.surface == "face" },
        items.filter { i -> catalog.first { it.id == i.id }.surface == "tile" })
}

private fun fallbackLogs(data: DialData?, id: String) = data?.events?.count { it.k == kindOf(id) } ?: 0

private fun tapDate(tap: Tap) = java.time.Instant.ofEpochSecond(tap.at).atZone(MADRID).toLocalDate().toString()

/** Logs for the face's counters, litres for water, the dose total for everything else. */
fun display(t: CatalogItem, total: Double): String = when {
    t.unit == "ml" -> if (total >= 1000) String.format(Locale("es"), "%.1f L", total / 1000) else "${total.roundToInt()} ml"
    t.surface == "face" -> (total / t.value).roundToInt().toString()
    else -> "${String.format(Locale("es"), "%.1f", total).removeSuffix(",0")} ${t.unit}"
}
