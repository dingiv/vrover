import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arraySink,
  consoleSink,
  createLogger,
  enabledFor,
  getDefaultLevel,
  getRootLogger,
  parseLevel,
  setDefaultLevel,
  setDefaultSink,
  type LogRecord,
} from '@vrover/logger';

const ORIGINAL_LOG_LEVEL = process.env['LOG_LEVEL'];

afterEach(() => {
  // restore global defaults between tests
  setDefaultLevel(parseLevel(ORIGINAL_LOG_LEVEL, 'info'));
  setDefaultSink(consoleSink);
  if (ORIGINAL_LOG_LEVEL === undefined) delete process.env['LOG_LEVEL'];
  else process.env['LOG_LEVEL'] = ORIGINAL_LOG_LEVEL;
});

describe('levels', () => {
  it('enabledFor respects severity ordering', () => {
    expect(enabledFor('warn', 'error')).toBe(true);
    expect(enabledFor('warn', 'warn')).toBe(true);
    expect(enabledFor('warn', 'info')).toBe(false);
    expect(enabledFor('silent', 'error')).toBe(false);
  });

  it('parseLevel is case-insensitive and falls back on bad input', () => {
    expect(parseLevel('INFO', 'debug')).toBe('info');
    expect(parseLevel('  Warn ', 'info')).toBe('warn');
    expect(parseLevel('silent', 'info')).toBe('silent');
    expect(parseLevel('nope', 'info')).toBe('info');
    expect(parseLevel(undefined, 'debug')).toBe('debug');
  });
});

describe('createLogger — filtering & format', () => {
  it('filters by level and routes through the sink', () => {
    const { sink, records } = arraySink();
    const log = createLogger('flt', { level: 'warn', sink });
    log.debug('nope');
    log.info('nope');
    log.warn('shown');
    log.error('also');
    expect(records.map((r) => r.message)).toEqual(['shown', 'also']);
  });

  it('delivers both the structured record and the unified formatted line', () => {
    const seen: Array<{ rec: LogRecord; line: string }> = [];
    const log = createLogger('fmt', {
      level: 'info',
      sink: (rec, line) => seen.push({ rec, line }),
    });
    log.warn('hello', { a: 1 });

    expect(seen).toHaveLength(1);
    const { rec, line } = seen[0]!;
    expect(rec.level).toBe('warn');
    expect(rec.name).toBe('fmt');
    expect(rec.message).toBe('hello');
    expect(rec.args).toEqual([{ a: 1 }]);

    // unified format: `ISO WARN  [fmt] hello <args>`
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN  \[fmt\] hello \{ a: 1 \}$/);
  });

  it('omits the args segment when there are none', () => {
    const seen: string[] = [];
    const log = createLogger('plain', { level: 'info', sink: (_r, line) => seen.push(line) });
    log.info('just a message');
    expect(seen[0]).toMatch(/^\S+ INFO  \[plain\] just a message$/);
  });

  it('string args are joined verbatim, objects inspected', () => {
    const seen: string[] = [];
    const log = createLogger('args', { level: 'info', sink: (_r, line) => seen.push(line) });
    log.info('count', 3, 'ok');
    expect(seen[0]).toMatch(/\] count 3 ok$/);
  });
});

describe('reading & setting the level', () => {
  it('getLevel reflects the override, then the global default', () => {
    setDefaultLevel('error');
    const log = createLogger('a');
    expect(log.getLevel()).toBe('error'); // follows default
    expect(log.isLevelActive('warn')).toBe(false);

    log.setLevel('debug');
    expect(log.getLevel()).toBe('debug');
    expect(log.isLevelActive('debug')).toBe(true); // at threshold
    expect(log.isLevelActive('trace')).toBe(false); // below threshold
  });

  it('setDefaultLevel reconfigures existing no-override loggers live', () => {
    const { sink, records } = arraySink();
    const log = createLogger('live', { sink });
    expect(log.getLevel()).toBe('info');
    log.debug('nope');
    expect(records).toHaveLength(0);

    setDefaultLevel('debug');
    expect(log.getLevel()).toBe('debug');
    log.debug('now');
    expect(records.map((r) => r.message)).toEqual(['now']);
  });
});

describe('replacing the output target', () => {
  it('setSink swaps the per-logger target', () => {
    const first = arraySink();
    const second = arraySink();
    const log = createLogger('swap', { level: 'info', sink: first.sink });
    log.info('one');
    log.setSink(second.sink);
    log.info('two');
    expect(first.records.map((r) => r.message)).toEqual(['one']);
    expect(second.records.map((r) => r.message)).toEqual(['two']);
  });

  it('setDefaultSink changes the global default for loggers without an explicit sink', () => {
    const { sink, records } = arraySink();
    setDefaultSink(sink);
    const log = createLogger('glob');
    log.info('captured');
    expect(records.map((r) => r.message)).toEqual(['captured']);
  });
});

describe('child loggers', () => {
  it('has a hierarchical name and inherits the sink', () => {
    const { sink, records } = arraySink();
    const parent = createLogger('scout', { level: 'info', sink });
    const child = parent.child('server');
    expect(child.name).toBe('scout/server');
    child.info('hi');
    expect(records[0]!.name).toBe('scout/server');
  });

  it('resolves its level independently after creation', () => {
    const parent = createLogger('p', { level: 'warn' });
    const child = parent.child('c');
    expect(child.getLevel()).toBe('warn'); // inherited snapshot
    parent.setLevel('error');
    expect(child.getLevel()).toBe('warn'); // independent thereafter
  });
});

describe('getRootLogger', () => {
  it('is lazily created and cached (memoized singleton)', () => {
    const a = getRootLogger();
    const b = getRootLogger();
    expect(a).toBe(b); // same reference — created once, then reused
    expect(a.name).toBe('vrover');
  });

  it('routes through the live global default sink like any logger', () => {
    const { sink, records } = arraySink();
    setDefaultSink(sink);
    getRootLogger().info('root line');
    expect(records[0]!.name).toBe('vrover');
  });
});

describe('default level from env', () => {
  it('resolves LOG_LEVEL lazily on first read', async () => {
    process.env['LOG_LEVEL'] = 'debug';
    vi.resetModules();
    const mod = await import('@vrover/logger');
    expect(mod.getDefaultLevel()).toBe('debug');
    vi.resetModules(); // drop the freshly-imported instance
  });

  it('falls back to info when LOG_LEVEL is unset', async () => {
    delete process.env['LOG_LEVEL'];
    vi.resetModules();
    const mod = await import('@vrover/logger');
    expect(mod.getDefaultLevel()).toBe('info');
    vi.resetModules();
  });
});

// `getDefaultLevel` here is the top-level (original-instance) import; the resetModules tests above
// spin up separate instances, so re-assert the original is restored for the suite's other tests.
it('global default is restored after the suite', () => {
  expect(getDefaultLevel()).toBe(parseLevel(ORIGINAL_LOG_LEVEL, 'info'));
});
