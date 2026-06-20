/**
 * Visual Scout client SDK — a thin JS interface over the Scout TCP protocol, for
 * writing automation scripts (the "人类 JS 脚本 API" from docs/design.md). This is
 * also the single home for the connection transport; the agent-side
 * `RemotePlatform` adapts it to the `Platform` interface.
 */
export { ScoutClient } from './scout-client.js';
export type { HandshakeRequest, HandshakeAck } from '../api.js';
