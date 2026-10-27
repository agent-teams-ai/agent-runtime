---
id: qualification.agent-runtime.modular-spikes
type: qualification-plan
status: proposed
owner: architecture/qualification
summary: Bounded decision-changing experiments for public packages, continuation and effect authority; no completed runtime qualification claimed.
---

# Agent Runtime Modular Architecture Spikes

## Target tuple

**Статус каждого опыта: planned, не выполнен в этой исследовательской работе.** Baseline плана `c59fe8364071530d09b48eda47d41620f3f59c25`, 27.10.2026. Цель — выбрать только опыт, результат которого изменит реальное architecture/product решение. Это дополнение существующих S1–S5/OBS/G3 acceptance; новый framework/runner и второй набор production algorithms не создаются.

До запуска конкретного опыта фиксируются exact source/package/native/schema/platform/profile versions, consumer, owned disposable resources, command, input seed и критерий fail/pass. Общего «всё прошло» для разных tuples нет. Реальный provider/native эксперимент выполняется только в disposable test project и рамках принятого owner scope. Fixtures проверяют semantics, а не hostile isolation/physical termination.

Связи: [синтез и D1–D4](../architecture/agent-runtime-modular-research.md), [реестр MR-01…24](agent-runtime-antipattern-register.md), [existing S1](../architecture/agent-runtime-architecture-program-s1-libraries.md), [existing S2](../architecture/agent-runtime-architecture-program-s2-operations-storage.md), [existing S3–S5](../architecture/agent-runtime-architecture-program-s3-s5-features-host.md).

## Required evidence

| ID / момент | Гипотеза и минимальный опыт | Наблюдаемое опровержение | Действие по результату |
| --- | --- | --- | --- |
| X01 / first public S1/S2 | Установить один реальный packed tarball в disposable caller и отдельный implementer project; проверить curated import/types/требуемые ports без workspace siblings и org secrets | Deep import, undeclared dependency, provider/Host/server requirement для pure library, factory type невозможно реализовать с public exports | Исправить boundary/public exports. Не создавать второй production backend ради теста |
| X02 / новая family D1/D2 | Один и тот же конкретный consumer и capability реализовать как smallest sufficient package boundary; сравнить packed dependency closure, changed-leaf compile, public declarations и migration diff | Независимый consumer обязан принимать чужие deps/lifetime/release либо decoupled shape создаёт больше coordinated changes без отдельной пользы | Выбрать family/subpath/split по observed constraint. Нельзя выдать package count или одно build time за общую maintainability |
| X03 / S2/S4 neutral binding | Process-free deterministic fixture без PID плюс adapter с unsupported capability и misleading brand name; fake clock/IDs/limits controlled | AE требует vendor DTO/PID, no-op выдаётся за поддержанный control, capability guessed by name | Исправить contract или явно сузить profile. Реальный второй harness только при G3 consumer |
| X04 / OBS-ADOPT | Один deterministic trajectory с observation off/on: одинаковые provider responses, input ordering, clock, capacity и budget; включить pause/drain/error/terminal | Observer меняет canonical transition/result, protected dispatch count или permission | Исправить observer/adapter boundary. Real-time scheduling/latency equality не требуем; отдельно truthful overload behavior |
| X05 / G3 continuation | Start→external effect fixture→lost native/transport state→continue. Проверить attach, stable replay, lossy rerun и config-induced new thread как разные scenarios | В ordinary no-replay profile effect counter растёт повторно; reset/reconstructed history выдаётся за lossless continuation | Refuse unsupported continuation либо принять отдельный scoped successor; не generic automatic fallback |
| X06 / selected RS effect promise | Назвать protected effect unit и enforcement owner; ordinary/direct/delegated/hosted path, grant revoked between admission and use, задержанная remote command после revoke/cutoff | Любой path обходит обещанное enforcement или privileged API доступен untrusted caller | Закрыть path/capability для этого profile либо квалифицировать existing owner enforcement. Не утверждать перехват каждого shell/internal provider effect без соответствующего native contract |
| X07 / output projection delivery | Admitted records→model/view transformation→typed persist/reload→cursor resume; paired call/result; secret-bearing payload/structural-field collision | Orphan result, mutated admitted source, invalid discriminator/timestamp/cursor, retained/exported secret | Minimization/admission до storage/export; codec-safe representation/refusal для unsafe structural values. Projection immutable только после допустимого admission |
| X08 / actual Temporal/Restate consumer | Crash после runtime acceptance/effect и до durable wrapper result; replay/retry с same trusted tenant/project/commandId+fingerprint. Повторить после receipt/dedup horizon и с changed payload | Новый dispatch, silent new commandId, same-key different intent, fake terminal/released outcome; late replay превращается в new work | Требовать proven repeat-safe public method + bounded retention/replay contract. Иначе integration unsupported. Retry-off само по себе не закрывает crash replay |
| X09 / release train/upgrade Q5/Q6 | Packed old caller/implementer + new selected family; explicit mixed-version durable state and retained cleanup record; incompatible descriptor revision | Core принимает mismatched descriptor по предположению N/N−1, store публикуется без required owners, upgrade теряет cleanup path | Exact CMS edge check; required owner/public-package successors в train; incompatible migration ждёт supported drain/repair |
| X10 / actual keyed workflow consumer | Exclusive A waits B, B needs A; cancel/approval/control одновременно; finite limits | Deadlock required control path либо unbounded waiting | Изменить конкретный workflow communication/serialization scope; не вводить actor layer в ordinary runtime |

X01, X03 и часть X09 уже предусмотрены existing plan: расширяются точными counterexamples, не запускаются второй раз ради нового названия. X02 — targeted experiment только при сомнении о новой family, не обязательные три prototype implementations. X05/X07/X08/X10 ждут actual owning slice. X04 не воспроизводит вендорный LangGraph целиком: его исправленный regression даёт конкретный risk к нашему contract.

### Required record для выполненного опыта

- **Question / owner / alternative changed:** зачем опыт нужен и какой результат переключит рекомендацию.
- **Inputs:** exact commits/artifacts/profile/OS/schema, dependency graph, seed, clock, chosen effect class; trusted identity separate from payload.
- **Command / observation:** фактическая команда, source of truth/counters, failures, cleanup/debt. Не считать compilation запуском behavior.
- **Decision:** supported/refused/needs successor; зачем слой/пакет нужен либо почему от него отказываемся.
- **Limits:** fixture versus live, cooperative versus hostile, one runtime versus fleet, source versus released artifact.

## Negative gates

1. Нельзя сделать опыт зелёным weakening existing required assertions/authority, изменением pinned profile или removal из governance. При конфликте планируется scoped successor.
2. Observation parity имеет одинаковые controlled inputs, не одинаковую wall-clock. При slow observer возможен declared backpressure/refusal; запрещено скрытое изменение owner semantics.
3. Remote revocation проверяется у target согласно accepted fencing/cutoff profile. Caller-side проверка не гарантирует мгновенную остановку; delayed command не проходит устаревшую authority.
4. Из S2 readback может следовать только allowed identity/settlement/terminal fact. Ни чтение найденной записи, ни delivery ACK не дают dispatch claim. Unknown outcome не превращается в absence.
5. Для replayed workflow callback повтор public submit допускается только при доказанной методной идемпотентности и актуальном retention envelope. После expiry требуются retained tombstone/receipt либо явный отказ по выбранному owner contract; бессрочная поддержка replay не предполагается.
6. Redaction view не разрешает durable raw secrets. Проверяются nonsecret runtime/output/diagnostic surfaces; PA credential custody следует собственному authorized contract. Semantic schema и допустимое содержимое определяются до persistence; unsafe structural value не освобождён от policy из-за имени поля.
7. False physical-stop/isolation receipt отвергается даже если higher-level operation Promise завершился. Runtime custody/borrowed-resource ownership сохраняются.
8. Производственные и тестовые LOC считаются отдельно; эти опыты не превращаются в новый общий budget поверх уже оценённых contract suites.

## Promotion rule

Успешный bounded fixture подтверждает только проверенный contract case. Публичная library требует actual consumer и packed installation; real native activation — её exact E2E tuple; fleet/security/capacity promise — свои существующие campaigns. Если опыт не влияет на decision, не запускать его для количества.

Результаты будущего опыта записываются как evidence в owning record и связываются с contract; здесь не подменяется qualification registry. Все X01–X10 на дату публикации этого research остаются **planned**.
