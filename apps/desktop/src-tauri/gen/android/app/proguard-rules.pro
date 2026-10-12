# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Screen sharing (ScreenShare.kt): a new epoch's key becomes the sending key of the published screen tracks through
# the frame cryptors the LiveKit SDK keeps (it sets a track's key index only when publishing).
-keepclassmembers class io.livekit.android.e2ee.E2EEManager {
    private java.util.Map frameCryptors;
}
