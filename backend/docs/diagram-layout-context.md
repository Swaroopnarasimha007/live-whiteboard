# Diagram layout and model context

Generated operations pass through backend schema/reference validation and the
frontend's deterministic measured-geometry pass before a scene transaction commits.
Geometry repair lives in the renderer because browser font metrics, manual edits,
and the current canonical scene are authoritative; Python does not guess dimensions
or maintain a second copy of applied board state.

Generated additions wrap at `maxGeneratedRowWidth` (default 1000 world units).
Affected sections are checked on additions, node/edge updates and deletions.
Collisions from position updates or text growth are repaired with nearby clear
positions first, preserving unchanged nodes when possible. Locked, manual, and
manually positioned nodes stay fixed. The scene reducer accepts position-only
repairs to eligible generated neighbors in affected sections and rejects changes
to unrelated or protected geometry. Intentional manual overlaps remain permitted.

Connector routing uses shape boundary ports, padded obstacles, orthogonal detours,
reserved corridors and a bounded visibility-grid fallback. Labels avoid nodes,
previous labels and other connectors. Section plans are deterministic and cached
by all section geometry and edge topology/labels, so culling/render order cannot
change routes. Arrowheads follow the final segment. Bounds include all route
segments and label backgrounds.

On routing failure, one wider-spacing recovery pass rearranges eligible generated
nodes in the section. If routing or label placement still fails, the scene transaction
rejects with LAYOUT and preserves its previous state; valid sibling transactions
can still apply. The visibility fallback caps the grid at 40,000 cells and search
at 80,000 heap pops. Non-planar/dense graphs can still have crossings or shared
corridors; these are penalized and reported in diagnostics, not claimed impossible.
Protected overlaps can make a route impossible. There is no additional LLM call.

Every next transcript request is built from the committed scene, including repaired
node positions, measured dimensions and updated section bounds. The backend prompt
explicitly treats these coordinates as authoritative. Provider compaction preserves
this geometry. Raw earlier model operations are never substituted for this board.
Edge route points remain derived renderer geometry rather than model context.

The structured provider adapter compacts only the model-facing payload. It drops
request/session/revision identifiers, transcript timing and segment identifiers,
and repeated default source/lock/color fields. Defaults are explicitly supplied.
Short entity aliases already replace canonical IDs. Manual and locked flags remain
explicit, and all entities, topology, geometry, selection and completeness metadata
are retained. Canonical validation, replay, persistence, and saved JSON are unchanged.
There is no heuristic context selection that might omit a needed entity. Context
still grows with board size; use logged input token usage to measure actual cost.

Validation: frontend unit suite, production build/typecheck/lint, Chromium layout
integration, backend unit suite. No live paid-model quality measurement is implied.
