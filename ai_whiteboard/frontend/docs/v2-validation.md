# V2 frontend validation

`release/v2` starts from `release/v1` at `e095dd2`. Changes are confined to
`V1/frontend`: presentation, short entrance animations, wheel navigation, the
pan/select toggle, documentation, and regression tests. Backend code, API
contracts, generation scheduling, persistence and editor operations are unchanged.

## Passing checks

- Production build, TypeScript, ESLint and Prettier.
- All 290 frontend unit tests, including theme contrast checks.
- All 16 UI browser tests: desktop/tablet/mobile layouts, dark theme, keyboard
  access, panel expansion, pan/select synchronization, and existing controls.
- Editor coverage for insertion, dragging, resizing, Escape cancellation,
  connectors, labels, duplication, delete/undo, palette drops and reflow.
- New browser checks for pointer-anchored wheel zoom in both directions,
  Shift+wheel panning, and existing Space/hand/middle-button drags.
- Canvas fade checks: finishes in 160 ms, preserves coordinates and scale,
  remains hittable while fading, does not replay after culling, caps concurrent
  fades at 48, and skips/finishes fades when reduced motion is requested.
- Existing streaming, import/export, autosave, manual-edit protection and
  generation-following scenarios passed in the broader end-to-end run.

## Existing browser failures

These failures were reproduced against unchanged `release/v1`, separately from
the V2 implementation. They remain visible rather than being skipped or changing
application behavior to satisfy older fixtures:

- Board following test expects the distant fixture to move the camera below
  x = -500; the fixture does not do so in v1.
- Board reflow test expects the fixed-size first fixture node to grow and shift
  the downstream camera; it does not do so in v1.
- Demo streaming and foundation tests look for a `Start session` button while
  the existing default input mode is backend/Hold to talk.
- Denied-microphone test selects a `microphone` option that the existing input
  selector no longer exposes.
- Recovery test looks for a `Retry request` button that the current backend-mode
  controls do not expose in that scenario.

An initial concurrent run shared Playwright's default output directory and
reported missing trace files in the editor Escape and grid tests. Both passed
when repeated with separate output directories. Use distinct `--output` paths
when running different browser suites concurrently.

Browser regression checks used local fixtures without a running backend;
capability discovery therefore logged expected local proxy connection errors.
No paid provider requests or backend changes were made.
