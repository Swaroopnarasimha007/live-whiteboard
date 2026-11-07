# Performance measurement

Measured on 3 November 2026 (Asia/Calcutta; raw reports store UTC timestamps). Reference machine: Intel Core i5-13500H, 16 reported logical CPUs, approximately 15.6 GiB RAM, Windows 11 build 26200 x64. Browser: Playwright headless Chromium 156.0.8078.4, DPR 2, 1280×720 viewport with an 1100×600 canvas. Tests use the Vite development server, reduced motion and Chromium timeline tracing; these are not production-build or physical-display measurements.

## Results

Three retained final trials use 500 visible fixed-size rectangular nodes and 90 generated label updates at a nominal 30 operations/second. Every operation applied, all ninety obtained actual Konva scene-layer draw samples, and no draw records remained pending. No edges are part of this dense streaming workload; branching/edge correctness is covered separately and routing is timed separately.

| Metric                                         |      Trial 1 |      Trial 2 |      Trial 3 |
| ---------------------------------------------- | -----------: | -----------: | -----------: |
| Complete operation → Konva draw, p95           |      49.3 ms |      47.5 ms |      54.0 ms |
| Dispatch including validation/layout, p95      |       7.5 ms |       7.0 ms |       7.9 ms |
| 5,000-node / 50-section navigation → draw, p95 |      19.2 ms |      19.3 ms |      19.4 ms |
| Animation-frame navigation proxy, mean         | about 60 FPS | about 60 FPS | about 60 FPS |
| 500 collision placement calls                  |      10.2 ms |       9.7 ms |      11.6 ms |
| Chromium timeline Paint events                 |           11 |           11 |           13 |

**The <50 ms p95 streaming goal is not consistently met: two trials meet it and one reaches 54 ms.** Functional/benchmark-integrity checks pass; the performance release gate remains open. The frame-rate value is a programmatic rAF navigation proxy, not verified physical pointer-gesture or screen-paint FPS. Therefore the general 50+ FPS gesture target is not certified.

All 5,000 navigation nodes are distributed across fifty sections. The final view renders 100 visible nodes, demonstrating offscreen culling, rather than drawing all 5,000. Fifty section jumps measure input-to-actual-layer-draw latency; 120 subsequent alternating pan frames provide the frame-time proxy. This is a short controlled long-document workload, not an hours-long soak or a dense 5,000-node single section.

Raw data: [trial 1](performance-results/trial-1.json), [trial 2](performance-results/trial-2.json), [trial 3](performance-results/trial-3.json). [reference.json](performance-results/reference.json) duplicates the first retained trial, not the fastest. Raw values include p50/p95/max, counts, layout duration, pure decode/schema timings, cached/uncached edge routing, collision attempts, machine and browser metadata.

## Timing boundaries

- Arrival: the controlled transport marks a complete encoded operation immediately before yielding its bytes. This excludes transcript grouping/network transit.
- Commit: a scene subscriber records the published revision timestamp.
- Dispatch: a test-only wrapper times the full dispatcher, including semantic checks, cloning, validation, injected layout and publication.
- Layout: the injected production layout adapter is timed separately inside dispatch. It is a nested component, not an additive independent latency.
- Draw: Whiteboard's existing Konva scene-layer draw callback resolves all waiting committed revisions. A requestAnimationFrame callback alone is not used as proof of drawing.
- Framing and schema: independent microbenchmarks decode three-byte chunks and parse validated operations without store/layout/rendering, so these are isolated aggregate costs rather than per-record inline production timings.
- Routing/collision: 500 uncached and cached routing calls and 500 collision placement calls are timed outside the stream window.
- Queue age: session snapshots separately track transcript queue age and request latency; acceptance/session tests verify the 400 ms grouping and edit deferral. Queue age is not folded into transport-to-draw statistics.

The Chromium timeline is saved as chromium-timeline.json next to each report. It supplies approximate browser Paint evidence; it does not prove when pixels reached a physical screen, and DrawFrame events are absent on this headless configuration. Tracing, development mode, system load, GC and timer scheduling affect the numbers. Do not extrapolate this one machine/dataset to other shapes, edge-heavy boards, browsers or devices.

## Optimization and reproducibility

An early [profiling baseline](performance-results/baseline.json) showed approximately 168.2 ms operation-to-draw p95 and 22.6 ms dispatch p95. Scene equality checks repeatedly sorted/serialized whole validated records. Agent 8 replaces those comparisons with identity-first structural equality over canonical JSON; deterministic serialization remains in replay signatures. Existing immutability, selectors, reducer/history and replay tests still pass. Full-scene clone/schema work remains and needs further profiling before declaring the latency gate closed. The baseline used the early harness; isolation/warmup differences mean its improvement is directional evidence, not a controlled attribution solely to the comparator.

Run npm run test:performance to collect a report and trace under test-results. For three independent runs:

```powershell
npx playwright test --config tests/performance/playwright.config.ts --repeat-each 3
```

By default CI asserts workload integrity/counts/culling and uploads measurements without a hardware-dependent latency threshold. To enforce the 50 ms gate on a chosen reference environment:

```powershell
$env:WHITEBOARD_PERFORMANCE_GATE = '1'
npm run test:performance
Remove-Item Env:WHITEBOARD_PERFORMANCE_GATE
```

Gate failures still write reports/traces. Versioned reference files are reviewed measurements; tests do not automatically overwrite them. Keep all trials, including misses. CI is configured but has not executed remotely in this session. Bundle output is approximately 801 kB minified JavaScript / 245 kB gzip and retains Vite's >500 kB warning. No bundle/FPS target is claimed solved.
