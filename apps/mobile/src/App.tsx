import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewNavigation,
  WebViewNavigationEvent,
  WebViewOpenWindowEvent,
  WebViewMessageEvent,
} from 'react-native-webview/lib/WebViewTypes';
import { parseWebOrigin } from './config';
import { hostReducer, initialHostState } from './hostState';
import { decideNavigation, decideNewWindow, isAppSubframe, isAppUrl } from './navigation';
import { strings } from './strings';
import { callsOperation, callsReply, subscribeCalls, callAudioEnabled } from './incomingCalls';
import { ActivityProtocol, activityBootstrap, activityReady } from './activityProtocol';
import { acknowledgeNotification, hostChannelEnabled, notificationReply, notificationState, subscribeNotifications } from './notifications';
import { endSessionActivity, publishSessionActivity, sessionActivityEnabled } from './sessionActivity';

/**
 * The phone host (ADR-0067): one full-screen WebView with the web client — the same DOM, router and
 * MobileShell as in a browser — plus a load error surface. A status-only capability (ADR-0069)
 * is offered on iOS after a native main-frame/origin/current-document handshake. File hand-off is iOS-native (ADR-0068): the web's
 * `<a download>` of its own blob: from the app's main frame goes to the share sheet, decided in the
 * react-native-webview patch without JS or page input. The WebView is edge to edge; the web client applies
 * the safe areas itself (`viewport-fit=cover` + `env(safe-area-inset-*)`), so the host adds none.
 */

/** Dark `--color-bg` / labels of the web client (app/styles.css): the app opens dark by default. */
const BG = '#1c1c1e';
const LABEL = '#ececf0';
const LABEL_SECONDARY = '#b4b4b9';
const ACCENT_STRONG = '#0071e3';

/** Inlined at build time; app.config.ts has already refused a bad value. */
const ORIGIN = (() => {
  try {
    return parseWebOrigin(process.env.EXPO_PUBLIC_CALAB_URL);
  } catch {
    return null;
  }
})();

/** Every URL reaches `onShouldStart`: the library's own origin list matches by prefix and opens misses via Linking. */
const ANY_ORIGIN = ['*'];

function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}

export default function App() {
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      {ORIGIN ? <Host origin={ORIGIN} /> : <Text style={[styles.body, styles.center]}>{strings.misconfigured}</Text>}
    </View>
  );
}

function Host({ origin }: { origin: string }) {
  const [state, dispatch] = useReducer(hostReducer, initialHostState);
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const loaded = useRef(false);
  const activity = useRef(new ActivityProtocol(state.generation));
  const resetActivity = useCallback(() => {
    activity.current.reset();
    endSessionActivity();
  }, []);
  useEffect(() => {
    activity.current = new ActivityProtocol(state.generation);
    return resetActivity;
  }, [state.generation, resetActivity]);
  const onMessage = useCallback(({ nativeEvent }: WebViewMessageEvent) => {
    const action = activity.current.accept(nativeEvent.data);
    if (action?.type === 'ready') {
      endSessionActivity();
      web.current?.injectJavaScript(activityReady(state.generation, action.document, sessionActivityEnabled));
    } else if (action?.type === 'calls') {
      void callsOperation(action.document, action).then(value => {
        if (activity.current.belongsTo(state.generation) && activity.current.isCurrent(action.document))
          web.current?.injectJavaScript(callsReply(state.generation, action.document, action.request, value));
      });
    } else if (action?.type === 'publish') publishSessionActivity(action.document, action.snapshot);
    else if (action?.type === 'end') endSessionActivity();
    else if (action?.type === 'notifications' && action.operation === 'ack' && action.eventId) acknowledgeNotification(action.document, action.eventId);
    else if (action?.type === 'notifications' && (action.operation === 'status' || action.operation === 'request')) {
      void notificationState(action.document, action.operation === 'request').then((value) => {
        if (activity.current.belongsTo(state.generation) && activity.current.isCurrent(action.document))
          web.current?.injectJavaScript(notificationReply(state.generation, action.document, action.request, value));
      });
    }
  }, [state.generation]);

  useEffect(() => subscribeNotifications((document, value) => {
    if (activity.current.belongsTo(state.generation) && activity.current.isCurrent(document))
      web.current?.injectJavaScript(notificationReply(state.generation, document, 0, value));
  }), [state.generation]);

  useEffect(() => subscribeCalls((document, value) => {
    if (activity.current.belongsTo(state.generation) && activity.current.isCurrent(document))
      web.current?.injectJavaScript(callsReply(state.generation, document, 0, {state:value}));
  }), [state.generation]);

  useEffect(() => {
    loaded.current = state.phase === 'ready';
  }, [state.phase]);

  // Android back walks the WebView history; with none left the system handles it (leaves the app).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  /**
   * The top frame left the app anyway (an Android POST or a decision past the library's 250 ms):
   * stop and show the error. After the fact, not a boundary: the page has already started loading.
   */
  const leftApp = useCallback(
    (url: string): boolean => {
      if (!url || url === 'about:blank' || isAppUrl(url, origin)) return false;
      web.current?.stopLoading();
      resetActivity();
      dispatch({ type: 'failed', error: 'blocked' });
      return true;
    },
    [origin, resetActivity],
  );

  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest): boolean => {
      const decision = decideNavigation(req, origin);
      if (decision === 'load') return true;
      // Before the app has loaded nobody tapped anything: a redirect out is an error, not a link.
      if (!isAppSubframe(req, origin) && !loaded.current) dispatch({ type: 'failed', error: 'blocked' });
      else if (decision === 'external') openExternal(req.url);
      return false;
    },
    [origin],
  );

  const onOpenWindow = useCallback(
    ({ nativeEvent }: WebViewOpenWindowEvent) => {
      if (decideNewWindow(nativeEvent.targetUrl, origin) === 'external') openExternal(nativeEvent.targetUrl);
    },
    [origin],
  );

  const onLoadStart = useCallback(
    ({ nativeEvent }: WebViewNavigationEvent) => {
      if (!activity.current.belongsTo(state.generation)) return;
      resetActivity();
      if (!leftApp(nativeEvent.url)) dispatch({ type: 'loadStart' });
    },
    [leftApp, resetActivity, state.generation],
  );

  const onNavigationStateChange = useCallback(
    (nav: WebViewNavigation) => {
      if (!activity.current.belongsTo(state.generation)) return;
      canGoBack.current = nav.canGoBack;
      leftApp(nav.url);
    },
    [leftApp, state.generation],
  );

  const onLoad = useCallback(() => {
    if (activity.current.belongsTo(state.generation)) dispatch({ type: 'loaded' });
  }, [state.generation]);
  const onError = useCallback((_e: WebViewErrorEvent) => {
    if (!activity.current.belongsTo(state.generation)) return;
    resetActivity();
    dispatch({ type: 'failed', error: 'network' });
  }, [resetActivity, state.generation]);
  // Main frame only (both platforms); 5xx is the server or the proxy in front of it being down.
  const onHttpError = useCallback(({ nativeEvent }: WebViewHttpErrorEvent) => {
    if (!activity.current.belongsTo(state.generation)) return;
    if (nativeEvent.statusCode >= 500) { resetActivity(); dispatch({ type: 'failed', error: 'server' }); }
  }, [resetActivity, state.generation]);
  const onProcessGone = useCallback(() => {
    if (!activity.current.belongsTo(state.generation)) return;
    resetActivity(); dispatch({ type: 'processGone' });
  }, [resetActivity, state.generation]);
  const retry = useCallback(() => { resetActivity(); dispatch({ type: 'retry' }); }, [resetActivity]);

  if (state.phase === 'error' && state.error) {
    const [title, body] = strings[state.error];
    return (
      <View style={styles.center}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.body}>{body}</Text>
        <Pressable accessibilityRole="button" onPress={retry} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>{strings.retry}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <WebView
        key={state.generation}
        ref={web}
        source={{ uri: origin }}
        style={styles.web}
        originWhitelist={ANY_ORIGIN}
        onShouldStartLoadWithRequest={onShouldStart}
        onOpenWindow={onOpenWindow}
        onLoadStart={onLoadStart}
        onLoad={onLoad}
        onError={onError}
        onHttpError={onHttpError}
        onNavigationStateChange={onNavigationStateChange}
        onContentProcessDidTerminate={onProcessGone}
        onRenderProcessGone={onProcessGone}
        {...(hostChannelEnabled ? {
          onMessage,
          injectedJavaScriptBeforeContentLoaded: activityBootstrap(state.generation, callAudioEnabled),
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
        } : {})}
        // Persistent session: the default (non-incognito) website data store keeps the HttpOnly cookie.
        incognito={false}
        domStorageEnabled
        // New windows come to onOpenWindow (Android needs multiple windows for that); the engine's popup blocker gates them.
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        allowsInlineMediaPlayback
        // A CallKit answer is a native gesture; async RTC audio has no web playback gesture.
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        bounces={false}
        overScrollMode="never"
        webviewDebuggingEnabled={__DEV__}
      />
      {state.phase === 'loading' && (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <ActivityIndicator color={LABEL_SECONDARY} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  web: { flex: 1, backgroundColor: BG },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: BG },
  title: { color: LABEL, fontSize: 17, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  body: { color: LABEL_SECONDARY, fontSize: 15, textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: ACCENT_STRONG, borderRadius: 9999, paddingHorizontal: 24, paddingVertical: 12 },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
