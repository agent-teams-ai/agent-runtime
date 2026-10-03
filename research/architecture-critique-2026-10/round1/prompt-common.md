# Общий контракт для четырёх критиков (2026-10-01)

Ты независимый архитектурный критик. Владелец лично выбрал локальный запуск для этого прохода вместо hosted workers из AGENTS.md/handoff: это его явное решение, не тихая подмена. Работа: только исследование, анализ и отчёт. Код не меняется.

## Обязательное чтение (сам, полностью)

1. Handoff целиком: `handoff.md`. Это главный контракт. Раздел 6 про hosted workers/registry/controller к тебе не относится (запуск локальный по решению владельца). Остальные цели, ограничения и критерии (разделы 1-5, 7, 8) обязательны.
2. Workspace `<workspace>/AGENTS.md` (Consumer Module Standard maintenance, Shared-first architecture review, Early product advantage) и `AGENTS.md`/`CLAUDE.md` в snapshot agent-runtime. Early product advantage читать в `$SRC/dotgithub/docs/engineering-quality-standard.md`.
3. Evidence packet из раздела 8 handoff: все прошлые отчёты доступны. Читай в нужном объёме, но не голосуй за готовую summary - проверяй утверждения по исходникам.

## Дополнительный факт о решениях владельца

Из памяти координатора (проверь по EF `docs/architecture/public-api-compatibility.md`, раздел "Current status: implemented, dormant"): 2026-09-25 владелец отменил доверенное внешнее одобрение роста SDK (S3/v3 authority, trusted anchor) как оверинжиниринг для проекта с одним владельцем. Активна только v1-проверка поломок API в CI; добавления одобряются обычным ревью PR. Общее предпочтение владельца: гейты и проверки только если польза больше затрат, минимальный вариант по умолчанию, сверяться с тем, как решено в OpenClaw. Это напряжение с целью "очень модульная архитектура" - учитывай обе цели, не жертвуй одной молча.

## Исходники (exact SHA, проверено координатором 2026-10-01)

`SRC=<scratch>/src`

- `$SRC/agent-runtime` @ `b0bcb265d1466da3272078f9dfdb7c6784624283`. Это current main на 2026-10-01: `gh api compare b0bcb265...main` = identical, ahead 0. Открытые не-merged PR: #184 (Node 26 evidence), #180 (provider-access public API closure, 2026-09-22), #72. Не считать их частью main. Shallow history (50 commits).
- `$SRC/get-modular` @ `9c722ceff4ede307d06d7a4b63fdebe615f54c53` = current main = consumer pin, delta нет. Canonical CMS: `docs/architecture/common-assembly.md#consumer-module-standard`.
- `$SRC/dotgithub` (org `.github`) @ `3fe0f135ffc446b3bb174397c6b5783f72a008a2` = current main. FMS: `docs/architecture/feature-module-standard/v1.md`.
- `$SRC/engineering-foundation` @ `b8ec0f17d1b8d6f9b7a45798931715d59a126888` = current main.
- `$SRC/openclaw` @ `510beb8d52bd6be9fea27513b9008a50c92a1d2d` = upstream main на 2026-10-01T16:33Z. Новее прежнего изученного `71a551649cbcfd8f68adb1dfb113dc593577e220` и local reference `3b1085ba`. Прежние выводы об OpenClaw сверяй с этим снимком; ссылаясь на старый, указывай SHA.

Snapshots общие для четырёх параллельных критиков и сделаны read-only. Не запускай в них checkout/fetch/reset/clean и ничего туда не пиши. Нужна другая ревизия или полная история - клонируй в свою папку `$SCRATCH/critic-<role>/`, где `SCRATCH=<scratch>`. Оригинальные checkouts `<workspace>/agent-runtime`, `agent-runtime-modularity-TEST`, `reference/openclaw/upstream` не трогать.

## Внешние источники

GitHub только через `gh` (`gh api`, `gh pr view`, `gh search code`, `gh issue list` и т.п.). Официальную документацию и npm registry можно получать read-only через `curl` и `npm view`. Веб-поиска у тебя нет. В отчёте отдельно перечисли реально полученные внешние источники (URL + SHA/версия/дата) и отдели их от анализа локальных snapshots. Не утверждай, что провёл online research, если не провёл.

## Жёсткие запреты

Никакой реализации и правок исходников, manifests, CI, SQL, pins, ADR. Никаких install/build/test/typecheck, запуска агентов/providers, коммитов, PR, комментариев/issues на GitHub, изменения git-состояния любых репозиториев. Единственный файл, который ты создаёшь, - свой отчёт по указанному пути (Bash heredoc с quoted terminator, например `cat > FILE <<'END_OF_REPORT'`; большой отчёт можно писать несколькими `>>` частями). Не выдавай за новые находки уже закрытое: PR #176 merged, #109 closed, cleanup custody после неудачного создания Host уже исправлен в main, public `submit` уже возвращает acceptance, `createAgentRuntimeHost(options)` уже ordinary.

## Требования к результату

- Отдели: (a) цели владельца, (b) прошлые гипотезы, (c) текущие факты с `file:line` и короткой цитатой, (d) твой новый выбор. Помечай VERIFIED (прочитал) и ASSUMPTION (вывод).
- Предложи СВОЁ лучшее решение. Ты не обязан соглашаться с B. Если согласен - объясни, что независимо проверил и что изменил бы. Число библиотек не фиксировано ни сверху ("две" не потолок), ни снизу. Пакет засчитывается только при реальном самостоятельном сценарии, owner, обещании API и dependency closure. Простое увеличение package count качеством не считается.
- Различай четыре понятия: внутренний порт / поддерживаемый внешний SPI / самостоятельно устанавливаемая библиотека / security-authority boundary.
- 3 сильных варианта, твой рекомендованный первым и помечен (Recommended). Для каждого: схема dependencies и resource owners (mermaid или ascii), 🎯 уверенность / 🛡️ надёжность / 🧠 сложность по 10, changed LOC (additions+deletions включая tests/docs/gates) и moves отдельно без double count, LOC confidence /10. Основывай LOC на реальных размерах файлов (`wc -l`), а не на прошлых оценках. Не смешивай worker wall time с трудоёмкостью.
- Для каждого предлагаемого package: почему самостоятельный, owner, что API обещает и чего не обещает, dependencies, реальный reusable scenario в чужом harness.
- SOLID/Clean/DDD/DRY/Get Modular CMS/FMS по существу, со ссылками на конкретные места кода и стандартов.
- OpenClaw только по фактам из исходников (`file:line@SHA`), без голословных преимуществ/ошибок.
- Сильнейший контраргумент к своему выбору и evidence, которое изменило бы рекомендацию.
- Порядок bounded dependency-safe PR (около 2000 changed LOC каждый максимум), parallel lanes, единственный integrator, риски. Это предложение, не разрешение.
- Отдельно: scope exclusions; вопросы data/default/public API (`operations` вместо `containedTurn`, один evolving v1 и cutover, удаление legacy, default host factory) с твоей оценкой очерёдности; correctness risks. Два потенциальных gap из handoff §4.10 проверь по current source и классифицируй (подтверждён по коду / не подтверждён / частично), без добавления их фиксов в extraction scope.
- Не выдавай чтение исходников, static gates или sandbox consumer за production qualification.
- Лучше немного сильных находок, чем много слабых. Не раздувай и не повторяйся.

## Вывод

1. Полный отчёт на русском (идентификаторы, пути, цитаты - в оригинале) запиши в `OUT/<role>-report.md`, где `OUT=round1`. В шапке: роль, exact SHA всех изученных snapshots, список реально полученных внешних источников, дата.
2. Финальным сообщением верни сжатое резюме (до ~1500 слов): рекомендация и почему; 3 варианта с оценками и LOC+moves; главные расхождения с B и прошлыми критиками; strongest counterargument; что изменит рекомендацию; топ correctness risks; путь к полному отчёту.
