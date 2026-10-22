plugins {
    alias(libs.plugins.android.application)
}

android {
    enableKotlin = false
    namespace = "com.deluispablo.healthtracker.watchface"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.deluispablo.healthtracker.watchface"
        minSdk = 36
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            // Resource-only APK: keep resources, sign with the debug key for sideloading.
            isMinifyEnabled = true
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
