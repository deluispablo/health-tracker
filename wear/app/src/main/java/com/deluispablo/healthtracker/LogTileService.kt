package com.deluispablo.healthtracker

import android.content.Context
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders as L
import androidx.wear.protolayout.ModifiersBuilders as M
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import kotlin.concurrent.thread

private const val RES_VERSION = "1"
private const val UNDO = "undo"
private const val BUTTON = 50f
private const val GAP = 6f

/** Glyphs the Tile can show, by resource name. */
private val ICONS = listOf(
    R.drawable.ic_cafe, R.drawable.ic_cigarro, R.drawable.ic_alcohol, R.drawable.ic_agua,
    R.drawable.ic_mood_menu, R.drawable.ic_more, R.drawable.ic_undo,
)

/** Asks the system to redraw the Tile, after a tap or a sync. */
fun updateTile(ctx: Context) = TileService.getUpdater(ctx).requestUpdate(LogTileService::class.java)

/**
 * A Tile that logs with one tap: a 2x3 grid of the face's trackers with today's values, the mood ring
 * and «more» (both open the menu), and an undo button while the last watch log can still be undone.
 * It shares the face's offline queue and undo, so either surface can take back the other's log.
 */
class LogTileService : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> =
        CallbackToFutureAdapter.getFuture { done ->
            thread {
                runCatching {
                    handleClick(requestParams.currentState.lastClickableId)
                    done.set(tile())
                }.onFailure { done.setException(it) }
            }
            "tile"
        }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        CallbackToFutureAdapter.getFuture { done ->
            done.set(ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).apply {
                for (icon in ICONS) addIdToImageMapping(resources.getResourceEntryName(icon), ResourceBuilders.ImageResource.Builder()
                    .setAndroidResourceByResId(ResourceBuilders.AndroidImageResourceByResId.Builder().setResourceId(icon).build())
                    .build())
            }.build())
            "resources"
        }

    /**
     * Clickable ids carry the render they belong to, and the last handled one is remembered: the
     * last clicked id can come back with later refreshes, and must not log twice.
     */
    private fun handleClick(id: String) {
        if (id.isEmpty()) return
        val handled = File(filesDir, "tile-click")
        if (handled.exists() && handled.readText() == id) return
        handled.writeText(id)
        when (val target = id.substringBefore('#')) {
            UNDO -> undoLast(this)
            else -> logTap(this, target)
        }
    }

    private fun tile(): TileBuilders.Tile {
        val render = System.nanoTime().toString()
        val grid = tileGrid(menuNow(this))
        val last = lastTap(this)
        val cells = grid.trackers.map { item ->
            val style = styleOf(item.id)
            cell(style, item.today, item.name, load("${item.id}#$render"), item.name)
        } + listOf(
            cell(MOOD_STYLE, null, "", launch(SCREEN_RING), getString(R.string.log_mood)),
            cell(MORE_STYLE, null, "", launch(SCREEN_MORE), getString(R.string.log_more)),
        )
        val column = L.Column.Builder().setHorizontalAlignment(L.HORIZONTAL_ALIGN_CENTER)
        cells.chunked(3).forEachIndexed { i, row ->
            if (i > 0) column.addContent(L.Spacer.Builder().setHeight(dp(GAP)).build())
            column.addContent(L.Row.Builder().apply {
                row.forEachIndexed { j, c ->
                    if (j > 0) addContent(L.Spacer.Builder().setWidth(dp(GAP)).build())
                    addContent(c)
                }
            }.build())
        }
        // The undo slot is always reserved, so the grid never jumps.
        column.addContent(L.Spacer.Builder().setHeight(dp(10f)).build())
        column.addContent(if (last != null) undoButton(load("$UNDO#$render")) else L.Spacer.Builder().setHeight(dp(28f)).build())
        val root = L.Box.Builder().setWidth(expand()).setHeight(expand())
            .setHorizontalAlignment(L.HORIZONTAL_ALIGN_CENTER).setVerticalAlignment(L.VERTICAL_ALIGN_CENTER)
            .addContent(column.build()).build()
        // Redraw when the undo window closes; syncs and taps request their own updates.
        val undoLeftMs = last?.let { (UNDO_WINDOW_SEC - (System.currentTimeMillis() / 1000 - it.at)) * 1000 + 1000 } ?: 0
        return TileBuilders.Tile.Builder().setResourcesVersion(RES_VERSION)
            .setFreshnessIntervalMillis(undoLeftMs.coerceAtLeast(0))
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root)).build()
    }

    private fun load(id: String) = M.Clickable.Builder().setId(id).setOnClick(ActionBuilders.LoadAction.Builder().build()).build()

    private fun launch(screen: String) = M.Clickable.Builder().setId("open-$screen").setOnClick(
        ActionBuilders.LaunchAction.Builder().setAndroidActivity(
            ActionBuilders.AndroidActivity.Builder().setPackageName(packageName).setClassName(LogActivity::class.java.name)
                .addKeyToExtraMapping(EXTRA_SCREEN, ActionBuilders.AndroidStringExtra.Builder().setValue(screen).build())
                .build(),
        ).build(),
    ).build()

    /** One round button: the glyph (or the initial) over today's value, in the tracker's colours. */
    private fun cell(style: TrackerStyle, value: String?, name: String, click: M.Clickable, description: String): L.LayoutElement {
        val inner = L.Column.Builder().setHorizontalAlignment(L.HORIZONTAL_ALIGN_CENTER)
        if (style.icon != null) inner.addContent(L.Image.Builder().setResourceId(resources.getResourceEntryName(style.icon))
            .setWidth(dp(if (value == null) 24f else 18f)).setHeight(dp(if (value == null) 24f else 18f))
            .setColorFilter(L.ColorFilter.Builder().setTint(argb(style.ink)).build()).build())
        else inner.addContent(text(name.take(1).uppercase(), 18f, style.ink))
        if (value != null) inner.addContent(text(value, if (value.length > 2) 11f else 14f, style.ink))
        return L.Box.Builder().setWidth(dp(BUTTON)).setHeight(dp(BUTTON))
            .setHorizontalAlignment(L.HORIZONTAL_ALIGN_CENTER).setVerticalAlignment(L.VERTICAL_ALIGN_CENTER)
            .setModifiers(M.Modifiers.Builder()
                .setBackground(M.Background.Builder().setColor(argb(style.fill)).setCorner(M.Corner.Builder().setRadius(dp(BUTTON / 2)).build()).build())
                .setClickable(click)
                .setSemantics(M.Semantics.Builder().setContentDescription(description).build())
                .build())
            .addContent(inner.build()).build()
    }

    private fun undoButton(click: M.Clickable): L.LayoutElement = L.Box.Builder().setWidth(dp(56f)).setHeight(dp(28f))
        .setHorizontalAlignment(L.HORIZONTAL_ALIGN_CENTER).setVerticalAlignment(L.VERTICAL_ALIGN_CENTER)
        .setModifiers(M.Modifiers.Builder()
            .setBackground(M.Background.Builder().setColor(argb(0xff14171e.toInt())).setCorner(M.Corner.Builder().setRadius(dp(14f)).build()).build())
            .setBorder(M.Border.Builder().setWidth(dp(1.4f)).setColor(argb(0xff3a3f4c.toInt())).build())
            .setClickable(click)
            .setSemantics(M.Semantics.Builder().setContentDescription(getString(R.string.log_undo)).build())
            .build())
        .addContent(L.Image.Builder().setResourceId(resources.getResourceEntryName(R.drawable.ic_undo)).setWidth(dp(16f)).setHeight(dp(16f))
            .setColorFilter(L.ColorFilter.Builder().setTint(argb(0xffc4c9d4.toInt())).build()).build())
        .build()

    private fun text(value: String, size: Float, color: Int) = L.Text.Builder().setText(value)
        .setFontStyle(L.FontStyle.Builder().setSize(sp(size)).setWeight(L.FONT_WEIGHT_BOLD).setColor(argb(color)).build())
        .build()
}
