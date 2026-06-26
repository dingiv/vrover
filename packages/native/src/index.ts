import { createRequire } from 'node:module';
import type { Screenshot, UiElement } from '@vrover/platform';
import type { SoMElement, SoMResult } from '@vrover/som';
import type {
  NativeConfig,
  NativeParser,
  NativeParsedElement,
  NativeParseResult,
} from './types.js';

export type { NativeConfig, NativeParser, NativeParsedElement, NativeParseResult } from './types.js';

// ── load the platform-specific .node binary ────────────────────────────────

const require = createRequire(import.meta.url);

// The .node file is produced by `napi build --platform --release` from
// crates/native/ into packages/native/ (see root package.json build:native).
function loadBinding(): {
  OmniParserNative: new (config: {
    yoloPath: string;
    boxThreshold: number;
    iouThreshold: number;
  }) => NativeParser;
  DesktopNativeLayer: new (
    screenWidth: number | null,
    screenHeight: number | null,
  ) => DesktopNativeLayer;
} {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') {
    return require('../vrover-native.linux-x64-gnu.node');
  }
  throw new Error(
    `@vrover/native: unsupported platform ${platform}-${arch}. ` +
      `Build the native binding with: pnpm build:native`,
  );
}

let _binding: ReturnType<typeof loadBinding> | undefined;

function binding(): ReturnType<typeof loadBinding> {
  if (!_binding) {
    _binding = loadBinding();
  }
  return _binding;
}

// ── factory ─────────────────────────────────────────────────────────────────

/**
 * Create a native OmniParser instance with sensible defaults.
 *
 * The returned parser implements {@link NativeParser} — pass it to
 * `runAgent({ nativeParser })` to use the Rust detection + SoM pipeline.
 */
export function createParser(config: NativeConfig): NativeParser {
  return new (binding().OmniParserNative)({
    yoloPath: config.yoloPath,
    boxThreshold: config.boxThreshold ?? 0.05,
    iouThreshold: config.iouThreshold ?? 0.1,
  });
}

// ── desktop layer ───────────────────────────────────────────────────────────

/**
 * Create a native input layer via Linux uinput.
 *
 * Requires `/dev/uinput` write access at runtime (root or `uinput` group).
 * Pass `screenWidth`/`screenHeight` for accurate absolute-pointer scaling.
 */
export function createDesktopLayer(opts?: {
  screenWidth?: number;
  screenHeight?: number;
}): DesktopNativeLayer {
  return new (binding().DesktopNativeLayer)(
    opts?.screenWidth ?? null,
    opts?.screenHeight ?? null,
  );
}

/** uinput-backed mouse + keyboard injection. */
export interface DesktopNativeLayer {
  moveTo(x: number, y: number): void;
  click(x: number, y: number, button: string): void;
  scroll(x: number, y: number, dx: number, dy: number): void;
  typeText(text: string): void;
  keyPress(key: string): void;
  keyRelease(key: string): void;
  tapKey(key: string): void;
}

// ── conversion ──────────────────────────────────────────────────────────────

/**
 * Convert a Rust {@link NativeParseResult} into the {@link SoMResult} shape
 * the agent loop expects.
 *
 * - `BBox` xyxy → `Bounds` x/y/width/height
 * - 0-based mark → 1-based {@link SoMElement.mark}
 * - `ElementType` → `role` + `description`
 */
export function convertToSoMResult(
  screenshot: Screenshot,
  result: NativeParseResult,
): SoMResult {
  const table: SoMElement[] = result.elements.map((el, i) => {
    const mark = i + 1; // 0-based Rust mark → 1-based SoM mark
    const role = el.type.toLowerCase();
    const label = el.content ?? '';
    const description = el.content
      ? `[${role}] ${el.content}`
      : `[${role}]`;

    const element: UiElement = {
      id: `${role}-${i}`,
      role,
      label,
      bounds: {
        x: el.x1,
        y: el.y1,
        width: el.x2 - el.x1,
        height: el.y2 - el.y1,
      },
    };

    return { mark, element, description };
  });

  return {
    annotated: {
      width: result.width,
      height: result.height,
      png: result.annotatedPng,
    },
    table,
  };
}
