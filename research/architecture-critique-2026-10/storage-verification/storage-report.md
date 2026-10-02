# Практическая проверка схемы хранилища agent-runtime на Drizzle

**Дата:** 2026-10-02. **Только анализ**, в репозиториях ничего не менялось.

**Ревизии:**
- agent-runtime snapshot `b0bcb265`. Current main `93367986` отличается только CI identity.
- `drizzle-team/drizzle-orm`: тег `v1.0.0-rc.4` = `748058e8`; npm `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@1.0.0-rc.4`; hash-сборка `drizzle-orm@1.0.0-rc.5-5935859`; ветка `rc5`.
- `agent-teams-ai/agent-teams-orchestrator` main `604ed911`.

**Метод.**
1. Чтение кода трёх хранилищ, Host, тестов, CI и governance-файлов agent-runtime.
2. Чтение опубликованного dist `drizzle-orm@1.0.0-rc.4` (тот код, который реально ставится) и diff ключевых файлов с `rc.5-5935859`.
3. Практический probe в scratch:
   - `npm pack` и распаковка, **без `npm install`**: `drizzle-orm@1.0.0-rc.4`, `pg@8.23.0` с зависимостями, `@types/pg@8.23.1`, `@types/node@24.13.3`, `typescript@5.9.3`;
   - одноразовый кластер PostgreSQL 15.13 из уже установленных локальных бинарников (CI использует 18.4); после проверки кластер остановлен, данные удалены;
   - Node 26.9.0 (CI использует 24.18.0), глобальный `tsc7` 7.0.2.
   - Скрипты остались в `<scratch>/probe/`: `probe1.mjs`, `probe2.mjs`, `probe3.mjs`, `probe-types.ts`, `probe-perf.mjs`.

Метки: **VERIFIED** — прочитано в коде или воспроизведено probe; **ASSUMPTION** — мой вывод.

---

## 0. Короткий итог

| # | Пункт схемы | Вердикт |
|---|---|---|
| 1 | Порт хранилища на владельца, атомарные операции на языке домена, без `Repository<T>` | **Подтверждено, требует поправки.** Порт есть только у Agent Execution. У Provider Access тип выведен из Postgres-реализации. У Runtime Security Postgres-адаптер и есть владелец (guards в памяти плюс хранилище). Порт Agent Execution принимает весь агрегат, хотя адаптер использует из него только ref, revision и attemptId |
| 2 | Чистые решения в domain; адаптер: транзакция → блокировка → решение → CAS; при неясном commit перечитать и вернуть `unknown` | **Требует поправки.** Шаблонов адаптера три, а не один. «Перечитать и вернуть `unknown`» неверно как общее правило: у методов семь разных семантик неясного commit |
| 3 | Host получает хранилища композицией, `createPostgresStorage(pool)` в Postgres-пакете | **Подтверждено, требует поправки.** Provider Access нужен не только store грантов, но и per-operation materialization repository. `pg` становится обязательной runtime-зависимостью Postgres-пакета. У хранилища нужен `close()` |
| 4 | Миграции отдельным шагом; ошибка отключает только ordinary | **Первая половина верна, вторая требует решения.** Сейчас миграции идут внутри фабрик Host. Ordinary-слот `required`, поэтому сбой валит всё создание Host. «Отключить только ordinary» — новое поведение |
| 5 | Проверки совместимости как `./testing` subpath владельца | **Требует поправки.** Противоречит действующему отвергающему тесту Agent Execution и SDK-growth `SDK_EXPORT_MATRIX_DRIFT`. Unknown-commit fault injection в общий набор не помещается |
| 6 | Drizzle `1.0.0-rc.4` | **Реализуемо с шестью обязательными адаптациями.** Факты координатора подтверждены. `db.transaction()` и голый migrator для нашей семантики непригодны (воспроизведено). Hash-сборки rc.5 брать нельзя |
| 7 | Один пакет `@agent-teams/runtime-store-postgres` с тремя адаптерами и миграциями | **Реализуемо для Agent Execution и Runtime Security. Для Provider Access сейчас заблокировано:** ordinary-путь делит Postgres-инфраструктуру materialization с contained-кодом. Перенос даёт либо цикл пакетов, либо двух владельцев одних таблиц |

Главное для плана: Drizzle здесь заменяет около двух десятков SQL-строк типизированными построителями. Ценные свойства хранилищ — транзакции с дедлайнами, неясный commit, digest-кодеки, триггеры, fail-closed проверка схемы — остаются нашим кодом. Drizzle-migrator к тому же надо обернуть: блокировка, отдельный журнал на владельца, сверка хешей.

---

## 1. Практический probe: что реально делает Drizzle rc.4 (VERIFIED)

| Probe | Что проверял | Результат |
|---|---|---|
| P1 | Обёртка в стиле Agent Execution (`ordinary-postgres-store.ts:29`: при объекте-запросе второй аргумент `values` теряется) | Drizzle вызывает `client.query({name,rowMode,text,types}, params)` (`node-postgres/session.js:41-46`). Результат: `there is no parameter $1`. Исправленная обёртка, которая передаёт `(config, values)`, работает |
| P2 | Ручная транзакция на одном `PoolClient`: `drizzle({client})`, `BEGIN`/`COMMIT` строками, потерянный ACK `COMMIT` | `unknown_commit`, readback видит строку, `release(true)`. **Наша текущая семантика сохраняется** |
| P3 | `db.transaction()` на `Pool`, потерянный ACK `COMMIT` | Строка **закоммичена**, но вызывающий получает обычный `DrizzleQueryError: synthetic lost ack`, неотличимый от ошибки тела. `release()` вызван **без** discard (`[undefined]`) |
| P4 | `.for("update")`, CAS `update … where revision = $n` | `rowCount` 1 при свежей revision и 0 при устаревшей. `bigint({mode:"number"})` читается как `number` |
| P5 | `insert … onConflictDoNothing({target})` | `rowCount` 1 при вставке и 0 при дубле |
| P5b | `db.execute(sql\`INSERT … SELECT … WHERE <clock_timestamp-окно> ON CONFLICT DO NOTHING\`)` | `rowCount` 1 / 0 / 0 (вставка, дубль, вне окна). Одноразовый consume Provider Access переносится один в один |
| P6 | Ошибка запроса | `DrizzleQueryError`; `message` **содержит параметры** (тестовый «промпт» в тексте ошибки); `cause.code = '23505'` сохраняется |
| P7a | Два `migrate()` одновременно на разных Pool | Один падает: `duplicate key value violates unique constraint "pg_namespace_nspname_index"` |
| P7b | Изоляция тестов через `search_path` (как в тестах Agent Execution и Runtime Security) | Таблица создана только в первой схеме. Журнал `drizzle.__drizzle_migrations` общий, поэтому вторая схема считается мигрированной |
| P7c | Правка уже применённой миграции | `no error`, хеш в журнале не изменился. Неизменяемость миграций **не проверяется** |
| P7d | `migrationsSchema` и `migrationsTable` на владельца | Работает: отдельный журнал |
| P8 | Обёртка: сессионный `pg_advisory_lock` на одном `PoolClient` → `migrate(drizzle({client}))` → сверка журнала с `readMigrationFiles` | Четыре параллельных запуска дали четыре `verified` и одну строку журнала |
| P9 | `tsc7` 7.0.2 и `tsc` 5.9.3 с `skipLibCheck:false` и `exactOptionalPropertyTypes:true`, как в agent-runtime | 47 ошибок в `.d.ts` самого `drizzle-orm@1.0.0-rc.4` (45 без `exactOptionalPropertyTypes`). У `0.45.3` — 73 ошибки. С `skipLibCheck:true` наш код компилируется чисто. Структурный `{query,release}` в `drizzle({client})` не принимается: `NodePgClient = pg.Pool \| PoolClient \| Client` (`session.d.ts:14`) |
| P10 | Накладные расходы | `drizzle({client})` около 0.8 мкс; сборка и исполнение `update` на фейковом драйвере около 38 мкс. Холодный импорт `drizzle-orm/node-postgres` с `pg-core` и migrator — 0.67–1.1 с на машине с load average 25 (ASSUMPTION: на свободной машине меньше; нужен замер) |

Исходники за этими фактами (`drizzle-orm@1.0.0-rc.4` dist):
- `node-postgres/driver.js:8` — `import pg from "pg"` на верхнем уровне; `:32-37` — `drizzle({client})` и `drizzle({connection})`; чужой пул не закрывается (вызовов `end` нет);
- `node-postgres/session.js:50-65` — `transaction()`:
  > `await tx.execute(sql\`begin…\`)` вне `try`; `catch (error) { await tx.execute(sql\`rollback\`); throw error; } finally { if (isPool) session.client.release(); }`
- `pg-core/async/session.js:136-171` — `migrate()`: `CREATE SCHEMA IF NOT EXISTS` и `CREATE TABLE IF NOT EXISTS` вне транзакции, без advisory lock, затем `db.transaction`;
- `migrator.utils.js:11-15` — `getMigrationsToRun` фильтрует только по `name`, хеш не сравнивается;
- `migrator.js:8` — старый формат с `meta/_journal.json` отвергается; новый формат — папка `<YYYYMMDDHHMMSS_name>/migration.sql`, hash = sha256 содержимого (`:28`);
- `errors.js:15` — `super(\`Failed query: ${query}\nparams: ${params}\`)`.

Что изменилось в `rc.5-5935859` в этих файлах: `begin` перенесён в отдельный `try`, который при ошибке делает `release()` (лечит утечку #6114/#6341). Ветка commit/rollback и `release()` без discard остались. Migrator не изменился. Ветка `rc5` на GitHub опережает `v1.0.0-rc.4` на 265 коммитов (последний — 2026-10-01). Это движущаяся цель, hash-сборки не являются релизом.

Открытые issue по теме (`gh`, VERIFIED):
- #874 «`migrate` isn't protected against simultaneous execution» — OPEN с 2023-07-10, labels `bug, drizzle/kit, priority`;
- #6114 и #6241 — `transaction()` теряет клиента при отказе `BEGIN` и возвращает сломанные клиенты в пул (rc.4 и 0.45.x);
- #6341 — то же, label `bug/fixed-in-beta`;
- #6083 — tx-handle продолжает работать после commit или rollback, запросы идут вне транзакции;
- #5187 — ошибки TypeScript при `skipLibCheck: false`;
- #1807 — нет динамической `pgSchema` (OPEN с 2024);
- #6020 — после `drizzle-kit up` с 0.45 на rc.4 следующий `generate` даёт no-op миграцию с полной перезаписью таблиц;
- #6140 — extra-config `pgTable` принимает произвольные объекты, а `drizzle-kit` молча их выбрасывает.

---

## 2. A. Наши три хранилища целиком (VERIFIED, agent-runtime `b0bcb265`)

Префиксы путей: Agent Execution — `packages/contexts/agent-execution/src/features/contained-agent-turn/`; Provider Access — `packages/contexts/provider-access/src/features/contained-turn-access/`; Runtime Security — `packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/`.

### 2.1 Agent Execution: `adapters/outbound/postgres/ordinary-postgres-store.ts` (152 строки) и `ordinary-state-codec.ts` (27)

- **Схема** (`:16-20`): `ordinary_turn_operations_v3`, `state text`, `revision bigint CHECK (revision >= 0)`, `PRIMARY KEY (tenant_id, project_id, operation_id)`, `UNIQUE (tenant_id, project_id, command_id)`. Имя без схемы, то есть таблица живёт в `search_path`. Версии и digest схемы нет. `applyOrdinaryPostgresSchema` — `CREATE TABLE IF NOT EXISTS` (`:49`).
- **Клиент** структурный, без импорта `pg` (`:2-7`). Таймауты: захват 5 с (`:39-43`), запрос 5 с через `Promise.race` с `release(true)` (`:21-38`).
- **Транзакция** (`:56-70`): `BEGIN`; `SET LOCAL statement_timeout 5000ms`, `lock_timeout 3000ms`, `idle_in_transaction_session_timeout 10000ms`; ошибка после начала `COMMIT` → `UnknownCommit` и discard (`:63-66`).
- **Кодек**: JSON-конверт `codecVersion 3` с digest канонизированного payload; лимит 8 MiB; `validateOrdinaryOperation` (`ordinary-state-codec.ts:12-27`). Поэтому `state` должен остаться `text`, а не `jsonb`.

| Метод | Транзакция и блокировка | Правило | Запись | Неясный commit |
|---|---|---|---|---|
| `accept` (`:81-101`) | `INSERT … ON CONFLICT (tenant,project,command) DO NOTHING`; при `rowCount 0` — `SELECT` без блокировки | Сравнение fingerprint (`:91`) | Только вставка | Readback по candidate `operationId`: найдено → `duplicate` («an unacknowledged accept never grants dispatch ownership», `:94`), иначе `unknown` |
| `read` (`:102`) | Без транзакции | — | — | — |
| `prepare` (`:103-111`) | `FOR UPDATE` | Inline: revision вызывающего, `accepted`, нет cancel, нет preparation (`:108`); дедлайны по `Date.now()` **до** транзакции (`:104-105`) | CAS по revision | Исключение `UnknownCommit` |
| `claim` (`:112-120`) | `FOR UPDATE` | Inline: revision вызывающего, срок минус 10 с (`:115`); claim receipt с `randomUUID()` строится в адаптере (`:116`) | CAS | `{kind:"unknown"}` **без** readback |
| `cancel` (`:121-127`) | `FOR UPDATE` | По текущей записи (`:124`) | CAS | Исключение |
| `append` (`:128-134`) | `FOR UPDATE` | По текущей записи и `attemptId` (`:131`) | CAS | Исключение |
| `finish`/`reconcile` (`:135-151`) | `FOR UPDATE` | По текущей записи; слияние receipts с проверкой неизменяемости — в адаптере (`:140-145`); статус — чистая `ordinaryTerminalStatus` (`:147`) | CAS | Исключение |

**Где доменная логика живёт в адаптере.** Построение агрегата с тремя `randomUUID()` и fingerprint (`:83-84`), claim receipt (`:116`), дедлайны (`:104-105`), слияние receipts (`:140-145`), guards (`:108`, `:115`, `:124`, `:131`).

**Порт** `OrdinaryOperationStore` есть (`application/ordinary-ports.ts:3-12`). Но `prepare(operation, …)`, `claim(operation)`, `append(operation, …)` и `finish(operation, …)` принимают весь агрегат, а адаптер берёт из него только ref, `revision` и `attemptId`.

**G1 подтверждён.** `#read` декодирует `state` и не сверяет его с ключом строки (`:71-74`); `#write` строит `WHERE` по identity из payload (`:77`).

### 2.2 Provider Access: `adapters/outbound/postgres/ordinary-pa-store.ts` (125), `ordinary-pa-schema.ts` (63), `materialization-postgres-transactions.ts` (93)

- **Схема** (`ordinary-pa-schema.ts:4-47`): таблицы `provider_access.ordinary_grant` и `ordinary_request` с `jsonb binding/snapshot`, пятью `CHECK` и двумя PL/pgSQL-триггерами монотонности и неизменяемости. Триггеры запрещают `DELETE` и откат `retired_at`, `disposition` и счётчиков.
- **Digest DDL**: `ordinaryPaSchemaDigest = sha256(ddl)` (`:48`). Реестр — `provider_access.materialization_schema(component='ordinary-pa-v1', version 1, digest)`. Миграция под `pg_advisory_xact_lock(1885433210)` (`:55`).
- **Проверка схемы на каждой транзакции**: `transaction = … transactions.write(async client => { await assertOrdinaryPaSchema(client); return work(client); })` (`ordinary-pa-store.ts:59-61`).
- **Транзакции**: свой класс с таймаутами `connectionMs 1000 / statementMs 2000 / transactionMs 4000` (`:58`). При сбое во время `COMMIT` он **бросает** «Provider Access commit acknowledgement is indeterminate» (`materialization-postgres-transactions.ts:83-87`), readback не делает.

| Метод | Блокировка | Правило | Запись | Неясный commit |
|---|---|---|---|---|
| `consume` (`:66-78`) | Нет | Окно срока и в приложении (`:68`), и по часам БД `clock_timestamp()` (`:73`) | `INSERT … SELECT … ON CONFLICT DO NOTHING`; `rowCount !== 1` → отказ (`:72-75`). **Одноразовый** | Исключение. Владелец отказывает (`ordinary-provider-access-owner.ts:75-76`). Повторный consume невозможен, нового гранта нет |
| `observe` (`:65`) | Нет | `decodeRow` сверяет binding со строкой (`:27-29`) | — | — |
| `retire` (`:79-89`) | `FOR UPDATE` | Все запросы завершены (`:83`) | `UPDATE retired_at`, если ещё не выставлен | Владелец: readback и принятие, если `retiredAt` уже есть (`ordinary-provider-access-owner.ts:113-117`) |
| `settle` (`:90-99`) | `FOR UPDATE` | Требует `retiredAt`; та же disposition идемпотентна | `UPDATE disposition, settlement_id` | Владелец: readback и принятие (`:159-163`) |
| `beginRequest` (`:100-112`) | `FOR UPDATE` | Не retired и не settled, нет failed, меньше 64, предыдущий завершён | `INSERT ordinary_request` и `UPDATE requests_started` | Исключение |
| `endRequest` (`:113-122`) | `FOR UPDATE` | sequence текущий | Условный `UPDATE … outcome='started'` (`rowCount`) и инкремент | Исключение |

**Порта нет.** `export type OrdinaryPaStore = ReturnType<typeof createOrdinaryPaStore>` (`:125`). Broker зависит от Postgres-типа: `Pick<OrdinaryPaStore, 'beginRequest' | 'endRequest'>` (`ordinary-pa-broker.ts:17`). CAS по revision нет: защита — блокировка строки плюс триггеры.

**Важная связка.** Ordinary-владелец Provider Access использует contained-инфраструктуру. В `migrate()` он мигрирует ещё и materialization (`ordinary-provider-access-owner.ts:53-57`). Для каждой операции он создаёт `createPostgresCredentialRenderingOwner(pool, selection)` (`:132`), а тот — `createPostgresMaterializationRepository(pool)` (`postgres-credential-rendering-owner.ts:33`). Этот же repository используют contained-композиции: `route-selection-owner.ts:41`, `postgres-current-provider-access.ts:14`, `postgres-materialization-authorization.ts:9`, а также embedded-runtime `darwin-contained-turn-deployment.ts:5,23`. Реестр `provider_access.materialization_schema` общий с компонентом `pa-m1`.

### 2.3 Runtime Security: `adapters/outbound/postgres/ordinary-security-owner.ts` (94) и `ordinary-security-transactions.ts` (49)

- **Схема**: `runtime_security_ordinary_grants_v1(… state text, state_digest text, PK(tenant,project,operation))`. `CREATE TABLE IF NOT EXISTS` прямо в методе `migrate()` владельца (`:69`). Без схемы БД, без версии.
- **Digest** считается по точному тексту: `row.state_digest !== hash(row.state)` (`:46`). Значит, нужен `text`, не `jsonb`.
- **Транзакции**: общий таймер 10 с, запрос 5 с, `statement_timeout` и `idle_in_transaction_session_timeout`, **без `lock_timeout`** (`ordinary-security-transactions.ts:39`). `close()` прерывает активные транзакции (`:9`).

| Метод | Блокировка | Правило | Запись | Неясный commit |
|---|---|---|---|---|
| `resolveAndConsume` (`:70-89`) | Нет: `INSERT … ON CONFLICT DO NOTHING`, затем чтение в той же транзакции (`:75-76`) | После транзакции: не settled и не истёк (`:80`). Повтор возвращает тот же грант из памяти (`:81`). **Идемпотентно в пределах TTL** | Только вставка | `catch {}` на **любую** ошибку → `observe` и принятие существующей записи (`:77-79`) |
| `observe` (`:90`) | Нет | `decode` сверяет input, policy и authority с ожидаемыми (`:15-34`) | — | — |
| `settle` (`:50-67`) | `FOR UPDATE` | Та же disposition идемпотентна | `UPDATE state` | `catch {}` → readback и принятие, если disposition совпала (`:60-64`) |

**Порт** `OrdinarySecurityOwner` (`application/ordinary-security-owner.ts:12-18`) — это порт **владельца**, а не хранилища. В него входят `migrate()`, `registerSecrets()` и `dispose()`. Postgres-фабрика и есть владелец (`composition/ordinary-security-factory.ts:1`): в одном модуле Map guards в памяти, политика TTL и SQL.

### 2.4 Host: `packages/apps/embedded-runtime/src/features/ordinary-session-runtime/composition/ordinary-agent-runtime-host.ts` (132)

- Тип входа выведен из Postgres-класса: `readonly storage: {readonly pool: ConstructorParameters<typeof PostgresOrdinaryOperationStore>[0]["pool"]}` (`:26`).
- Комментарий: «Borrowed pool: the Host never ends it. Schema is expanded additively during construction.» (`:25`).
- Миграции внутри фабрик: `await applyOrdinaryPostgresSchema(options.storage.pool)` (`:74`), `await owner.migrate()` для Runtime Security (`:77`) и Provider Access (`:82`).
- Фабрики вызывает Get Modular assembly. Слот `ordinaryTurnHostSlot` имеет `cardinality: {kind: "required"}` (`ordinary-runtime-assembly.ts:40`) и подключён к Host (`runtime-setup-assembly.ts:134`). Сбой любой фабрики валит всё создание Host.

### 2.5 Тесты и CI

- `postgres-durability` (`.github/workflows/ci.yml:93-213`) поднимает три сервиса `postgres:18.4-trixie`. Ordinary-тесты идут через `scripts/ci/ordinary-postgres-disposable.sh`, список файлов — `scripts/ci/run-ordinary-postgres.mjs:7-12`.
- Тесты Agent Execution и Runtime Security изолируются через `search_path` (`ordinary-core-postgres.test.ts:12`, `ordinary-security-postgres.test.ts:9`).
- Тест Provider Access требует свежий кластер (`ordinary-pa-postgres.test.ts:21`) и мигрирует параллельно: `await Promise.all([one.migrate(), two.migrate()])` (`:24`).
- Fault injection сравнивает SQL как строки: `sql === "COMMIT"` (`ordinary-security-postgres.test.ts:14`) и `sql.includes('SET retired_at=')` (`ordinary-pa-postgres.test.ts:111-113`). Drizzle передаёт объект `QueryConfig`, поэтому эти хуки придётся переписать.

---

## 3. B. Drizzle на точном теге `1.0.0-rc.4`: ответы по пунктам

| Вопрос | Ответ | Статус |
|---|---|---|
| Драйвер node-postgres принимает `Pool` и `PoolClient`? | Да: `drizzle({client})`, тип `NodePgClient = pg.Pool \| PoolClient \| Client` (`node-postgres/session.d.ts:14`). Структурный тип не проходит без `as unknown as PoolClient` (P9). Чужой пул не закрывает (`driver.js:32-37`) | VERIFIED |
| Зависимость от `pg` | `import pg from "pg"` на верхнем уровне `driver.js:8` и `session.js:7`. В `drizzle-orm` это `peerDependencies.pg ">=8"`, optional. У пакета ноль `dependencies`, 16 MB, 4173 файла | VERIFIED (`npm view`) |
| Ручная транзакция против `db.transaction()` | Ручная на одном `PoolClient` работает и сохраняет «неясный commit → readback» (P2). `db.transaction()` превращает ошибку `COMMIT` в обычную ошибку, делает `rollback` и `release()` без discard (P3; `session.js:50-65`). В rc.4 ещё и утечка клиента при отказе `BEGIN` (#6114, #6341) | VERIFIED |
| `FOR UPDATE`, `onConflictDoNothing`, `returning`, `rowCount` | Есть: `.for("update")` (`pg-core/dialect.js:209-215`), `onConflictDoNothing({target, where})` (`query-builders/insert.js:89-95`). Без `returning` update и insert исполняются в режиме `raw` и возвращают `QueryResult` с `rowCount` (`pg-core/async/update.js:18`, `insert.js:18`; P4, P5) | VERIFIED |
| `jsonb`, `check` | `jsonb` с `$type<T>()`; параметр-объект передаётся как есть, **строка будет закодирована повторно** (`node-postgres/codecs.js:37`), поэтому вместо `JSON.stringify` передавать объект. `check(name, sql\`…\`)` в extra-config | VERIFIED |
| Программный migrator | `migrate(db, {migrationsFolder, migrationsTable?, migrationsSchema?})` (`migrator.d.ts`). По умолчанию `drizzle.__drizzle_migrations`. Отдельный журнал на владельца реализуем (P7d). Нет блокировки (#874, P7a), нет сверки хешей (P7c), отбор только по `name` | VERIFIED |
| Поставка миграций в npm | Миграции читаются с диска (`readdirSync` в `migrator.js:11`). Папку `migrations/<owner>/` нужно положить в `files` пакета и резолвить через `fileURLToPath(new URL("../migrations/agent-execution", import.meta.url))` | VERIFIED по коду; ASSUMPTION по упаковке |
| Кастомные SQL-миграции | `drizzle-kit generate --custom` — «Prepare empty migration file for custom SQL» (bin `drizzle-kit@1.0.0-rc.4`). Триггеры и функции Drizzle не моделирует, они идут только кастомными миграциями | VERIFIED |
| Стабильность миграций между rc | SQL-файлы неизменяемы, перегенерировать их нельзя (так же требует ADR-0052 оркестратора). Формат папок v3 и журнал версии 1 с колонкой `name` уже в rc.4, путь апгрейда журнала есть (`up-migrations/pg.js`). Переход с 0.45 на 1.0 через `drizzle-kit up` даёт no-op миграцию с перезаписью таблиц (#6020) | VERIFIED; ASSUMPTION, что GA сохранит формат |
| ESM, TypeScript 7, Node 24/26, `pg@8.23` | ESM `type: module` с dual exports. Под TypeScript 7.0.2 и 5.9.3 наш код компилируется только с `skipLibCheck: true`: 47 ошибок в `.d.ts` Drizzle (P9). В agent-runtime `skipLibCheck: false` (`tsconfig.json:16`), а base preset Engineering Foundation включает `exactOptionalPropertyTypes: true`. Runtime проверен на Node 26.9.0 и `pg@8.23.0` (CI использует Node 24.18.0 — не проверено) | VERIFIED / ASSUMPTION для Node 24 |
| `drizzle-kit` | Нужен только для генерации, в `devDependencies`. Зависимости: `esbuild`, `jiti`, `@drizzle-team/brocli`, `@js-temporal/polyfill`, `get-tsconfig`. У `esbuild` нативные бинарники; проверить `allowBuilds` pnpm | VERIFIED (`npm pack`, package.json) |

---

## 4. C. Отображение инвариантов: метод за методом

| Метод | Форма на Drizzle | Escape hatch `sql` | Что теряется или меняется |
|---|---|---|---|
| Agent Execution `accept` | `insert(ops).values(row).onConflictDoNothing({target:[tenant,project,command]})` → `rowCount`; при 0 — `select … where command` | Нет | Ничего. Readback неясного commit остаётся нашим кодом |
| `prepare`, `claim` (revision вызывающего) | `select(...).for("update")` → `decidePrepare/decideClaim(current, expectedRevision, now)` → `update(...).where(and(ref, eq(revision, current.revision)))` → `rowCount === 1` | Нет | Ничего (P4). Асимметрия сохраняется в decide-функциях |
| `cancel`, `append`, `finish`, `reconcile` (текущая заблокированная запись) | То же, решение по `current` (append и terminal проверяют `attemptId`) | Нет | Ничего |
| Provider Access `consume` (одноразовый) | `db.execute(sql\`INSERT INTO ${grant} … SELECT … WHERE <окно clock_timestamp()> ON CONFLICT (operation_key) DO NOTHING\`)` → `rowCount !== 1` → отказ (P5b) | **Да.** `insert().select(SQL)` требует все вставляемые колонки по порядку (`dialect.js` `buildInsertQuery`: при SQL берутся все колонки) | Ничего, если оставить часы БД. Без SQL пришлось бы переносить проверку окна в триггер |
| `retire`, `settle` | `for("update")` → решение → `update` | Нет | Ничего; защита триггерами остаётся в миграции |
| `beginRequest` | `for("update")` → `insert(request)` → `update(grant).set({requestsStarted})` | Нет | Ничего |
| `endRequest` | Условный `update(request).where(… outcome='started')` → `rowCount`; `set({requestsCompleted: sql\`${t.requestsCompleted} + 1\`})` | Мелкий: инкремент через `sql` | Ничего |
| Runtime Security `resolveAndConsume` (идемпотентен в пределах TTL) | `insert(...).onConflictDoNothing()` → `select` в той же транзакции | Нет | Ничего. TTL и повтор гранта — в application |
| Runtime Security `settle` | `for("update")` → решение → `update` | Нет | Ничего |
| `BEGIN`, `SET LOCAL`, `COMMIT` | Строки через наш клиент (или `db.execute(sql\`…\`)`). **Не `db.transaction()`** | Да, осознанно | Ничего. Фаза commit классифицируется нашим кодом (P2) |
| Проверка схемы | Сверка журнала миграций (раздел 5) | Да, чтение журнала | Сейчас Provider Access проверяет digest на каждой транзакции; это свойство надо сохранить явно |
| Ошибки | Перехват `DrizzleQueryError` → санитизированная ошибка с `cause.code` (SQLSTATE) | — | Без этого текст ошибки несёт параметры: промпт, вывод, snapshot (P6) |

Итог по C: атомарная семантика переносится один в один. Escape hatch нужен в двух местах: одноразовый consume с окном по часам БД и управление транзакцией. Ещё два мелких: инкремент и чтение журнала. Теряется только то, что потеряли бы и с любым ORM: fault-injection тесты на строковый SQL.

---

## 5. D. Чем заменить проверку digest DDL Provider Access, сохранив fail-closed

Сейчас (VERIFIED): `sha256(ddl)` вшит в код. Строка реестра `component='ordinary-pa-v1'` сверяется на **каждой** транзакции (`ordinary-pa-store.ts:59-61`, `ordinary-pa-schema.ts:49-52`). Новая версия кода со старой БД или старая с новой отказывают.

Предлагаемая замена (VERIFIED как работающий механизм, P8):
1. **Журнал на владельца** в его схеме: `provider_access.__migrations` (`migrationsSchema: "provider_access"`, `migrationsTable: "__migrations"`). Агрегатного журнала на три владельца нет: при общем журнале совпадение имён папок молча пропустит миграцию (`migrator.utils.js:11-15`).
2. **Ожидаемый список** — `readMigrationFiles({migrationsFolder})` из поставленного пакета. Он даёт `[{name, hash}]`, где hash — тот же sha256 содержимого `migration.sql`, что пишет migrator (`migrator.js:28`).
3. **`verify()`** — точное равенство упорядоченных пар `(name, hash)` журнала и ожидаемого списка. Отказ при:
   - отсутствующем журнале или неполном наборе (`not_migrated`);
   - лишних строках, то есть база новее кода (`newer_schema`, fail-closed против даунгрейда);
   - несовпадающем хеше, то есть кто-то правил выпущенную миграцию (`hash_mismatch`; это закрывает P7c).
4. **На каждой транзакции** — лёгкая проверка головы журнала без лишнего round trip: вложить её в уже существующий запрос `set_config` (Provider Access и Runtime Security его делают), например `SELECT set_config(…), (SELECT hash FROM provider_access.__migrations ORDER BY id DESC LIMIT 1) AS head`, и сравнить с ожидаемым hash последней миграции. ASSUMPTION: стоимость нулевая по round trip и микросекунды по CPU. Решение владельца — оставить это только для Provider Access, как сейчас, или включить всем трём (рекомендую всем: одинаковое поведение и та же цена).
5. **Миграция-переход** для существующих БД:
   - Baseline не использует `IF NOT EXISTS` для таблиц владельца, иначе тихо примет чужую форму таблицы.
   - Guard в кастомной миграции: если `provider_access.ordinary_grant` существует и **не пуста** → `RAISE EXCEPTION`. Если пуста → `DROP TABLE` (триггеры на `DROP` не срабатывают) и удалить строку `component='ordinary-pa-v1'` из `materialization_schema`. **Строку `pa-m1` и таблицы materialization не трогать.**
   - Аналогично для `ordinary_turn_operations_v3` и `runtime_security_ordinary_grants_v1`; проверять через `to_regclass` и `EXECUTE`, потому что таблицы может не быть.

Свойство «сверка реестра, а не реального каталога» остаётся тем же, что сейчас: обе схемы доверяют своему реестру. Если нужен каталог, добавьте в тесты адаптера проверку `information_schema` и `pg_trigger` на ожидаемые constraint и триггеры. Это заодно страхует от #6140, когда kit молча выбрасывает объявленные индексы и constraint.

---

## 6. E. Форма портов (эскиз, не реализация)

### 6.1 Общее (в каждом владельце своё, без общего базового типа)

```ts
/** COMMIT ушёл, подтверждение потеряно. Адаптер никогда не повторяет запрос. */
export class OrdinaryStoreCommitUnknown extends Error { readonly code = "ORDINARY_STORE_COMMIT_UNKNOWN"; }
/** Хранилище недоступно или схема не совпала. Без параметров запроса в сообщении. */
export class OrdinaryStoreUnavailable extends Error { readonly code = "ORDINARY_STORE_UNAVAILABLE"; readonly sqlState?: string; }
```

Классы ошибок делать **отдельными в каждом владельце**: у Provider Access уже есть `OrdinaryPaUnavailable`. Общий пакет ошибок был бы тем самым «service bag».

### 6.2 Agent Execution

```ts
// application/ports/ordinary-operation-store.ts
export interface OrdinaryOperationStore {
  /** Вставка по (scope, commandId), если записи нет. "inserted" только для строки, вставленной этим вызовом. */
  insertIfAbsent(candidate: OrdinaryOperation): Promise<
    | {readonly kind: "inserted"; readonly operation: OrdinaryOperation}
    | {readonly kind: "existing"; readonly operation: OrdinaryOperation}>;          // бросает OrdinaryStoreCommitUnknown
  read(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined>;
  /** Сверяет revision вызывающего. */
  prepare(ref: OrdinaryOperationRef, expectedRevision: number, preparation: OrdinaryPreparation): Promise<OrdinaryTransition>;
  /** Сверяет revision вызывающего. На неясный commit возвращает "unknown" и никогда не делает readback в "claimed". */
  claim(ref: OrdinaryOperationRef, expectedRevision: number): Promise<
    | {readonly kind: "claimed"; readonly operation: OrdinaryOperation; readonly receipt: OrdinaryReceiptOf<"dispatch_claim">}
    | {readonly kind: "not_claimed" | "unknown"}>;
  /** Работают с текущей заблокированной записью, чтобы не терять параллельные факты. */
  cancel(ref: OrdinaryOperationRef): Promise<OrdinaryOperation | undefined>;
  append(ref: OrdinaryOperationRef, attemptId: string, output: Omit<OrdinaryOutput, "cursor">): Promise<OrdinaryOperation>;
  finish(ref: OrdinaryOperationRef, attemptId: string, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation>;
  reconcile(ref: OrdinaryOperationRef, attemptId: string, receipts: readonly OrdinaryReceipt[]): Promise<OrdinaryOperation>;
}
export type OrdinaryTransition = {readonly kind: "applied"; readonly operation: OrdinaryOperation} | {readonly kind: "rejected"; readonly reason: OrdinaryRejection};

// domain/ordinary-decisions.ts — чистые функции, часы и идентификаторы передаются явно
export interface OrdinaryDecisionContext {readonly now: number; readonly newId: (prefix: "claim") => string}
export type OrdinaryDecision<R> =
  | {readonly kind: "write"; readonly next: OrdinaryOperation; readonly result: R}
  | {readonly kind: "keep"; readonly result: R}
  | {readonly kind: "reject"; readonly reason: OrdinaryRejection};
export declare function newOrdinaryOperation(input: OrdinaryInput, ids: {operationId: string; attemptId: string; effectId: string}): OrdinaryOperation;
export declare function decideOrdinaryAcceptExisting(existing: OrdinaryOperation, input: OrdinaryInput): "duplicate" | "conflict";
export declare function decideOrdinaryPrepare(current: OrdinaryOperation | undefined, expectedRevision: number, preparation: OrdinaryPreparation, ctx: OrdinaryDecisionContext): OrdinaryDecision<OrdinaryOperation>;
export declare function decideOrdinaryClaim(current: OrdinaryOperation | undefined, expectedRevision: number, ctx: OrdinaryDecisionContext): OrdinaryDecision<OrdinaryReceiptOf<"dispatch_claim"> | null>;
export declare function decideOrdinaryCancel(current: OrdinaryOperation | undefined): OrdinaryDecision<OrdinaryOperation | undefined>;
export declare function decideOrdinaryAppend(current: OrdinaryOperation | undefined, attemptId: string, output: Omit<OrdinaryOutput, "cursor">): OrdinaryDecision<OrdinaryOperation>;
export declare function decideOrdinaryTerminal(current: OrdinaryOperation | undefined, attemptId: string, receipts: readonly OrdinaryReceipt[], reconcile: boolean): OrdinaryDecision<OrdinaryOperation>;
/** G1: адаптер обязан вызвать после декодирования строки. */
export declare function assertOrdinaryRowIdentity(row: {readonly tenantId: string; readonly projectId: string; readonly operationId: string; readonly commandId: string; readonly revision: number}, operation: OrdinaryOperation): void;
```

- Readback неясного `accept` переходит в application (`ordinary-engine`): при `OrdinaryStoreCommitUnknown` — `read(candidateRef)`. Найдено → `duplicate`, иначе `unknown` (как сейчас `:94-99`).
- `now` адаптер читает **после** захвата блокировки: сейчас `claim` так и делает, а `prepare` — до транзакции (`:104`). Это мелкая поправка поведения.

### 6.3 Provider Access

```ts
// application/ports/ordinary-pa-grant-store.ts
export interface OrdinaryPaGrantStore {
  /** Одноразово: ровно один успешный insert на binding за всё время. Неясный commit отказывает, второго гранта нет. Хранилище вправе отказать по своему окну часов. */
  insertGrant(grant: OrdinaryPaGrantRecord): Promise<{readonly kind: "inserted"; readonly snapshot: OrdinaryPaSnapshot} | {readonly kind: "rejected"}>;
  observe(binding: OrdinaryPaBinding): Promise<OrdinaryPaSnapshot | undefined>;
  retire(binding: OrdinaryPaBinding, retiredAt: string): Promise<OrdinaryPaSnapshot>;                 // идемпотентно; бросает при незавершённых запросах
  settle(binding: OrdinaryPaBinding, disposition: OrdinaryPaDisposition, settlementId: string): Promise<OrdinaryPaSnapshot>;
  beginRequest(binding: OrdinaryPaBinding, request: {readonly bodyDigest: string; readonly byteLength: number}): Promise<number>;
  endRequest(binding: OrdinaryPaBinding, sequence: number, outcome: "completed" | "failed"): Promise<void>;
}
// domain: newOrdinaryPaGrant(binding, selected, ids), decideOrdinaryPaRetire/Settle/BeginRequest/EndRequest(current, …)
/** Пока жив contained: отдельный порт materialization для credential rendering одной операции. */
export interface OrdinaryPaMaterializationStores { forOperation(selection: CredentialRenderingSelection): MaterializationAuthorizationRepository & {replaceBinding(…): Promise<number | undefined>; dispose(): void} }
```

Broker переходит с `Pick<OrdinaryPaStore, …>` на `Pick<OrdinaryPaGrantStore, "beginRequest" | "endRequest">`.

### 6.4 Runtime Security

```ts
// application/ports/ordinary-security-grant-store.ts — только хранилище
export interface OrdinarySecurityGrantStore {
  insertIfAbsent(record: OrdinarySecurityGrantRecord): Promise<{readonly kind: "inserted" | "existing"; readonly record: OrdinarySecurityGrantRecord}>;
  observe(key: OrdinarySecurityKey): Promise<OrdinarySecurityGrantRecord | undefined>;
  settle(key: OrdinarySecurityKey, settlement: OrdinarySecuritySettlement): Promise<{readonly kind: "settled" | "already"; readonly settlement: OrdinarySecuritySettlement} | {readonly kind: "conflict"}>;
}
// application/ordinary-security-owner.ts — владелец без SQL: guards, TTL, readback
export declare function createOrdinarySecurityOwner(options: {store: OrdinarySecurityGrantStore; allowedScope: OrdinarySecurityScope; policy: OrdinarySecurityPolicy; clock?: () => number}): OrdinarySecurityOwner;
// OrdinarySecurityOwner теряет migrate(); domain: decideOrdinarySecurityConsume(record, now): "grant" | "deny"
```

### 6.5 Хранилище для Host вместо `storage.pool`

```ts
// embedded-runtime объявляет структурный тип; Postgres-пакет реализует его, не импортируя embedded-runtime
export interface OrdinaryRuntimeStorage {
  readonly operations: OrdinaryOperationStore;
  readonly providerAccess: {readonly grants: OrdinaryPaGrantStore; readonly materialization: OrdinaryPaMaterializationStores};
  readonly security: OrdinarySecurityGrantStore;
  /** Прерывает транзакции в полёте и ждёт их; заимствованный пул не закрывает никогда. */
  close(): Promise<void>;
}
// OrdinaryAgentRuntimeHostOptions.storage: OrdinaryRuntimeStorage

// @agent-teams/runtime-store-postgres
export declare function openPostgresStorage(input: {readonly pool: import("pg").Pool; readonly clock?: () => number}): Promise<OrdinaryRuntimeStorage>; // read-only verify(); при несовпадении бросает PostgresStorageSchemaMismatch
export declare function migratePostgresStorage(input: {readonly pool: import("pg").Pool; readonly owners?: readonly PostgresStorageOwner[]}): Promise<readonly {readonly owner: PostgresStorageOwner; readonly applied: readonly string[]}[]>;
export declare function verifyPostgresStorage(input: {readonly pool: import("pg").Pool}): Promise<{readonly ok: true} | {readonly ok: false; readonly owner: PostgresStorageOwner; readonly reason: "not_migrated" | "newer_schema" | "hash_mismatch"}>;
export type PostgresStorageOwner = "agent-execution" | "provider-access" | "runtime-security";
```

Имя `createPostgresStorage` из схемы меняю на `openPostgresStorage`. Функция асинхронная и делает `verify`, поэтому «open» честнее.

**API миграций.** На каждого владельца:
1. взять отдельный `PoolClient`;
2. `SELECT pg_advisory_lock(<const classid>, <owner objid>)`;
3. `SET lock_timeout` и `statement_timeout` для DDL;
4. `migrate(drizzle({client}), {migrationsFolder, migrationsSchema: <owner schema>, migrationsTable: "__migrations"})`;
5. `verify`;
6. в `finally` — `pg_advisory_unlock`, при ошибке unlock — `release(true)`.

Это ровно P8. Порядок владельцев не важен: связей между их таблицами нет (VERIFIED: внешних ключей между тремя наборами нет).

### 6.6 Проверки совместимости (что входит в набор на каждый порт)

**`OrdinaryOperationStore`:**
1. N параллельных `insertIfAbsent` одной команды → ровно один `inserted`, остальные `existing` с тем же `operationId`.
2. `read` после рестарта (новый экземпляр на том же хранилище) возвращает то же. Чужой tenant → `undefined`.
3. Устаревшая revision в `prepare` → `rejected`, записи нет; текущая → `revision + 1`.
4. N параллельных `claim` с одной revision → ровно один `claimed`, `committedRevision = revision + 1`.
5. `claim` после cancel и `claim` при сроке в пределах 10 с → `not_claimed`.
6. `cancel` идемпотентен; на терминальной операции записи нет.
7. N параллельных `append` → курсоры 1..N без дыр (работа по текущей записи); чужой `attemptId` → отказ.
8. `finish` и `reconcile`: слияние receipts; конфликт того же вида → отказ; терминальная операция → `keep`.
9. Любая возвращённая операция совпадает по identity с запрошенным ref (G1).
10. `close()`: вызовы в полёте завершаются `Unavailable`, новые отклоняются, пул жив.

**`OrdinaryPaGrantStore`:**
1. N параллельных `insertGrant` → один `inserted`. Повтор после settle → `rejected` (одноразовость навсегда).
2. Чужой `attemptId` в `observe` → отказ; чужой tenant → `undefined`.
3. `beginRequest`: отказ после retire или settle, при failed, на 65-м запросе и при незавершённом предыдущем; одинаковый `bodyDigest` → отказ.
4. `endRequest` только для текущего started; повтор → отказ.
5. `retire` при незавершённых запросах → отказ; повтор → тот же `retiredAt`.
6. `settle` до retire → отказ; та же disposition → тот же `settlementId`; другая → отказ.
7. Окно срока гранта.

**`OrdinarySecurityGrantStore`:**
1. Параллельные `insertIfAbsent` → одна запись, остальные `existing`, побайтно одинаковые.
2. `observe` с другим input или policy → отказ.
3. `settle` идемпотентен; другая disposition → `conflict`.
4. В сырой записи нет секретов. Это тест владельца: он регистрирует токены, а хранилище не должно их видеть.

**Вне набора, в тестах Postgres-пакета:**
- потеря ACK `COMMIT` на каждом методе; ожидаемые исходы — в разделе 7, пункт 2;
- параллельные миграции;
- триггеры неизменяемости (`UPDATE snapshot` → `immutable`, `DELETE` → `immutable`);
- наличие constraint и триггеров в каталоге;
- legacy guard.

### 6.7 Куда ложатся G1 и G2

- **G1 (сверка ключа строки с содержимым).** Доменный helper `assertOrdinaryRowIdentity` в Agent Execution. Его вызывает декодер строки в адаптере: сверяются `tenant_id`, `project_id`, `operation_id`, `command_id` **и** колонка `revision` с payload. Плюс пункт 9 в наборе совместимости. У Provider Access и Runtime Security аналог уже есть (`ordinary-pa-store.ts:28-29`, `ordinary-security-owner.ts:21`). Его надо перенести в их декодеры без изменений.
- **G2 (failed workspace preparation без cleanup-only handle)** к хранилищу **не относится**: это engine и workspace adapter (cleanup-only handle). Если нужен долговечный след retained workspace, это новый факт в модели Agent Execution: receipt `workspace_retained` с `workspaceId`. Хранилищу он не требует новых методов: `reconcile(ref, attemptId, receipts)` его уже сохранит, когда домен разрешит такой вид receipt. В план хранилища G2 не включать.

---

## 7. Вердикты по пунктам 1–7 схемы (подробно)

### Пункт 1. Порт на владельца — **подтверждено, требует поправки** (🎯9)

- VERIFIED. Порт есть только у Agent Execution (`application/ordinary-ports.ts:3-12`). Provider Access: `OrdinaryPaStore = ReturnType<typeof createOrdinaryPaStore>` (`ordinary-pa-store.ts:125`). Runtime Security: порт владельца, совмещённый с хранилищем, guards и `migrate` (`application/ordinary-security-owner.ts:12-18`).
- Поправки:
  - Provider Access получает порт `OrdinaryPaGrantStore` вместе с журналом запросов broker.
  - Runtime Security разделяется: владелец в application, хранилище — в отдельный порт.
  - `migrate` уходит из портов.
  - Методы Agent Execution принимают `ref + expectedRevision` или `ref + attemptId`, а не весь агрегат.
  - Построение агрегата с идентификаторами уходит из адаптера в domain (`ordinary-postgres-store.ts:83-84, 116`).
- Отказ от `Repository<T>` подтверждаю: у трёх владельцев три разные модели атомарности (раздел 2). Тот же вывод в ADR-0052 оркестратора (`0052-…md:146-147`).

### Пункт 2. Решения в domain, тонкий адаптер — **требует поправки** (🎯8)

**Шаблонов адаптера три, а не один (VERIFIED):**
1. **Вставка-если-нет плюс сравнение**: Agent Execution `accept`, Runtime Security `resolveAndConsume`. Без блокировки и без CAS.
2. **Одноразовая вставка**: Provider Access `consume` — `ON CONFLICT DO NOTHING`, затем `rowCount !== 1` → отказ.
3. **Блокировка → решение → запись**. CAS по revision только там, где у агрегата есть revision (Agent Execution). Provider Access полагается на блокировку и триггеры монотонности, Runtime Security — на блокировку. Добавлять им revision ради единообразия не нужно.

CAS под `FOR UPDATE` в Agent Execution формально избыточен. Но он ловит рассинхрон payload и ключа строки (G1), поэтому его стоит оставить.

**Неясный commit — семь разных семантик (VERIFIED), а не «перечитать и вернуть `unknown`»:**

| Метод | Ожидаемый исход | Где сейчас | Где должен быть |
|---|---|---|---|
| Agent Execution `accept` | Readback: найдено → `duplicate` (никогда `accepted`), не найдено → `unknown` | адаптер `:92-100` | application |
| Agent Execution `claim` | `unknown` **без** readback, процесс не запускается | адаптер `:119` | адаптер (контракт порта) |
| Agent Execution `prepare`, `cancel`, `append`, `finish`, `reconcile` | Типизированное исключение; engine переводит операцию в reconcile | адаптер (`UnknownCommit` не экспортирован, `:50`) | `OrdinaryStoreCommitUnknown` экспортирован из порта |
| Provider Access `consume` | Отказ без readback; повтор невозможен, второго гранта нет | транзакции `:83-87`, владелец `:75-76` | контракт порта плюс тест |
| Provider Access `retire`, `settle` | Readback и принятие, если целевое состояние достигнуто | владелец `:113-117`, `:159-163` | application |
| Runtime Security `resolveAndConsume` | Readback и принятие существующего гранта | адаптер-владелец `:77-79` | application (владелец Runtime Security) |
| Runtime Security `settle` | Readback и принятие при совпадении disposition | адаптер-владелец `:60-64` | application |

**Правило для плана.**
- Адаптер классифицирует фазу: «не закоммичено» против «исход неизвестен». Он никогда не повторяет запрос и никогда не делает readback сам.
- Политика readback — часть контракта метода порта в application.
- Набор совместимости проверяет «unknown никогда не даёт владения».

Это совпадает с выводом spike оркестратора: «retry policy requires adapter-owned commit phase» (`OD-003…md:125-127`).

Попутно у Runtime Security `catch {}` ловит **любую** ошибку, включая отказ декодера, и делает readback (`:77`, `:60`). Безопасно, потому что readback тоже декодирует. Но это маскирует причины. В новом владельце ловить только `CommitUnknown` и `Unavailable`.

### Пункт 3. Хранилища через композицию — **подтверждено, требует поправки** (🎯8)

- VERIFIED. Сейчас тип входа Host выведен из Postgres-класса (`ordinary-agent-runtime-host.ts:26`).
- Поправки:
  - Тип входа объявляет embedded-runtime **структурно** (раздел 6.5), иначе Postgres-пакет зависел бы от embedded-runtime.
  - Provider Access нужен ещё и per-operation materialization repository (`ordinary-provider-access-owner.ts:132`). Пока жив contained, это отдельный порт.
  - Нужен `close()`, который прерывает транзакции и не закрывает пул. Инвариант «borrowed pool» уже проверяется тестом (`ordinary-core-postgres.test.ts:32-33`), Drizzle его не нарушает (`driver.js` не вызывает `end`).
  - `pg` становится обязательной runtime-зависимостью Postgres-пакета (`driver.js:8`).

### Пункт 4. Миграции отдельным шагом — **первая половина подтверждена, вторая требует решения владельца** (🎯9)

- VERIFIED. Сейчас наоборот: миграции идут в фабриках (`:74`, `:77`, `:82`), а комментарий `:25` это декларирует. Отдельный шаг — breaking change API Host; на этапе MVP это допустимо.
- «Ошибка отключает только ordinary» сейчас невозможна: слот `required` (`ordinary-runtime-assembly.ts:40`, `runtime-setup-assembly.ts:134`). Понадобятся:
  - optional-слот и явный статус «ordinary unavailable» в API Host;
  - решение, нужна ли такая деградация вообще. Тот, кто явно создал ordinary Host со storage, скорее ждёт типизированную ошибку создания, а не тихо урезанный Host.
- Рекомендация: создание Host делает только `verifyPostgresStorage` и падает с `ordinary_storage_unavailable` и `reason`. Деградация — отдельный вариант (раздел 13, выбор 4), не раньше Get Modular 0.3.0 (AR-1).

### Пункт 5. Проверки совместимости как `./testing` subpath — **требует поправки** (🎯8)

- VERIFIED: отвергающий тест Agent Execution `tests/package/testing-subpath-packed-consumer.test.ts`:
  > `:129` `assert.equal(packedPaths.some(path => /^dist\/(?:production|testing)(?:\.|\/)/u.test(path)), false);`
  >
  > `:164` `extraExports.some(key => key.startsWith("./production") || key.startsWith("./testing"))` → `false`
  >
  > `:167-171` любой лишний export обязан начинаться с `./dist/`, `./tests/` или `./scripts/`
  >
  > `:201` динамический `import(\`@agent-teams/agent-execution/${subpath}\`)` для `production` и `testing` должен отказать.
- Плюс `SDK_EXPORT_MATRIX_DRIFT` (`scripts/architecture/check-sdk-growth-profile.mjs:157`) и `packageExports: [., ./composition]` в `architecture/foundation/source-dependencies.yaml`.
- Fault injection неясного commit зависит от адаптера (обёртка пула) и в общий набор не помещается.
- Варианты — раздел 13, выбор 3.

### Пункт 6. Drizzle `1.0.0-rc.4` — **реализуемо с шестью обязательными адаптациями** (🎯8)

**Факты координатора подтверждены** (`npm view`):
- rc.1 — 2026-04-30, rc.2 — 2026-05-05, rc.3 — 2026-05-18, rc.4 — 2026-06-27;
- `rc.5` только в hash-сборках: `ab785fc` (2026-08-11), `169397b` (2026-08-12), `5935859` (2026-09-09);
- dist-tags `rc: 1.0.0-rc.4`, `rc5: 1.0.0-rc.5-5935859`;
- latest `drizzle-orm@0.45.3` и `drizzle-kit@0.31.11` (2026-09-21). Стабильная линия 0.x патчится и после rc.4.

**Обязательные адаптации** (каждая воспроизведена):
1. Ручная транзакция на одном `PoolClient`, не `db.transaction()` (P2, P3).
2. Обёртка migrator: advisory lock, журнал на владельца, `verify` (P7a, P7c, P8).
3. Санитизация `DrizzleQueryError` (P6).
4. Клиентская обёртка передаёт `(config, values)` (P1).
5. `skipLibCheck: true` **только в tsconfig Postgres-пакета**, с явным deviation; Drizzle-импорты не должны попадать в корневой `tsconfig.json` (P9).
6. `state` остаётся `text`, потому что digest считается по байтам: `jsonb` переупорядочивает ключи. Это VERIFIED у Runtime Security (`:46`) и записано в `OD-003…md:74` оркестратора.

Hash-сборки rc.5 не брать. Переход на GA — отдельный PR с прогоном набора совместимости, без перегенерации миграций.

### Пункт 7. Один пакет на три адаптера — **реализуемо для Agent Execution и Runtime Security; для Provider Access сейчас заблокировано** (🎯8)

- Направление зависимостей корректно: `runtime-store-postgres → {agent-execution, provider-access, runtime-security}` (публичные порты, domain decide, кодеки), а `embedded-runtime → runtime-store-postgres`. Циклов нет, **пока** owner-пакеты не зависят от Postgres-пакета.
- Provider Access: ordinary-путь использует `createPostgresMaterializationRepository` и `createPostgresCredentialRenderingOwner`, общие с contained (раздел 2.2). Два исхода переноса:
  - **цикл**: contained-композиция Provider Access зависит от нового пакета, а новый пакет — от Provider Access;
  - **два владельца** таблиц `provider_access.materialization_*` с двумя механизмами миграций.

  Выходы — раздел 13, выбор 2.
- «Ядро и библиотеки свободны от Postgres» верно для ordinary-модулей, но **не для пакетов**, пока жив contained. Agent Execution держит `pg` в `dependencies` и contained-хранилища в production-границе (`source-dependencies.yaml:488-505`); Provider Access держит materialization и dispatch-хранилища. Формулировку в плане надо уточнить.
- Пакет держать `private: true` до второго потребителя. Это снимает главное возражение раунда 2 (Q1): публикация закрепила бы durable-формат.

---

## 8. F. Orchestrator на практике (main `604ed911`)

- **Кода на Drizzle нет** (VERIFIED). `drizzle` отсутствует во всех `package.json` и в `pnpm-lock.yaml`. Упоминания только в документах: ADR-0052, ADR-0025/0046/0047/0049, OD-003, OD-024, `persistence-boundary.md`, `testing-strategy.md`, research.
- **Spike-harness удалены**: «All temporary harnesses … were checksum-verified and then deleted … It does not claim that deleted harnesses remain reproducible» (`docs/research/foundation-spike-evidence-manifest-2026-07-26.md:19-22`). От parity-spike «25/25 … pinned `drizzle-orm` 1.0.0-rc.4» (`OD-003…md:66-70`) остался только SHA-256. Неизвестно, использовал ли он `db.transaction()` и Drizzle-migrator.
- **Основание RC у них — node:sqlite**: «the stable ORM does not export `drizzle-orm/node-sqlite`» (`cross-dialect-persistence-tooling-2026-07-26.md:39`; `OD-003…md:72-73`). У agent-runtime только PostgreSQL, и `0.45.3` его полностью поддерживает. Довод ADR-0052 о двух диалектах к нам не переносится. Для RC в agent-runtime остаются два основания: решение владельца и отсутствие перехода формата миграций 0.x → 1.0 (#6020). Оба законные, но слабее.
- **Что практически подтверждается:**
  - «connection, transaction, and commit-ambiguity handling» — дело адаптера (`0052-…md:80`) = наш P2/P3;
  - «PostgreSQL advisory lock must precede metadata DDL» (`OD-003…md:99-100`) = P7a/P8, Drizzle этого не делает;
  - «immutable checksum enforcement» (`OD-003…md:95`) = P7c, Drizzle этого не делает;
  - «`jsonb` reordered keys» (`OD-003…md:74`);
  - адаптерная фаза commit (`OD-003…md:125-127`);
  - «No caret, tilde, or floating release-candidate range» (`0052-…md:47`);
  - «An upgrade never regenerates released migrations» (`:49-50`).
- **Что не подтверждается или не проверено:**
  - что Drizzle сам закрывает миграции и транзакции — по нашим probe, нет;
  - что rc.4 проходит `skipLibCheck: false` — не проходит;
  - production-готовность: OD-003 `status: open`, readiness-гейт не пройден (`OD-003…md:4, 37-43`).

---

## 9. G. Упаковка и зависимости `@agent-teams/runtime-store-postgres`

- **`dependencies`:** `drizzle-orm: "1.0.0-rc.4"` — точный пин через catalog (`catalogMode: strict`, `pnpm-workspace.yaml:6`); workspace-зависимости на три owner-пакета.
- **`peerDependencies`:** `pg: "^8.23.0"`, плюс `devDependencies: pg: catalog:`. Почему peer: пул принадлежит встраивающему приложению. Один экземпляр `pg` избавляет от расхождения типов и от `instanceof Pool` в Drizzle (`session.js:51`). Обычная зависимость тоже работала бы, потому что транзакции ручные (ASSUMPTION, 🎯7).
- **`devDependencies`:** `drizzle-kit: "1.0.0-rc.4"`. Альтернатива — писать SQL вручную в формате папок 1.0 и не тянуть esbuild.
- **`files`:** `dist`, `migrations/agent-execution`, `migrations/provider-access`, `migrations/runtime-security`.
- **tsconfig:** `skipLibCheck: true` с комментарием «почему, когда вернуть» (#5187).
- **Сосуществование миграций.** Отдельная папка, журнал (`<owner_schema>.__migrations`) и advisory lock на каждого владельца. Схемы БД: `agent_execution`, `provider_access`, `runtime_security`. У Provider Access схема уже есть; Agent Execution и Runtime Security сейчас без схемы, через `search_path`.
- **Governance — работа единственного integrator (VERIFIED):**
  - SDK-growth: новый пакет ловит `SDK_SCOPE_DRIFT` (`check-sdk-growth-profile.mjs:103`), новые subpath — `SDK_EXPORT_MATRIX_DRIFT` (`:157`). PR #187 их не трогает (`round2-update-2026-10-02.md` §1);
  - `architecture/foundation/source-dependencies.yaml`: новый `packageRoot`, `governedRoots`, границы с разрешёнными `drizzle-orm` и `pg`, `packageExports`. Убрать `pg` из границы Agent Execution не получится, пока жив contained (`:583-586`);
  - Feature Module Standard: `architecture/feature-module-standard/ordinary-scope.json` перечисляет файлы хранилищ по путям. После переноса пути меняются, иначе `architecture:feature-modules:active` упадёт (ASSUMPTION о поведении проверки; список путей VERIFIED);
  - Consumer Module Standard и Get Modular consumer profile: новая композиционная граница (Postgres-пакет как поставщик `ordinary/store`, `ordinary/security`, `ordinary/provider-access`) должна быть принята или классифицирована (workspace `AGENTS.md`, раздел Consumer Module Standard). Это пересекается с AR-1 и AR-1b, которые переписывают `ordinary-runtime-assembly.ts` и `consumer-profile.json`;
  - curated export census: Agent Execution `BASE_COMPOSITION_RUNTIME_EXPORTS` (`testing-subpath-packed-consumer.test.ts:11+`), Provider Access `curated-composition-surface.test.ts:11+`, Runtime Security `curated-assembly-surface.test.ts`. Экспорт портов и decide-функций меняет эти списки.

---

## 10. H. Объём и разбиение (по реальным размерам файлов)

Базовые размеры (VERIFIED, `wc -l`):

| Часть | Строк |
|---|---:|
| Agent Execution: store 152, codec 27, ports 68, validation 144, model 71, engine 271 | 733 |
| Provider Access: ordinary-pa-store 125, ordinary-pa-schema 63, transactions 93, ordinary owner 191, broker 186, contracts 61; связка materialization: repository 159, schema 56, binding 40, credential rendering owner 59 | 1033 |
| Runtime Security: owner 94, transactions 49, port 18, policy 74 | 235 |
| Host 132; ordinary-тесты Postgres 58 + 35 + 141; тесты и fixtures с `storage: {pool}` в embedded-runtime и Provider Access около 650 | ≈1016 |

Оценка изменений (ASSUMPTION, уверенность в LOC 4/10):

| PR | Содержание | Changed | Moves | Исполнитель | Зависит от |
|---|---|---:|---:|---|---|
| S0 | Governance: выключить SDK-growth asserts для нового пакета, catalog `drizzle-orm`/`drizzle-kit`, скелет пакета, `source-dependencies.yaml`, tsconfig deviation, ADR «хранилища на Drizzle» | 400–700 | 0 | integrator | — |
| S1a | Agent Execution: decide-функции, `newOrdinaryOperation`, `assertOrdinaryRowIdentity`, сужение порта, engine, табличные тесты; **текущий raw-SQL адаптер вызывает decide** | 500–800 | 0–60 | исполнитель 1 | — |
| S1b | Runtime Security: владелец в application плюс `OrdinarySecurityGrantStore`; текущий Postgres-адаптер реализует порт | 300–450 | 50–100 | исполнитель 2 | — |
| S1c | Provider Access: `OrdinaryPaGrantStore`, `newOrdinaryPaGrant`, владелец принимает порт и materialization-порт, broker | 300–500 | 0–60 | исполнитель 3 | — |
| S2-core | Пакет: транзакционный runner (заменяет три разных), runner миграций (lock, journal, verify), санитизация ошибок, `openPostgresStorage`, пакет проверок совместимости | 600–900 | 0 | integrator или исполнитель 1 | S0 |
| S2-execution | Drizzle-адаптер и схема Agent Execution, миграция с legacy guard, перенос и адаптация тестов, удаление старого адаптера | 350–550 | 180–250 | исполнитель 1 | S1a, S2-core |
| S2-security | То же для Runtime Security | 250–400 | 140–200 | исполнитель 2 | S1b, S2-core |
| S2-access | То же для Provider Access: триггеры кастомной миграцией, `db.execute` для consume, тесты | 450–700 | 190–260 | исполнитель 3 | S1c, S2-core, **решение по contained** |
| S3 | Host: `storage: OrdinaryRuntimeStorage`, явная миграция, `verify` при создании, тесты и fixtures, CI `postgres-durability` (по базе на тест вместо `search_path`) | 350–600 | 0 | integrator | S2-*, **AR-1** |
| **Итого** | | **≈3500–5600** | **≈560–930** | | |

Плюс автогенерируемый churn `pnpm-lock.yaml`, в LOC не учтён.

- **Параллельно:** S1a ‖ S1b ‖ S1c (файлы не пересекаются); затем S2-execution ‖ S2-security ‖ S2-access после S2-core.
- **Единственный integrator:** S0 и S3; корневые manifests, catalog, lock, `source-dependencies.yaml`, профили Feature Module Standard, Consumer Module Standard и Get Modular, SDK-growth, CI workflow, ADR, Host и Assembly.
- Каждый PR укладывается в ~2000 строк.
- S1a/b/c ценны сами по себе даже без Drizzle: это R1c из раунда 1 и разделение Runtime Security. Их стоит делать первыми, независимо от решения по ORM.

---

## 11. I. Риски

| # | Риск | Вероятность / вред | Что делать |
|---|---|---|---|
| R1 | Нестабильность RC: ветка `rc5` +265 коммитов; между rc меняются API (в rc.4 «Removed `mapResult`», переработка codecs и сессий, release notes `v1.0.0-rc.4`) | Средняя / средний | Узкая поверхность: `pgTable`, колонки, `select`/`insert`/`update`, `sql`, `migrate`, `readMigrationFiles`; без RQB, relations и cache. Точный пин, набор совместимости, переход на GA отдельным PR |
| R2 | Отличия поведения: `DrizzleQueryError` с параметрами, переопределённые type parsers (`session.js:12-25` — timestamp и date строками), `bigint` mode | Высокая, если не учесть / высокий (утечка промптов в логи) | Санитизация, классификация по `cause.code`, только `text`/`bigint number`/`jsonb` |
| R3 | Migrator без блокировки и без сверки хешей (#874, P7a, P7c) | Высокая / высокий | Обёртка P8 обязательна; тест параллельной миграции уже есть (`ordinary-pa-postgres.test.ts:24`) |
| R4 | Durable-данные: таблицы созданы без журнала; baseline с `IF NOT EXISTS` тихо примет чужую форму | Средняя / высокий | Новые имена и схемы, guard «таблица пуста», иначе `RAISE`. Не трогать `pa-m1`. Сначала ответить на Q5 раунда 2 (есть ли реальные строки) |
| R5 | CI: изоляция через `search_path` ломается (P7b); `pgSchema` статична (#1807); fault-injection хуки на строковом SQL | Высокая / средний | База на тест (`createdb`, как уже делает Provider Access в `ci.yml`); хуки по `typeof q === "string" ? q : q.text`, а `COMMIT` наш, строковый |
| R6 | `skipLibCheck: true` скрывает ошибки типов во всех зависимостях пакета | Высокая / низкий | Только в одном пакете; `tsc7` чисто с ним (P9) |
| R7 | Provider Access и contained делят materialization | Определённо / высокий для сроков | Решение в разделе 13, выбор 2 |
| R8 | Производительность | Низкая / низкий | ~38 мкс на запрос; холодный импорт измерить на свободной машине, при необходимости грузить лениво в фабрике |
| R9 | Supply chain: 16 MB `drizzle-orm` без runtime-зависимостей; `drizzle-kit` тянет esbuild с нативными бинарниками | Низкая / средний | Kit только в dev; вариант — ручной SQL |
| R10 | `drizzle-kit` молча выбрасывает некорректный extra-config (#6140) | Низкая / средний | Тест каталога: constraint, unique и триггеры существуют |

---

## 12. Исправленная схема, готовая к записи в план

1. **Порты на владельца в application, на языке домена, без `Repository<T>`.**
   - Agent Execution: `OrdinaryOperationStore` с методами `ref + expectedRevision` (prepare, claim) и `ref + attemptId` (append, finish, reconcile); `insertIfAbsent` вместо `accept`.
   - Provider Access: новый `OrdinaryPaGrantStore` вместе с журналом запросов broker; пока жив contained — отдельный `OrdinaryPaMaterializationStores`.
   - Runtime Security: `OrdinarySecurityGrantStore`; владелец (guards, TTL, readback) переезжает в application.
   - `migrate` убирается из портов. Классы ошибок `CommitUnknown` и `Unavailable` — свои у каждого владельца.
2. **Правила в domain.**
   - Чистые `decide*` и фабрики кандидатов (`newOrdinaryOperation`, `newOrdinaryPaGrant`) с явными `now` и `newId`. `now` адаптер читает после захвата блокировки.
   - Адаптер реализует один из трёх шаблонов: вставка-если-нет плюс сравнение; одноразовая вставка; блокировка → решение → запись, с CAS по revision у Agent Execution.
   - Адаптер классифицирует фазу commit и не делает readback. Политика неясного commit — в контракте каждого метода (таблица в разделе 7, пункт 2) и в наборе совместимости.
   - G1: `assertOrdinaryRowIdentity` в декодере строки.
3. **Host получает `storage: OrdinaryRuntimeStorage`.** Структурный тип объявлен в embedded-runtime: `operations`, `providerAccess.{grants, materialization}`, `security`, `close()`. Postgres-пакет даёт `openPostgresStorage({pool, clock?})`: read-only `verify`, пул не закрывает никогда, `pg` как peer.
4. **Миграции — явный шаг `migratePostgresStorage({pool, owners?})`.**
   - На каждого владельца: сессионный advisory lock на одном `PoolClient`, затем Drizzle `migrate` с журналом `<owner_schema>.__migrations`, затем точная сверка `(name, hash)`.
   - Создание Host вызывает только `verify` и падает типизированной ошибкой `ordinary_storage_unavailable` с `reason`. Деградация «только без ordinary» — отдельное решение после Get Modular 0.3.0.
   - Голова журнала проверяется на каждой транзакции внутри существующего `set_config`-запроса.
   - Baseline-миграции с guard «legacy-таблица пуста, иначе `RAISE`».
5. **Проверки совместимости** — в private workspace-пакете (не публикуется), владельцы которого — владельцы портов (раздел 13, выбор 3). Fault injection неясного commit, триггеры, каталог и параллельные миграции живут в тестах Postgres-пакета.
6. **Drizzle `1.0.0-rc.4` точным пином** (`drizzle-orm` в runtime, `drizzle-kit` в dev), с шестью адаптациями: ручная транзакция; обёртка migrator; санитизация ошибок; передача `(config, values)`; `skipLibCheck` только в пакете; `text` для digest-состояний. Без hash-сборок rc.5. GA — отдельный PR с набором совместимости. Выпущенные миграции не перегенерируются.
7. **Пакет `@agent-teams/runtime-store-postgres`** (`private: true` до второго потребителя). Схемы БД `agent_execution`, `provider_access`, `runtime_security`. Сначала Agent Execution и Runtime Security; Provider Access — по выбору 2 из раздела 13. В плане уточнить: «ordinary-модули ядра свободны от Postgres», а пакеты станут свободны после удаления contained.
8. **Порядок.**
   - S1a ‖ S1b ‖ S1c (decide и порты, без Drizzle) → S0 (governance) → S2-core → S2-execution ‖ S2-security ‖ S2-access → S3 (Host после AR-1).
   - Q5 раунда 2 («есть ли реальные строки») закрыть до S2.

---

## 13. Варианты там, где есть реальный выбор

### Выбор 1. Версия Drizzle

| Вариант | 🎯 | 🛡️ | Комментарий |
|---|---|---|---|
| **(a) Recommended: `1.0.0-rc.4` точным пином с шестью адаптациями** (решение владельца) | 8 | 7 | Без перехода формата миграций 0.x → 1.0 (#6020); один пин с оркестратором. Обе главные проблемы (транзакции, migrator) есть и в 0.45.3, адаптации те же |
| (b) `drizzle-orm@0.45.3` / `drizzle-kit@0.31.11` stable, потом GA | 7 | 7 | Соответствует глобальному правилу «только stable», но владелец явно попросил RC. Потом понадобится `drizzle-kit up` с риском no-op перезаписи (#6020) |
| (c) Без ORM: `pg` плюс свой runner миграций | 7 | 8 | Технически самый надёжный для трёх маленьких хранилищ, но противоречит правилу владельца «ORM, а не raw SQL» |

Честно: для этих трёх хранилищ Drizzle сокращает мало кода. Ценность в типизированной схеме и журнале миграций. Если цель — надёжность любой ценой, (c) лучше на один балл.

### Выбор 2. Provider Access в общем пакете

| Вариант | 🎯 | 🛡️ | Комментарий |
|---|---|---|---|
| **(a) Recommended: сначала Agent Execution и Runtime Security; Provider Access после удаления contained** | 8 | 8 | Ни цикла, ни двух владельцев таблиц. Provider Access временно остаётся на текущем raw-SQL, но уже за портом (S1c) |
| (b) Provider Access сейчас: в пакет переезжают только `ordinary_grant` и `ordinary_request`, materialization остаётся в Provider Access за портом `OrdinaryPaMaterializationStores` с владельцем и шагом удаления | 6 | 7 | В `provider_access` два механизма миграций: Drizzle-журнал и реестр `materialization_schema`. Это допустимо, если зафиксированы владелец и дата удаления |
| (c) Перенести в пакет все Postgres-хранилища Provider Access, включая contained | 3 | 5 | Цикл зависимостей или вложение в legacy, который удаляется |

### Выбор 3. Где живут проверки совместимости

| Вариант | 🎯 | 🛡️ | Комментарий |
|---|---|---|---|
| **(a) Recommended: private workspace-пакет `@agent-teams/runtime-storage-conformance`** (три entry, владельцы по CODEOWNERS — команды портов), dev-зависимость Postgres-пакета и тестов владельцев | 7 | 8 | Не трогает отвергающие тесты и production-артефакты. Один пакет на governance, не три |
| (b) `./testing` subpath в каждом владельце через ADR и правку отвергающих тестов | 6 | 7 | Классическая форма, но сознательно отменяет политику «test-support не попадает в packed artifact» (`testing-subpath-packed-consumer.test.ts:129-131`) |
| (c) Набор внутри тестов Postgres-пакета | 8 | 6 | Дёшево, но контракт порта перестаёт принадлежать его владельцу. LSP для второй реализации не гарантирован |

### Выбор 4. Что при несовпадении схемы во время создания Host

| Вариант | 🎯 | 🛡️ | Комментарий |
|---|---|---|---|
| **(a) Recommended: `verify` при создании, типизированная ошибка `ordinary_storage_unavailable` с `reason`** | 8 | 9 | Честно и fail-closed; Get Modular менять не нужно |
| (b) Деградация: Host без ordinary и явный статус | 5 | 7 | Нужен optional-слот (Get Modular 0.3.0, AR-1) и новый API статуса |
| (c) Host сам мигрирует (как сейчас) | 8 | 5 | Runtime-учётке нужны права DDL; противоречит пункту 4 |

### Выбор 5. Схемы БД и изоляция тестов

| Вариант | 🎯 | 🛡️ | Комментарий |
|---|---|---|---|
| **(a) Recommended: схемы владельцев с журналами внутри и отдельная база на тест (`createdb`)** | 7 | 8 | Ясное владение; совпадает с «schema per bounded context» оркестратора. CI уже создаёт базы для Provider Access |
| (b) Таблицы без схемы и журнал в `current_schema()`, сохраняется изоляция через `search_path` | 6 | 6 | Меньше правок тестов, но владельцы делят одну схему, а журнал зависит от сессии |

---

## 14. Находки (severity, уверенность)

| # | Sev | 🎯 | Находка | Где |
|---|---|---|---|---|
| N1 | P1 | 9 | Перенос Provider Access в общий пакет сейчас даёт цикл или двух владельцев таблиц: ordinary-путь делит materialization repository с contained | `ordinary-provider-access-owner.ts:53-57, 132`; `postgres-credential-rendering-owner.ts:33`; `route-selection-owner.ts:41`; `postgres-current-provider-access.ts:14`; `postgres-materialization-authorization.ts:9` |
| N2 | P1 | 10 | `db.transaction()` непригоден: закоммиченная строка плюс неотличимая ошибка, `release()` без discard; в rc.4 утечка при отказе `BEGIN` | `node-postgres/session.js:50-65`; P3; #6114, #6341, #6241 |
| N3 | P1 | 10 | Drizzle-migrator без блокировки, без сверки хешей, отбор по имени | `pg-core/async/session.js:136-171`; `migrator.utils.js:11-15`; P7a, P7c; #874 |
| N4 | P1 | 9 | `DrizzleQueryError.message` содержит параметры: промпты и вывод уйдут в ошибки и журналы | `errors.js:15`; P6 |
| N5 | P1 | 9 | `.d.ts` Drizzle не проходят `skipLibCheck: false` (47 ошибок в rc.4, 73 в 0.45.3; TypeScript 7.0.2 и 5.9.3); в репозитории `skipLibCheck: false` | `tsconfig.json:16`; P9; #5187 |
| N6 | P1 | 8 | «Неясный commit → перечитать → `unknown`» неверно как общее правило: семь семантик | раздел 7, пункт 2 |
| N7 | P2 | 9 | Сейчас миграции в фабриках Host, ordinary-слот `required`. «Отключить только ordinary» — новое поведение | `ordinary-agent-runtime-host.ts:25, 74, 77, 82`; `ordinary-runtime-assembly.ts:40`; `runtime-setup-assembly.ts:134` |
| N8 | P2 | 9 | `./testing` противоречит отвергающему тесту и SDK-growth | `testing-subpath-packed-consumer.test.ts:129, 164, 167-171, 201`; `check-sdk-growth-profile.mjs:157` |
| N9 | P2 | 9 | Изоляция тестов через `search_path` ломается на журнале Drizzle; динамической `pgSchema` нет | P7b; `ordinary-core-postgres.test.ts:12`; `ordinary-security-postgres.test.ts:9`; #1807 |
| N10 | P2 | 9 | Доменная логика в адаптере Agent Execution; у Provider Access нет порта; у Runtime Security адаптер и есть владелец | `ordinary-postgres-store.ts:83-84, 104-105, 108, 115-116, 140-145`; `ordinary-pa-store.ts:125`; `ordinary-pa-broker.ts:17`; `ordinary-security-owner.ts:37-94` |
| N11 | P2 | 9 | Обёртка Agent Execution теряет `values` у объектных запросов — несовместима с Drizzle | `ordinary-postgres-store.ts:29`; P1 |
| N12 | P2 | 8 | Fault-injection хуки сравнивают SQL как строку | `ordinary-pa-postgres.test.ts:111-113`; `ordinary-security-postgres.test.ts:14` |
| N13 | P2 | 8 | Основание RC в ADR-0052 оркестратора — node:sqlite, к agent-runtime не применимо; кода и воспроизводимых spike нет | `cross-dialect-persistence-tooling-2026-07-26.md:39`; `OD-003…md:38-40, 72-73`; `foundation-spike-evidence-manifest-2026-07-26.md:19-22` |
| N14 | P2 | 8 | «Ядро свободно от Postgres» неверно на уровне пакетов, пока жив contained | Agent Execution `package.json` (`pg` в `dependencies`); `source-dependencies.yaml:488-505, 583-586` |
| N15 | P3 | 8 | У Runtime Security нет `lock_timeout`; три разных транзакционных runner с разными таймаутами | `ordinary-security-transactions.ts:39`; `ordinary-postgres-store.ts:59-62`; `ordinary-pa-store.ts:58` |
| N16 | P3 | 7 | `catch {}` в Runtime Security ловит любые ошибки, включая отказ декодера | `ordinary-security-owner.ts:60, 77` |
| N17 | P3 | 6 | `drizzle-kit` молча выбрасывает некорректный extra-config; нужен тест каталога | #6140 |
