import { describe, expect, it } from 'vitest';
import { MockPlatform, centerOf } from '@vrover/platform';

describe('MockPlatform', () => {
  it('exposes the interactive elements', async () => {
    const p = new MockPlatform();
    const ids = (await p.getElements()).map((e) => e.id);
    expect(ids).toEqual(['username', 'password', 'login', 'forgot']);
  });

  it('renders a real PNG screenshot', async () => {
    const p = new MockPlatform();
    const s = await p.captureScreen();
    expect(s.width).toBe(1280);
    expect(s.height).toBe(800);
    expect(s.png.length).toBeGreaterThan(0);
  });

  it('completes the login flow via center-of-bounds clicks + typing', async () => {
    const p = new MockPlatform();
    const els = await p.getElements();
    const byId = (id: string) => els.find((e) => e.id === id)!;
    const at = (id: string) => centerOf(byId(id).bounds);

    await p.performClick(at('username').x, at('username').y);
    await p.performType('admin');
    await p.performClick(at('password').x, at('password').y);
    await p.performType('hunter2');
    expect(p.isLoggedIn).toBe(false);

    await p.performClick(at('login').x, at('login').y);
    expect(p.isLoggedIn).toBe(true);
  });

  it('refuses login when a field is empty', async () => {
    const p = new MockPlatform();
    const els = await p.getElements();
    const login = centerOf(els.find((e) => e.id === 'login')!.bounds);
    await p.performClick(login.x, login.y);
    expect(p.isLoggedIn).toBe(false);
  });

  it('ignores clicks outside any element', async () => {
    const p = new MockPlatform();
    await p.performClick(5, 5); // top-left corner, no element there
    const s = await p.captureScreen();
    expect(s.png.length).toBeGreaterThan(0);
  });
});
