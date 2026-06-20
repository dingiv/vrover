import { describe, expect, it } from 'vitest';
import type { HandshakeRequest } from '@vrover/scout-protocol';
import { BACKENDS, DEFAULT_BACKEND, resolveBackend } from '../apps/visual_scout/src/backends.js';

/**
 * Unit tests for the visual-scout app's pure backend resolution: how a client's handshake
 * `backend` hint and the CLI default combine to pick the per-session terminal. No sockets,
 * no key — just the registry logic.
 */
describe('visual-scout backend resolution', () => {
  it('uses the CLI default when the client sends no hint', () => {
    expect(resolveBackend(undefined, 'mock').name).toBe('mock');
    expect(resolveBackend({}, 'multi-screen').name).toBe('multi-screen');
  });

  it('honors a recognized client handshake hint over the CLI default', () => {
    const req: HandshakeRequest = { backend: 'mock' };
    expect(resolveBackend(req, 'multi-screen').name).toBe('mock');
  });

  it('falls back to the CLI default for an unknown hint', () => {
    const req: HandshakeRequest = { backend: 'no-such-backend' };
    expect(resolveBackend(req, 'mock').name).toBe('mock');
  });

  it('falls back to the built-in default for an unknown CLI default', () => {
    expect(resolveBackend(undefined, 'bogus').name).toBe(DEFAULT_BACKEND);
  });

  it('mints a fresh Platform instance per call (per-session isolation)', () => {
    const req: HandshakeRequest = { backend: 'multi-screen' };
    const a = resolveBackend(req, 'mock').create();
    const b = resolveBackend(req, 'mock').create();
    expect(a).not.toBe(b);
  });

  it('creates a Platform with the expected primitive for every known backend', () => {
    for (const name of Object.keys(BACKENDS)) {
      const platform = BACKENDS[name]!.create();
      expect(typeof platform.captureScreen).toBe('function');
    }
  });
});
