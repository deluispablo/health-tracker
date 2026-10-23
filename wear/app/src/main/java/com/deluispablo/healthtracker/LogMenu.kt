package com.deluispablo.healthtracker

import java.util.Locale
import kotlin.math.roundToInt

/** One loggable tracker as the menus show it: [today] is ready to print, [progress] only for goals. */
data class LogItem(val id: String, val name: String, val today: String, val progress: Float? = null)

/**
 * What the centre menu offers: [face] in catalog order (moods are one separate button), and the
 * [supplements] its Suplementos button opens, which is every catalog row outside the face.
 */
data class LogMenu(val face: List<LogItem>, val supplements: List<LogItem>)

// Before the Worker sends its catalog, the watch still offers what it always had.
private val FALLBACK = listOf(
    CatalogItem("caffeine", "Café", "mg", 80.0, "face", 0.0),
    CatalogItem("cigarettes", "Cigarro", "u", 1.0, "face", 0.0),
    CatalogItem("alcohol", "Copa", "g", 13.0, "face", 0.0),
)

/** Builds the menus from the cached dial plus the taps the Worker has not shown yet. */
fun logMenu(data: DialData?, taps: List<Tap>): LogMenu {
    // Only a Worker without the catalog gets the built-in trackers; an empty catalog means none.
    val catalog = data?.trackers?.filterNot { it.id.startsWith("mood_") } ?: FALLBACK
    val shown = data?.events?.mapNotNull { it.i }?.toSet() ?: emptySet()
    val date = data?.date ?: java.time.LocalDate.now(USER_ZONE).toString()
    val day = taps.filter { tapDate(it) == date }
    val items = catalog.map { t ->
        // Unsent logs count at once; an unsent undo takes back only a log the dial shows under its key.
        val delta = day.count { it.tracker == t.id && !it.undo && it.id !in shown } -
            day.count { it.tracker == t.id && it.undo && it.id in shown }
        val text = when {
            t.unit == "ml" -> litres((t.today + delta * t.value).coerceAtLeast(0.0))
            // The face counts drinks and coffees, whatever their dose; cigarettes count their units.
            t.surface == "face" -> {
                val logs = if (t.unit == "u" && catalog !== FALLBACK) t.today else data?.events?.count { it.k == kindOf(t.id) }?.toDouble() ?: 0.0
                (logs + delta).coerceAtLeast(0.0).roundToInt().toString()
            }
            else -> dose((t.today + delta * t.value).coerceAtLeast(0.0), t.unit)
        }
        val water = data?.water?.takeIf { t.id == "water" }
        val progress = water?.let { ((it.ml + delta * t.value) / it.goalMl).toFloat().coerceIn(0f, 1f) }
        t.surface to LogItem(t.id, t.name, text, progress)
    }
    val (face, supplements) = items.partition { it.first == "face" }
    return LogMenu(face.map { it.second }, supplements.map { it.second })
}

private fun tapDate(tap: Tap) = java.time.Instant.ofEpochSecond(tap.at).atZone(USER_ZONE).toLocalDate().toString()

private fun litres(ml: Double) = if (ml >= 1000) String.format(Locale("es"), "%.1f L", ml / 1000) else "${ml.roundToInt()} ml"

private fun dose(total: Double, unit: String) = "${String.format(Locale("es"), "%.1f", total).removeSuffix(",0")} $unit"
