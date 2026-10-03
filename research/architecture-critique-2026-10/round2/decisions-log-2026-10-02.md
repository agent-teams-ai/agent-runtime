# Журнал решений владельца по архитектуре agent-runtime (1–2 октября 2026)

Это единственный источник решений для плана. Всё, чего здесь нет, не решено. Сокращения не используются, кроме имён в коде.

## Направление (1 октября)

1. Codex сначала. Ordinary — единственный активный путь. Contained-turn не развиваем. Claude не переписываем.
2. Library-first (Engineering Quality Standard, PR agent-teams-ai/.github#328): выносить сразу то, что вероятно будет переиспользовано. Breaking changes допустимы. Пакеты 0.x: break выходит minor-релизом с changelog и migration guide.
3. Codex в идеале всегда свежий. Трактовка принята по умолчанию: последний **проверенный** stable из реестра в коде Host. Принимаем текущий и предыдущий проверенные релизы. Режим «нижняя граница + предупреждение», как у OpenClaw, отклонён.
4. Строгая декомпозиция на модули и библиотеки, строго SOLID, Clean Architecture, DRY.

## Решения 2 октября

5. **Репозитории.** Пока только agent-runtime. Любой другой репозиторий организации agent-teams-ai — только после согласования с владельцем: не у всех строгая архитектура. Subscription Runtime вне scope.
6. **Гейты** (решение 3 программы resources, PR #187). Код гейтов не удаляем. Блокирующий гейт выключается из триггеров или из `check` с комментарием «почему, когда вернуть, кто владелец, дата пересмотра».
7. **SDK-growth переделать под нас, а не просто выключить.**
   - Переиспользуем:
     - безопасный читатель архивов (`scripts/sdk-growth-source/archive.mjs`);
     - проверки упакованного пакета (`qualify-sdk-packages.mjs:30-67`: цели exports в архиве, нет утечки `src`, приватные deep paths отвергаются в runtime и в types);
     - идею сравнения exports с проверенной записью;
     - признак публикации вместо жёстких `private` и `0.0.0`.
   - Выключаем с комментарием: равенство с замороженным C0-списком, пин Engineering Foundation 1.6.0, исторические хэши архивов, статусы отменённого пути одобрения.
   - Взамен — генерируемый отчёт о публичной поверхности:
     - закоммиченный файл;
     - падение с понятным diff и командой `surface:update`;
     - бюджеты по уровням (как у OpenClaw);
     - без сети и быстро, ничего не стопорит.

   Для опубликованных пакетов позже добавляется проверка API v1 из Engineering Foundation. Её включаем только после того, как Engineering Foundation заменит требование ADR на каждый break на changeset с migration note.
8. **Engineering Foundation в agent-runtime обновить сразу до 1.7.1.** Это первый PR, вместе с переделкой SDK-growth: assert пиннит 1.6.0.
9. **Дешёвые границы приняты:** единый источник идентичности модуля (`package.json` → `agentTeamsArchitecture`) и пина Consumer Module Standard. Механические инвентари генерируются с режимом `--check`. Решения записываются руками в одном месте.
10. **Библиотеки:** `@agent-teams/process`, `@agent-teams/jsonl`, `@agent-teams/codex-app-server`. Process — только механизм, политика супервизии остаётся в Host.
11. **Provider Access auth capture переводим на общие библиотеки** отдельным PR с ревью. Обнуление буферов остаётся в Provider Access. Миграция с deprecated `getAuthStatus` на `account/read` — отдельно.
12. **Engine и store — тоже пакеты:** `ordinary-operations` и Postgres-пакет хранилища. Выпускаются последней фазой ядра, breaking changes допустимы.
13. **Публикация в npm сразу:** новые библиотеки (`process`, `jsonl`, `codex-app-server`, `ordinary-operations`, store-пакет) и `filesystem-custody`. Host, Agent Execution, Provider Access и Runtime Security — после переименования в `operations`. Первая публикация каждого пакета — с интерактивным подтверждением владельца.
14. **Хранилище.**
    - Правильные абстракции, не привязанные к PostgreSQL. Второй backend не делаем.
    - Схема после практической проверки (`storage-verification/storage-report.md`):
      - порт у каждого владельца на языке домена;
      - решения в domain;
      - адаптер сообщает фазу commit, а политика неясного commit записана в контракте каждого метода;
      - Host получает хранилища композицией (`openPostgresStorage(pool)` с `verify` и `close()`).
    - Хранилище Provider Access переносится после удаления contained: сейчас его таблицы materialization общие с contained-кодом.
15. **Drizzle `1.0.0-rc.4` точным пином** (исключение из правила «без RC», разрешено владельцем). Обязательные доработки:
    - транзакции вручную на одном `PoolClient`;
    - обёртка над migrator: advisory lock, журнал на владельца, сверка `(name, hash)`;
    - санитизация `DrizzleQueryError` до SQLSTATE;
    - исправить обёртку клиента Agent Execution, которая теряет `values`;
    - пакетное исключение `skipLibCheck`;
    - `state` оставить `text`.

    Hash-сборки `rc.5-<hash>` не брать. Проверять выход чистого rc.5 или GA и обновлять agent-runtime и agent-teams-orchestrator вместе.
16. **Проверки совместимости хранилищ** — приватный workspace-пакет (не публикуется). Тест неясного commit — в тестах Postgres-пакета. Этот же механизм — общий ответ на «test entry point» из issue #189.
17. **При несовпадении схемы** Host не создаётся: `verify` и типизированная ошибка. Миграции — отдельной командой.
18. **Postgres-пакет хранилища публикуется**, когда Host на него перейдёт, с адаптерами Agent Execution и Runtime Security. Provider Access добавляется minor-релизом после удаления contained.
19. **Стандарт библиотек — по уровням, строго Clean Architecture, SOLID, DRY:**
    - Engineering Foundation даёт нейтральные настраиваемые механизмы: отчёт поверхности, установку пакета в изоляции, уровни exports, шаблон библиотеки как scaffold-композицию;
    - соглашения Agent Teams — текстом в Engineering Quality Standard (`agent-teams-ai/.github`);
    - каждый репозиторий подключает их маленьким data-пресетом.

    Отдельная задача: README Engineering Foundation сейчас называет его «for Agent Teams repositories», это расходится с задуманной универсальностью. Правка — с согласия владельца, это другой репозиторий.
20. **Feature Module Standard.** Сейчас — явное owned deviation в профиле agent-runtime для пакетов engine и store. После merge #328 — поправка Feature Module Standard v2 со строкой LIBRARY_FIRST, принять вместе с ревизией Consumer Module Standard для 0.3.0.
21. **PR #328 смёржить**, если пройдёт ревью. Это прямая команда владельца, чтобы снять блокер.
22. **План** — в agent-runtime через docs-protocol: индекс полос со статусом (готово / нужно решение / заблокировано / чужая программа), карточки PR, волны параллельной работы, архив обоих раундов критики в `research/`. Отдельным PR от имени владельца, без merge.
23. **Issue agent-runtime #189** (долг тестов после поезда Get Modular) синхронизировать с планом:
    - механизм test entry point = решение 16;
    - порядок — после AR-1 и AR-1b программы resources;
    - отвергающий тест `./testing` в Agent Execution учитывается.

## По умолчанию (принято без возражений)

- Отсутствие реальных данных в трёх ordinary-таблицах не доказано. Первая миграция отказывает, если старая таблица не пуста.
- PR, затрагивающие Host и Assembly, — после AR-1 программы resources. Смена типа `LaunchRecipe` в Assembly — в AR-1b.
- `operations` вместо `containedTurn` — после разделения версии Codex, до любой публикации Host.
- Первый bump Codex до 0.159.3 — только после разделения версии и с разрешения владельца на тестовый прогон.
- Принятие ресурсов в Host: журнал закрывается после владельцев. Второй scope — per-grant в Provider Access (уже в плане resources).
