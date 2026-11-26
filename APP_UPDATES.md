# App updates

Publish each signed APK as a GitHub Release asset named `DIPA-Liquor-Store-POS-v<versionCode>.apk` (for example, `DIPA-Liquor-Store-POS-v7.apk`). The app checks the latest public release at startup and shows available updates in the menu's GitHub Releases section.

Before installing an APK signed with a different key, export a full app backup. Android may require uninstalling the old build, which erases its local data.
