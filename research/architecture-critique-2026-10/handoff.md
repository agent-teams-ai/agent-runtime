# Передача другому агенту: видение владельца и критика архитектуры Agent Runtime

1 октября 2026. **DRAFT / DECISION PENDING. Исследование и планирование, без реализации.**

Это сообщение для нового агента. Твоя задача - понять исходное видение владельца, независимо проверить варианты архитектуры, запустить критиков с разными позициями и предложить лучший состав библиотек и порядок изменений. Не воспринимай рекомендацию предыдущего агента как принятое решение. Не начинай coding по старым планам или прежним поручениям.

## 1. Что хочет владелец

Мы разбираем `agent-teams-ai/agent-runtime`: насколько правильно устроена реализация Codex, её модули и границы. Владелец хочет уверенно выбрать архитектуру до дальнейшего роста возможностей.

- **Очень модульную архитектуру.** Людям должно быть удобно заменять содержательные компоненты своими реализациями без изменения core и private/deep imports. Не подменяй это пожелание минимальным косметическим extraction.
- **Переиспользуемые самостоятельные библиотеки.** Другие разработчики будут строить свои harness на наших решениях. Если компонент действительно имеет самостоятельное применение, допустимо выделять больше библиотек, даже с некоторым усложнением. Нужно объяснять цену каждой границы и её пользу, а не выбирать количество пакетов заранее.
- **Codex сначала.** Довести его архитектуру до хорошего образца, после этого синхронизировать Claude Code. Сейчас Claude не переписывать.
- **Ordinary как основной active способ запуска.** Изолированный contained-turn появился как лишнее направление; сейчас владелец не хочет тратить ресурсы на развитие двух способов. Не предлагать contained-turn Assembly или поддержку второго полного runtime в этой программе.
- **Понятный публичный интерфейс.** Название `containedTurn` для ordinary путает; целевое имя обсуждалось как `operations`. Пользователю нужны понятные submit/observe/cancel, а не знание внутренних owners и receipts.
- **SOLID, Clean Architecture, DDD, DRY и Get Modular/FMS.** Не просто формальный проход диагностики, а правильные обязанности, зависимости, владение ресурсами и проверяемая заменяемость.
- **Без новых фич до стабилизации архитектуры.** Последнее явное ограничение: сейчас границы, необходимые refactors и packaging; не наращивать возможности.
- **Без ненужного legacy и prototype versioning.** Владелец хочет одну текущую evolving v1 собственных pre-stable форматов operation/preparation/ordinary и простую исходную SQL-схему, без ненужных исторических readers/migrations. Это цель, а не разрешение молча удалить действующие записи и cleanup obligations. Инвентаризировать реальные данные и возможность breaking cutover; не придумывать установленную базу пользователей без evidence.
- **Сохранить полезный код.** Не выбрасывать authority, idempotency, cleanup, parsers, validation и meaningful tests из-за имени `contained` или ради уменьшения файлов.
- **Учиться у OpenClaw регулярно.** Существенные execution-решения сверять с его реальной реализацией, учитывать успешные механизмы и failure cases. Хотим более чистую, удобную, мощную архитектуру с меньшим legacy и скрытым состоянием, без универсального framework и раздувания кода. Не объявлять наши преимущества или ошибки OpenClaw без фактов.
- **Единообразие SDK и сопровождения.** Владелец спросил, поможет ли центральный SDK/foundation библиотекам иметь одинаковый, управляемый API и быть проще в поддержке. Он не требовал общего базового класса, inheritance, обязательного container или глобального plugin registry. Нужно оценить готовые OSS-решения и минимальное собственное решение.
- **Понятные оценки.** Для трёх сильных вариантов давать 🎯 уверенность, 🛡️ надёжность, 🧠 сложность по 10, диапазон changed LOC и moves отдельно. Не смешивать worker wall time с трудоёмкостью реализации. Не повторять одно и то же в огромном ответе; детали сохранять в отчёте.

## 2. Что НЕ принято и где предыдущий агент расширил scope

Владелец просил удобную заменяемость и переиспользование в целом. **Обязательный публичный SPI provider/process/store/workspace/artifacts/PA/RS с conformance всех семи ролей был экстраполяцией главного агента, а не согласованным требованием.** Он признал это после вопроса владельца. Его 4500–9000 LOC имели confidence 4/10 и не являются утверждённым бюджетом.

Две технические библиотеки + contracts + dev-kit также были гипотезой, а не принятой topology. Четыре ранних критика и три последних исследователя спорили о model/SPI, engine, PostgreSQL, passive inspection, SDK и kit. Сохрани эти разногласия. **Не превращай число «две» в потолок и не превращай желание модульности в требование немедленно публично поддерживать каждую роль.**

Отделяй четыре понятия: внутренний порт; поддерживаемый внешний SPI; самостоятельно устанавливаемая библиотека; security/authority boundary. Они не тождественны.

Не входит в текущую работу: реализация кода, изменение manifests/dependencies/CI/SQL/pins/accepted ADR, builds/tests/install, live agent/provider execution, PR/commit/merge/release. Также не входят новые streaming/progress, timeout extension, providers/ОС/transports, session reuse/resume, remote/shared-server execution, dynamic loading/hot reload, marketplace/scheduler, второй DI framework, Claude rewrite и contained-turn Assembly.

Default, имя public API, переход данных к v1 и удаление legacy сохраняются как цели владельца. В последней рекомендации они вынесены в отдельные checkpoints. **Проверь обоснованность такой очередности; не выдавай её за решение владельца.** При отсутствии реальных старых данных не строй compatibility framework для гипотетических consumers.

## 3. Изученное состояние и что уже завершено

Последние три исследования изучали Agent Runtime exact SHA `b0bcb265d1466da3272078f9dfdb7c6784624283` от 1 октября. Это изученный снимок, не гарантия актуального main на момент твоего запуска. Получи свежий main через `gh`, посмотри delta и закрепи exact source SHA, прежде чем делать новые выводы. Оригинальные local checkouts находятся на других ветках; не reset/rebase их ради исследования.

Ранее было шесть production context/platform/Host packages, около 35 features. Для нового отчёта актуальный executable profile важнее старого census. Ordinary уже имеет семь consumer ports, восемь Assembly owners и десять capability keys. Provider + prepare-launch имеют одного owner; RS + register-secrets тоже. Package, feature, capability и Assembly node - разные единицы.

Passive и ordinary реально используют Get Modular compile → bind → prepare → run. Contained Assembly pending и сейчас не предлагается к развитию. Domain/application ordinary уже не импортируют Node, SQL, vendor protocol и Assembly; основа Clean/DIP существует.

`createAgentRuntimeHost(options)` уже создаёт ordinary. `createDefaultAgentRuntimeHost()` - passive compatibility factory. Public `submit` уже возвращает acceptance до завершения исполнения. Не предлагай заново реализовать эти возможности; различай публичное acceptance и streaming текста ответа.

Последний изученный main уже исправил удержание cleanup custody при неудачном создании Host/journal. Это нельзя снова выдавать за новую находку. **PR #176 уже merged владельцем**: три ordinary PostgreSQL integrations стали обязательными, общий Docker fake убран из production. **PR #109 уже закрыт** как заменённый. Не возобновляй эти задачи.

Claude имеет настоящий SDK adapter/passive support, но ordinary Host для него отсутствует; protected path имеет незакрытый broker seam. Не считать Codex/Claude одинаково готовыми. Static/synthetic gates не доказывают полную production qualification Codex.

## 4. Конкретные границы и инварианты для проверки

1. **Codex profile в core.** Manifest/platform/binary version конкретного Codex присутствуют в ordinary model/provider contracts. Нужен trusted outer selection с immutable descriptor и связью Host/provider/LaunchRecipe/stored operation; не произвольный caller string. Реши, насколько обобщать при одном текущем supported tuple.
2. **LaunchRecipe.** Assembly сейчас ссылается на `NodeOrdinaryProcessOptions["prepareLaunch"]`. Рассмотри consumer-owned contract вместо concrete adapter type и сохранение одного согласованного provider/recipe owner.
3. **Process/protocol.** Node process делает UTF-8/line framing; Codex reader повторно превращает строки в bytes. Кандидат process library владеет child/pipes/signals/bounded bytes/physical closure; Codex client - framing/RPC/correlation/vendor terminal semantics. Client заимствует канал, а не становится вторым process owner. Сохрани stderr/EOF/UTF-8/overflow/drain behavior.
4. **AE lifecycle.** Engine получает genuine grants, готовит workspace/credentials, резервирует process, сохраняет preparation, подтверждает durable claim и только потом start. Unknown commit/send не означает разрешение повторного запуска. После restart наблюдаем существующие факты. Provider terminal, drain, отсутствие process group, artifact publication, credential retirement и authority settlement - разные факты, не общий `done: true`.
5. **Store.** Adapter использует borrowed structural Pool; сам ordinary store не импортирует `pg`, но AE manifest устанавливает `pg`, Claude SDK и другие зависимости. Named atomic methods над актуальной locked записью + CAS сохраняют cancellation/output races. Adapter → pure domain policy внутри транзакции корректно; наружный read–compute–write может сломать атомарность. Смена operation store не устраняет PostgreSQL из PA/RS автоматически.
6. **Authority и DRY.** PA materialization/retirement и RS admission/settlement имеют разные обязанности. Одинаковая DTO shape или общий `dispose` не даёт genuine authority. Не объединять различную семантику только ради DRY; не открывать PA/RS для симметрии.
7. **SDK/packages.** Curated exports, types, runtime validation, API review и rejecting checks уже контролируют функции. SDK object добавляет удобство, не магическую корректность. Независимый package должен работать без AE/Host/SQL/Claude/PA/RS/Assembly, если их семантика ему не нужна. Узкий import subpath не уменьшает обычные package-level dependencies.
8. **Packed proof.** Установка всех local archives/hoisted linker/checkout symlinks не доказывает независимую установку одной библиотеки. Нужен один выбранный root и declared dependency closure, включая declarations/resources.
9. **Current SDK gate.** На изученном SHA `blocked-current-typed-observation`, `releaseEligible: false`; нужно актуальное typed observation/strict extraction/authority route. API Extractor уже закреплён. Сохранённые 446 diagnostics исторические, не текущая измеренная ошибка.
10. **Отдельные source-backed risks.** SQL read/duplicate accept не сопоставляет decoded payload identity/scope с ключом строки; failed workspace preparation сохраняет evidence без полноценного cleanup-only recovery handle. Это потенциальные gaps по чтению кода, не воспроизведённые incidents. Проверь текущий source и отдельно классифицируй; не добавляй молча исправления к extraction scope.

Старый codec v3 - discriminator persisted ordinary state, не третий релиз продукта. Ordinary появился сразу с 3; contained codec 2 и исторический raw 1 существовали отдельно. Это сохраняло различие cooperative execution и более сильной custody. Существование reader/fixture не доказывает production старые записи. Наша цель one-v1 не запрещает package SemVer, vendor protocol version, standard pin или optimistic concurrency revision.

## 5. Последняя рекомендация, которую надо критиковать

**B: узкий совместный architecture/extraction этап**, не все семь SPI:

- Согласовать minimal API, consumer walkthrough, dependency direction и resource ownership.
- Отделить concrete profile/LaunchRecipe, сохраняя один нынешний supported tuple.
- Выделить самостоятельные process и Codex App Server client библиотеки.
- Подключить сразу в существующий AE ordinary engine/Host; одна Get Modular Assembly.
- SDK как удобный внешний вход, общие правила через существующий development toolchain; без mandatory runtime foundation.
- Выбранные model/state/SPI, PostgreSQL, inspection и engine packages оставить реальными кандидатами, а не автоматической следующей очередью.

На старом снимке dedicated Codex critic оценил B: **2800–4400 additions+deletions включая tests/docs/gates, плюс 900–1650 логических перемещённых строк**, LOC confidence 5/10, 🎯 8/10 · 🛡️ 8/10 · 🧠 5/10. Это не прибавляется к предыдущим бюджетам. R0 contracts → R1 profile/LaunchRecipe → R2 process и R3 client параллельно → R4 combined evidence/docs. При будущей реализации каждый extraction PR сразу интегрирует библиотеку и проверяется; R4 не откладывает все tests до конца.

Альтернативы: A только leaves без full profile cleanup; C B + выбранные AE model/state/SPI/Postgres/conformance. Отдельный AE engine - ещё другой вариант. Не смешивай их budgets. Сильный counterargument B: нейтральный profile для одного tuple может быть преждевременным; сильный counterargument A: переносит существующую связанность и ограничивает дальнейшее использование. Проверь оба.

## 6. Как запустить критиков

[При публикации удалены два абзаца о запуске на внутренней инфраструктуре hosted workers: они не относятся к архитектурному анализу.]

**Для current external research нужен admitted research network/tool profile и фактическая проверка retrieval.** Не выключать sandbox, не использовать TEST egress exception. При отсутствии такого профиля честно сообщить о missing capability. Предыдущие три анализировали retained source packets с restricted network; это глубокая source critique, а не три независимых online research. Главный агент отдельно получал current source через `gh` и official docs. Сохрани это различие.

Предлагаю четыре независимых ракурса; можно изменить число по содержательной пользе:

1. **Библиотеки и внешний consumer.** Что реально можно использовать в чужом harness; более дробные packages, ownership, dependency closure. Дай сильнейший вариант с большей модульностью и его цену. Не ограничивайся двумя leaves по умолчанию.
2. **Core/DDD/SOLID/lifecycle.** Где держать engine/model/policy, что исправить в Codex до extraction, где совместная работа возможна, какие boundaries сохраняют корректность. Проверь аргументы за и против отдельного engine.
3. **SDK/foundation/OSS и сопровождение.** Consumer SDK vs adapter SPI vs runtime kernel vs dev tooling; единые API, готовые решения, pnpm sufficiency, dependencies/version skew, API extraction. Покажи concrete direct-library и SDK consumer walkthrough без implementation.
4. **Скептик и OpenClaw.** Оспорь выбранный состав и оценки, ищи scope creep, избыточные layers и пропущенные потребности. Сверь реальные process/protocol/correlation/recovery механизмы OpenClaw. Предложи иной лучший вариант, если evidence его поддерживает.

Каждому передай **этот документ целиком**, latest AGENTS ограничения, полный current source checkpoint и доступ ко всем прошлым отчётам, а не только общую рекомендацию. Ownership - analysis/report; isolated workspace, no edits/build/tests/agent execution. Критики должны сами прочитать необходимые source/standards, а не голосовать за готовую summary.

## 7. Стандарты и критерии результата

Canonical CMS: `agent-teams-ai/get-modular/docs/architecture/common-assembly.md#consumer-module-standard`. Изученные upstream и production consumer pin совпали на `9c722ceff4ede307d06d7a4b63fdebe615f54c53`, digest `33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd`. Новому агенту проверить actual delta, не следовать moving main молча. Lifecycle-kernel optional dynamic candidate не нужен автоматически статическому Host.

FMS: `agent-teams-ai/.github/docs/architecture/feature-module-standard/v1.md`; engineering quality / early product advantage там же. Изученный `.github` SHA `3fe0f135ffc446b3bb174397c6b5783f72a008a2`. Общие правила не копировать в новый локальный стандарт. В будущем boundary changes идут с guidance/profiles/rejecting gates; сейчас только анализ.

Shared-first: stable invariant/port/schema/policy kernel/conformance может быть обоснован одним production consumer с несколькими materially different lifecycle scopes. Не отказывать только из-за отсутствия второго repo. Для обещания общего cross-consumer runtime или широкого stable SPI нужен независимый consumer. Product policy, orchestration, authority и supervision остаются ответственностью Host; технический механизм может быть библиотекой без переноса этих обязанностей.

OpenClaw предыдущий изученный snapshot `71a551649cbcfd8f68adb1dfb113dc593577e220`; не называть current upstream. GitHub всегда читать через `gh`, включая source/PR/Actions, без browser workaround. Другие official technical docs можно получать admitted web tools. Новую dependency сейчас не устанавливать.

Ожидаемый результат:

- Чётко отделить owner goals, ранее предложенные гипотезы, current facts и новый выбор.
- Дать 3 сильных варианта, схемы dependencies/resource owners и конкретные consumer walkthroughs.
- Для каждого package объяснить, почему самостоятельный, кто owner, что API обещает, чего не обещает, dependencies и реальный reusable scenario.
- Разобрать SOLID/Clean/DDD/DRY/Get Modular/FMS по существу; простое увеличение package count не засчитывать как качество.
- Указать разногласия критиков, strongest counterargument и evidence, меняющее рекомендацию.
- Changed LOC + moves без double count, confidence и approximate effort лишь при обосновании. Старые оценки не являются обязательством.
- Порядок bounded dependency-safe PR около 2000 changed LOC после выбора, parallel lanes/единственный integrator/риски. Это предложенный план, **не разрешение открыть PR**.
- Scope exclusions, data/default/API вопросы и correctness risks вынести отдельно. Никаких новых фич под видом architecture.
- Не выдавать source reading, passing static gates или sandbox consumer за production qualification.

Никаких tests launch/provisioning/runtime/task assignment на реальных пользовательских проектах. В этом проходе effectful testing вообще не нужен. Не создавать commits/PR; при будущем разрешении author и committer только `iliya <<owner-email>>`, conventional commits + issue refs, без веток `codex/`.

## 8. Полный evidence packet и навигация

Все пути доступны в прежнем workspace; если другой агент работает на хостинге, передай пакет inputs с exact SHA256 через штатную изоляцию.

- Последняя сводка с диаграммой и вариантами: `<local-notes>/hosted-sdk-architecture-20261001/sdk-architecture-synthesis.md`.
- SDK/foundation critic: `<local-notes>/hosted-sdk-architecture-20261001/sdk-report.md`.
- Codex boundaries critic: `<local-notes>/hosted-sdk-architecture-20261001/codex-boundaries-report.md`.
- Necessity/UX critic: `<local-notes>/hosted-sdk-architecture-20261001/necessity-ux-report.md`.
- Самодостаточный контракт предыдущих трёх: `<local-notes>/hosted-sdk-architecture-20261001/context-and-scope.md`.
- Четыре предыдущих критика, разногласия и ссылки на полные отчёты: `<local-notes>/hosted-critique-20260930/critique-synthesis.md`.
- Два ранних исследования libraries/OpenClaw: `<local-notes>/hosted-research-20260928/research-summary.md`.
- Исторический обычный runtime план с текущим scope notice: `<local-notes>/agent-runtime-ordinary-first-implementation-plan.md`.
- Историческая гипотеза библиотек, не approved implementation handoff: `<local-notes>/agent-runtime-libraries-implementation-handoff.md`.
- Receipt завершённых jobs и ограничения исследования: `<local-notes>/hosted-sdk-architecture-20261001/launch-receipt.md`.

Оригинальный source checkout `<workspace>/agent-runtime` сохранён на `docs/sr-contained-turn-anti-patterns`, SHA `6b12fbd4…`; прежний TEST checkout `<workspace>/agent-runtime-modularity-TEST` на `6e77790c…`. Они не current main; оба были чистыми при передаче. OpenClaw local reference `<workspace>/reference/openclaw/upstream` можно читать, но его HEAD также проверить. Не менять посторонние деревья.

Прошлые три jobs `<job>`, `<job>`, `<job>` завершены done по одной попытке с `changedFiles: []`. Не перезапускать их как незаконченные. Raw JSON, hashes, retained inputs и дополнительные primary sources находятся рядом с последней сводкой. По всем трём clean/exact HEAD/input integrity проверял coordinator вне provider sandbox.

**Финальный ответ владельцу:** краткое понятное предложение, что именно выбрать и почему, какая цена, что ещё спорно. Начни с его исходной задачи - правильная архитектура Codex и reusable components, а не с количества пакетов. Отчёты сохрани отдельно; решение по реализации пока не принято.
