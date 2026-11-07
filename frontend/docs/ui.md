# Application UI and accessibility

Agent 7 owns src/ui and src/styles. WhiteboardApp is exported from src/ui/index.ts and receives the shared RendererRuntime. src/app/RendererApp.tsx remains a compatibility re-export for existing browser harnesses. Runtime lifecycle, scene authority and session scheduling stay with their existing controllers.

## Layout and controls

The top bar contains the app/session name, input mode, Start/Resume, Pause, Stop and the Board panel disclosure. The session name is local display state, not a persisted document field. Capture and generation are independently described in a polite status line; recording has both a visible dot and text. Mock transcription/generation and local recording mode remain explicitly labelled.

The left tool rail contains select/hand, all six shapes, arrow/line, shared colour swatches and undo/redo. The bottom bar contains independent Grid/Snap, zoom, fit section/board, keyboard pan controls and live following. Following can be paused explicitly or by navigation and resumed independently of grid/snap. Zoom buttons disable at their actual 15%/400% bounds.

The right Board panel contains session recovery actions, interim/final transcript, local recording clips, topics, selection properties, section rename, the DOM scene outline, navigation help and collapsed Developer tools. Properties render only for a selection. Raw request/stream diagnostics and direct renderer/mock fixtures stay inside Developer tools; no repeated toast UI is used. Context/transcript errors keep their recovery text and accepted drawing.

At widths of 1100 px and above the panel starts open in a fixed 288 px column. Smaller windows start collapsed; resizing across that breakpoint resets to the appropriate default. The small-screen panel overlays the canvas without resizing it. Opening it focuses Close; Escape or dismissal closes it and returns focus to the disclosure. It is a nonmodal complementary region, so it does not trap focus. The palette becomes a scrollable one-column rail on smaller layouts. The page does not scroll; the palette and Board panel scroll independently. The footer wraps on phones.

The empty canvas offers Start demo and Add a shape. The overlay does not intercept drawing gestures, and choosing a shape removes it. The default demo requires no microphone permission. Start/Stop/Reset call session controller methods; Reset keeps the explicit confirmation dialog.

## Keyboard and accessible scene alternative

Every control is a native button, input, select, details/summary or audio control, with a meaningful label. Icon-only buttons have accessible names and title tooltips; actionable buttons have at least 36×36 px targets. The first keyboard stop is Skip to canvas. The canvas and outline are reachable from navigation help as well.

Pointer palette activation selects a placement tool and preserves drag/drop. Keyboard/assistive activation inserts a shape at the current world-view centre through editor.insert. Text insertion opens the existing label editor. For connectors, choose Arrow or Line and activate the two endpoint nodes in Scene outline. Both nodes and edges appear in the outline with readable labels/endpoints, selection states, types/source and lock information. Shift activation supports multiple selection. Section/topic buttons fit the chosen section through the camera API.

After selecting an outline object, use properties to edit the full label, dimensions, lock, duplicate or delete; colour swatches apply through the editor. Focus the canvas and use arrow keys to nudge selected nodes, Shift+arrows for larger moves. Existing tool, history, duplicate, label and delete shortcuts remain available on the canvas. Native controls and text fields keep their own keyboard behaviour, so Enter on a button does not accidentally edit the selected canvas label. Escape cancels an active editor interaction/connector before dismissing a small-screen panel. Typing/IME continues through the existing editor overlay.

## Shared theme

src/styles/index.ts exports THEME, THEME_VARIABLES and SHAPE_COLORS. Tokens supply DOM CSS variables, BOARD_THEME paint and layout FONT_FAMILY/edge-label background. src/main.tsx installs variables on the document root; WhiteboardApp also supplies them within its own tree. Board/editor focus and transient connector colours use the same accent. A neutral light background, single UI accent, subtle borders, consistent icon strokes and an 8-unit base spacing guide the shell. Palette semantic shape colours remain available.

Unit checks verify at least 4.5:1 for normal/muted text and primary button text, including labels on every shape fill, and at least 3:1 for focus/control boundaries. Focus-visible uses a 3 px accent outline. Reduced-motion CSS removes transitions/animation and smooth scrolling; the existing camera media-query integration disables animated fitting. Browser checks exercise the actual focus ring and immediate camera fit after a pan.

## Verification and limits

Run npm run test:ui-browser. The owned Chromium suite checks 1280×720, 1920×1080, 768×1024 and 390×844 layouts, canvas space/page overflow, automatic panel collapse, Escape/focus return, skip navigation, keyboard insertion/connections/properties, independent toggles, canvas scroll containment, target sizes/names and reduced motion. Existing board/editor/stream/session suites still exercise the real shared components; selectors now open Developer tools where appropriate and inspect raw state attributes alongside friendly labels.

The UI was visually reviewed at desktop/tablet/phone sizes. These checks are focused accessibility coverage, not a screen-reader or full WCAG conformance certification. Physical assistive technologies, forced-colour mode and additional OS/browser scaling still need QA. Dark mode is not implemented. Agent 8 wires DocumentPanel with save status, JSON files and validated autosave recovery; [acceptance](acceptance.md) and [performance](performance.md) record tested coverage and remaining gates. Firefox/WebKit smoke passes, but full UI/accessibility coverage is still Chromium only. No provider/STT backend is connected.
