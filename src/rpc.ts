/**
 * QwenCode Harness — RPC contract shared by the server and GUI halves.
 *
 * Plain JSON Schema literals (same shape the other published plugins use):
 * the server validates input and output with them, and the GUI types its
 * client proxy from the same definition.
 */
import type { Rpc } from "@opencode/schema/rpc"

/** Engine name shown on the chat badge when a request is routed to QwenCode. */
export const QWENCODE_HARNESS_NAME = "QwenCode"

/** Plugin id; also the key prefix for stored prefs. */
export const QWENCODE_HARNESS_ID = "qwencode-harness"

/** Model-ID globs that get the QwenCode harness in `auto` mode. */
export const DEFAULT_PATTERNS = ["qwen*", "qwencoder*", "swift*"]

/** Where the QwenCode CLI lives by default (`~` is expanded by the server). */
export const DEFAULT_QWEN_BIN = "~/.local/bin/qwen"

/**
 * How the harness is chosen.
 * - `auto`: QwenCode only when the model matches the configured patterns.
 * - `always`: QwenCode for every model in the session.
 * - `off`: keep the standard OpenCode harness.
 */
export const HARNESS_MODES = ["auto", "always", "off"] as const
export type HarnessMode = (typeof HARNESS_MODES)[number]

export interface HarnessStatus {
  /** Effective mode for the requested session (override or default). */
  mode: HarnessMode
  /** The global default mode, regardless of any session override. */
  globalMode: HarnessMode
  /** The per-session override; "" when the session follows the global default. */
  sessionMode: "" | HarnessMode
  /** Absolute path of the resolved CLI, "" when not found. */
  bin: string
  /** Whether the resolved CLI was found on disk. */
  binOk: boolean
  /** Model-ID globs used in `auto` mode. */
  patterns: string[]
  /** Turns routed to QwenCode since the server started. */
  routed: number
}

export interface HarnessPrefs {
  /** Default mode for sessions without an override. */
  mode: HarnessMode
  bin: string
  patterns: string[]
  allowedTools: string[]
  timeoutSeconds: number
}

/** Result of `test`: one throwaway `qwen -p` round trip. */
export interface HarnessTest {
  bin: string
  ok: boolean
  detail: string
}

/** Output shared by `status` and `setMode` (the GUI re-reads it after changes). */
const statusSchema = {
  type: "object",
  properties: {
    mode: { type: "string" },
    globalMode: { type: "string" },
    sessionMode: { type: "string" },
    bin: { type: "string" },
    binOk: { type: "boolean" },
    patterns: { type: "array", items: { type: "string" } },
    routed: { type: "number" },
  },
  required: ["mode", "globalMode", "sessionMode", "bin", "binOk", "patterns", "routed"],
}

const prefsSchema = {
  type: "object",
  properties: {
    mode: { type: "string" },
    bin: { type: "string" },
    patterns: { type: "array", items: { type: "string" } },
    allowedTools: { type: "array", items: { type: "string" } },
    timeoutSeconds: { type: "number" },
  },
  required: ["mode", "bin", "patterns", "allowedTools", "timeoutSeconds"],
}

export const QwenCodeHarnessRpc = {
  id: QWENCODE_HARNESS_ID,
  methods: {
    // Effective state for one session (pass sessionID to include its override).
    status: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
      },
      output: statusSchema,
    },
    // Force the harness for one session; "auto" restores the default behavior.
    setMode: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          mode: { type: "string" },
        },
        required: ["sessionID", "mode"],
      },
      output: statusSchema,
    },
    prefs: {
      input: { type: "object", properties: {} },
      output: prefsSchema,
    },
    setPrefs: {
      input: {
        type: "object",
        properties: {
          mode: { type: "string" },
          bin: { type: "string" },
          patterns: { type: "array", items: { type: "string" } },
          allowedTools: { type: "array", items: { type: "string" } },
          timeoutSeconds: { type: "number" },
        },
      },
      output: prefsSchema,
    },
    // Spawn the CLI once with a tiny prompt to prove it answers.
    test: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          bin: { type: "string" },
          ok: { type: "boolean" },
          detail: { type: "string" },
        },
        required: ["bin", "ok", "detail"],
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition
