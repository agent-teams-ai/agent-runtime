---
id: evidence.agent-runtime.modular.durability
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Pinned LangGraph, Temporal and Restate lessons without changing runtime operation authority.
---

# Agent Runtime Durability Research

## Observed target

Primary-source research dated 2026-10-27, baseline `c59fe8364071530d09b48eda47d41620f3f59c25`; exact upstream source identities and limits are recorded below. Related synthesis: [Agent Runtime Modular Research](../architecture/agent-runtime-modular-research.md).

## Method

Static source, manifest, official documentation and selected change-history review. Source facts, documented limits, historical fixes and our engineering inferences are distinguished below. Independent critiques and dispositions are retained in the [review record](agent-runtime-modular-research-review.md).

## Results

Дата чтения источников: **27 октября 2026**. Основа нашего проекта: branch `docs/architecture-program-v3`, HEAD `c59fe8364071530d09b48eda47d41620f3f59c25`, PR #235. Прочитаны greenfield foundation plan, foundation decisions/review, существующий industry research и Engineering Quality Standard; это **дельта**, а не новый конкурирующий план.

**Метод:** чтение официальной документации, package manifests, публичных исходников и diff исправления. Чужие runtime-тесты здесь не запускались. Утверждения имеют статусы **S** (исходники на SHA), **D** (документированная семантика), **H** (подтверждённый исторический дефект, исправленный в проверенном HEAD), **I** (наш инженерный вывод), **P** (план проверки). Rolling docs описывают состояние страницы при чтении; package version из manifest не означает, что именно этот HEAD опубликован stable release.

## 1. Что уже принято и не переоткрывается

- Смысловые owners: Agent Execution (AE), Provider Access (PA), Runtime Security (RS), Runtime Configuration (RC). Operations — reusable mechanism внутри AE, не новый context.
- Первый ordinary S2 использует **PostgreSQL**. SQLite остаётся в более широкой local/desktop foundation; выбор SQLite вместо S2 здесь не предлагается.
- S2 unknown claim не разрешает workload start или automatic mutation/claim retry. Сохраняются ровно предусмотренные S2 bounded identity/settlement/terminal observations; readback не даёт права launch. Новый wrapper не вводит свой recovery path и не ослабляет контракт.
- Runtime исполняет технические операции; teams/tasks/business workflows принадлежат consumer. Temporal/Restate не получают runtime scheduler, private storage tables, custody или право повторить неизвестный эффект.
- Existing native lane сохраняет physical custody; Temporal heartbeat или Restate attempt signal не являются physical-stop receipt.
- Public required ports уже имеют implementer contract. **Private S2 joined storage conformance остаётся private.** Отдельный public kit возможен только для объявленного public API и реального external consumer.

Источники: foundation plan §§3–4, 6.2, 7.3; decisions/review §§1–1.1; architecture-program-plan invariant на строках 195–196. При несовпадении будущего выбранного профиля с этими решениями нужен scoped successor, а не незаметная замена defaults.

## 2. Точный source snapshot

| Проект | Проверенный commit | Версия в прочитанном manifest | Что реально изучено |
| --- | --- | --- | --- |
| LangGraph Python | `858891aaa164ebdacf33b8f5e7f88b38b9132211`, 26.10.2026 | `langgraph 1.2.18` | package dependencies, checkpoint base, public conformance README, fix #9406 |
| Temporal TypeScript SDK | `211c365b8d0e389ffae839b65e46d674d7241c68`, 27.10.2026 | `1.24.0` | workflow/worker manifests и дерево subpackages; официальные semantics docs |
| Restate TypeScript SDK | `b1080a11984b35419e0e825a0e82bc17c656a22d`, 20.10.2026 | `1.17.4` | SDK/core split, public exports/API checks, Context и Request |
| Restate server | `d188f08a3baff61ed3f8892491054ab76a3697be`, 27.10.2026 | не проверялась | Зафиксирован HEAD; server implementation не аудировался |

Они выбраны как разные механизмы: LangGraph — agent/graph orchestration; Temporal — durable workflow; Restate — durable services/objects. Это не рейтинг популярности и не список одинаковых взаимозаменяемых продуктов.

## 3. LangGraph: независимые библиотеки и две разные границы replay

### 3.1 Полезная находка: conformance как самостоятельный продукт

**S.** `langgraph-checkpoint-conformance` — отдельная библиотека, проверяющая контракт checkpoint implementations: сохранение данных/метаданных, namespace isolation и incremental updates. Обязательные base capabilities отделены от optional extension capabilities; отсутствие override optional метода приводит к пропуску его тестов. [LG1]

**I для нас.** Публичный adapter contract должен поставляться с исполнимым способом проверить существенные guarantees. Это сильнее одного интерфейса TypeScript: структурное совпадение не доказывает правильные failure outcomes. Однако мы не копируем всю чужую матрицу. Для нашего уже public required port нужны независимые cases; public portable kit выпускается только при отдельном ecosystem promise. Private S2 kit не становится публичным из-за наличия аналогичной библиотеки у LangGraph.

Отдельное полезное различие: декларация capability и доказательство её поведения. «Метод override-нут» годится для выбора группы тестов, но не является доказательством guarantees. У нас capability profile должен приводить к обязательным rejecting cases и явно названным unsupported outcomes. Это наш вывод, **не утверждение о дыре** в LangGraph: их suite именно тестирует реализацию.

### 3.2 Package boundary не означает отсутствие semantic coupling

**S.** LangGraph отделяет runtime, checkpoint interfaces, конкретные storage adapters, SDK и prebuilt components. При этом package `langgraph` напрямую зависит от `langchain-core`, `langgraph-checkpoint`, `langgraph-sdk` и `langgraph-prebuilt`; checkpoint base использует `RunnableConfig` из `langchain_core`. [LG2, LG3]

**I для нас.** Это показывает реальный tradeoff удобства установки и ecosystem integration. Нельзя объявить LangGraph «монолитом», но количество его libraries не означает полностью независимую semantic surface. Наш внешний consumer Operations не должен получать обязательные Host/provider/SDK dependencies только ради одной durable operation. Для package review проверяем dependency closure, public declarations и executable entry point; не просто размер tarball. Уже принятая outward composition сохраняется.

**P.** Consumer устанавливает один operations tarball с минимальными required ports; отдельный packed implementer project определяет свою реализацию порта; отсутствие Host/native runtime в import closure проверяется реально. Browser/offline обещание проверяем лишь у packages, чей профиль его действительно заявляет.

### 3.3 Новый подтверждённый исторический кейс: pause превратился в ошибку

**H + S.** Commit #9406 исправил два связанных поведения. `GraphInterrupt`/`GraphDrained`, приходя как исключения из tool, ранее превращались в `tool-error`; исправление отделяет paused control flow от failed execution. Второй fix исключает `StreamToolCallHandler` из механизма, который переводил каждый node в streaming mode: в описанном regression case `@task` внутри subgraph возвращал `None`, когда включался tools stream. Diff содержит отдельные regression tests для обоих случаев. В проверенном HEAD исправления уже есть. [LG4]

**I.** Это два конкретных антипаттерна для нашей памяти:

1. Транспорт/observer строит terminal outcome из класса generic exception, не учитывая owner state.
2. Подключение read-only observation меняет execution mode, возвращаемый результат или scheduling semantics.

Достаточная дельта к существующим F02/F07: deterministic fixture «тот же harness task с observation off/on, с pause/drain/resume» с фиксированными clock/IDs/provider responses, одинаковыми принятыми inputs и достаточными budgets; сравнить canonical decisions/result и authorized dispatch/effect counts. Не требовать равной wall-clock latency, scheduling или одинакового terminal outcome при различающихся deadline/overload conditions. Допустимы trace overhead и drop из явно lossy telemetry; недопустим новый dispatch, исчезнувший task result или ложный failure. Для нашего output-stream profile pause имеет собственный статус/continuation; generic adapter не придумывает `completed` только потому, что upstream stream закрылся.

**Что не доказано:** что LangGraph сегодня продолжает этот дефект; что все callback architectures плохи; что exception-based internal control flow всегда недопустим. Наше требование относится к сохранению смысла при пересечении границы.

### 3.4 Урок persisted-code compatibility

**D.** LangGraph по умолчанию применяет текущий deployed graph к сохранённым threads. Старые node names и state schema становятся persisted compatibility surface; rename/remove node, на котором остановлен thread, может сломать resume. Встроенное обновление topology не равно pinning старой business logic. [LG5]

**I.** Для нас это поддерживает уже выбранное разделение execution tuple, storage format и shared schema. «Package minor» и «объект успешно декодирован» недостаточны для восстановления. При paused operation должны сохраняться именно нужные identifiers/decoders/recovery capability по нашему owner contract. Новый rename не принимается автоматически как косметический refactor.

### 3.5 Checkpoint modes и граница обещания

**D.** У LangGraph есть `exit`, `async`, `sync` persistence; durability/latency различаются. Pending writes позволяют не повторять уже успешно завершённые sibling tasks после ошибки super-step. Time-travel replay из старого checkpoint повторно выполняет последующие LLM/API вызовы. [LG6] Interrupt-resume начинает node заново; внешние эффекты до interrupt требуют идемпотентности/правильного разбиения. [LG7]

**I.** Operational recovery, user-requested fork/replay и ordinary retry нельзя скрыть за одним `resume()`. Наш профиль уже ограничивает one-shot operations; перенос возможностей graph replay требует отдельной операции с новой явно разрешённой business intent и сохранением prior effect uncertainty. `sync` checkpoint не закрывает внешний effect/commit gap.

## 4. Temporal: хороший пример library split, но workflow не заменяет AE

### 4.1 Пакеты следуют среде исполнения

**S.** SDK разделяет `workflow`, `activity`, `worker`, `client`, `common`, `testing` и другие subpackages. В проверенном manifest `workflow` не зависит от `worker`; `worker` собирает workflow/activity/client/core-bridge и технические зависимости. [T1, T2]

**I.** Это подходящий ориентир для «наружная composition знает конкретику, переносимая логика не импортирует host». Не нужно переносить точные названия/число пакетов; полезна асимметрия зависимости. Host способен собирать heavy dependencies, semantic library — нет.

### 4.2 Три разных guarantees

**D.** Workflow replay проверяет историю команд и требует deterministic workflow code; внешние I/O и LLM calls выносятся в Activities. Изменение последовательности replay commands нуждается в versioning/patching либо соответствующей worker-version strategy. [T3] Идемпотентность внешнего Activity effect обеспечивается принимающим сервисом, а не магией Activity API. [T4]

**D.** Cancellation cooperative: Activity получает сигнал через поддержанную SDK/heartbeat semantics и может его игнорировать. Timeout и завершение Workflow не равны физической остановке произвольного внешнего процесса. [T5]

**I.** Если consumer выбирает Temporal, Workflow владеет business progression; Activity обращается к public runtime API. AE продолжает владеть operation identity, dispatch claim и admission. Повтор Activity не получает право запустить новый operation ID при неизвестном исходе прошлого. Native stop/custody остаётся в нашей existing lane.

### 4.3 Ограничения — аргументы за bounded representation

**D.** У Workflow history есть limits; документация рекомендует учитывать количество Events, размер history и incomplete operations. Для длинных процессов предусмотрен Continue-As-New. [T6] Это deliberate bounded-resource design, а не «Temporal не масштабируется».

**I.** Consumer workflow history не должен становиться копией каждого agent token, полного artifact и private runtime row. Хранить business state и ссылки на owner receipts; output/body/artifacts остаются в выбранной owner boundary. Если telemetry теряется, она не удаляет canonical result. Уже существующие output/retention contracts достаточны; новый глобальный event store не нужен.

## 5. Restate: что полезно и где появляется скрытая цена

### 5.1 SDK/core и технические subpaths

**S.** `@restatedev/restate-sdk` зависит от отдельного `restate-sdk-core`, имеет `fetch`, `lambda`, `node` subpath exports; package scripts отдельно проверяют exports/type resolution и API surface. Request различает стабильный invocation id и attempt-specific headers/signal. [R1, R2]

**I.** Runtime public identity и конкретная попытка соединения действительно разные contracts. Для нас opaque operation/generation/host incarnation не смешиваются; curated exports + packed import checks предотвращают случайную публикацию private graph. Один package с несколькими правильными subpaths иногда лучше трёх пустых libraries — решение зависит от независимого потребления, platform dependency и release policy.

### 5.2 Source-подтверждение внешнего crash window

**S.** В SDK `Context.run` прямо описан случай: операция успешно выполнилась, но запись результата ещё не стала durable; после сбоя действие может выполниться повторно. [R2] Это точная граница guarantees, которой marketing-style «exactly once» нельзя заменять semantics.

**I.** `ctx.run(() => arbitraryTool())` не снимает обязанности effect owner. Для queryable/idempotent external system сохраняется исходная effect identity; для irreversible non-idempotent unknown сохраняется uncertainty и разрешённый recovery path. Новые S2 mutation retries или readback, дающий dispatch authority, не добавляются; owning bounded settlement observations остаются разрешёнными по точной S2 таблице.

### 5.3 New delta: serial object + циклические ожидания

**D.** Exclusive handlers одного Virtual Object serial; shared handlers имеют read-only state access. [R3] Официальный service communication guide предупреждает о deadlock при цикле request/response exclusive handlers A→B→A. [R4]

**I.** Если будущий consumer связывает teams/agents через keyed workflows, нельзя держать exclusive handler, ожидающий ответ от участника, который должен получить тот же lock. Аналогично approval/cancel/control должны иметь независимый разрешённый путь progress. Для нашего bounded runtime это не повод добавлять actors; это rejecting scenario конкретного будущего wrapper.

**P.** Consumer создаёт две keyed workflows, которые ожидают друг друга; выбранный product flow должен либо запрещать такой synchronous cycle, либо выражать его как durable message + явно обработанное ожидание. Проверяется cancellation и конечный backlog при этом цикле. Этот тест не переносится как mandatory ordinary S2 gate без такого consumer.

### 5.4 Retention и code pinning

**D.** Restate deployment pinning держит ongoing invocation на исходном immutable endpoint; shared Virtual Object state всё равно переживает deployments и требует совместимой schema. Длительные handlers заставляют сохранять старые deployments. [R5] Ingress idempotency keys deduplicate в установленном retention window; автоматически назначенный key одного запроса не дедуплицирует два независимых клиентских запроса. [R6]

**I.** Default retention внешнего engine нельзя автоматически принять за наш product replay horizon. Наличие durable outer workflow не разрешает удалить runtime cleanup/reconciliation capability. Pinning части системы не закрепляет все mutable shared data или PA/RS authority навсегда.

## 6. Реестр конкретных антипаттернов и переносимых плюсов

| ID | Наблюдение | Статус | Применение в нашем плане |
| --- | --- | --- | --- |
| D-LG-01 | Interrupted/drained tool отражался как failed | H, исправлено в #9406 | Explicit lifecycle outcome и pause/drain stream fixture |
| D-LG-02 | Подключённый observer менял streaming execution и task result | H, исправлено в #9406 | Observation off/on parity по canonical behavior |
| D-LG-03 | Persisted node name становится runtime compatibility surface | D, design tradeoff | Execution/profile/schema compatibility отдельно от package SemVer |
| P-LG-01 | Standalone checkpoint conformance | S, сильная находка | Узкий portable kit только для объявленного implementer API; private S2 kit сохраняется |
| P-LG-02 | Pending writes сохраняют завершённые части super-step | D, сильная находка | Не повторять known settled work; не импортировать graph super-steps в ordinary engine |
| P-T-01 | Workflow package не зависит от worker | S, сильная находка | inward dependency и outward heavy composition |
| D-T-01 | Cancellation не доказывает termination чужого I/O | D, scope limit | Не выдавать signal/timeout за native release receipt |
| D-R-01 | External effect + journal commit имеют crash gap | S, documented limit | Unknown остаётся unknown; downstream idempotency/query authority |
| D-R-02 | Exclusive keyed handlers допускают cyclic wait deadlock | D, documented tradeoff | Future consumer integration test, не новый runtime scheduler |
| P-R-01 | Stable invocation vs attempt identity | S, сильная находка | Сохранить operation/generation/incarnation distinctions |
| P-R-02 | Immutable endpoint pinning + separate shared-state compatibility | D, сильная находка | Retained recovery path и mixed-version schema cases |
| D-ALL-01 | Больше packages не гарантирует независимый dependency closure | I | Packed minimal consumer и public declaration review |

## 7. Три варианта для действительно открытого будущего вопроса

**Вопрос:** нужна ли первому consumer **долговечная business workflow orchestration вне runtime**? Этот вопрос не блокирует G0–G2, не заменяет PostgreSQL S2 и не требует выбрать новый scheduler. Если реального такого consumer нет, реализуем accepted foundation без новой dependency. Оценки относятся к одному небольшому consumer adapter после готового runtime, а не ко всему продукту.

**Шкалы:** С — сложность (10 = максимальная); Н — ожидаемая надёжность именно заявленного contract; У — уверенность в пригодности. Это инженерное суждение, не измеренный SLA или vendor score. P — handwritten production+integration; T — tests/fixtures. Исключены generated/vendor code, документация, underlying engine deployment/operations и native lane. LOC uncertainty 3–4/10; варианты не суммируются.

| Вариант | Обещание | С / Н / У | P / T |
| --- | --- | --- | --- |
| **A. Consumer использует public runtime API; отдельного durable workflow engine пока нет** | Runtime owns technical durability; consumer хранит лишь необходимый product state и не заявляет произвольный multi-step durable workflow | **3 / 8 / 9** | **200–600 / 600–1 400** |
| B. Temporal adapter на стороне consumer | Multi-step business Workflow; Activities обращаются к runtime. AE/PA/RS, effect identity и native custody остаются у runtime | 7 / 8 / 7 | 900–2 000 / 1 400–3 200 |
| C. Restate adapter на стороне consumer | Durable service/object workflow; runtime operation вызывается через узкий adapter. Deployment/journal semantics принадлежат external engine, AE authority сохраняется | 6 / 8 / 6 | 800–1 800 / 1 300–3 000 |

Н=8 не значит одинаковую availability или масштаб: scope A уже. Все оценки предполагают выполнение собственных negative cases. Зрелость underlying engine не квалифицирует наш wrapper автоматически.

### Критический разбор A

**Сильнейший аргумент за:** минимальная дополнительная сложность, существующий runtime остаётся самостоятельной библиотекой. Ordinary S2 уже имеет своё нужное durable поведение.

**Сильнейший контраргумент:** как только product обещает «выполнить 20 шагов за несколько дней с ручными approval и восстановлением», отсутствие workflow engine провоцирует домашний scheduler в consumer.

**Ответ:** назвать отсутствие этого обещания явно; при появлении multi-step durable use case сравнить B/C с уже существующим consumer mechanism. Не строить самодельный Temporal под видом helpers.

**Условие отказа от A:** product requirement требует долговременных timers, wait/resume, массового rollout workflow code и распределённого retry orchestration, которые consumer реально не покрывает.

### Критический разбор B

**Сильнейший аргумент за:** зрелая модель business workflow/replay/activity, явная версия workflow logic, удобный наружный слой orchestration.

**Сильнейший контраргумент:** две state machines и два retry policies могут независимо восстанавливать одну работу; Activity timeout соблазняет создать новый runtime operation. Дополнительная инфраструктура и version discipline существенны.

**Ответ:** единственная technical authority остаётся AE. Adapter сохраняет caller command identity; по unknown outcome прекращает автоматическую effectful recovery и передаёт его разрешённому owner path. Automatic retries runtime-mutating activity выключены по умолчанию, пока не доказана exact method semantics. Сохраняются лишь разрешённые S2 identity/settlement/terminal observations, ни один readback не даёт dispatch authority. Business retry новая intent только после предписанного closure/authority proof.

**Receiver contract для B/C:** до первого вызова стабильно фиксируется trusted `(tenant, project, commandId)` и fingerprint. Повтор допускается лишь для public submit с доказанной идемпотентностью: duplicate observation, same-key/different-payload conflict, никогда dispatch ownership. Retained dedup/receipt horizon покрывает поддержанные replay/restore paths; после expiry retained proof либо явный отказ, не новый commandId. Если method/profile такого не гарантирует, integration path неподдержан. Отключение retry policy само по себе не устраняет crash replay.

**Kill case:** external workload начался, wrapper ACK потерян, worker restart до journal commit; повтор с той же identity не создаёт второй dispatch; changed payload, expired retention и restore-before-effect также проверяются. Cancelled workflow не заявляет runtime resource release.

### Критический разбор C

**Сильнейший аргумент за:** естественная durable service/object модель, TypeScript API, узкие transports и immutable deployments.

**Сильнейший контраргумент:** keyed serial execution и long waits создают head-of-line blocking/deadlock; external `ctx.run` всё равно имеет effect/commit gap. Object isolation нельзя принять за runtime tenant/security isolation.

**Ответ:** сохранить owner identity, ограниченный backlog и независимый control path; не помещать whole runtime invocation в бесконечный exclusive section. Runtime вызовы с unknown outcome не получают бесконтрольный redispatch. `ctx.run` может повторить closure после external success/journal gap независимо от обычной retry policy; обязательный receiver contract B/C выше проверяется на реальном public submit. Неподдержанная идемпотентность означает отказ integration, не второй journal внутри runtime.

**Kill case:** invocation/approval callback и cancel приходят во время recovery; нет duplicate dispatch, revive после cancel или неограниченного blocked queue. Старый deployment и shared state остаются читаемыми по объявленному horizon.

**Практическая рекомендация:** A сейчас. B/C — дополнительный конкретный consumer slice, не foundational dependency. Когда появится требование такого workflow, спросить владельца с этой таблицей; до этого не загружать его искусственной развилкой.

## 8. Минимальная дельта в основной план

1. В observation/stream verification добавить **off/on observer parity** и **pause/drain ≠ failure**, с reference на исправленный LangGraph #9406.
2. В public-library review сослаться на checkpoint conformance как хороший reusable-product пример; сохранить private S2 kit и отдельный declared implementer scope.
3. В future consumer integration memo явно назвать **одного владельца technical retry/dispatch** при Temporal/Restate wrappers. Это уточнение F17/F03, не новый слой.
4. При long-session/remote consumer delivery включить cancellation-vs-termination и keyed waiting cycle только там, где выбранный integration реально создаёт этот риск.
5. Existing replay/retention/storage invariants уже покрывают остальные lessons; не дублировать их новыми generic managers, journals или event buses.

## 9. Источники

Каждая ссылка первичная. `S`-ссылки фиксируют точный SHA, `D`-ссылки rolling; дата доступа указана выше.

| ID | Источник | Подтверждает |
| --- | --- | --- |
| LG1 | [Checkpoint conformance README, L19, L64–80](https://github.com/langchain-ai/langgraph/blob/858891aaa164ebdacf33b8f5e7f88b38b9132211/libs/checkpoint-conformance/README.md#L19) | Separate suite, required/optional capabilities |
| LG2 | [LangGraph manifest, L5–33](https://github.com/langchain-ai/langgraph/blob/858891aaa164ebdacf33b8f5e7f88b38b9132211/libs/langgraph/pyproject.toml#L5-L33) | Version string и реальные runtime dependencies |
| LG3 | [Checkpoint base, L16, L39–199](https://github.com/langchain-ai/langgraph/blob/858891aaa164ebdacf33b8f5e7f88b38b9132211/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L16) | RunnableConfig coupling; snapshot/base contract |
| LG4 | [Commit #9406 с diff и tests](https://github.com/langchain-ai/langgraph/commit/858891aaa164ebdacf33b8f5e7f88b38b9132211) | Исправленные pause/tool-error и stream/task regressions |
| LG5 | [Backward compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility) | Latest code against persisted threads, node/state compatibility |
| LG6 | [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | Durability modes, pending writes, replay, installable adapters |
| LG7 | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | Restart from node beginning; external-effect idempotency |
| T1 | [Workflow package manifest](https://github.com/temporalio/sdk-typescript/blob/211c365b8d0e389ffae839b65e46d674d7241c68/packages/workflow/package.json) | Dependencies/public package |
| T2 | [Worker package manifest](https://github.com/temporalio/sdk-typescript/blob/211c365b8d0e389ffae839b65e46d674d7241c68/packages/worker/package.json) | Host-side dependencies/composition |
| T3 | [Workflow definition](https://docs.temporal.io/workflow-definition) | Determinism, I/O boundary, versioning |
| T4 | [Activity definition](https://docs.temporal.io/activity-definition) | External service owns idempotency-key enforcement |
| T5 | [Activity execution](https://docs.temporal.io/activity-execution) | Timeout, heartbeat, cooperative cancellation |
| T6 | [Workflow execution limits](https://docs.temporal.io/workflow-execution/limits) | Bounded event history/incomplete operations |
| R1 | [Restate SDK manifest](https://github.com/restatedev/sdk-typescript/blob/b1080a11984b35419e0e825a0e82bc17c656a22d/packages/libs/restate-sdk/package.json) | Core split, exports/API checks |
| R2 | [Context source, L59–123; L390–406](https://github.com/restatedev/sdk-typescript/blob/b1080a11984b35419e0e825a0e82bc17c656a22d/packages/libs/restate-sdk/src/context.ts#L390-L406) | Stable invocation/attempt distinction; external-effect gap |
| R3 | [Handlers](https://docs.restate.dev/foundations/handlers) | Exclusive/shared handlers |
| R4 | [TypeScript service communication](https://docs.restate.dev/develop/ts/service-communication) | Explicit cyclic exclusive-handler deadlocks |
| R5 | [Versioning](https://docs.restate.dev/services/versioning) | Immutable deployments; shared state compatibility |
| R6 | [HTTP invocation](https://docs.restate.dev/services/invocation/http) | Client-supplied vs automatic idempotency keys; retention |

## 10. Что не проверено

- Не запускались реальные LangGraph/Temporal/Restate workloads, chaos/restart experiments или performance benchmarks.
- Не аудитировались внутренние server algorithms Temporal/Restate; manifests не доказывают полностью ацикличный или идеально независимый runtime graph.
- Не заявляется физическая остановка процесса по cancellation API, бессрочная deduplication, zero-downtime upgrade либо superiority нашего ещё не реализованного runtime.
- Нет оснований добавлять новый engine в current S2. Эти выводы уточняют contracts и будущие qualified integration cases.



## Уточнения после независимой критики

Точный [S2 readback contract](../architecture/agent-runtime-architecture-program-s2-operations-storage.md#transaction-outcomes-and-readback-ownership) разрешает ограниченные owner observations; запрещает mutation replay и dispatch authority из readback. Runtime-owned dispatch guarantee не доказывает exactly-once внутренних tools harness. Cases и dispositions сохранены в [review record](agent-runtime-modular-research-review.md).

## Limitations

No competitor runtime, live provider, native/PostgreSQL failure campaign or comparative benchmark was executed. A source commit or manifest does not establish a released or installed artifact. All proposed experiments remain planned; accepted owner contracts and exact deployment qualification control implementation.
