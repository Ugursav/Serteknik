import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import { buildInjectedBridge } from '@/lib/serteknik-bridge';
import { handleFileMessage, abortFileTransfer } from '@/lib/serteknik-files';
import { IMAGE_PICKER_SCRIPT } from '@/lib/serteknik-image-script';
import { BACK_SCRIPT, DEVICE_SESSION_KEY, SITE_ORIGIN, isTrustedUrl, navigationAction } from '@/lib/serteknik-policy';

export default function SerteknikNativeScreen() {
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const currentUrl = useRef(SITE_ORIGIN);
  const picking = useRef(false);
  const rejectedDownloads = useRef(new Set<string>());
  const exitPrompt = useRef(false);
  const sessionQueue = useRef(Promise.resolve());
  const [sessionReady, setSessionReady] = useState(false);
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bridge = useMemo(() => IMAGE_PICKER_SCRIPT + '\n' + buildInjectedBridge(savedToken), [savedToken]);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(DEVICE_SESSION_KEY).then(token => {
      if (active) setSavedToken(token && token.length <= 4096 ? token : null);
    }).catch(() => {}).finally(() => { if (active) setSessionReady(true); });
    return () => { active = false; if (loadTimer.current) clearTimeout(loadTimer.current); };
  }, []);

  const exit = useCallback(() => {
    if (exitPrompt.current) return;
    exitPrompt.current = true;
    Alert.alert('SerTeknik', 'Uygulamadan çıkılsın mı?', [
      { text: 'Kal', style: 'cancel', onPress: () => { exitPrompt.current = false; } },
      { text: 'Çık', onPress: () => { exitPrompt.current = false; BackHandler.exitApp(); } },
    ], { cancelable: true, onDismiss: () => { exitPrompt.current = false; } });
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (error || !sessionReady) { exit(); return true; }
      web.current?.injectJavaScript(BACK_SCRIPT);
      return true;
    });
    return () => subscription.remove();
  }, [error, sessionReady, exit]);

  const external = useCallback(async (url: string) => {
    if (navigationAction(url) !== 'external') return;
    try { await Linking.openURL(url); }
    catch { Alert.alert('Bağlantı açılamadı', 'WhatsApp veya ilgili uygulamanın telefonda kurulu olduğunu kontrol edin.'); }
  }, []);

  const pickImage = useCallback(async (id: string) => {
    if (picking.current || !/^image-[a-zA-Z0-9-]{1,100}$/.test(id)) return;
    picking.current = true;
    const apply = (name: string, mime: string, value: string) => {
      web.current?.injectJavaScript(`window.__srkApplyImage?.(${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(mime)},${JSON.stringify(value)});true;`);
    };
    try {
      const choice = await new Promise<'camera' | 'gallery' | null>(resolve => {
        Alert.alert('Fotoğraf seç', 'Fiş veya ürün görselini nasıl eklemek istersiniz?', [
          { text: 'Kamera', onPress: () => resolve('camera') },
          { text: 'Galeri', onPress: () => resolve('gallery') },
          { text: 'Vazgeç', style: 'cancel', onPress: () => resolve(null) },
        ], { cancelable: true, onDismiss: () => resolve(null) });
      });
      if (!choice) { apply('', '', ''); return; }
      const permission = choice === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { apply('', '', ''); Alert.alert('İzin gerekli', 'Fotoğraf eklemek için ilgili izni telefonun uygulama ayarlarından açabilirsiniz.'); return; }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.85, allowsMultipleSelection: false };
      const result = choice === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled || !result.assets[0]?.base64) { apply('', '', ''); return; }
      const asset = result.assets[0], data = asset.base64!;
      if (data.length > 28 * 1024 * 1024) throw new Error('Fotoğraf çok büyük; 20 MB altında bir görsel seçin.');
      const mime = data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('iVBOR') ? 'image/png' : asset.mimeType || 'image/jpeg';
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      apply(`serteknik-fotograf-${Date.now()}.${ext}`, mime, data);
    } catch (err) {
      apply('', '', '');
      Alert.alert('Fotoğraf eklenemedi', err instanceof Error ? err.message : 'Lütfen tekrar deneyin.');
    } finally { picking.current = false; }
  }, []);

  const onMessage = useCallback(async (event: WebViewMessageEvent) => {
    if (!isTrustedUrl(event.nativeEvent.url)) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'SESSION') {
      if (message.token !== null && (typeof message.token !== 'string' || message.token.length > 4096)) return;
      const token = typeof message.token === 'string' && message.token ? message.token : null;
      setSavedToken(token);
      sessionQueue.current = sessionQueue.current.catch(() => {}).then(() => token
        ? SecureStore.setItemAsync(DEVICE_SESSION_KEY, token)
        : SecureStore.deleteItemAsync(DEVICE_SESSION_KEY)).catch(() => {});
      return;
    }
    if (message.type === 'PICK_IMAGE' && typeof message.id === 'string') { await pickImage(message.id); return; }
    if (message.type === 'IMAGE_ERROR') { Alert.alert('Fotoğraf okunamadı', 'Başka bir fotoğrafla tekrar deneyin.'); return; }
    if (message.type === 'BACK_READY') {
      if (canGoBack.current) web.current?.goBack();
      else if (Number(message.historyLength) > 1 && currentUrl.current !== SITE_ORIGIN && currentUrl.current !== SITE_ORIGIN + '/') web.current?.injectJavaScript('history.back();true;');
      else exit();
      return;
    }
    const downloadId = typeof message.id === 'string' ? message.id : '';
    if (downloadId && rejectedDownloads.current.has(downloadId)) {
      if (message.type === 'DOWNLOAD_END' || message.type === 'DOWNLOAD_ERROR') rejectedDownloads.current.delete(downloadId);
      return;
    }
    try { await handleFileMessage(message); }
    catch {
      if (downloadId) {
        abortFileTransfer(downloadId);
        rejectedDownloads.current.add(downloadId);
        if (rejectedDownloads.current.size > 64) rejectedDownloads.current.delete(rejectedDownloads.current.values().next().value!);
      }
      Alert.alert('Belge kaydedilemedi', 'Belge aktarımı tamamlanamadı. En fazla 20 MB olan belgeyi tekrar indirip kaydetmeyi deneyin.');
    }
  }, [exit, pickImage]);

  const retry = () => { setError(''); setLoading(true); setRetryKey(key => key + 1); };
  return (
    <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.container}>
      {sessionReady && <WebView
        key={retryKey}
        ref={web}
        source={{ uri: SITE_ORIGIN }}
        style={styles.web}
        javaScriptEnabled domStorageEnabled sharedCookiesEnabled thirdPartyCookiesEnabled
        cacheEnabled setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures
        allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never"
        originWhitelist={['https://*', 'tel:*', 'mailto:*', 'whatsapp:*']}
        injectedJavaScriptBeforeContentLoaded={bridge}
        injectedJavaScript={bridge}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={request => {
          const action = navigationAction(request.url);
          if (action === 'external') { void external(request.url); return false; }
          return action === 'internal';
        }}
        onOpenWindow={event => {
          const url = event.nativeEvent.targetUrl;
          if (isTrustedUrl(url)) web.current?.injectJavaScript(`location.href=${JSON.stringify(url)};true;`);
          else void external(url);
        }}
        onNavigationStateChange={state => { canGoBack.current = state.canGoBack; currentUrl.current = state.url; }}
        onLoadStart={() => {
          setLoading(true); setError('');
          if (loadTimer.current) clearTimeout(loadTimer.current);
          loadTimer.current = setTimeout(() => { setLoading(false); setError('Bağlantı beklenenden uzun sürdü. İnternetinizi kontrol edip tekrar deneyin.'); }, 35000);
        }}
        onLoadEnd={() => { if (loadTimer.current) clearTimeout(loadTimer.current); setLoading(false); }}
        onError={() => { if (loadTimer.current) clearTimeout(loadTimer.current); setLoading(false); setError('SerTeknik’e bağlanılamadı. İnternet bağlantınızı kontrol edin.'); }}
        onHttpError={event => {
          if (event.nativeEvent.statusCode >= 400 && event.nativeEvent.url === currentUrl.current) { setLoading(false); setError('Site şu anda yanıt vermiyor. Biraz sonra tekrar deneyin.'); }
        }}
        renderError={() => <View style={styles.web} />}
      />}
      {(loading || !sessionReady) && !error && <View style={styles.loading} pointerEvents="none"><ActivityIndicator color="#07334d"/><Text style={styles.loadingText}>SerTeknik açılıyor…</Text></View>}
      {!!error && <View style={styles.error}><Text style={styles.title}>Bağlantı kurulamadı</Text><Text style={styles.message}>{error}</Text><Pressable style={styles.retry} onPress={retry}><Text style={styles.retryText}>Tekrar dene</Text></Pressable></View>}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7fafc' },
  web: { flex: 1, backgroundColor: '#f7fafc' },
  loading: { position: 'absolute', top: 52, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12, backgroundColor: '#ffffffed', borderRadius: 12 },
  loadingText: { color: '#17324d', fontSize: 15, fontWeight: '700' },
  error: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#f7fafc', padding: 28, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 23, fontWeight: '800', color: '#17324d', marginBottom: 12 },
  message: { fontSize: 16, color: '#456179', textAlign: 'center', lineHeight: 25 },
  retry: { backgroundColor: '#07334d', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 10, marginTop: 22, minHeight: 50 },
  retryText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
