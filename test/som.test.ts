import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { annotate, formatTable } from '../src/som/index.js';
import type { Screenshot, UiElement } from '../src/platform/types.js';

function shot(): Screenshot {
  const c = createCanvas(200, 150);
  c.getContext('2d').fillStyle = '#fff';
  c.getContext('2d').fillRect(0, 0, 200, 150);
  return { width: 200, height: 150, png: c.toBuffer('image/png') };
}

const elements: UiElement[] = [
  { id: 'a', role: 'button', label: 'OK', bounds: { x: 10, y: 10, width: 40, height: 20 } },
  { id: 'b', role: 'input', label: 'Name', bounds: { x: 10, y: 50, width: 80, height: 24 } },
  { id: 'c', role: 'link', label: 'Help', bounds: { x: 10, y: 90, width: 30, height: 16 } },
];

describe('annotate (Set-of-Mark)', () => {
  it('assigns 1-based marks in order and builds the table', () => {
    const { table } = annotate(shot(), elements);
    expect(table.map((e) => e.mark)).toEqual([1, 2, 3]);
    expect(table[0]!.description).toBe('[button] OK');
  });

  it('emits a real annotated PNG of the same dimensions', () => {
    const { annotated } = annotate(shot(), elements);
    expect(annotated.width).toBe(200);
    expect(annotated.height).toBe(150);
    expect(annotated.png.length).toBeGreaterThan(0);
  });

  it('respects maxElements', () => {
    const { table } = annotate(shot(), elements, { maxElements: 2 });
    expect(table).toHaveLength(2);
  });

  it('formatTable renders "mark: [role] label"', () => {
    const { table } = annotate(shot(), elements);
    expect(formatTable(table)).toBe('1: [button] OK\n2: [input] Name\n3: [link] Help');
  });
});
