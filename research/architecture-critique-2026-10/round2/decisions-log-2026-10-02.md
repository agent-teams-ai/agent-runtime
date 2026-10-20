# Журнал решений владельца по архитектуре agent-runtime (1–11 октября 2026)

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

## Решения 3 октября

24. **Q-SURFACE: вариант (b).** Механизм отчёта о публичной поверхности строится сразу в Engineering Foundation как нейтральная настраиваемая capability; agent-runtime подключает его из релиза Engineering Foundation. Это одновременно согласие владельца на работу в репозитории Engineering Foundation для этого механизма. Заморозка SDK-growth в agent-runtime до этого выключается с комментарием (решение 6).
25. **Q-ACCESS-INTERIM: вариант (a).** На шаге STORE-3 Host получает хранилища Agent Execution и Runtime Security из store-пакета, а Provider Access временно остаётся на старом owner поверх `pool`. В коде Host обязательно оставить подробный TODO: что именно временно, почему (таблицы materialization общие с contained), кто владелец, условие и шаг удаления (после удаления contained перенести адаптер Provider Access в store-пакет, добавить его порт в `storage`, убрать `pool` из опций Host, удалить временную ветку сборки, обновить реестры и тесты), ссылки на карточки STORE-2-access и CONTAINED-REMOVAL.
26. **Q-NATIVE: вариант (a).** До публикации `filesystem-custody` короткий дизайн нативного хелпера `rename-no-replace.node`: готовые платформенные артефакты (optional-пакеты по платформам) или JS-резерв; выбор и CI-сборка фиксируются до первой публикации этого пакета.
27. **Локальная настройка инструментов** вне репозитория; на программу не влияет.
28. **Факт:** Engineering Foundation в agent-runtime уже обновлён до 1.7.2 отдельным изменением (main `399ffc22`). Часть GOV-1 «обновить до 1.7.1» закрыта; остаётся переделка SDK-growth (с учётом решения 24).

## Решения 3 октября, блоки 1 и 2

29. **Q-SECURITY-POLICY-DECODE: (a).** Runtime Security при чтении допуска сверяет только поля идентичности (профиль, провайдер, режим, scope); закрывает допуск по лимитам, записанным в нём самом. Смена политики Host больше не делает незакрытые допуски нечитаемыми. Делается в VERSION-1.
30. **Q-G2: (a).** Handle «только для очистки», которым владеет полёт движка, плюс durable-запись `workspace_retained` в операции. Изменение формата делается один раз вместе с форматом v1 (VERSION-1).
31. **Q-RESTART: (a).** Честный статус: операция без живого владельца после верхней границы срока authority показывается как `reconcile_required`, без повторного запуска. Реализуется до выноса engine в пакет (до ENGINE-1).
32. **Q-CONTAINED: заморозить и отключить.** Contained-turn не поддерживается и не развивается: правило в `AGENTS.md`, README-пометки в каталогах, где только contained, отметка в плане. Тесты contained отключаются в CI (выключение с комментарием «почему, когда вернуть, кто владелец», код тестов не удаляется). Оговорки: (1) тесты общих модулей, которыми пользуется ordinary (кодеки, record, limits, fingerprint, JSONL-ридер и т.п.), НЕ отключаются, либо сначала переносятся в ordinary; (2) typecheck и build пакета продолжают компилировать contained-код, поэтому поломка компиляции видна сразу; (3) ordinary-файлы (`ordinary-*`) внутри каталогов `features/contained-agent-turn/` активны и под заморозку не попадают; (4) разрешены только механические правки импортов, которые вынуждает вынос общих частей; (5) удаление — отдельным решением потом.
33. **Q-FEATURES: (a).** Набор отключаемых фич Codex вычисляется инструментом bump из исходников точного тега и хранится в записи релиза; новая фича, включённая по умолчанию, — обязательный пункт ревью; тестовый прогон сверяет фактический конфиг.
34. **Q-STRICTNESS: (a).** Таблица строгости по типу сообщения: методы, типы item, sandbox, permissions, config и эффекты закрыты; информационные сообщения (лимиты, расход токенов, метаданные thread, коды ошибок) терпят новые поля. Решается на ревью каждого bump.
35. **Q-BROKER-HEADER: (a).** Ожидаемое значение заголовка версии брокер Provider Access берёт из записи релиза.
36. **Q-ACCOUNT-READ: (b), читать токен напрямую.** Факты: `account/read` токен не отдаёт; Provider Access уже требует `cli_auth_credentials_store = "file"` и держит `auth.json` под custody; `getAuthStatus` вызывается с `refreshToken: false`, то есть автообновление не используется. Решение: заменить вызовы deprecated `getAuthStatus` чтением `tokens` из уже удерживаемого `auth.json` строгим парсером под проверенный релиз; helper Codex остаётся для `config/read`, `account/read`, `account/rateLimits/read`, `model/list` и проверки дрейфа идентичности (файл читается до и после). Перед реализацией — короткая проверка (карточка ACCESS-AUTH-FILE): поля `TokenData` и совпадение с токеном `getAuthStatus`. `getAuthStatus` — только запасной путь, если прямого чтения не хватит.
37. **Q-LAUNCH-CONFIG (по умолчанию): (a).** Рецепт запуска остаётся рядом с проверкой конфига в Agent Execution; к ADR-0090 пишется successor-заметка.

## Решения 4 октября, блок 3

38. **Q9: (a).** Отчёт о публичной поверхности (в Engineering Foundation, решение 24): сгенерированный список имён и видов exports по пакетам и entrypoints (`surface/<пакет>.json`), команды `surface:update` и `surface:check` с понятным diff и подсказкой, бюджеты по уровням; уровни из `package.json` → `agentTeamsArchitecture`. Сигнатуры позже проверяет API v1 Engineering Foundation для опубликованных пакетов.
39. **Q10: (a).** Стандарт библиотек: соглашения текстом в Engineering Quality Standard; шаблон новой библиотеки в Engineering Foundation; автоматические проверки только механической части (уровни exports, политика зависимостей ноль или peer, установка в изоляции, changeset с migration note). Стилевые соглашения (`code` + `is()`, `signal` последним параметром, discriminated outcomes, `close()` с фактами) проверяет ревью.
40. **Q11: (a).** Имена: `@agent-teams/process`, `@agent-teams/jsonl`, `@agent-teams/codex-app-server` (subpaths `./protocol`, `./turn`), `@agent-teams/ordinary-operations`, `@agent-teams/runtime-store-postgres`, приватный `@agent-teams/runtime-storage-conformance`.
41. **Q12: тестовый проект — `modularity-host-TEST`** (владелец разрешил его менять, это тестовый репозиторий). Плюс автоматическая проверка установки в изоляции (GOV-4) как механический гейт. Первая публикация каждого пакета в npm — с интерактивным подтверждением владельца.
42. **Q13: постоянное согласие.** Владелец разрешил вносить изменения в Engineering Foundation, `agent-teams-ai/.github` и `modularity-host-TEST` всегда, когда это нужно программе: каждое изменение отдельным PR с независимым ревью. Merge по-прежнему только по явной команде владельца (глобальное правило).
43. **Q-CI-CONTRACT: (a).** CI-контракт от 04.10 (`scripts/ci/full-contract.json`, `scripts/ci/conformance.ts`, проверки в `consumer-migration.test.mjs`): по решению 6 выключить с комментарием три сравнения с замороженной базой `df9260b0` (реестр `source-dependencies.yaml`, engines и зависимости корневого `package.json`, точный список команд) и заменить проверкой «вперёд»: пять дорожек вместе выполняют ровно те leaf-команды, что есть в текущем `check`, каждая ровно в одной обязательной дорожке. Карточка CI-CONTRACT-1, первая в agent-runtime перед STORE-1a и библиотеками.
44. **Q-CONSUMER-STANDARD-REF: (a).** get-modular включён в постоянное согласие (как Engineering Foundation, `.github`, `modularity-host-test`): изменения отдельными PR с ревью, merge по команде владельца. Отдельным PR в Consumer Module Standard добавить ссылку «Feature Module Standard v1 или successor, закреплённый профилем потребителя» и фразу, что сгенерированный инвентарь с закоммиченным diff — это ревью, а не автоматическое расширение (нужно для генерации census, GOV-3).

## По умолчанию, объявлено 4 октября (принято без возражений 8 октября)

Владелец попросил доделать план, не возразив. 10 октября координатор подтвердил D6 и D8 по делегированию технических решений владельцем (9 октября); D7 (сроки публикации) и D9 (цель bump) остаются за владельцем; владелец может изменить любой из них.

- D6. Feature Module Standard v2 пишется полным документом, а не дельтой: реестр `.github` допускает только опубликованные полные версии с шестью обязательными маркерами.
- D7. Решение 13 читается буквально: каждая библиотека публикуется сразу, как только смёржена и выполнены условия публикации (установка в изоляции, surface report, маршрут релиза, TEST-потребитель, интерактивное подтверждение владельца). Второго потребителя не ждём.
- D8. STANDARD-1a сохраняет правило «no global singletons» (урок OpenClaw из первого раунда). В решении 39 его не было.
- D9. Цель bump Codex — последний stable на момент bump; владелец подтверждает её тогда же (решение 3, D4).

## Поправка факта к решению 36 (8 октября)

Посылка «`getAuthStatus` вызывается с `refreshToken: false`, то есть автообновление не используется» неверна. `AuthManager::auth()` (его вызывают `getAuthStatus` без refresh и `account/rateLimits/read`) проактивно обновляет токен, если до `exp` access token осталось 5 минут или меньше. Кроме того, после ответа 401 Codex обновляет токен независимо от `exp`; с `rust-v0.159.3` этот путь достижим через `account/read`. Подробности — в противоречии 12 плана версии 2. Решение 36 остаётся в силе до ответа владельца на Q-AUTH-FILE-CONFIRM; защита от окна обновления — вопрос Q-AUTH-REFRESH-WINDOW.

## Решения 10 октября (координатор, по делегированию владельца от 9 октября)

Владелец 9 октября делегировал технические решения без спорных моментов; спорные вопросы по-прежнему решает он сам.

45. **Q-SURFACE-SHAPE: (a).** Один `tier` на пакет в настраиваемом ключе (в agent-runtime `agentTeamsArchitecture.tier`); бюджет — максимум имён exports на entrypoint для этого tier, задаётся в пресете потребителя; маркер публикации — стандартный npm-сигнал (нет `private`, есть `publishConfig.access`). Обратимо дёшево, пока capability используют только agent-runtime и modularity-host-TEST: пакеты agent-runtime приватные 0.x, но сама capability выходит в Engineering Foundation 1.x, где смена формы позже будет ломающим изменением. Владелец может изменить это решение.

Остаются у владельца: Q-CI-SCOPE (координация с работой по CI), Q-AUTH-FILE-CONFIRM и Q-AUTH-REFRESH-WINDOW (безопасность учётных данных пользователя, тестовый хук upstream), Q-ISSUE-189-COMMENT (запись в GitHub), Q-RUNTIME-CONFIG (решается на API-1), решение CONTAINED-REMOVAL (решение 32), разрешение на тестовый прогон BUMP-2 (D4), D7 и D9.

## Решения 11 октября

46. **Q-AUTH-FILE-CONFIRM: (a), владелец.** Решение 36 остаётся: Provider Access читает токен из удерживаемого `auth.json`, вместе с дизайном обновления из решения 47.
47. **Обновление токена.** Направление владельца: агенту надо разрешать обновлять токен, иначе он протухнет; сделать грамотно (посмотреть, как это решено в соседнем проекте). Механизм выбрал координатор по делегированию: обновление средствами самого Codex на общем логине. Helper получает право записи данных ровно в удерживаемый `auth.json` и обновляет токен сам, когда считает нужным: его окно — 5 минут, это шире окна capture (не больше 60 секунд, ADR-0090:115), поэтому явный запрос обновления не нужен. Codex делает guarded reload с диска, обновляет только если файл не изменился, и пишет на месте, то есть ведёт себя как два Codex CLI на одном логине. Provider Access сам файл не пишет и обновление не запрашивает; проверка дрейфа сравнивает аккаунт и идентичность файла, а не байты; при дедлайне сначала закрывает stdin и даёт helper короткое время дописать файл. Вариант «заблокировать обновление» снят. Альтернатива для владельца: отдельный логин Agent Runtime в собственном хранилище с lease и compare-and-set (так сделано в соседнем проекте, где аккаунты принадлежат только ему); убирает гонку на общем логине, но требует отдельного входа.
48. **Q-ISSUE-189-COMMENT: разрешено владельцем.** Комментарий в #189 оставлен 11 октября: что сделано (#224–#229, #231) и что осталось.
49. **Q-CI-SCOPE: (a), координатор по делегированию** после проверки статуса, о которой просил владелец: заморозки на `2f457fe5` прежние, #229 ради двух изменённых тестовых команд уже правил пять CI-файлов (`package-execution.ts`, `product-fanout-contract.ts`, их тесты и `er-process-observer.ts`), работа по CI идёт (#230). CI-CONTRACT-1 в полном объёме передаётся линии CI после merge #230 и #232; если она не возьмёт, делает интегратор в согласованное окно. Владелец может изменить.

Кроме того (владелец, 10 октября): окна ревизий контрактов (бывший train 2) отложены до появления отдельно собранных плагинов; контракты меняются на месте вместе со всеми потребителями.


## Version 3 inputs and supersession (2026-10-15 to 2026-10-19)

This appendix preserves the earlier record. It distinguishes owner direction
from technical defaults; it does not silently amend an accepted ADR or authorize
implementation in another repository. The version 3 plan supplies the execution
sequence and the smallest required successor records.

50. Owner direction, October 15-16: rewrite the active ordinary path inside
agent-runtime by slices, existing behavioral tests first, then one consumer
switch. Build all selected libraries; do not replace them with a reduced scope.
51. Owner direction, October 15: contained code stays frozen and is not deleted.
No implementation dependency may wait for CONTAINED-REMOVAL. This supersedes the
removal timing in decisions 14, 18, 25 and 32(5) for this program; it preserves
contained code, tests, data and shared materialization ownership.
52. Technical selections in the October 15 synthesis, accepted with option (a)
on October 16: verified storage object with no Host pool; Provider Access grants
in the store package and shared materialization with Provider Access; dedicated
ordinary schemas; preserve #231 assertions while adapting narrowed port calls;
one Provider Access rewrite with libraries/auth-file/refresh; capability feature
names; Provider Access and Agent Execution directly nested after N2.
53. Accepted reductions, October 16: generator before slices; preserve meaningful
oracles and add only risk-driven tests; coherent PRs that avoid repeated registry
churn, within the current review budget rather than a mandatory PR count.
54. Correction after communication-catalog inspection, October 16: configuration
and release are creation snapshots; journal is a required command; one upward
receiver uses an explicit port. Observation stores/watch/events are not a
prerequisite and no temporary substitute is built.
55. Completion delegation, October 19: finish the outstanding plan with technical
choices inside the accepted scope. The following are coordinator defaults, not
additional owner quotations: infer recognized roles from nonempty directories
after the scoped N2 successor; runtime root entrypoint for platform libraries;
remove public Embedded Runtime ./composition at API cutover while preserving
internal contained build/tests; keep Runtime Configuration private unless the
public Host signature proves a standalone publication necessary.
56. Verified source update, October 19: the process-runtime repository now
publishes node-or-bun 0.2.1. Its current run-to-completion API lacks the duplex
and POSIX group semantics the runtime needs. Plan a narrow separately owned
extension there; do not create a duplicate @agent-teams/process. This is a
planning choice and not authorization for implementation in that repository.
57. Verified source update, October 19: Foundation 1.10.0 and the FMS package
0.1.1 are published. Reuse their baseline/source graph/kernel rather than plan
them as missing work. Baseline adoption uses its actual CLI configuration path,
not an invented capability key. Consumer adoption and validation remain work.

Earlier references to owner-only routine merge or repeated independent review
are historical procedure. Current global/repository delivery rules govern actual
execution; this planning delivery does not merge or publish product changes.

58. Owner approval, October 19: implement the planned bounded interactive
process extension in the existing process-runtime repository, whose package is
node-or-bun. This supplies the repository scope missing from decision 56;
PROCESS-DUPLEX requires no repeat owner scope confirmation. Preserve the existing
run API and deliver the selected duplex stdio / Node POSIX group mechanism with
its owning successor record, tests and release. Other repositories or unrelated
capabilities are not added by this approval. The architecture program still
rewrites the active ordinary path from scratch by slices, directly in the nested
v1.1 target after N2; this approval does not turn the documentation delivery into
an already completed implementation.

59. Planning completeness audit, October 19: restore explicit cards and acceptance
for the already accepted ACTIVE-SUPPORT module-rules lane, PUBLISH-NATIVE and
filesystem-custody publication, conditional shared tooling/library-first standard
successor, and the full source/feature/config/refresh checklist of Codex bump.
This is a coordinator completion of existing scope, not a new owner feature
request. Published FMS v1.1 provides nesting; it does not prove the separate
LIBRARY_FIRST extraction criterion delivered. PUBLISH-NATIVE selects prebuilt
optional artifacts matching the full existing native binding, with typed refusal
for an unavailable tuple and no weakened JavaScript no-replace fallback.

60. Owner direction, October 20: study Get Modular module communication,
observation and events deeply and use the important module mechanism according
to its actual recommendations. Coordinator selection: OBS-ADOPT adds a bounded
live-operation summary view with an AE producer and Host subscriber/public
`operations.watchSummary` bridge. This is a new selected inspection capability,
not an assertion that the baseline already needed reactive replacements.
Direct durable queries, journal acknowledgement, dispatch/settlement/cancellation
and the distinct existing `onAccepted` failure semantics remain intact. This
refines decision 54's blanket deferral while retaining immutable per-Host
configuration/release and its protected command paths. The implementation card
must supply its scoped public-contract/CMS successor; this plan changes no
accepted ADR, installed package pin or runtime source.

61. Verified source refresh, October 20: Observation 0.1.0 is public and its npm
archive is byte-identical to the retained tested release artifact. Core/Assembly
0.6.0, resources 0.2.0 and conformance 0.4.0 are published; review this compatible
train directly for P7a/P7b with native TypeScript 7.0.2. Actual consumer adoption
and qualification are still required. `watch` coalesces latest state, `load`
serializes replaceable queries with cooperative cancellation, and `many()` is
an explicitly ordered static extension point. They do not implement lossless
events, dynamic registration, readiness authority or distributed notification.
No new event bus, plugin framework, invented first `load` consumer or local
copy of a shared mechanism is selected by this direction.

62. Owner request, October 20: examine high-cost Get Modular foundation choices
before the runtime rewrite and strengthen the implementation plan. The source
review found no missing shared runtime primitive that blocks the selected
static/nested/per-run scope. Coordinator selections now explicitly fix six
contracts: capabilities/boundaries, ownership/lifetime, command/state/occurrence
delivery, readiness/diagnostics, behavioral replacement/evolution and the future
trust/isolation seam. Existing P7b/N2 and slice cutovers own their enforcement;
there is no new platform-wide completion gate before S1/S2 authoring.
The four runtime outcomes now have concrete implementation instructions and
positive/rejecting acceptance. Diagnostics enter from an outer-root/per-Host
input rather than creating an AE/Host cycle. OBS-ADOPT's public refusal,
activation and close state machine retains sources through pending reader
construction and incomplete cleanup; passive callbacks cannot become feedback
commands. Optional events, plugin isolation, dynamic registries and hot
replacement remain additive work for a selected consumer, not blanket module
requirements. This records planning choices only; no Get Modular or runtime
implementation is claimed.

63. Owner request, October 20: make the six pre-rewrite decisions executable
and estimate the three optional module capabilities. Coordinator refinements
specify one descriptor/exact revision with coordinated contract updates, owned
DTO snapshots (Assembly leaves values opaque), inert preparation, scoped async
acquisition, admission before facade publication and retained construction
failure/recovery. A synchronous non-acknowledging summary publication adapter
cannot change the already confirmed command result. Existing feature cards,
behavioral oracles and the one consumer cutover retain ownership; there is no
new prerequisite phase or module-wide lifecycle interface.
The main plan records separate estimated new production, integration, tests and
documentation ranges for ephemeral typed events, executable dynamic
contributions and a trusted cooperative in-process plugin Host. Their bounds
and exclusions are estimation assumptions, not accepted future API designs or
authorization to implement them now. Dynamic contribution metadata is plain
data; executable invocation needs a separate owned facade and removal/drain
contract. Durable/replay delivery and isolated plugins are larger distinct
scopes. No new blocking product question was found for the selected runtime
rewrite. Revisit those product choices only when a real consumer selects the
future capability.

64. Owner clarification request, October 20: focus further planning on this
runtime, leaving module-platform work to another agent; establish whether the
existing TypeScript Host is reusable and whether Rust/cross-platform readiness
was already delivered. Source review distinguishes the real implemented ordinary/
passive Embedded Host from the Rust technical Supervisor/Guardian spike.
The September 6 Rust custody migration remains explicitly deferred, with domain,
API, PA/RS, SDK and HTTP/TLS ownership retained in TypeScript; this request does
not activate that separate migration. S5 writes the new ordinary/passive target
composition/API once, preserving suitable independent mechanisms and meaningful
tests, while replacing constructor DDL/raw-pool wiring and contained-ledger
coupling. The frozen contained Host and shared materialization/native custody
keep their separate existing ownership.
The plan now records the current ordinary Darwin/non-root and arm64-auth limits,
synthetic Host/Postgres evidence, distinct frozen Linux route evidence and the
three-OS Rust spike's unqualified production status. No all-platform or successful
live-provider claim follows from those tests. Existing Host assertions are
mapped explicitly; obsolete positive constructor-migration expectations become
verify-only/no-DDL rejection. No new product answer or Get Modular capability is
needed to complete this bounded plan refinement.

65. Owner-supplied native-team handoff, October 20: keep the new runtime in
TypeScript and assign technical custody to a separate Rust lane in proposed
`agent-teams-ai/custody-keeper` and `agent-teams-ai/custody-init` repositories.
Working names are not created/published artifact claims. Native owns per-attempt
keeper, init under Tini, Docker/process/resources, autonomous accepted deadlines,
technical journals/recovery, normative protocols, generic TS client and native
artifacts. Runtime owns operations/PG/claim/receipt decisions, PA/RS/SDK/provider
and broker semantics, workspace/artifact contents, Host and the consumer-owned
execution port/adapter. Generic client is not the runtime adapter.
The handoff supersedes PROCESS-DUPLEX as this runtime's dependency and the native
integration deferral in decision64; separately approved process-runtime work is
not cancelled or taken over. Existing contained remains frozen. Guardian is a
possible primitive reference, not a ready keeper/init implementation; Supervisor
updater/generation work is not an extra prerequisite.
The canonical program section now owns the seven-part shared integration
contract, dependency direction and fixture/real-conformance/real-Docker evidence
split. Keeper owns broker process custody from launch, TS its HTTP/TLS behavior;
mounts never transfer source-directory deletion rights. Native startup/recovery
invocation has an explicit Host/deployment owner; native never resumes/retries a
provider. No second TS custody/client implementation or weaker automatic fallback.
First native profile is Linux+Docker with exact artifact/provider/profile and
credential/receipt successors, not relabelled Darwin or frozen contained evidence.
NATIVE-AUTH explicitly resolves helper placement/credential rights with native/PA
owners before activation. Runtime may develop against the agreed fixture while
native is pending; only dependent physical cutover/E2E waits. Native owns its
broad E2E matrix, runtime the policy mapping and complete integration; no test-line
quota. This delivery records coordination, not native implementation, repository
creation, provider activation or accepted-ADR changes.
