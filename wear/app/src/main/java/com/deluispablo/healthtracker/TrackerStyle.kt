package com.deluispablo.healthtracker

private const val SUPPLEMENT_FILL = 0xfff59bb8.toInt()
private const val SUPPLEMENT_INK = 0xff3d0b1f.toInt()

/** How a tracker looks on the menu and the dial: its glyph (null = its initial) on a solid circle. */
data class TrackerStyle(val icon: Int?, val fill: Int, val ink: Int)

private val STYLES = mapOf(
    "caffeine" to TrackerStyle(R.drawable.ic_cafe, 0xfff2c46b.toInt(), 0xff2a1a00.toInt()),
    "cigarettes" to TrackerStyle(R.drawable.ic_cigarro, 0xffdfe3ea.toInt(), 0xff16191f.toInt()),
    "alcohol" to TrackerStyle(R.drawable.ic_alcohol, 0xffb48ae8.toInt(), 0xff1c0b33.toInt()),
    // Shared tokens: docs/assets/brand/trackers/tokens.json.
    "water" to TrackerStyle(R.drawable.ic_agua, 0xff38b6ff.toInt(), 0xff03263d.toInt()),
    "melatonin" to TrackerStyle(R.drawable.ic_melatonina, SUPPLEMENT_FILL, SUPPLEMENT_INK),
    "protein" to TrackerStyle(R.drawable.ic_proteina, SUPPLEMENT_FILL, SUPPLEMENT_INK),
    "creatine" to TrackerStyle(R.drawable.ic_creatina, SUPPLEMENT_FILL, SUPPLEMENT_INK),
)
// A supplement added later shows its initial in the supplements' colours.
private val OTHER = TrackerStyle(null, SUPPLEMENT_FILL, SUPPLEMENT_INK)

val MOOD_STYLE = TrackerStyle(R.drawable.ic_mood_menu, 0xffb6c2ff.toInt(), 0xff141c45.toInt())
val SUPPLEMENTS_STYLE = TrackerStyle(R.drawable.ic_melatonina, SUPPLEMENT_FILL, SUPPLEMENT_INK)

fun styleOf(id: String): TrackerStyle = STYLES[id] ?: OTHER
