# Duet — Agentic Adapter Workflow

**Hackathon Submission**

*A deterministic workflow that analyzes video player architecture, generates sync adapters, and validates them — replacing manual per-site reverse-engineering with automated adapter generation.*

---

## TL;DR

DuetWatch syncs pause/play/seek between two browsers using a single content script with generic `<video>` detection. Adding support for sites with custom players (shadow DOM, cross-origin iframes, framework-specific players) requires manual reverse-engineering per site.

We built a workflow that automates this: given a URL, it analyzes the DOM, detects the player framework, generates a adapter conforming to DuetWatch's sync contract, validates the code, and caches the result. Sites that previously required hours of manual work now get an adapter generated in milliseconds.

**What this is:** A template-based adapter generator with DOM analysis, strategy selection, code validation, and persistent caching.

**What this is not:** An LLM that reasons about arbitrary websites. No LLM calls are made. The system selects from predefined strategy templates based on DOM features.

---

## Baseline vs. Advanced

### Baseline: DuetWatch's Current Detection

DuetWatch's `content.js` uses a single heuristic for all sites:

```javascript
function findVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (!videos.length) return null;
  let best = null, bestScore = 0;
  for (const v of videos) {
    const s = scoreVideo(v);
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best;
}
```

This works on YouTube, Vimeo, and any site with a visible `<video>` element. It fails when:

- Video is inside Shadow DOM (`querySelector("video")` can't reach it)
- Video is in a cross-origin iframe (throws on `contentDocument` access)
- Player is a custom framework (Netflix, Disney+, Prime wrap or replace the standard API)
- DRM (Encrypted Media Extensions) blocks direct DOM manipulation

The README acknowledges this limitation for Netflix, Disney+, and Prime Video.

### Advanced: Agentic Adapter Workflow

The workflow replaces manual detection with a five-stage pipeline:

```
URL → SiteAnalyzer → AdapterGenerator → SandboxTester → AdapterRegistry
         ↓                ↓                  ↓                ↓
    Detect player    Select strategy     Validate code    Cache for reuse
    Detect framework Generate adapter    Check exports    LRU eviction
    Score challenges Hook events         Catch pitfalls   Instant lookup
```

**Stage 1 — Site Analysis** (`agent/site-analyzer.js`):
- Scans for `<video>` elements (standard, Shadow DOM, iframes)
- Detects 10 player frameworks (YouTube, Vimeo, Netflix, Disney+, Prime, Twitch, etc.)
- Catalogs challenges (DRM, custom controls, ad overlays)
- Scores confidence (0-100) based on detection quality and challenge severity

**Stage 2 — Adapter Generation** (`agent/adapter-generator.js`):
- Selects a strategy based on analysis results
- Generates a self-contained adapter that conforms to DuetWatch's sync contract
- 6 strategy templates: generic HTML5, shadow DOM, cross-origin iframe, custom player, framework-specific

**Stage 3 — Sandbox Validation** (`agent/sandbox-tester.js`):
- Syntax validation via `new Function()` parse
- Required exports check (findVideo, attachListeners, applySync, getMetadata)
- Common pitfall detection (eval, innerHTML XSS, document.write)

**Stage 4 — Adapter Registry** (`agent/adapter-registry.js`):
- Stores adapters in Chrome storage keyed by hostname + framework
- LRU eviction (max 50 adapters)
- Instant lookup on subsequent visits

**Stage 5 — Content Script Integration** (`extension/content.js`):
- After 3 consecutive polls find no video, triggers the agent fallback
- Agent generates/retrieves adapter, injects it, and the adapter's `findVideo()` takes over
- Once a video is found, standard DuetWatch sync logic operates unchanged

---

## What Was Tested

All tests were run in Node.js with simulated DOM inputs. No live browser testing was performed. See `test-results.txt` for raw output.

### Test 1: Module Syntax Validation
All 5 agent modules parse without errors:
```
PASS site-analyzer.js (400 lines)
PASS adapter-generator.js (672 lines)
PASS adapter-registry.js (171 lines)
PASS sandbox-tester.js (296 lines)
PASS agent.js (234 lines)
```

### Test 2: Adapter Generation + Validation
Each strategy template generates valid adapter code:
```
PASS generic_html5     strategy=generic_html5         hooks=7 code=3417 chars
PASS shadow_dom        strategy=shadow_dom            hooks=8 code=2737 chars
PASS custom_player     strategy=custom_player         hooks=5 code=3700 chars
PASS framework_yt      strategy=framework_specific    hooks=5 code=3069 chars
PASS framework_vimeo   strategy=framework_specific    hooks=5 code=2682 chars
PASS cross_origin      strategy=cross_origin_iframe   hooks=5 code=4559 chars
```

### Test 3: Registry Round-Trip
Registered 3 adapters, verified lookup by hostname and framework fallback:
```
PASS youtube.com → FOUND (exact match)
PASS vimeo.com → FOUND (exact match)
PASS unknown.com → MISS (correct — no adapter)
PASS unknown.com + framework=youtube → FOUND (framework fallback)
```

### Test 4: Per-Site Adapter Generation (Simulated)
```
PASS YouTube        strategy=framework_specific     confidence=75%
PASS Vimeo          strategy=framework_specific     confidence=75%
PASS Netflix        strategy=framework_specific     confidence=30%
PASS Disney+        strategy=framework_specific     confidence=30%
PASS Prime Video    strategy=framework_specific     confidence=30%
PASS Twitch         strategy=framework_specific     confidence=55%
PASS Archive.org    strategy=generic_html5          confidence=75%
SKIP No-video       no video detected (expected)
```

### Test 5: Integration Validation
```
PASS content.js agent integration code parses correctly
PASS manifest.json is valid JSON with agent scripts in content_scripts
```

---

## What Was NOT Tested (Honest Limitations)

These are real limitations that affect the submission's claims:

1. **No live browser DOM testing.** All tests used simulated DOM inputs in Node.js. The analyzer's Shadow DOM traversal, iframe detection, and framework detection have not been validated against real pages.

2. **DRM sites are not controllable.** Netflix, Disney+, and Prime Video use Encrypted Media Extensions (EME). The adapter can detect the `<video>` element and hook play/pause events, but cannot bypass DRM license checks, force seek to arbitrary timestamps, or decrypt the video stream. The adapter generation is verified; real-world sync behavior on these sites is unverified.

3. **Cross-origin iframe adapters may be blocked.** The cross-origin strategy relies on `postMessage` between parent and iframe. Content Security Policy (CSP) headers on some sites may block this communication.

4. **No end-to-end sync test.** We did not test two browsers creating a room, joining, playing a video, and verifying sync. The adapter code generation is validated; actual sync behavior is unverified.

5. **SPA navigation survival is untested.** Single-page application navigation (YouTube, Netflix) may cause the adapter to lose its video reference. The polling fallback handles this in theory but is untested.

6. **No community adapter sharing.** The registry is local-only. There is no mechanism for users to share adapters across installations.

---

## Architecture

### Sync Contract

All adapters conform to the same interface:

```javascript
window.__duetAdapter = {
  findVideo() → HTMLVideoElement | null,
  attachListeners(video, sendSync) → void,
  applySync(video, state, serverNow) → void,
  getMetadata(video) → { url, hostname, pageTitle, videoTitle, duration, currentTime, paused }
};
```

This matches DuetWatch's existing content.js contract. Once the adapter finds a video element, the standard sync logic takes over unchanged.

### File Structure

```
extension/
├── agent/
│   ├── site-analyzer.js      # DOM/player inspection
│   ├── adapter-generator.js  # Code generation from templates
│   ├── adapter-registry.js   # Storage & caching
│   ├── sandbox-tester.js     # Validation
│   └── agent.js              # Orchestrator
├── content.js                # Modified: +30 lines for agent fallback
├── background.js             # Unchanged
├── popup.js                  # Unchanged
└── manifest.json             # Modified: agent scripts added

agent/
├── test-panel.html           # Evaluation harness
└── (copies of agent modules)

test-results.txt              # Raw test output
SUBMISSION.md                 # This document
```

---

## Baseline vs. Advanced Comparison

| Area | Baseline (content.js) | Advanced (agent workflow) |
|---|---|---|
| Player discovery | Generic `querySelector("video")` | DOM, shadow-root, iframe, framework analysis |
| Adapter creation | Manual code changes per site | Generated strategy-specific adapter |
| Validation | Manual browser testing | Syntax/export/pitfall checks |
| Reuse | Repeated manual work | Host/framework registry with cached adapters |
| Failure handling | Silent polling | Confidence score + explicit unsupported result |

---

## What's Next

1. **Live browser testing.** Load the extension, navigate to YouTube/Vimeo/Archive.org, verify the agent detects the player and the adapter syncs correctly.

2. **LLM-powered generation.** Replace template selection with an LLM that can reason about novel player architectures. The current workflow provides the analysis; an LLM could provide the adapter code.

3. **Runtime API discovery.** Instead of generating adapters at analysis time, inject a "meta-adapter" that dynamically discovers player APIs using prototype chain scanning.

4. **Community registry.** Let users share adapters for sites the workflow can't handle automatically.

---

## Built With

- Chrome Extensions Manifest V3
- Vanilla JavaScript (no build step)
- Firebase Realtime Database
- DuetWatch's existing sync infrastructure

---

## Reproduction

To verify from a clean checkout:

```bash
# 1. Check agent modules parse
cd extension && node -e "
const fs = require('fs');
['site-analyzer.js','adapter-generator.js','adapter-registry.js','sandbox-tester.js','agent.js']
  .forEach(f => { try { new Function(fs.readFileSync('agent/'+f,'utf8')); console.log('PASS '+f); }
  catch(e) { console.log('FAIL '+f+': '+e.message); } });
"

# 2. Check adapter generation
cd extension && node -e "
global.chrome={storage:{local:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()}}};
global.document={querySelectorAll:()=>[],querySelector:()=>null,body:{classList:[]}};
global.getComputedStyle=()=>({visibility:'visible',display:'block'});
const G=require('./agent/adapter-generator.js'),V=require('./agent/sandbox-tester.js');
[{n:'generic',fw:'none',sh:false},{n:'shadow',fw:'none',sh:true},{n:'yt',fw:'youtube',sh:false}]
.forEach(c=>{const a=G.generate({url:'https://t.com',hostname:'t.com',hasVideo:true,videoSelector:'video',
framework:c.fw,domStructure:{usesShadowDOM:c.sh},challenges:[],iframes:[],confidence:60});
const v=V.validate(a.code);console.log((v.ok?'PASS':'FAIL')+' '+c.n+' strategy='+a.strategy);});
"

# 3. Verify manifest.json is valid
cd extension && node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'));console.log('PASS manifest.json');"
```

---

*Made with honesty about what works, what doesn't, and what's verified vs. unverified.*
