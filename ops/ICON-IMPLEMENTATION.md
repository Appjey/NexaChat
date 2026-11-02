# NexaChat — Внедрение иконки приложения (Вариант 02 · «Свой круг / Kindred Hearth»)

Дата: 2 ноября 2026 · Итерация: `Clear Contrast v4` · Утверждённый знак: **Вариант 02 · «Свой круг / Kindred Hearth»** (`design/rebrand/own-space-icons/concept-02-kindred-hearth.svg`).

---

## 1. Выбранное направление и исходный мастер

- **Канонический векторный мастер:** `design/rebrand/own-space-icons/concept-02-kindred-hearth.svg` (`1024×1024`, плитка `#0D1017` с `rx="226"`, ведущее светлое крыло `#F2F4FA`, парное крыло второго плана `#493B67`, верхняя живая искра отклика `#7C5CFF`).
- **Канонический растровый мастер:** `design/rebrand/own-space-icons/concept-02-kindred-hearth.png` (`1024×1024`).
- **Монохромный мастер:** `design/rebrand/own-space-icons/concept-02-kindred-hearth-mono.svg` / `.png`.
- Старый знак разомкнутого кольца с точкой (`stroke-dasharray="1518 304"`, `#4f8cff`, градиенты `#23233f -> #121224`) и заглушка `favicon.ico` (SVG-логотип Vite в файле `.ico`) полностью удалены из всех производственных поверхностей приложения.

---

## 2. Перечень обновлённых поверхностей и файлов

### 2.1. Мастер-пакет исходников (`frontend/assets/`)
- `frontend/assets/icon-only.svg` — приведён в полное соответствие с каноническим мастером `concept-02-kindred-hearth.svg` (`1024×1024`, `rx="226"`, `#0D1017` / `#F2F4FA` / `#493B67` / `#7C5CFF`).
- `frontend/assets/icon-only.png` (`1024×1024` RGBA PNG) — синхронизирован побайтово/попиксельно с `design/rebrand/own-space-icons/concept-02-kindred-hearth.png` (`diff = 0.0000`).
- `frontend/assets/icon-foreground.svg` & `frontend/assets/icon-foreground.png` (`1024×1024` RGBA PNG) — передний план для адаптивной иконки Android **без скруглённой плитки** (на прозрачном фоне), отмасштабированный в `0.80×` относительно центра `(512, 512)` (габарит знака `229..786 px` по X и `230..785 px` по Y, максимальный диаметр `613 px <= 625.8 px`), что гарантирует попадание внутрь строгой круговой safe zone `66dp / 108dp` (`61.1%`) и исключает двойную рамку при наложении системной маски.
- `frontend/assets/icon-background.svg` & `frontend/assets/icon-background.png` (`1024×1024` RGBA PNG) — полноразмерная заливка `#0D1017` без скруглений (`rx`), исключающая просветы и удвоение углов в Android adaptive launcher.
- `frontend/assets/splash.svg`, `frontend/assets/splash.png`, `frontend/assets/splash-dark.svg`, `frontend/assets/splash-dark.png` (`2732×2732`) — обновлены со старого разомкнутого кольца на центрированный знак **Вариант 02 (`Kindred Hearth`)** на фоне `#0D1017`.

### 2.2. Desktop / Electron / macOS (`frontend/electron/`)
- `frontend/electron/build/icon.png` (`1024×1024` RGBA PNG) — синхронизирован с каноническим мастером `concept-02-kindred-hearth.png` (`diff = 0.0000`).
- Локальный кэш и пакет macOS (`frontend/electron/release/.icon-icns/icon.icns`, `frontend/electron/release/mac-arm64/NexaChat.app/Contents/Resources/icon.icns`, игнорируемые git) пересобраны через `/usr/bin/iconutil` со всеми 10 слоями (`16x16` .. `512x512@2x`).

### 2.3. Web / Favicon / PWA / Service Worker (`frontend/public/`, `frontend/index.html`)
- `frontend/public/favicon.svg` (`width="64" height="64" viewBox="0 0 1024 1024"`) — оптически адаптированная версия **Варианта 02 (`Kindred Hearth`)** для малых размеров (`16–48 px`):
  - Сохранены направление, углы наклона (`30°`), трёхчастная иерархия и палитра (`#0D1017`, `#F2F4FA`, `#493B67`, `#7C5CFF`).
  - Оптическое поле знака расширено с `68%` до `78%` площади плитки, толщины крыльев увеличены (`r = 118` и `r = 114`), искра укрупнена (`r = 66`), а сквозной канал негативного пространства в устье V-чаши расширен с `15.3 px` до `47.4 px` (и до `82.5–84.1 px` вокруг верхней искры), чтобы элементы не слипались в `16×16` и `24×24 px`.
- `frontend/public/favicon.ico` — заменён с некорректного текстового SVG от Vite на настоящий бинарный multi-resolution `.ico` (`16×16`, `32×32`, `48×48` RGBA PNG-слои), сгенерированный из оптически адаптированного `favicon.svg`.
- `frontend/public/manifest.json` — обновлены описания иконок (`/favicon.svg` с `sizes: "any"`, `type: "image/svg+xml"`, `purpose: "any"` и `/favicon.ico` с `sizes: "16x16 32x32 48x48"`, `type: "image/x-icon"`, `purpose: "any"`).
- `frontend/index.html` — подключены `<link rel="icon" type="image/svg+xml" href="/favicon.svg" sizes="any" />` и `<link rel="alternate icon" type="image/x-icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />`.
- `frontend/public/sw.js` — проверены ссылки `icon: '/favicon.svg'` и `badge: '/favicon.svg'` для Web Push и входящих звонков; теперь они отдают новый знак Варианта 02.

### 2.4. Android Adaptive & Legacy Launcher + Splash (`frontend/android/app/src/main/res/`)
- Регенерированы через `@capacitor/assets` все плотности `mipmap-ldpi` (`36×36`), `mipmap-mdpi` (`48×48`), `mipmap-hdpi` (`72×72`), `mipmap-xhdpi` (`96×96`), `mipmap-xxhdpi` (`144×144`), `mipmap-xxxhdpi` (`192×192`):
  - `ic_launcher.png` (legacy squircle icon)
  - `ic_launcher_round.png` (legacy round icon)
  - `ic_launcher_foreground.png` (adaptive foreground glyph on transparent canvas inside safe zone)
  - `ic_launcher_background.png` (adaptive solid `#0D1017` background without rounded rect)
- Проверены `mipmap-anydpi-v26/ic_launcher.xml` и `mipmap-anydpi-v26/ic_launcher_round.xml` (`@mipmap/ic_launcher_background` + `@mipmap/ic_launcher_foreground` с `android:inset="16.7%"`).
- Обновлены запасные векторные и цветовые ресурсы Android:
  - `values/ic_launcher_background.xml` (`#0D1017` вместо `#FFFFFF`)
  - `drawable/ic_launcher_background.xml` (сплошной `#0D1017` `108×108dp` вместо бирюзовой сетки шаблона `#26A69A`)
  - `drawable-v24/ic_launcher_foreground.xml` (векторный контур Варианта 02 в safe zone `108×108dp` вместо стандартного робота Android)
- Регенерированы все 25 файлов `drawable*/splash.png` (portrait/landscape/night `ldpi`..`xxxhdpi`).

---

## 3. Команды проверки и результаты

```sh
# 1. Проверка отсутствия старого разомкнутого кольца в коде и SVG-ассетах
grep -rn "1518\|rotate(-62\|#4f8cff\|#23233f\|#121224" frontend/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=release

# 2. Линтинг, unit-тесты и сборка всех целей (Web, Desktop, Android)
cd frontend && npm run lint && npm test && npm run build && npm run build:desktop && npm run build:android
```

### Что реально проверено:
1. **Попиксельная сверка с мастером (`1024×1024`)**: `frontend/assets/icon-only.png` и `frontend/electron/build/icon.png` побайтово и попиксельно совпадают с каноническим мастером `design/rebrand/own-space-icons/concept-02-kindred-hearth.png` (`meanAbsChannelDiff = 0.0000`, `maxChannelDiff = 0`).
2. **Визуальная проверка малых и крупных размеров (`16 / 24 / 32 / 48 / 192 / 1024 px`) на тёмной (`#141923` / `#0D1017`) и светлой (`#F0F3F8` / `#FFFFFF`) подложках**:
   - Оптически адаптированный `favicon.svg` и слои `favicon.ico` (`16×16`, `32×32`, `48×48`) сохраняют чистый сквозной канал фона между обоими крыльями и верхней фиолетовой искрой.
   - На тёмной и светлой подложках плитка `#0D1017` держит чёткий внешний силуэт.
3. **Проверка Android Adaptive Icon и safe zone**:
   - В `icon-foreground.svg` / `ic_launcher_foreground.png` отсутствует фоновая плитка (`rx="226"`), фон прозрачный; в `icon-background.svg` / `ic_launcher_background.png` — сплошная заливка `#0D1017` без скруглений. Удвоение скруглённой плитки полностью исключено.
   - Проверены все 6 плотностей (`ldpi`, `mdpi`, `hdpi`, `xhdpi`, `xxhdpi`, `xxxhdpi`) по 4 файла в каждой (`24` файла `mipmap-*`) + `2` XML в `mipmap-anydpi-v26` + `25` файлов `drawable*/splash.png`.
4. **Сборка и тесты**:
   - `npm run lint` — **0 ошибок**.
   - `npm test` — **7 файлов, 61 тест пройден**.
   - `npm run build` (Web), `npm run build:desktop` (Electron bundle), `npm run build:android` (Android web bundle) — **успешно собраны**, в `frontend/dist/` попадают обновлённые `favicon.svg`, `favicon.ico`, `manifest.json`.

### Проверка координатора после внедрения:
- `npm run dist:desktop` — повторно собраны Electron bundle и `frontend/electron/release/NexaChat-1.5.5-mac-arm64.dmg` с выбранной иконкой.
- `codesign --verify --deep --strict --verbose=2 frontend/electron/release/mac-arm64/NexaChat.app` — успешно; сборка использует локальную подпись, сертификата Developer ID нет.
- `cmp frontend/electron/build/icon.png design/rebrand/own-space-icons/concept-02-kindred-hearth.png` — полное совпадение.
- SHA-256 DMG: `460c344846959880255908911787decbd8a9406ad1b29ba725e61b34086bf00a`.

### Ограничения:
- APK не собирался; Android web bundle и ресурсы launcher/splash проверены. Docker-контейнеры не перезапускались, поскольку изменение касается клиентских ассетов.
