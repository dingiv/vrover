/**
 * Visual Scout — the "胖工具" component: a standalone TCP server that exposes UI
 * operations + grounding (D10 ①④) for the VRover brain to drive over a custom
 * binary protocol, with per-connection sessions. The graph map + walker (②③)
 * layer on top in a later iteration (placeholder classes today). See
 * docs/scout-server.md.
 */
// Server + sessions.
export { startScoutServer } from './server.js';
export type { ScoutServer, ScoutServerOptions } from './server.js';
export { Session } from './session.js';
export { Walker } from './walker.js';
export { GraphMap } from './graph-map.js';
export { PlatformGroundingSource } from './grounding.js';

// Wire protocol (transport) + application message shapes (shared by server + client).
export {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  MsgType,
  FrameDecoder,
  ProtocolError,
  encodeFrame,
  encodeJsonFrame,
  encodeCaptureBlob,
  decodeCaptureBlob,
} from './protocol.js';
export type { Frame } from './protocol.js';
export type {
  HandshakeRequest,
  HandshakeAck,
  Request,
  OkResult,
  ElementsResult,
  ErrorPayload,
} from './api.js';
