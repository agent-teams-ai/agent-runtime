---
id: runtime.architecture.modular-research
type: architecture
status: active
owner: architecture
summary: Source-backed modular library choices, explicit ownership, alternatives and scoped research deltas for the greenfield plan.
---

# Agent Runtime Modular Research

## Purpose

Дополнение от **27 октября 2026** к [greenfield foundation plan](agent-runtime-greenfield-foundation-plan.md) и [ограниченному v3/S1–S5](agent-runtime-architecture-program-plan.md), baseline `c59fe8364071530d09b48eda47d41620f3f59c25`, draft PR [#235](https://github.com/agent-teams-ai/agent-runtime/pull/235). Пользователь просит независимые библиотеки, глубокий конкурентный анализ, сохранение хороших находок/антипаттернов и критическую проверку альтернатив. Этот документ дополняет существующий план; статус active означает поддерживаемый план, а не принятие новых контрактов или завершение реализации.

**Вывод исследования:** выбранное library-first направление сохраняется. Следующее улучшение — доказать самостоятельную полезность пакетов и точность их смысловых гарантий. Дополнительные абстракции оправданы на границах whole harness, storage, custody, authorization и observation. Универсальный AgentManager, общий shared-domain, второй scheduler/DI и обязательные сетевые вызовы между TypeScript библиотеками не обоснованы.

### Навигация по результатам

| Документ | Содержание |
| --- | --- |
| [Framework research](../spikes/agent-runtime-framework-research.md) | OpenAI Agents, Google ADK, Microsoft Agent Framework; provider coupling, capabilities, sessions, effect paths; три G3 integrations |
| [Library research](../spikes/agent-runtime-library-research.md) | AI SDK v7, Mastra, PydanticAI, OpenHands; dependency closure, history, упаковка и release alternatives |
| [Durability research](../spikes/agent-runtime-durability-research.md) | LangGraph, Temporal, Restate; replay, control flow, conformance, три внешних workflow варианта |
| [Antipattern register](../spikes/agent-runtime-antipattern-register.md) | Нумерованные уроки: факт/предел → наш owner → rejecting case; хорошие паттерны |
| [Decision-changing spikes](../spikes/agent-runtime-modular-architecture-spikes.md) | Узкие эксперименты, которые действительно способны изменить выбор; статус каждого planned |
| [Research review](../spikes/agent-runtime-modular-research-review.md) | Покрытие независимой критики, принятые/отклонённые замечания, результаты проверок и ограничения |
| [Предыдущие решения Q1–Q7](agent-runtime-foundation-decisions-and-review.md#3-семь-настоящих-продуктовых-развилок) | Продуктовые promises, уже подготовленные top-3; этот документ не создаёт второго authority |

## Ownership boundary

Остаются четыре accepted contexts: **Agent Execution, Provider Access, Runtime Security, Runtime Configuration**. Ordinary Operations — отдельная библиотека механизма в semantic ownership AE. Native lane владеет keeper/init, generic client, journal и physical custody. Consumer владеет teams/tasks/business workflows. Первое ordinary-хранилище — PostgreSQL; broad local/desktop SQLite direction сохраняется. ConnectRPC/Protobuf/Buf, frozen contained и принятую 0.x evolution policy не меняем.

Канонические package identities и обязательства находятся в [S1](agent-runtime-architecture-program-s1-libraries.md), [S2](agent-runtime-architecture-program-s2-operations-storage.md) и [S3–S5](agent-runtime-architecture-program-s3-s5-features-host.md). Не открываем их повторно лишь потому, что конкурент использует другой язык или движок. Исследовательская гипотеза становится контрактом только в соответствующем принятом срезе.

## Invariants

Сохраняются F01–F18 foundation plan. Package, feature, bounded context, Assembly entry, process и repository — разные единицы. Продуктовая надёжность определяется конкретными guarantees и проверенным deployment, а не количеством слоёв. Source HEAD/manifest, опубликованный package artifact и установленная версия различаются. В этой работе не запускались competitor runtimes, live models, native/PG chaos или capacity campaign.

## 1. Что сравниваем

Это целевая выборка архитектурных ориентиров по применимости. Подтверждённого рейтинга market share и измерения «топ по надёжности» здесь нет. Direct whole-harness конкуренты, SDK для создания loops и durable workflow engines решают разные задачи.

| Группа | Что полезно перенять | Подтверждённая цена или ограничение | Наше проверяемое направление |
| --- | --- | --- | --- |
| AI SDK v7 HarnessAgent | Отдельные harness/model/sandbox оси, versioned contract, opaque state, familiar public facade | Harness API experimental; documented continue может быть lossless attach или lossy rerun; некоторые config changes сбрасывают Codex thread | Qualified continuation profile и явный context reset/refusal. Сам harness seam уже не уникален |
| OpenHands SDK | SDK/tools/workspace/server; V1 исправляет собственные V0 deployment/state coupling | Direct execute_tool — privileged bypass loop checks; historical masking повредил structural event fields, исправлено PR6259 | Полное покрытие разрешённых effect paths; codec-safe sensitive-data handling |
| OpenAI Agents SDK | Малые agent/runner/tool/session primitives; Python retry safety и отдельно проверенные TS idempotent history operations | Python Model DTO provider-shaped; JS core имеет openai dependency; Python parallel input guards не охватывают все effects | Whole-harness adapter не протаскивает vendor DTO в AE; RS enforced перед защищённым effect |
| Google ADK | Session/artifact/memory interfaces; explicit validated capability snapshot | LlmRequest использует google.genai types; resume допускает повтор tools, что документировано | Capability support отдельно от permission и qualification; no accidental replay |
| Microsoft Agent Framework | Provider extraction ADR-0021, core abstractions, explicit session store semantics | Migration surface и language/process deployment cost; structural protocol сам не обещает concurrent reuse | Разные caller/implementer contracts, точные lifetime и storage preconditions |
| LangGraph | Checkpointer/storage split, standalone checkpoint-conformance, pending writes | Replay зависит от code/state; исправленный #9406 показал влияние observation на result/control state | Observer parity и pause/drain semantics; поддержанный recovery tuple |
| Mastra | Готовая TypeScript ecosystem, storage capabilities и explicit fencing | Broad core surface; исправленный PR28286 о tool call/result pairing. Числа exports/deps не performance metric | Минимальный install closure; согласованные пары в projection, исходная history не переписывается |
| PydanticAI | Slim distribution, opt-in dependencies, typed results | Экосистема Python и её contracts; slim не означает произвольное исключение обязательных deps | Самостоятельный leaf package плюс удобный отдельно выбираемый Host facade |
| Temporal / Restate | Durable business progression, versioned executions, понятные retry/replay limits | External effect/journal gap; cooperative cancellation; history/serialization ограничения | Возможный consumer integration, без передачи technical dispatch authority из AE |

Источники и exact SHA в трёх исследовательских приложениях выше. Значимые первичные anchors: [AI SDK overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview), [OpenHands design](https://docs.openhands.dev/sdk/arch/design), [MAF ADR-0021](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0021-provider-leading-clients.md), [OpenAI guardrails](https://openai.github.io/openai-agents-python/guardrails/), [LangGraph fix](https://github.com/langchain-ai/langgraph/commit/858891aaa164ebdacf33b8f5e7f88b38b9132211), [Restate external-effect limit](https://github.com/restatedev/sdk-typescript/blob/b1080a11984b35419e0e825a0e82bc17c656a22d/packages/libs/restate-sdk/src/context.ts#L397-L406).

AutoGen рассматриваем как исторический источник: его README уже сообщает archived/no maintenance. Semantic Kernel не называем архивированным только из-за рекомендации MAF. Текущее source evidence и отсутствие release/deployment qualification отражены в framework research.

## 2. Конкретная карта библиотек

Следующая таблица — навигация к существующим S1–S5, не новая схема package names. Одна самостоятельная библиотека может иметь несколько cohesive features. Четыре контекста не обязаны стать четырьмя публичными npm-пакетами.

| Компонент | Самостоятельная ответственность | Допустимая зависимость / граница | Публикация |
| --- | --- | --- | --- |
| `@agent-teams/jsonl` | Bounded bytes, framing, UTF-8, strict decode | Нет runtime production dependencies | Новый public S1 |
| `@agent-teams/codex-app-server` | Protocol correlation и turn reducer | JSONL; structural byte channel, без process custody/credentials | Новый public S1, explicit protocol/turn subpaths |
| Native-owned generic client | Transport/protocol реального keeper/init | Native lane supplies exact compatible artifacts | Потребление отдельной поставки, не дублировать здесь |
| `ordinary-operations` | Acceptance, claim, cancellation, truthful outcomes | Consumer-owned clock/digest/store/authority/execution ports; без PG/provider/Host | Public S2 `.` и `./composition` |
| `runtime-store-postgres` | Owner-specific storage, CAS/transactions, migrations | Operations + RS + PA implementer surfaces, concrete Drizzle/pg; borrowed pool | Public S2 полный store в согласованном train |
| `runtime-security`, `provider-access` | Разные semantic authorities | Свои domain/ports; без store implementation | До public S2 store required RS/PA owner versions и implementer surfaces должны быть distributable через scoped public-package successors в том же train; остальные private surfaces не публикуются |
| `agent-execution` | Technical execution policy, binding, workspace/artifacts | Operations и explicit PA/RS/native consumer ports | Owner context, не universal agent loop |
| `embedded-runtime` | Удобный Host/SDK, admission/lifecycle и outer composition | Проверенные owner capabilities и storage object | Curated `.`/`./host` в S5; не экспорт всех internals |
| `runtime-configuration` | Immutable nonsecret profile values | Без credential custody и mutable service bag | Остаётся private, если public signature не докажет необходимость |
| `runtime-storage-conformance` | Joined behavioral oracle для stores | Test-only dependency на owner contracts; production не импортирует | Private. Публичный narrow kit — отдельное promise Q1 |
| Get Modular / filesystem custody | Готовые composition/resources/observation и custody mechanisms | Существующие owning contracts и adoption profiles | Переиспользовать; не второй DI, parser, lifecycle platform |
| Следующая harness family | Реальный adapter конкретного engine | Boundary translation, точный profile, свой consumer | Только при реальном следующем integration; без пустых optional methods |

**Независимость проверяется снаружи monorepo.** Consumer устанавливает tarball, вызывает curated API и отдельно реализует обязательный public port. Он не знает repo paths, organization credentials, Host graph или private DB DTO. Из [Node package exports](https://nodejs.org/api/packages.html#package-entry-points) следует контроль публичных subpaths, но не запрет чужого malicious JS читать доступный filesystem. Dependency boundary не является security sandbox.

### 2.1 Где слой приносит пользу

| Граница | Зачем нужен слой | Когда его не добавлять |
| --- | --- | --- |
| Domain → application → outbound port | Один владелец invariants; deterministic decisions отдельно от IO | Малый parser/helper без policy не требует искусственного aggregate/repository |
| Harness/protocol adapter | Перевести чужие events/errors/continuation semantics | Не копировать все upstream DTO по пяти одинаковым структурам |
| Semantic store adapter | Сохранить atomicity/conflict/unknown outcomes при конкретном SQL | Не generic CRUD repository для разных authorities |
| Host composition | Выбрать implementations, version/profile, lifetimes | Не service locator внутри use case; не registration-order authority |
| Public SDK facade | Простая установка/usage поверх нескольких библиотек | Не обязательный barrel, устанавливающий все engines/server/native dependencies |
| Observation/export adapter | Bounded diagnostics и presentation | Не второй source of truth, scheduler или мутация authoritative records |

Consumer-owned port описывает нужную capability. Для adopted Get Modular boundary внешняя composition связывает owner-owned contract descriptors и adapter. Domain/application не импортируют assembly, shared contract graph или provider SDK. Fixed library dependency остаётся обычным import. [CMS](https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/architecture/common-assembly.md#consumer-module-standard) прочитан как current research reference; local pin и P7a/N2 migration obligations этим не изменены.

### 2.2 Правило выделения нового пакета

До публикации у concern есть хотя бы конкретная ожидаемая независимая польза, один semantic owner, понятный public caller/implementer contract и реальный consumer в той же поставке. Независимые dependency/release/runtime requirements усиливают основание. Не нужно сначала размножить одну реализацию в нескольких продуктах. Если меняется лишь расположение приватного helper, новый tarball/Assembly entry обычно не нужен.

Для оценки изменения задаём четыре вопроса: что сможет сделать внешний consumer; какие dependencies он получит; кто изменяет invariant; какой failure/lifetime contract проверяется отдельно. Нельзя отвечать на все четыре только «так чище».

### 2.3 Caller API, implementer API и persisted state

Добавленный обязательный метод способен сохранить compiling caller и сломать чужой adapter. Поэтому required public ports поддерживаются с первого useful release; optional ecosystem kit не откладывает это обязательство. Package SemVer, contract revision, wire format и durable schema — разные identities. При 0.x deliberate breaking minor сопровождается migration note; retained user state и cleanup debt всё равно требуют safe migration.

Полезная первичная модель: [OpenTelemetry stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) различает API/SDK и extensibility contracts. Мы перенимаем это различение, не его LTS сроки. Политика compatibility остаётся в existing decisions Q5 и S2 publication graph.

## 3. Реестр возможностей стать лучше

Это **целевые проверяемые преимущества**, не уже достигнутое превосходство. Во многих источниках нужные защиты уже присутствуют.

| Цель | Метрика/контрпример, способный её опровергнуть | Первый owner/slice |
| --- | --- | --- |
| Runtime library пригодна без нашего продукта | Packed caller/implementer не компилируется или подтягивает Host/provider/server без необходимости | S1/S2 public libraries |
| Новый harness не требует переписывать AE | Adapter требует vendor-specific change в unrelated domain, fake PID или fabricated drain | S2/S4 binding; G3 real adapter |
| Наблюдение не меняет исполнение | При одинаковых deterministic inputs/clock/provider responses и достаточных budgets observation on меняет canonical decisions/result/dispatch; pause выдан как failure. Real-time overhead и overload проверяются отдельно | OBS-ADOPT, selected stream adapter |
| Восстановление не повторяет неизвестный effect | Lost ACK / process loss / workflow retry создаёт новый runtime-owned protected dispatch без доказательства; внутренние tools harness имеют отдельный qualified scope | AE/Operations + relevant adapter |
| Security соответствует обещанному profile | Hosted/direct/privileged path выполняет effect без нужной enforcement authority | RS/PA + selected effect adapter |
| История и reader устойчивы к transformations | Redaction ломает decode/cursor; удалён call, оставлен result; source history переписана | Output/projection owner в соответствующем срезе |
| Эволюция библиотек предсказуема | Compatible caller ломает implementer; full store published без owner prerequisites | S2/S3/S5 release train |
| Перегрузка сохраняет cancel/cleanup progress | Accepted backlog/debt или actual waiters бесконтрольно растут; control не укладывается в выбранный bound | Existing F05–F07 и fleet charter |

Преимущество доказывается одним declared contract на выбранном наборе harness/deployment tuples и опубликованным результатом этих cases. Сравнительная performance campaign имеет смысл только при одинаковой семантике, workload, бюджете и topology. Здесь benchmark не проводился.

## 4. Как читать top-3

**С** — сложность разработки/поддержки, 10 хуже. **Н** — ожидаемая надёжность выполнения своего declared promise, 10 лучше. **У** — уверенность в пригодности при stated scope, 10 лучше. Это экспертные порядковые оценки, не вероятность, SLA или security certification. Высокое Н у узкого профиля не означает такое же покрытие, как у широкого.

**P/T** — incremental handwritten production+integration / tests+fixtures LOC поверх готовых общих prerequisites. Generated/vendor/docs/native implementation/годовые operations исключены. Диапазоны перекрываются и не суммируются между таблицами. Уверенность в LOC до inventory **3–4/10**. Для каждой альтернативы нужен проверочный сценарий, способный изменить рекомендацию; без такого сценария сравнение косметическое.

### D1. Гранулярность следующей самостоятельной capability

Уже выбранные S1/S2 libraries сохраняются. Для сопоставления берём одну следующую capability с двумя тесными features, одним owning team, одной обязательной реализацией и конкретным внешним consumer. Предполагаем, что пока нет разных runtime/native dependencies и отдельных release promises. P/T — только packaging/public surface/example/contract-test overhead этого же поведения, не полный implementation.

Это три возможных **объёма независимой поставки для данного сценария**, а не три несовместимых архитектурных философии: A — один новый family tarball с нужными subpaths; B — та же responsibility остаётся subpath существующего owner tarball, если независимая польза/closure отсутствует; C — features становятся двумя independently consumed tarballs, когда факты подтверждают независимый lifecycle/consumer. Subpaths допустимы внутри A/C. Если concrete consumer требует standalone library, B отпадает по library-first, а не побеждает по меньшим LOC.

| Вариант | С / Н / У | P / T LOC | Сильнейшее возражение и условие применения |
| --- | --- | --- | --- |
| **A. Capability-family package + private cohesive helpers** | **4 / 8 / 9** | **300–900 / 700–1 800** | Family может распухнуть. Проверяем независимые reasons-to-change, dependency closure и change fan-out |
| B. Subpath того же owner package | 3 / 8 / 7 | 150–600 / 450–1 400 | Subpath не отделяет installation deps. Только для тесной одной responsibility; не переносим known reusable concern «на потом» |
| C. Несколько независимо versioned feature packages | 8 / 7 / 5 | 1 000–2 800 / 2 000–5 500 | Compatibility matrix и setup cost. Допустимо при реальных независимых owners/consumers, а не package-per-file |

**Рекомендация A.** C может стать правильным после появления независимых потребителей. Killer experiment: реальный второй consumer использует одну feature, но обязан устанавливать/согласовывать весь чужой lifecycle. Тогда границу нужно пересмотреть, независимо от количества строк.

### D2. Release policy следующих libraries

Для D2 берём отдельный неизменный tuple: уже необходимые public owner-contract package, один независимо распространяемый adapter package и один и тот же первый 0.x consumer. Обе versioned units существуют во всех A/B/C; эта таблица не требует нового package split и не сравнивает версии единственного tarball из D1-A. Сравниваем начальный operational support promise: A допускает отдельные выпускаемые версии этих двух units с одной квалифицированной комбинацией для effectful deployment; B синхронизирует их release numbers и поддерживает одну combination; C дополнительно поддерживает проверенное окно комбинаций тех же units. Coordinated train может присутствовать во всех трёх: это не отдельная ось доверия. Цены — release glue/fixtures, не engine; support window стоит больше не из-за номера версии, а из-за дополнительных доказанных комбинаций.

| Вариант | С / Н / У | P / T LOC | Сильнейшее возражение и предел |
| --- | --- | --- | --- |
| **A. Independent SemVer + coordinated qualified train для связанных cuts** | **4 / 8 / 9** | **200–650 / 500–1 500** | Train может стать вторым resolver. Используем существующие version/adoption/composition records |
| B. Lockstep versions тех же двух units | 3 / 8 / 7 | 150–450 / 400–1 100 | Лишние каскадные releases; одинаковый номер не гарантирует compatibility. Подходит одной реально совместной поставке |
| C. Те же две units + N/N−1 compatibility window | 8 / 7 / 5 | 900–2 300 / 2 000–5 500 | Матрица и backports до actual demand; только после support promise Q5 |

**Рекомендация A.** S1/S2-A/B выпускаются independently, когда их contracts/consumers готовы. Full S2-C/D store требует fresh S3 owner surfaces и bounded S5 public-export prerequisites. «Независимые версии» не разрешают публиковать неполный store. Exact graphs/tuples проверяются перед effectful activation; нет нового release coordinator service. N/N−1 в C относится к явно перечисленным API/package/deployment/durable-profile combinations. Это **не negotiation соседних capability revisions**: current CMS требует exact revision на binding edge, включая additive bump. Изменение этого механизма требует отдельного upstream successor; совместимость API достигается explicit adapters/records/tests внутри принятой модели.

### D3. Дополнительный G3 harness: три кандидата, выбор по реальному consumer

| Вариант | С / Н / У | P / T LOC | Самый сильный риск |
| --- | --- | --- | --- |
| A. OpenAI Agents SDK TS, cooperative process-free | 4 / 8 / 8 | 1 200–2 800 / 2 000–4 500 | Слишком похожая TS среда скрывает provider DTO coupling и не проверяет physical isolation |
| B. Microsoft Agent Framework, managed external | 7 / 8 / 6 | 2 500–5 500 / 3 500–7 500 | Языковой bridge/packaging съедает scope; не переносить workflow/session owners в AE |
| C. Google ADK, managed external | 7 / 7 / 6 | 2 800–6 000 / 4 000–8 000 | At-least-once resume конфликтует с обычным no-replay promise |

Общий scope: один adapter, new bindings, text/function-tool path, bounded output, truthful cancellation, external usage example и соответствующие tests. Не обещаем одинаковую execution topology, hostile isolation или resume. В B/C native custody остаётся у existing owner, approved transport direction сохраняется. Для C допустим initial profile без resume. В A cooperative failure boundary явно иной. Python OpenAI guardrail/retry evidence не переносится автоматически на TypeScript: exact selected TS adapter проверяется отдельно. New binding и запрет resume сами по себе не доказывают отсутствие внутренних model/tool retries у любого harness. Ordinary baseline гарантирует runtime-owned dispatch/one turn-start; более широкая гарантия требует inventory и qualification всех заявленных внутренних effect paths.

**Рекомендация: не реализовывать ни один только ради диаграммы.** При отсутствии consumer технический falsification fixture проверяет process-free neutrality. При появлении consumer его required language/effects определяют A/B/C; для TS-only cooperative потребителя A дешевле. Полные контраргументы и experiments — framework research §5. Эти варианты не заменяют текущий Codex S1/S2. AI SDK/OpenHands/PydanticAI не объявлены проигравшими: они рассмотрены в library research; actual G3 shortlist пересобирается по потребителю, а не фиксируется как мировой top-3.

### D4. Durable business workflow поверх runtime

| Вариант | С / Н / У | P / T LOC | Самый сильный риск |
| --- | --- | --- | --- |
| **A. Public runtime API, без нового workflow engine сейчас** | **3 / 8 / 9** | **200–600 / 600–1 400** | Если product обещает многошаговую работу на дни, можно случайно начать писать собственный workflow engine |
| B. Temporal consumer adapter | 7 / 8 / 7 | 900–2 000 / 1 400–3 200 | Activity retry/timeout создаёт вторую technical recovery authority |
| C. Restate consumer adapter | 6 / 8 / 6 | 800–1 800 / 1 300–3 000 | External effect/journal gap и cyclic exclusive waits |

Scope A намеренно уже: техническая durability runtime, без нового arbitrary durable business workflow promise. При реальном требовании multi-day progression B/C сравниваются с уже существующим consumer mechanism. В обоих вариантах AE остаётся dispatch authority. Wrapper не вводит новые mutation retries/readback recovery; разрешены только owning S2 identity/settlement/terminal observations, и ни один readback не даёт права launch.

**Обязательная граница B/C:** retry policy off не устраняет crash replay внешнего вызова до journal commit. Для повторной подачи нужен доказанно repeat-safe public submit с тем же trusted `(tenant, project, commandId)` и command fingerprint; duplicate возвращает допустимое observation, никогда не dispatch ownership. Его retained identity/receipt horizon покрывает весь поддержанный replay/restore horizon wrapper. После expiry нужен retained proof/tombstone либо явный отказ; новый commandId автоматически не создаётся. Если public API/profile этого не обеспечивает, такой workflow path неподдержан до соответствующего owner delivery.

Cancel signal не заменяет physical-stop receipt. **Default A не блокирует G0–G2.** Полный adversarial разбор — durability research §7.

## 5. Продуктовые вопросы владельцу

Ответ на «делать ли отдельными библиотеками?» уже дан пользователем: **да**. D1/D2 имеют технический default; существующие PostgreSQL/native/transport choices не требуют повторного решения. Три действительно существенных product promises уже сформулированы в каноническом [Q1/Q2/Q6](agent-runtime-foundation-decisions-and-review.md#3-семь-настоящих-продуктовых-развилок). Здесь уточняется момент решения:

| Вопрос | Три подготовленных направления | Рекомендуемый следующий выбор | Когда ответ меняет работу |
| --- | --- | --- | --- |
| Q1: кому поддерживаем написание сторонних adapters? | Обязательные ports / дополнительная поддержанная family+portable kit / сразу несколько independently supported families | **B: одна дополнительная family при её первом external consumer** | До дополнительного public kit/support promise. Required ports уже поддерживаются во всех вариантах |
| Q2: runtime extension code trusted или hostile? | Trusted/cooperative adapters / isolated executable backend / ограниченные Wasm tools | **A для первого runtime** | До executable extension admission. Изоляция самого agent workload остаётся отдельной native обязанностью |
| Q6: какое interruption обещаем при обновлении? | Drain+maintenance / old pinned executions+new workers / bounded-interruption controller+worker+store evolution | **A сначала, B по fleet потребности** | До upgrade SLO; durable state/cleanup obligations сохраняются во всех вариантах |

Их канонические таблицы уже содержат С/Н/У и P/T, а полный новый cross-review охватывает все семь Q1–Q7. Остальные Q3/Q4/Q5/Q7 — worker infrastructure, partition budget, support horizon, restricted-network delivery — остаются stage-specific и не блокируют первые libraries. Выбор scoped weaker promise никогда не маскируется прежним profile name.

## 6. Узкая дельта к реализации

1. **S1/S2 public boundaries:** пользоваться уже предусмотренными packed caller и implementer cases; дополнительно проверять dependency closure и import/construct side effects там, где library заявляет passive semantics. Не строить новую систему checker-ов.
2. **OBS-ADOPT и selected output adapters:** добавить controlled off/on semantic parity с фиксированными clock/inputs/provider responses и pause/control-flow classification на consumer path. Накладные расходы, реальные timeout crossings и overload outcomes не обязаны совпадать. Исходный LangGraph fixed case даёт контрпример; новый универсальный event bus не нужен.
3. **S3/S4 effects:** для selected profile назвать protected effect unit/owner и entrypoints, включая direct/delegated/hosted paths; проверить grant/revocation там, где такое enforcement обещано. Remote delayed command проверяется у target по existing fencing/cutoff contract; caller-side grant read не доказывает instantaneous revocation. Неперехватываемый path исключается из strict profile или получает честную отдельную гарантию.
4. **G3 session/output:** before activating continuation явно описать attach/replay/rerun/reset и authority. History-input ownership, call/result pairing, redaction+typed reload+cursor включить только в срез, который действительно выполняет эти transformations. Допустимое содержимое проходит PA/RS admission/minimization до persistence/export; immutable projection не означает хранить raw secrets, чтобы потом скрыть их в UI. Unsafe structural values требуют codec-safe representation или отказа, без blanket exemption; PA credential custody следует отдельной owning policy.
5. **S2/S3/S5 evolution:** сохранить dependency-complete publication graph, required public implementer compatibility и private suite. Дополнительный public kit не копирует closed internal tests.
6. **G4/G5:** существующие capacity/unknown/cleanup/fencing invariants и qualification charter продолжают действовать. Новый research не доказывает 10k, exactly-once или hostile tenancy.

Ни новый capability, ни optional middleware не создаются лишь для заполнения каталога. Каждый материализуется с owning implementation и реальным consumer. Если bounded spike проваливается, сначала сужаем обещание или исправляем владельческую границу, затем принимаем дополнительную архитектуру.

## 7. Research completion и оставшаяся неопределённость

Нужный plan найден и прочитан. Исследования сохранены по трём направлениям, lessons сведены в единый реестр с источниками. Два круга независимой критики завершены: проверены все указанные тройки, прежние Q1–Q7 и traceability к S1–S5. Существенные замечания исправлены и повторно прочитаны; итог, точные hashes входов и отдельные результаты validation находятся в [review record](../spikes/agent-runtime-modular-research-review.md). Закрытие замечаний относится к исследовательскому тексту, не к ещё не созданной реализации.

Пока не известны exact first external consumer, customer support horizon и новые deployment promises. Предположения и LOC не заменяют их выбор. Ни один конкурентный benchmark не проводился, source changes не выданы за released fixes, runtime code и dependency pins этой documentation delivery не меняются.
