package com.deluispablo.healthtracker

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import kotlin.concurrent.thread
import kotlin.math.cos
import kotlin.math.sin

private const val FACE_INK = 0xff14161c.toInt()

/** Clockwise from the top, by energy (up) and pleasantness (right), in the Mood Meter's colours. */
private val MOODS = listOf(
    Triple("estresado", R.drawable.ic_mood_estresado, 0xfff08a5d.toInt()),
    Triple("genial", R.drawable.ic_mood_genial, 0xfff2d06b.toInt()),
    Triple("bien", R.drawable.ic_mood_bien, 0xffc9dc6a.toInt()),
    Triple("tranquilo", R.drawable.ic_mood_tranquilo, 0xff6cc9a0.toInt()),
    Triple("cansado", R.drawable.ic_mood_cansado, 0xff7fa7e0.toInt()),
    Triple("triste", R.drawable.ic_mood_triste, 0xff6f8fe8.toInt()),
    Triple("ansioso", R.drawable.ic_mood_ansioso, 0xffe86f7a.toInt()),
    Triple("enfadado", R.drawable.ic_mood_enfadado, 0xffee5f5f.toInt()),
)

/** Which screen the menu opens on; the Tile opens the ring or the list directly. */
const val EXTRA_SCREEN = "screen"
const val SCREEN_RING = "ring"
const val SCREEN_MORE = "more"

fun logIntent(ctx: Context, screen: String? = null): Intent =
    Intent(ctx, LogActivity::class.java).apply { screen?.let { putExtra(EXTRA_SCREEN, it) } }

/**
 * Opened by tapping the centre of the face: syncs now and shows the face's trackers and mood in a ring
 * around an undo button for the last watch log. One tap logs and closes; mood swaps the ring for the 8
 * moods around a back button, and shows the chosen mood's name before closing. The Tile also opens the
 * mood ring and the full list of trackers here.
 */
class LogActivity : Activity() {
    private lateinit var screen: FrameLayout
    private var direct = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The hourly job can be deferred while the screen is off.
        WorkManager.getInstance(this).enqueueUniqueWork(
            "dial-sync-now",
            ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            ).setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build(),
        )
        screen = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(screen)
        when (intent.getStringExtra(EXTRA_SCREEN)) {
            SCREEN_RING -> { direct = true; showRing() }
            SCREEN_MORE -> { direct = true; showList(menuNow(this).let { tileGrid(it).more }) }
            else -> showGrid()
        }
    }

    private fun showGrid() {
        screen.removeAllViews()
        val menu = menuNow(this)
        // Four buttons keep the 2x2 grid; more go round the undo button.
        val n = menu.face.size + 1
        val size = if (n <= 4) 68 else 60
        val spot = { i: Int ->
            if (n <= 4) (if (i % 2 == 0) -46f else 46f) to (if (i < 2) -46f else 46f)
            else (i * 2 * Math.PI / n).let { a -> (66 * sin(a)).toFloat() to (-66 * cos(a)).toFloat() }
        }
        menu.face.forEachIndexed { i, item ->
            val (x, y) = spot(i)
            place(itemButton(item, styleOf(item.id), size) { log(item.id) }, size, x, y)
        }
        val (mx, my) = spot(menu.face.size)
        place(iconButton(MOOD_STYLE, 32 * size / 68, getString(R.string.log_mood)) { showRing() }, size, mx, my)
        if (lastTap(this) != null) place(centreButton(R.drawable.ic_undo, R.string.log_undo) {
            screen.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            val ctx = applicationContext
            thread { undoLast(ctx) }
            finish()
        }, 48, 0f, 0f)
    }

    private fun showRing() {
        screen.removeAllViews()
        MOODS.forEachIndexed { i, (mood, icon, fill) ->
            val a = i * Math.PI / 4
            place(iconButton(TrackerStyle(icon, fill, FACE_INK), 32, "Ánimo: $mood") { pickMood(mood, fill) }, 44,
                (76 * sin(a)).toFloat(), (-76 * cos(a)).toFloat())
        }
        place(centreButton(R.drawable.ic_back, R.string.log_back) { if (direct) finish() else showGrid() }, 48, 0f, 0f)
    }

    /** Every tracker the Tile has no room for, one row each; the crown scrolls. */
    private fun showList(items: List<LogItem>) {
        screen.removeAllViews()
        val rows = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(30), dp(40), dp(34), dp(48))
        }
        for (item in items) {
            val style = styleOf(item.id)
            rows.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                contentDescription = "Registrar ${item.name}"
                addView(glyphCircle(style, item.name, 40, 22), LinearLayout.LayoutParams(dp(40), dp(40)))
                addView(TextView(context).apply {
                    text = item.name
                    setTextColor(0xffe7e9f0.toInt())
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                    setPadding(dp(10), 0, dp(6), 0)
                }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                addView(TextView(context).apply {
                    text = item.today
                    setTextColor(0xffa2a8b8.toInt())
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                })
                setOnClickListener { log(item.id) }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)))
        }
        val scroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; addView(rows) }
        screen.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        scroll.requestFocus()
    }

    /** Logs at once, then shows the name in the centre so the faces are learnt, and closes. */
    private fun pickMood(mood: String, color: Int) {
        screen.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val ctx = applicationContext
        thread { logTap(ctx, "mood_$mood") }
        for (i in 0 until screen.childCount) screen.getChildAt(i).isEnabled = false
        screen.removeViewAt(screen.childCount - 1)
        place(TextView(this).apply {
            text = mood.replaceFirstChar { it.uppercase() }
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            background = oval(0xff14171e.toInt())
        }, 64, 0f, 0f)
        screen.postDelayed({ finish() }, 600)
    }

    private fun log(tracker: String) {
        screen.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val ctx = applicationContext
        thread { logTap(ctx, tracker) }
        finish()
    }

    private fun oval(color: Int, stroke: Int? = null) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
        if (stroke != null) setStroke(dp(1.4f), stroke)
    }

    private fun image(icon: Int, ink: Int) = ImageView(this).apply {
        setImageResource(icon)
        setColorFilter(ink)
    }

    /** The tracker's glyph on its circle, or its initial while it has no glyph. */
    private fun glyphCircle(style: TrackerStyle, name: String, sizeDp: Int, iconDp: Int): View = FrameLayout(this).apply {
        background = oval(style.fill)
        if (style.icon != null) addView(image(style.icon, style.ink), FrameLayout.LayoutParams(dp(iconDp), dp(iconDp), Gravity.CENTER))
        else addView(TextView(context).apply {
            text = name.take(1).uppercase()
            setTextColor(style.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeDp * 0.4f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
        }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    /**
     * A filled circle with the tracker's bold icon and today's count side by side, or stacked when the
     * value is long (water in ml or litres), with the goal as a ring inside the edge.
     */
    private fun itemButton(item: LogItem, style: TrackerStyle, sizeDp: Int, onClick: () -> Unit): View {
        val long = item.today.length > 2
        val content = LinearLayout(this).apply {
            orientation = if (long) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            if (style.icon != null) addView(image(style.icon, style.ink), LinearLayout.LayoutParams(dp(if (long) 18 else 22), dp(if (long) 18 else 22)))
            addView(TextView(context).apply {
                text = item.today
                setTextColor(style.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (long) 11f else 24f * sizeDp / 68)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setPadding(if (long) 0 else dp(3), 0, 0, 0)
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        return FrameLayout(this).apply {
            background = oval(style.fill)
            contentDescription = "Registrar ${item.name}"
            addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            item.progress?.let { addView(GoalRing(context, it, style.ink)) }
            setOnClickListener { onClick() }
        }
    }

    private fun iconButton(style: TrackerStyle, iconDp: Int, description: String, onClick: () -> Unit): View =
        FrameLayout(this).apply {
            background = oval(style.fill)
            contentDescription = description
            addView(image(style.icon!!, style.ink), FrameLayout.LayoutParams(dp(iconDp), dp(iconDp), Gravity.CENTER))
            setOnClickListener { onClick() }
        }

    private fun centreButton(icon: Int, label: Int, onClick: () -> Unit): View = FrameLayout(this).apply {
        background = oval(0xff14171e.toInt(), 0xff3a3f4c.toInt())
        contentDescription = getString(label)
        addView(image(icon, 0xffc4c9d4.toInt()), FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
        setOnClickListener { onClick() }
    }

    /** Centres [view] of [sizeDp] at ([dx], [dy]) dp from the middle of the screen. */
    private fun place(view: View, sizeDp: Int, dx: Float, dy: Float) =
        screen.addView(view, FrameLayout.LayoutParams(dp(sizeDp), dp(sizeDp), Gravity.CENTER).apply {
            leftMargin = dp(dx)
            topMargin = dp(dy)
        })

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun dp(v: Float) = (v * resources.displayMetrics.density).toInt()
}

/** Progress towards a daily goal, drawn just inside the button's edge from the top, clockwise. */
private class GoalRing(ctx: Context, private val progress: Float, ink: Int) : View(ctx) {
    private val w = 2.5f * ctx.resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = w; color = ink; alpha = 50 }
    private val done = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = w; color = ink; strokeCap = Paint.Cap.ROUND }

    override fun onDraw(c: Canvas) {
        val box = RectF(w * 1.5f, w * 1.5f, width - w * 1.5f, height - w * 1.5f)
        c.drawOval(box, track)
        if (progress > 0f) c.drawArc(box, -90f, 360f * progress, false, done)
    }
}
