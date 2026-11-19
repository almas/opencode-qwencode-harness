/**
 * QwenCode Harness — route selected models to the QwenCode CLI harness.
 *
 * When the session's model matches one of the configured patterns (or the
 * mode is set to "always"), this plugin swaps the AI-SDK language model for
 * one whose answers come from a `qwen` CLI process instead of an HTTP API.
 * Everything else — session storage, SSE, the GUI — is untouched, so Qwen
 * models that are broken behind their current proxy keep working: the host
 * UI still believes it talks to the model the user picked.
 *
 * Mode resolution, strongest first:
 *   1. per-session override set from the composer pill (mode ≠ "auto"),
 *   2. the global mode ("always" routes every model, "off" routes none),
 *   3. "auto": the model must match one of the glob patterns.
 *
 * The `language` hook has no session id, so the session is captured in the
 * session-level `model.request` hook, which fires for the same provider call
 * right before the language model is used.
 */
import { createOpencodePlugin, definePlugin } from "@opencode/plugin/promise"

import { QwenCodeRunner, matchModel } from "./runner"
import {
  DEFAULT_PATTERNS,
  DEFAULT_QWEN_BIN,
  QwenCodeHarnessRpc,
  type HarnessMode,
  type HarnessPrefs,
} from "./rpc"

const DEFAULT_PREFS: HarnessPrefs = {
  mode: "auto",
  bin: DEFAULT_QWEN_BIN,
  patterns: [...DEFAULT_PATTERNS],
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  timeoutSeconds: 900,
}

/** Prefer an explicit path; otherwise resolve `qwen` through the usual PATHs. */
const BIN_CANDIDATES = [
  "/home/dd/.local/bin/qwen",
  "/usr/local/bin/qwen",
  "/usr/bin/qwen",
  "/bin/qwen",
]

const GLOBS = ["*"]

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return "unknown error"
  }
}

/** `providerID/…/modelID` — everything matchModel may want to probe. */
function describeModelPath(model: unknown): string {
  const m = model as Record<string, any> | undefined
  const apiId = typeof m?.api?.id === "string" ? m.api.id : ""
  const id = typeof m?.id === "string" ? m.id : ""
  const provider = typeof m?.providerID === "string" ? m.providerID : ""
  const modelID = apiId || id
  if (modelID && provider) return `${provider}/${modelID}`
  return modelID || provider
}

async function resolveQwenBin(prefs: HarnessPrefs): Promise<string | null> {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const candidates = [
    ...(prefs.bin ? [prefs.bin] : []),
    ...BIN_CANDIDATES,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "qwen")),
    ...GLOBS.flatMap((glob) => {
      if (glob.includes("/")) return [glob]
      return [
        path.join(process.env.HOME ?? "", ".local", "bin", glob),
        path.join(process.env.HOME ?? "", "bin", glob),
      ]
    }),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const stat = await fs.promises.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

export default definePlugin({
  id: "qwencode-harness",
  name: "QwenCode Harness",
  server: createOpencodePlugin({
    async trigger(ctx) {
      const storage = (ctx as any).storage as {
        read(key: readonly string[]): Promise<unknown>
        write(key: readonly string[], data: unknown): Promise<void>
      }
      const processSvc = (ctx as any).process as {
        run(input: {
          command: string
          args: string[]
          cwd: string
          timeout: number
        }): Promise<{ text: () => Promise<string> }>
      }

      const prefs: HarnessPrefs = { ...DEFAULT_PREFS }

      const load = async () => {
        try {
          const stored = (await storage.read(["qwencode-harness", "prefs"])) as
            | Partial<HarnessPrefs>
            | undefined
          if (stored && typeof stored === "object") {
            Object.assign(prefs, DEFAULT_PREFS, stored)
          }
          // Migrate the old boolean switch onto the mode ladder.
          const legacy = stored as { enabled?: unknown } | undefined
          if (legacy && typeof legacy.enabled === "boolean" && !("mode" in legacy)) {
            prefs.mode = legacy.enabled ? "auto" : "off"
            await storage.write(["qwencode-harness", "prefs"], { ...prefs })
          }
        } catch (error) {
          console.warn("[qwencode-harness] prefs load failed:", describe(error))
        }
      }
      const save = async () => {
        try {
          await storage.write(["qwencode-harness", "prefs"], { ...prefs })
        } catch (error) {
          console.warn("[qwencode-harness] prefs save failed:", describe(error))
        }
      }
      await load()

      const binCache = { value: undefined as string | null | undefined }
      const getBin = async () => {
        if (binCache.value === undefined) binCache.value = await resolveQwenBin(prefs)
        return binCache.value
      }
      const clearBinCache = () => {
        binCache.value = undefined
      }

      // Per-session overrides set from the composer pill. In-memory: they
      // apply to the running server and reset when it restarts.
      const sessionModes = new Map<string, HarnessMode>()
      // The session of the provider call currently being prepared. Set in
      // `model.request`, read by the `language` hook moments later.
      let currentSessionID: string | undefined
      let routed = 0

      const effectiveMode = (modelPath: string, sessionID?: string): HarnessMode => {
        const sessionMode = sessionID ? sessionModes.get(sessionID) : undefined
        if (sessionMode === "always" || sessionMode === "off") return sessionMode
        if (prefs.mode === "always") {
          // Never hijack OpenCode's own helper models (titles, summaries).
          return modelPath.toLowerCase().startsWith("opencode") ? "off" : "always"
        }
        if (prefs.mode === "off") return "off"
        return matchModel(modelPath, prefs.patterns) ? "auto" : "off"
      }

      const runner = new QwenCodeRunner({
        getPrefs: () => ({
          bin: prefs.bin,
          allowedTools: prefs.allowedTools,
          timeoutSeconds: prefs.timeoutSeconds,
        }),
        resolveBin: getBin,
      })

      const rpc = (ctx as any).rpc as {
        register(definitions: Record<string, any>): void
      }

      rpc.register({
        [QwenCodeHarnessRpc.status]: async (input: { sessionID?: string } | undefined) => {
          const bin = await getBin()
          const sessionMode = input?.sessionID ? sessionModes.get(input.sessionID) : undefined
          return {
            mode: sessionMode ?? prefs.mode,
            globalMode: prefs.mode,
            sessionMode: sessionMode ?? null,
            bin: bin ?? "",
            binOk: Boolean(bin),
            patterns: [...prefs.patterns],
            routed,
          }
        },
        [QwenCodeHarnessRpc.setMode]: async (
          input: { sessionID?: string; mode: HarnessMode | null } | undefined,
        ) => {
          if (!input) throw new Error("missing input")
          if (input.sessionID) {
            if (input.mode === null) sessionModes.delete(input.sessionID)
            else if (input.mode === "auto" || input.mode === "always" || input.mode === "off") {
              sessionModes.set(input.sessionID, input.mode)
            } else throw new Error(`unknown mode: ${String(input.mode)}`)
          } else if (input.mode === "auto" || input.mode === "always" || input.mode === "off") {
            prefs.mode = input.mode
            await save()
          } else {
            throw new Error(`unknown mode: ${String(input.mode)}`)
          }
          const bin = await getBin()
          return {
            mode: prefs.mode,
            globalMode: prefs.mode,
            sessionMode: input?.sessionID ? sessionModes.get(input.sessionID) ?? null : null,
            bin: bin ?? "",
            binOk: Boolean(bin),
            patterns: [...prefs.patterns],
            routed,
          }
        },
        [QwenCodeHarnessRpc.prefs]: async () => ({ ...prefs }),
        [QwenCodeHarnessRpc.setPrefs]: async (patch: Partial<HarnessPrefs> | undefined) => {
          Object.assign(prefs, DEFAULT_PREFS, patch ?? {}, {
            patterns:
              Array.isArray(patch?.patterns) && patch!.patterns.length > 0
                ? patch!.patterns
                : prefs.patterns,
            allowedTools: Array.isArray(patch?.allowedTools)
              ? patch!.allowedTools
              : prefs.allowedTools,
          })
          if (patch && "bin" in patch) clearBinCache()
          await save()
          return { ...prefs }
        },
        [QwenCodeHarnessRpc.test]: async () => {
          const bin = await getBin()
          if (!bin) {
            return { bin: "", ok: false, detail: `qwen not found (looked in ${BIN_CANDIDATES.join(", ")} and PATH)` }
          }
          try {
            const handle = await processSvc.run({
              command: bin,
              args: ["-p", "--no-session-persistence", "Reply with exactly: PONG"],
              cwd: process.env.HOME ?? "/",
              timeout: 120_000,
            })
            const text = await handle.text()
            const ok = /PONG/i.test(text)
            return { bin, ok, detail: text.trim().slice(0, 400) || "(empty reply)" }
          } catch (error) {
            return { bin, ok: false, detail: describe(error).slice(0, 400) }
          }
        },
      })

      ctx.register({
        // Fired per model call, with the session id the `language` hook lacks.
        // Remember the session so per-session modes can be applied there.
        "model.request": (input: { sessionID?: string }) => {
          if (typeof input?.sessionID === "string") currentSessionID = input.sessionID
        },

        // Replace the language model for harness-routed calls. Returning the
        // harness via output.language swaps the model instance; the host then
        // streams our process' output as if it were the API's.
        language: (input: any, output: any) => {
          const modelPath = describeModelPath(input.model)
          const mode = effectiveMode(modelPath, currentSessionID)
          if (mode === "off") return
          if (!output.language) {
            console.warn(
              "[qwencode-harness] language hook ran without a model instance; skipping",
            )
            return
          }

          const original = input.model as Record<string, any>
          const harness = runner.asLanguageModel(
            {
              provider: original?.providerID ?? "qwencode",
              modelId: original?.api?.id ?? original?.id ?? modelPath,
              maxInputTokens: original?.limit?.context,
            },
            modelPath,
          )
          routed += 1
          console.info(
            `[qwencode-harness] routing ${modelPath} via ${binCache.value ?? prefs.bin} (mode=${mode}, session=${currentSessionID ?? "?"})`,
          )
          output.language = harness
        },
      })

      ctx.lifecycle.register({
        async dispose() {
          await save()
        },
      })
    },
  }),
})
