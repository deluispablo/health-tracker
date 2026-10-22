package com.deluispablo.healthtracker

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import kotlin.concurrent.thread

/** One edge button: today's count for [tracker]; a tap logs one more without opening anything. */
abstract class TrackerComplicationService(private val tracker: String, private val icon: Int, private val label: Int) :
    SuspendingComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData {
        if (request.complicationType != ComplicationType.SHORT_TEXT) return NoDataComplicationData()
        val count = todayWithTaps(this)?.events?.count { it.k == kindOf(tracker) } ?: 0
        return data(count.toString())
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type == ComplicationType.SHORT_TEXT) data("2") else null

    private fun data(text: String) = ShortTextComplicationData.Builder(
        PlainComplicationText.Builder(text).build(),
        PlainComplicationText.Builder(getString(label)).build(),
    ).setMonochromaticImage(MonochromaticImage.Builder(Icon.createWithResource(this, icon)).build())
        .setTapAction(
            PendingIntent.getBroadcast(
                this, tracker.hashCode(),
                Intent(this, LogReceiver::class.java).putExtra(LogReceiver.TRACKER, tracker),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        ).build()
}

class CoffeeComplicationService : TrackerComplicationService("caffeine", R.drawable.ic_cafe, R.string.log_coffee)
class CigaretteComplicationService : TrackerComplicationService("cigarettes", R.drawable.ic_cigarro, R.string.log_cigarette)
class AlcoholComplicationService : TrackerComplicationService("alcohol", R.drawable.ic_alcohol, R.string.log_alcohol)

val TRACKER_SERVICES = listOf(
    CoffeeComplicationService::class.java, CigaretteComplicationService::class.java, AlcoholComplicationService::class.java,
)

class LogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val tracker = intent.getStringExtra(TRACKER) ?: return
        val ctx = context.applicationContext
        // Hardware-feedback usage is the one tap vibration Android still plays for a background app.
        ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator?.vibrate(
            VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK),
            VibrationAttributes.createForUsage(VibrationAttributes.USAGE_HARDWARE_FEEDBACK),
        )
        val pending = goAsync()
        thread {
            try { logTap(ctx, tracker) } finally { pending.finish() }
        }
    }

    companion object { const val TRACKER = "tracker" }
}
