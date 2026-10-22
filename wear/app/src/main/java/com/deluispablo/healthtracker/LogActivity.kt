package com.deluispablo.healthtracker

import android.app.Activity
import android.graphics.Color
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

private class Choice(val tracker: String, val label: Int, val icon: Int, val fill: Int, val ink: Int)

private val TRACKERS = listOf(
    Choice("caffeine", R.string.log_coffee, R.drawable.ic_cafe, 0xfff2c46b.toInt(), 0xff2a1a00.toInt()),
    Choice("cigarettes", R.string.log_cigarette, R.drawable.ic_cigarro, 0xffdfe3ea.toInt(), 0xff16191f.toInt()),
    Choice("alcohol", R.string.log_drink, R.drawable.ic_alcohol, 0xffd3b6f7.toInt(), 0xff22103a.toInt()),
)

private const val MOOD_FILL = 0xffb6c2ff.toInt()
private const val MOOD_INK = 0xff141c45.toInt()
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
 * Opened by tapping the centre of the face: syncs now and shows a 2x2 grid (coffee, cigarette,
 * drink, mood) around an undo button for the last watch log. One tap logs and closes; mood swaps the
 * grid for a ring of the 8 moods around a back button, and shows the chosen mood's name before closing.
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
        val today = todayWithTaps(this)
        TRACKERS.forEachIndexed { i, c ->
            val count = today?.events?.count { it.k == kindOf(c.tracker) } ?: 0
            place(countButton(c, count) { log(c.tracker) }, 68, gridX(i), gridY(i))
        }
        place(iconButton(R.drawable.ic_mood_menu, 32, MOOD_FILL, MOOD_INK, getString(R.string.log_mood)) { showRing() },
            68, gridX(3), gridY(3))
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
            place(iconButton(icon, 32, fill, FACE_INK, "Ánimo: $mood") { pickMood(mood, fill) }, 44,
                (76 * sin(a)).toFloat(), (-76 * cos(a)).toFloat())
        }
        place(centreButton(R.drawable.ic_back, R.string.log_back) { showGrid() }, 48, 0f, 0f)
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

    // Spread enough to leave the centre free for undo.
    private fun gridX(i: Int) = if (i % 2 == 0) -46f else 46f
    private fun gridY(i: Int) = if (i < 2) -46f else 46f

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

    /** A filled circle with the tracker's bold icon and today's count side by side. */
    private fun countButton(c: Choice, count: Int, onClick: () -> Unit): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        background = oval(c.fill)
        contentDescription = getString(c.label)
        addView(image(c.icon, c.ink), LinearLayout.LayoutParams(dp(22), dp(22)))
        addView(TextView(context).apply {
            text = count.toString()
            setTextColor(c.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setPadding(dp(3), 0, 0, 0)
        })
        setOnClickListener { onClick() }
    }

    private fun iconButton(icon: Int, iconDp: Int, fill: Int, ink: Int, description: String, onClick: () -> Unit): View =
        FrameLayout(this).apply {
            background = oval(fill)
            contentDescription = description
            addView(image(icon, ink), FrameLayout.LayoutParams(dp(iconDp), dp(iconDp), Gravity.CENTER))
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
