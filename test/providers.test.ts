import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createOpenAICompatible } from '@vrover/providers';
import type { CompleteRequest } from '@vrover/llm';

/**
 * Unit tests for the OpenAI-compatible adapter. No network: `fetch` is spied and returns a
 * scripted assistant message. Asserts both directions of the translation (our ContentBlock/tool
 * shape ↔ OpenAI messages/tool_calls), the tool-result split, and the id round-trip that keeps
 * multi-turn tool calling linked.
 */
interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** Spy on fetch; reply once per call with a fake assistant message. Returns the captured calls. */
function mockFetch(reply: {
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  finish_reason?: string;
}): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: reply.content ?? null, tool_calls: reply.tool_calls },
            finish_reason: reply.finish_reason ?? 'stop',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { calls };
}

function bodyOf(c: CapturedCall): any {
  return JSON.parse(String(c.init.body));
}

const baseReq: CompleteRequest = {
  system: 'SYS',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
};

describe('openai-compatible adapter', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prepends a system message, sends plain text as a string, omits tools when empty, sends Bearer when keyed', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' });
    await complete(baseReq);

    const b = bodyOf(calls[0]!);
    expect(calls[0]!.url).toBe('http://x/v1/chat/completions');
    expect(b.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(b.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(b.max_tokens).toBe(4096);
    expect(b).not.toHaveProperty('tools'); // empty tools omitted (some servers reject tools: [])
    expect(b.model).toBe('m');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer k' });
  });

  it('encodes image blocks as image_url data URLs', async () => {
    const { calls } = mockFetch({ content: 'seen' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    await complete({
      system: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/png', data: Buffer.from([1, 2, 3]) },
            { type: 'text', text: 'annotate' },
          ],
        },
      ],
      tools: [],
    });
    const content = bodyOf(calls[0]!).messages[0].content; // no system (empty) → user is first
    // blocks are preserved in order: image first (as the loop sends it), then text
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
    expect(content[1]).toEqual({ type: 'text', text: 'annotate' });
  });

  it('maps assistant tool_use → tool_calls with JSON-string arguments and null content', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    await complete({
      system: '',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'click', input: { mark: 1 } }] },
      ],
      tools: [],
    });
    expect(bodyOf(calls[0]!).messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'click', arguments: '{"mark":1}' } }],
    });
  });

  it('keeps assistant text alongside tool_calls', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    await complete({
      system: '',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'clicking' },
            { type: 'tool_use', id: 'tu_1', name: 'click', input: { mark: 2 } },
          ],
        },
      ],
      tools: [],
    });
    expect(bodyOf(calls[0]!).messages[0]).toEqual({
      role: 'assistant',
      content: 'clicking',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'click', arguments: '{"mark":2}' } }],
    });
  });

  it('splits one tool_result user message into separate tool-role messages (is_error dropped)', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    await complete({
      system: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'clicked' },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'Error: boom', is_error: true },
          ],
        },
      ],
      tools: [],
    });
    const msgs = bodyOf(calls[0]!).messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'tool', content: 'clicked', tool_call_id: 'tu_1' });
    expect(msgs[1]).toEqual({ role: 'tool', content: 'Error: boom', tool_call_id: 'tu_2' });
  });

  it('maps tools to function parameters, preserving input_schema verbatim', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    const schema = { type: 'object', properties: { mark: { type: 'number' } }, required: ['mark'] };
    await complete({ system: '', messages: [], tools: [{ name: 'click', description: 'd', input_schema: schema }] });
    expect(bodyOf(calls[0]!).tools).toEqual([
      { type: 'function', function: { name: 'click', description: 'd', parameters: schema } },
    ]);
  });

  it('round-trips the server tool_call id into toolUses[].id and raw[].id; parses arguments', async () => {
    mockFetch({
      content: null,
      tool_calls: [{ id: 'call_42', function: { name: 'click', arguments: '{"mark":7}' } }],
      finish_reason: 'tool_calls',
    });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    const resp = await complete(baseReq);

    expect(resp.text).toBeNull();
    expect(resp.stopReason).toBe('tool_calls');
    expect(resp.toolUses).toEqual([{ id: 'call_42', name: 'click', input: { mark: 7 } }]);
    expect(resp.raw).toContainEqual({ type: 'tool_use', id: 'call_42', name: 'click', input: { mark: 7 } });
  });

  it('falls back to { _raw } when arguments are not valid JSON (id still preserved)', async () => {
    mockFetch({ content: null, tool_calls: [{ id: 'c1', function: { name: 'click', arguments: 'not-json{' } }] });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    const resp = await complete(baseReq);

    expect(resp.toolUses[0]!.input).toEqual({ _raw: 'not-json{' });
    expect(resp.raw.find((b) => b.type === 'tool_use')).toMatchObject({ id: 'c1' });
  });

  it('throws on non-2xx with the response body in the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom detail', { status: 500 }));
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' });
    await expect(complete(baseReq)).rejects.toThrow(/HTTP 500.*boom detail/);
  });

  it('omits Authorization when apiKey is empty (no-auth local servers)', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1', model: 'm' }); // no apiKey
    await complete(baseReq);
    expect(calls[0]!.init.headers).not.toHaveProperty('authorization');
  });

  it('strips a trailing slash from baseUrl before appending /chat/completions', async () => {
    const { calls } = mockFetch({ content: 'ok' });
    const complete = createOpenAICompatible({ baseUrl: 'http://x/v1/', model: 'm' });
    await complete(baseReq);
    expect(calls[0]!.url).toBe('http://x/v1/chat/completions');
  });
});
