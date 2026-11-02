# NexaChat: локальная проверка редизайна

Рабочая область Orca: `nexa-rebrand-design`. Ветка: `Appjey/nexa-rebrand-design`.
Тикет: https://github.com/Appjey/NexaChat/issues/1

Реализацию выполняет Antigravity / `gemini-4-argon-medium` в Orca Run `run_849d4c88abd3`, Task `task_9cad1af993a2`. Координатор отвечает за Docker, независимую проверку и macOS-сборку. Receipt запуска подтвердил совпадение requested/effective модели.

## Локальный стек

Из корня этой рабочей области:

```sh
docker compose -f docker-compose.override.yml up -d --build --wait --wait-timeout 180
docker compose -f docker-compose.override.yml ps
docker compose -f docker-compose.override.yml logs --tail=100 backend frontend
```

Это самостоятельный локальный compose-файл: запускать с явным `-f`. Project `nexachat-redesign` имеет свои PostgreSQL/MinIO volumes; прежний `nexa-issue3` не изменяется.

- Web: http://127.0.0.1:18000
- Backend: http://127.0.0.1:18080/health
- MinIO API: http://127.0.0.1:19000

Секреты находятся в игнорируемом `.env`; не коммитить его. Compose override и `.env.desktop.local` также локальные. Desktop-сборка использует локальные API/files origins через `.env.desktop.local`; production `.env.desktop` не меняется.

Остановить без удаления данных:

```sh
docker compose -f docker-compose.override.yml stop
```

## Тестовые данные

Только для этого локального стека: `preview_owner` (Алексей Козлов), `preview_maria` (Мария Соколова). Пароль обоих: `NexaPreview-2026!`. Это локальные тестовые аккаунты, не production-учётные записи.

В чате #3 есть сообщения, отправленные через настоящий UI с E2E-шифрованием. Есть Избранное и 12 дополнительных тестовых диалогов для проверки прокрутки и закреплённой FAB. Дополнительные аккаунты не проходили инициализацию vault и нужны только как строки списка; E2E-переписку проверять между owner/maria.

Исходные проверки до редизайна: backend healthy, web 200, `/api/auth/me` через web без авторизации 401; регистрация, отправка и расшифровка сообщений owner ↔ maria работают.

## Итоговая проверка

- Gemini 4 Argon (`gemini-4-argon-medium`) завершил frontend-редизайн и исправление расшифровки при холодном переходе на `/?chat=N`. Отчёт реализации и результаты frontend build/lint/unit suite: `ops/REDESIGN-IMPLEMENTATION.md`.
- Дополнительно пересобран production web-контейнер из финального исходного кода; контейнер healthy. Web отвечает HTTP 200, backend `/health` сообщает `healthy` вместе с PostgreSQL. Неавторизованный `/api/auth/me` отвечает 401.
- После проверки аватара в профиле исправлено применение стиля: `display: block` на корневом компоненте отключал flex-центрирование и обрезал инициалы. Повторно собраны web и macOS-клиент; в запущенном приложении инициалы отображаются по центру.
- Повторно собран arm64 macOS-клиент: `frontend/electron/release/NexaChat-1.5.5-mac-arm64.dmg`. Вложенный executable — Mach-O arm64. `codesign --verify --deep --strict` и `hdiutil verify` прошли; подпись **ad-hoc**, поскольку Developer ID certificate на машине нет. SHA-256: `4ac3c54b862244ae6c86c457fca7fa5ba3cda834febcd11fb6ac9392dbc97d73`.
- Запущенное приложение авторизовано локальным preview-аккаунтом и подключено к backend. Скриншоты: основной экран — `design/rebrand/runtime-preview/macOS-client.png`, исправленный аватар в профиле — `design/rebrand/runtime-preview/macOS-avatar-fix.png`.
- Docker Compose оставлен работающим: web `http://127.0.0.1:18000`, backend `http://127.0.0.1:18080/health`, MinIO `http://127.0.0.1:19000`. DMG использует локальные `VITE_*` origins и предназначен для этого preview-стека.

Тестовые учётные данные из предыдущего раздела относятся только к локальной изолированной базе. Сборка остаётся ad-hoc подписанной локальной сборкой и не предназначена для распространения через Gatekeeper без Developer ID подписи и notarization.

## Решение по нативным клиентам

Оставить текущую мультиплатформенную React/Capacitor/Electron архитектуру. Отдельный SwiftUI macOS-клиент сейчас создаст второй UI и дополнительную стоимость поддержки, а выигрыш для продукта не подтверждён. Возвращаться к нативной реализации стоит после измерений, если web runtime систематически ограничивает звонки, офлайн-работу, системную интеграцию или производительность. Полный разбор: `design/rebrand/PLATFORM-DECISION.md`.
