---
id: runtime.architecture.foundation-decisions-and-review
type: architecture
status: active
owner: architecture
summary: Selected technical defaults, evaluated product alternatives, review dispositions and validation for the greenfield foundation plan.
---

# Agent Runtime Foundation Decisions and Review

## Purpose

Зафиксировать выбранное техническое направление, реальные продуктовые развилки, цену альтернатив и результаты пересмотра [greenfield foundation plan](agent-runtime-greenfield-foundation-plan.md). [Исследовательское приложение](../spikes/agent-runtime-industry-architecture-research.md) хранит первичные источники, причины чужих ошибок и ограничения выводов. Этот документ не принимает ADR, не квалифицирует runtime и не заменяет implementation inventory.

Исследованный baseline: `518f1449acf6dda793662783ec9d918d4007c563`, 26.10.2026, draft PR #235. Новый scope — целевая greenfield-система, а не только исправление текущего bounded ordinary-среза. Существующие нормативные owners и immutable decisions продолжают действовать.

## Ownership boundary

Технические defaults ниже предлагаются владельцам соответствующих capability; продуктовые обещания выбирает владелец продукта. Native implementation/release/qualification принадлежат существующей native lane. Runtime не присваивает себе её keeper/init/client/journal и не добавляет второго custody owner. Отдельная reusable library Operations остаётся в semantic ownership Agent Execution.

## Invariants

F01–F18 основного плана обязательны в scope активируемого среза. Более дешёвая альтернатива может обещать меньше возможностей или меньшую доступность; она не может называть unknown «успехом», удалять unresolved obligations, ослаблять чужую authority или выдавать fixture за physical qualification.

## 1. Технические решения, для которых не нужен новый вопрос владельцу

| Решение | Почему выбираем | Достаточная реализация / ограничение |
| --- | --- | --- |
| Четыре accepted contexts: AE, PA, RS, Runtime Configuration | Это существующие смысловые и транзакционные owners | Ordinary Operations — reusable механизм AE, Host — composition/lifetime, Observation — read-only projection. Capacity сначала AE port; выделение нового context обосновывается независимым ownership/lifecycle |
| TS application/SDK + существующая Rust native custody | Язык соответствует нынешним границам, а безопасность проверяется authority/custody contract | Без общего Rust rewrite, нового Go supervisor или Wasm-host prerequisite. Их реальный measured use case получает отдельный срез |
| Малые consumer-owned ports и adapters, выбранные closed profiles | Сохраняют ответственность и допускают разные целые harnesses | Не universal BaseAgent/history/repository. Unsupported capability даёт явный отказ; fake PID/drain не принимается |
| Public reusable mechanisms с первого полезного релиза | Пользователь хочет компоненты для внешних consumers и независимую эволюцию | Реальный consumer + packed disposable project. S1/S2 package identities сохраняются; helper не обязан становиться пакетом |
| Один semantic store contract, конкретные adapters | Domain задаёт atomicity/preconditions/outcomes; adapter задаёт SQL и реальное IO | Первый ordinary S2 — PostgreSQL. Более широкий accepted foundation сохраняет SQLite local/desktop и PostgreSQL hosted; не реализуем второй store ради интерфейса |
| ConnectRPC/Protobuf/Buf для принятой runtime wire direction | Это уже принятое направление, оно не переоткрывается списком чужих протоколов | ACP/A2A/gRPC/Jupyter — источники semantics/adapter lessons; они не заменяют наш public SDK или accepted transport |
| Finite local admission до acceptance + actual IO accounting | Нельзя сначала пообещать owned work, потом искать для него место | Считаем pending, accepted obligation, actual acquisition, closing/debt. Вычисленный envelope достаточен без limiter на каждый helper |
| Truthful uncertainty и single effect owner | Ни ACK, ни checkpoint не атомарны с произвольным внешним эффектом | Ordinary сохраняет one-shot restrictions; broader accepted known-not-accepted retry имеет свой proof и стабильную semantic identity |
| Очередь/fleet расширяют AE/C0–C3 через ports | Worker wake-up, placement и quota не дают новую authority | Не добавляем второй scheduler/allocator beside существующий capacity plan; не держим внешнее IO под row lock |
| Existing SDK-growth/EF/FMS/CMS и packed routes | В репозитории уже есть механизмы graph/surface/release контроля | Расширяем текущую декларацию/check. Нет второго contract registry, build orchestrator или «сертификатора» |
| First local/remote library cuts не ждут 10k experiment | Независимые границы дают полезный результат раньше fleet | Native effectful activation ждёт real tuple; scale/security claim ждёт свою кампанию; pure S1/S2 не ждут G5 |

### 1.1 Какие формы переиспользования поддержать

Для каждой public concern в её существующем README/contract/adoption record записываются semantic owner, audience, explicit exports, invariants/failure outcomes, acquired/borrowed lifecycle, supported profile и stability promise. Общий пакет всех domain interfaces не создаётся. Public caller API не протаскивает provider session, ORM/pool, native DTO или весь assembly graph.

**Caller и implementer — разные аудитории.** Добавленный обязательный метод может сломать сторонний adapter, хотя caller по-прежнему компилируется. Поэтому объявленный public implementer contract получает отдельный compile case и необходимую portable suite. Это перенос различия из [OpenTelemetry stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/), а не автоматическое принятие его LTS policy.

Обязательные ports/types уже опубликованной factory, включая выбранный S2 `./composition`, с первого релиза являются её public implementer contract для заявленного profile. Это не зависит от Q1. Нужны README semantics/failures/lifetimes, отдельная packed implementer compilation и необходимые независимые behavior cases; intentional implementer break следует 0.x migration policy. Внутренние ports, которые consumer-у не нужны, остаются private.

S2 `runtime-storage-conformance` остаётся **private и test-only**. При Q1-B/C публикуется отдельный owner-reviewed узкий testing export/kit для выбранного public contract; private joined suite целиком не публикуется. Dependencies направлены conformance → owners/adapters. Production не импортирует conformance; owner не получает обратную devDependency на suite, уже зависящую от него. Независимые expected outcomes не генерируются production mapper-ом. Fake pass не доказывает native stop, hostile isolation или 10k capacity.

### 1.2 Рост кода и feedback loop

Build graph следует настоящим package/dependency boundaries. Измеряем cold build, changed-leaf build, public-contract fan-out, память и editor latency на выбранном TS baseline. Project references/incremental build допустимы, когда дают эффект и поддержаны toolchain; новый build framework не нужен из-за предположения о миллионах строк. Curated public return types не должны выводить гигантские внутренние graph types в declaration surface. [Node exports](https://nodejs.org/api/packages.html#package-entry-points), [TypeScript references](https://www.typescriptlang.org/docs/handbook/project-references.html) и [performance guidance](https://github.com/microsoft/TypeScript/wiki/Performance) — средства и tradeoffs, не обещание масштаба.

Governed feature size/shape, visibility и split signals остаются у FMS/CMS. Code review проверяет change locality и semantic ownership вместе с автоматическими import rules. CI routing учитывает фактические inputs/versions/platform; source-only cache не переиспользует evidence после изменения SQL/native/compiler inputs. Существующие changed/fast/full checks сохраняют свой смысл.

### 1.3 Что заложить сразу, но не реализовывать пустым каркасом

| Будущая возможность | Что фиксируем сейчас | Что ждёт реального consumer |
| --- | --- | --- |
| Новый whole harness | Разные оси model/protocol/harness/environment; neutral binding; profile semantics | Реальный adapter и exact E2E; process-free fixture только для опровержения лишнего process requirement |
| Long session / human wait | AE ownership, opaque state binding, version/retention, continuity and approval authority | Конкретный live-bounded или durable-parking profile; не универсальная conversation history |
| Remote workers | Immutable command identity, target-side authority/cutoff, lost ACK semantics | Actual transport/backend/security/receipt qualification |
| Fleet | Resource vector, accepted backlog boundary, C0–C3 ownership, fairness и shared account scope | Реальная queue/placement/infrastructure adapter и measured campaign |
| Hostile executable extension | Trust class, executable admission отдельно от scoped data reads | Один выбранный isolation backend и его platform/patch/network qualification |
| Rolling release / HA | Раздельные API/wire/state/profile/artifact identities; retained cleanup path | Конкретная upgrade/promotion topology и измеренный interruption/RPO envelope |

Если remote backend не способен дать доказательство требуемого profile, он **не допускается к этому profile**. Можно определить отдельный честно более слабый продуктовый profile, но нельзя сохранить прежнее имя гарантии и вернуть синтетический receipt.

## 2. Как читать оценки вариантов

**У** — уверенность в пригодности варианта при указанном scope, **Н** — ожидаемая надёжность выполнения именно его обещания, **С** — сложность реализации/поддержки. Шкала 1–10; большая С означает больший burden. Это инженерные оценки, не measured SLA, security score или рейтинг vendors. Надёжность cooperative adapter и hostile execution сравнивается только с их разными заявленными threat classes.

**P** — incremental handwritten production + integration LOC; **T** — tests/fixtures LOC. Диапазоны не включают generated/vendor code, native lane implementation, cloud configuration, документацию и многолетнюю поддержку. Они оценивают первый полезный срез при уже доставленном общем фундаменте, а не весь runtime. Альтернативы и таблицы частично перекрываются; складывать их в project budget нельзя. Уверенность именно в LOC до inventory — обычно **3–6/10**, даже если архитектурный default имеет У=8–9. Точные counts появятся после списка existing surfaces, reused code, adapter/backend и test obligations.

Пользователь уже выбрал public reusable libraries и расширяемую систему. Это не открытый вопрос. Следующие развилки касаются **дополнительных продуктовых обещаний**; указанные defaults позволяют продолжить G0–G2 без ожидания ответов.

## 3. Семь настоящих продуктовых развилок

### Q1. Насколько широко расширяем ecosystem support сверх обязательных public ports?

**Рекомендация для заявленного видения: B — дополнительная выбранная family и portable kit при первом соответствующем external consumer.** Уже выбранные публичные S1/S2 factory/required-port contracts поддерживаются с их первого релиза во всех вариантах. Вопрос касается расширения independently supported families/testing distribution/support promises, а не отсрочки usability библиотеки. Открытая экосистема не требует marketplace, discovery или hot replacement.

| Вариант | Обещание и tradeoff | У / Н / С | P / T |
| --- | --- | --- | --- |
| A. Ограничить ecosystem обязательными public ports первого package/profile | Публичные implementer inputs поддержаны; готовые production adapters сначала ведут maintainers, новых отдельно сопровождаемых families/kits нет | 9 / 8 / 2 | 0–250 / 200–650 |
| **B. Дополнительная independently supported capability family / portable kit** | Точный owner contract, portable kit и migration example; независимый consumer не использует private imports/credentials | **8 / 8 / 5** | **600–1 800 / 1 500–4 000** |
| C. Сразу несколько независимо versioned adapter families | Сразу больше ecosystem obligations: compatibility windows, release notices, поддерживаемые combinations | 6 / 7 / 8 | 1 800–5 000 / 4 000–10 000 |

**Когда ответ нужен:** до дополнительного independently versioned family/kit/support promise. Выбирается конкретная дополнительная family, а не все внутренние ports. Уже экспортируемые обязательные implementer inputs не ждут этого ответа. Private S2 kit сохраняется во всех вариантах. Default B отражает пользовательскую цель; C без реальных authors расширит support surface раньше проверки usability. Цены не включают повторно обязательную first-package usability, уже заложенную в S1/S2.

### Q2. Нужно ли запускать произвольные недоверенные executable extensions?

**Рекомендация: A для первого продукта.** Public adapter contract не означает, что любой загруженный JS безопасно исполняется внутри Host. Это вопрос расширений самого runtime; выбранная native изоляция agent workload остаётся отдельной обязательной границей.

| Вариант | Обещание и tradeoff | У / Н / С | P / T |
| --- | --- | --- | --- |
| **A. Trusted/cooperative runtime adapters** | Владелец установки допускает executable code; разделяется TCB Host. Не обещаем malicious-plugin containment | **8 / 9 cooperative / 2** | **0–550 / 200–900** |
| B. Arbitrary executable через существующую custody и один qualified isolated backend | Отдельные spawn/caller/tool/provider grants, physical limits и fault boundary; не новый собственный sandbox engine | 5 / 8 conditional / 7 | 3 700–7 500 / 4 000–8 000 |
| C. Только ограниченные Wasm component tools через существующий host | Typed ABI и малый класс tools; host imports/calls/cache остаются частью TCB. Не whole-harness portability | 4 / 8 narrow scope / 6 | 2 500–5 700 / 3 500–7 000 |

P для A включает 0–400 runtime + 0–150 integration; B — 3 000–6 000 + 700–1 500; C — 2 000–4 500 + 500–1 200. **Когда ответ нужен:** перед executable extension admission, G3/G5. Цены исключают реализацию native backend, component host, marketplace и fleet. Основание: [Node permissions](https://nodejs.org/api/permissions.html), [Wasmtime security](https://docs.wasmtime.dev/security.html) и K11/K12 исследования.

### Q3. Какую worker инфраструктуру мы сами будем поддерживать первой?

**Рекомендация: A — self-hosted Linux VM workers с выбранным native/Docker profile после его реальной qualification**, затем autoscaling adapter при потребности. Kubernetes уместен, если команда уже его эксплуатирует. Ни один бренд не даёт hostile tenancy автоматически.

| Вариант | Обещание и tradeoff | У / Н / С | P / T сверх общего fleet contract |
| --- | --- | --- | --- |
| **A. VM worker pool** | Прямая native custody, понятный operator scope; обновления/узлы ведёт оператор | **8 / 8 / 5** | **700–1 600 / 1 200–2 500** |
| B. Kubernetes worker pools | Reuse существующей cluster operations; daemon/socket/mount topology отдельно квалифицируется, workload не получает control socket | 7 / 8 / 7 | 900–2 200 / 1 500–3 500 |
| C. Managed execution/sandbox provider | Меньше node operations, больше зависимости от receipt/stop/idempotency/SLA и recurring cost vendor | 5 / 7 / 6 | 1 000–2 500 / 1 800–4 000 |

**Когда ответ нужен:** до первого G4 deployment adapter. Это оценка одного собственного adapter/conformance route, не инфраструктуры provider и не total cost of ownership. Более слабый remote receipt требует другого profile; синтетический physical-stop receipt недопустим. Источники exact-topology урока и hosted scope — каталог исследования: SWE-ReX, agent-sandbox, E2B/Modal/Firecracker, LiveKit, AgentCore.

### Q4. Что делать с глобальным provider-account бюджетом при потере координации?

**Рекомендация: A — strict pre-send reservation, новые запросы ждут или получают отказ.** Это технический default до отдельного требования продолжать работу при partition. Hard bound возможен только при консервативно ограниченной exposure; неизвестный итоговый billing не скрывается обещанием абсолютного финансового cap.

| Вариант | Обещание и tradeoff | У / Н / С | P / T относительно strict G4 |
| --- | --- | --- | --- |
| **A. Central strict reservation** | Конечная поддержанная exposure; потеря authority уменьшает availability новых requests | **8 / 9 / 5** | **+0 / +0** к общему G4 |
| B. Предварительно выделенные bounded escrow credits | Часть работы продолжается при partition; crash удерживает capacity. Credits не дублируются и остаются вычтенными до settlement/revocation proof | 6 / 8 / 8 | +800–1 800 / +1 500–3 000 |
| C. Soft budget / fail-open | Выше availability, возможен явно принятый overshoot; не вариант для hard-cap обещания | 7 / 8 в пределах soft-policy обещания / 4 | −200…+400 / +300–800 |

**Когда ответ нужен:** до обещания cross-worker/account limits и partition availability. TTL не возвращает возможно потраченные credits. PA/deployment владеют account scope; product cost priority mapping остаётся снаружи. Local PA cap и mutex не превращаются в global coordination. [LiteLLM production](https://docs.litellm.ai/docs/proxy/prod) и [account limits](https://docs.litellm.ai/docs/proxy/users) — ориентиры по scope; конкретный reservation design наш.

### Q5. Насколько старые клиентские установки поддерживаем после стабилизации?

**Рекомендация: A.** Текущая accepted 0.x policy с deliberate minor breaking changes и migration notes остаётся. Этот вопрос не объявляет сегодняшнее API стабильным и не разрешает старым binaries писать новый format.

| Вариант | Обещание и tradeoff | У / Н / С | P / T для начальной support matrix |
| --- | --- | --- | --- |
| **A. Один active stable major, fixes на latest minor** | SemVer commitments соблюдаются; major migration имеет объявленный transition period, отдельные old-minor продукты не ведём | **9 / 8 / 3** | **100–400 / 300–900** |
| B. Current + previous major в ограниченное окно | Операторы обновляются независимо; explicit SDK/server/implementer/schema combinations. 6–12 месяцев — возможный, не принятый срок | 7 / 8 / 6 | 800–2 400 / 1 800–5 000 |
| C. Несколько LTS линий на годы | Recurring backport/security/release/platform work; возможные 2–3 года требуют staffing/native/dependency policy | 5 / 8 / 9 | 1 800–5 000 / 3 500–9 000 |

**Когда ответ нужен:** перед stable/GA/customer support promise, особенно Q1-C. LOC не включают годы fixes/backports. Окончание поддержки версии не разрешает удалить последний нужный recovery decoder/query/cleanup path. Caller/implementer promises различаются; [OTel](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) даёт полезную классификацию, не обязательный срок.

### Q6. Какое прерывание допустимо при обновлении нового runtime?

**Рекомендация: A сначала, B для первого fleet rollout при потребности.** Initial S2 fresh/empty cutover и refusal populated legacy уже выбраны; ни один вариант не делает старую миграцию автоматической. Это availability upgrade, а не перенос истории между разными harnesses.

| Вариант | Обещание и tradeoff | У / Н / С | P / T сверх уже доставленного fleet foundation |
| --- | --- | --- | --- |
| **A. Stop new admission → drain/reconcile → verified forward migration** | Честное maintenance window, retained recovery, отказ unsupported transitions; нет live replacement | **9 / 9 / 3** | **150–600 / 500–1 500** |
| B. Новые workers принимают работу, старые pinned executions завершаются | Общий state совместим в объявленном mixed-version окне; incompatible migration ждёт старых writers. Controller/store всё ещё могут приостанавливать admission | 7 / 8 / 6 | 1 200–3 500 / 2 000–6 000 |
| C. Ограниченное interruption при rolling controller/worker/store evolution | Измеренный SLO exact profile, expand/contract migration, fencing, rollback/forward-repair. Не универсальный zero downtime | 5 / 8 / 9 | 3 000–8 000 / 5 000–12 000 |

**Когда ответ нужен:** B до fleet rolling update, C до hosted upgrade SLO. [Restate versioning](https://docs.restate.dev/services/versioning) иллюстрирует разные обязанности pinned execution и shared state. Backup не стирает внешние эффекты после restore point; rollback допускает только proven compatible code/data. Цены не строят fleet повторно.

### Q7. Нужна ли restricted-network или полностью disconnected установка?

**Рекомендация: A; B при первом enterprise/on-prem consumer.** Это доставка artifacts, не offline model/provider promise.

| Вариант | Обещание и tradeoff | У / Н / С | P / T |
| --- | --- | --- | --- |
| **A. Online acquisition exact approved artifacts** | Обычная registry/image delivery через существующую release verification; никакого произвольного latest at runtime | **9 / 8 / 2** | **0–250 / 150–500** |
| B. Customer mirrors, без неожиданных public fetches | Dependency/image closure, registry overrides, лицензии и повторяемая installed identity | 8 / 8 / 4 | 300–1 200 / 600–2 000 |
| C. Sealed offline bundle с offline verification | Exact package/native/image/migration/tool closure; install/repair без сети; vulnerability-response доставка — обязанность оператора | 6 / 8 / 7 | 1 200–4 000 / 1 800–6 000 |

**Когда ответ нужен:** до такого packaging promise. Native builds/signing/OS expansion не входят в TS integration LOC. Провайдер всё ещё может требовать сеть или отдельную поддержку local model. Provenance зависит от реальной public/private registry/workflow route ([npm](https://docs.npmjs.com/generating-provenance-statements/)); не меняем visibility ради badge.

## 4. Операционная политика, которую нельзя подменить вариантом реализации

Default HA foundation — не разрешать повтор после потери acknowledged authority. Для конкретного hosted profile выбираются replication/promotion/fencing и заявляемый RPO; synchronous authority durability в выбранном failure envelope может быть необходима для безопасного автоматического failover. При неподтверждённой сохранности authority новый admission/redispatch закрывается до reconciliation. «Потерять accepted identity и повторить» не дешевле допустимый вариант надёжности. Межрегиональная topology и availability обещания потребуют конкретного deployment inventory; этот документ не оценивает их выдуманным количеством TS строк. Основание: [PostgreSQL replication](https://www.postgresql.org/docs/18/warm-standby.html), [promotion/fencing](https://www.postgresql.org/docs/18/warm-standby-failover.html).

Whole-harness replacement разделяется на выбор новой binding, совместимое продолжение existing session и явный cross-harness import/export с документированными потерями. Технический default — первая возможность сейчас и accepted AE continuity для конкретного session среза; universal lossless migration не обещается. Длительные human waits выбирают supported durable parking при реальном consumer; bounded live wait сохраняет первоначальные limits. Продуктовый workflow не получает ownership технической AE authority.

## 5. Что было рассмотрено и сознательно не включено

| Предложение | Решение и причина | Условие возврата |
| --- | --- | --- |
| Сделать всё микросервисами сразу | Не требуется для library reuse; увеличивает partial failures и delivery cost | Независимая capacity/failure/trust/operational boundary |
| Universal AgentManager/BaseAgent и portable conversation schema | Смешивает разные owners и делает слабую семантику общей | Только конкретный bounded shared contract с доказанной одинаковой семантикой |
| Нативно переписать всё на Rust/Go | Язык не решает лишние reads, accepted-state loss или wrong authority | Измеренный CPU/latency/TCB use case с сохранением owners |
| Mandatory Wasm/microVM/global broker/consensus для embedded SDK | Добавляет чужие operational assumptions к простому consumer | Конкретный selected trust/deployment profile |
| Второй production store/harness только для демонстрации abstraction | Дублирует product work, но не доказывает все контракты | Реальный consumer; до него независимый structural/behavior case |
| Отдельный central contracts package со всем domain | Увеличивает change fan-out и смешивает owner language | Только узкий язык настоящей owner boundary |
| Новый public conformance framework или публикация private S2 kit | Уже есть runner/cases и выбранный private scope | Owner-reviewed узкий implementer export при Q1-B/C |
| Event sourcing default, global event bus как source of truth | Replay не даёт external transaction, журнал требует своего ownership/retention | Конкретная необходимость и новый принятый ADR, без дублирования custody |
| Немедленно новый output backend/compact query/global index | Baseline cost — повод измерить, не доказательство провала нового S2 | Bottleneck envelope при сохранении authority/readback invariants |
| Все historical issues индустрии назвать сегодняшними уязвимостями | Неверный статус и scope создадут ложные blockers | Только проверенный текущий дефект с воспроизводимым нашим path |

## 6. Протокол самостоятельных и независимых пересмотров

Первый полный draft подготовлен до независимой критики нового vision. Самостоятельные проходы и независимые reviews ниже имеют раздельный статус; незавершённый проход не считается выполненным.

| Проход | Область | Статус / содержательный результат |
| --- | --- | --- |
| Self-review 1 | Authority, ownership, полнота исходных findings и новых исследований | Выполнен: явно сохранены четыре contexts, SQLite/PG и Connect/Buf; Operations закреплён под AE; ordinary retry отделён от broader known-not-accepted; уточнены capability/API versions, capacity reserve/bind, paused-worker fencing, session replacement и executable/data trust |
| Self-review 2 | Минимальность, executable acceptance, версии, источники, LOC и вопросы | Выполнен: F01/F05–F08/F14 перенесены в S2 acceptance; native/output/topology и Host limits связаны с S3–S5; убрано ложное впечатление уже qualified Docker profile; закреплены exact CMS delta/source-vs-release; Q1-B выбран под external-consumer цель, LOC остаются incremental |
| Independent review wave 1 | Domain/libraries, scale/fencing, security/native | Завершена: три независимых GPT-6.1 Sol xhigh review на `0a018f265`; четыре material P2/medium уточнения приняты, ни один не установлен как текущая production vulnerability |
| Independent review wave 2 | Harness/versioning, evidence/status, delivery/minimalism | Завершена: три отдельных GPT-6.1 Sol xhigh review immutable `0a018f265`; пять material P2 уточнений приняты, исправлены attribution и scope одной оценки |
| Delta review | Спорные исправления и отсутствие новых конфликтов | После disposition существенных findings |

Для каждого существенного finding сохраняется: конкретный дефект/контрпример, принятое изменение либо причина отказа, scope/owner и проверка. «Ещё один агент согласен» не заменяет доказательство. Новые советы не принимаются только из-за строгости формулировки; они должны улучшать инвариант без competing authority.

### Disposition первой независимой волны

| ID / scope | Контрпример и решение | Изменение / минимальная будущая проверка |
| --- | --- | --- |
| V01-1, P2/G1 | Q1 мог отложить поддержку ports уже публичной S2 factory. **Принято** | Main §4, здесь §1.1/Q1 и S2 public surface: обязательный public implementer contract с первого релиза; packed caller/implementer и existing independent cases, private suite не публикуется |
| V02-FLEET-1, P2/G4–G5 | Closed-loop arrivals скрывают замедление; краткий 10k run может накопить debt без формального провала. **Принято** | Main §11.1: заранее заданные offered load, duration, throughput/latency/refusal/drift/drain pass/fail; exploratory evidence не qualification |
| V02-FLEET-2, P2/extracted G4 owner | Reservation принята AE, bind задержан, allocator уже reused capacity. **Принято как связь с existing ADR-0001** | Main §8.1: подтверждённая current finalized binding до dispatch; unknown сохраняет bounded delivery obligation. Race bind/expiry/cancel и bind COMMIT/ACK-loss проверяются в этом future profile |
| V03-01, medium/G2 | Credential-free egress мог выглядеть разрешённым самим profile. **Принято** | Main §9, research §5/K11, S3 acceptance: RS остаётся egress authority; legitimate PA upstream не расширяет workload route; denied/allowed public/private cases в existing suite |
| V01 publication clarification, optional | First publish и полный Host cutover — разные моменты. **Уточнено** | S2 release record называет actual consumer/source exercise; fake-only suite не real consumer. Не ждём full native activation или fleet для чистой библиотеки |

Контргипотезы о необходимости нового context/allocator, второго native supervisor, universal history, запрета всех private/public destinations или automatic lease retry отвергнуты: они не следуют из finding и конфликтуют с сохранёнными owners/scope. Три review сохранили существующие положительные protections; количество новых механизмов этим disposition не увеличено.

### Disposition второй независимой волны

| ID / scope | Контрпример и решение | Изменение / минимальная будущая проверка |
| --- | --- | --- |
| V04-01, P2/G3 replaying harness | Reconnect восстанавливает history с новыми IDs; text dedup либо сливает новое событие, либо дублирует старое. **Принято** | Main §7.2, research §3 и S3 output hook: no replay / stable occurrence replay / reconstructed snapshot; reset/mapping и old-live/rebuilt/new-identical case, без ложного gap repair |
| V04-02, P2/первый structured resumable reader | Cursor после `text-start` сохраняется, reducer state при refresh теряется; продолжение с delta нечитаемо. **Принято** | Main §7.2: feed/epoch/representation/version и state/checkpoint/boundary precondition; cross-view/version и state-loss cases, explicit resync/refusal |
| V04-03, P2/G3 interaction | Durable валидное approval переживает удалённый connection-owned callback. **Принято** | Main §5.2: provider interaction/continuation incarnation; decision acceptance отдельно от delivery/enforcement; same-generation reconnect, reused ID, revoke/cancel и unknown ACK cases |
| V05-E01, P2/G0 evidence | Agno queue и session stores различны; non-Postgres session/run records не имеют описанного fencing. **Принято** | Research row 12/K07: точный store/config scope и сохранённая acceptance/terminal-error persistence; D-классификация, без заявления новой vulnerability |
| V06-01, P2/G1–G2 roadmap | Полный store обещан до S3/S5, хотя требуемые owner versions/export cleanup входят в его publication graph. **Принято** | Main §12: ранние S1/S2-A/B независимы; S2-C/D публикуется вместе с нужными owner/export prerequisites до Host activation. Нет execution-only placeholder или ожидания всего fleet |
| V04 attribution, optional | Signed-approval PR не подтверждает representation cursor semantics. **Исправлено** | Research row 14 и §3 дают отдельный официальный Workflow mid-part источник; patch/release coverage из него не выводится |
| V06 score scope, optional | Q4 soft-budget Н сравнивалась с чужим hard-budget обещанием. **Исправлено** | Н оценивает выполнение soft policy; вариант по-прежнему явно непригоден для hard-cap promise |

Q1 implementer finding, независимо повторённый V06, уже закрыт первой волной и не посчитан вторым дефектом. Все три wave-2 review проверяли исходный immutable `0a018f265`, а не одобряли исправления заранее. Поэтому ниже остаётся отдельная delta-проверка изменённых границ. Evidence review дополнительно подтвердил K01–K12 статусы/причины/ограничения, exact CMS source/blob и baseline arithmetic; он не квалифицирует все 52 системы или реальные deployments.

## 7. Validation record

| Проверка | Что она подтверждает | Статус этой ревизии |
| --- | --- | --- |
| Governed creation, indexes, bounded context, docs check/protocol | Существующие типы/metadata/reachability и документационные инварианты | PASS: 102 documents, valid adoption; bounded context exit 0; все 5 frozen-authority tests pass |
| Local relative links, exact authority references, no frozen/accepted changes | Связность плана и отсутствие скрытого переписывания решений | Frozen authority PASS; relative destinations и staged diff проверяются перед каждым push |
| Repository changed/fast/full routes | Реальный доступный consumer gate, с различением environment failures | BLOCKED в текущей среде: `pnpm check:changed` exit 1 — отсутствует `@oxc-parser/binding-linux-x64-gnu`; `pnpm check:fast` и `pnpm check` exit 1 на lint — отсутствует `@oxlint/binding-linux-x64-gnu`. Дальнейшие product phases не выполнены; green full gate не заявляется |
| Remote tree/head/draft readback | Публикацию выбранных bytes в нужный PR | `1654daa0c`, `0a018f265` и `cb8258757` опубликованы с CAS; remote trees совпали с local staged trees, Git author/committer identity проверена; последующие updates проверяются так же |
| Provider/native/PG/10k campaigns | Runtime performance/security/correctness конкретной реализации | Не выполняются этой documentation delivery |

Проверки выполнялись на exact Node 26.11.1 / pnpm 11.18.0. Для documentation workflow зависимости установлены frozen без optional packages/install scripts после нехватки диска при полной установке. Production source, dependency pins и gates не менялись; отсутствие native tool bindings не является проверенным кодовым регрессионным finding. Docs gates и пять frozen-authority tests проходят отдельно от blocked full route.

Открытые продуктовые развилки не означают незавершённое исследование: у каждой есть default, три проработанных варианта, ограничения оценки и момент, когда выбор должен стать явным. Подтверждение преимуществ архитектуры производится реализацией и квалификацией соответствующего среза.
