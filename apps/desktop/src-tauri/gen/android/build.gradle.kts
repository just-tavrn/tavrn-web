// SPDX-License-Identifier: Apache-2.0
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
        // The LiveKit SDK's audio routing helper (com.github.davidliu:audioswitch, Apache-2.0, pinned to a commit by the
        // SDK) is published on JitPack only: that repository serves this one group and nothing else.
        maven("https://jitpack.io") {
            content { includeGroup("com.github.davidliu") }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}

