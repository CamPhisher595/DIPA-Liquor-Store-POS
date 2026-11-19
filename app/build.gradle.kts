import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val firebaseConfigText = rootProject.file("web-assets/firebase-config.json").readText()
val firebaseAuthDomain = Regex("\"authDomain\"\\s*:\\s*\"([^\"]+)\"")
    .find(firebaseConfigText)
    ?.groupValues
    ?.get(1)
    ?: throw GradleException("Firebase authDomain is missing from web-assets/firebase-config.json.")
val signingPropertiesFile = rootProject.file("signing.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.dealer.pos"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dealer.pos"
        minSdk = 23
        targetSdk = 35
        versionCode = 7
        versionName = "2.7"
        manifestPlaceholders["firebaseAuthDomain"] = firebaseAuthDomain
    }

    sourceSets {
        getByName("main") {
            assets.setSrcDirs(listOf(rootProject.file("web-assets")))
        }
    }

    signingConfigs {
        create("release") {
            val storePath = signingProperties.getProperty("storeFile")
            if (!storePath.isNullOrBlank()) {
                storeFile = rootProject.file(storePath)
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.13.0")
}
