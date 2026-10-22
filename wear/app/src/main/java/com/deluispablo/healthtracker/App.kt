package com.deluispablo.healthtracker

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val wm = WorkManager.getInstance(this)
        wm.enqueueUniquePeriodicWork(
            "dial-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(60, TimeUnit.MINUTES).setConstraints(online).build(),
        )
        wm.enqueueUniquePeriodicWork(
            "dial-redraw",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RedrawWorker>(15, TimeUnit.MINUTES).build(),
        )
    }
}
