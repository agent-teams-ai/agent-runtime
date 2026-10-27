---
id: evidence.agent-runtime.modular.antipatterns
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Source-backed historical lessons, good patterns and concrete rejecting cases for runtime library review.
---

# Agent Runtime Antipattern Register

## Observed target

Design-review register для greenfield agent-runtime, baseline `c59fe8364071530d09b48eda47d41620f3f59c25`, **27.10.2026**. Это память о причинах ошибок и полезных находках. Реестр не объявляет соответствующие ошибки найденными у нас и не утверждает, что исправленные upstream defects остаются актуальными.

Связи: [главный research synthesis](../architecture/agent-runtime-modular-research.md), [frameworks](agent-runtime-framework-research.md), [libraries](agent-runtime-library-research.md), [durability](agent-runtime-durability-research.md), [existing K01–K12](agent-runtime-industry-architecture-research.md), [existing SR-AP-1…11](../architecture/subscription-runtime-port-candidates.md#named-subscription-runtime-anti-patterns). Известные ранее guards переиспользуются, не получают второго implementation owner.

## Method

**H** — historical defect/retrospective, исправление или статус назван; **D** — documented design tradeoff/limit; **S** — прочитанный pinned source; **I** — наше инженерное следствие, без обвинения конкурента. Ни package counts, ни programming language не измеряют качество. Для каждой строки конкретный источник, owner и способ опровергнуть достаточность решения. Cases ниже **planned**; выполненного runtime qualification здесь нет.

## Results

### A. Модульность, dependency и эволюция

| ID | Источник и точный статус | Ошибка, которой избегаем у себя | Достаточное правило и проверка |
| --- | --- | --- | --- |
| MR-01 | **H/S:** [MAF ADR0021](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0021-provider-leading-clients.md); extraction уже видна в current core manifest | Называть core универсальным, сохраняя обязательные provider SDK/DTO | AE/Operations public closure не включает provider/server. Packed caller+implementer без Host. Не запрещает SDK внутри конкретного adapter |
| MR-02 | **S/D:** [Pydantic slim](https://github.com/pydantic/pydantic-ai/blob/58fa0d9dd764ee0b2eddf4b420a44daa8df2cb4c/pydantic_ai_slim/pyproject.toml), [Mastra manifest](https://github.com/mastra-ai/mastra/blob/e56f88e18d906635b033173abcae637cf361ce8a/packages/core/package.json); разные packaging choices, не benchmark | Считать subpath эквивалентом независимого install или число пакетов доказательством слабой связанности | Публикуемый concern имеет собственный real consumer, dependency closure и public declarations. Optional feature deps не становятся обязательными без причины |
| MR-03 | **I** по [CMS](https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/architecture/common-assembly.md#new-composition-boundaries) | Package/Assembly entry для каждого класса, пустые layers, generic managers и service bags | Самостоятельные ownership/consumption/lifecycle reasons; helpers обычные imports. Один composition authority, не runtime string registry |
| MR-04 | **S:** [Temporal workflow manifest](https://github.com/temporalio/sdk-typescript/blob/211c365b8d0e389ffae839b65e46d674d7241c68/packages/workflow/package.json), [worker](https://github.com/temporalio/sdk-typescript/blob/211c365b8d0e389ffae839b65e46d674d7241c68/packages/worker/package.json) | Domain/library зависит от Host, который её собирает; цикл через test kit | Host/adapter → owner contract. Joined conformance → owners; production не импортирует testing, owners не замыкают цикл обратной devDependency |
| MR-05 | **D:** [OTel stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) | Считать caller compatibility доказательством implementer compatibility | Отдельный packed implementation required port; explicit breaking change/migration. Нельзя отложить public required ports до ecosystem support Q1 |
| MR-06 | **D/S:** [Restate versioning](https://docs.restate.dev/services/versioning), [CMS exact revisions](https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/architecture/common-assembly.md#module-packages-and-contracts) | Смешивать package version, capability revision, wire и persisted schema; N/N−1 обещает магическую negotiation | Раздельные identities; edge требует exact compatible descriptor по current CMS. API/deployment window требует explicit mapping/test, не нового broker. Retained cleanup path не исчезает с окончанием package support |
| MR-07 | **I** по existing S2 publication graph | Публичный PG store зависит от private недоступных owner packages или выпускается execution-only placeholder | Required RS/PA public implementer/distribution successors входят в один qualified train до store publication; независимые S1/S2-A/B не ждут весь fleet |
| MR-08 | **D:** [Node exports](https://nodejs.org/api/packages.html#package-entry-points) | Выдавать import boundaries за hostile-code isolation | Curated exports предотвращают случайные deep imports, но не являются sandbox. Runtime executable admission относится к Q2/native/RS, а не package metadata |

### B. Исполнение, восстановление и наблюдение

| ID | Источник и точный статус | Ошибка, которой избегаем у себя | Достаточное правило и проверка |
| --- | --- | --- | --- |
| MR-09 | **S/D:** [AI SDK continuation](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness/src/v1/harness-v1-session.ts#L233-L273); документированы attach и rerun | Называть resume lossless, когда утрата runtime запускает unfinished work повторно | Selected profile различает attach/replay/rerun/reset. Ordinary unknown effect не разрешает rerun. Lost-state fixture считает actual effects, не только stream chunks |
| MR-10 | **D:** [OpenAI sessions](https://openai.github.io/openai-agents-python/sessions/); запрет двойного history input; MAF proposed history ADR — лишь дополнительный design input | Передавать и полный transcript, и opaque provider continuation; output view становится неявным model input | Один history-input owner на adapter/profile. Два turns+restart доказывают отсутствие двойных prior messages; новый harness не означает перенос старой history |
| MR-11 | **H/S:** [LangGraph #9406](https://github.com/langchain-ai/langgraph/commit/858891aaa164ebdacf33b8f5e7f88b38b9132211), уже исправлено | Подключение observation меняет execution mode, task result или authority | Deterministic off/on fixture с одинаковыми clock/inputs/provider responses и достаточными budgets. Допустим overhead; не требуем identical real-time schedule/latency или same outcome при разной перегрузке |
| MR-12 | **H/S:** тот же [LangGraph fix](https://github.com/langchain-ai/langgraph/commit/858891aaa164ebdacf33b8f5e7f88b38b9132211) | Pause/interrupt/drain превращается в generic tool-error/completed | Owner outcome сохраняется adapter-ом; EOF/exception class не доказывают terminal state. Case controlled pause, observer attached, resume unsupported/allowed |
| MR-13 | **S:** [Restate Context.run](https://github.com/restatedev/sdk-typescript/blob/b1080a11984b35419e0e825a0e82bc17c656a22d/packages/libs/restate-sdk/src/context.ts#L397-L406) | Retry off считается достаточным для external effect/journal crash gap | Wrapper повторяет лишь доказанно repeat-safe public method: same trusted tenant/project/commandId + fingerprint, duplicate никогда не dispatch. При отсутствии такого договора integration unsupported; после dedup horizon нет silent new intent |
| MR-14 | **D:** [ADK resume](https://adk.dev/runtime/resume/#how-it-works), [Temporal retries](https://docs.temporal.io/encyclopedia/retry-policies) | Второй retry owner в workflow adapter повторяет unknown technical operation | AE остаётся dispatch authority. Сохраняются bounded identity/settlement reads из S2; ни readback, ни retry engine не дают права launch. Effectful replay может требовать явного нового product intent после closure |
| MR-15 | **D:** [Temporal cancellation](https://docs.temporal.io/develop/typescript/cancellation), [native coordination](../architecture/agent-runtime-architecture-program-plan.md#native-team-coordination-contract-native-integration) | Cancel ACK, timeout или Promise reject считается физическим завершением процесса | Отдельно requested/observed terminal/output drain/custody release; exact native tuple доказывает последний факт. Borrowed resources не закрываются чужим consumer |
| MR-16 | **D:** [Restate service communication](https://docs.restate.dev/develop/ts/service-communication), документированные exclusive-handler deadlocks | Держать serial owner и ждать callback, которому нужен этот же owner | При выбранном actor/workflow consumer проверять A→B→A и cancel/approval progress; one-way/shared path только если semantics разрешают. Не добавлять actor engine в ordinary runtime |
| MR-17 | **H:** [Mastra CAS resume #21725](https://github.com/mastra-ai/mastra/pull/21725), предыдущий K02; поддержка зависит от store/config | Read-before-write continuation выбирает двух победителей | Durable atomic claim до effect; real supported store race. Queue delivery/lease не заменяет authority/fencing; старые unfenced stores не объявлять исправленными автоматически |

### C. Output, permissions и доверие

| ID | Источник и точный статус | Ошибка, которой избегаем у себя | Достаточное правило и проверка |
| --- | --- | --- | --- |
| MR-18 | **H/S:** [OpenHands PR6259](https://github.com/OpenHands/software-agent-sdk/pull/6259), merged; старые повреждённые histories этим не отремонтированы | Generic masking меняет timestamps/discriminants/cursor identity и ломает typed reload | PA/RS-approved minimization nonsecret runtime/output/diagnostic surfaces ДО persistence/export; собственная PA credential custody отдельно authorized. Sanitization сохраняет schema; опасный secret в structural field требует безопасного typed representation/refusal, а не blanket exemption. После admission model/view projection не мутирует разрешённый authoritative source |
| MR-19 | **H/S:** [Mastra PR28286](https://github.com/mastra-ai/mastra/pull/28286), merged; gateway.* preservation across vendors вне scope | Удалён tool call, оставлен result; normalization мутирует persisted history | Пары преобразуются согласованно в выбранной model projection; original admitted history сохраняется. Проверять consecutive provider switch, unknown tool types и непарные input events |
| MR-20 | **D:** [OpenAI guardrails](https://openai.github.io/openai-agents-python/guardrails/); parallel mode и scope documented, есть blocking mode | Input validation или beforeTool hook объявляется authorization всех effects | RS/PA/adapter называют exact enforcement unit и paths; remote delayed command проверяется у target по принятому fencing/cutoff, без ложного instantaneous revoke. Hosted/direct path либо обеспечен declared authority, либо не поддерживает этот строгий promise. Не заявлять interception каждого shell effect, которого native profile не обеспечивает |
| MR-21 | **D/S:** [OpenHands security](https://docs.openhands.dev/sdk/guides/security), [direct execute_tool](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L3184-L3225); intentionally privileged API | Convenience/direct entrypoint незаметно обходит promised confirmation/enforcement | Privileged caller contract явный; untrusted ingress его не получает. Проверка direct/delegated/hosted paths под одним выбранным profile |
| MR-22 | **S:** [ADK explicit capabilities](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/models/base_llm.py#L36-L126), прежняя name heuristic deprecated | По названию vendor/model включить resume/kill/permission | Validated capability declaration, separate compatibility evidence и separate authorization. Field typo/unsupported required capability отвергаются до эффекта |
| MR-23 | **D:** [OpenAI tracing](https://openai.github.io/openai-agents-python/tracing/); controls и buffers documented | Сначала записать sensitive data, потом отключить exporter и считать данные удалёнными | Default minimization перед recording; explicit bounded export. Disable не обещает удаления уже buffered/exported данных |
| MR-24 | **H:** [A2A owner check fix](https://github.com/a2aproject/a2a-python/pull/1172), предыдущий K03 | Cache/live lookup обходит authorization, opaque locator становится разрешением | Trusted caller binding проверяется до live/cache/remote read/control; cross-owner live/parked cases. Не дублировать auth policy в произвольном cache helper |

### Хорошие находки, которые сохраняем

| ID | Паттерн и первичный пример | Применение и предел |
| --- | --- | --- |
| GP-01 | Provider extraction плюс удобный facade, [MAF ADR0021](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0021-provider-leading-clients.md) | Public SDK convenience поверх самостоятельных libraries; facade не единственный путь |
| GP-02 | Minimal install/extras, [Pydantic slim](https://pydantic.dev/docs/ai/overview/install/) | Consumer выбирает реально нужные dependencies; проверяем install closure |
| GP-03 | Contract + optional-capability conformance, [LangGraph checkpoint kit](https://github.com/langchain-ai/langgraph/blob/858891aaa164ebdacf33b8f5e7f88b38b9132211/libs/checkpoint-conformance/README.md) | Public selected kit при extra support promise; private S2 joined suite не публикуется |
| GP-04 | Whole harness отдельно от models/sandbox, [AI SDK](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) | Сохраняем F01 и explicit profile; наличие похожего seam у конкурента — counterevidence уникальности |
| GP-05 | Workflow package отдельно от heavy worker, [Temporal](https://github.com/temporalio/sdk-typescript/tree/211c365b8d0e389ffae839b65e46d674d7241c68/packages) | Направление dependencies, а не обязательное копирование списка packages |
| GP-06 | Read versus create operation различаются, [MAF store](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/dotnet/src/Microsoft.Agents.AI.Abstractions/AgentSessionStore.cs) | Semantic store methods и typed unknown/conflict вместо generic repository |
| GP-07 | Safe/unsafe/unknown и veto скрытых retries, [OpenAI retry safety](https://openai.github.io/openai-agents-python/models/#safety-boundaries) | Преимущество формулируем как проверяемую cross-harness consistency; не «только мы умеем safe retry» |
| GP-08 | Stable invocation отдельно от attempt signal, [Restate Request](https://github.com/restatedev/sdk-typescript/blob/b1080a11984b35419e0e825a0e82bc17c656a22d/packages/libs/restate-sdk/src/context.ts) | Command/operation/generation/connection identities не взаимозаменяемы |
| GP-09 | Explicit state source и application/core split, [OpenHands V1 design](https://docs.openhands.dev/sdk/arch/design) | Один owner каждого mutable fact; это не один глобальный mutable object для всех наших contexts |
| GP-10 | API/SDK implementer compatibility отдельно, [OpenTelemetry](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) | Caller+implementer+state compatibility cases, без автоматического adoption чужих LTS сроков |

### Как пользоваться реестром

При изменении конкретной границы reviewer ссылается на релевантный MR-ID и существующий owner case. Новая статья сама не создаёт обязательный gate во всех packages. При новом подтверждённом инциденте запись получает exact affected/fixed status, cause, counterevidence и минимальную проверку; изменившийся upstream status уточняется, не скрывается. Каталог хранит инженерную память, а не маркетинговый список «все конкуренты сломаны».

## Limitations

Ни один testcase из этой новой таблицы не объявлен исполненным. Source/public docs не устанавливают production behavior всех deployments. Known fixed HEAD не означает установленный patch у пользователей. Источники snapshots и языковые profiles находятся в соответствующих исследовательских файлах. Existing SR/K records остаются authoritative источниками своих исторических деталей; дублированные MR ссылки связывают их с единым практическим review index.
