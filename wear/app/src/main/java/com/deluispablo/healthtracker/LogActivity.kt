package com.deluispablo.healthtracker

import android.app.Activity
import android.content.Context
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

/**
 * Opened by tapping the centre of the face: syncs now and shows the face's trackers, mood and
 * supplements in a ring around an undo button for the last watch log. One tap logs and closes; mood
 * and supplements swap the ring for their own ring around a back button, and show the chosen name
 * before closing.
 */
class LogActivity : Activity() {
    private lateinit var screen: FrameLayout

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
        showGrid()
    }

    private fun showGrid() {
        screen.removeAllViews()
        val menu = menuNow(this)
        val extra = listOfNotNull(
            Triple(MOOD_STYLE, getString(R.string.log_mood)) { showRing() },
            menu.supplements.takeIf { it.isNotEmpty() }?.let {
                Triple(SUPPLEMENTS_STYLE, getString(R.string.log_supplements)) { showSupplements(it) }
            },
        )
        // Four buttons keep the 2x2 grid; more go round the undo button.
        val n = menu.face.size + extra.size
        val size = when { n <= 4 -> 68; n == 5 -> 60; else -> 56 }
        val spot = { i: Int ->
            if (n <= 4) (if (i % 2 == 0) -46f else 46f) to (if (i < 2) -46f else 46f)
            else (i * 2 * Math.PI / n).let { a -> (68 * sin(a)).toFloat() to (-68 * cos(a)).toFloat() }
        }
        menu.face.forEachIndexed { i, item ->
            val (x, y) = spot(i)
            place(itemButton(item, styleOf(item.id), size) { log(item.id) }, size, x, y)
        }
        extra.forEachIndexed { j, (style, label, open) ->
            val (x, y) = spot(menu.face.size + j)
            place(iconButton(style, 30 * size / 68, label) { open() }, size, x, y)
        }
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
            place(iconButton(TrackerStyle(icon, fill, FACE_INK), 32, "Ánimo: $mood") {
                pick("mood_$mood", mood.replaceFirstChar { it.uppercase() }, fill)
            }, 44, (76 * sin(a)).toFloat(), (-76 * cos(a)).toFloat())
        }
        place(centreButton(R.drawable.ic_back, R.string.log_back) { showGrid() }, 48, 0f, 0f)
    }

    /** Like the mood ring: every supplement in the catalog with today's dose, around a back button. */
    private fun showSupplements(items: List<LogItem>) {
        screen.removeAllViews()
        val size = if (items.size <= 4) 60 else 44
        val r = if (items.size <= 4) 66.0 else 76.0
        items.forEachIndexed { i, item ->
            val a = i * 2 * Math.PI / items.size
            val style = styleOf(item.id)
            place(itemButton(item, style, size) { pick(item.id, item.name, style.fill) }, size,
                (r * sin(a)).toFloat(), (-r * cos(a)).toFloat())
        }
        place(centreButton(R.drawable.ic_back, R.string.log_back) { showGrid() }, 48, 0f, 0f)
    }

    /** Logs at once, then shows the name in the centre so the symbols are learnt, and closes. */
    private fun pick(tracker: String, name: String, color: Int) {
        screen.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val ctx = applicationContext
        thread { logTap(ctx, tracker) }
        for (i in 0 until screen.childCount) screen.getChildAt(i).isEnabled = false
        screen.removeViewAt(screen.childCount - 1)
        place(TextView(this).apply {
            text = name
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (name.length > 10) 11f else 14f)
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

    /**
     * A filled circle with the tracker's bold icon and today's count side by side, or stacked when the
     * value is long (water in litres, doses), with a goal as a ring around a slightly smaller disc.
     */
    private fun itemButton(item: LogItem, style: TrackerStyle, sizeDp: Int, onClick: () -> Unit): View {
        val long = item.today.length > 2
        val content = LinearLayout(this).apply {
            orientation = if (long) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            if (style.icon != null) addView(image(style.icon, style.ink), LinearLayout.LayoutParams(dp(if (long) 18 else 22), dp(if (long) 18 else 22)))
            else addView(TextView(context).apply {
                text = item.name.take(1).uppercase()
                setTextColor(style.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            })
            addView(TextView(context).apply {
                text = item.today
                setTextColor(style.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (long) 11f else 24f * sizeDp / 68)
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setPadding(if (long) 0 else dp(3), 0, 0, 0)
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        val inset = if (item.progress != null) dp(6) else 0
        return FrameLayout(this).apply {
            contentDescription = "Registrar ${item.name}"
            item.progress?.let { addView(GoalRing(context, it, style.fill)) }
            addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply {
                setMargins(inset, inset, inset, inset)
            })
            content.background = oval(style.fill)
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

/** Progress towards a daily goal around the disc, from 12 o'clock clockwise, as on the dashboard. */
private class GoalRing(ctx: Context, private val progress: Float, color: Int) : View(ctx) {
    private val w = 3f * ctx.resources.displayMetrics.density
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = w; this.color = 0xff2a2f3a.toInt() }
    private val done = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = w; this.color = color; strokeCap = Paint.Cap.ROUND }

    override fun onDraw(c: Canvas) {
        val box = RectF(w / 2, w / 2, width - w / 2, height - w / 2)
        c.drawOval(box, track)
        if (progress > 0f) c.drawArc(box, -90f, 360f * progress, false, done)
    }
}
