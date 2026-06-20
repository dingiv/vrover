import { describe, expect, it } from 'vitest';
import { MultiScreenPlatform } from '../src/platform/multi-screen.js';
import { centerOf } from '../src/platform/types.js';

describe('MultiScreenPlatform', () => {
  it('shows the login screen first', async () => {
    const p = new MultiScreenPlatform();
    expect(p.currentScreen).toBe('login');
    const ids = (await p.getElements()).map((e) => e.id);
    expect(ids).toEqual(['username', 'password', 'login', 'forgot']);
  });

  it('renders a real PNG of the login screen', async () => {
    const p = new MultiScreenPlatform();
    const s = await p.captureScreen();
    expect(s.width).toBe(1280);
    expect(s.height).toBe(800);
    expect(s.png.length).toBeGreaterThan(0);
  });

  it('logs in via center-of-bounds clicks + typing, then shows home', async () => {
    const p = new MultiScreenPlatform();
    const els = await p.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

    await p.performClick(at('username').x, at('username').y);
    await p.performType('admin');
    await p.performClick(at('password').x, at('password').y);
    await p.performType('hunter2');
    await p.performClick(at('login').x, at('login').y);

    expect(p.isLoggedIn).toBe(true);
    expect(p.currentScreen).toBe('home');
    const homeIds = (await p.getElements()).map((e) => e.id);
    expect(homeIds).toEqual(['articles', 'profile', 'logout']);
  });

  it('logs out back to the login screen', async () => {
    const p = new MultiScreenPlatform();
    const els = await p.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);
    await p.performClick(at('username').x, at('username').y);
    await p.performType('admin');
    await p.performClick(at('password').x, at('password').y);
    await p.performType('hunter2');
    await p.performClick(at('login').x, at('login').y);
    expect(p.isLoggedIn).toBe(true);

    const homeEls = await p.getElements();
    const logout = centerOf(homeEls.find((e) => e.id === 'logout')!.bounds);
    await p.performClick(logout.x, logout.y);

    expect(p.currentScreen).toBe('login');
    expect(p.isLoggedIn).toBe(false);
  });

  it('ignores clicks outside any element', async () => {
    const p = new MultiScreenPlatform();
    await p.performClick(5, 5); // top-left corner, no element
    expect(p.currentScreen).toBe('login');
  });
});
