# Независимое ревью черновика плана версии 2 (4 октября 2026)

Ревью черновика, который не публиковался. Номера строк «план NNN» и «handoff NNN» относятся к тому черновику, а не к опубликованной версии. Код проверялся на agent-runtime `0ace1cce`. Все находки учтены в версии 2 плана от 8 октября: противоречия 12-15, карточки DOCS-1, ACCESS-AUTH-FILE, ACCESS-REFRESH-GUARD, EF-SURFACE, STANDARD-1a…1d, FEATURE-STANDARD-2, CONTAINED-FREEZE, CI-CONTRACT-1, EF-README и ISSUE-189-SYNC.

## Вердикт

**В нынешнем виде план подавать нельзя, нужны правки.** Основной анализ заморозки CI-контракта верен и проверен на `0ace1cce`. Расчёты бюджетов сходятся. Факты о PR и коммитах (#191–#194, #199, #200 = `0ace1cce`, #328 = `5a66a8eb`, `399ffc22`: 31 файл, +408/−120) и данные npm точны: Core и Assembly только 0.2.0, resources и conformance не опубликованы, Drizzle `rc` = `1.0.0-rc.4`, `rc5` = только hash-сборка.

При этом нашлось 6 проблем уровня P1. Четыре из них сидят в «ready»-карточках волны 2: ACCESS-AUTH-FILE, DOCS-1, STANDARD-1c и STANDARD-1d. Ещё одна касается ложной посылки о безопасности на пути секрета. Решения 1–42 в целом переданы верно. Отклонения:
- решение 13 переоткрыто как вопрос с рекомендацией против формулировки «сразу»;
- в решении 39 добавлено «no global singletons»;
- у решений 19 и 23 нет карточек;
- фактическая посылка решения 36 неполна (подробнее в находке 3).

Все находки ниже я сам прочитал в коде на `0ace1cce` или в upstream (VERIFIED), если не помечено ASSUMPTION.

---

## P1

**1. ACCESS-AUTH-FILE противоречит принятому ADR-0090, а запись-преемник в плане отсутствует.** Уверенность 9.
- VERIFIED, `docs/decisions/0090-ordinary-user-session-codex-execution-profile.md:106-111`: «it neither copies source credentials nor reads the parent token directly … Only the bounded protocol sequence `initialize`, `config/read`, `account/read`, `getAuthStatus`, `account/rateLimits/read`, and `model/list` … is admitted».
- Правило Engineering Quality Standard (`.github` `docs/engineering-quality-standard.md:102-103`): «Accepted decisions and pinned standards still change through their successor process».
- В плане (стр. 402) и в handoff зависимость указана так: «Depends on: nothing». DOCS-1 закрывает только строку 91 ADR-0090.
- **Правка (plan, DOCS-1 Goal, добавить):** «(c) a successor record to ADR-0090 section "Provider Access and Runtime Security" (lines 104-111): under decision 36 Provider Access reads `tokens.access_token` from the custodied source `auth.json`; the admitted helper sequence becomes `initialize`, `config/read`, `account/read`, `account/rateLimits/read`, `model/list`.» Бюджет DOCS-1: «120-280».
- **ACCESS-AUTH-FILE Depends on:** заменить на «DOCS-1 part (c). Ordering with resources AR-2 (same package) by the integrator.»
- Те же правки внести в handoff §3, строка 1, и в §9 DOCS-1.

**2. Правила строгого парсера `auth.json` неверны: настоящий ChatGPT-логин будет отвергаться.** Уверенность 8.
- План, стр. 396: «refuse `OPENAI_API_KEY`, `agent_identity`, `personal_access_token`, `bedrock_api_key` when present». Handoff, стр. 122 — то же самое.
- VERIFIED, upstream `rust-v0.153.4` (и 0.159.3): `codex-rs/login/src/server.rs:428` «Obtain API key via token-exchange and persist», `:911-912` `auth_mode: Some(AuthMode::Chatgpt), openai_api_key: api_key`. Поле `OPENAI_API_KEY` всегда сериализуется: `storage.rs:45-46`, у него нет `skip_serializing_if`. Режим определяет явный `auth_mode` (`manager.rs:1754` `resolved_mode`).
- Значит, после обычного браузерного ChatGPT-логина ключ, как правило, не `null`. Синтетические фикстуры этого не поймают.
- Кроме того, в `AuthDotJson` есть `bedrock_access_keys` (`storage.rs:64`). Его нет ни в противоречии 8, ни в handoff, стр. 116.
- **Правка (plan 396 и handoff 122):** «require `auth_mode` equal to `"chatgpt"`; `OPENAI_API_KEY` is always serialized and after a ChatGPT browser login usually holds the token-exchanged key (`codex-rs/login/src/server.rs` `persist_tokens_async`), so accept `null` or a string and never read, copy or compare it; refuse a non-null `agent_identity`, `personal_access_token`, `bedrock_api_key` or `bedrock_access_keys`; refuse a missing `last_refresh`».
- **Acceptance добавить:** «ChatGPT file with a non-null `OPENAI_API_KEY` accepted; `bedrock_access_keys` refused; missing `auth_mode` refused».
- В handoff 116 и plan 115 дописать `bedrock_access_keys`.

**3. Посылка «автообновление не используется» ложна, и это касается данных.** Уверенность 7.
- Журнал решений, 95: «`getAuthStatus` вызывается с `refreshToken: false`, то есть автообновление не используется». План, стр. 601: «with `refreshToken: false` today the behavior matches».
- VERIFIED в `rust-v0.153.4`:
  - при `refreshToken: false` `getAuthStatus` вызывает `self.auth_manager.auth().await` (`account_processor.rs:1059`);
  - `account/rateLimits/read` делает то же самое (`:1134`);
  - `auth()` проактивно обновляет токен, если access token истекает в пределах 5 минут (`manager.rs:189`, `:2345-2358`, `:2924-2946`).
- Повторное использование refresh token классифицируется как исчерпание (`manager.rs:1644` `refresh_token_reused` → `Exhausted`).
- Запись в источник запрещена профилем sandbox (`ordinary-codex-auth-files.ts:89` `(deny file-write* (subpath …))`).
- ASSUMPTION: в результате refresh может израсходовать одноразовый refresh token, а запись в custodied-файл при этом не пройдёт. Риск существует уже сегодня, и ACCESS-AUTH-FILE его не убирает: `rateLimits/read` остаётся.
- **Правка (plan 601):** заменить на «`refreshToken: false` does not disable refresh: `AuthManager::auth()` (used by `getAuthStatus` without refresh and by `account/rateLimits/read`) refreshes proactively when the access token expires within 5 minutes (`codex-rs/login/src/auth/manager.rs` `should_refresh_proactively`). The helper cannot persist into the write-denied source, so such a refresh can spend the custodied refresh token. This exists today; ACCESS-AUTH-FILE does not remove it.»
- Добавить в §2.3 пункт 12 (поправка факта к решению 36) и вопрос **Q-AUTH-REFRESH-WINDOW**:
  - (a) Recommended: до запуска helper отказывать, если `exp` отсутствует или наступает раньше чем через 5 минут плюс 15 секунд;
  - (b) оставить как есть и задокументировать риск.

**4. DOCS-1 запрещает правки, без которых карточку не выполнить.** Уверенность 8.
- План 348: «`docs/README.md`, `docs/decisions/README.md` and `docs/architecture/README.md` are byte-frozen». Handoff, gotcha 7 и стр. 108 — то же.
- VERIFIED: `scripts/docs/verify-frozen-document-bytes.mjs:18-21` замораживает только `docs/decisions/000[1-5]-*.md`, `docs/spikes/*-results.md` и `docs/spikes/runtime-profile-behavior.md`. PR #192 сам менял `docs/architecture/README.md`.
- Капабилити Engineering Foundation `governance-architecture-decisions` требует запись в индексе `docs/decisions/README.md` (разделы Accepted и т.д.) и в `architecture/decisions/accepted-decisions.json` (`architecture/foundation/governance-architecture-decisions.yaml`).
- Профиль Feature Module Standard разрешает `acceptedAdr` только через этот реестр (`scripts/architecture/feature-module-profile.mjs:147, 164`).
- **Правка (plan 348):** «**Registration:** add each accepted record to the `Accepted` section of `docs/decisions/README.md` and to `architecture/decisions/accepted-decisions.json` with its immutable digest; the Feature Module Standard profile resolves `acceptedAdr` only through that registry. Index files are not byte-frozen (`verify-frozen-document-bytes.mjs:18-21` freezes ADR 0001-0005 and two spike patterns).» Соответственно исправить handoff 77 и 108.

**5. STANDARD-1c (и частично EF-SURFACE) упираются в инвариант Engineering Foundation о выносе кода.** Уверенность 7.
- VERIFIED, Engineering Foundation `AGENTS.md`, `docs/architecture/executable-capabilities.md:82-86`: «A consumer-owned implementation moves into Foundation only after two real consumers … must also delete the superseded consumer implementations».
- План 363: «Reuse the ideas of agent-runtime `scripts/architecture/qualify-sdk-packages.mjs:30-67`…». Здесь один потребитель, а удаление кода противоречит решению 6.
- **Правка (plan 354/363, handoff 147/164):** «These are new Foundation-owned mechanisms decided by the owner (decisions 24, 39, 42), not extractions: write them fresh against the Engineering Foundation capability model and cite the decisions in the pull request; do not copy agent-runtime code. agent-runtime checks stay and are disabled with comment in GOV-1 (decision 6). If the Engineering Foundation reviewer applies the extraction admission invariant, stop and ask.»

**6. STANDARD-1d не выполняет предусловие решения 7.** Уверенность 7.
- VERIFIED: Engineering Foundation `public-api-compatibility/application/rules.ts:47` требует «Approve the reported fingerprint in an ADR-backed breaking-change entry». Решение 7 требует заменить «ADR на каждый break» на changeset с migration note.
- Карточка (plan 364) добавляет отдельную проверку и не говорит, как обнаружить break.
- **Правка (plan 364):** «STANDARD-1d, Engineering Foundation: in `public-api-compatibility`, allow an approved breaking change of a 0.x package to be backed by a changeset with "Breaking" and "Migration" paragraphs instead of an accepted ADR; the API fingerprint stays the break signal; check that the changeset bumps minor. Budget 250-500.»

---

## P2

**7. В CONTAINED-FREEZE не указаны известные пины.** Уверенность 8.
- `packages/contexts/agent-execution/tests/package/postgres-qualification-command.test.ts:458`: `assert.match(manifest.scripts.test ?? "", /tests\/features\/contained-agent-turn\/\*\.test\.ts/u)`. Если заменить glob явным списком, тест сломается.
- `scripts/architecture/ar2-test-execution-inventory.mjs:24-25` (запускается в `check` через `test:ar2-contract`): для пакетов, кроме embedded-runtime, допускается только литерал `node --test … tests/….test.(ts|mjs)`. Скрипт-лаунчер с комментариями упадёт.
- В embedded-runtime список уже явный (`scripts/run-package-tests.mjs`), поэтому формулировка «switch from globs» к нему неприменима.
- **Добавить в plan 334 и handoff 137:** «Known pins: update the glob assertion at `postgres-qualification-command.test.ts:458` (keep the fail-closed wrapper asserts); keep the list as a literal `node --test` command in `package.json` (`ar2-test-execution-inventory.mjs:24-25`) and keep the `test:ar2-contract` coverage files; in embedded-runtime only remove contained entries from `testProcesses`.»

**8. VERSION-1 правит исходники embedded-runtime до AR-1.** Уверенность 7.
- План 471 трогает `runtime-access.ts:233` и `composition/contained-turn-runtime-validation.ts:199, 257`. Это противоречит плану 554 («Until AR-1, no card touches embedded-runtime source») и handoff 37 (`src/**/composition/**`).
- При этом в индексе полос (стр. 252) единственный блокер — STORE-1a.
- **Правка (plan 252):** «STORE-1a; AR-1 for the embedded-runtime literal, or a coordinator exemption for these two files after checking the AR-1 diff».

**9. STORE-1a, вероятно, можно выполнить без CI-CONTRACT-1.** Уверенность 6.
- VERIFIED: корень `…/contained-agent-turn/domain` директорный (`source-dependencies.yaml:41-45`). Импорт через границу должен попадать в entrypoint (Engineering Foundation `evaluate-resolved-source-dependency.ts:161-168`). Адаптер уже импортирует entrypoint `ordinary-validation.js` (`ordinary-postgres-store.ts:12`).
- ASSUMPTION: другие гейты не возразят; это нужно проверить пробным прогоном.
- **Правка (plan 409):** «Status: ready if `domain/ordinary-decisions.ts` stays inside the directory root and the adapter reaches it only through an existing entrypoint; confirm with a `pnpm check:fast` dry run; otherwise blocked by CI-CONTRACT-1.»

**10. Окружение в handoff описано не полностью.** Уверенность 8.
- На машине ревьюера `node` по умолчанию тоже вне диапазона `engines`.
- `test:ci` читает Git-историю (`conformance.ts:152-177`), поэтому shallow clone падает.
- **Правка (handoff 56-57):** «Clone with full history (no `--depth`): `test:ci` reads `df9260b0` and `ccf6d6f8`. The default `node` on PATH may be outside `engines`; prefix every command with the Node 24.21.0 bin directory on `PATH` (shell state does not persist).»
- Добавить, что у Engineering Foundation и у тестового репозитория `pnpm@11.20.0`.

**11. Merge FEATURE-STANDARD-2 означает публикацию неизменяемого стандарта.** Уверенность 6.
- Реестр допускает только `status: "published"` и требует шесть маркеров (`.github` `tools/feature-module-standard/check.mjs:60, 79-88`). ADR-0004 делает версию неизменяемой.
- «Delta form» — это не решение владельца. agent-runtime пинит ровно один артефакт (`candidate-profile.json` `authority`).
- **Правка (plan 368):** «text drafting ready; merge waits for Q-CONSUMER-STANDARD-REF; write v2 as a complete document with the six required markers (form needs coordinator confirmation)».

**12. Решение 13 подано как расписание.** Уверенность 6.
- План 197 пишет «after ACCESS-LIB», а решение 13 говорит «сразу».
- **Правка:** «not decided (Q-PUBLISH-TIMING); decision 13 reads "right away"». В Q-PUBLISH-TIMING отметить: (b) — буквальное прочтение решения 13, а (a) его откладывает.

**13. Forward-проверка в CI-CONTRACT-1 конфликтует с решением 6.** Уверенность 7.
- План 320: «every baseline leaf command is still present». Решение 6 разрешает выключать гейт удалением из `check`.
- **Правка:** «…still present or listed in a committed disabled-gates record with why, when to return, owner and review date (decision 6)».

**14. EF-SURFACE.** Уверенность 6.
- В плане 356 собственные пакеты Engineering Foundation названы «real consumer». Engineering Quality Standard (`:76-79`) требует реального потребителя в той же поставке. Реальный потребитель — agent-runtime, а его принятие (GOV-1) заблокировано.
- Ключ `agentTeamsArchitecture` жёстко зашит в «нейтральную» капабилити.
- Не определено, как карточка соотносится с существующей `public-api-compatibility`.
- **Правка:** «validate on modularity-host-TEST and on a draft agent-runtime branch through Engineering Foundation local mode before the release; tiers from a configurable `package.json` key (agent-runtime preset: `agentTeamsArchitecture`); state the boundary with `public-api-compatibility` (names and kinds only, no build)».

**15. Секреты оказываются в памяти Provider Access.** Уверенность 6.
- Сегодня Provider Access не читает содержимое `auth.json`. `parseAuthFrame` (`ordinary-codex-auth-json.ts:8`) декодирует весь текст в строки JS, а их нельзя обнулить. После изменения в процесс попадут `refresh_token`, `id_token` и ключ API.
- **Правка (инвариант ACCESS-AUTH-FILE):** «parse with a bounded byte scanner that copies only `tokens.access_token` into a Buffer; other members are validated without decoding; stop and ask if not feasible».

---

## P3 (сводно)

- План 114: фраза «It already hosts the resources train TEST-1 suite» неверна. В `modularity-host-test` есть только стенд допуска и жизненного цикла для Core и Assembly; TEST-1 ещё не сделан, о чём говорит и сам §6.3.
- Codex `rust-v0.160.0` вышел 2026-10-01 20:19 UTC, это последний stable. По сравнению с 0.159.3 добавлены только две фичи, выключенные по умолчанию. По решению 3 цель BUMP-2 стоит подтвердить у владельца.
- Устаревшие ссылки и формулировки:
  - план 298: `check:fast` теперь тоже запускает `pnpm docs:qualification`;
  - план 108: литерал находится на `conformance.ts:146`, а не на `:145`;
  - GOV-1 должен ссылаться и на `check-sdk-growth-profile.mjs:155` (пин 1.6.0 из решения 7);
  - handoff 84 («nothing else on GitHub is») противоречит handoff 90 (`gh pr ready`).
- Нет карточек под решение 19 (README Engineering Foundation) и решение 23 (тело issue #189 не синхронизировано).
- STANDARD-1a повторяет правило о 0.x, которое уже есть в Engineering Quality Standard (`:90-96`), и добавляет «no global singletons», которого нет в решении 39.
- В ruleset включено `required_review_thread_resolution: true`, а в gotchas об этом не сказано.
