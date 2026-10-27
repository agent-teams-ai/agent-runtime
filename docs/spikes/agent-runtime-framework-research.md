---
id: evidence.agent-runtime.modular.frameworks
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Pinned SDK research and limits for OpenAI Agents, Google ADK and Microsoft Agent Framework.
---

# Agent Runtime Framework Research

## Observed target

Primary-source research dated 2026-10-27, baseline `c59fe8364071530d09b48eda47d41620f3f59c25`; exact upstream source identities and limits are recorded below. Related synthesis: [Agent Runtime Modular Research](../architecture/agent-runtime-modular-research.md).

## Method

Static source, manifest, official documentation and selected change-history review. Source facts, documented limits, historical fixes and our engineering inferences are distinguished below. Independent critiques and dispositions are retained in the [review record](agent-runtime-modular-research-review.md).

## Results

Дата проверки: **27 октября 2026**. Автор: независимый исследователь `research_frameworks`.

## 1. Контекст и пределы

Исходный план найден: [greenfield foundation](../architecture/agent-runtime-greenfield-foundation-plan.md), [решения и reviews](../architecture/agent-runtime-foundation-decisions-and-review.md), [предыдущее отраслевое исследование](agent-runtime-industry-architecture-research.md), snapshot **c59fe8364071530d09b48eda47d41620f3f59c25**, ветка **docs/architecture-program-v3**, PR235.

Это дополнение к существующим 52 reference entries, а не новый список якобы неисследованных конкурентов. Сохраняются четыре accepted contexts AE/PA/RS/RC, Operations как библиотечный механизм AE, первый ordinary S2 PostgreSQL, TypeScript application layer, отдельная native custody lane, ConnectRPC direction, обязательная поддержка public factory ports с первого релиза. Исследование не принимает новый runtime, не заменяет ADR и не доказывает qualification.

Проверены текущие официальные документы, manifests, interfaces и отдельные ADR/implementation files. Живые workloads SDK, API-вызовы моделей, реальные security exploits и benchmark не запускались. Некоторые исходники прочитаны через GitHub connector, поскольку сетевой доступ shell закрыт. Возраст проекта, звёзды и маркетинговые заявления в оценки не входят.

Классификация: **S** — факт проверенного исходника; **D** — документированное поведение; **H** — историческая проблема/миграция; **P** — предложенное upstream решение с неполной проверкой реализации; **I** — наш вывод. Отдельный факт не является доказательством всего проекта.

## 2. Точные snapshots и актуальность

| Проект | Проверенный HEAD | Версия в source manifest | Как использовать в сравнении |
| --- | --- | --- | --- |
| OpenAI Agents SDK Python | [b040da59037b1a34fee3a0dd4da95a571460eb98](https://github.com/openai/openai-agents-python/commit/b040da59037b1a34fee3a0dd4da95a571460eb98), 2026-10-27 | 0.24.0 в pyproject.toml | Актуальный agent/tool-loop SDK; прямой конкурент отдельным capability, не полная замена нашего lifecycle |
| OpenAI Agents SDK TypeScript | [be4f1f9aa4ad4f03cc5db5fdd57d0d0136923570](https://github.com/openai/openai-agents-js/commit/be4f1f9aa4ad4f03cc5db5fdd57d0d0136923570), 2026-10-21 | agents-core 0.21.0 | Особенно полезен для package surface и adapter design |
| Google ADK Python | [c54b253eba3359264a5f86805051aeb6cd93034d](https://github.com/google/adk-python/commit/c54b253eba3359264a5f86805051aeb6cd93034d), 2026-10-27 | 2.13.0 в version.py | Актуальный runtime/workflow/session framework; Python evidence не переносится автоматически на JS/Go/Java |
| Microsoft Agent Framework | [981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86](https://github.com/microsoft/agent-framework/commit/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86), 2026-10-27 | agent-framework-core 1.23.0 | Текущий Microsoft comparator; Python и .NET contracts рассматриваются отдельно |
| Microsoft AutoGen | [004749e6b7102c8fd317b9b1499ce5807223c278](https://github.com/microsoft/autogen/commit/004749e6b7102c8fd317b9b1499ce5807223c278), 2026-10-16 | Релиз не исследован | README сообщает archived и отсутствие fixes/support. Исторический источник, не основной candidate для greenfield adoption |
| Semantic Kernel | [660b1a4674aeaa74305cf06b023ecb1664fd0176](https://github.com/microsoft/semantic-kernel/commit/660b1a4674aeaa74305cf06b023ecb1664fd0176), 2026-10-27 | Версия не исследована | README направляет новых пользователей к MAF; на snapshot коммиты продолжаются. Не объявлять SK архивированным по аналогии с AutoGen |

Source manifest version не означает проверенный опубликованный release, tarball или воспроизведённую установку.

**Свежесть документации имеет значение.** AutoGen README в начале уже сообщает archived, а ниже сохраняет старую фразу maintenance mode. При конфликте использован свежий явный статус и соответствующий commit от 16.10.2026. Microsoft migration guide всё ещё содержит устаревающие строки «Anthropic/Ollama planned», хотя нынешние overview и source package tree содержат реализации. Поэтому эти строки не использованы как текущие конкурентные недостатки.

Источники статуса: [AutoGen README, строки 14–31](https://github.com/microsoft/autogen/blob/004749e6b7102c8fd317b9b1499ce5807223c278/README.md#L14-L31), [SK README](https://github.com/microsoft/semantic-kernel/blob/660b1a4674aeaa74305cf06b023ecb1664fd0176/README.md#L1-L6), [MAF overview](https://learn.microsoft.com/en-us/agent-framework/overview/).

## 3. Доказанные архитектурные находки

### F01. Отдельный package core ещё не означает provider-neutral contract

**S — OpenAI.** Python Model принимает и возвращает Responses-shaped input/events, а input/output aliases в items.py ссылаются на OpenAI SDK. JS опубликован отдельными agents-core, agents-openai, agents-realtime и agents-extensions, но agents-core на проверенном snapshot прямо зависит от openai ^7.2.0. Это осознанная форма SDK, не доказанный функциональный баг и не утверждение отсутствия поддержки других моделей.

**Плюс:** понятная модель вызова, provider adapters, полноценный runner/tool loop, отдельные package entry points. **Цена для нашего scope:** если такой ModelProvider сделать core contract agent-runtime, семантика выбранного API становится частью независимого runtime, а смена модели остаётся внутри прежнего harness.

**I — применение:** сохранить уже принятый whole-harness seam. Adapter может использовать OpenAI SDK внутри. AE/Operations не должны импортировать Responses items, prompt DTO или SDK RunState. Не писать собственный универсальный ModelProvider поверх уже нейтрального operational contract: это лишний слой без отдельного consumer.

Источники: [Python Model, строки 37–148](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/src/agents/models/interface.py#L37-L148), [type aliases](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/src/agents/items.py#L12-L88), [JS core manifest](https://github.com/openai/openai-agents-js/blob/be4f1f9aa4ad4f03cc5db5fdd57d0d0136923570/packages/agents-core/package.json#L130-L141).

### F02. Microsoft документирует цену provider dependencies в core и исправляет её

**H + S.** ADR-0021 прямо описывает прежнее смешение core abstractions с OpenAI/Azure implementations и зависимостями. Решение выделяет agent-framework-openai и оставляет compatibility namespaces ленивыми gateways. В текущем core manifest нет OpenAI/Azure SDK dependencies: реализация соответствует узкой проверенной части решения.

**Плюс:** разделение не заставляет пользователя собирать всё вручную — удобный import/facade сохранён. **Цена:** прежние публичные имена и namespaces потребовали migration/deprecation; modularity не бесплатна после публикации.

**I — применение:** consumer-friendly facade поверх отдельных библиотек допустим. Он не должен быть единственным доступным входом и не должен устанавливать/запускать все интеграции. Каждый runtime library выпускается с явным dependency graph; переносимые contracts выбираются до первых независимых consumers. В MVP не копировать legacy aliases без обязательства compatibility.

Источники: [ADR-0021, accepted, 2026-03-20](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0021-provider-leading-clients.md#L11-L40), [core pyproject dependencies](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/python/packages/core/pyproject.toml#L26-L34).

### F03. Google ADK: модули services полезны, но внутренний язык остаётся Gemini-shaped

**S.** В ADK LlmRequest.contents используется google.genai.types.Content, а config — GenerateContentConfig. Event наследует LlmResponse. Базовый install содержит google-genai вместе с FastAPI, uvicorn, aiosqlite и прочими runtime/developer dependencies; многие дополнительные интеграции вынесены в extras. SessionService существует как отдельный интерфейс.

**Плюс:** agent code может работать через session/artifact/memory services, а invocation events имеют явные identity и workflow metadata. **Цена для независимого low-level runtime:** перенос полного ADK Event или LlmRequest в core потянет чужой язык и lifecycle assumptions. Наличие модулей внутри одного distribution не обеспечивает минимальную installation surface для каждого механизма.

**I — применение:** reusable Operations library должна устанавливаться и типизироваться без web server, provider SDK и native platform implementation. ADK остаётся одним адаптируемым harness. Не переносить его Event наследование в нашу domain model только ради «DRY».

Источники: [LlmRequest, строки 21–90](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/models/llm_request.py#L21-L90), [Event](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/events/event.py#L87-L156), [base dependencies/extras](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/pyproject.toml#L33-L62), [SessionService](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/sessions/base_session_service.py#L63-L130).

### F04. Capabilities нужно объявлять, а не угадывать по имени модели

**S — полезное исправление ADK.** BaseLlm.capabilities возвращает validated capability snapshot. Deprecated fallback ещё распознаёт часть возможностей по имени/variant; собственные Gemini/LiteLlm implementations явно объявляют capability. LlmCapabilities запрещает неизвестные поля, immutable, а default output_schema_and_tools — false. Документирован риск model_copy(update=...), который обходит validation.

**I — применение:** выбранный harness/profile явно заявляет поддержанный capability contract; unsupported нельзя превращать в успешный no-op. Name-based auto-detection не даёт права включить resume/fork/approval/kill/drain. Но self-report тоже не равен qualification или RS permission: нужны отдельные compatibility/authorization checks уже принятого F10. Immutable descriptor не должен кешировать динамический credential grant.

**Минимальный negative case:** adapter называется как поддержанный vendor, но не реализует continuation; его запуск с required continuation отвергается до защищённого эффекта. Опечатка capability field должна быть ошибкой construction/validation, а не silent fallback.

Источники: [BaseLlm capability property and fallback](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/models/base_llm.py#L36-L126), [LlmCapabilities](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/models/_capabilities.py#L52-L85).

### F05. Guardrail pipeline не является универсальной authorization boundary

**D — OpenAI.** Parallel input guardrails являются default и могут завершиться после начала модели/выполнения tools. Blocking mode позволяет проверить вход до старта. Tool guardrails применяются к FunctionTool pipeline, в том числе к настроенным local MCP tools; handoff, hosted и ряд built-in execution tools используют другие paths. Это явно описанные границы, а не скрытая vulnerability.

**I — применение:** RS authorization перед фактическим защищённым эффектом не заменяется общей hook/guardrail над user input. «У adapter есть beforeTool hook» недостаточно для обещания контроля любых effects. В capability/profile указываются interceptable effect paths и hosted effects, которые контролируются только provider-side policy либо не поддержаны.

**Минимальная проверка:** разрешение отозвано между approval и dispatch; ordinary function, delegated agent, hosted tool и built-in execution path должны либо проверить актуальный grant у своего enforcement owner, либо быть недоступны в заявленном strict profile. Из этого не следует строить новый universal security middleware: существующие RS/PA/adapters остаются владельцами.

Источник: [guardrails guide](https://openai.github.io/openai-agents-python/guardrails/), [pinned guide, execution modes and tool scope](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/docs/guardrails.md#L10-L80).

### F06. Conversation history должна иметь одного владельца подачи в модель

**D + P.** OpenAI Session нельзя комбинировать в одном run с conversation_id/previous_response_id/auto_previous_response_id. Это полезный явный запрет двойной истории. Microsoft ADR о Foundry history-source описывает duplicate prior turns, когда host replay transcript соединяется с restored downstream service_session_id. ADR имеет status proposed; весь fix/PR/released deployment здесь не проверен. Нельзя выдавать его за текущий подтверждённый MAF defect или уже исправленный во всех версиях.

**I — применение:** AE owns execution/session binding; harness owns own history semantics; runtime output projection не должна автоматически становиться повторным model input. В adapter нужно явно выбрать history authority для данного continuation path. Нельзя одновременно передавать полный transcript и opaque downstream continuation, если API не документирует такую комбинацию.

**Минимальный тест:** первый turn, сохранение provider locator, host restart, повторный turn; spy/model transport получает прошлую реплику ровно в разрешённой форме, не двумя каналами. Отдельно switch model/harness: supported new binding не выдаётся за lossless migration существующей conversation.

Источники: [OpenAI sessions overview](https://openai.github.io/openai-agents-python/sessions/), [MAF proposed ADR-0039 history source](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0039-python-foundry-hosting-history-source.md#L1-L27).

### F07. Protocol compatibility не гарантирует concurrent reuse

**S — MAF.** SupportsChatGetResponse прямо предупреждает: structural protocol conformance сам по себе не гарантирует reuse instance across concurrent calls. У ADK BaseLlm, наоборот, есть конкретный contract о concurrent calls через shared model instance внутри event loop. Подпись похожего метода не делает эти lifetime/concurrency contracts одинаковыми.

**I — применение:** public implementer surface должен фиксировать acquired/borrowed ownership, sharing scope, concurrency и closing semantics. Conformance kit проверяет не только DTO и happy path. Нет оснований требовать per-operation instance от всех adapters или singleton от всех libraries: ограничения конкретного consumer и implementation должны совпадать.

**Минимальные cases:** два независимых scopes одновременно; cancellation одного не закрывает borrowed shared client второго; owning Host закрывает ресурс один раз после settled borrowers; adapter, допускающий только serial use, получает подходящий local bound и не скрывает это.

Источники: [MAF SupportsChatGetResponse, строки 85–101](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/python/packages/core/agent_framework/_clients.py#L85-L101), [ADK BaseLlm concurrency note](https://github.com/google/adk-python/blob/c54b253eba3359264a5f86805051aeb6cd93034d/src/google/adk/models/base_llm.py#L36-L42).

### F08. Semantic storage contract важнее одинаковых CRUD имён

**H + S — MAF .NET.** Upstream ADR объясняет проблему двух AgentSessionStore с разными Get semantics: один creates missing session, другой returns null. Текущий Abstractions AgentSessionStore содержит отдельные GetSessionAsync и GetOrCreateSessionAsync, а AgentSessionStoreKey включает все named partitions. ADR metadata ещё proposed, поэтому реализация проверена отдельно. Ключ и contract имеются в source, release qualification не утверждается.

**I — применение:** одинаковые названия repositories не создают Liskov substitutability. Для нашего semantic store фиксируются preconditions, atomicity, absent/conflict/unknown outcomes и scope. Tenant/key normalization не должен происходить по-разному в load/save/delete/observe. Но нам не нужен новый generic SessionStore сейчас: ordinary S2 уже имеет собственный consumer-owned semantic contract.

**Минимальные cases:** missing read не создаёт state; одинаковый logical ID при разных trusted scopes адресует разные записи; неизвестный partition не отбрасывается; перестановка equivalent key fields не создаёт другую identity. Это подтверждает существующие F16 и S2 owner stores, не расширяет scope на universal history DB.

Источники: [ADR-0039 store rationale](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/docs/decisions/0039-shared-agent-session-store.md#L10-L55), [actual store methods](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/dotnet/src/Microsoft.Agents.AI.Abstractions/AgentSessionStore.cs#L20-L95), [actual immutable key](https://github.com/microsoft/agent-framework/blob/981f70e3c7bb9d8062dd5e7eafbca1684c6a9a86/dotnet/src/Microsoft.Agents.AI.Abstractions/AgentSessionStoreKey.cs#L18-L70).

### F09. Хорошая современная реализация уже защищает replay; нельзя приписывать ей старые пробелы

**S + D — OpenAI.** Retry contracts различают provider safe/unsafe/unknown, abort, streamed emission, local-side-effect veto и stateful requests. Runner запрещает ряд unsafe retries даже при application retry decision и контролирует скрытые underlying SDK retries. JS SessionHistoryTransactionAwareSession требует atomic persistence operationId+history и запрещает same ID/different transaction.

**I — применение:** конкурентное преимущество нельзя описывать как «только у нас UNKNOWN/безопасные retry». Оно может заключаться в едином, публично проверенном runtime contract across harnesses и выбранном deployment. Не копировать частные retry predicates в AE: ordinary one-shot restrictions сохраняются, более широкий retry допустим только по принятому proof.

Источники: [retry safety guide](https://openai.github.io/openai-agents-python/models/#safety-boundaries), [source retry vetoes](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/src/agents/run_internal/model_retry.py#L384-L482), [hidden SDK retry control](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/src/agents/run_internal/model_retry.py#L517-L554), [JS transaction-aware session](https://github.com/openai/openai-agents-js/blob/be4f1f9aa4ad4f03cc5db5fdd57d0d0136923570/packages/agents-core/src/memory/session.ts#L133-L171).

### F10. Durable resume без external-effect idempotency остаётся at-least-once

**D — ADK.** Resume guide прямо говорит о возможном повторе tool executions; непрерывно менять stopped workflow перед resume не поддерживается; custom agents сами обеспечивают resumability. Это контрпример к выводу «framework умеет resume, значит continuation безопасен для любого эффекта».

**I — применение:** extra harness resume capability не активируется автоматически из наличия метода resume. Нужен точный adapter/profile contract для unknown effect, code/version, pending approvals и ownership. Первый G3 может честно поддержать только новые bindings, отказавшись от resume, пока его semantics не квалифицированы.

Источник: [ADK resume, Tool execution behavior и Workflow modification](https://adk.dev/runtime/resume/#how-it-works).

### F11. Telemetry — отдельный канал данных с собственной политикой

**D — OpenAI.** Tracing включён по умолчанию; trace_include_sensitive_data default true, есть отключение, custom processors/redaction. Отключение tracing не удаляет уже buffered data, а explicit flush может отправить их. Это документированное поведение и operator configuration responsibility.

**I — применение:** для библиотеки runtime подключение observation/exporter должно быть явным на composition boundary. Secret/prompt/output minimization определяется до создания spans, а не post-hoc disable после отказа. Не делать tracing вторым неограниченным output/history store. Не утверждать, что «OpenAI безусловно сливает секреты»; источник описывает управляемую feature с настройками.

**Минимальный case:** token-like fixture в error/prompt/tool result отсутствует в default export; cancellation/disable не выдаются за deletion уже экспортированных данных; byte/count bounds продолжают действовать при exporter failure.

Источник: [tracing guide](https://openai.github.io/openai-agents-python/tracing/), [pinned defaults/buffer notes](https://github.com/openai/openai-agents-python/blob/b040da59037b1a34fee3a0dd4da95a571460eb98/docs/tracing.md#L104-L175).

## 4. Что реально сделать лучше в agent-runtime

Ниже **I — engineering proposal**, а не установленное превосходство.

| Обещание | Достаточная библиотечная граница | Как доказать лучшее соответствие нашему scope |
| --- | --- | --- |
| Новый harness не меняет AE policy | Harness-specific adapter → consumer-owned semantic operation capabilities | Changed-file/import check и два реально разных consumers; один без process/PID semantics |
| Минимальная установка механизма | Operations/JSONL/protocol independent tarballs; adapters отдельно | Packed external project без provider/web/native dependencies, imports без effect |
| Provider capability не выдумывается | Explicit descriptor, typed unsupported, qualified tuple | Adapter-name spoof, unsupported optional family, wrong revision; отказ до protected effect |
| Обновление не теряет history authority | Opaque provider binding и отдельная UI projection | Double-history detection; old session/new adapter отказ либо явный migration contract |
| Scope и lifetime не скрыты | Public caller + public implementer obligations | Two tenants, concurrent calls, partial cancellation, borrowed owner disposal cases |
| Безопасный effect path | RS/PA decisions у соответствующих enforcement boundaries | All declared effect paths, revoke-before-dispatch, no implicit approval revival |
| Retry policy не размножена | AE operation authority + provider-local safe behavior в adapter | Unknown ACK не включает одновременно SDK retry и runtime redispatch |

**Новые слои ради этих фактов не требуются.** Большая часть уже правильно отражена в foundation plan. Нужны уточнённые acceptance cases и библиотеки с реальными независимыми consumers. Дополнительный абстрактный AgentBase, universal ModelProvider, generic context bag, глобальный registry или общий provider message domain здесь ухудшат change locality.

Внутри adapter допустим прямой импорт SDK и его DTO. Anti-corruption mapping нужен на границе несовпадающих semantics; механическое копирование каждого поля между пятью одинаковыми DTO не улучшает Clean Architecture.

## 5. Top-3 для реально ещё открытой G3 интеграции

Это **не переоткрытие** уже принятого whole-harness contract и **не** предложение заменить ordinary Codex S1/S2. Выбор нужен только когда продукт решит, какая дополнительная ecosystem family станет первым реальным G3 consumer. Если такого consumer пока нет, G0–G2 продолжаются без выбора и без реализации трёх adapters.

Общий bounded scope оценки: один дополнительный harness, новые bindings, text + function-tool loop, bounded observations, typed failures, explicit cancellation semantics, portable adapter test kit, пример внешнего consumer. Не включены lossless cross-harness session migration, hosted arbitrary tools, sandbox engines, generic workflow engine, fleet, marketplace или native owner implementation. P — новые handwritten production/integration LOC; T — tests/fixtures, отдельно. Оценки не vendor ranking и не measured SLA. LOC confidence **3/10**, архитектурная confidence — колонка У.

| Вариант | Причина выбрать | С / Н / У (10 = выше) | P / T LOC |
| --- | --- | --- | --- |
| **A. OpenAI Agents SDK TypeScript как process-free cooperative harness** | Самый короткий путь проверить, что AE не зависит от Codex/PID, оставаясь в принятом основном языке | **4 / 8 / 8** | **1 200–2 800 / 2 000–4 500** |
| B. Microsoft Agent Framework как managed external harness | У consumer уже есть MAF/.NET/Python agents и требуется их реальное подключение; проверяет более сильную language/process границу | 7 / 8 / 6 | 2 500–5 500 / 3 500–7 500 |
| C. Google ADK как managed external harness | Первый внешний consumer уже использует ADK/Gemini workflows; проверяет mapping event/session semantics и явно ограниченный resume profile | 7 / 7 / 6 | 2 800–6 000 / 4 000–8 000 |

Во всех трёх вариантах reliability оценена для **заявленного bounded promise**, а не для враждебных плагинов. В B/C процесс запускается/контролируется через существующего native custody owner в выбранном profile, а approved Connect direction сохраняется; это не повод строить второй supervisor. Cost не включает релизную поддержку чужих языковых окружений, signing/images, integration credentials и operational runbooks. В B/C эти работы заметно больше, чем видно из LOC.

### Критическая проверка A

- **Сильнейшее возражение:** близость к TS и OpenAI ecosystem даст слишком лёгкую проверку neutrality; provider-shaped DTO могут тихо проникнуть в core.
- **Ответ:** проверяется только reuse operational contract. Model loop и provider history остаются opaque. Packed consumer compile не имеет dependency на agents SDK через public core types.
- **Что опровергнет рекомендацию:** реальному первому consumer нужен Python/ADK/MAF, либо contract всё равно требует provider-specific state в AE, либо unsupported cancellation не удаётся честно выразить.
- **Эксперимент, меняющий решение:** disposable adapter, два последовательных operations и cancel mid-stream; native/process-free false assumptions должны проявиться без внешних эффектов. Это будущий spike, не уже выполненный тест.
- **Критическое ограничение:** process-free cooperative adapter не демонстрирует hostile isolation, native deadlines или устойчивость к event-loop block.

### Критическая проверка B

- **Сильнейшее возражение:** фактически проверяется transport/bootstrap/packaging, а не нужная библиотечная abstraction; scope может разрастись.
- **Ответ:** выбирать B только с настоящим MAF consumer. Не переносить MAF workflows/session store в AE. Клиент/bridge работает через accepted runtime transport/native boundary.
- **Что опровергнет:** B нужен лишь «чтобы показать поддержку Microsoft» без потребителя или выбор exact SDK/language/profile ещё не сделан.
- **Эксперимент:** request accepted → ответ потерян; повторный wake-up не запускает новый external effect. Stop/restart не отождествляются с завершением remote agent.
- **Незакрытая uncertainty:** точная семантика remote continuation и language-specific resource lifetime требует отдельного qualification inventory.

### Критическая проверка C

- **Сильнейшее возражение:** ADK resume/at-least-once окажется несовместим с ordinary one-shot expectations и создаст второй retry owner.
- **Ответ:** initial profile только new bindings, resume capability выключена; external consumer разрешён только с явно выбранным recovery behavior. ADK hooks и auth wrappers не заменяют RS.
- **Что опровергнет:** единственная ценность consumer состоит в opaque resume с произвольными необратимыми tools, а доказать idempotency/query невозможно.
- **Эксперимент:** completed tool + lost result + resumed invocation; adapter не должен выдавать exactly-once или автоматически redispatch прежнюю runtime operation.
- **Незакрытая uncertainty:** code/workflow upgrades и state ownership must be pinned per deployed ADK tuple; Google docs не дают универсальный migration contract.

**Рекомендация исследователя:** A — только при отсутствии заранее выбранного реального ecosystem consumer; B/C получают приоритет при наличии соответствующего consumer. Не делать второй harness сейчас лишь ради абстракции: предусмотренный process-free falsification fixture уже помогает проверить ненужные assumptions в S2.

Первоначальный self-critique дополнен независимыми evidence/architecture/failure reviews; coverage, замечания и повторная проверка находятся в [review record](agent-runtime-modular-research-review.md).

## 6. Реестр антипаттернов: запоминать причину и предел

| ID | Антипаттерн для нашего проекта | Источник урока | Коррекция и owner |
| --- | --- | --- | --- |
| AP-F01 | Назвать package core, но сделать vendor DTO обязательным для каждого consumer | F01/F03, текущие SDK design tradeoffs | AE owns neutral operational language; DTO внутри adapter |
| AP-F02 | Вынести файлы по папкам, сохранив все heavy deps в базовом install | F02/F03 | Package boundary доказывается isolated tarball install |
| AP-F03 | Определять capability по brand/model name | F04, deprecated ADK fallback | Adapter declaration + qualification; отдельно RS permission |
| AP-F04 | Считать input guardrail разрешением всех последующих effects | F05, documented pipeline scope | RS authorization у реального effect owner |
| AP-F05 | Replay полного transcript плюс remote conversation locator | F06, documented restriction/proposed upstream repair | Один history input owner per adapter profile |
| AP-F06 | Из одинаковой method signature выводить singleton/concurrent safety | F07 | Public lifetime/sharing contract и соответствующие tests |
| AP-F07 | Унифицировать stores только по именам CRUD | F08 | Semantic atomic operations, explicit absent/conflict/unknown |
| AP-F08 | Повторять UNKNOWN ради удобного resume UX | F09/F10 | Existing AE authority и validated safe replay only |
| AP-F09 | Выключать logging после того как secret уже попал в buffer | F11 | Default minimization до recording; bounded explicit exporter |
| AP-F10 | Приписывать framework старый недостаток после исправления | F02/F09/AutoGen status | Pin+date+fact/history/inference labels; сохранять counterevidence |

Эти записи не утверждают наличие соответствующих bugs в agent-runtime. Они превращают источник в review question и конкретный acceptance case.

## 7. Достаточные дельты к плану

1. В existing industry research уточнить AutoGen как historical archived reference, а MAF как актуальный comparator.
2. Добавить F01/F02/F03 как source-backed evidence к уже принятой библиотечной границе — без нового universal core package.
3. Добавить F04/F05/F07 в acceptance выбранного real harness capability: capability declaration, effect-path coverage, sharing/lifetime.
4. Сохранить сильные контрпримеры F09: современные SDK уже имеют replay protection и idempotent session operations; наше отличие надо доказывать на scope нескольких harnesses.
5. G3 choice делать по первому consumer, а не по количеству логотипов. Ничего из этого не блокирует согласованный S1/S2 publication train.

## 8. Что остаётся неизвестным

Не проверены опубликованные package artifacts, benchmark под одинаковым workload, все языковые ports, все security issues, реальные tool side effects и deployment operators. Нет оснований сравнивать проекты единым баллом «надёжность SDK» или обещать превосходство agent-runtime до реализации. Отдельный session method или capability flag не доказывает entire-system guarantee.

Следующая проверка имеет смысл только если её результат меняет реальное G3 решение: exact consumer language, required effect classes, continuation needs, native deployment profile и supported upgrade horizon. Иначе дополнительный framework catalogue даст меньше пользы, чем завершение первых независимых библиотек с contract tests.



## Уточнения после независимой критики

Python OpenAI guardrails/retry evidence не переносится автоматически на TypeScript SDK. JS core dependency и SessionHistoryTransaction capability проверены отдельными sources. Для D3-A выбирается exact TS adapter и отдельно проверяются declared paths. Аналогично MAF Python/.NET не считаются одной идентичной реализацией.

Новые bindings и disabled resume не устраняют скрытые inner tool/model retries. Гарантия ordinary runtime — его собственный protected dispatch/one turn-start; произвольные внутренние effect paths требуют отдельного inventory/qualification. Process-free cooperative A не обещает hard cutoff/hostile isolation, managed B/C имеют другой cost/failure profile.

Тройка G3 — условные ecosystem candidates, не объективные top-3 рынка. AI SDK/OpenHands/PydanticAI исследованы в companion [library research](agent-runtime-library-research.md) и не объявлены хуже: для реального consumer shortlist пересобирается по language, required effect/continuation class и existing dependencies. Нет current consumer — нет искусственного adapter delivery.

Nonsecret runtime/output/diagnostic representation проходит owning PA/RS policy до persistence/export; immutable source для model/view projection означает уже допущенное содержимое. PA credential custody подчиняется своему отдельному контракту. Для remote revoke действуют target fencing/cutoff выбранного profile; caller-side check не обещает instantaneous remote revocation.

## Limitations

No competitor runtime, live provider, native/PostgreSQL failure campaign or comparative benchmark was executed. A source commit or manifest does not establish a released or installed artifact. All proposed experiments remain planned; accepted owner contracts and exact deployment qualification control implementation.
