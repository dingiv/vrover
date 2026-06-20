import net from 'node:net';
import type { Platform, Screenshot, UiElement } from './types.js';
import {
  FrameDecoder,
  MsgType,
  decodeCaptureBlob,
  encodeJsonFrame,
  type Frame,
} from '../scout/protocol.js';
import {
  parseHandshakeAck,
  type ElementsResult,
  type ErrorPayload,
  type HandshakeAck,
  type HandshakeRequest,
  type Request,
} from '../scout/api.js';

/**
 * Brain-side {@link Platform} that talks to a Visual Scout server over the custom
 * TCP protocol (`../scout/protocol.ts`). A drop-in replacement for
 * {@link MockPlatform}: pass it to `runAgent({ platform: new RemotePlatform(host, port) })`
 * and the agent operates whatever backend the Scout server is driving, over the
 * network — the D10 component split, brain ⇄ Scout as separate processes.
 *
 * One long-lived connection per instance. Construction opens the socket and sends
 * a {@link MsgType.HAND_SHAKE}; {@link ready} resolves with the server's ack
 * (assigning the session id). Every {@link Platform} method awaits {@link ready},
 * sends a {@link MsgType.REQUEST} with a unique correlation id, and resolves on
 * the matching {@link MsgType.RESULT}/{@link MsgType.BLOB} (or rejects on
 * {@link MsgType.ERROR}). Screenshots arrive as a raw binary BLOB — no base64.
 */
export class RemotePlatform implements Platform {
  readonly host: string;
  readonly port: number;

  /** Resolves with the handshake ack once the session is established. */
  readonly ready: Promise<HandshakeAck>;

  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, { resolve: (f: Frame) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private torn = false;
  private resolveReady!: (ack: HandshakeAck) => void;
  private rejectReady!: (err: Error) => void;

  constructor(host: string, port: number, req: HandshakeRequest = {}) {
    this.host = host;
    this.port = port;
    this.ready = new Promise<HandshakeAck>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.socket = net.createConnection({ host, port });
    this.socket.on('connect', () => {
      this.socket.write(encodeJsonFrame(MsgType.HAND_SHAKE, 0, req));
    });
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err) => this.teardown(err));
    this.socket.on('close', () => this.teardown(new Error('connection closed')));
  }

  /** Convenience for clients/tests: the ack info, as a small health object. */
  async health(): Promise<{ ok: true; backend: string; sessionId: string }> {
    const ack = await this.ready;
    return { ok: true, backend: ack.backend, sessionId: ack.sessionId };
  }

  async captureScreen(): Promise<Screenshot> {
    const frame = await this.call({ method: 'capture' });
    if (frame.type !== MsgType.BLOB) {
      throw new Error(`capture: expected BLOB reply, got 0x${frame.type.toString(16)}`);
    }
    return decodeCaptureBlob(frame.payload);
  }

  async getElements(): Promise<UiElement[]> {
    const frame = await this.call({ method: 'elements' });
    const body = JSON.parse(frame.payload.toString('utf8')) as ElementsResult;
    return body.elements;
  }

  async performClick(x: number, y: number): Promise<void> {
    await this.act({ method: 'click', x, y });
  }

  async performType(text: string): Promise<void> {
    await this.act({ method: 'type', text });
  }

  async performScroll(x: number, y: number, direction: 'up' | 'down'): Promise<void> {
    await this.act({ method: 'scroll', x, y, direction });
  }

  async performKeypress(keys: string): Promise<void> {
    await this.act({ method: 'keypress', keys });
  }

  /** Close the connection. Pending calls reject with a 'client closed' error. */
  close(): void {
    this.teardown(new Error('client closed'));
    this.socket.destroy();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Send a request, await its matching reply frame. */
  private call(req: Request): Promise<Frame> {
    return this.ready.then(
      () =>
        new Promise<Frame>((resolve, reject) => {
          const id = this.nextId();
          this.pending.set(id, { resolve, reject }); // set before write so teardown sees it
          this.socket.write(encodeJsonFrame(MsgType.REQUEST, id, req));
        }),
    );
  }

  /** Fire an action request and assert the ok result. */
  private async act(req: Request): Promise<void> {
    await this.call(req); // RESULT { ok: true } (or ERROR → rejected)
  }

  private nextId(): number {
    this.seq = (this.seq + 1) >>> 0;
    if (this.seq === 0) this.seq = 1; // 0 is reserved for handshake
    return this.seq;
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.teardown(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: Frame): void {
    switch (frame.type) {
      case MsgType.HAND_SHAKE_ACK: {
        try {
          this.resolveReady(parseHandshakeAck(frame));
        } catch (err) {
          this.teardown(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      case MsgType.ERROR: {
        const error = (safeJson(frame.payload) as ErrorPayload | null)?.error ?? 'unknown error';
        if (frame.id === 0) this.rejectReady(new Error(error));
        else this.settle(frame.id, null, new Error(error));
        return;
      }
      case MsgType.RESULT:
      case MsgType.BLOB: {
        this.settle(frame.id, frame, null);
        return;
      }
      default:
        return; // unexpected frame type — ignore
    }
  }

  /** Resolve/reject a pending request by id, then drop it. */
  private settle(id: number, frame: Frame | null, err: Error | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(frame!);
  }

  /** Idempotent teardown: fail the handshake + all pending calls. */
  private teardown(err: Error): void {
    if (this.torn) return;
    this.torn = true;
    this.rejectReady(err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

function safeJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}
