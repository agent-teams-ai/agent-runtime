---
id: runtime.architecture.v3-embeddability-review
type: architecture
status: proposed
owner: architecture
summary: Proposed public embeddability, library distribution, and extension-contract hardening for v3 without adding new implementation scope.
baseline: agent-teams-ai/agent-runtime@518f1449acf6dda793662783ec9d918d4007c563
historical_review_pr: https://github.com/agent-teams-ai/agent-runtime/pull/235
merged_v3_pr: https://github.com/agent-teams-ai/agent-runtime/pull/243
reviewed_main: agent-teams-ai/agent-runtime@4bdc93a43b58469f60ca10c0dca512824650c8ac
---

# Agent Runtime v3 — модульные библиотеки, embedding и заменяемые границы

**Исследовательское дополнение от 1 ноября 2026 к уже смерженному v3/greenfield foundation, а не новый ADR, новый план или разрешение расширить S1–S5.** Исходный PR [#235](https://github.com/agent-teams-ai/agent-runtime/pull/235) закрыт как superseded; его актуализированная версия уже смержена через [#243](https://github.com/agent-teams-ai/agent-runtime/pull/243). Данное исследование сохраняет конкретные SPI/packaging/embedding риски и acceptance scenarios, сверенные с `main` `4bdc93a43`. Большая часть стратегических решений уже есть в [greenfield foundation](../../docs/architecture/agent-runtime-greenfield-foundation-plan.md) и [modular research](../../docs/architecture/agent-runtime-modular-research.md); этот текст не дублирует их authority. Исторический baseline `518f1449a` относится к первоначальной записи; перед code cutover проверять актуальные source/pins.

**Reviewer handoff, coverage и учёт замечаний:** [V3 Embeddability Review Ledger](v3-embeddability-review-ledger.md). Он фиксирует полное видение, существующие решения, дельту, self-review и статус независимых критиков. Статус предложений не меняет принятые ADR, FMS/CMS pins или S1–S5.

## 0. Что такое v2 и v3

- **v2:** move-first — реорганизация существующего ordinary-кода, затем переписывание. Больше промежуточных миграций и дублирования.
- **v3:** написать **новый active ordinary execution path непосредственно в целевой архитектуре**, переключать по одному согласованному consumer/data cutover, сохранять поведенческие тесты и проверенные гарантии. Это **не** переписывание всех компонентов репозитория: **contained-turn остаётся frozen**, существующий полезный Host/resource-custody код и общая Provider Access materialization сохраняются по назначению.
- **Данное дополнение:** делает v3 основой для **публичных встраиваемых библиотек**, не расширяя текущий объём implementation на remote SDK, event bus, plugin host, Wasm, новые провайдеры или хранение. Неподтверждённые расширения помечены отдельными будущими delivery triggers.

**Приоритет:** устойчивые границы пакетов, публичные контракты и семантика failure/lifecycle до публикации; не универсальные фреймворки заранее.

## 1. Неизменяемые архитектурные ограничения

1. **FMS v1 (текущий принятый scoped profile); FMS v1.1 — целевой, ещё не автоматически принятый N2 successor:** production module — жёсткая ownership/dependency-граница, feature/subfeature — cohesive capability с `contracts/domain/application/adapters/composition` только там, где слой содержателен. Тесты зеркалят вложенные feature paths. Извлечение feature в пакет не меняет её semantic owner. Внешние потребители видят curated exports; внутри feature нельзя deep-import другие features.
2. **Четыре bounded contexts:** Agent Execution — операции/сессии/authority/recovery; Provider Access — подключения, credential custody, grant/route/broker; Runtime Security — авторизация и ограничения; Runtime Configuration — неизменяемая конфигурация и provenance. Orchestrator владеет задачами, командной работой, business priority, delivery и workflow. Ни одна общая техническая библиотека не получает эти полномочия.
3. **Get Modular:** один static Core/Assembly composition root на выбранный Host-профиль, объявленные capabilities и точные revisions, typed required/optional/many bindings; per-run scopes и resources; Observation только для latest-state. Никакого дополнительного DI контейнера, глобального resolver/service locator, ambient registry или параллельного production root.
4. **Clean Architecture/DIP:** domain/application imports — только свои внутренние роли и consumer-owned ports. Данные SDK, Protobuf/Connect, ORM, Node/native, provider DTO и Get Modular descriptors остаются во внешних слоях. Cross-context relationship — опубликованный контракт + ACL через допустимые адаптеры, а не импорт репозитория другого context.
5. **Сохранение authority:** unknown commit/write не превращается в rejection, acceptance, retry или права на dispatch; один durable claim; нет второго запуска после lost acknowledgement; provider acceptance, output drain, process exit и cleanup — разные факты.
6. **Native ownership v3:** отдельный native keeper/init/client lane; Runtime TS только consumer port/adapter и policy; никаких параллельных TS supervisor, Docker wrapper, PID-based recovery или автоматических слабых fallbacks. Native profile требует собственных receipts, authentication/credential-proof и полного реального E2E.
7. **Scope frozen:** contained-turn не переписывать и не удалять; сохранять shared Provider Access materialization. Принятые ADR и content pins не редактировать задним числом; при фактическом изменении принятой семантики нужен отдельный scoped successor.
8. **Пакеты не появляются ради количества:** технический reusable package допустим сразу при конкретном cross-project потребителе, независимой зависимости или публичной поверхности; feature внутри пакета остаётся feature. Не создавать `shared/kernel`, глобальные DomainError, generic Repository, abstraction per function или пустые слои.

## 2. Карта границ: что существует, что закрепить

| Boundary | Текущий факт | Решение/план | Обязательное подтверждение |
| --- | --- | --- | --- |
| Ordinary engine → storage | Postgres adapter одновременно делает SQL и предметные решения | S2: pure decisions, narrowed semantic owner ports, Drizzle outside | fake/real store conformance, CAS/unknown-commit no-dispatch |
| Host → storage lifetime | ordinary Host принимает raw PG pool и вызывает DDL/migrate в constructor | S2/S5: verified storage capabilities; migrate/verify/open — раздельно | zero constructor DDL, borrowed pool never ended, retained debt |
| Engine → process custody | Node/darwin process owner и sealed channel | S1-NATIVE/S4: consumer port → native client, без второго custodian | lost ack/partial writes/crash/full cleanup E2E |
| Provider protocol → bytes | JSONL/Codex привязаны к Node `Buffer` и древнему contained parser | S1: самостоятельные Node-free JSONL + Codex session/turn | packed browser-safe import, bounded reads, no replay on unknown write |
| Provider ↔ Runtime | Interactive `DriverFactory`, `Session`, `Handoff`, `Event` существуют; provider SPI уже owned | Зафиксировать semantic version/capability matrix и внешний implementer admission | detached installed provider passes owner suite |
| Host → external consumers | S5 planned `operations`, `.`/`./host`; только private embedded admission сейчас | Published client semantics first; Connect/gRPC по real external demand | typed outcomes same semantics embedded/remote; no domain wire imports |
| Durable output ↔ live summary | `observe`/output vs OBS-ADOPT `watchSummary` | Не смешивать lossless cursor/replay с coalesced latest-state | slow consumer and gap/error cases |
| Host/resources → physical cleanup | cleanup-only recovery exists, current workspace.prepare error can retain root | S2 G2, S5 retained close reports and scopes | partial prepare, close-during-await, cleanup debt retained |
| Execution capacity | Отдельный active plan C0–C3, Stage K evidence | Follow-up; не создавать в v3 duplicate scheduler/8th V1 port | bounded counts+bytes, cancel under saturation, fenced reclaim |
| Build/distribution | type-only `./interactive-contracts` lives in AE package alongside provider SDK + pg | Package-level dependency isolation and real external install checks | clean consumer with selected deps only; no deep imports |

**Исходники, которые демонстрируют риски:**
- `packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/postgres/ordinary-postgres-store.ts`: SQL + fingerprints/transitions + clock/ID.
- `packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts`: Host получает pool, запускает миграции при construction.
- `packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/ordinary-channel/ordinary-byte-channel.ts`: `WeakMap` для internal sealed transport — **не публичный межпакетный SPI**; две копии runtime-модуля дадут несовместимые handle registries.
- `packages/contexts/agent-execution/package.json`: embedded provider contracts в пакете с `@anthropic-ai/claude-agent-sdk`, `pg` и native dependency. Type-only external import test — полезный, но недостаточный proof полной независимости установки.
- `packages/contexts/agent-execution/src/features/interactive-agent-session/application/ports/outbound/interactive-provider-driver.ts`: хороший owner SPI, не дублировать.

## 3. Package-first без нарушения feature-first

**Обязательная матрица для каждого публикуемого пакета:** владельцы feature; curated runtime/type exports; import-time effects; Node/platform/ABI floor; production/peer/optional/dev deps; owner of secrets and physical resources; version/compatibility contract; minimal external consumer; migrations/native artifacts; trigger for extraction/split.

**Уже запланированные и допустимые пакеты (не изобретать дубликаты):**

| Пакет/семейство | Реальная роль | Запрещённые зависимости |
| --- | --- | --- |
| `@agent-teams/jsonl` | Парсинг/framing байтов, независимая platform library S1 | Node runtime, providers, storage, Get Modular, Host |
| `@agent-teams/codex-app-server` | Вендорный wire/client/turn reducer S1 | Postgres, Host, Runtime authority, native custody, credentials |
| `@agent-teams/ordinary-operations` | Чистые ordinary операции/state/use cases + owned implementer ports S2 | Provider SDK, PG/Drizzle, Node process, Get Modular, Host |
| `@agent-teams/runtime-store-postgres` | PG/Drizzle commit/migration/verification adapters S2 | Embedded Runtime, provider SDK, чужие repositories |
| `@agent-teams/runtime-storage-conformance` | private test support S2, fakes and contract suites | Production dependency, runtime export |
| Provider Access / Runtime Security contexts | Их собственные policy/grants/materialization | Agent Execution aggregate internals; вендорные types в domain |
| `@agent-teams/embedded-runtime` | Trusted Host assembly и public access facade S5 | Статус owner другой bounded context, production `./composition` deep access после S5 |
| `@agent-teams/filesystem-custody` | Нативные строгие filesystem primitives, независимое version/ABI/OS qualification | Provider policy, Execution authority, silently weakened fallback |
| Native keeper/init/client | Отдельно owned implementation и distribution | Reverse import из native client в AR domain/models/DB/Get Modular |

**Принцип установки:** package `exports` и runtime dependency closure должны позволять установить только выбранный путь. Клиентский SDK без embedded Host не тянет PG/native/provider SDK. Provider-protocol библиотека не тянет provider auth или общий Host. Готовая композиция может зависеть от нескольких библиотек — это сознательный набор, а не загрязнение минимального пакета.

`@agent-teams/agent-execution/interactive-contracts` уже является curated type-only entry. Решение о самостоятельном contract-only npm artifact принимается при первой реальной **независимой установке implementer**: проверить реальную dependency closure и совместимость, затем при необходимости выделить один owned artifact с сохранением исходного semantic owner и scoped FMS/ADR successor. Не объявлять новый пакет с фиктивным именем заранее. PR #239 и standalone donor #242 — соседняя provider-adoption работа; не переписывать, не дублировать и не мержить автоматически из v3.

**Встраивание без скрытых side effects:** `import` не должен создавать процессы, читать credential files, открывать socket, исполнять миграции или регистрировать глобальный singleton. `create Host` не должен неожиданно мигрировать storage. Host возвращает scope-bound handle и закрывает только собственные resources; заимствованные pool/credentials/SDK clients закрывает их владелец.

## 4. Публичные контрактные поверхности — три аудитории

| Аудитория | Публичная поверхность и семантика |
| --- | --- |
| End-user SDK | `sessions`, `operations`, `observations`, `interactions`, `recovery` по фактическому supported scope; без SQL, vendor SDK, native handles |
| Embedder/host integrator | trusted scope binding, factories/config snapshots, readiness, disposal, explicit resource borrowing; `.` types и `./host` по S5 |
| Author of an adapter | **один** конкретный owner-defined SPI + capability descriptor + conformance; без deep imports, private bridge, resolver, raw Resources |

- `./composition` после S5 остаётся внутренним, не третьей поддерживаемой API-поверхностью.
- У каждого публичного контракта есть owner, version, frozen semantics, `supported/unsupported`, minimal install proof; не публиковать «все интерфейсы» реэкспортом.
- Application/domain используют свои `application/ports`; внешние SDK/adapter DTO отображаются в них на разрешённом adapter/composition слое. Не импортировать `contracts/` из application ради DRY.
- Нет requirement иметь network boundary между обычными внутренними TS-модулями. Embedded — прямые вызовы; отдельный transport — только на реальном process boundary.

### Предлагаемая семантика SDK-result (зафиксировать при соответствующем owner successor; wire — позже)

Текущий публичный SDK/transport **не принят**: [ADR-0008](https://github.com/agent-teams-ai/agent-runtime/blob/main/docs/decisions/0008-private-embedded-runtime-access-entrypoint.md) сохраняет private embedded entrypoint и требует отдельного решения после реального внешнего потребителя. Ниже — критерии для этого решения, а не уже выпущенный SDK/Connect API.

- **Command identity:** scoped command ID + canonical semantic fingerprint; тот же ID/смысл возвращает прежний признанный факт, изменённый смысл — conflict.
- **Accepted != executed:** подтверждение API, подтверждение provider и физическая работа — разные факты. `potential_acceptance` сохраняет неизвестность и reconciliation; timeout/connection lost никогда не запускает новый effect автоматически.
- **Request cancellation != operation cancellation:** abort ожидания/отписка не означают durable `cancel`. Для отмены принятой операции — явная команда со своим подтверждением и `unknown` при неясном commit. Сохранить существующую семантику `onAccepted` (new-owned callback throw vs duplicate) во внутреннем Host; не превращать сетевой ACK в этот callback.
- **Read and streaming:** операции дают durable reference; output/feed имеет scoped opaque cursor, ограниченные page/byte объёмы, typed expired/invalid/wrong-stream/ahead, reconnect с явным cursor, стабильные event IDs для dedupe. Отсутствие live subscriber никогда не отменяет выполнение. Отправка старого курсора не сбрасывает «к последнему» молча.
- **Interactions:** request generation/id, один command-authority writer, решение только в допустимом scope и на текущей revision; UI `allow` не расширяет Runtime Security permissions. Unknown/expired/revoked fail closed.
- **Capability negotiation:** provider capability, trusted permission и qualified execution profile проверяются отдельно. Unsupported — явная ветка; нельзя выдавать `supportsResume` по факту наличия checkpoint bytes.
- **Errors/privacy:** machine-readable bounded status/reason/phase, никакого текста токенов/argv/env/raw prompts в диагностике и envelope. Типы отказывают корректно, не полагаются на parsing `error.message`.

**Не замораживать `.proto` до первой реальной межпроцессной интеграции.** После неё один owner-controlled Published Language + Buf backward-compat rules, generated low-level clients и handwritten ergonomic TS client; Python/Go SDK при конкретном потребителе. Внешний протокол не становится domain language. При локальном SDK транспорт может подключаться к локальному Runtime-процессу без облака. Локальная петля/Unix socket тоже требует authenticated, scope-bound endpoint; наличие локального адреса не является авторизацией.

## 5. Provider SPI: поддерживать реализации, а не всё подряд

**Provider session/driver SPI уже выбран принятым ADR-0091**, где предусмотрены отдельная implementer-библиотека и typed subpath Agent Execution; новый SPI не изобретать. [PR #239](https://github.com/agent-teams-ai/agent-runtime/pull/239) интегрирует workspace provider library, [PR #242](https://github.com/agent-teams-ai/agent-runtime/pull/242) сохраняет историческую extraction-ветку; оба являются самостоятельной текущей работой, а не завершённой квалификацией. Дальнейшие сторонние provider adapters подключаются через проверенный static composition. Не вводить discovery, dynamic registry или hot replacement ради SPI.

Контракт `DriverFactory/Session` уже имеет `submit`, `observe`, `interrupt`, interaction reply, checkpoint, readiness, close. Его нужно версионировать и протестировать именно по наблюдаемым гарантиям:

| Capability | Необходимая гарантия |
| --- | --- |
| `submit` | stdin/SDK-consumed не равно provider-accepted; unknown нельзя повторять как новую операцию |
| `observe` | declared event ordering, bounded queue/bytes, закрытие и физический drain как разные факты |
| `interrupt` | request acknowledged не означает terminal/physical stop |
| `checkpoint` | format/provider version, config/scope compat, opaque bytes, own custody; не обещать перенос между провайдерами |
| `respondToInteraction` | current generation, stale/duplicate/revoked refusal, no grant escalation |
| `close` | logical close, cleanup confirmed/unknown, retained recovery reference при необходимости |

**Потенциальный ABI риск при извлечении, НЕ текущий подтверждённый дефект:** текущий `OrdinaryTransport` опирается на module-private `WeakMap`. Это корректно как локальная internal bridge между двумя outer bindings **в одной копии модуля**, но недопустимо экспортировать его как взаимозаменяемую cross-package extension API. При извлечении — либо объединить владельца bridge в одном package/Host, либо передавать явный owned channel только среди доверенных адаптеров, с проверкой resource custody. Не использовать глобальный `Symbol.for`, общий singleton registry или обходной `any`, чтобы искусственно сделать две копии совместимыми. Не переименовывать internal sealed handles в Published Language.

Provider implementer не получает доступ к Runtime stores, private grants, native journal, runtime-host control, чужим tenants и raw credential sources. Когда адаптеру нужен vendor SDK, его зависимости принадлежат этому adapter package. Вынесение external/untrusted executable plugin — **другое** security/host/lifetime решение, не автоматическое расширение этого SPI.

## 6. Состояние/выход/ресурсы: три независимые оси

1. **Operation/state authority:** подтверждённые state transitions и командные receipts; Postgres owner store S2, с lock/CAS/immutable evidence. Никакой Observation store не принимает authority.
2. **Durable output/control feed:** точное число occurrence, owner-local order, bounded cursor/replay/retention/gap; independent of live callbacks. Внутренний storage/transaction design должен согласовать атомарность output commit с operation truth. Перенос output в отдельную таблицу — отдельный schema/storage cutover, а не следствие объявления `OutputStore`.
3. **Live latest-state:** OBS-ADOPT `watchSummary` — coalesced non-authoritative state, локальное live-work, own subscriber scope/limit. Не использовать как журнал эффектов, durable terminal или сигнал для повторного запуска.

**Artifacts:** большие payloads передаются через authorized `artifactRef`+metadata/integrity, а не через unbounded DTO или весь `SessionView`; storage implementation меняется за owner port. Не утверждать, что отдельная object-store доставка/URL уже существует в v3.

**Lifecycle:** `Host`/`session`/`operation`/`execution generation`/`native attempt`/`physical process` — отдельные identities и lifetimes. Сохранённая session может не иметь live process; один native host теоретически может обслуживать несколько sessions лишь после доказанной isolation; per-attempt keeper v3 при этом сохраняет выбранные гарантии. Borrowed inputs/ports передаются без transfer of ownership. `cleanup complete` только после доказанных фактов, `abandon` — конец ожидания, не конец физических ресурсов.

## 7. Capacity и размещение тысяч агентов — отдельный управляемый follow-up

Действующий `docs/architecture/capacity-admission-delivery-plan.md` C0–C3 уже владеет `ExecutionCapacityPort`, finite count+byte queues, tenant/provider/pool fairness, admission receipts и reclaim. В v3 **не** вводить второй scheduler, очередь, lease abstraction или дополнительный V1 port. Добавить в integration checklist ссылки на C0–C3 и на необходимость согласования с native-execution contract перед production adoption.

- Бюджеты различают сохранённые sessions, live sessions, активные operations, OS processes, buffered output/bytes, storage retention/debt. `maxAgents` не заменяет их.
- Control-путь cancel/renew/reclaim сохраняет bounded capacity даже при заполненном обычном ingress.
- Неподтверждённый stop/cleanup не освобождает slot, quota или хранилище. Quarantine/debt сохраняются после Host loss.
- Размещение (`one process per agent`, `many sessions per process`, local worker, remote worker) — profile/backend choice, а не API identity. Не обещать мультиплексинг без permission/cancellation/output/credential isolation.
- Postgres vs future local storage и связанная репликация — отдельный deployment/storage ADR; целевая библиотечная независимость не делает transactional guarantees автоматически одинаковыми.

## 8. Identity/compatibility, которые нельзя сливать

| Identity | Что он версионирует |
| --- | --- |
| FMS version + repo adoption pin | Правила feature ownership и permitted layers |
| Get Modular descriptor ID + revision | Binding type semantics (не durable schema) |
| npm package version + integrity | Поставляемую сборку, public API и её dependencies |
| Public Published Language / Protobuf revision | Cross-process DTO и wire-compatibility |
| Provider protocol schema revision | Вендорные сообщения и их validation |
| Selected binary/image closure and execution profile | Подтверждённые OS/CLI/native guarantees |
| Configuration revision | Неизменяемый setup/permissions snapshot |
| Durable operation/credential/checkpoint schema | Хранимые данные и migration compatibility |

Контрактные изменения — при owning feature; внешняя поддерживаемая реализация проходит conformance на точной объявленной revision. Не создавать новые ID `/v2` для обычного изменения revision. Immutable configuration и release selection копируются/валидируются на доверенном ingress; TypeScript `readonly` не защищает от мутации объекта вызывающим кодом после construction. Не объявлять rolling capability revision windows или hot replacement до реальной потребности и accepted successor.

## 9. Admission suite для public/embedder/implementer

Доставить по **реальной границе**, не один огромный пустой тестовый framework:

**S1 library packed tests:** архив отдельно от workspace и root node_modules; `node`/browser-safe JSONL import без Node-only deps, строгие UTF-8/framing/bytes, publisher API только через curated entries, отсутствие effect при `import`, независимый настоящий consumer. Для Codex — проверка protocol revision и no-blind-replay при possible write.

**S2 owner/store tests:** одинаковый owner contract suite на fake и Postgres для сценариев (accept/conflict/unknown, claim, CAS, cancellation, reconciliation); Postgres отдельно подтверждает locks/commit/migration/legacy-data refusal. Никакой optimistic pretend-readback. Замена Drizzle не меняет owner behavior.

**S3/S4 adapter tests:** provider-adapter в отдельном installable package (допустим синтетический в disposable project), typed public SPI, one authority, interrupt/checkpoint/permission failure cases; native client fixture — отдельный статус от real pinned Rust client и полного Docker E2E. Cross-package bridge не зависит от одного невидимого module singleton.

**S5 embedding E2E:** сторонний Node consumer устанавливает именно опубликованные/packed transitive packages, создаёт два Host с разными scope (изолированные операции/ownership), закрытие одного не закрывает второго; borrowed PG pool остаётся жив; при construction нет DDL/provider requests; cleanup incomplete сохраняет recovery handle. Export `./composition` и deep feature imports снаружи отклоняются. External example не требует org-specific repository tooling/credentials.

**Remote SDK later:** другой язык (Python или Go) вызывает реальный процесcный адаптер, теряет ACK после принятия, возобновляет output с cursor, получает typed unknown/gap, не создаёт второй effect; cancel client wait не равен durable operation cancel. Это **не** gate S1/S2 source authoring.

**Scale later:** 8→100→500→1000 sessions/graphs и отдельная реальная нагрузка с OS-process count, memory/bytes, queue fairness и physical cleanup debt. Structural module graph benchmark не доказывает 1000 simultaneous agents.

## 10. Привязка к существующим карточкам v3 без второй дорожной карты

| Existing v3 card | Что уточнить в её реализации / проверке |
| --- | --- |
| `P7a/P7b`, `N2` | FMS v1.1 feature/group ownership, single static Assembly, no deep imports, explicit capability compatibility and per-run scope; применять к новому публичному SPI и его adapters |
| `S1-JSONL`, `S1-CODEX` | Node-free source/byte contract, no Host/provider-policy leak, independently installable package and consumer; no duplicate contained library |
| `NATIVE-CONTRACT`, `S1-NATIVE` | one native owner, stable pre-effect correlation, typed write facts, no WeakMap/private bridge as external ABI, no TS fallback |
| `S2-A/B` | operation rules pure; transport-neutral application inputs and semantic owner ports; separate version identities |
| `S2-C/D/E` | verified storage and immutable migrations, borrowed pool; no storage class leaking into Host public API; no automatic local-DB assertion |
| `S3-SECURITY`, `S3-ACCESS` | recorded immutable limits, credential custody, explicit permissions; external adapters never hold raw storage/grant authority |
| `S4-EXECUTION` | provider SPI mapping against capability matrix; process-native receipts truthful per profile; physical cleanup proof independent from logical status |
| `S5-RELEASE` | selected verified protocol/binary/image/profile closures; effective config pin, only qualified tuples |
| `S5-STORAGE`, `S5-API` | three audiences (caller, embedder, adapter author) with curated surfaces; embedded direct API, no implicit process or DDL; SDK semantics described but remote wire deferred |
| `OBS-ADOPT` | latest-state only, no durable output/command authority; scoped reader lifecycle and limit |
| `PUBLISH-ROUTE` | per-package dependency closure and optional native/provider deps; external installer contract, no `workspace:*` tarball leaks |
| `ACTIVE-SUPPORT`, `PUBLISH-NATIVE` | preserve scoped setup/custody contracts and exact native artifact resolution, no speculative general toolkit |

**Follow-up outside current v3 implementation:** сторонние provider adapters сверх уже выбранного ADR-0091 implementer path; public SPI package extraction only when required by that consumer; Connect/Protobuf + one other-language SDK after real consumer; C0–C3 capacity; cursor-based external output delivery; untrusted/dynamic plugin lifecycle; Wasm/component experiment. Каждому — собственный consumer, owner, delivered proof и accepted successor при изменении защищённого решения. Не называть их оставшимися невыполненными частями S1–S5.

## 11. Конкретные критерии отсутствия overengineering

Абстракция **нужна сейчас**, если выполняется хотя бы одно:
- уже существуют два различающихся потребителя/реализации;
- внешний потребитель должен поддерживать независимую установку/версию;
- технология или физический lifetime пересекает границу, которая уже мешает safety/исправлению;
- отдельная security/authority/failure responsibility требует явного owner;
- конкретный следующий v3 card без неё неизбежно создаст промежуточный refactor.

Иначе оставить точную локальную функцию/тип и задокументированный future seam. Публиковать новый package только при определённом public export, реальном consumer и packed conformance; **feature ≠ package ≠ module ≠ bounded context**.

**FMS extraction check:** сам факт ожидаемого повторного использования не разрешает выделение любого нового package. Целевой FMS v1.1 требует READY (accepted owner, curated surface, contract tests, migration) **и** доказанное независимое reuse, hard boundary (включая отдельный public API/release), public provider surface или dependency lifecycle. Одна внутренняя реализация и желание иметь много пакетов недостаточны. Текущий Runtime пока применяет свой принятый FMS v1 profile; переход на v1.1 и возможная policy library-first проходят предусмотренный N2/FMS-LIBRARY-FIRST successor, а не эта исследовательская запись. Никаких generic `RuntimeKernel`, `PluginManager`, `StorageManager`, `EventBus`, `AnyProvider`, `IRepository<T>`, multi-version adapters или глобального DI bag. Не копировать политики в protocol libs ради повторного использования.

## 12. Review: независимые направления критики и исправления

Этот раздел — **внутренние проверочные проходы автора**, не выдаётся за отчёт реально запущенных удалённых AI-критиков. Для независимого агентного ревью нужны отдельные исполнители с актуальным repo head и read-only review assignment. Каждый должен получить этот документ, v3 план/briefs S1–S5, принятые ADR, `AGENTS.md`, FMS/CMS pins, текущие PR #235/#239 и ограничения native keeper/init.

### Проход A — DDD/FMS/SOLID

- **Риск:** создать один общий SDK/kernel с domain models и размыть владельцев. **Решение:** в разделе 1 закреплены 4 semantic owners, outer DTO mappings, no generic shared domain и promotion criteria.
- **Риск:** конфликт extract-many-libraries с FMS feature hierarchy. **Решение:** feature/subfeature остаётся единицей смысла; package — граница поставки, извлечение при подтверждённой потребности.
- **Риск:** нарушить Get Modular через второй resolver. **Решение:** static composition и owner-owned ports, никакой plugin host в S1–S5.

### Проход B — встраиваемость/API и минимальные зависимости

- **Риск:** type-only `./interactive-contracts` ошибочно считать fully independent install. **Решение:** отдельно проверять manifest + real package dependency closure; contract-only artifact — при конкретном внешнем implementer.
- **Риск:** обычный `AbortSignal` выдавать за durable cancel в Python/Go. **Решение:** два разных действия, acknowledgement/unknown semantics и explicit cursor protocol.
- **Риск:** internal `WeakMap` pass-through выдавать за публичный extension ABI. **Решение:** граница оставлена internal, external implementer проверяется реальным independent install.

### Проход C — reliability/native/scale

- **Риск:** запускать broker/helper как workaround до claim или дублировать keeper custody. **Решение:** native contract v3 сохраняет отдельную ограниченную authority подготовки, а workload запускается только после confirmed claim. Native — single physical owner.
- **Риск:** `closed`/EOF/timeout/absent container превратить в completed cleanup. **Решение:** раздельные receipt facts и retained debt.
- **Риск:** заложить 1000 agents как автоматическое следствие graph composition. **Решение:** отдельные budgets и load qualification; C0–C3 вне scope v3.

### Финальный integration review — проверка непротиворечивости

- **Проверено на уровне документа:** каждое требование имеет конкретного semantic owner и карточку v3 либо explicit future trigger; не введены новая authority/DI/kernel/сервис; frozen contained и existing Provider Access materialization сохранены; native/Linux+Docker квалификация не объявлена готовой; не заморожены `.proto`/plugin/Wasm без реализации.
- **Не выполнено этим документом:** независимый multi-model agent review; запуск CI, root conformance или реальный Docker E2E; изменения исходников/ADR. Эквивалентность существующих production contracts новой реализации подтверждается только при их фактической поставке, а не этим review. Следующий delivery должен проверять exact head, выделенные contract deltas и реальных consumer/adapters. Новое GitHub review на PR #244 было **incomplete (0/3 reviewed)**, поэтому независимая оценка именно этого addendum остаётся открытой; прежние внешние критики v3/#243 не заменяют review изменённых документов.

## Источники

- Основной план v3: https://github.com/agent-teams-ai/agent-runtime/blob/518f1449acf6dda793662783ec9d918d4007c563/docs/architecture/agent-runtime-architecture-program-plan.md
- S1/S2/S3–S5 briefs: в том же commit/`docs/architecture/`.
- FMS v1.1: https://github.com/agent-teams-ai/.github/blob/main/docs/architecture/feature-module-standard/v1.1.md
- Consumer Module Standard: https://github.com/agent-teams-ai/get-modular/blob/main/docs/architecture/common-assembly.md
- Engineering Quality Standard: https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md
- Capacity plan: https://github.com/agent-teams-ai/agent-runtime/blob/e9541fcd9ed3b17b83e423eea52b998a325f2888/docs/architecture/capacity-admission-delivery-plan.md
- Independent install pattern: https://pydantic.dev/docs/ai/overview/install/
