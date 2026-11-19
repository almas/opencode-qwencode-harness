/**
 * QwenCode Harness — the server half of the plugin.
 *
 * Redirects OpenCode's own answering step: when the session's model matches
 * the configured patterns, the `aisdk.hook("language")` event swaps the
 * language model for a thin wrapper that streams answers from the QwenCode
 * CLI (`qwen -p --output-format stream-json`) instead of the upstream API.
 *
 * OpenCode still runs the loop, stores messages and renders the transcript;
 * only the model that produces tokens is replaced. The GUI half configures
 * mode, binary path and patterns through the `qwencode-harness` RPC domain.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"

import { QwenCodeRunner, matchModel, type OriginalModel } from "./runner"
import {
  DEFAULT_PATTERNS,
  DEFAULT_QWEN_BIN,
  HARNESS_MODES,
  QwenCodeHarnessRpc,
  type HarnessMode,
  type HarnessPrefs,
  type HarnessStatus,
  type HarnessTest,
} from "./rpc"

const PREFS_KEY = "qwencode-harness/prefs"

const DEFAULT_PREFS: HarnessPrefs = {
  mode: "auto",
  bin: DEFAULT_QWEN_BIN,
  patterns: [...DEFAULT_PATTERNS],
  // Read-only tools plus Bash; the CLI runs unsupervised, so keep this tight.
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  timeoutSeconds: 900,
}

/** Candidate locations probed when the configured path is not executable. */
const FALLBACK_BINS = [
  "~/.local/bin/qwen",
  "~/.npm-global/bin/qwen",
  "~/.volta/bin/qwen",
  "/usr/local/bin/qwen",
  "/usr/bin/qwen",
  "/opt/homebrew/bin/qwen",
]

function expandHome(input: string): string {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isMode(value: unknown): value is HarnessMode {
  return typeof value === "string" && (HARNESS_MODES as readonly string[]).includes(value)
}

const TEST_PROMPT = "Reply with exactly: PONG"

export default Plugin.define({
  id: "qwencode-harness",
  async setup(ctx) {
    // ---------- preferences ----------
    const loadPrefs = async (): Promise<HarnessPrefs> => {
      let stored: (Partial<HarnessPrefs> & { enabled?: unknown }) | undefined
      try {
        stored = (await ctx.storage.get(PREFS_KEY)) as (Partial<HarnessPrefs> & { enabled?: unknown }) | undefined
      } catch {
        return { ...DEFAULT_PREFS }
      }
      if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
      const merged: HarnessPrefs = { ...DEFAULT_PREFS, ...stored }
      if (!isMode(merged.mode)) merged.mode = DEFAULT_PREFS.mode
      if (!merged.bin) merged.bin = DEFAULT_PREFS.bin
      if (!Array.isArray(merged.patterns) || merged.patterns.length === 0)
        merged.patterns = [...DEFAULT_PATTERNS]
      if (!Array.isArray(merged.allowedTools)) merged.allowedTools = [...DEFAULT_PREFS.allowedTools]
      if (!Number.isFinite(merged.timeoutSeconds) || merged.timeoutSeconds < 30)
        merged.timeoutSeconds = DEFAULT_PREFS.timeoutSeconds
      // Migrate the old boolean switch onto the mode ladder (true → auto).
      if (typeof stored.enabled === "boolean" && stored.mode === undefined) {
        merged.mode = stored.enabled ? "auto" : "off"
        try {
          await ctx.storage.set(PREFS_KEY, { ...merged })
        } catch {
          /* prefs stay in memory for this run */
        }
      }
      return merged
    }

    let prefs = await loadPrefs()
    const savePrefs = async () => {
      try {
        await ctx.storage.set(PREFS_KEY, { ...prefs })
      } catch (error) {
        console.warn("[qwencode-harness] prefs save failed:", describe(error))
      }
    }

    // ---------- binary discovery ----------
    let binCache: string | null | undefined
    const resolveBin = async (): Promise<string | null> => {
      if (binCache !== undefined) return binCache
      const configured = expandHome(prefs.bin.trim())
      const names = configured ? [configured] : []
      for (const fallback of FALLBACK_BINS) {
        const candidate = expandHome(fallback)
        if (!names.includes(candidate)) names.push(candidate)
      }
      const fromPath = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, "qwen"))
      for (const candidate of [...names, ...fromPath]) {
        if (!candidate) continue
        try {
          const stat = await fs.promises.stat(candidate)
          if (stat.isFile()) {
            binCache = candidate
            return candidate
          }
        } catch {
          /* keep looking */
        }
      }
      binCache = null
      return null
    }

    // ---------- routing state ----------
    /** Per-session mode overrides; empty means "follow prefs.mode". */
    const sessionModes = new Map<string, HarnessMode>()
    /**
     * The session whose model is being resolved right now. `model.request`
     * fires a moment before the language model is built; the language hook
     * itself carries no sessionID, so this is the only correlation point.
     */
    let currentSessionID = ""
    let routedCount = 0

    const effectiveMode = (sessionID: string): HarnessMode =>
      sessionModes.get(sessionID) ?? prefs.mode

    const buildStatus = (sessionID?: string): HarnessStatus => {
      const id = sessionID ?? ""
      const sessionMode = sessionModes.get(id) ?? null
      return {
        mode: effectiveMode(id),
        globalMode: prefs.mode,
        sessionMode: sessionMode ?? "",
        bin: "",
        binOk: false,
        patterns: [...prefs.patterns],
        routed: routedCount,
      }
    }

    // One shared runner; it reads prefs live, so changes apply to the next turn.
    const runner = new QwenCodeRunner({
      getPrefs: () => ({
        bin: prefs.bin,
        allowedTools: prefs.allowedTools,
        timeoutSeconds: prefs.timeoutSeconds,
      }),
      resolveBin: async () => (await resolveBin()) ?? "",
    })

    // ---------- RPC ----------
    await ctx.rpc.register(QwenCodeHarnessRpc, {
      status: async (raw): Promise<HarnessStatus> => {
        const sessionID = (raw as { sessionID?: string } | undefined)?.sessionID
        const bin = await resolveBin()
        return { ...buildStatus(sessionID), bin: bin ?? "", binOk: bin !== null }
      },
      setMode: async (raw): Promise<HarnessStatus> => {
        const input = raw as { sessionID?: string; mode?: string | null } | undefined
        const sessionID = input?.sessionID ?? ""
        if (!isMode(input?.mode)) sessionModes.delete(sessionID)
        else sessionModes.set(sessionID, input!.mode as HarnessMode)
        const bin = await resolveBin()
        return { ...buildStatus(sessionID), bin: bin ?? "", binOk: bin !== null }
      },
      prefs: async (): Promise<HarnessPrefs> => ({ ...prefs }),
      setPrefs: async (raw): Promise<HarnessPrefs> => {
        const patch = (raw ?? {}) as Partial<HarnessPrefs>
        if (isMode(patch.mode)) prefs.mode = patch.mode
        if (typeof patch.bin === "string") {
          prefs.bin = patch.bin.trim() || DEFAULT_QWEN_BIN
          binCache = undefined
        }
        if (Array.isArray(patch.patterns) && patch.patterns.length > 0)
          prefs.patterns = patch.patterns.map(String)
        if (Array.isArray(patch.allowedTools)) prefs.allowedTools = patch.allowedTools.map(String)
        if (Number.isFinite(patch.timeoutSeconds))
          prefs.timeoutSeconds = Math.max(30, Math.floor(patch.timeoutSeconds as number))
        await savePrefs()
        return { ...prefs }
      },
      test: async (): Promise<HarnessTest> => {
        const bin = await resolveBin()
        if (!bin)
          return {
            bin: "",
            ok: false,
            detail: `QwenCode CLI not found (tried ${[prefs.bin, ...FALLBACK_BINS].join(", ")})`,
          }
        try {
          const model = runner.asLanguageModel(
            { provider: "qwencode", modelId: "qwen-test", maxInputTokens: 32_000 },
            "qwen-test",
          ) as { doGenerate: (o: { prompt: string }) => Promise<{ content: Array<{ type: string; text?: string }> }> }
          const result = await model.doGenerate({ prompt: TEST_PROMPT })
          const text = result.content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("")
            .trim()
          return {
            bin,
            ok: text.length > 0,
            detail: text.length > 200 ? `${text.slice(0, 200)}…` : text || "empty reply (check the API key)",
          }
        } catch (error) {
          return { bin, ok: false, detail: describe(error) }
        }
      },
    })

    // ---------- harness hooks ----------
    // Remember which session is about to make a model request: the language
    // hook below has no sessionID of its own.
    await ctx.session.hook("model.request", (event) => {
      currentSessionID = String((event as { sessionID?: unknown }).sessionID ?? "")
    })

    await ctx.aisdk.hook("language", (input) => {
      const info = input.model as unknown as
        | { id?: string; api?: { id?: string }; providerID?: string }
        | undefined
      const modelPath = String(info?.api?.id ?? info?.id ?? info?.providerID ?? "")

      const sessionMode = sessionModes.get(currentSessionID)
      if (sessionMode === "off") return
      const mode = sessionMode ?? prefs.mode
      if (mode === "off") return
      if (mode === "auto" && !matchModel(modelPath, prefs.patterns)) return
      // "always" must not hijack OpenCode's built-in helper models (titles,
      // summaries, compaction): those providers are not user chats.
      if (modelPath.toLowerCase().startsWith("opencode")) return

      const original: OriginalModel = {
        provider: info?.providerID ?? "qwencode",
        modelId: modelPath || "qwencode",
        maxInputTokens:
          Number((info as { limit?: { context?: unknown } } | undefined)?.limit?.context) || 128_000,
      }

      // The wrapper rebuilds the transcript from the messages OpenCode
      // assembled, so the CLI sees the same conversation the UI shows.
      const wrapper = runner.asLanguageModel(original, modelPath || "qwencode")
      routedCount += 1
      ;(input as unknown as { language?: unknown }).language = wrapper
    })
  },
})
