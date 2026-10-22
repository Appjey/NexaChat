import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.messenger.app',
  appName: 'Messenger',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    // webContentsDebuggingEnabled is intentionally NOT set: Capacitor then
    // enables Chrome remote debugging (`chrome://inspect/#devices`) only when
    // the APK is debuggable, i.e. for assembleDebug. On a release build an
    // attached inspector would expose the WebView's localStorage — auth token,
    // E2E account_key and the decrypted message cache — to anyone with adb
    // access to the unlocked phone.
  },
}

export default config
