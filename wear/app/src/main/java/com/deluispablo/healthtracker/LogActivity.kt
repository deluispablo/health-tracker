package com.deluispablo.healthtracker

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
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

private val TRACKERS = listOf(
    Triple("caffeine", "Café", R.drawable.ic_cafe),
    Triple("cigarettes", "Cigarro", R.drawable.ic_cigarro),
    Triple("alcohol", "Copa", R.drawable.ic_alcohol),
)

private val MOODS = listOf(
    "genial" to R.drawable.ic_mood_genial, "bien" to R.drawable.ic_mood_bien,
    "tranquilo" to R.drawable.ic_mood_tranquilo, "cansado" to R.drawable.ic_mood_cansado,
    "estresado" to R.drawable.ic_mood_estresado, "ansioso" to R.drawable.ic_mood_ansioso,
    "triste" to R.drawable.ic_mood_triste, "enfadado" to R.drawable.ic_mood_enfadado,
)

/**
 * Opened by tapping the centre of the face: syncs now and offers coffee, cigarette, drink and mood.
 * One tap logs and closes; mood first swaps the list for the 8 moods.
 */
class LogActivity : Activity() {
    private lateinit var list: LinearLayout

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
        list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // Round screen: generous top and bottom room so the first and last rows clear the bezel.
            setPadding(dp(30), dp(40), dp(30), dp(48))
        }
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            setBackgroundColor(Color.BLACK)
            addView(list)
        }
        setContentView(scroll)
        scroll.requestFocus()  // the crown scrolls the focused view
        showMenu()
    }

    private fun showMenu() {
        list.removeAllViews()
        val today = todayWithTaps(this)
        for ((tracker, name, icon) in TRACKERS) {
            val count = today?.events?.count { it.k == kindOf(tracker) } ?: 0
            add("$name · $count", icon) { log(tracker) }
        }
        add("Ánimo", R.drawable.ic_mood_bien) {
            list.removeAllViews()
            for ((mood, icon) in MOODS) add(mood.replaceFirstChar { it.uppercase() }, icon) { log("mood_$mood") }
            (list.parent as ScrollView).scrollTo(0, 0)
        }
    }

    private fun log(tracker: String) {
        list.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val ctx = applicationContext
        thread { logTap(ctx, tracker) }
        finish()
    }

    private fun add(label: String, icon: Int, onClick: () -> Unit) = list.addView(TextView(this).apply {
        text = label
        setTextColor(0xffe7e9f0.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), 0, dp(14), 0)
        compoundDrawablePadding = dp(10)
        setCompoundDrawablesRelativeWithIntrinsicBounds(getDrawable(icon), null, null, null)
        background = GradientDrawable().apply { cornerRadius = dp(26).toFloat(); setColor(0xff1c2233.toInt()) }
        setOnClickListener { onClick() }
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { bottomMargin = dp(4) })

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
