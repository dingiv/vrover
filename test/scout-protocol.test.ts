import { describe, expect, it } from 'vitest';
import {
  HEADER_SIZE,
  MAGIC,
  VERSION,
  FrameDecoder,
  MsgType,
  decodeCaptureBlob,
  encodeCaptureBlob,
  encodeFrame,
  encodeJsonFrame,
  type Frame,
} from '../src/scout/protocol.js';

/**
 * Unit tests for the wire protocol: framing encode/decode, split-chunk
 * reassembly, the capture BLOB layout, and bad-frame rejection. Pure bytes —
 * no sockets, no server.
 */

describe('scout wire protocol', () => {
  it('encodes a frame with the magic header, version, type, id, and length', () => {
    const body = Buffer.from('{"ok":true}', 'utf8');
    const f = encodeFrame(MsgType.RESULT, 7, body);
    expect(f.length).toBe(HEADER_SIZE + body.length);
    expect([f.readUInt8(0), f.readUInt8(1)]).toEqual([...MAGIC]);
    expect(f.readUInt8(2)).toBe(VERSION);
    expect(f.readUInt8(3)).toBe(MsgType.RESULT);
    expect(f.readUInt32BE(4)).toBe(7);
    expect(f.readUInt32BE(8)).toBe(body.length);
    expect(f.subarray(HEADER_SIZE).toString('utf8')).toBe('{"ok":true}');
  });

  it('decodes a JSON control frame round-trip', () => {
    const enc = encodeJsonFrame(MsgType.HAND_SHAKE, 0, { client: 'brain', backend: 'multi-screen' });
    const frames = new FrameDecoder().push(enc);
    expect(frames).toHaveLength(1);
    const f: Frame = frames[0]!;
    expect(f.type).toBe(MsgType.HAND_SHAKE);
    expect(f.id).toBe(0);
    expect(JSON.parse(f.payload.toString('utf8'))).toEqual({ client: 'brain', backend: 'multi-screen' });
  });

  it('reassembles a frame fed one byte at a time', () => {
    const enc = encodeJsonFrame(MsgType.RESULT, 42, { ok: true });
    const dec = new FrameDecoder();
    let frames: Frame[] = [];
    for (let i = 0; i < enc.length; i++) {
      frames = dec.push(enc.subarray(i, i + 1));
      if (i < enc.length - 1) expect(frames).toHaveLength(0);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(42);
  });

  it('decodes multiple frames packed into one chunk', () => {
    const a = encodeJsonFrame(MsgType.RESULT, 1, { ok: true });
    const b = encodeJsonFrame(MsgType.RESULT, 2, { ok: true });
    const frames = new FrameDecoder().push(Buffer.concat([a, b]));
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
  });

  it('holds a partial payload across chunks until the frame is whole', () => {
    const enc = encodeJsonFrame(MsgType.BLOB, 9, Buffer.from([0, 1, 2, 3, 4]));
    const dec = new FrameDecoder();
    const split = Math.floor(enc.length / 2);
    expect(dec.push(enc.subarray(0, split))).toHaveLength(0); // header + half payload
    const frames = dec.push(enc.subarray(split));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(MsgType.BLOB);
  });

  it('encodes and decodes a capture BLOB (width + height + raw png)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const payload = encodeCaptureBlob(1280, 800, png);
    const out = decodeCaptureBlob(payload);
    expect(out).toEqual({ width: 1280, height: 800, png });
    expect(out.png.equals(png)).toBe(true);
  });

  it('rejects a frame with bad magic', () => {
    const bad = Buffer.alloc(HEADER_SIZE);
    bad[0] = 0xff;
    bad[1] = 0xff;
    expect(() => new FrameDecoder().push(bad)).toThrow(/magic/i);
  });

  it('rejects a frame with an unsupported version', () => {
    const bad = Buffer.alloc(HEADER_SIZE);
    bad[0] = MAGIC[0];
    bad[1] = MAGIC[1];
    bad[2] = 99; // unsupported version
    bad[3] = MsgType.RESULT;
    bad.writeUInt32BE(0, 4);
    bad.writeUInt32BE(0, 8);
    expect(() => new FrameDecoder().push(bad)).toThrow(/version/i);
  });
});
