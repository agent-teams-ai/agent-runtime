# Architecture critique archive, October 2026

This directory archives the analysis behind the Agent Runtime architecture program plan: two critique rounds and one storage verification, produced on 2026-10-01 and 2026-10-02, and the independent review of the version 2 draft (2026-10-04). The material is analysis only. It changes no code and it is written in Russian (identifiers, paths and quotations are kept in their original form).

The plan in [`docs/architecture/agent-runtime-architecture-program-plan.md`](../../docs/architecture/agent-runtime-architecture-program-plan.md) is the current authority. The archive is evidence for it, not a set of decisions. The owner decisions log is [`round2/decisions-log-2026-10-02.md`](round2/decisions-log-2026-10-02.md).

## Contents

- `handoff.md`: the brief given to the critics.
- `round1/`: first critique round (four critic reports, the synthesis, the shared prompt, the launch receipt and input checksums).
- `round2/`: second critique round (four critic reports, the synthesis, the 2026-10-02 update, the decisions log, the shared prompt and the launch receipt).
- `storage-verification/`: storage verification report.
- `plan-reviews/`: independent review of the unpublished version 2 draft of the plan (2026-10-04); its findings are folded into version 2 (2026-10-08).

## Source revisions

| Repository | Revision |
| --- | --- |
| agent-runtime | `b0bcb265` |
| get-modular | `9c722cef` |
| `.github` | `3fe0f135` |
| Engineering Foundation | `b8ec0f17` |
| OpenClaw | `510beb8d` |

## Redaction log

The files were copied from local working notes and redacted before publication. Everything else is verbatim. Rules:

1. Absolute local paths: the workspace root became `<workspace>/`; local notes paths became the archive-relative file name when the file is in this archive and `<local-notes>/...` otherwise; scratch directories became `<scratch>/...`; the private local checkout became `<private-repo>`; its branch and commit were removed, and the cited file, identical in the public `777genius/ar` at `7086f891`, is cited there instead; any other home path became `<local>/...`; the workspace id segment became `<workspace-id>`.
2. Email addresses became `<owner-email>`.
3. Names of models and assistant tooling that describe who wrote the critique or how it was run were replaced with neutral wording (`independent critic`, `hosted workers`). Technical product and provider names used in the analysis (Claude Agent SDK, Claude CLI, Claude Code as an agent-runtime provider, Codex, OpenAI, and the Codex model name quoted from release notes) were kept. Local notes directory and file names that named a model were shortened (`hosted-critique-20260930`, `pr176-review.md`).
4. Owner review tooling names would be replaced with `automated reviewer`. None needed replacing: the remaining mentions are public repository names used as code-reuse evidence (`review-router-ai`) and identifiers quoted from files that are already public in this repository (`reviewrouter:sdk-growth-authority:3` and a workflow name).
5. Host names, worker state paths and controller or job names became `<worker-host>`, `<worker-state>/...`, `<controller>` and `<job>`.
6. Two paragraphs of `handoff.md` section 6 about the internal worker infrastructure were removed and replaced with a bracketed note.

Replacements per file (rule 4 has no replacements; the last column counts other publication edits made after the rules, such as renamed note directories, the rule 6 removal, the web search wording and list reformatting):

| File | Rule 1 paths | Rule 2 emails | Rule 3 authors | Rule 5 hosts | Other edits |
| --- | --- | --- | --- | --- | --- |
| `handoff.md` | 13 | 1 | 2 | 3 | 10 |
| `round1/core-lifecycle-report.md` | 0 | 0 | 2 | 0 | 0 |
| `round1/critique-synthesis.md` | 0 | 0 | 6 | 0 | 2 |
| `round1/input-sha256.txt` | 1 | 0 | 0 | 0 | 12 |
| `round1/launch-receipt.md` | 0 | 0 | 7 | 1 | 4 |
| `round1/libraries-consumer-report.md` | 0 | 0 | 2 | 0 | 2 |
| `round1/prompt-common.md` | 6 | 0 | 7 | 0 | 1 |
| `round1/sdk-foundation-report.md` | 0 | 0 | 2 | 0 | 1 |
| `round1/skeptic-openclaw-report.md` | 0 | 0 | 2 | 0 | 1 |
| `round2/codex-version-report.md` | 0 | 0 | 3 | 0 | 1 |
| `round2/decisions-log-2026-10-02.md` | 0 | 0 | 3 | 0 | 2 |
| `round2/governance-sdk-report.md` | 0 | 0 | 2 | 0 | 1 |
| `round2/launch-receipt.md` | 0 | 0 | 4 | 0 | 1 |
| `round2/library-decomposition-report.md` | 0 | 0 | 2 | 0 | 1 |
| `round2/prompt-common-round2.md` | 7 | 0 | 4 | 0 | 1 |
| `round2/round2-synthesis.md` | 0 | 0 | 1 | 0 | 1 |
| `round2/round2-update-2026-10-02.md` | 1 | 0 | 0 | 0 | 0 |
| `round2/skeptic-integration-report.md` | 2 | 0 | 3 | 0 | 4 |
| `storage-verification/storage-report.md` | 1 | 0 | 0 | 0 | 0 |
| `plan-reviews/plan-v2-review-2026-10-04.md` | 2 | 0 | 0 | 0 | 2 |
| **Total** | 33 | 1 | 52 | 4 | 47 |

Files not listed had no replacements. The counts come from a word-level diff of each file against the unredacted original, so they are approximate: rule 3 counts removed model and role mentions, and a few lines were reworded by those rules to stay grammatical.

Checksums in `round1/input-sha256.txt` identify the unredacted local inputs; the redacted copies here do not match them.
