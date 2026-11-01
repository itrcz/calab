package io.calab.host

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `CalabMediaSession` for the RN host (src/mediaSession.ts, board #141): `set` / `clear` the
 * microphone foreground service for the handshaken document, `onMediaAction` for the
 * notification's leave action. The RN host passes only documents of main-frame messages of the
 * exact app origin (the react-native-webview patch drops the rest natively, ADR-0070 Android).
 */
class CalabMediaSessionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CalabMediaSession")
    Events("onMediaAction")
    OnCreate {
      CalabMediaSession.emit = { document -> sendEvent("onMediaAction", mapOf("document" to document, "action" to "leave")) }
    }
    // JS teardown (reload, React host destroyed): no page is left to own the voice session.
    OnDestroy {
      CalabMediaSession.emit = null
      CalabMediaSession.clear()
    }
    Function("set") { document: String, session: String, language: String ->
      val context = appContext.reactContext
      if (context != null) CalabMediaSession.set(context, document, session, language)
      Unit
    }
    Function("clear") { CalabMediaSession.clear() }
  }
}
