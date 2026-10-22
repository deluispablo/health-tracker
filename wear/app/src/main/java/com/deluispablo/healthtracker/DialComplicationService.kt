package com.deluispablo.healthtracker

import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import java.io.File

/** Serves the dial image that [SyncWorker] cached; never renders or fetches on request. */
class DialComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData {
        val png = File(filesDir, "dial.png")
        val ambient = File(filesDir, "dial-ambient.png")
        if (request.complicationType != ComplicationType.SMALL_IMAGE || !png.exists() || !ambient.exists()) {
            return NoDataComplicationData()
        }
        return dialData(png.readBytes().let { Icon.createWithData(it, 0, it.size) },
            ambient.readBytes().let { Icon.createWithData(it, 0, it.size) })
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? {
        if (type != ComplicationType.SMALL_IMAGE) return null
        val sample = DialData(
            date = "2026-10-22",
            generatedAt = System.currentTimeMillis() / 1000,
            sleep = listOf(Span(-30, 430), Span(900, 940, nap = true)),
            workouts = listOf(Span(1080, 1140)),
            events = listOf(Mark(460, "cafe"), Mark(472, "cafe"), Mark(675, "cigarro"), Mark(1170, "alcohol")),
            hr = List(96) { i -> if (i < 28) 55 else 70 + (i % 12) * 4 },
        )
        return dialData(Icon.createWithBitmap(renderDial(sample, 1440, false)),
            Icon.createWithBitmap(renderDial(sample, 1440, true)))
    }

    private fun dialData(image: Icon, ambient: Icon) = SmallImageComplicationData.Builder(
        SmallImage.Builder(image, SmallImageType.PHOTO).setAmbientImage(ambient).build(),
        PlainComplicationText.Builder(getString(R.string.dial_description)).build(),
    ).build()
}
