import { describe, expect, it } from 'vitest';
import { prompts, render } from '@vrover/agent';

/** Prompt registry: named, templated prompts rendered by the agent loop. */
describe('prompt registry', () => {
  it('renders the system prompt verbatim (no vars)', () => {
    expect(prompts.render('system')).toBe(prompts.get('system'));
    expect(prompts.render('system')).toMatch(/You are VRover/);
  });

  it('substitutes {{step}} and {{elementTable}} into the step prompt', () => {
    const out = render('step', { step: 3, elementTable: '1: [button] Login' });
    expect(out).toBe(
      'Current screen (step 3). Interactive elements (refer by mark number):\n1: [button] Login',
    );
    expect(out).not.toContain('{{');
  });

  it('leaves unknown placeholders untouched (no crash)', () => {
    // {{elementTable}} not provided → stays literal rather than vanishing.
    expect(render('step', { step: 1 })).toContain('{{elementTable}}');
  });

  it('renders the nudge prompt', () => {
    expect(prompts.render('nudge')).toMatch(/tool/);
  });
});
