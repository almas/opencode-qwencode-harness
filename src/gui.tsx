/**
 * QwenCode Harness — the GUI half of the plugin.
 *
 * Two surfaces:
 *  - a composer pill (the row above the input box) showing which harness
 *    answers this chat; clicking it opens Auto / Always / Off rows and the
 *    detected-CLI status;
 *  - a settings section with the global mode, the `qwen` binary path, the
 *    model patterns, and a live CLI test.
 */
import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import { ComposerPill, Plugin, SettingsPage } from "@opencode/plugin/gui"

import {
  DEFAULT_PATTERNS,
  DEFAULT_QWEN_BIN,
  QwenCodeHarnessRpc,
  type HarnessMode,
  type HarnessPrefs,
  type HarnessStatus,
  type HarnessTest,
} from "./rpc"

interface RpcLike {
  status(input?: { sessionID?: string }): Promise<unknown>
  setMode(input: { sessionID?: string; mode: HarnessMode | null }): Promise<unknown>
  prefs(input?: unknown): Promise<unknown>
  setPrefs(patch: Partial<HarnessPrefs>, input?: unknown): Promise<unknown>
  test(input?: unknown): Promise<unknown>
}

const DEFAULT_PREFS: HarnessPrefs = {
  mode: "auto",
  bin: DEFAULT_QWEN_BIN,
  patterns: [...DEFAULT_PATTERNS],
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  timeoutSeconds: 900,
}

const MODE_KEYS: Record<HarnessMode, string> = {
  auto: "qwencode.mode.auto",
  always: "qwencode.mode.always",
  off: "qwencode.mode.off",
}

async function retryRpc<T>(
  label: string,
  call: () => Promise<T>,
  attempts = 8,
  baseDelayMs = 600,
): Promise<T | undefined> {
  let delayMs = baseDelayMs
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await call()
    } catch (error) {
      console.warn(`[qwencode-harness] ${label} attempt ${i + 1} failed: ${String(error)}`)
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return undefined
}

const labelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  "font-size": "13px",
}
const fieldStyle: JSX.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  "border-radius": "6px",
  border: "1px solid color-mix(in oklab, currentColor 25%, transparent)",
  background: "transparent",
  color: "inherit",
}

export default Plugin.define({
  i18n: {
    en: {
      "qwencode.name": "QwenCode Harness",
      "qwencode.pill.title": "QwenCode harness: which engine answers this chat",
      "qwencode.mode.auto": "Auto",
      "qwencode.mode.always": "Always",
      "qwencode.mode.off": "Off",
      "qwencode.pill.auto": "Auto (matching models)",
      "qwencode.pill.always": "Always (every model)",
      "qwencode.pill.off": "Off (OpenCode)",
      "qwencode.pill.session": "this chat",
      "qwencode.pill.global": "global",
      "qwencode.pill.binOk": "qwen CLI detected",
      "qwencode.pill.binMissing": "qwen CLI not found",
      "qwencode.pill.routed": "{count} turns routed",
      "qwencode.settings.title": "QwenCode Harness",
      "qwencode.settings.intro": "Hand answered turns to the QwenCode CLI instead of OpenCode's own loop. The pill above each chat's input overrides this per chat.",
      "qwencode.settings.mode": "Global mode",
      "qwencode.settings.mode.auto": "Auto — only models matching the patterns",
      "qwencode.settings.mode.always": "Always — every model (except OpenCode's own)",
      "qwencode.settings.mode.off": "Off — OpenCode answers everything",
      "qwencode.settings.bin": "QwenCode binary",
      "qwencode.settings.patterns": "Model patterns (comma-separated, * and ? allowed)",
      "qwencode.settings.tools": "Tools allowed in headless runs (comma-separated)",
      "qwencode.settings.timeout": "Timeout (seconds)",
      "qwencode.settings.test": "Test the CLI",
      "qwencode.settings.testing": "Testing…",
      "qwencode.settings.ok": "QwenCode found: {detail}",
      "qwencode.settings.fail": "QwenCode not working: {detail}",
      "qwencode.settings.detected": "Detected: {bin}",
      "qwencode.settings.missing": "Detected: not found — install QwenCode or fix the path above",
    },
    ja: {
      "qwencode.name": "QwenCode ハーネス",
      "qwencode.pill.title": "QwenCode ハーネス: このチャットの応答エンジン",
      "qwencode.mode.auto": "自動",
      "qwencode.mode.always": "常時",
      "qwencode.mode.off": "オフ",
      "qwencode.pill.auto": "自動: パターン一致のみ",
      "qwencode.pill.always": "常時: 全モデル",
      "qwencode.pill.off": "オフ: OpenCode",
      "qwencode.pill.session": "このチャット",
      "qwencode.pill.global": "全体設定",
      "qwencode.pill.binOk": "qwen CLI 検出済み",
      "qwencode.pill.binMissing": "qwen CLI 未検出",
      "qwencode.pill.routed": "{count} ターン転送済み",
      "qwencode.settings.title": "QwenCode ハーネス",
      "qwencode.settings.intro": "応答を OpenCode ではなく QwenCode CLI に担当させます。各チャットの入力欄上のピルでチャット単位に上書きできます。",
      "qwencode.settings.mode": "グローバルモード",
      "qwencode.settings.mode.auto": "自動 — パターンに一致するモデルのみ",
      "qwencode.settings.mode.always": "常時 — すべてのモデル（OpenCode 自身除く）",
      "qwencode.settings.mode.off": "オフ — すべて OpenCode",
      "qwencode.settings.bin": "QwenCode バイナリの場所",
      "qwencode.settings.patterns": "対象モデルのパターン（カンマ区切り、* と ? 使用可）",
      "qwencode.settings.tools": "自動実行を許可するツール（カンマ区切り）",
      "qwencode.settings.timeout": "タイムアウト（秒）",
      "qwencode.settings.test": "CLI をテスト",
      "qwencode.settings.testing": "テスト中…",
      "qwencode.settings.ok": "QwenCode 起動確認: {detail}",
      "qwencode.settings.fail": "QwenCode が動きません: {detail}",
      "qwencode.settings.detected": "検出済み: {bin}",
      "qwencode.settings.missing": "検出できません — QwenCode をインストールするか上のパスを直してください",
    },
  },
  setup(ctx) {
    const rpc = ctx.client.rpc(QwenCodeHarnessRpc) as unknown as RpcLike

    const [prefs, setPrefs] = createSignal<HarnessPrefs>({ ...DEFAULT_PREFS })
    const [globalStatus, setGlobalStatus] = createSignal<HarnessStatus>()
    // Per-session status, refreshed by one shared poller.
    const [sessionStatus, setSessionStatus] = createSignal<Record<string, HarnessStatus>>(
      {},
      { equals: false },
    )
    const watched = new Set<string>()

    const refreshStatusFor = async (sessionID: string) => {
      try {
        const value = (await rpc.status({ sessionID })) as HarnessStatus
        setSessionStatus((prev) => ({ ...prev, [sessionID]: value }))
      } catch (error) {
        console.warn(`[qwencode-harness] pill status poll failed: ${String(error)}`)
      }
    }

    const refresh = async () => {
      const [prefValue, statusValue] = await Promise.all([
        retryRpc("prefs", () => rpc.prefs({})),
        retryRpc("status", () => rpc.status({})),
      ])
      if (prefValue) setPrefs({ ...DEFAULT_PREFS, ...(prefValue as HarnessPrefs) })
      if (statusValue) setGlobalStatus(statusValue as HarnessStatus)
    }
    void refresh()

    const poll = setInterval(() => {
      const current = ctx.sessions.current()
      if (current) void refreshStatusFor(current.id)
      for (const id of watched) void refreshStatusFor(id)
      void rpc.status({}).then((v) => setGlobalStatus(v as HarnessStatus)).catch(() => {})
    }, 3000)
    onCleanup(() => clearInterval(poll))

    const setSessionMode = async (sessionID: string, mode: HarnessMode) => {
      try {
        const value = (await rpc.setMode({ sessionID, mode })) as HarnessStatus
        setSessionStatus((prev) => ({ ...prev, [sessionID]: value }))
      } catch (error) {
        console.error(`[qwencode-harness] setMode failed: ${String(error)}`)
      }
    }

    const savePrefs = async (patch: Partial<HarnessPrefs>) => {
      try {
        const next = await rpc.setPrefs(patch)
        setPrefs({ ...DEFAULT_PREFS, ...(next as HarnessPrefs) })
        const refreshed = await rpc.status({})
        setGlobalStatus(refreshed as HarnessStatus)
      } catch (error) {
        console.error(`[qwencode-harness] setPrefs failed: ${String(error)}`)
      }
    }

    // ---------- composer pill ----------
    ctx.add(ComposerPill, {
      id: "harness-mode",
      order: 5,
      show: (input) => {
        const sessionID = input.session.id
        if (!watched.has(sessionID)) {
          watched.add(sessionID)
          void refreshStatusFor(sessionID)
        }
        const info = sessionStatus()[sessionID] ?? globalStatus()
        // `mode` is already the effective mode for this session (server
        // applies any per-session override); "" in sessionMode = no override.
        const mode: HarnessMode = info?.mode ?? "auto"
        const mark = (value: HarnessMode) => (value === mode ? "✓ " : "")
        return {
          label: `Qwen: ${ctx.t(MODE_KEYS[mode])}`,
          title: ctx.t("qwencode.pill.title"),
          tone: mode === "off" ? undefined : "warning",
          rows: [
            {
              id: "auto",
              label: `${mark("auto")}${ctx.t("qwencode.pill.auto")}`,
              run: () => void setSessionMode(sessionID, "auto"),
            },
            {
              id: "always",
              label: `${mark("always")}${ctx.t("qwencode.pill.always")}`,
              run: () => void setSessionMode(sessionID, "always"),
            },
            {
              id: "off",
              label: `${mark("off")}${ctx.t("qwencode.pill.off")}`,
              run: () => void setSessionMode(sessionID, "off"),
            },
            {
              id: "state",
              label: info?.binOk ? ctx.t("qwencode.pill.binOk") : ctx.t("qwencode.pill.binMissing"),
              detail: info?.routed ? `→ QwenCode ×${info.routed}` : undefined,
            },
          ],
        }
      },
    })

    // ---------- settings page ----------
    const [testing, setTesting] = createSignal(false)
    const [testResult, setTestResult] = createSignal<HarnessTest>()

    const runTest = async () => {
      setTesting(true)
      setTestResult(undefined)
      try {
        const value = (await rpc.test({})) as HarnessTest
        setTestResult(value)
      } catch (error) {
        setTestResult({ bin: "", ok: false, detail: String(error) })
      } finally {
        setTesting(false)
      }
    }

    const join = (items: string[]) => items.join(", ")
    const split = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

    ctx.add(SettingsPage, {
      id: "main",
      title: ctx.t("qwencode.settings.title"),
      render: () => (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", "max-width": "620px" }}>
          <p style={{ "font-size": "13px", opacity: 0.8 }}>{ctx.t("qwencode.settings.intro")}</p>

          <label style={labelStyle}>
            <span>{ctx.t("qwencode.settings.mode")}</span>
            <select
              style={fieldStyle}
              value={prefs().mode}
              onChange={(event) => void savePrefs({ mode: event.currentTarget.value as HarnessMode })}
            >
              <option value="auto">{ctx.t("qwencode.settings.mode.auto")}</option>
              <option value="always">{ctx.t("qwencode.settings.mode.always")}</option>
              <option value="off">{ctx.t("qwencode.settings.mode.off")}</option>
            </select>
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("qwencode.settings.bin")}</span>
            <input
              style={fieldStyle}
              value={prefs().bin}
              placeholder={DEFAULT_QWEN_BIN}
              onInput={(event) => setPrefs({ ...prefs(), bin: event.currentTarget.value })}
              onBlur={(event) => void savePrefs({ bin: event.currentTarget.value.trim() })}
            />
            <Show when={globalStatus()?.bin}>
              <span style={{ opacity: 0.6, "font-size": "12px" }}>
                {ctx.t("qwencode.settings.detected", { bin: globalStatus()?.bin ?? "" })}
              </span>
            </Show>
            <Show when={globalStatus() && !globalStatus()?.binOk}>
              <span style={{ opacity: 0.6, "font-size": "12px" }}>{ctx.t("qwencode.settings.missing")}</span>
            </Show>
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("qwencode.settings.patterns")}</span>
            <input
              style={fieldStyle}
              value={join(prefs().patterns)}
              onInput={(event) => setPrefs({ ...prefs(), patterns: split(event.currentTarget.value) })}
              onBlur={(event) => void savePrefs({ patterns: split(event.currentTarget.value) })}
            />
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("qwencode.settings.tools")}</span>
            <input
              style={fieldStyle}
              value={join(prefs().allowedTools)}
              onInput={(event) => setPrefs({ ...prefs(), allowedTools: split(event.currentTarget.value) })}
              onBlur={(event) => void savePrefs({ allowedTools: split(event.currentTarget.value) })}
            />
          </label>

          <label style={labelStyle}>
            <span>{ctx.t("qwencode.settings.timeout")}</span>
            <input
              style={fieldStyle}
              type="number"
              min="30"
              value={String(prefs().timeoutSeconds)}
              onInput={(event) =>
                setPrefs({ ...prefs(), timeoutSeconds: Number(event.currentTarget.value) || 600 })
              }
              onBlur={(event) =>
                void savePrefs({ timeoutSeconds: Number(event.currentTarget.value) || 600 })
              }
            />
          </label>

          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <button type="button" disabled={testing()} onClick={() => void runTest()}>
              {testing() ? ctx.t("qwencode.settings.testing") : ctx.t("qwencode.settings.test")}
            </button>
            <Show when={testResult()}>
              <span
                style={{
                  "font-size": "12px",
                  color: testResult()?.ok ? "var(--color-success, #2e7d32)" : "var(--color-error, #c62828)",
                }}
              >
                {testResult()?.ok
                  ? ctx.t("qwencode.settings.ok", { detail: testResult()?.detail ?? "" })
                  : ctx.t("qwencode.settings.fail", { detail: testResult()?.detail ?? "" })}
              </span>
            </Show>
          </div>
        </div>
      ),
    })
  },
})
