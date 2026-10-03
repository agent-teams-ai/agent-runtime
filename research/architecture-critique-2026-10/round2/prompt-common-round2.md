# Раунд 2: общий контракт для четырёх критиков (2026-10-01, вечер)

Ты независимый архитектурный критик второго раунда, по явному выбору владельца. Работа: только исследование, анализ и отчёт. Код не меняется.

## Что изменилось после раунда 1 (главное, читать внимательно)

После первого раунда владелец уточнил основу оценки. Эти уточнения имеют приоритет над конфликтующими формулировками handoff и отчётов раунда 1.

**U1. Заморозка SDK-growth заменяема.** `scripts/architecture/check-sdk-growth-profile.mjs` запускается в `pnpm check` и `check:fast`. Координатор проверил: он замораживает набор из 6 пакетов, их имена и roots, `private: true`, `version: "0.0.0"`, `bin`, `files`, точный JSON `exports` и entrypoints `[".", "./composition"]`, версию EF 1.6.0, хэши исторических evidence-файлов, а также проверяет CMS pin chain. Сигнатуры функций внутри существующих entrypoints он **не** проверяет: активного v1 API-гейта в AR нет. Владелец: «мы на ранней стадии, часто меняемся», правило слишком строгое и может быть заменено. Решение 2026-09-25 (S3/v3 authority не строим) остаётся в силе.

**U2. Library-first.** Org EQS PR agent-teams-ai/.github#328 (OPEN, не merged; diff сохранён в `OUT/eqs-pr328.diff`) и глобальное правило владельца. Цитаты из PR:
- «Design a concern that is expected to serve several projects as a universal, well-structured library from the start, with one owner and one contract.»
- «Extracting consumer-local code into a library later and migrating every copy costs more than adapting consumers to a deliberate change.»
- «Validate it with disposable test projects and at least one real consumer in the same delivery; that consumer proves the contract and is not an incubator for it.»
- «Breaking changes are allowed in every organization repository when they deliberately improve the system. No repository has a compatibility commitment during the MVP stage.»
- «Packages still on 0.x stay on 0.x … ship a breaking change as a minor release … Every breaking release has a changelog entry and a migration guide»
- «This direction does not relax minimalism, security or data safety. A library carries only mechanism with a concrete need, product policy stays with its owner, and speculative features, universal managers and service bags remain out. Persisted user data, durable recovery state and in-flight work still need a safe migration.»

Слова владельца: «Надо выносить в либы то, что скорее всего переиспользуется, чтобы потом не рефакторить, а breaking changes - это ок». **Не используй FMS-правило «one adapter / hypothetical future consumer» (`dotgithub/docs/architecture/feature-module-standard/v1.md:147-149, 468-469`) как блокер для компонентов, которые с высокой вероятностью будут переиспользованы.** Но честно отметь конфликт: PR #328 оставляет FMS без изменений («Published architecture standards, adoption pins and ADRs are unchanged»). Предложи, как его снять: successor к FMS, интерпретация или что-то иное.

**U3. Codex: в идеале всегда самая свежая версия.** Сейчас exact pin `0.153.4` прописан в 22 production-файлах AE/PA/RS/embedded (13 ordinary) и включает SHA бинаря, exact-key валидаторы одной ревизии и литерал в публичном типе `runtime-access.ts:233`. Latest Codex на 2026-10-01 — `rust-v0.159.3` (30.09). Архитектура должна считать эволюцию версии Codex первоклассной задачей. Не предлагай реализацию, но спроектируй границы так, чтобы обновление версии было дешёвым и безопасным.

**U4. Владелец любит строгую декомпозицию на модули и библиотеки, строгие SOLID / Clean Architecture / DRY.** Модульность — цель, а не побочный эффект. Каждая граница всё равно должна иметь конкретную механику, owner и контракт. Без universal managers, service bags и speculative features (EQS #328).

**U5. Параллельная программа ресурсов.** Владелец принял дизайн `@get-modular/resources` (scope tree, «кто создал, тот и закрывает», LIFO, single-flight close, continue-on-failure с отчётом о долге, `child()` для вложенности). Решил сразу публиковать его в npm (0.1.0), первым реальным потребителем назначен AR ordinary host и Darwin deployment. Документ: `<workspace>/plans/module-resource-scopes-design-2026-10-01.md` (прочитай разделы 1-2, 13-14). Учитывай как соседнюю зависимость: та же зона Host/cleanup, обновление CMS pin.

Прежние ограничения остаются: без новых продуктовых фич (streaming, новые providers/ОС/transports, resume, remote, marketplace, Claude rewrite, contained-turn Assembly); ordinary — единственный активный путь; сначала Codex; сохранять полезный код (authority, idempotency, cleanup, parsers, validation, meaningful tests); безопасность, authority и durable data не ослаблять; учиться у OpenClaw по фактам.

## Обязательное чтение

1. Этот контракт.
2. Handoff раунда 1 целиком: `handoff.md` (§6 про hosted workers не относится).
3. Сводка раунда 1: `round1/critique-synthesis.md` и четыре полных отчёта рядом (`*-report.md`). Это evidence, а не решение: проверяй по коду и пересматривай выводы, которые опирались на single-consumer FMS, заморозку гейта или exact pin Codex.
4. Workspace `<workspace>/AGENTS.md`, repo `AGENTS.md`/`CLAUDE.md` agent-runtime, `$SRC/dotgithub/docs/engineering-quality-standard.md` плюс diff PR #328.

## Исходники (exact SHA; координатор перепроверил current main в 2026-10-01 ~20:30 — без изменений)

`SRC=<scratch>/src`

- `$SRC/agent-runtime` @ `b0bcb265d1466da3272078f9dfdb7c6784624283` = current main.
- `$SRC/get-modular` @ `9c722ceff4ede307d06d7a4b63fdebe615f54c53` = current main = consumer pin (`@get-modular/resources` ещё не в main).
- `$SRC/dotgithub` @ `3fe0f135ffc446b3bb174397c6b5783f72a008a2` = current main (PR #328 не merged).
- `$SRC/engineering-foundation` @ `b8ec0f17d1b8d6f9b7a45798931715d59a126888` = current main.
- `$SRC/openclaw` @ `510beb8d52bd6be9fea27513b9008a50c92a1d2d` (upstream main ушёл на `c0c8fc9a`; можешь сверить дельту через `gh`, указывая SHA).

Snapshots общие и read-only: не запускай в них checkout/fetch/reset и ничего не пиши. Нужна другая ревизия или чужой репозиторий (например `openai/codex`) — клонируй в `$SCRATCH/r2-<role>/`, где `SCRATCH=<scratch>`. Оригинальные checkouts пользователя не трогать.

## Внешние источники

GitHub только через `gh`. Официальную документацию и npm registry можно получать read-only через `curl` и `npm view`. Веб-поиска нет. Перечисли реально полученные внешние источники (URL + SHA/версия/дата). Не утверждай, что провёл online research, если не провёл.

## Жёсткие запреты

Никакой реализации и правок исходников, manifests, CI, SQL, pins, ADR; никаких install/build/test/typecheck, запуска агентов/providers/Codex-бинаря, коммитов, PR, комментариев на GitHub. Единственный создаваемый файл — свой отчёт (Bash heredoc с quoted terminator; большой отчёт можно писать частями через `>>`).

## Требования к результату

- Отдели цели владельца (включая U1-U5), прошлые гипотезы, текущие факты с `file:line` и короткой цитатой, свой новый выбор. VERIFIED и ASSUMPTION.
- Предложи СВОЁ решение. Раунд 1 рекомендовал «швы на месте → пакет процесса с PA → Codex-пакет по условию»; пересмотри это с учётом U1-U4. Не соглашайся по инерции.
- Различай: внутренний порт / поддерживаемый внешний SPI / самостоятельная библиотека / security-authority boundary / единица публикации.
- 3 сильных варианта, рекомендованный первым и помечен (Recommended). Для каждого: схема зависимостей и resource owners, 🎯 уверенность / 🛡️ надёжность / 🧠 сложность по 10, changed LOC (add+del включая tests/docs/gates) и moves отдельно, LOC confidence /10. Опирайся на реальные размеры файлов (`wc -l`) и на сметы раунда 1, явно показывая, что и почему меняется.
- Для каждого пакета: почему самостоятельный (вероятное переиспользование: кем и где), owner, что API обещает и чего не обещает, dependencies, как контракт будет эволюционировать (0.x, breaking → minor + migration guide).
- SOLID / Clean / DDD / DRY / CMS / FMS по существу, со ссылками на код и стандарты.
- OpenClaw только по фактам (`file:line@SHA`, номера issue/PR).
- Сильнейший контраргумент к своему выбору и evidence, которое изменило бы рекомендацию.
- Порядок bounded dependency-safe PR (около 2000 changed LOC каждый максимум), parallel lanes, единственный integrator, риски. Это предложение, не разрешение.
- Отдельно: риски безопасности и durable data (переход v3 → v1, in-flight операции, cleanup obligations), конфликт EQS #328 с FMS, scope exclusions.
- Не выдавай чтение исходников за production qualification. Лучше немного сильных находок, чем много слабых.

## Вывод

1. Полный отчёт на русском (идентификаторы, пути, цитаты — в оригинале) в `OUT/<role>-report.md`, где `OUT=round2`. В шапке: роль, SHA snapshots, реально полученные внешние источники, дата.
2. Финальным сообщением верни сжатое резюме (до ~1500 слов): рекомендация и почему; 3 варианта с оценками и LOC+moves; что изменилось относительно раунда 1 и почему; strongest counterargument; что изменит рекомендацию; топ рисков; путь к отчёту.
