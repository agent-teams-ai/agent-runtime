---
id: evidence.agent-runtime.industry-architecture-research
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Primary-source industry lessons and historical failure cases informing the greenfield foundation; no comparative runtime benchmark.
---

# Agent Runtime Industry Architecture Research

## Observed target

Дата источников и проверки статусов: **26 октября 2026 года**. Приложение к исследованию архитектурного фундамента `agent-teams-ai/agent-runtime`; связан с [целевым планом](../architecture/agent-runtime-greenfield-foundation-plan.md) и [решениями/review](../architecture/agent-runtime-foundation-decisions-and-review.md). Исследованный runtime baseline — `518f1449acf6dda793662783ec9d918d4007c563`; это не аудит уже реализованного нового runtime. Сравниваются **52 разных проекта, протокола и инфраструктурных компонента**, сгруппированных по назначению. Подпроекты одного продукта не раздувают счётчик: Ray Core/Serve, Cloudflare Agents/Durable Objects и Dagger/container-use учтены каждый одной строкой.

## Method

### Как читать доказательства

Исследование включает первоначальные независимые направления и их критическую перепроверку, затем шесть дополнительных направлений greenfield-плана: reusable libraries, whole-harness/session contracts, fleet, trust/isolation, отраслевой каталог и совместимость/доставка. Источники — официальные спецификации, документация, код, авторская архитектурная ретроспектива и реальные issue/PR с проверкой текущего статуса. Чужие продукты здесь не устанавливались и не проходили общий benchmark. Ключевые случаи повторно сверены по позднейшему состоянию PR/commit, а не раннему title или комментарию. Ширина обзора и глубина проверки явно различаются; 52 строки не означают 52 полных source-code audit.

**Глубина:** **У** — углублённый конкретный кейс в §2: причина, текущий статус, переносимый инвариант и предел вывода; **Ц** — целевое чтение официальной документации/спецификации или ограниченного исходника, только по указанной границе. У не означает аудит всего продукта. **Тип:** **H** — историческая исправленная проблема/архитектурная ретроспектива; **D** — документированная семантика/предел; **I** — наш инженерный вывод, не обнаруженный чужой дефект. Табличный «урок» включает I, если формулирует следствие для нашего проектирования.

Текущие `main`, `latest` и rolling docs — сведения на дату чтения. Их нельзя считать immutable production pins, обещанием будущей совместимости или квалификацией наших deployments. Merged в main отдельно от наличия исправления в каждом выпуске и установленном deployment. Чужой historical fix обосновывает тест нашего инварианта, но не доказывает наличие такого же дефекта у нас. Документированные ограничения Agno, Ray, OpenClaw, Jupyter, Wasmtime и других не переименовываются в неисправленные баги.

## Results

## 1. Каталог: одна защищаемая мысль на систему

### A. Полный harness, agent SDK и service composition — 15

| № | Проект | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 01 | OpenAI Codex app-server | Ц / D | Ответ `turn/start` и `turn/completed` — разные факты. Provider lifecycle остаётся в своём adapter/reducer; успешный RPC не завершает operation. | [App-server](https://developers.openai.com/codex/app-server) |
| 02 | Claude Agent SDK | Ц / D | SDK использует Claude Code loop; streaming-input и одноразовый query имеют разные lifetimes. Подмена model endpoint не заменяет этот harness. | [Overview](https://code.claude.com/docs/en/agent-sdk/overview), [input modes](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) |
| 03 | OpenCode | Ц / D | HTTP commands, session status и SSE — разные поверхности. Boolean abort не является нашим receipt физической остановки и полного output drain. | [Server API](https://opencode.ai/docs/server/) |
| 04 | goose | Ц / D | ACP provider guide явно ограничивает resume/fork и различает goose/ACP session IDs. Общий протокол не даёт полной переносимости возможностей. | [ACP providers](https://goose-docs.ai/docs/guides/acp-providers/) |
| 05 | OpenHands | У / H | V0 coupling и mutable configuration переработаны в V1. Core/harness/environment/serving полезно разделять без копирования точного числа пакетов. | [Авторская ретроспектива, §§3–4](https://arxiv.org/html/2511.03690v2) |
| 06 | Microsoft Agent Framework | Ц / D | `BaseAgent`, chat-client agent, session storage и workflow state — отдельные конструкции. Сериализация local history и remote conversation locator не дают одинаковую custody. | [Agent source](https://github.com/microsoft/agent-framework/blob/main/python/packages/core/agent_framework/_agents.py), [storage](https://learn.microsoft.com/en-us/agent-framework/concepts/agents/conversations/storage) |
| 07 | Google ADK | Ц / D | Runner связывает agent с session/artifact/memory services. Agent Event и session persistence не должны стать универсальным DTO нашего engine. | [Runner source](https://github.com/google/adk-python/blob/main/src/google/adk/runners.py) |
| 08 | PydanticAI | Ц / D | Settled-step history и durable execution различны; документирован один durable backend на agent. Нельзя позволять двум wrappers независимо повторять один ambiguous effect. | [Durable execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/) |
| 09 | OpenAI Agents SDK | Ц / D | `ModelProvider` возвращает model; Runner сохраняет свой tools/handoff loop. Whole-harness replacement требует другого seam, чем смена LLM provider. | [ModelProvider](https://openai.github.io/openai-agents-js/openai/agents/interfaces/modelprovider/), [running agents](https://openai.github.io/openai-agents-js/guides/running-agents/) |
| 10 | Hugging Face smolagents | Ц / D | Sandbox одного code snippet и sandbox всей agent system — разные профили. Executor isolation не изолирует автоматически controller/model/tools. | [Secure code execution](https://huggingface.co/docs/smolagents/en/tutorials/secure_code_execution) |
| 11 | CrewAI | Ц / D | Crew/Flow — бизнесовая координация; `kickoff_async` оборачивает sync в thread, `akickoff` имеет иной путь. Async название не доказывает fleet capacity. | [Async execution](https://docs.crewai.com/v1.15.30/en/learn/kickoff-async) |
| 12 | Agno / AgentOS | У / D | Queue retry повторяет весь run и tool calls; default `max_attempts=1`. Attempt fencing своих записей отдельно от идемпотентности внешних эффектов. | [Durable queue](https://docs.agno.com/agent-os/background-execution/durable-queue) |
| 13 | Letta | Ц / D | Persistent agent identity, harness и computer разделены; approval — continuation boundary, connection-owned callbacks не воскресают из сохранённых IDs. | [Terminology](https://docs.letta.com/reference/terminology), [App Server lifecycle](https://docs.letta.com/self-hosting/app-server/protocol-lifecycle) |
| 14 | Vercel AI SDK | У / H | Durable `WorkflowAgent` ранее не переносил signed-approval поддержку core. Wrapper должен сохранять provenance и representation-specific cursors, а не только happy-path result. | [Issue19964](https://github.com/vercel/ai/issues/19964), [PR19976](https://github.com/vercel/ai/pull/19976) |
| 15 | OpenClaw | У / D | Один gateway — один оператор/взаимно доверяющая команда; `sessionKey` — routing selector. Hostile tenant isolation требует иной границы. | [Trust model](https://docs.openclaw.ai/gateway/security/trust-model) |

### B. Протоколы и semantics удалённого взаимодействия — 5

| № | Протокол | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 16 | ACP — Agent Client Protocol | Ц / D | Stable v1 prompt completion и draft v2 insertion ACK имеют разную семантику. Package version, protocol revision и required capabilities различаются. | [v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization), [v2 migration](https://agentclientprotocol.com/protocol/v2/migration) |
| 17 | A2A | У / H + D | Task, message, context и subscription имеют разные lifetimes; исторический Python live-registry owner bypass исправлен. Locator не заменяет caller authority. | [Specification](https://a2a-protocol.org/latest/specification/), [PR1172](https://github.com/a2aproject/a2a-python/pull/1172) |
| 18 | Jupyter messaging | У / D | Shell reply, IOPub, control и heartbeat различны; async output допустим после idle. Foreground завершение не доказывает полный drain. | [Authoritative protocol](https://jupyter-client.readthedocs.io/en/stable/messaging.html) |
| 19 | Language Server Protocol | Ц / D | V3 capabilities эволюционируют отдельно от implementation version; нет общего numeric protocol handshake. Optional extensions и mandatory baseline нужно различать. | [3.18 initialize source](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/general/initialize.md) |
| 20 | gRPC | Ц / D | Configured retry может replay request history; transport commitment после response headers — не application effect transaction. Проверяется реальная method/channel retry policy. | [Retry guide](https://grpc.io/docs/guides/retry/), [cancellation](https://grpc.io/docs/guides/cancellation/) |

### C. Actors, identity и локальная/распределённая ёмкость — 6

| № | Проект | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 21 | Ray Core / Serve | Ц / D | Logical resources используются для scheduling admission и не enforce physical CPU use/isolation. Concurrency budget отдельно от OS limits и cost/token budgets. | [Resources](https://docs.ray.io/en/latest/ray-core/scheduling/resources.html) |
| 22 | Microsoft AutoGen Core | Ц / D | Agent type/key и worker instance различны; distributed runtime — host/worker/RPC layer. Наличие agent ID не доказывает activation, persistence или recovery. | [Identity/lifecycle](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/agent-identity-and-lifecycle.html), [distributed runtime](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/distributed-agent-runtime.html) |
| 23 | Microsoft Orleans | Ц / D | Grain identity переживает activation; collection и cluster membership имеют собственные механизмы. Heartbeat/liveness не заменяет exclusive execution authority. | [Activation collection](https://learn.microsoft.com/en-us/dotnet/orleans/host/configuration-guide/activation-collection), [cluster management](https://learn.microsoft.com/en-us/dotnet/orleans/implementation/cluster-management) |
| 24 | Dapr actors | У / H | Shared timer callback blocking исправлен per-actor loops; финальная concurrency unbounded. Per-actor serialization отдельно от aggregate admission. | [PR10145](https://github.com/dapr/dapr/pull/10145), [final redesign commit](https://github.com/dapr/dapr/commit/d774f9a785faf647615db3736a4845f1f019a46b) |
| 25 | Restate | Ц / D | Scoped concurrency/sharding key, durable step replay и deployment compatibility — отдельные contracts. Не выдавать concurrency limit за конечный backlog или external-effect transaction. | [Flow control](https://docs.restate.dev/services/flow-control), [durable steps](https://docs.restate.dev/develop/ts/durable-steps) |
| 26 | Cloudflare Agents / Durable Objects | Ц / D | Durable object identity и WebSocket могут переживать hibernation, in-memory instance — нет. Считать dormant identity и resident execution отдельно. | [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Agents lifecycle](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/) |

### D. Durable workflow, replay и retention — 5

| № | Проект | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 27 | Temporal | У / D | Reuse policy для closed workflow ID проверяется лишь по retained executions. Product command deduplication должен иметь собственный явно заданный horizon. | [Workflow/Run IDs](https://docs.temporal.io/workflow-execution/workflowid-runid) |
| 28 | LangGraph | Ц / D | Resume переиспользует persisted completed-task results; начатый незавершённый task может выполняться снова. Размещение эффекта в task не делает его exactly-once. | [Functional API idempotency](https://docs.langchain.com/oss/python/langgraph/functional-api#idempotency), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| 29 | DBOS | Ц / D | Внешний эффект step и checkpoint разделены crash window; DB transaction атомарен только в своей DB boundary. Нужны idempotency/query/reconciliation внешнего владельца. | [Step tutorial](https://docs.dbos.dev/golang/tutorials/step-tutorial), [transaction tutorial](https://docs.dbos.dev/golang/tutorials/transaction-tutorial) |
| 30 | Inngest | Ц / D | Invocation idempotency, stable step identity и external-service idempotency — разные границы. Изменение step IDs требует versioning, а не надежды на replay. | [Idempotency](https://www.inngest.com/docs/durable-execution/guides-and-advanced/idempotency), [versioning](https://www.inngest.com/docs/durable-execution/guides-and-advanced/versioning) |
| 31 | Mastra | У / H | Concurrent resume исправлен durable CAS до downstream execution, но есть store/config exceptions. Гарантия должна следовать фактической capability, а не имени SDK. | [PR21725](https://github.com/mastra-ai/mastra/pull/21725) |

### E. Execution environment, sandbox и native boundary — 11

| № | Проект | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 32 | Kubernetes SIGs agent-sandbox | Ц / H + D | Controller lifecycle, isolation runtime, network policy и router authorization различны. Issue263 о default policy закрыта 13.03.2026; текущую угрозу нельзя выводить из старого issue. | [Threat model](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/security/threat_model.md), [issue263](https://github.com/kubernetes-sigs/agent-sandbox/issues/263) |
| 33 | E2B | Ц / D | MicroVM boundary не запрещает internet автоматически; network policy отдельна. Pause/resume сохраняет state и не является wipe. | [Security](https://e2b.dev/security), [internet access](https://docs.e2b.dev/network/internet-access) |
| 34 | Daytona | Ц / D | Документы v0 latest и v2 alpha описывают разные isolation arrangements. Квалифицируется конкретная generation/tier/configuration, не слово sandbox. | [Isolation](https://www.daytona.io/docs/en/isolation/), [v2 alpha](https://www.daytona.io/docs/en/v2/isolation/) |
| 35 | Modal Sandboxes | Ц / D | Sandbox network и secret injection имеют отдельные ограничения. Проверять фактический transport, sidecars и redirect destination, а не выводить no-exfiltration из isolation. | [Networking](https://modal.com/docs/guide/sandbox-networking), [secret injection](https://modal.com/docs/guide/sandbox-secret-injection) |
| 36 | gVisor | Ц / D | Sentry уменьшает host syscall surface; in-sandbox cgroup limits между процессами не enforced. Для всего sandbox нужны host limits; межагентная fairness отдельно. | [Security](https://gvisor.dev/docs/architecture_guide/security/), [compatibility](https://gvisor.dev/docs/user_guide/compatibility/) |
| 37 | Firecracker | Ц / D | Jailer/host hardening и operator network firewall — отдельные obligations. VM не отменяет credential/API authorization, egress policy или host mitigations. | [Production host setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md), [jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md) |
| 38 | SWE-ReX | У / H | Созданный container может быть недоступен controller из другого namespace. Exact deployment topology — часть execution profile, не только OS/image versions. | [Issue253](https://github.com/SWE-agent/SWE-ReX/issues/253), [architecture](https://swe-rex.com/latest/architecture/) |
| 39 | mini-SWE-agent | Ц / D | Независимые commands намеренно не сохраняют shell cwd/env. Один command-execution interface не обещает stateful-shell compatibility. | [FAQ](https://mini-swe-agent.com/latest/faq/) |
| 40 | Wasmtime | Ц / D | Async guest Future не гарантирует короткий poll; epoch/fuel не прерывают blocking host call. Native/async/sandbox не доказывают control progress. | [Async](https://docs.wasmtime.dev/api/wasmtime/index.html#async), [epoch interruption](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html#method.epoch_interruption) |
| 41 | Wassette | Ц / D | Typed Wasm component→MCP tool — узкий tool ABI, не универсальный loader полных agent harnesses. Reuse нужно сопоставлять с реальным execution contract. | [Microsoft engineering post](https://opensource.microsoft.com/blog/2025/08/06/introducing-wassette-webassembly-based-tools-for-ai-agents/) |
| 42 | Dagger / container-use | Ц / D | SDK generated bindings и engine version требуют согласования. Package compatibility отдельно от уже живущего engine/resource lifecycle. | [TypeScript SDK](https://docs.dagger.io/reference/sdks/typescript/) |

### F. Fleet, sessions и account policy — 4

| № | Проект | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 43 | AWS Bedrock AgentCore Runtime | Ц / D | Session identity, compute lifetime, per-session limits и account/Region API quotas отдельны. Data-plane quota может связывать invoke/control traffic; headroom нужно квалифицировать. | [Sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) |
| 44 | LiveKit Agents | Ц / D | Agent server, job process и AgentSession различны; deployment отдельно задаёт load/admission/drain. Worker plane не получается из одного execution API. | [Server](https://docs.livekit.io/agents/server/), [jobs](https://docs.livekit.io/agents/server/job/), [deployments](https://docs.livekit.io/deploy/custom/deployments/) |
| 45 | Azure Container Apps dynamic sessions | Ц / D | Routing identifier, allocated-session cap, ready pool и cooldown различны. Повторное имя после destruction не доказывает непрерывность процесса/state. | [Usage](https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage), [pool](https://learn.microsoft.com/en-us/azure/container-apps/session-pool) |
| 46 | LiteLLM gateway | Ц / D | Account RPM/TPM/concurrency/spend policy требует своего scope и multi-instance coordination. Per-Host execution cap не является глобальным account budget. | [User budgets/rate limits](https://docs.litellm.ai/docs/proxy/users), [production](https://docs.litellm.ai/docs/proxy/prod) |

### G. Storage, delivery, telemetry и точечное reuse — 6

| № | Компонент | Глубина / тип | Проверяемая граница и переносимый урок | Первичный источник |
| --- | --- | --- | --- | --- |
| 47 | PostgreSQL | Ц / D | Row lock сериализует конкурирующих writers конкретного row, не все reads/operations. Full aggregate rewrite и TOAST не равны delta-update; cost измеряется. | [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), [TOAST](https://www.postgresql.org/docs/current/storage-toast.html) |
| 48 | node-postgres | Ц / D | `pool.max` ограничивает clients, а `waitingCount` отражает очередь. Aggregate replica pools и acquisition waiters требуют отдельных конечных budgets. | [Pool API](https://node-postgres.com/apis/pool), [pool sizing](https://node-postgres.com/guides/pool-sizing) |
| 49 | NATS JetStream | Ц / D | Pending ACKs, waiting requests, batch count/bytes, retention и dedup window независимы. ACK delivery не доказывает external effect exactly-once. | [Consumer source](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/consumers.md), [model deep dive](https://github.com/nats-io/nats.docs/blob/master/using-nats/jetstream/model_deep_dive.md) |
| 50 | OpenTelemetry | Ц / D | Metrics cardinality имеет budget; GenAI prompts/output требуют opt-in. Trace correlation ID не должен превращаться в неограниченный metrics label или второй output store. | [Cardinality](https://opentelemetry.io/docs/specs/otel/metrics/sdk/#cardinality-limits), [GenAI content capture](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md#capturing-instructions-inputs-and-outputs) |
| 51 | Node.js streams | Ц / D | `highWaterMark` — threshold, не hard cap. Producer обязан учитывать backpressure; destroy/EOF не доказывают доставку всех buffered bytes. | [Stream API](https://nodejs.org/api/stream.html) |
| 52 | Ajv | Ц / D | Build-time standalone validation может заменить schema predicate mechanics, но runtime helpers требуют bundling. Schema validation не заменяет byte framing, duplicate-key или protocol state machine. | [Standalone](https://ajv.js.org/standalone.html), [strict mode](https://ajv.js.org/strict-mode.html) |

## 2. Десять углублённых кейсов: факт → наш guard/test → предел вывода

Каждый кейс содержит короткое резюме первичного источника; предлагаемая проверка — наш вывод. Это не каталог «десяти неисправленных промахов». Здесь пять конкретных исправленных дефектов, одна архитектурная ретроспектива и четыре документированные semantics/limits.

### K01. OpenHands V0: coupling сделал новый deployment mode дорогим

**H, авторская ретроспектива; переработано в V1.** Статья v2 от 22.04.2026, §§3–4, связывает V0 sandbox-centric assumptions, дублирование local tools/MCP и mutable config с трудностью CLI/local use. V1 разделил SDK, tools, workspace и server. [Источник](https://arxiv.org/html/2511.03690v2).

**Наш guard/test:** pure core не импортирует serving/config/environment; новый process-free harness и другой workspace выбираются на composition edge. Изменение deployment не должно требовать форка engine. **Не доказывает:** что любое monorepo плохо, что требуются именно четыре пакета, что V1 лишён всех ошибок или что наш принятый foundation имеет V0 coupling.

### K02. Mastra concurrent resume: read-before-write не выбирает единственного победителя

**H, PR21725 merged 19.08.2026, `84a5b699`.** Два callers могли прочитать suspended snapshot и повторить downstream effects. CAS suspended→running перенесён перед execution. Сам PR сохраняет warning/старое поведение для stores без atomic update и пропускает claim, если configuration не сохраняет running. [Источник](https://github.com/mastra-ai/mastra/pull/21725).

**Наш guard/test:** гонка двух continuation commands на реальном поддержанном store; один durable winner до эффекта, проигравший получает typed conflict. Отдельно capability/config refusal. **Не доказывает:** exactly-once всех внешних effects, исправление каждого store и всех опубликованных deployments, необходимость взять Mastra или наличие этой гонки у нас.

### K03. A2A Python: cache hit не может обходить owner authorization

**H, issue1159 closed / PR1172 merged 21.08.2026, `ddbf853d`.** Subscribe/cancel находили live task по task ID до owner-aware store; для обхода требовались live task и знание ID. Fix проверяет owner store первым. Тот же PR объединяет корректировку cancel terminal state в безопасном порядке. [Issue](https://github.com/a2aproject/a2a-python/issues/1159), [fix](https://github.com/a2aproject/a2a-python/pull/1172).

**Наш guard/test:** owner/non-owner × live/parked × observe/subscribe/cancel; authorization до cache/live facet, ошибки не раскрывают чужой объект. **Не доказывает:** уязвимость всего A2A protocol, безопасность от одного opaque ID, актуальную уязвимость исправленного main или аналогичный обход у agent-runtime.

### K04. Dapr timers: исправление HoL выбрало другой resource tradeoff

**H, PR10145 merged 03.07.2026, `8c0b37db`.** Синхронный callback общего processor задерживал timers других actors. Финальный commit `d774f9a` заменил первоначальный bounded pool на **unbounded per-actor loops**; serial order внутри actor сохраняется. Позднейший commit добавил reaping idle loops. Старые title/body не описывают финальный cap. [PR](https://github.com/dapr/dapr/pull/10145), [redesign](https://github.com/dapr/dapr/commit/d774f9a785faf647615db3736a4845f1f019a46b).

**Наш guard/test:** stuck data callback одного owner не блокирует чужой control/cleanup progress; одновременно измеряются aggregate live resources и teardown. **Не доказывает:** что финальный Dapr использует bounded pool, что unbounded concurrency всегда неправильна или что per-owner serialization сама даёт fairness/10k capacity.

### K05. SWE-ReX: успешный create не доказывает transport reachability

**H, issue253 closed completed 06.10.2025 в `e6d38e2`.** В containerized controller default localhost указывал на другой namespace: workload container создавался, RemoteRuntime connect истекал. Исправление сделало Docker internal host configurable. [Issue с timeline](https://github.com/SWE-agent/SWE-ReX/issues/253).

**Наш guard/test:** exact topology Host/keeper/daemon, transport endpoint и host mount-source namespace названы в profile; реальный E2E читает непустой mount и получает protocol readiness. Неподдержанная topology не получает permissive fallback. **Не доказывает:** что любой Docker-in-Docker неработоспособен, что баг остаётся открытым, что нужно реализовать все topology либо автоматически распознавать конфигурацию без наблюдаемых данных.

### K06. AI SDK WorkflowAgent: durable wrapper потерял approval provenance

**H, issue19964 closed и PR19976 merged 31.08.2026, `11109ae0`.** Core поддерживал signed approvals, wrapper не передавал эту возможность через durable replay/UI transformations. Fix добавил signing/verification внутри steps, binding к approval/tool/input и сохранение signatures без сериализации raw secret. [Issue](https://github.com/vercel/ai/issues/19964), [PR](https://github.com/vercel/ai/pull/19976).

**Наш guard/test:** выданное approval → преобразование/UI → disconnect/replay → consume; missing/tampered/input-mismatch/expired/revoked отклоняются до эффекта. **Не доказывает:** auth/CSRF bypass всего SDK, текущую unpatched vulnerability или необходимость HMAC для каждого trusted in-process callback. Требуется provenance и точная binding/authority, механизм зависит от trust boundary.

### K07. Agno: retry attempt fenced в storage, но tool effect всё равно повторяется

**D, официальная rolling documentation, прочитана 26.10.2026; не баг.** Queue `max_attempts>1` повторяет run с начала, включая уже исполненные tools; default 1 рекомендован для side effects. Attempt counter fencing отвергает late writes старого worker в собственные records. Submission idempotency — отдельный слой. [Источник](https://docs.agno.com/agent-os/background-execution/durable-queue).

**Наш guard/test:** fake tool совершает effect, теряет ACK до checkpoint; worker loss не разрешает blind repeat. Сохраняется query/idempotency/unknown path владельца эффекта. **Не доказывает:** что Agno скрывает эту семантику, что fencing бесполезен, что retries всегда запрещены либо что локальный claim даёт external-effect exactly-once.

### K08. OpenClaw: security claim начинается с поддерживаемой trust class

**D, официальная trust-model documentation, прочитана 26.10.2026; не уязвимость.** Один gateway рассчитан на single operator или взаимно доверяющую команду. Operator roles — guardrails внутри этого scope; session key — routing. Для adversarial users указаны отдельные gateways/host users. [Источник](https://docs.openclaw.ai/gateway/security/trust-model).

**Наш guard/test:** каждый profile называет TCB, unit of isolation и поддержанную tenancy; separate user/tenant model не возникает из branded IDs. Отрицательная проверка чужого scope относится именно к обещанному threat class. **Не доказывает:** tenant isolation bypass в поддержанной OpenClaw модели или необходимость VM для cooperative in-process components нашего SDK.

### K09. Temporal: closed-ID protection имеет retention horizon

**D, official workflow identity docs, прочитаны 26.10.2026; не баг.** Workflow ID уникален среди открытых executions в namespace. Reuse policies для закрытых executions применяются к retained records; Reject Duplicate не является бессрочным business deduplication ledger. [Источник](https://docs.temporal.io/workflow-execution/workflowid-runid).

**Наш guard/test:** retention продукта на command identity, heavyweight output и executable/recovery assets задаётся раздельно. После compaction/restore старый command ID не создаёт новый dispatch там, где продукт обещал долгую deduplication. **Не доказывает:** потерю retained Temporal data, нарушение его контракта, требование хранить всё вечно или безопасный replay внешнего эффекта одним workflow ID.

### K10. Jupyter: idle и полное окончание output — разные утверждения

**D, authoritative messaging spec 5.5, прочитана 26.10.2026; не баг.** Shell, IOPub, control и heartbeat разделены. Спецификация прямо допускает asynchronous output после idle; обработка таких out-of-order сообщений не полностью определена. Версия protocol отдельно от package jupyter_client 8.10.0. [Источник, Kernel status](https://jupyter-client.readthedocs.io/en/stable/messaging.html#kernel-status).

**Наш guard/test:** harness сообщает foreground completion, затем выпускает late output при stall/close; profile явно допускает/отклоняет его и не производит complete-output receipt из одного idle/reply. **Не доказывает:** потерю данных Jupyter, необходимость ZeroMQ или отдельных физических sockets у нас. Раздельный logical control progress можно доказать выбранным другим transport.

## 3. Синтез для greenfield foundation: что действительно следует из карты

Это **I — архитектурные выводы**, а не двадцать новых обвинений в technical debt. Существующие accepted ownership/fencing/recovery contracts следует сохранять; bounded ordinary delivery не обязана реализовать весь будущий target за один cutover.

| Отраслевой урок | Применимая граница foundation | Достаточное доказательство, когда появляется реализация |
| --- | --- | --- |
| Смена модели, tool executor, harness и environment — разные изменения | Малые owner capabilities; provider DTO/profile-specific facts за adapter; AE сохраняет session/execution authority | Process-free harness falsification; реальные неподдержанные semantics дают refusal, не fake process receipt |
| Replayable workflow не атомарен с произвольным внешним эффектом | Единственный владелец разрешения на dispatch; UNKNOWN и query/reconciliation; outer workflow не получает независимое retry authority | Effect succeeded/ACK lost; duplicate resume; restart/restore до/после durable accept |
| Locator, routing key, cursor, incarnation и authority не взаимозаменяемы | Session/operation/generation/host-boot и cursors принадлежат своим owners; auth-before-live facet | Cross-scope live/parked operations; same locator/new incarnation; replay cursor другого representation |
| Human wait — состояние/решение, а не бесконечный Promise | AE technical interaction lifecycle, RS authorization, product business approval flow; finite live wait либо explicit parking/retained custody | Revoke/cancel/expire до позднего approval; crash между issuance и reply; никакого revived effect |
| Один per-attempt limit не ограничивает fleet | Count preparing/running/closing/waiting readers и bytes; Host/storage/provider-account/deployment budgets раздельны | Mixed load + cancellation/close, slow append, waiting acquisition burst; staged измерение выбранного tuple |
| Foreground result не является output/resource settlement | Profile-specific output admission/drain, native custody evidence, retained cleanup debt | Late output, output gap, disconnected reader, stalled store, автономный deadline и truthful readback |
| Срок хранения результата не равен сроку dedup/recovery | Раздельные retention policies; последний compatible decoder/query/cleanup path живёт до разрешения obligations | Compaction и restore rehearsal; unresolved old-profile debt препятствует небезопасному retirement |
| Isolation, auth, network, quota и packaging — разные гарантии | Profile указывает TCB/topology/native tuple, credential destination и физические limits; язык/VM не подменяют контракт | Native E2E чужого scope/control channel, mounts, broker redirects, stop/debt; measured density отдельно |
| Reuse уместен для механики с совпавшими constraints | Mature parser/schema tooling — private implementation choice; domain invariants/release policy остаются owner-owned | Packed offline/browser import; independent boundary vectors и effect/lifecycle oracles |

Нельзя заключить, что agent-runtime «лучше 52 конкурентов». Системы обслуживают разные workloads, tenancy и failure domains; документация и issue histories имеют разную глубину. Здесь нет общего benchmark, performance ranking или одинакового conformance test. Правомерный результат — карта известных tradeoffs, выбранные инварианты и план квалификации собственного deployment.

## 4. Дополнительные механизмы масштабирования и модульности

Это целевые сопоставления первичных источников, не дополнительные «агентные фреймворки» в счётчике 52 и не перечень новых обязательных зависимостей.

| Источник и установленный факт | Наш вывод / действие | Граница вывода |
| --- | --- | --- |
| [Kubernetes client-go leaderelection](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go) прямо не гарантирует fencing | F12: stale worker после pause/lease loss должен встретить проверку у получателя эффекта или независимо enforced cutoff. Тест приостанавливает его между последней проверкой и эффектом | Leader election полезен для coordination; не дефект Kubernetes и не основание дублировать его собственным consensus |
| [PostgreSQL 18 warm standby](https://www.postgresql.org/docs/18/warm-standby.html) допускает потерю acknowledged transactions при async failover; [failover](https://www.postgresql.org/docs/18/warm-standby-failover.html) требует исключить возврат former primary | F03/F14: HA/RPO profile охватывает accepted effect identity. После promotion/restore до acceptance прежний внешний эффект не повторяется автоматически | COMMIT локального primary не доказывает cross-failure-domain durability; это deployment choice, не «сломанные транзакции PG» |
| [Temporal priority/fairness](https://docs.temporal.io/develop/task-queue-priority-fairness) документирует scope partitions, версии, restart и невозможность вытеснить уже начатую работу | C0–C3 квалифицируют собственную fairness по resource vector, возрасту и tenant skew; dispatch-count не выдаётся за CPU/token/spend fairness | Не утверждаем глобальное starvation freedom у чужой системы или что нужен её scheduler |
| [Backstage extension points](https://backstage.io/docs/backend-system/architecture/extension-points/) связывает конкретное extension API с plugin owner; [AWS SDK v3](https://github.com/aws/aws-sdk-js-v3) поставляет modular clients и curated exports | Узкие owner contracts и независимые tarballs; небольшой facade удобен, если не скрывает lifetime, whole framework и private imports | Количество пакетов не переносим как норму; локальное разбиение приложения не обязано совпадать с публикацией |
| [HashiCorp go-plugin](https://github.com/hashicorp/go-plugin) описывает отдельные процессы и local reliable-network assumptions | Executable boundary, transport и threat assumptions указываются явно. Local plugin protocol нельзя без проверки считать WAN worker protocol | Process boundary сама не гарантирует hostile containment или distributed retry semantics |
| [OTel stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) различает caller API и plugin implementer obligations | SDK caller и внешний автор adapter компилируются отдельными cases; public implementer promise имеет своего owner и compatibility window | Не принимаем чужой LTS срок и не публикуем private S2 conformance |
| [Restate versioning](https://docs.restate.dev/services/versioning) закрепляет deployment для исполнения; shared Virtual Object state переживает версии | Exact execution tuple плюс отдельная shared-schema compatibility. Drain, version switch и retained recovery проверяются независимо | Не принимаем Restate как dependency и не превращаем immutable endpoint в гарантию external-effect exactly-once |
| [Node exports](https://nodejs.org/api/packages.html#package-entry-points), [TS project references](https://www.typescriptlang.org/docs/handbook/project-references.html), [TS performance](https://github.com/microsoft/TypeScript/wiki/Performance) дают средства public/build boundaries с собственным overhead | Настоящие packed imports; measured changed-leaf/public-contract build fan-out до добавления новых projects/cache/tools | Никакого обещания million-LOC performance или обязательного числа TS projects по старому примеру |
| [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [provenance](https://docs.npmjs.com/generating-provenance-statements/), [SLSA v1.2 verification](https://slsa.dev/spec/v1.2/verifying-artifacts) различают artifact identity и проверку trusted source/builder/expectations | Release admission проверяет разрешённую identity; data artifact требует отдельного caller authorization. Используем поддержанную existing release route | Signature/digest не означает safe code, permission на запуск или поддержку provenance в любой private/public конфигурации |

## 5. Trust и два точно ограниченных security кейса

[Node Permission Model](https://nodejs.org/api/permissions.html) прямо не предназначен для malicious code. Следствие для нас: trusted in-process TS modules входят в TCB Host, разделяют ambient authority и failure scope. Borrowed ports, type checking и package exports полезны для архитектурной дисциплины, но не являются hostile-plugin sandbox. Rust/Go FFI в том же процессе также не создаёт изоляцию.

[MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) требует intended-audience checks и запрещает token passthrough; [security guidance](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) рассматривает confused deputy. Для первого соответствующего remote среза разделяем runtime caller grant, tool-server authorization, provider credential и разрешение spawn. Это не предложение строить OAuth service для подходящего private inherited FD.

### K11. Wasmtime HTTP: разрешённый proxy менял фактический destination

**H, исправлено.** [GHSA-5qpp-g3j2-8frx](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-5qpp-g3j2-8frx), опубликован 14.10.2026: absolute-form request target мог указывать другой host, если разрешённая connection authority являлась forwarding proxy/gateway. Исправлено в **36.0.18, 48.0.6, 49.0.3**.

**Наш guard/test:** выбранный credential broker согласует URL, request target, Host/authority, redirect/proxy и фактического получателя PA secret. При существовании raw/proxy path проверяется conflicting absolute target и разрешённый positive case; при невозможности представить этот path достаточно зафиксировать это свойство. **Предел:** public egress сам по себе не является bypass; это не обнаруженная уязвимость нашего runtime и не запрет legitimate private provider origin.

### K12. Wasmtime filesystem: patch/platform входят в обещанную границу

**H, исправлено.** [GHSA-m9f7-9w4p-gv38](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-m9f7-9w4p-gv38), опубликован 14.10.2026: trailing-slash symlink rename позволял escape на **macOS/FreeBSD**; advisory явно исключает **Linux/Windows**. Исправлено в **36.0.18, 48.0.6, 49.0.3**.

**Наш guard/test:** hostile-execution claim привязан к exact platform/patch/backend и filesystem policy. Тест другого kernel/path не становится доказательством выбранного tuple. **Предел:** это не дефект нашего Linux native target, не аргумент против любого Wasm и не автоматическое разрешение обновить pinned dependency.

[Wasmtime security](https://docs.wasmtime.dev/security.html), [epoch interruption](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html#method.epoch_interruption) и [Module deserialize](https://docs.wasmtime.dev/api/wasmtime/struct.Module.html#method.deserialize) дают ещё три constraints: host imports входят в доверенную границу; guest CPU budget не прерывает blocking host call; compiled-native cache принимается только из trusted artifact path. Wasm можно выбрать для ограниченного tool ABI, но нельзя обещать совместимость со всем CLI/SDK harness или создать второй custody journal. Текущая API-документация `51.0.0-dev` и опубликованный `50.0.0` от 20.10.2026 — разные факты, не наш adopted pin ([releases](https://github.com/bytecodealliance/wasmtime/releases)).

## 6. Что действительно установлено в нашем baseline

Все пути ниже относятся к исследованному SHA `518f1449acf6dda793662783ec9d918d4007c563`, а не будущей S2 реализации. Для удобства ссылки закреплены на этот commit.

| Наблюдение / статус | Exact source | Следствие для плана |
| --- | --- | --- |
| **Статический codec counterexample:** raw output cap 2 000 000 UTF-8 bytes, encode без конечного encoded cap, decode ceiling 8 388 608 bytes | [codec](https://github.com/agent-teams-ai/agent-runtime/blob/518f1449acf6dda793662783ec9d918d4007c563/packages/contexts/agent-execution/src/features/contained-agent-turn/adapters/outbound/postgres/ordinary-state-codec.ts), [validation](https://github.com/agent-teams-ai/agent-runtime/blob/518f1449acf6dda793662783ec9d918d4007c563/packages/contexts/agent-execution/src/features/contained-agent-turn/domain/ordinary-validation.ts), [limits](https://github.com/agent-teams-ai/agent-runtime/blob/518f1449acf6dda793662783ec9d918d4007c563/packages/contexts/agent-execution/src/features/contained-agent-turn/domain/contained-turn-limits.ts) | 2 000 000 U+0001 кодируются в JSON string размером 12 000 002 bytes ещё без envelope. F08 требует roundtrip всех admitted states и bound до mutation SQL |
| **Арифметика, не benchmark:** cancellation poll interval 250 ms при fast active flight; per-flight overlap guard | [ordinary engine](https://github.com/agent-teams-ai/agent-runtime/blob/518f1449acf6dda793662783ec9d918d4007c563/packages/contexts/agent-execution/src/features/contained-agent-turn/application/ordinary-engine.ts) | 10k одновременно polling flights дают номинально 40k read starts/s только при достаточной скорости; skipped ticks/stalls меняют результат. Измерить policy до fleet claim |
| **Новая acceptance refinement, не найденный production outage:** aggregate pending/owned/waiter bounds | [S2 brief](../architecture/agent-runtime-architecture-program-s2-operations-storage.md), [capacity plan](../architecture/capacity-admission-delivery-plan.md) | Reserve future obligation до acceptance; pool token до underlying settlement/dequeue; bounded control progress |
| **Already covered:** neutral refs/profiles, P599 independent checks; native single-owner custody; retained recovery; shared-login refresh race | [v3](../architecture/agent-runtime-architecture-program-plan.md), [S2](../architecture/agent-runtime-architecture-program-s2-operations-storage.md), [S3–S5](../architecture/agent-runtime-architecture-program-s3-s5-features-host.md) | Проверить конкретные signatures/paths. Не объявлять уже описанные protections отсутствующими и не заводить второго owner |

Codec результат получен чтением source branches и чистым вычислением размера JSON. Imported production codec fixture, PG/Codex trajectory и native/provider эксперимент **не выполнялись**. Transport cap 1 MiB может исключать именно эту provider trajectory; этого недостаточно, чтобы убрать source-level roundtrip obligation. Terminal headroom — требование нового формата, не второй доказанный incident. У каждой операции собственный row; baseline не доказывает один global row lock или сломанную производительность нового S2.

## 7. Правила, которые переносятся в документацию и acceptance

| Не допускать | Что фиксируем вместо этого | Где проверить |
| --- | --- | --- |
| Общий BaseAgent/manager, знающий все providers/stores/deployments | Consumer-owned capability, adapter и выбранный profile | F01, S2/S4 process-free falsification |
| Повтор effect после неизвестного ACK под видом retry доставки | Stable semantic identity, proof of non-acceptance либо reconciliation | F03/F04; ordinary one-shot и broader ADR scope раздельно |
| Новый execution slot после COMMIT без вместимости | Reserve до acceptance либо owner-atomic bounded backlog | F05–F07, C0–C3 |
| Timeout очищает только Promise, но не IO очередь | Actual waiter accounting и late result cleanup | F06, реальный driver/fault fixture |
| Accepted state невозможно прочитать/завершить | Encoded envelope и bounded terminal/reconcile growth | F08, pre-mutation vectors |
| Lease/heartbeat/opaque ID заменяют authorization/fencing | Target-side authority или independent cutoff; auth до cache/live | F09/F12/F16 |
| Foreground completion превращается в «всё доставлено и освобождено» | Раздельные execution/output/reader/custody facts | F02/F11, native exact E2E |
| Обновление стирает dedup/recovery horizon | Раздельные retention, migration, support и rollback contracts | F13/F14, restore/retirement cases |
| Количество replicas заменяет capacity доказательство | Суммарные budgets и exact mixed-load campaign | F15/F18, fleet charter |
| Подпись/контейнер/язык дают автоматическое доверие | Explicit trust class и authorized executable/data boundaries | F10/F16/F18, selected profile tests |

## Limitations

Это design evidence, а не production qualification, security certification или полный аудит всех ошибок индустрии. Исторические fixes не доказывают, что каждый опубликованный/установленный выпуск уже исправлен; rolling documentation не фиксирует artifact hash. Реальные benchmarking, installed-version audits и native/PG/provider failure campaigns относятся к реализации конкретного среза. Рекомендации проверяются по их инвариантам; чужой бренд не является доказательством нашего преимущества.

Актуальность moving sources — дата чтения 26.10.2026. Перед adoption сверяются exact published artifacts, platform, лицензии, known advisories и совместимость с собственным контрактом. В этом исследовании pins, accepted ADR и frozen contained не изменены.
