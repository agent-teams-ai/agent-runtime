---
id: runtime.architecture.v3-embeddability-review-ledger
type: architecture
status: proposed
owner: architecture
summary: Review handoff, vision, source-of-truth crosswalk, findings and qualification status for the v3 embeddability addendum.
---

# V3 Embeddability — полный контекст для критиков и реестр решений

## 1. Authority, актуальность и границы

**Актуальная основа:** PR [#243](https://github.com/agent-teams-ai/agent-runtime/pull/243) смержил исходный V3 и greenfield research в main 27 октября 2026, commit [4bdc93a43](https://github.com/agent-teams-ai/agent-runtime/commit/4bdc93a43b58469f60ca10c0dca512824650c8ac). Исходный [#235](https://github.com/agent-teams-ai/agent-runtime/pull/235) закрыт **без merge** как superseded. Вслед за ним открыли draft [#244](https://github.com/agent-teams-ai/agent-runtime/pull/244) — **предлагаемое** исследовательское дополнение, не заменяющее принятые решения. Исторические SHA в исследовании нельзя выдавать за текущие production head.

**Authoritative sources** в порядке применения: принятые ADR и scoped adoption profiles репозитория; organization [Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md); принятую данным repo версию [FMS](https://github.com/agent-teams-ai/.github/blob/main/docs/architecture/feature-module-standard/v1.1.md) и закреплённый [Get Modular CMS](https://github.com/agent-teams-ai/get-modular/blob/main/docs/architecture/common-assembly.md); затем действующий [v3 program](../../docs/architecture/agent-runtime-architecture-program-plan.md) и его S1, S2, S3–S5 briefs; [greenfield foundation](../../docs/architecture/agent-runtime-greenfield-foundation-plan.md), [modular research](../../docs/architecture/agent-runtime-modular-research.md), [decisions and review](../../docs/architecture/agent-runtime-foundation-decisions-and-review.md); наконец [November SPI/embeddability addendum](v3-embeddability-addendum.md). Ссылки на moving main в стандартах — навигация, не автоматический переход pin.

**Protected decisions:** принятые ADR, авторизация, native ownership, frozen contained-turn, privacy/identity, durability и accepted FMS/CMS bindings нельзя молча менять. Любая новая семантика через scoped successor и согласование владельца; research не создаёт полномочий на код, запуск providers или новые gates. **FMS v1.1 — цель N2, а не текущий уже принятый в Runtime pin.**

## 2. Передаваемое критикам видение (не сокращать при назначении)

| Инвариант / цель | Следствие для проверки |
| --- | --- |
| V2 — move-first, V3 — greenfield ordinary path directly in target architecture | Не переносить старый ordinary код «для красоты», не делать двойной refactor; frozen contained остаётся, полезные tested owners/mechanisms переиспользуются |
| Это foundational headless библиотека для чужих проектов и наших desktop/web/orchestrator | Типизированный продуктовый API, независимые packages и реальные disposable external consumers; ни UI, ни teams/tasks/boards не входят в Runtime |
| Система может стать очень большой: сотни модулей/миллионы строк, тысячи одновременно работающих агентов и 10k+ квалифицируемых operations | Library/module/feature/process/deployment — разные единицы; graph scaling ≠ количество активных OS-процессов; измерения и capacity C0–C3 отдельные |
| Clean Architecture, SOLID, DDD, DRY; строгое FMS feature/subfeature layout | Один semantic owner, inward dependencies, no cross-context repository access; nested features сохраняются при извлечении в пакет, без пустых слоёв |
| Get Modular — единственный выбранный static composition mechanism | Core/Assembly/resources и optional Observation, typed contract revisions, per-run scopes; нет второго DI/service locator/global registry |
| Library-first, много независимых реально используемых пакетов | S1 JSONL/Codex, S2 Operations/PG/conformance, S5 Host и реальные adapters; избегать искусственных package-per-function, но не откладывать нужную extraction до дублирования |
| Четыре контекста сохраняют ownership | Agent Execution, Provider Access, Runtime Security, Runtime Configuration; shared package не становится пятым domain owner |
| Native keeper/init/client — отдельный Rust owner | TS владеет application/policy, native физическими ресурсами; никаких вторых TS supervisor/client/journal или fallback на слабые гарантии |
| Безопасное исполнение при неопределённости | Unknown COMMIT/write/ACK не подтверждает отказ, не допускает retry/new launch; committed claim до workload; distinct provider acceptance, delivery, physical cleanup |
| Разделённые identities и lifetimes | Host, session, operation, generation, attempt, process/container, artifact и cursor не взаимозаменяемы; borrower не закрывает provider-owned resources |
| Стабильный SDK/embedding для потребителей | Три аудитории: caller, trusted embedder и implementer; private ADR-0008 entrypoint пока не расширять без нового решения; remote Connect/Protobuf и Python/Go — будущая выбранная integration |
| Provider SPI уже принят ADR-0091 | Отдельный DriverFactory/Session contract, scoped interactive authority; PR #239/#242 — отдельная текущая работа, не считать merged; не создавать второй SPI/adapter framework |
| Provider protocol, SDK, model, harness и execution environment — разные оси | Разделить parse/protocol/turn, provider capabilities, release/profile, runtime permissions; cross-harness continuation не обещать автоматически |
| Output ≠ operation ≠ live summary ≠ memory/checkpoint | Durable cursor/replay с gap, ephemeral coalesced watch, authorized artifact references, provider checkpoint как opaque compatibility state; память продукта у consumer |
| Fully local сегодня и возможный multi-tenant hosted/fleet | Локальный клиент не требует облака; безопасность localhost не подразумевается; v3 ordinary S2 выбирает Postgres, более широкий accepted foundation сохраняет отдельный SQLite/local direction, не обещать auto-interchangeability |
| Критика по сути, не ради объёма | Несколько проходов, exact SHA, доказанный counterexample, альтернативы и cost; исправлять только обоснованные findings, тесты по риску, E2E на disposable средах, без новой инфраструктуры ради hypotheticals |

**Do not add now:** universal AgentManager / RuntimeKernel / PluginHost, global event bus, shared-domain identity, generic CRUD repository, второй scheduler, новый RPC между обычными TS modules, speculative hot swap, универсальная Wasm ABI, новая production database/provider ради двух implementations. Future research on native in-process/Wasm must not claim TypeScript transpiles directly to portable Wasm.

## 3. Где решения уже сохранены — completeness crosswalk

| Тема | Канонический документ/раздел | Статус |
| --- | --- | --- |
| V2→V3, S1–S5 cutovers, read-only planning status | [V3 program](../../docs/architecture/agent-runtime-architecture-program-plan.md), §§1, 5–9 и [execution brief](../../docs/architecture/agent-runtime-architecture-program-execution-brief.md) | Existing, planned implementation |
| Долгосрочный greenfield, десять тысяч операций, G0–G5 | [Greenfield foundation](../../docs/architecture/agent-runtime-greenfield-foundation-plan.md), §§1–2, 8, 11–13 | Existing, future qualification |
| F01–F18 authority/identity/resource/capacity/security/scale contracts | Greenfield foundation §5; existing ADR/feature owners | Existing, not blanket current gates |
| Library portfolio, distribution, implementer API, reusability | Greenfield foundation §4; [modular research](../../docs/architecture/agent-runtime-modular-research.md), §§2–3 | Existing; November delta adds package dependency-closure cases |
| Q1–Q7 alternatives, scores and review provenance | [Foundation decisions/review](../../docs/architecture/agent-runtime-foundation-decisions-and-review.md) | Existing; no new owner approval implied |
| D1–D4 independent research alternatives, antipatterns | Modular research; [research review](../../docs/spikes/agent-runtime-modular-research-review.md) | Existing; prior reviewer coverage not current PR |
| Nested FMS and Get Modular composition/revisions/resource scopes | V3 §§4–5, N2; local adoption profile; standard | Existing/selected adoption; protect current pins |
| Ordinary engine/store, Drizzle, migrations and schema-fence | [S2 brief](../../docs/architecture/agent-runtime-architecture-program-s2-operations-storage.md) | Already planned; no second StorageManager |
| Physical custody, durable correlation and no-blind-replay | V3 NATIVE-INTEGRATION and [S1 brief](../../docs/architecture/agent-runtime-architecture-program-s1-libraries.md) | Already planned, real native qualification separate |
| Public Host API, verified borrowed storage, release selection | [S3–S5 brief](../../docs/architecture/agent-runtime-architecture-program-s3-s5-features-host.md) | Already planned |
| Interactive session, external provider SPI, scoped synthetic proof | [ADR-0091](../../docs/decisions/0091-interactive-agent-session-synthetic-vertical-slice.md); PR [#239](https://github.com/agent-teams-ai/agent-runtime/pull/239), [#242](https://github.com/agent-teams-ai/agent-runtime/pull/242) | Accepted SPI decision; packaging/integration work distinct and not merged |
| Private embedded access/public SDK prerequisite | [ADR-0008](../../docs/decisions/0008-private-embedded-runtime-access-entrypoint.md) | Accepted restriction; future scoped successor |
| Output/readback/watchSummary and resource debts | S2/S3–S5 briefs; greenfield §7 | Current summary selected; future remote replay service not selected |
| Capacity/Fairness/scale | [Capacity C0–C3](../../docs/architecture/capacity-admission-delivery-plan.md), greenfield §8 | Planned follow-up, not eighth ordinary port |
| Package-level dependency closure; WeakMap cross-package risk | [November addendum](v3-embeddability-addendum.md) §§2–5 | Proposed specific integration tests, not present production vulnerability |
| Cross-language SDK and Wasm choices | Greenfield §10; November addendum §4, §10 | Future seam; transport/provider/SDK must have real consumer |
| Reviewer handoff, findings and status | This ledger §§4–7 | Current PR review governance, proposed |

**Coverage conclusion:** core long-term vision was already committed by #243. The November review adds actionable **external installation, implementer/ABI, authority-cancellation/cursor and packaging checks**, not a replacement of F01–F18 or a second roadmap. This table is navigation, not another source of normative decisions.

## 4. Задания для независимых критиков

**Shared brief для каждого:** прочитать весь §2, принятые ADR-0008/0091 и relevant owner ADR, организационный Quality Standard, закреплённый FMS/CMS consumer pin, V3 + S1–S5, greenfield, modular research и November addendum. Проверять точный HEAD PR #244 относительно актуального main; не считать прежние review #235/#243 оценкой этой дельты. Максимальная доступная глубина рассуждения и самостоятельный source-backed review.

1. **DDD/FMS/Get Modular critic:** найти расползание ownership, forbidden imports, скрытые package/feature graph cycles, нарушение v1→v1.1 migration, ложный отдельный bounded context и дублирующий DI. Проверить, что proposed SPI не перехватывает authority ADR-0091.
2. **Library/SDK/compatibility critic:** проверить installable external consumer, peer/optional dependency closure, type-only vs install semantics, public caller/embedder/implementer split, mutable config snapshot, WeakMap duplicate-package bridge, SemVer/descriptor/wire/schema separation и требования ADR-0008.
3. **Reliability/security/native critic:** пройти unknown COMMIT/ACK/write, admission before native effect, auth-helper/broker prep authority, generation/fencing, interaction reply, close/cleanup debt, borrowed pool, output cursor/gap и forbidden secret diagnostics. Каждая weaker backend guarantee должна стать typed refusal/profile distinction.
4. **Scale/operations critic:** различить static 1000 graph instances и 10k+ real active operations, ресурсы/buffer bytes/queued pending IO, shared accounts/quotas, control lane saturation, fair allocator, migration/restore rollback, local vs hosted security. Не требовать реализации C0–C3 внутри текущего S1–S5.
5. **Integration critic (после четырёх):** сравнить каждое замечание с уже смерженными V3/greenfield docs; убрать дублирующие новые требования, проверить линии внедрения и owner constraints, exact-status всех предложений и отсутствие новых непрошенных migrations.

**Ожидаемый результат каждой критики:** severity (blocker/major/minor), точный source path + SHA + строки, минимальный воспроизводимый counterexample или contradiction, affected owner/ADR, конкретное исправление, проверка его эффекта и цена предлагаемой альтернативы. Отдельно перечислить отвергнутые улучшения и причины. Не объявлять «zero findings» без явного полного file coverage.

## 5. Независимая критика — фактический статус

- Предыдущие six xhigh reviews и delta reviews относились к исходным документам #235/#243, **не к November addendum**. Их результаты сохранены в foundation review; они не переносимы как автоматический approve.
- Для PR [#244](https://github.com/agent-teams-ai/agent-runtime/pull/244) автоматический review provider сообщил **incomplete, 0/3 files reviewed**; это не независимое содержательное заключение. Review service exhausted retries. Нет доказанных reviewer findings и нет права считать 0 замечаний полным прохождением.
- В этой сессии отдельные subagent/model reviews не доступны. Выполнены **внутренние**, а не независимые, проходы по пяти направлениям из §4. Нельзя писать «эксперты подтвердили» или «максимальный effort выполнен» без фактического model/run evidence.
- Current-head required CI до этой редакции: product/docs/architecture checks mostly success, **commit-author-identity failure**, independent codex review failure. Изменение этого файла требует **нового exact-head** evidence.
- GitHub connector формирует авторство **Илия <iliyazelenkog@gmail.com>**, требуемый identity gate — **777genius <iliyazelenkog@gmail.com>**. Нельзя обходить guard, менять policy или объявлять PR merge-ready. Для корректного commit требуется разрешённый Git route с явным author/committer; этот connector не поддерживает override.

## 6. Self-review: замечания, решение, статус

| ID | Counterexample / проблема | Диспозиция и исправление |
| --- | --- | --- |
| E-01 | Research назвал FMS v1.1 так, будто repo уже использует именно её; N2 ещё отдельно принимает pin | **Accepted/fixed:** явно описать текущий v1 и целевой v1.1 через scoped N2, без silent pin advance |
| E-02 | «Первый SPI» звучал как новое решение при существующем ADR-0091 и подготовке #239/#242 | **Accepted/fixed:** указать already-owned interactive DriverFactory/Session, не создавать второй интерфейс |
| E-03 | «Нормативный SDK-result» звучал как уже принятое public API, вопреки ADR-0008 | **Accepted/fixed:** proposed semantics for later owner decision, no premature Proto freeze |
| E-04 | WeakMap example мог читаться как текущая production-уязвимость | **Accepted/fixed:** это только риск **future independently packaged adapter** с двумя module instances |
| E-05 | Документ повторяет Greenfield/F01–F18 и D1–D4, создавая вторую authority | **Accepted/fixed:** точная coverage-карта §3, research остаётся proposed, не новый владелец |
| E-06 | Future remote SDK test мог быть ошибочно истолкован как блокер S1/S2 | **Accepted/no new gate:** future consumer-driven successor; S1/S2 сохраняют свой bounded scope |
| E-07 | Публичный contracts-only import может работать без runtime values, но npm install всё равно затянет pg/SDK | **Valid risk, future test:** actual external install/package closure на first chosen public provider implementer |
| E-08 | Удалённое cancellation нельзя связывать с локальным AbortSignal или с onAccepted callback | **Valid contract, future SDK:** explicit cancel command and readback; internal accepted callback semantics untouched |
| E-09 | 1000 Assembly runs не доказывает 1000 simultaneous OS agents, а 10k в документе не значит квалифицированные 10k | **Accepted/clamped claims:** separate benchmark classes and future G4/G5 load proof |
| E-10 | Можно получить новый generic Host/Plugin/Storage framework вместо закрытия одной real seam | **Rejected:** существующие owner ports, static Assembly and S1–S5 достаточны |
| E-11 | Взятые из прошлых research critiques советы могут дублировать уже выбранные v3 packages | **Rejected duplicate delivery:** сохранять как ссылку/acceptance на owning card, не отдельную roadmap |
| E-12 | ADR-0091 sessions и frozen ordinary/contained нельзя слить ради DRY | **Preserved:** отдельный owner feature/format, shared mechanisms только при доказанном совпадении семантики |

**После изменений:** E-01–E-05 исправлены на уровне документа; E-06–E-12 имеют явные ограничения/владельцев. **Это self-review disposition, не independent-critic closure и не E2E.**

## 7. Следующие реальные блокирующие действия

1. Исправить commit identity в PR #244 через аутентифицированный Git с canonical author/committer (не подменять пользователей и не ослаблять policy).
2. Проверить точный новый HEAD: docs protocol, проверку ссылок, source/architecture gates, необходимые CI. Не повторять провайдера или effectful E2E по причине одного отсутствующего review signal.
3. Запустить независимые ревью по §4 в среде, где реально доступны отдельные умные модели/агенты; зафиксировать модели/effort, ревизии, file coverage, findings и ответы по каждому. На текущем доступном toolset их запуск не подтверждён.
4. Исправить принятые source-backed findings, затем выполнить delta review и полный финальный coverage review. Держать PR draft пока нет обязательного CI и reviewed source head.
5. Не менять accepted ADR bytes, не мержить PR #239/#242 вместе с этой документационной задачей и не активировать providers/native/fleet только потому, что research записан.

**Результат этой исследовательской доставки:** подробное видение и crosswalk не теряются; implementation S1–S5 и отдельные будущие capabilities остаются у существующих owners и проходят собственную квалификацию.
