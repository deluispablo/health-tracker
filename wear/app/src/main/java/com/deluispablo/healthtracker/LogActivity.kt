package com.deluispablo.healthtracker

import android.app.Activity
import android.graphics.Color
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

private val TRACKERS = listOf(
    Triple("caffeine", R.string.log_coffee, R.drawable.ic_cafe),
    Triple("cigarettes", R.string.log_cigarette, R.drawable.ic_cigarro),
    Triple("alcohol", R.string.log_drink, R.drawable.ic_alcohol),
)

private val MOODS = listOf(
    "genial" to R.drawable.ic_mood_genial, "bien" to R.drawable.ic_mood_bien,
    "tranquilo" to R.drawable.ic_mood_tranquilo, "cansado" to R.drawable.ic_mood_cansado,
    "estresado" to R.drawable.ic_mood_estresado, "ansioso" to R.drawable.ic_mood_ansioso,
    "triste" to R.drawable.ic_mood_triste, "enfadado" to R.drawable.ic_mood_enfadado,
)

/**
 * Opened by tapping the centre of the face: syncs now and shows a 2x2 grid (coffee, cigarette,
 * drink, mood). One tap logs and closes; mood swaps the grid for a ring of the 8 moods.
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
        val today = todayWithTaps(this)
        TRACKERS.forEachIndexed { i, (tracker, label, icon) ->
            val count = today?.events?.count { it.k == kindOf(tracker) } ?: 0
            place(button(icon, 26, count.toString(), getString(label)) { log(tracker) }, 72, gridX(i), gridY(i))
        }
        place(button(R.drawable.ic_mood_bien, 30, null, getString(R.string.log_mood)) { showRing() }, 72, gridX(3), gridY(3))
    }

    private fun showRing() {
        screen.removeAllViews()
        MOODS.forEachIndexed { i, (mood, icon) ->
            val a = i * Math.PI / 4
            place(button(icon, 26, null, "Ánimo: $mood") { log("mood_$mood") }, 44,
                (76 * sin(a)).toFloat(), (-76 * cos(a)).toFloat())
        }
    }

    private fun gridX(i: Int) = if (i % 2 == 0) -40f else 40f
    private fun gridY(i: Int) = if (i < 2) -40f else 40f

    private fun log(tracker: String) {
        screen.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val ctx = applicationContext
        thread { logTap(ctx, tracker) }
        finish()
    }

    /** A round button with an icon and an optional count under it. */
    private fun button(icon: Int, iconDp: Int, count: String?, description: String, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xff1c2233.toInt()) }
            contentDescription = description
            addView(ImageView(context).apply { setImageResource(icon) }, LinearLayout.LayoutParams(dp(iconDp), dp(iconDp)))
            if (count != null) addView(TextView(context).apply {
                text = count
                setTextColor(0xffe7e9f0.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                gravity = Gravity.CENTER
            })
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
