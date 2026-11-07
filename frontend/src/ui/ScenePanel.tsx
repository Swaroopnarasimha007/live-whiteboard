import { useState, useSyncExternalStore } from 'react';
import type { RendererRuntime } from '../app/rendererRuntime';
import { SelectionProperties } from '../editor';
import { getWorldBounds } from '../layout';
export function ScenePanel({ runtime }: { runtime: RendererRuntime }) {
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
  const sections = Object.values(scene.sections).sort((a, b) => a.order - b.order);
  const active =
    editor.activeSectionId && scene.sections[editor.activeSectionId]
      ? editor.activeSectionId
      : sections[0]?.id;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const connector = editor.tool === 'arrow' || editor.tool === 'line';
  return (
    <>
      {editor.selectedIds.length > 0 && <SelectionProperties editor={runtime.editor} />}
      <section aria-label="Topics">
        <h2>Topics</h2>
        {!sections.length && <p className="muted">Topics appear as your explanation grows.</p>}
        <div className="section-buttons">
          {sections.map((section) => (
            <button
              key={section.id}
              aria-pressed={active === section.id}
              title={`View ${section.title}`}
              onClick={() => {
                runtime.editor.setActiveSection(section.id);
                runtime.viewport.fitSection(section.id, { animate: true });
              }}
            >
              {section.title}
            </button>
          ))}
        </div>
        {active && (
          <details>
            <summary>Rename section</summary>
            <form
              key={active}
              onSubmit={(event) => {
                event.preventDefault();
                runtime.editor.renameSection(
                  active,
                  String(new FormData(event.currentTarget).get('title')),
                );
              }}
            >
              <label>
                Section title
                <input
                  name="title"
                  aria-label="Section title"
                  defaultValue={scene.sections[active]!.title}
                  maxLength={120}
                  required
                />
              </label>
              <button>Save section title</button>
            </form>
          </details>
        )}
      </section>
      <details onToggle={(event) => setOutlineOpen(event.currentTarget.open)}>
        <summary>Scene outline</summary>
        <p>
          Keyboard: activate a shape in the palette to add it at the view centre. Select an object
          here, then use properties or focus the canvas and use arrow keys to move. Choose Arrow or
          Line, then two nodes here to connect.
        </p>
        {outlineOpen && (
          <ul className="scene-outline">
            {sections.map((section) => (
              <li key={section.id}>
                <h3>{section.title}</h3>
                <ul>
                  {Object.values(scene.nodes)
                    .filter((n) => n.sectionId === section.id)
                    .map((node) => (
                      <li key={node.id}>
                        <button
                          aria-pressed={editor.selectedIds.includes(node.id)}
                          aria-label={`${connector ? 'Connect' : 'Select'} ${node.label || 'Empty text'}`}
                          title={`${node.type}, ${node.width} by ${node.height}, ${node.source}${node.locked ? ', locked' : ''}`}
                          onClick={(event) => {
                            if (connector) runtime.editor.connect(node.id);
                            else runtime.editor.select(node.id, event.shiftKey);
                            runtime.viewport.fitBounds(
                              getWorldBounds(node, scene.sections[node.sectionId]!),
                              { animate: true },
                            );
                          }}
                        >
                          {node.label || 'Empty text'}
                          <small>
                            {node.type} · {node.source}
                            {node.locked ? ' · Locked' : ''}
                          </small>
                        </button>
                      </li>
                    ))}
                </ul>
                <ul>
                  {Object.values(scene.edges)
                    .filter((e) => e.sectionId === section.id)
                    .map((edge) => (
                      <li key={edge.id}>
                        <button
                          aria-label={`Select connection ${edge.label || 'unlabelled'} from ${scene.nodes[edge.from]?.label || 'node'} to ${scene.nodes[edge.to]?.label || 'node'}`}
                          aria-pressed={editor.selectedIds.includes(edge.id)}
                          onClick={(event) => runtime.editor.select(edge.id, event.shiftKey)}
                        >
                          {edge.label || 'Connection'}
                          <small>
                            {scene.nodes[edge.from]?.label || 'Node'} to{' '}
                            {scene.nodes[edge.to]?.label || 'Node'}
                            {edge.locked ? ' · Locked' : ''}
                          </small>
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {!sections.length && <p>No objects yet.</p>}
      </details>
    </>
  );
}
