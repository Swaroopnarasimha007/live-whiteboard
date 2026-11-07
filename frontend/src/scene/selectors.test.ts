import { expect, it, vi } from 'vitest';
import { createSectionNodesSelector, selectEntity } from './selectors';
import { setup } from './test-helpers';

it('section selector subscriptions ignore changes confined to another section', () => {
  const { store, addSection, addNode } = setup();
  addSection();
  addSection('g_other');
  addNode();
  const select = createSectionNodesSelector('g_s');
  const initial = select(store.getSnapshot());
  const changed = vi.fn();
  store.subscribeSelector(select, changed);
  addNode('g_elsewhere', 'g_other');
  expect(select(store.getSnapshot())).toBe(initial);
  expect(changed).not.toHaveBeenCalled();
  addNode('g_here');
  expect(changed).toHaveBeenCalledOnce();
  expect(select(store.getSnapshot())).toHaveLength(2);
});

it('entity lookup never returns inherited prototype members', () => {
  const { store } = setup();
  expect(selectEntity(store.getSnapshot(), 'constructor')).toBeUndefined();
  expect(selectEntity(store.getSnapshot(), 'toString')).toBeUndefined();
});
