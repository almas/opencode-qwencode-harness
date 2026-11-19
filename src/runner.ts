/**
 * The bridge itself: a `LanguageModelV3` implementation whose answers come
 * from a QwenCode CLI process instead of an HTTP API.
 *
 * Each call spawns `qwen -p` with the whole conversation on stdin and reads
 * `--output-format stream-json` events back:
 *
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"thinking",...}|{"type":"text",...}]}}
 *   {"type":"result","result":"...","session_id":"...","usage":{...}}
 *
 * Events are mapped onto the AI-SDK stream parts (reasoning/text deltas and a
 * finish), so OpenCode renders the turn exactly like any streamed reply.
 */
import { spawn } from "node:child_process"

export interface QwenEvent {
  type?: string
  subtype?: string
  message?: { content?: Array<Record<string, unknown>> }
  result?: string
  is_error?: boolean
  stop_reason?: string
  session_id?: string
  usage?: Record<string, number>
}

export interface RunnerPrefs {
  bin: string
  allowedTools: string[]
  timeoutSeconds: number
}

/** Minimal structural view of the model instance we are replacing. */
export interface OriginalModel {
  provider?: string
  modelId?: string
  maxInputTokens?: number
}

type StreamPart = Record<string, unknown>

export class QwenCodeRunner {
  constructor(
    private readonly deps: {
      getPrefs: () => RunnerPrefs
      resolveBin: () => Promise<string>
    },
  ) {}

  /**
   * A drop-in replacement for `original`. Identity fields (provider/modelId)
   * are kept so the rest of the app still believes it is talking to the model
   * the user picked — only the answers now come from QwenCode.
   */
  asLanguageModel(original: OriginalModel, modelID: string): unknown {
    const runner = this
    return {
      specificationVersion: "v3",
      provider: original.provider ?? "qwencode",
      modelId: original.modelId ?? modelID,
      supportedUrls: {},
      get maxInputTokens() {
        return original.maxInputTokens
      },
      async doStream(options: any): Promise<{ stream: ReadableStream<StreamPart>; response: { headers: Record<string, string> } }> {
        return {
          stream: runner.stream(options, options?.abortSignal),
          response: { headers: { "x-qwencode-harness": "1" } },
        }
      },
      async doGenerate(options: any) {
        const text = await runner.collect(runner.stream(options, options?.abortSignal))
        return {
          content: text ? [{ type: "text", text }] : [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { text: 0, reasoning: 0, total: 0 },
          },
          warnings: [],
        }
      },
    }
  }

  /** Run one turn; the returned stream yields AI-SDK v3 parts. */
  private stream(options: any, abortSignal?: AbortSignal): ReadableStream<StreamPart> {
    const runner = this
    let controller!: ReadableStreamDefaultController<StreamPart>
    const stream = new ReadableStream<StreamPart>({
      start(control) {
        controller = control
      },
    })
    let emitted = 0
    const emit = (part: StreamPart) => {
      emitted += 1
      try {
        controller.enqueue(part)
      } catch {
        /* the consumer went away */
      }
    }
    const close = () => {
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    }

    const run = async () => {
      const bin = await this.deps.resolveBin()
      if (!bin) {
        throw new Error("QwenCode Harness: `qwen` was not found. Install it or set the path in Settings → QwenCode.")
      }
      if (abortSignal?.aborted) return
      try {
        await runner.spawnOnce(options ?? {}, bin, emit, abortSignal)
      } catch (error) {
        // Retry once, but only while nothing has been streamed yet, so a
        // half-written answer is never duplicated.
        if (abortSignal?.aborted || emitted > 0) throw error
        await runner.spawnOnce(options ?? {}, bin, emit, abortSignal)
      }
    }

    run()
      .then(close)
      .catch((error: unknown) => {
        try {
          controller.error(error instanceof Error ? error : new Error(describe(error)))
        } catch {
          /* already closed */
        }
      })
    return stream
  }

  private async spawnOnce(
    options: any,
    bin: string,
    emit: (part: StreamPart) => void,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const prefs = this.deps.getPrefs()
    const args = ["-p", "--no-session-persistence", "--output-format", "stream-json", "--input-format", "text"]
    if (prefs.allowedTools.length) args.push("--allowed-tools", prefs.allowedTools.join(","))

    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], signal: abortSignal })
    const stderrChunks: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.stdin?.end(buildTranscript(options))

    let buffer = ""
    let textStarted = false
    let reasoningStarted = false
    let finished = false

    const handle = (event: QwenEvent) => {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            if (!textStarted) {
              emit({ type: "text-start", id: "text-0" })
              textStarted = true
            }
            emit({ type: "text-delta", id: "text-0", delta: block.text })
          } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            if (!reasoningStarted) {
              emit({ type: "reasoning-start", id: "reasoning-0" })
              reasoningStarted = true
            }
            emit({ type: "reasoning-delta", id: "reasoning-0", delta: block.thinking })
          }
        }
      } else if (event.type === "result" && !finished) {
        finished = true
        const isError = Boolean(event.is_error)
        const text = typeof event.result === "string" ? event.result : ""
        if (!isError && text && !textStarted) {
          emit({ type: "text-start", id: "text-0" })
          emit({ type: "text-delta", id: "text-0", delta: text })
          textStarted = true
        }
        if (textStarted) emit({ type: "text-end", id: "text-0" })
        if (reasoningStarted) emit({ type: "reasoning-end", id: "reasoning-0" })
        const usage = event.usage ?? {}
        emit({
          type: "finish",
          finishReason: {
            unified: isError ? "error" : "stop",
            raw: String(event.stop_reason ?? event.subtype ?? "stop"),
          },
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cachedInputTokens: usage.cache_read_input_tokens ?? 0,
            reasoningTokens: undefined,
            raw: usage,
          },
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
        reject(new Error(`QwenCode timed out after ${prefs.timeoutSeconds}s`))
      }, Math.max(10, prefs.timeoutSeconds) * 1000)

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line) continue
          try {
            handle(JSON.parse(line) as QwenEvent)
          } catch {
            /* ignore non-JSON noise lines */
          }
        }
      })
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        if (abortSignal?.aborted) {
          resolve()
          return
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
        if (code !== 0 && !finished) {
          reject(new Error(`QwenCode exited (${code ?? "signal"})${stderr ? `: ${tail(stderr, 1500)}` : ""}`))
          return
        }
        resolve()
      })
    })
  }

  /** Collect all text deltas from a stream (for the non-streaming call path). */
  private async collect(stream: ReadableStream<StreamPart>): Promise<string> {
    const reader = stream.getReader()
    let text = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.type === "text-delta" && typeof value.delta === "string") text += value.delta
    }
    return text
  }
}

/**
 * Flatten an AI-SDK v3 prompt into plain text for the CLI's stdin:
 * system instructions first, then one block per message labelled by role.
 */
export function buildTranscript(options: { prompt?: unknown; system?: unknown }): string {
  const sections: string[] = []
  const system = options.system
  if (Array.isArray(system)) {
    const text = system.filter((part) => typeof part === "string" && part).join("\n\n")
    if (text) sections.push(`# System Instructions\n${text}`)
  } else if (typeof system === "string" && system) {
    sections.push(`# System Instructions\n${system}`)
  }
  const prompt = Array.isArray(options.prompt) ? options.prompt : []
  for (const raw of prompt) {
    const message = raw as { role?: string; content?: unknown }
    const role = message.role === "assistant" || message.role === "system" ? message.role : "user"
    const content = Array.isArray(message.content) ? message.content : []
    const chunks: string[] = []
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text) chunks.push(part.text)
      } else if (part.type === "file") {
        chunks.push(`[attached file: ${String(part.mediaType ?? "file")}]`)
      } else if (part.type === "tool-result") {
        chunks.push(`[tool result: ${tail(JSON.stringify(part.output ?? ""), 2000)}]`)
      }
    }
    const body = chunks.join("\n").trim()
    if (!body) continue
    sections.push(`# ${role}\n${body}`)
  }
  // The last thing read should be the newest user message: end with a cue.
  return `${sections.join("\n\n")}\n\n# instruction\nReply to the most recent user message above, in the language it was written in.`
}

/** `*`/`?` glob → case-insensitive anchored regex (for matching model IDs). */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

/**
 * True when a model path matches any pattern. Both the full string and each
 * `/`-separated segment are tested, so `qwen*` hits `custom-x/qwen3.8-flash`
 * as well as a bare `qwen3.6-27b`.
 */
export function matchModel(modelPath: string, patterns: string[]): boolean {
  const lower = (modelPath ?? "").toLowerCase()
  if (!lower) return false
  const haystacks = [lower, ...lower.split("/").filter(Boolean)]
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern)
    return haystacks.some((value) => re.test(value))
  })
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return "unknown error"
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max)
}
