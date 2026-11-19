# Firebase setup

The Android app uses the Firebase JavaScript SDK with the Web app config in `firebase-config.json`; a `google-services.json` file is not used.

## Enable services

1. In Firebase Console, enable **Authentication > Email/Password** and its **Email link (passwordless sign-in)** option.
2. Create the Cloud Firestore database and the default Storage bucket. Firebase may require a billing plan to create or use Storage.
3. From this project folder, select your Firebase project in the Firebase CLI and deploy the checked-in rules:

   ```powershell
   firebase use --add
   firebase deploy --only firestore:rules,storage
   ```

4. Register an Android app with package name `com.dealer.pos`. Add the release signing certificate's SHA-256 fingerprint in Firebase Console. The fingerprint can be read with:

   ```powershell
   keytool -list -v -keystore .\dipa-pos-release.jks -alias dipa-pos-release
   ```

   Add these fingerprints to the Android app in Firebase Console:

   - SHA-1: `70:1E:B4:61:71:79:EC:83:43:EE:16:E8:71:68:DF:22:F3:0E:E1:5F`
   - SHA-256: `74:A4:35:77:E2:ED:AC:F1:31:B1:4F:49:55:3A:85:52:3F:17:B0:59:50:70:38:38:2B:5E:B5:E0:D8:7B:E9:2C`

   Use the same signing key for every future APK release. Keep both `dipa-pos-release.jks` and `signing.properties` backed up securely; neither belongs in source control.

## Assign store accounts

Create each account in Firebase Authentication. Then create a Firestore document at `users/{auth-user-uid}` with:

```json
{
  "storeId": "dipa-main",
  "role": "admin"
}
```

Use the exact role `admin` for store managers or `staff` for other users. Every account for the same store must use the same `storeId`; IDs may contain letters, numbers, underscores, and hyphens. The first admin login on a device with no linked store seeds an empty store from that device's existing catalog, settings, and transaction ledger. Subsequent accounts load the shared Firestore data.

The rules intentionally prevent app users from editing their own profile. Create or change account profiles in Firebase Console. Store members can read shared catalog/settings and transactions; only admins can change the catalog, settings, and product images.

## APK updates

Publish each signed APK as a GitHub Release asset named `DIPA-Liquor-Store-POS-v<versionCode>.apk` (for example, `DIPA-Liquor-Store-POS-v7.apk`). The app checks the latest public release after sign-in and prompts when its version code is newer.

Before installing this newly signed APK over an older differently signed build, export a full app backup. Android may require uninstalling the old build, which erases its local data.
