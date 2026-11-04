# Agent 1 starting brief

## Objective

Implement the master plan's Agent 1 scope: contracts, runtime validation, canonical scene reducer/store, revision/concurrency handling, manual history and validated persistence. This brief does not reduce any requirement in the master plan.

## Read first

1. `docs/Live_Whiteboard_Master_Plan.md`, especially all shared contracts and the Agent 1 section.
2. `docs/architecture.md` and `docs/agent-handoffs/agent-0.md`.
3. `package.json`, `tsconfig.json`, `vitest.config.ts` and `CONTRIBUTING.md`.

## Available environment

Dependencies are installed and the lockfile is present. Zod, Zustand, Vitest and IndexedDB browser APIs are available without a backend. Core tests run in Node; persistence tests may need an integration-owner-approved IndexedDB test adapter or browser tests.

Own `src/contracts/**`, `src/scene/**`, colocated unit tests and the content of `docs/protocol.md`. Request package/config/app changes through Agent 0. Do not build later agents' renderer, layout engine, stream parser or UI.

## Suggested sequence

1. Publish canonical TypeScript types and Zod schemas for scene, operations, manual commands, metadata and generation requests. Include security/size/coordinate limits and centralized defaults.
2. Publish compiling public API types/stubs, including the layout injection interface. Document the boundary so Agent 2 can implement geometry without a circular import. Keep geometry semantics explicit; do not silently hardcode placeholder production layout.
3. Implement pure command application, one canonical store, transaction revisions, conflicts, epochs, replay deduplication, tombstones and bounded pending dependencies.
4. Implement manual field-level undo/redo, import/export, validated autosave and stable selectors.
5. Supply valid/invalid examples, focused unit tests and `docs/agent-handoffs/agent-1.md` using the handoff template.

Public exports required by the plan: `createSceneStore`, `dispatch`, `getSnapshot`, `subscribe`, `undo`, `redo`, `importScene`, `exportScene`, operation/request schemas. Document whether store methods or named functions provide these APIs and show a usage example.

## Completion checks

Run `npm run check` and relevant browser tests. Exercise stale/manual conflicts, locked/actively edited targets, deleted dependencies, revision-safe undo, import failure preservation, bounded history/pending state and schema rejection cases. Record actual results. Ask Agent 0 to review/freeze protocol v1 before dependent agents proceed. Gate A is not complete just because this foundation screen loads.
