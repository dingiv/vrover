import { describe, expect, it } from 'vitest';
import { CalculatorPlatform, centerOf } from '@vrover/platform';

describe('CalculatorPlatform', () => {
  it('exposes the display then the 4×5 button grid', async () => {
    const p = new CalculatorPlatform();
    const ids = (await p.getElements()).map((e) => e.id);
    expect(ids).toEqual([
      'display',
      'clear', 'lparen', 'rparen', 'div',
      'd7', 'd8', 'd9', 'mul',
      'd4', 'd5', 'd6', 'sub',
      'd1', 'd2', 'd3', 'add',
      'd0', 'dot', 'back', 'eq',
    ]);
  });

  it('renders a real 1280×800 PNG', async () => {
    const p = new CalculatorPlatform();
    const s = await p.captureScreen();
    expect(s.width).toBe(1280);
    expect(s.height).toBe(800);
    expect(s.png.length).toBeGreaterThan(0);
  });

  it('starts with an empty (zero) display', () => {
    expect(new CalculatorPlatform().display).toBe('0');
  });

  it('reproduces the readme scenario: type "1+1", click "=", get "1+1 = 2"', async () => {
    const p = new CalculatorPlatform();
    const els = await p.getElements();
    const eq = centerOf(els.find((e) => e.id === 'eq')!.bounds);

    await p.performType('1+1');
    expect(p.display).toBe('1+1');

    await p.performClick(eq.x, eq.y);
    expect(p.display).toBe('1+1 = 2');
    expect(p.currentResult).toBe('2');
  });

  it('also works by clicking the buttons one at a time', async () => {
    const p = new CalculatorPlatform();
    const els = await p.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

    await p.performClick(at('d2').x, at('d2').y);
    await p.performClick(at('mul').x, at('mul').y);
    await p.performClick(at('d3').x, at('d3').y);
    await p.performClick(at('eq').x, at('eq').y);

    expect(p.display).toBe('2×3 = 6');
  });

  it('evaluates parentheses and trims float noise', async () => {
    const p = new CalculatorPlatform();
    await p.performType('(1+2)*3');
    await p.performKeypress('Return');
    expect(p.display).toBe('(1+2)×3 = 9');

    const q = new CalculatorPlatform();
    await q.performType('0.1+0.2');
    await q.performKeypress('=');
    expect(q.display).toBe('0.1+0.2 = 0.3');
  });

  it('shows Error on divide-by-zero and recovers on the next input', async () => {
    const p = new CalculatorPlatform();
    await p.performType('1/0');
    await p.performKeypress('=');
    expect(p.isError).toBe(true);
    expect(p.display).toBe('Error');

    // Any further digit clears the error and starts fresh.
    await p.performType('5');
    expect(p.isError).toBe(false);
    expect(p.display).toBe('5');
  });

  it('clears and backspaces', async () => {
    const p = new CalculatorPlatform();
    const els = await p.getElements();
    const at = (id: string) => centerOf(els.find((e) => e.id === id)!.bounds);

    await p.performType('123');
    expect(p.display).toBe('123');

    await p.performClick(at('back').x, at('back').y);
    expect(p.display).toBe('12');

    await p.performClick(at('clear').x, at('clear').y);
    expect(p.display).toBe('0');
  });

  it('continues from a result when an operator follows it', async () => {
    const p = new CalculatorPlatform();
    await p.performType('2+2');
    await p.performKeypress('=');
    expect(p.display).toBe('2+2 = 4');

    // Operator after `=` keeps the result; digit starts over.
    await p.performType('+5');
    await p.performKeypress('=');
    expect(p.display).toBe('4+5 = 9');
  });

  it('ignores clicks outside any element', async () => {
    const p = new CalculatorPlatform();
    await p.performClick(5, 5); // top-left corner of the desktop, no element
    expect(p.display).toBe('0');
    const s = await p.captureScreen();
    expect(s.png.length).toBeGreaterThan(0);
  });
});
