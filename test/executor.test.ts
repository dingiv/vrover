import { describe, expect, it } from 'vitest';
import type { Platform, Screenshot, UiElement } from '@vrover/platform';
import type { SoMElement } from '@vrover/som';
import { dispatch } from '@vrover/tools';

/** Minimal Platform that records what the executor drove it to do. */
class RecordingPlatform implements Platform {
  clicks: Array<[number, number]> = [];
  typed: string[] = [];
  keys: string[] = [];

  async captureScreen(): Promise<Screenshot> {
    return { width: 1, height: 1, png: Buffer.alloc(0) };
  }
  async getElements(): Promise<UiElement[]> {
    return [];
  }
  async performClick(x: number, y: number): Promise<void> {
    this.clicks.push([x, y]);
  }
  async performType(text: string): Promise<void> {
    this.typed.push(text);
  }
  async performScroll(): Promise<void> {}
  async performKeypress(keys: string): Promise<void> {
    this.keys.push(keys);
  }
}

const table: SoMElement[] = [
  {
    mark: 1,
    description: '[input] Name',
    element: { id: 'name', role: 'input', label: 'Name', bounds: { x: 100, y: 200, width: 40, height: 20 } },
  },
];

describe('executor (mark → coordinate → Platform)', () => {
  it('clicks the center of the element for the given mark', async () => {
    const p = new RecordingPlatform();
    const r = await dispatch('click', { mark: 1 }, table, p);
    // center of {100,200,40,20} = (120, 210)
    expect(p.clicks).toEqual([[120, 210]]);
    expect(r.finished).toBe(false);
    expect(r.message).toContain('[input] Name');
  });

  it('focuses (clicks) then types', async () => {
    const p = new RecordingPlatform();
    await dispatch('type', { mark: 1, text: 'hi' }, table, p);
    expect(p.clicks).toHaveLength(1);
    expect(p.typed).toEqual(['hi']);
  });

  it('done is terminal', async () => {
    const p = new RecordingPlatform();
    const r = await dispatch('done', { summary: 'all set' }, table, p);
    expect(r.finished).toBe(true);
    expect(r.summary).toBe('all set');
  });

  it('throws on an unknown mark', async () => {
    const p = new RecordingPlatform();
    await expect(dispatch('click', { mark: 99 }, table, p)).rejects.toThrow(/No element with mark 99/);
  });
});
