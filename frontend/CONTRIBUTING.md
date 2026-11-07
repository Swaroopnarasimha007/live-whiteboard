# Contributing

Read `docs/Live_Whiteboard_Master_Plan.md` and `docs/architecture.md` first. The master plan is an implementation specification, not evidence of completed functionality.

- Agent 0 owns root configuration, package files, lockfiles, app composition, README and CI.
- Agent 1 owns `src/contracts`, `src/scene`, and protocol documentation content.
- Agents 2–8 own the paths listed in the master plan. Unit tests live beside owned source; cross-component fixtures, browser tests and performance harnesses live under `tests`.
- Request shared interface or dependency changes through the integration owner. Do not duplicate shared types or invent a second authoritative scene.
- Keep scene, validation, layout and transport independently testable. React and Konva must stay out of the scene store.
- Run `npm run check` and relevant browser tests before handoff. Document actual outcomes and limitations in `docs/agent-handoffs/agent-N.md`.
- Do not commit secrets, raw microphone audio, `node_modules`, build output or test reports.

Use the existing checkout unless isolation is needed. No agent implementation or parallel work should begin merely because its directory exists.
