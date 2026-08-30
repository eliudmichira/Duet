# Agent Trajectories — Duet Adapter Workflow

**Built:** Aug 30, 2026, 02:00–04:58 UTC
**Tool:** Codebuff (Buffy agent) — deterministic coding agent, no LLM calls in the workflow itself
**Session type:** Single continuous development session with iterative audit

> This document is the primary trajectory artifact for the agent adapter workflow.
> h5i traces in `refs/h5i/context` cover an earlier April 28 popup.js session, not this build.

---

## Build Timeline

### Phase 1: Code Generation (02:00–02:40 UTC)

The agent workflow was built as five modules plus an orchestrator:

| File | Lines | Purpose |
|---|---|---|
| `site-analyzer.js` | 400 | DOM/player inspection, framework detection, confidence scoring |
| `adapter-generator.js` | 672 | 6 strategy templates, code generation from analysis results |
| `adapter-registry.js` | 171 | Chrome storage persistence, LRU eviction (max 50) |
| `sandbox-tester.js` | 296 | Syntax validation, export checks, pitfall detection |
| `agent.js` | 234 | Pipeline orchestrator |
| `test-panel.html` | — | Evaluation harness |

**Key design decision:** Template-based generation instead of LLM-based generation.
The workflow selects from predefined strategy templates based on DOM features.
No LLM calls are made at runtime. This was chosen for determinism and speed.

**Strategy templates:** generic HTML5, shadow DOM, cross-origin iframe, custom player, framework-specific (YouTube/Vimeo).

### Phase 2: Integration (02:40–03:10 UTC)

- Modified `extension/content.js` (+30 lines): added agent fallback after 3 consecutive polls find no video
- Modified `extension/manifest.json`: added agent scripts to content_scripts
- Ran `test-results.txt` validation: all 5 modules parse, all 6 strategies generate valid adapters, registry round-trip passes

**Git commits:**
- `84b4680` — `feat: add agentic adapter workflow for automated video player detection`

### Phase 3: External Audit (03:41–04:30 UTC)

A human reviewer cloned the repo and verified:
1. ✅ Agent code is real — tests pass, git history confirms commits
2. ✅ File boundary claim is accurate — agent/ files added today, base extension predates hackathon
3. ❌ Build Provenance section falsely claimed h5i traces covered this build
4. ❌ Improvement Changelog implied separate commit cycles that don't exist in git history

**Auditor's exact finding on trajectories:**
> `.claude/h5i.md` isn't a trajectory log, it's the tool's instruction file telling an agent how to record traces. The actual trace data lives in a git ref that requires a separate `h5i push` and isn't in this repo.

### Phase 4: Corrections (04:30–04:58 UTC)

Three corrective commits applied:

1. `e019d5a` — `docs: tighten SUBMISSION.md framing and structure for hackathon rubric`
   - Removed "agentic" language from title and opener
   - Added What-This-Is/Is-Not callout box
   - Updated comparison table with detailed column specs
   - Rewrote limitations to match 6 required items
   - Added full reproduction commands with runtime/cost notes
   - Added Improvement Changelog, Hot Take, File Boundary sections

2. `490fe28` — `docs: fix trajectories claim and soften changelog framing`
   - Renamed "Improvement Changelog" → "Design Iteration Log"
   - Added explicit note: "iterations happened within a single development session"
   - Replaced false h5i claim with honest Build Provenance section

3. `3fbaa8b` — `docs: accurate Build Provenance — h5i data is partial, not complete`
   - Updated to reflect: `refs/h5i/context` contains April 28 traces only
   - Clarified Aug 30 agent build has no h5i traces
   - Noted `h5i.exe` is Windows-only, `h5i push` cannot run here

---

## Evidence Chain

| Claim | Evidence | Verifiable? |
|---|---|---|
| Agent code exists | `agent/` directory with 6 files | ✅ `ls agent/` |
| Tests pass | `test-results.txt` + reproducible via node commands | ✅ Run commands in SUBMISSION.md |
| Git history is honest | `git log --all --oneline` shows commit chain | ✅ Anyone can clone and check |
| File boundary is accurate | `git log --follow extension/content.js` shows April 2026 origin | ✅ Verifiable |
| No LLM calls at runtime | No API keys, no fetch calls, no async LLM integration in agent code | ✅ Read the source |
| Limitations are honest | 6 limitations documented, including DRM, CSP, auth, mobile, stability, SPA | ✅ Read SUBMISSION.md |
| h5i traces are partial | `git cat-file -p refs/h5i/context` shows April 28 data only | ✅ Verifiable |
| Chat log is the primary artifact | This file + the live conversation | ✅ Screen-recordable |

---

## Iteration Rationale

The Design Iteration Log in SUBMISSION.md describes the evolution within this session. For clarity, here's what drove each phase:

- **Baseline audit** → Existing `content.js` uses `querySelectorAll("video")` which fails on shadow DOM, iframes, and custom players. Needed a fallback mechanism.
- **Phase 1: Site analyzer** → Detection alone isn't useful without a response. But we needed to know WHAT to generate before generating it.
- **Phase 2: Adapter templates** → 5 templates cover the common patterns seen in the wild. Framework-specific template handles YouTube/Vimeo/Twitch with player API knowledge.
- **Phase 3: Sandbox tester** → First-pass adapters had syntax errors (missing exports, unhandled edge cases). Validation catches these before injection.
- **Phase 4: Registry** → Same site visited twice shouldn't regenerate the same adapter. LRU caching with hostname+framework key.
- **Final: Integration** → Wire all stages together. Content script polls, falls back to agent, adapter takes over.

---

## What Was NOT Claimed

To be explicit about what this submission does **not** claim:

- Does NOT claim to bypass DRM (Netflix, Disney+, Prime sync is unverified)
- Does NOT claim cross-origin iframe adapters work with CSP-protected sites
- Does NOT claim mobile browser support
- Does NOT claim long-session stability
- Does NOT claim SPA navigation survival
- Does NOT claim live browser testing was performed
- Does NOT claim the agent workflow is "autonomous" or "reasons about arbitrary websites"
- Does NOT use unmeasured multipliers ("9/10", "2-3×", etc.)
