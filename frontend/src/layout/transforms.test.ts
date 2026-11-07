import { expect, it } from 'vitest';
import {
  getWorldBounds,
  screenToWorld,
  sectionToWorld,
  worldToScreen,
  worldToSection,
} from './transforms';

it.each([0.15, 0.5, 1, 2, 4])(
  'round-trips world/section/screen coordinates at %s zoom after panning',
  (scale) => {
    const viewport = { x: -250.5, y: 172.25, scale };
    const section = { origin: { x: 84, y: 1_500 } };
    const local = { x: -32.75, y: 180.5 };
    const world = sectionToWorld(local, section);
    const screen = worldToScreen(world, viewport);
    const back = screenToWorld(screen, viewport);
    const restored = worldToSection(back, section);
    expect(restored.x).toBeCloseTo(local.x);
    expect(restored.y).toBeCloseTo(local.y);
    expect(getWorldBounds({ ...local, width: 120, height: 64 }, section)).toEqual({
      ...world,
      width: 120,
      height: 64,
    });
  },
);
it('rejects zero/negative/non-finite transforms instead of producing NaN', () => {
  for (const scale of [0, -1, Infinity, NaN])
    expect(() => screenToWorld({ x: 1, y: 2 }, { x: 0, y: 0, scale })).toThrow();
  expect(() => worldToScreen({ x: NaN, y: 0 }, { x: 0, y: 0, scale: 1 })).toThrow();
});
