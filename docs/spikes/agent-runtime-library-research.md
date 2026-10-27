---
id: evidence.agent-runtime.modular.libraries
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Pinned AI SDK, Mastra, PydanticAI and OpenHands modularity evidence and alternatives.
---

# Agent Runtime Library Research

## Observed target

Primary-source research dated 2026-10-27, baseline `c59fe8364071530d09b48eda47d41620f3f59c25`; exact upstream source identities and limits are recorded below. Related synthesis: [Agent Runtime Modular Research](../architecture/agent-runtime-modular-research.md).

## Method

Static source, manifest, official documentation and selected change-history review. Source facts, documented limits, historical fixes and our engineering inferences are distinguished below. Independent critiques and dispositions are retained in the [review record](agent-runtime-modular-research-review.md).

## Results

Дата проверки: **2026-10-27**. Исследователь: research_modularity. Это source/documentation evidence и инженерные предложения для review; не adoption и не production qualification.

## 1. Scope и baseline

Прочитаны greenfield-plan, foundation-decisions/review, industry research и S1–S5 briefs в agent-runtime, ветка docs/architecture-program-v3, baseline c59fe8364071530d09b48eda47d41620f3f59c25. Существующие 52 строки каталога и K01–K12 не пересоздаются. AE, PA, RS, RC, Operations в semantic ownership AE, Get Modular/FMS/CMS, отдельная native lane, PostgreSQL first ordinary store и public S1/S2 — исходные условия.

Исследованы Vercel AI SDK (TypeScript model/harness ecosystem), Mastra (TypeScript agent/workflow platform), PydanticAI (typed core с optional dependency sets), OpenHands Software Agent SDK (modular coding runtime). Выбор по применимости, не по звёздам или недоказанному market share. Не исчерпывающий vendor ranking.

Метод: официальные rolling docs; GitHub manifests, contracts, source и merged PR на immutable commits. Source manifest/HEAD не подтверждает публикацию npm/PyPI или наличие fix в пользовательской установке. Чужие runtimes, installs, live models и benchmark не запускались. Выполнен только статический подсчёт JSON keys. Документы открыты web tool, source — GitHub API; полные raw snapshot не нужны в итоговом репозитории.

Типы: **D** — текущая документированная семантика/предел; **S** — прочитанный source; **H** — историческая проблема с проверенным статусом; **I** — наше инженерное следствие. I не является найденным чужим defect.

| Проект | Прочитанный SHA | Source metadata, не release qualification |
| --- | --- | --- |
| Vercel AI SDK | c3b6fef1ffcebd52a8fa1495b96785dc9d802880 | ai 7.0.154; provider 4.0.34; harness 1.0.165; harness-codex 1.0.167 |
| Mastra | e56f88e18d906635b033173abcae637cf361ce8a | core 1.80.0-alpha.4, не stable release claim |
| PydanticAI | 58fa0d9dd764ee0b2eddf4b420a44daa8df2cb4c | version вычисляется из Git; пинним commit |
| OpenHands Software Agent SDK | 6edd54d481cd778abcdb0dab6ce566e529788d4a | четыре manifests 1.58.2 |

## 2. Genuine delta к предыдущему исследованию

### 2.1 AI SDK уже прямой whole-harness конкурент

**D/S.** AI SDK v7 отделяет model providers от whole-agent harnesses. Есть harness packages Codex/Claude Code/OpenCode/Pi/ACP и другие, sandbox adapters, workflow-harness. Описание AI SDK только как model API layer уже неполно. Harness API официально experimental и допускает breaking changes. [M01–M02]

**Сильные решения:** versioned HarnessV1; adapter identity; start→session boundary; opaque native lifecycle state; разделение host tools/builtin tools; sandbox ownership у создавшего его caller; history unsupported, unavailable environment и empty history — разные результаты. [M03–M05]

**Документированный предел:** один doContinueTurn поддерживает lossless attach/replay живого runtime и lossy rerun из сохранённого thread state после утраты runtime. Незавершённая работа при rerun recomputed. Host-resident Pi не может оставить turn живым после выхода процесса; uniform method shape не означает uniform effect guarantee. Это написано в source, а не скрытый defect. [M04]

**Отдельный предел:** при смене skills/instructions/tool catalog Codex adapter начинает новый native thread и прежний native context не переносится. Неизменные settings продолжают thread. Смена model — другой случай. [M06]

**Следствие I:** не заявлять уникальность самого harness seam. Потенциальный выигрыш — строгий selected execution profile: no-replay после unknown effect; admission конкретного continuation behavior; отдельно turn completion, output drain, physical release. В future session slice context discontinuity — explicit reset/new binding/refusal. Не вводить universal history aggregate в Operations.

### 2.2 Число пакетов не измеряет независимость

**S.** AI SDK provider contract package имеет одну direct dependency (json-schema). ai зависит от gateway/provider/provider-utils, harness — от ai/provider/provider-utils. Это staged packaging, но не доказательство отсутствия coupling или лёгкого install. [M07]

**S.** Mastra core manifest содержит **88 export entries и 30 direct dependencies**. Среди aliases: AI SDK provider v5/v6/v7, A2A 0.3/v1. Экспорты включают agent/workflow/server/auth/storage/workspace. Это измеренная ширина API/dependency surface; не bundle/RSS/install benchmark и не доказательство плохой архитектуры. [M08]

**S/D.** PydanticAI slim допускает выбор extras для models/MCP/UI/telemetry/durable backends. Это optional dependency sets одного distribution, не независимые provider packages; core всё равно требует pydantic-graph exact same version. [M09–M10]

**S/D.** OpenHands имеет четыре пакета, но workspace зависит от SDK и agent-server, server — от SDK и tools. SDK прямо зависит от LiteLLM, FastMCP, ACP, lmnr и др. Четыре packages не означают четыре независимых leaves; такая closure может быть оправдана remote workspace product. [M11–M12]

**Следствие I:** для S1 JSONL/protocol и S2 Operations проверять standalone tarball consumption и конкретную dependency closure. Context, feature, package, process — разные единицы. Не тянуть UI/native/DB/provider/exporters в pure mechanism лишь ради root convenience. Зависимость от другого маленького механизма допустима, если отражает реальную семантику.

### 2.3 Release policy бывает выборочной

**S.** AI SDK Changesets fixed/linked пусты; Mastra задаёт конкретные fixed-группы (core/server/deployer/deployer-cloud и отдельно CLI family). OpenHands source manifests имеют один номер; Pydantic slim exact-pins graph к собственной вычисленной версии. [M10][M12–M14]

**I:** независимые package versions совместимы с coordinated qualified runtime train. S2 all-owner store publication остаётся dependency-complete; pure S1 не ждёт весь runtime. Одинаковый SemVer не доказывает wire/state/native/profile compatibility.

## 3. Concrete cases: ограничения и исправленные грабли

### M-H01. Mastra: history mapping оставлял result без call

[PR28286](https://github.com/mastra-ai/mastra/pull/28286) merged 2026-10-27T16:55:30Z, SHA e56f88e18d906635b033173abcae637cf361ce8a; [issue28190](https://github.com/mastra-ai/mastra/issues/28190) closed. Processor удалял foreign hosted tool call внутри assistant message, оставляя matching result; после OpenAI↔Anthropic switch следующий request становился malformed. Fix удаляет пары согласованно, сохраняя unrelated content и исходную persisted history. Upstream regression tests inspected, не исполнялись нами. [M15]

**Residual:** PR исключает ownership-aware сохранение gateway.* results across vendors: request уже корректен, но контекст может потеряться и потребовать refetch. Live Gateway/provider errors в PR не тестировались. Не описывать проблему как остающийся orphan-result bug.

**Наш invariant I:** projection/adapter preserves call/result causality и не меняет canonical history. Это нужен targeted test реального selected history converter, не новый universal conversation model.

### M-H02. OpenHands: redaction повреждал structural event fields

[PR6259](https://github.com/OpenHands/software-agent-sdk/pull/6259) merged 2026-10-27T16:02:56Z, SHA 6edd54d481cd778abcdb0dab6ce566e529788d4a. Generic string masking мог изменить timestamp или фиксированный Literal; event переставал проходить reload validation, timestamp cursor давал HTTP422. Fix сохраняет structural timestamps/Literals, продолжая редактировать user content. Старые повреждённые histories явно вне scope fix. [M16]

**Наш invariant I:** redaction view не разрушает identity/discriminants/codec/cursors. Это не blanket exemption для всех IDs: sensitive user input не должен превращаться в доверенную structural identity. Test existing owner record decode→persist→reload→pagination; не новый global sanitizer. Existing PA diagnostic/value policy остаётся authoritative.

### M-D01. OpenHands: direct tool API — privileged execution surface

Документация и LocalConversation.execute_tool прямо говорят, что direct call bypasses agent-loop confirmation/security analyzer. Caller отвечает за safeguards. Analyzers возвращают risk; не являются sandbox или полной prompt-injection защитой. Это явная trust boundary, не скрытая vulnerability. [M17–M18]

**Наш invariant I:** если runtime обещает RS enforcement, effectful public paths либо проходят тот же authorization owner, либо имеют отдельный explicitly privileged caller contract. Risk score/approval UI/valid signature не равны execution authority. Не добавлять analyzer в core только ради security label.

### M-H03. OpenHands V0: повторная проверка уже известной ретроспективы

Авторы описывают state duplication, restoration/version drift, application conditionals в core, heavy research dependencies. V1 переработан против этих проблем. Это уже K01 baseline; не считать новым finding и не приписывать V0 defects актуальному V1. [M19]

**Контрдоказательство:** OpenHands уже modular; Mastra уже имеет storage domains и run fencing. Нельзя рекламировать наше преимущество утверждениями «у них нет modularity/fencing». Конкретная гарантия всегда проверяется по adapter/config/deployment. [M20–M21]

## 4. Полезные приёмы без нового framework

| Приём | Evidence | Применение в нашем плане | Не переносим |
| --- | --- | --- | --- |
| Model отдельно от whole harness | AI SDK v7 | F01, independent AE binding | Общий BaseAgent |
| Contract revision отдельно от package SemVer | HarnessV1/LanguageModelV4 | S1/native/codec/profile identities | Единую version для всего |
| Optional integration dependencies | Pydantic slim | Узкие S1/S2 tarballs | Все extras в первый релиз |
| Curated public exports | Manifests | Caller и implementer compilation | Экспорт каждого helper |
| Selected release groups | Mastra Changesets | All-owner S2 train, pure S1 separately | Lockstep всего repo без причины |
| Adapter-owned native history | Harness lifecycle | Opaque binding/revision в AE | Universal history aggregate |
| Non-destructive normalization | Mastra pair fix | Causal consistency adapter projection | Lossless all-provider migration |
| Schema-aware redaction | OpenHands fix | Safe owner representation/reload | Skip всех IDs/strings |
| Explicit privileged methods | OpenHands API | RS effect boundary | Risk score как право |
| Immutable resolved plugin source | OpenHands strict fetch | Exact artifact при future approved extensions | Hash как permission |

## 5. Где дополнительный слой оправдан

1. **Operations→execution binding:** независимые owners, lifecycle и failure semantics. Не расширять контракт обязательными особенностями каждого vendor.
2. **Future continuation profile:** attach/replay, rerun, reset, fork и history projection имеют разные guarantees. Ordinary unknown replay остаётся запрещён.
3. **Pure mechanism→optional integration:** уже выбранные public S1/S2, explicit exports и packed route. Не пять одинаковых DTO layers.
4. **Canonical record→projection/redaction:** только при изменении representation/validation. Если semantics совпадают, механический mapper не нужен.
5. **Composition release record:** отдельные API/implementer/native/state/profile identities; existing authority, не ещё один registry/resolver.

Не нужны extra layers для pure helpers, arithmetic calculators, private DTO с одинаковой semantics, immutable config или wrapper без самостоятельной ответственности. Отдельная ответственность, consumer, trust/failure boundary или demonstrated volatility — основания; число слоёв само по себе не основание.

## 6. Top-3: гранулярность следующих библиотек

**Не переоткрывает обязательные public S1/S2 cuts.** Это выбор packaging следующей independently useful family. P — дополнительный handwritten production/integration/glue LOC для boundary/packaging; T — tests/fixtures. Сама feature, generated/vendor/native code, CI YAML, docs исключены. Нельзя суммировать с S1–S5 baseline; LOC confidence **4/10** до inventory. Reliability — achievable correctness в указанном scope, не SLA.

Сопоставление после независимой критики: одна следующая capability, две тесные features, один owning team, один внешний consumer и те же effect/lifetime guarantees. A — новый standalone family tarball с subpaths; B — subpath существующего owner tarball только при совпадающих dependencies/consumption promises; C — два отдельно потребляемых tarballs при доказанном independent lifecycle. Эти средства могут сосуществовать в разных частях продукта; это не взаимоисключающие архитектурные школы. P/T — overhead упаковки/public contracts/tests, не feature implementation. Known reusable concern не откладывается из-за меньшей цены B.

| Вариант | Сложность /10 | Надёжность /10 | Уверенность /10 | P LOC | T LOC |
| --- | ---: | ---: | ---: | ---: | ---: |
| **A. Capability-family package; private helpers внутри, independently useful adapters отдельно** | **4** | **8** | **9** | **300–900** | **700–1 800** |
| B. Closely coupled new capabilities как subpath owner package; отдельный tarball при реальном independent concern | 3 | 8 | 7 | 150–600 | 450–1 400 |
| C. Independently versioned feature packages сразу при нескольких реальных owners/consumers | 8 | 7 | 5 | 1 000–2 800 | 2 000–5 500 |

**A default:** reusable concern проектируется библиотекой сразу с real consumer и packed external project. Сильнейшее возражение: family может превратиться в новый broad core. Контроль — reason-to-change, dependency closure, change fan-out, public API; не arbitrary LOC threshold.

**B:** хорош для одной semantic responsibility. Возражение: subpath не ограничивает install closure; один consumer тянет чужой server/native. Для заведомо reusable concern «выделим потом» противоречит library-first, поэтому B не применим к уже выбранным S1/S2.

**C:** оправдан реальными independent lifecycle/maintainers, преждевременен как default. Возражение — release matrix, setup friction, compatibility burden. Package-per-function/class и empty plugin framework не входят в этот вариант: без независимой причины выделения это вообще не допустимая архитектурная альтернатива.

Вопрос пользователю возникает до новой independently supported family, если различие A/B меняет install/upgrade promise. Не нужно опять спрашивать, нужны ли библиотеки: ответ уже дан.

## 7. Top-3: release policy следующей family

Не меняет accepted 0.x minor-breaking policy, immutable contracts или S2 publication graph. LOC incremental release glue/fixtures сверх existing gates; confidence **4/10**, не engine implementation.

Отдельный фиксированный сценарий: уже необходимые public owner-contract package, один независимо распространяемый adapter package и один и тот же первый 0.x consumer. Обе versioned units существуют во всех R1/R2/R3; это не новый package split и не единственный tarball из D1. R1 — независимые версии этих двух units с одной qualified deployment combination; R2 — одинаковые номера тех же units с одной combination; R3 — дополнительное явно проверенное окно комбинаций тех же units. Coordinated release train возможен во всех вариантах. N/N−1 относится к названным package/API/profile combinations, не к соседним Get Modular capability revisions: current CMS требует exact revision на edge. Изменение negotiation требует отдельного upstream successor. Цены перекрывают D1/public-kit работу и не суммируются.

| Вариант | Сложность /10 | Надёжность /10 | Уверенность /10 | P LOC | T LOC |
| --- | ---: | ---: | ---: | ---: | ---: |
| **R1. Independent SemVer + coordinated qualified runtime train для связанных cuts** | **4** | **8** | **9** | **200–650** | **500–1 500** |
| R2. Lockstep numbers тех же двух units, одна supported combination | 3 | 8 | 7 | 150–450 | 400–1 100 |
| R3. Те же две units + N/N−1 compatibility window | 8 | 7 | 5 | 900–2 300 | 2 000–5 500 |

**R1:** JSONL отдельно; full store не выходит без owner prerequisites. Возражение — train metadata может превратиться во второй resolver; использовать существующие composition/adoption contracts.

**R2:** проще upgrade story маленькой coherent family. Возражение — cascade releases и ложная вера в равные версии. Shared lifecycle может оправдать; весь future monorepo — нет.

**R3:** полезен зрелой внешней экосистеме. Возражение — combinatorial matrix и retained old code до реального support promise. Не default в deliberate 0.x stage, только scoped future decision пользователя.

## 8. Experiments, способные изменить решение

Это кандидаты в существующие owner acceptance, **не выполненные эксперименты**, не новый runner.

| Experiment | Фальсифицируемый риск | Минимальный scope | Реакция на провал |
| --- | --- | --- | --- |
| Packed caller + implementer без workspace siblings | Hidden deps/deep imports/facade contamination | Один tarball, disposable consumer, existing runner | Исправить public boundary |
| Passive import/construct | IO/env/native side effects в pure core | Selected pure entrypoints | Explicit adapter start |
| Live-turn loss + continue | Rerun выдаётся за no-replay | One binding fixture; real adapter при его delivery | Refusal или отдельный weaker profile |
| Bootstrap settings change | Silent native context reset | Two turns, tool/skill change, native ID | Explicit discontinuity/reset |
| History projection | Orphan result, mutation of source | Selected converter paired events | Owner mapping fix |
| Redaction→persist→reload→cursor | Structural schema corruption | Existing selected output record | Safe view boundary |
| New family release | Incompatible ports in all-owner factory | Packed caller/implementer + migration fixture | Coordinated train/typed refusal |

## 9. Вопросы независимым критикам

- Не дублирует ли предложение F01/F08/S1–S5? Дополнить existing owner evidence, не создавать слой.
- Где guarantee изменился, а где API shape? No-replay/physical custody требуют independent proof.
- Source alpha/experimental не назван stable released? Ни source version, ни docs rollout не registry evidence.
- Общий contracts package не смешал owner languages? Outbound port consumer-owned; reusable protocol types отдельно.
- Новый tarball usable без Host/org secrets? Real consumer с first useful release.
- Convenience path не обходит RS? Privileged caller explicit и не выдаётся недоверенному входу.
- Continuation не маскирует retry? Кто разрешает recomputation и что сохраняет effect identity?
- Scores сравнивают одинаковый scope? Package independence не malicious-code isolation.

## 10. Primary source ledger

Все source SHA immutable; rolling documentation дополнена датой чтения; source HEAD не доказывает опубликованный artifact.

- **M01 D:** [AI SDK introduction](https://ai-sdk.dev/docs/introduction), [harness overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview): v7, model/harness distinction, experimental.
- **M02 S/D:** [harness catalog](https://ai-sdk.dev/providers/ai-sdk-harnesses), [packages source](https://github.com/vercel/ai/tree/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages). Directory API verified.
- **M03 S:** [HarnessV1](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness/src/v1/harness-v1.ts#L14-L93): spec tag, flags, lifecycle schema, start.
- **M04 S:** [HarnessV1Session](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness/src/v1/harness-v1-session.ts#L192-L296): unsupported/history, lossy/lossless continue, lifecycle.
- **M05 S:** [lifecycle state](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness/src/v1/harness-v1-lifecycle-state.ts#L65-L125), [LanguageModelV4](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/provider/src/language-model/v4/language-model-v4.ts): opaque data, spec identity, captured pending requests/settings.
- **M06 D:** [HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent), settings/history/lifecycle sections.  Rolling docs, not released adapter qualification.
- **M07 S:** [provider manifest](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/provider/package.json), [ai manifest](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/ai/package.json#L58-L61), [harness manifest](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness/package.json), [harness-codex manifest](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/packages/harness-codex/package.json).
- **M08 S:** [Mastra core manifest](https://github.com/mastra-ai/mastra/blob/e56f88e18d906635b033173abcae637cf361ce8a/packages/core/package.json), [dependencies](https://github.com/mastra-ai/mastra/blob/e56f88e18d906635b033173abcae637cf361ce8a/packages/core/package.json#L903-L933). Parsed len(exports)=88, len(dependencies)=30.
- **M09 D:** [Pydantic install](https://pydantic.dev/docs/ai/overview/install/), optional extras/slim.
- **M10 S:** [Pydantic slim manifest](https://github.com/pydantic/pydantic-ai/blob/58fa0d9dd764ee0b2eddf4b420a44daa8df2cb4c/pydantic_ai_slim/pyproject.toml#L57-L173).
- **M11 D:** [OpenHands architecture](https://docs.openhands.dev/sdk/arch/overview).
- **M12 S:** OpenHands [SDK](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-sdk/pyproject.toml), [tools](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-tools/pyproject.toml), [workspace](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-workspace/pyproject.toml), [server](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-agent-server/pyproject.toml) manifests.
- **M13 S:** [AI SDK Changesets](https://github.com/vercel/ai/blob/c3b6fef1ffcebd52a8fa1495b96785dc9d802880/.changeset/config.json).
- **M14 S:** [Mastra Changesets](https://github.com/mastra-ai/mastra/blob/e56f88e18d906635b033173abcae637cf361ce8a/.changeset/config.json#L8).
- **M15 H/S:** [Mastra PR28286](https://github.com/mastra-ai/mastra/pull/28286), [issue28190](https://github.com/mastra-ai/mastra/issues/28190), [fix commit](https://github.com/mastra-ai/mastra/commit/e56f88e18d906635b033173abcae637cf361ce8a). Status/limitations and patches inspected; tests not run here.
- **M16 H/S:** [OpenHands PR6259](https://github.com/OpenHands/software-agent-sdk/pull/6259), [fix commit](https://github.com/OpenHands/software-agent-sdk/commit/6edd54d481cd778abcdb0dab6ce566e529788d4a). Source+status; previously corrupted histories excluded.
- **M17 D:** [OpenHands security](https://docs.openhands.dev/sdk/guides/security).
- **M18 S:** [execute_tool](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L3184-L3225).
- **M19 H/D:** [OpenHands retrospective](https://docs.openhands.dev/sdk/arch/design).  Existing K01, not new defect.
- **M20 D:** [Mastra storage domains](https://mastra.ai/docs/storage).
- **M21 S:** [Mastra fencing](https://github.com/mastra-ai/mastra/blob/e56f88e18d906635b033173abcae637cf361ce8a/packages/core/src/storage/run-fencing.ts#L3-L112). Not proof of every adapter.
- **M22 S:** [OpenHands strict source fetch](https://github.com/OpenHands/software-agent-sdk/blob/6edd54d481cd778abcdb0dab6ce566e529788d4a/openhands-sdk/openhands/sdk/plugin/strict_fetch.py#L154-L211). Resolved SHA/cache checks, not executable authorization.



## Уточнения после независимой критики

No-replay guarantee относится к runtime-owned dispatch и explicitly qualified effect paths. One turn-start не доказывает отсутствие внутренних retries tools/model в harness. Secret minimization/admission предшествует сохранению nonsecret runtime/output/diagnostic records; затем schema-safe projections не мутируют допустимый source. Собственная PA credential custody остаётся отдельной authorized boundary. Unsafe structural fields не получают blanket exemption. Off/on observer parity имеет одинаковые deterministic inputs/clock/responses/budgets; real-time overhead/deadlines проверяются отдельно. Все изменения и critic dispositions — [review record](agent-runtime-modular-research-review.md).

## Limitations

No competitor runtime, live provider, native/PostgreSQL failure campaign or comparative benchmark was executed. A source commit or manifest does not establish a released or installed artifact. All proposed experiments remain planned; accepted owner contracts and exact deployment qualification control implementation.
