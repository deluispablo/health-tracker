import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

val watchToken = localProps.getProperty("watchToken", "")
val watchBaseUrl = localProps.getProperty("watchBaseUrl", "https://health.deluispablo.com")
require(watchToken.isNotBlank()) { "Set a non-blank watchToken in wear/local.properties" }
require(watchBaseUrl.startsWith("https://")) { "watchBaseUrl in wear/local.properties must start with https://" }

android {
    namespace = "com.deluispablo.healthtracker"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.deluispablo.healthtracker"
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "WATCH_BASE_URL", "\"${watchBaseUrl}\"")
        buildConfigField("String", "WATCH_TOKEN", "\"${watchToken}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.wear.watchface.complications.data.source.ktx)
    testImplementation(libs.junit)
    // Android's org.json is a stub on the JVM; tests need the real one.
    testImplementation(libs.org.json)
}
