package io.calab.host

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * A `microphone` foreground service while the shared web client is in a voice room or a call
 * (board #141), so Android does not take the microphone away when the app leaves the foreground.
 * The web says only room / call / none (`mediaSession` host message, document-scoped by the RN
 * host); the service holds no media of its own: capture and playback stay in the WebView, and
 * remote audio stays on its `<audio>` path (docs/02 echo rules).
 *
 * Start rules: only while the app is in the foreground (Android 12+ forbids a background start)
 * and RECORD_AUDIO is granted (Android 14+ throws for a microphone service without it). No
 * `phoneCall` type: there is no Telecom/ConnectionService (ADR-0071 Android, v2). Everything runs
 * on the main looper; the service's own callbacks do too.
 */
internal object CalabMediaSession {
  data class Spec(val document: String, val session: String, val language: String)

  private val main = Handler(Looper.getMainLooper())
  private var wanted: Spec? = null
  private var pending = false
  private var service: CalabMediaSessionService? = null

  /** Set by the module while React runs: the notification's «Выйти»/«Завершить» for `document`. */
  var emit: ((String) -> Unit)? = null

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  fun set(context: Context, document: String, session: String, language: String) = onMain {
    if (!CalabPushPayload.uuid(document) || (session != "room" && session != "call")) return@onMain
    val spec = Spec(document, session, if (language == "ru") "ru" else "en")
    wanted = spec
    service?.let { return@onMain it.render(spec) }
    if (pending) return@onMain
    val app = context.applicationContext
    // A background start fails on Android 12+ anyway; a microphone service also needs the grant.
    if (!CalabPush.foreground() || ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      wanted = null
      return@onMain
    }
    pending = true
    try {
      ContextCompat.startForegroundService(app, Intent(app, CalabMediaSessionService::class.java))
    } catch (_: RuntimeException) {
      // ForegroundServiceStartNotAllowedException / SecurityException: the call goes on in the foreground.
      pending = false
      wanted = null
    }
  }

  /** None, navigation, reload, crash, remount, revoke, logout, JS teardown. */
  fun clear() = onMain {
    wanted = null
    // A pending start stops itself right after startForeground: stopping before it would crash.
    service?.finish()
  }

  /** The notification action: stop now and tell the page that started it (if React still runs). */
  fun leave() = onMain {
    val document = wanted?.document
    clear()
    if (document != null) emit?.invoke(document)
  }

  /** onStartCommand of a regular start: what to show, or null to stop right after starting. */
  fun attach(service: CalabMediaSessionService): Spec? {
    pending = false
    this.service = service
    return wanted
  }

  fun detach(service: CalabMediaSessionService) {
    if (this.service === service) this.service = null
  }
}

class CalabMediaSessionService : Service() {
  companion object {
    private const val CHANNEL = "calab.media"
    private const val NOTIFICATION_ID = 0x0ca1ab
    const val ACTION_LEAVE = "io.calab.host.media.LEAVE"
    private const val ACCENT = 0xFF0071E3.toInt()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_LEAVE) {
      CalabMediaSession.leave()
      // Also when a stale action started a fresh, non-foreground instance.
      stopSelf()
      return START_NOT_STICKY
    }
    val spec = CalabMediaSession.attach(this)
    // startForegroundService obliges startForeground even when the page already left.
    val shown = try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, build(spec ?: CalabMediaSession.Spec("", "room", "en")),
        if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
      true
    } catch (_: RuntimeException) {
      false
    }
    if (!shown || spec == null) finish()
    // Not restarted after the process dies: a new page asks again when it joins.
    return START_NOT_STICKY
  }

  /** The user swiped the app away: the WebView and its call are gone with the task. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    CalabMediaSession.clear()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    CalabMediaSession.detach(this)
    super.onDestroy()
  }

  internal fun finish() {
    CalabMediaSession.detach(this)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  @SuppressLint("MissingPermission")
  internal fun render(spec: CalabMediaSession.Spec) {
    // Without POST_NOTIFICATIONS the service still runs; Android lists it in the task manager.
    try {
      NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, build(spec))
    } catch (_: SecurityException) {
      // Notifications denied: nothing to update.
    }
  }

  private fun build(spec: CalabMediaSession.Spec): Notification {
    channel()
    val call = spec.session == "call"
    val ru = spec.language == "ru"
    val title = when {
      call && ru -> "Идёт звонок"
      call -> "Call in progress"
      ru -> "Calab — вы в голосовой комнате"
      else -> "Calab — you are in a voice room"
    }
    val action = when {
      call && ru -> "Завершить"
      call -> "End"
      ru -> "Выйти"
      else -> "Leave"
    }
    val text = if (ru) "Нажмите, чтобы вернуться в Calab" else "Tap to return to Calab"
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val leave = PendingIntent.getService(this, 1, Intent(this, CalabMediaSessionService::class.java).setAction(ACTION_LEAVE),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.calab_notification)
      .setColor(ACCENT)
      .setContentTitle(title)
      .setContentText(text)
      .setCategory(if (call) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(false)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .apply { if (open != null) setContentIntent(open) }
      .addAction(0, action, leave)
      .build()
  }

  private fun channel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    // Low importance: an ongoing status, never a sound or a heads-up.
    manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.calab_media_channel), NotificationManager.IMPORTANCE_LOW))
  }
}
