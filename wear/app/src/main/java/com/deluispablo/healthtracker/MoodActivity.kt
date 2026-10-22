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

private val MOODS = listOf(
    "genial" to R.drawable.ic_mood_genial, "bien" to R.drawable.ic_mood_bien,
    "tranquilo" to R.drawable.ic_mood_tranquilo, "cansado" to R.drawable.ic_mood_cansado,
    "estresado" to R.drawable.ic_mood_estresado, "ansioso" to R.drawable.ic_mood_ansioso,
    "triste" to R.drawable.ic_mood_triste, "enfadado" to R.drawable.ic_mood_enfadado,
)

/** Opened by tapping the dial: syncs now and offers the 8 moods; one tap logs and closes. */
class MoodActivity : Activity() {
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
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // Round screen: generous top and bottom room so the first and last rows clear the bezel.
            setPadding(dp(30), dp(40), dp(30), dp(48))
        }
        for ((mood, icon) in MOODS) list.addView(row(mood, icon), LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(52),
        ).apply { bottomMargin = dp(4) })
        val scroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            setBackgroundColor(Color.BLACK)
            addView(list)
        }
        setContentView(scroll)
        scroll.requestFocus()  // the crown scrolls the focused view
    }

    private fun row(mood: String, icon: Int) = TextView(this).apply {
        text = mood.replaceFirstChar { it.uppercase() }
        setTextColor(0xffe7e9f0.toInt())
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), 0, dp(14), 0)
        compoundDrawablePadding = dp(10)
        setCompoundDrawablesRelativeWithIntrinsicBounds(getDrawable(icon), null, null, null)
        background = GradientDrawable().apply { cornerRadius = dp(26).toFloat(); setColor(0xff1c2233.toInt()) }
        contentDescription = "Ánimo: $mood"
        setOnClickListener {
            performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            val ctx = applicationContext
            thread { logTap(ctx, "mood_$mood") }
            finish()
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
