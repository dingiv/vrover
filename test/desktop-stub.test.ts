import { describe, expect, it } from 'vitest';
import { DesktopPlatform, type NativeLayer } from '@vrover/platform';

/**
 * The Rust seam is reserved but not wired this iteration. Without a NativeLayer,
 * every DesktopPlatform method must fail fast with a message pointing at the missing
 * native module; with one, it delegates. This keeps the seam explicit and honest.
 */
describe('DesktopPlatform (reserved Rust seam)', () => {
  it('fails fast and clearly when no native layer is wired', async () => {
    const p = new DesktopPlatform();
    await expect(p.captureScreen()).rejects.toThrow(/not available/i);
    await expect(p.getElements()).rejects.toThrow(/not available/i);
    await expect(p.performClick(0, 0)).rejects.toThrow(/not available/i);
  });

  it('delegates to a provided NativeLayer', async () => {
    const clicks: Array<[number, number]> = [];
    const typed: string[] = [];
    const native: NativeLayer = {
      async captureScreen() {
        return { width: 2, height: 2, png: Buffer.from('hi') };
      },
      async performClick(x, y) {
        clicks.push([x, y]);
      },
      async performType(text) {
        typed.push(text);
      },
      async performScroll() {},
      async performKeypress() {},
      async getAccessibilityElements() {
        return [];
      },
    };

    const p = new DesktopPlatform(native);
    const shot = await p.captureScreen();
    expect(shot.png.toString()).toBe('hi');
    expect(await p.getElements()).toEqual([]);
    await p.performClick(3, 4);
    await p.performType('x');
    expect(clicks).toEqual([[3, 4]]);
    expect(typed).toEqual(['x']);
  });
});
