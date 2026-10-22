package com.deluispablo.healthtracker

/** How a tracker looks on the menu, the Tile and the list: its glyph (null = its initial) on a solid circle. */
data class TrackerStyle(val icon: Int?, val fill: Int, val ink: Int)

private val STYLES = mapOf(
    "caffeine" to TrackerStyle(R.drawable.ic_cafe, 0xfff2c46b.toInt(), 0xff2a1a00.toInt()),
    "cigarettes" to TrackerStyle(R.drawable.ic_cigarro, 0xffdfe3ea.toInt(), 0xff16191f.toInt()),
    "alcohol" to TrackerStyle(R.drawable.ic_alcohol, 0xffb48ae8.toInt(), 0xff1c0b33.toInt()),
    // Placeholders until the shared glyphs and colours for the new trackers land.
    "water" to TrackerStyle(R.drawable.ic_agua, 0xff8fd3f4.toInt(), 0xff0b2a3a.toInt()),
)
private val OTHER = TrackerStyle(null, 0xffc4c9d4.toInt(), 0xff14161c.toInt())

val MOOD_STYLE = TrackerStyle(R.drawable.ic_mood_menu, 0xffb6c2ff.toInt(), 0xff141c45.toInt())
val MORE_STYLE = TrackerStyle(R.drawable.ic_more, 0xff2a2f3a.toInt(), 0xffc4c9d4.toInt())

fun styleOf(id: String): TrackerStyle = STYLES[id] ?: OTHER
