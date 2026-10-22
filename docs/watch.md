# Watch face

The `wear/` folder holds a Wear OS watch face that shows today's dial (sleep, workouts, logs and heart rate) on the watch, with native hands and four editable edge complications. It has two modules:

| Module | Package | What it is |
|---|---|---|
| `app` | `com.deluispablo.healthtracker` | Fetches `GET /watch/today` from the Worker every hour, renders the dial to an image and serves it as a complication |
| `watchface` | `com.deluispablo.healthtracker.watchface` | A resource-only Watch Face Format (v4) face: bezel, 24-hour hour hand, minute hand, the dial image and four edge slots |

It needs Wear OS 6 or later (Watch Face Format v4). It was built for a 41 mm Pixel Watch 3; other round watches should work. It is sideloaded with ADB, not published on Play.

## 1. Worker token

The watch authenticates with one bearer token. Generate a random value and store it as a Worker secret:

```bash
openssl rand -base64 32
cd worker
npx wrangler secret put WATCH_TOKEN --config wrangler.production.jsonc
```

Keep the value; the watch build needs it in the next step.

## 2. Toolchain

- JDK 17
- Android SDK command-line tools with `platforms;android-36`, `build-tools;36.0.0` and `platform-tools`

On macOS with Homebrew:

```bash
brew install openjdk@17 android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Use the SDK's `adb` (`$ANDROID_HOME/platform-tools/adb`). The standalone Homebrew `adb` cask can fail to connect over Wi-Fi with "No route to host".

## 3. Local configuration

Create `wear/local.properties` (git-ignored). Every Gradle task needs it, including the face module and the unit tests:

```properties
sdk.dir=/opt/homebrew/share/android-commandlinetools
watchToken=<the WATCH_TOKEN value>
watchBaseUrl=https://<your-domain>
```

`watchToken` and `watchBaseUrl` are compiled into the `app` build. Never commit this file.

## 4. Pair the watch

1. On the watch: **Settings → System → About → Versions**, tap **Build number** seven times to enable developer options.
2. **Settings → Developer options**: turn on **ADB debugging** and **Wireless debugging**. Keep the watch and the computer on the same Wi-Fi.
3. In **Wireless debugging → Pair new device**, note the pairing code and `IP:port`, then:

   ```bash
   adb pair <ip>:<pairing-port>     # enter the pairing code
   adb connect <ip>:<port>          # the port shown on the Wireless debugging screen
   adb devices                      # the watch should be listed
   ```

## 5. Build and install

```bash
cd wear
./gradlew :app:installDebug :watchface:installDebug
```

Then set the face:

```bash
adb shell am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE \
  --es operation set-watchface \
  --es watchFaceId com.deluispablo.healthtracker.watchface
```

You can also pick **Health Tracker** from the watch's face picker or the phone's watch app.

The first sync runs when the app starts, then every 60 minutes while the watch has a connection. Until the first image arrives the face shows "Toca para activar". Tapping it, or tapping the dial at any time, launches a tiny launcher activity that requests a best-effort immediate one-time sync and closes; use it after logging something, since the hourly job can be deferred while the screen is off. A separate job redraws the cache every 15 minutes without needing a connection, keeps stale dimming current and clears yesterday's data after local midnight in Europe/Madrid. WorkManager timing is approximate. The hands update once per minute.

## 6. Edge complications

The four slots sit on the diagonals of the bezel. By default the top-right slot shows battery (`WATCH_BATTERY`, `RANGED_VALUE`) and the bottom-right slot shows steps (`STEP_COUNT`, `GOAL_PROGRESS`); both left slots start empty. Long-press the face (or use the phone's watch app) and choose **Edit** to change them. Edge slots accept providers with progress (`RANGED_VALUE` or `GOAL_PROGRESS`), shown as icon, value and a progress arc on one curved line, and short text (`SHORT_TEXT`), shown as icon and text centred on the diagonal. The lower slots read upright. They hide in ambient mode, which shows only the bezel, the hands and the night's sleep.

## Troubleshooting

- **`adb shell screencap` shows only the bezel and hands.** The watch was in ambient mode; wake it (`adb shell input keyevent KEYCODE_WAKEUP`) and capture again.
- **The dial never appears.** Check the app's sync log with `adb logcat -s SyncWorker`. A 401 means `watchToken` does not match the `WATCH_TOKEN` secret; rebuild after fixing `local.properties`.
- **The dial looks faded.** The data is more than three hours old; the watch has not reached the Worker since.
- **Change the face** in `wear/watchface/generate.py`, not in the XML: run `python3 generate.py` from `wear/watchface` to rewrite `src/main/res/raw/watchface.xml`.
- **Validate the face XML** after regenerating `wear/watchface/src/main/res/raw/watchface.xml` with the [Watch Face Format validator](https://github.com/google/watchface/releases): `java -jar wff-validator.jar 4 wear/watchface/src/main/res/raw/watchface.xml`.
