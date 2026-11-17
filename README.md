# SerTeknik Android

Expo Android application source for the SerTeknik service website. This release uses a Trusted Web Activity (TWA) to open `https://serteknik.elektrik.workers.dev/` in immersive full-screen mode, without browser address or toolbar UI.

## Release source

- App version: `1.0.4`
- Android version code: `5`
- Android package: `space.manus.sertekapp.t150554463504678`
- TWA integration: Google Android Browser Helper, immersive display mode, and Digital Asset Links verification.

## Build

The `production` profile in `eas.json` is configured to output an installable APK:

```sh
eas build --platform android --profile production
```

Expo/EAS signing credentials are managed by the Expo project; no signing keystore is included in this repository. The existing `SerTeknik-Android-Kaynak.zip` is retained as an older source archive; use the repository files on `main` for the current 1.0.4 TWA source.
