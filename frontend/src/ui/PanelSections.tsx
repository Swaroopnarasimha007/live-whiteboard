import { useState, type KeyboardEvent } from 'react';
import {
  SlidersHorizontal,
  Layers,
  ListTree,
  Settings2,
  FileText,
  Keyboard,
  Wrench,
} from 'lucide-react';
import type { RendererRuntime } from '../app/rendererRuntime';
import type { SessionMode } from '../session';
import { SessionDetails } from './SessionDetails';
import { ScenePanel } from './ScenePanel';
import { DocumentPanel } from './DocumentPanel';
import { Diagnostics } from './Diagnostics';
const tabs = [
  { id: 'session', label: 'Session', icon: SlidersHorizontal },
  { id: 'topics', label: 'Topics', icon: Layers },
  { id: 'outline', label: 'Scene outline', icon: ListTree },
  { id: 'properties', label: 'Selection properties', icon: Settings2 },
  { id: 'document', label: 'Document', icon: FileText },
  { id: 'keyboard', label: 'Keyboard & navigation', icon: Keyboard },
  { id: 'developer', label: 'Developer tools', icon: Wrench },
] as const;
type Tab = (typeof tabs)[number]['id'];
export function PanelSections({
  runtime,
  mode,
  focusCanvas,
}: {
  runtime: RendererRuntime;
  mode: SessionMode;
  focusCanvas: () => void;
}) {
  const [active, setActive] = useState<Tab>('session');
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActive(tabs[next]!.id);
    document.getElementById('board-tab-' + tabs[next]!.id)?.focus();
  }
  return (
    <div className="panel-sections">
      <div className="panel-section-header">
        <h2>Session & board</h2>
        <div className="panel-tabs" role="tablist" aria-label="Session & board sections">
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              id={'board-tab-' + id}
              role="tab"
              aria-label={label}
              title={label}
              aria-selected={active === id}
              aria-controls={'board-content-' + id}
              tabIndex={active === id ? 0 : -1}
              onClick={() => setActive(id)}
              onKeyDown={(event) => navigate(event, index)}
            >
              <Icon size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div className="panel-section-body">
        {tabs.map(({ id }) => (
          <div
            key={id}
            role="tabpanel"
            id={'board-content-' + id}
            aria-labelledby={'board-tab-' + id}
            hidden={active !== id}
            tabIndex={0}
          >
            {id === 'session' && <SessionDetails runtime={runtime} mode={mode} />}
            {(id === 'topics' || id === 'outline' || id === 'properties') && (
              <ScenePanel runtime={runtime} view={id} />
            )}
            {id === 'document' && <DocumentPanel runtime={runtime} />}
            {id === 'developer' && <Diagnostics runtime={runtime} expanded />}
            {id === 'keyboard' && (
              <section aria-label="Keyboard & navigation">
                <h2>Keyboard & navigation</h2>
                <p>
                  V select · H hand · R rectangle · Shift+R rounded rectangle · C circle · O ellipse
                  · D diamond · T text · A arrow · L line.
                </p>
                <p>
                  Arrow keys move the selected nodes; Shift moves 10 units. Enter edits a selected
                  label. Escape cancels. Ctrl/Cmd+Z undoes, Ctrl/Cmd+D duplicates. These shortcuts
                  stay off while using controls or typing.
                </p>
                <button onClick={focusCanvas}>Focus canvas</button>
                <p>
                  Scroll up to zoom in and down to zoom out at the pointer. Shift+scroll pans. Drag
                  with Hand, hold Space, or drag the middle mouse button to pan.
                </p>
              </section>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
