import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  Moon,
  Sun,
  RotateCcw,
  PanelRight,
  X,
  Play,
  Pause,
  Square as StopIcon,
  ZoomIn,
  ZoomOut,
  Scan,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Hand,
  MousePointer2,
} from 'lucide-react';
import type { RendererRuntime } from '../app/rendererRuntime';
import type { SessionMode } from '../session';
import { EditorSurface, handleEditorKeyDown } from '../editor';
import { ColorModeContext, DARK_THEME_VARIABLES, type ColorMode } from '../styles/colorMode';
import { THEME_VARIABLES } from '../styles/tokens';
import { ToolRail } from './ToolRail';
import { PanelSections } from './PanelSections';
import { TranscriptPanel } from './TranscriptPanel';
import { HoldToTalk } from './HoldToTalk';
import { captureLabel, generationLabel } from './status';

const wideQuery = '(min-width: 1100px)';
const subscribeWidth = (listener: () => void) => {
  const media = window.matchMedia(wideQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
const isWide = () => window.matchMedia(wideQuery).matches;
export function WhiteboardApp({ runtime }: { runtime: RendererRuntime }) {
  const scene = useSyncExternalStore(
    runtime.store.subscribe,
    runtime.store.getSnapshot,
    runtime.store.getSnapshot,
  );
  const editor = useSyncExternalStore(
    runtime.editor.subscribe,
    runtime.editor.getSnapshot,
    runtime.editor.getSnapshot,
  );
  const camera = useSyncExternalStore(
    runtime.viewport.subscribe,
    runtime.viewport.getSnapshot,
    runtime.viewport.getSnapshot,
  );
  const session = useSyncExternalStore(
    runtime.session.subscribe,
    runtime.session.getSnapshot,
    runtime.session.getSnapshot,
  );
  const stream = useSyncExternalStore(
    runtime.stream.consumer.subscribe,
    runtime.stream.consumer.getSnapshot,
    runtime.stream.consumer.getSnapshot,
  );
  const wide = useSyncExternalStore(subscribeWidth, isWide, () => true);
  const [panelChoice, setPanelChoice] = useState<{ wide: boolean; open: boolean } | null>(null);
  const open = panelChoice?.wide === wide ? panelChoice.open : wide;
  const setOpen = (value: boolean) => setPanelChoice({ wide, open: value });
  const [mode, setMode] = useState<SessionMode>('backend');
  const [colorMode, setColorMode] = useState<ColorMode>(() => {
    try {
      return localStorage.getItem('whiteboard-color-mode') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('whiteboard-color-mode', colorMode);
    } catch {
      // Theme switching remains available when browser storage is restricted.
    }
  }, [colorMode]);
  const [grid, setGrid] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [name, setName] = useState('Untitled session');
  const panelButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open && !wide)
      panel.current?.querySelector<HTMLButtonElement>('[aria-label="Close board panel"]')?.focus();
  }, [open, wide]);
  const canvasRegion = useRef<HTMLElement>(null);
  const focusCanvas = () =>
    canvasRegion.current?.querySelector<HTMLElement>('[role="application"]')?.focus();
  const closePanel = () => {
    setOpen(false);
    panelButton.current?.focus();
  };
  const captureActive = ['recording', 'requesting', 'finishing'].includes(session.capture);
  const streaming = stream.phase === 'receiving' || stream.phase === 'draining';
  const sections = Object.values(scene.sections).sort((a, b) => a.order - b.order);
  const active =
    editor.activeSectionId && scene.sections[editor.activeSectionId]
      ? editor.activeSectionId
      : sections[0]?.id;
  const attention =
    session.generation === 'error' ||
    session.capture === 'error' ||
    (session.generation === 'paused' && session.queued.length > 0);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && (editor.interactionInProgress || editor.connectorFrom)) {
      event.preventDefault();
      runtime.editor.escape();
      return;
    }
    if (event.key === 'Escape' && open && !wide && !editor.interactionInProgress) {
      event.preventDefault();
      closePanel();
      return;
    }
    if (
      (event.target as HTMLElement).closest(
        'button,a,summary,input,textarea,select,[contenteditable="true"]',
      )
    )
      return;
    handleEditorKeyDown(event.nativeEvent, runtime.editor);
  };
  return (
    <ColorModeContext.Provider value={colorMode}>
      <main
        className="whiteboard-app"
        data-theme={colorMode}
        style={colorMode === 'dark' ? DARK_THEME_VARIABLES : THEME_VARIABLES}
        onKeyDown={onKeyDown}
      >
        <a
          className="skip-link"
          href="#canvas-region"
          onClick={(event) => {
            event.preventDefault();
            focusCanvas();
          }}
        >
          Skip to canvas
        </a>
        <header className="app-topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Scan size={20} strokeWidth={1.75} />
            </span>
            <h1>Live Whiteboard</h1>
          </div>
          <input
            className="session-name"
            aria-label="Session name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
          <label className="mode-control">
            <span className="sr-only">Input mode</span>
            <select
              aria-label="Input mode"
              value={mode}
              disabled={captureActive || session.inFlight}
              onChange={(event) => setMode(event.target.value as SessionMode)}
            >
              <option value="mock">Mock demo — no microphone</option>
              <option value="backend">Whisper — hold to talk</option>
            </select>
          </label>
          <div className="session-actions" role="group" aria-label="Session controls">
            {mode === 'backend' ? (
              <HoldToTalk session={runtime.session} />
            ) : (
              <>
                {session.capture === 'paused' ? (
                  <button
                    className="primary"
                    aria-label="Resume session"
                    title="Resume input and queued generation"
                    onClick={() => {
                      void runtime.session.resume();
                    }}
                  >
                    <Play size={16} aria-hidden="true" />
                    Resume
                  </button>
                ) : (
                  <button
                    className="primary"
                    aria-label="Start session"
                    title={
                      mode === 'mock'
                        ? 'Start the permission-free mock demo'
                        : 'Start local recording; transcription stays mocked'
                    }
                    disabled={captureActive || streaming}
                    onClick={() => {
                      void runtime.session.start(mode);
                    }}
                  >
                    <Play size={16} aria-hidden="true" />
                    Start
                  </button>
                )}
                <button
                  aria-label="Pause session"
                  title="Pause input; let the current diagram finish"
                  disabled={!captureActive && !session.queued.length}
                  onClick={runtime.session.pause}
                >
                  <Pause size={16} aria-hidden="true" />
                  <span className="action-label">Pause</span>
                </button>{' '}
              </>
            )}

            <button
              aria-label="Stop session"
              title="Stop input and generation; keep drawing and unsent text"
              onClick={runtime.session.stop}
            >
              <StopIcon size={15} aria-hidden="true" />
              <span className="action-label">Stop</span>
            </button>
          </div>
          <div className="topbar-utilities">
            <button
              role="switch"
              aria-label="Dark theme"
              aria-checked={colorMode === 'dark'}
              title={colorMode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => setColorMode((current) => (current === 'light' ? 'dark' : 'light'))}
            >
              {colorMode === 'dark' ? (
                <Sun size={18} aria-hidden="true" />
              ) : (
                <Moon size={18} aria-hidden="true" />
              )}
            </button>
            <button
              aria-label="Reset session"
              title="Clear board and transcript after confirmation"
              onClick={() => {
                if (window.confirm('Clear the board, transcript and current session?'))
                  runtime.session.reset({ confirmed: true });
              }}
            >
              <RotateCcw size={18} aria-hidden="true" />
            </button>
            <button
              ref={panelButton}
              className="panel-toggle"
              aria-label="Board panel"
              aria-expanded={open}
              aria-controls="board-panel"
              title="Topics, transcript, selection properties and diagnostics"
              onClick={() => setOpen(!open)}
            >
              <PanelRight size={18} aria-hidden="true" />
              <span className="panel-label">Session & board</span>
              {attention && <span className="attention-dot" aria-label="Needs attention" />}
            </button>
          </div>
        </header>
        <div className="statusbar" role="status" aria-live="polite" aria-atomic="true">
          <span
            className={`capture-indicator ${session.capture === 'recording' ? 'is-recording' : ''}`}
            aria-hidden="true"
          />
          <span data-testid="capture-state" data-state={session.capture}>
            {captureLabel({ ...session, mode })}
          </span>
          <span className="status-separator" aria-hidden="true">
            ·
          </span>
          <span data-testid="generation-state" data-state={session.generation}>
            {generationLabel(session, stream)}
          </span>
          <span className="status-disclaimer">
            {mode === 'microphone'
              ? 'Local recording — transcription mocked'
              : mode === 'backend'
                ? 'Live backend transcription and streamed drawing'
                : 'Transcript and generation are mocked'}
          </span>
        </div>
        <div
          className={`app-workspace ${open ? 'panel-open' : ''} ${panelExpanded ? 'panel-expanded' : ''}`}
        >
          <ToolRail runtime={runtime} />
          <section
            ref={canvasRegion}
            className="board-region"
            id="canvas-region"
            aria-label="Drawing area"
          >
            <EditorSurface
              viewport={runtime.viewport}
              grid={grid}
              editor={runtime.editor}
              store={runtime.store}
            />
            {!sections.length && editor.tool === 'select' && !captureActive && !streaming && (
              <div className="board-empty">
                <div className="empty-content">
                  <Scan size={28} aria-hidden="true" />
                  <h2>Your board is ready</h2>
                  <p>Hold to talk to create a diagram, or add a shape.</p>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={captureActive || streaming}
                      onClick={() => {
                        setMode('mock');
                        void runtime.session.start('mock');
                      }}
                    >
                      Start demo
                    </button>
                    <button
                      onClick={(event) => {
                        runtime.editor.setTool('rect');
                        if (event.detail === 0) {
                          const b = runtime.viewport.getVisibleWorldBounds();
                          runtime.editor.insert('rect', {
                            x: b.x + b.width / 2,
                            y: b.y + b.height / 2,
                          });
                        }
                      }}
                    >
                      Add a shape
                    </button>
                  </div>
                  <small>No microphone or API key needed for the demo.</small>
                </div>
              </div>
            )}
            {(attention || editor.message) && (
              <div className="board-notice">
                <span>
                  {editor.message ||
                    session.message ||
                    (session.capture === 'error'
                      ? 'Microphone needs attention.'
                      : session.generation === 'paused'
                        ? 'Generation paused. Queued text is kept.'
                        : 'Some updates need attention. Your drawing is kept.')}
                </span>
                <button onClick={() => setOpen(true)}>Review session</button>
              </div>
            )}
          </section>
          {open && !wide && (
            <button
              className="drawer-scrim"
              tabIndex={-1}
              aria-label="Dismiss board panel"
              onClick={closePanel}
            />
          )}
          {open && (
            <aside
              ref={panel}
              className="board-panel renderer-sidebar"
              id="board-panel"
              aria-label="Board information"
            >
              <div className="panel-heading">
                <h2>Transcript & board</h2>
                <div className="panel-heading-actions">
                  <button
                    aria-label={panelExpanded ? 'Collapse board panel' : 'Expand board panel'}
                    title={panelExpanded ? 'Restore panel width' : 'Expand panel to the left'}
                    aria-pressed={panelExpanded}
                    aria-controls="board-panel"
                    onClick={() => setPanelExpanded((value) => !value)}
                  >
                    {panelExpanded ? (
                      <ChevronRight size={18} aria-hidden="true" />
                    ) : (
                      <ChevronLeft size={18} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    aria-label="Close board panel"
                    title="Close board panel"
                    onClick={closePanel}
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <TranscriptPanel runtime={runtime} mode={mode} />
              <PanelSections runtime={runtime} mode={mode} focusCanvas={focusCanvas} />
            </aside>
          )}
        </div>
        <footer className="viewport-bar" aria-label="Whiteboard controls">
          <button
            className="navigation-toggle"
            aria-label="Pan mode"
            aria-pressed={editor.tool === 'hand'}
            title="Switch between pan and select. H for hand, V for select."
            onClick={() => runtime.editor.setTool(editor.tool === 'hand' ? 'select' : 'hand')}
          >
            {editor.tool === 'hand' ? (
              <Hand size={16} aria-hidden="true" />
            ) : (
              <MousePointer2 size={16} aria-hidden="true" />
            )}
            <span>{editor.tool === 'hand' ? 'Pan mode' : 'Select mode'}</span>
          </button>
          <label className="toggle-label" title="Show the grid; does not change snap">
            <input
              type="checkbox"
              checked={grid}
              onChange={(event) => setGrid(event.target.checked)}
            />
            Grid
          </label>
          <label
            className="toggle-label"
            title="Snap new objects and movement independently of the grid"
          >
            <input
              type="checkbox"
              checked={editor.snap}
              onChange={(event) => runtime.editor.setSnap(event.target.checked)}
            />
            Snap
          </label>
          <div className="zoom-controls" role="group" aria-label="Zoom">
            <button
              aria-label="Zoom out"
              title="Zoom out about the centre"
              disabled={camera.viewport.scale <= 0.15}
              onClick={() => runtime.viewport.zoomBy(1 / 1.2)}
            >
              <ZoomOut size={18} aria-hidden="true" />
            </button>
            <button
              aria-label="Reset zoom to 100 percent"
              title="Reset zoom to 100%"
              onClick={() => runtime.viewport.resetZoom()}
            >
              {Math.round(camera.viewport.scale * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              title="Zoom in about the centre"
              disabled={camera.viewport.scale >= 4}
              onClick={() => runtime.viewport.zoomBy(1.2)}
            >
              <ZoomIn size={18} aria-hidden="true" />
            </button>
          </div>
          <button
            disabled={!active}
            title="Fit the active section in view"
            onClick={() => active && runtime.viewport.fitSection(active, { animate: true })}
          >
            Fit section
          </button>
          <button
            className="fit-board"
            disabled={!sections.length}
            title="Fit all topics in view"
            onClick={() => runtime.viewport.fitBoard({ animate: true })}
          >
            Fit board
          </button>
          <details className="pan-menu">
            <summary title="Keyboard-accessible pan controls">Pan</summary>
            <div role="group" aria-label="Pan view">
              {[
                { icon: ChevronLeft, label: 'Pan left', x: 100, y: 0 },
                { icon: ChevronRight, label: 'Pan right', x: -100, y: 0 },
                { icon: ChevronUp, label: 'Pan up', x: 0, y: 100 },
                { icon: ChevronDown, label: 'Pan down', x: 0, y: -100 },
              ].map(({ icon: Icon, label, x, y }) => (
                <button
                  key={label}
                  aria-label={label}
                  title={label}
                  onClick={() => runtime.viewport.panBy({ x, y }, { manual: true })}
                >
                  <Icon size={18} aria-hidden="true" />
                </button>
              ))}
            </div>
          </details>
          <span className="follow-state" role="status" aria-label="Follow status">
            {camera.followLive ? 'Following live' : 'Follow paused'}
          </span>
          <button
            className="follow-button"
            aria-label={camera.followLive ? 'Pause live following' : 'Resume live'}
            aria-pressed={camera.followLive}
            title="Follow the latest generated topic; navigation pauses following"
            onClick={() =>
              camera.followLive ? runtime.viewport.suspendFollow() : runtime.viewport.resumeLive()
            }
          >
            {camera.followLive ? 'Following live' : 'Resume live'}
          </button>
        </footer>
      </main>
    </ColorModeContext.Provider>
  );
}
