# opencode-qwencode-harness

Swap OpenCode's answering engine for the **QwenCode CLI** on Qwen-family
models — while keeping OpenCode's UI, permissions, session storage and
transcript exactly as they are. The selected model becomes a label; the
answers come from `qwen -p` streaming events.

日本語版: [下の「日本語」セクション](#日本語) を参照してください。

## How it works

OpenCode resolves a prompt to an AI-SDK language model just before it answers.
This plugin hooks that moment (`ctx.aisdk.hook("language")`) and replaces the
model with a small AI-SDK-shaped wrapper. The wrapper:

1. rebuilds the transcript from the messages OpenCode sends (system prompts
   plus the conversation, with tool output rendered as text),
2. spawns `qwen -p --no-session-persistence --output-format stream-json`
   once for the turn, with the Qwen model name and the configured
   permission mode,
3. streams the CLI's assistant text back as OpenCode token events, and
4. ends the turn with the CLI's real token/cost usage.

OpenCode still stores the messages, so history, forking and sharing behave
normally. The harness is stateless: OpenCode resends the full history every
turn, and the CLI sees it all, so no session mapping is needed.

## Harness modes

| Mode | Behaviour |
| --- | --- |
| `auto` | QwenCode answers when the model ID matches the configured patterns (`qwen*`, `swift*`, …). |
| `always` | QwenCode answers for every model — OpenCode's own helper models (titles, summaries) are always left alone. |
| `off` | OpenCode answers everything; the plugin does nothing. |

The global default lives in the plugin's settings page. Each chat can override
it with the **Qwen** pill above the composer: pick 自動 / 常時 / オフ and it
applies to that session only.

## Requirements

- OpenCode Desktop (or server + client) with the experimental plugin API
- [QwenCode CLI](https://www.npmjs.com/package/@qwen-code/qwen-code) installed
  and authenticated (e.g. `npm install -g @qwen-code/qwen-code`, then sign in)

## Install

```bash
git clone https://github.com/almas/opencode-qwencode-harness.git
cd opencode-qwencode-harness
npm install
npm run build
```

Then register both halves in `~/.config/opencode/opencode.jsonc` (paths shown
for a clone under `~/workspace`):

```jsonc
{
  "plugin": [
    "file:///home/dd/workspace/opencode-plugins/qwencode-harness/src/index.ts"
  ],
  "gui": {
    "plugins": {
      "qwencode-harness": "file:///home/dd/workspace/opencode-plugins/qwencode-harness/dist/gui-experimental.cjs"
    }
  }
}
```

Open the settings page **QwenCode Harness**, press *Test the CLI*, and make
sure it reports `QwenCode found`. Then ask something with a `qwen*` model
selected (or set the mode to 常時) — the pill shows the turn count routed.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | Global default harness mode (`auto` / `always` / `off`). |
| `bin` | `~/.local/bin/qwen` | QwenCode CLI path; also searched in `PATH`, `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`. |
| `patterns` | `qwen*`, `qwencoder*`, `swift*` | Model-ID globs routed in `auto` mode. |
| `allowedTools` | `Read, Grep, Glob, Bash` | Passed to `qwen --allowed-tools` for headless runs. |
| `timeoutSeconds` | `900` | Hard timeout per CLI run. |

## Notes and limits

- **Auto-approve**: the CLI runs with `--yolo`, so tools execute without
  prompts, bounded by `allowedTools`. Lower `approvalMode` in `src/index.ts`
  if you want prompts (they cannot be answered in headless mode).
- Tool calls appear in the transcript as plain text from the CLI's own
  narration; native OpenCode tool cards are not synthesised.
- `--no-session-persistence` keeps the CLI from writing per-run session
  files; nothing is hidden from OpenCode's own history.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # vite build → dist/gui-experimental.cjs
```

## 日本語

OpenCode の応答エンジンを、Qwen 系モデルの時だけ **QwenCode CLI** に差し替える
プラグインです。UI・権限・セッション保存は OpenCode のまま、選んだモデルは
表示上のラベルになり、実際の応答は `qwen -p` のストリームが担当します。

- **仕組み**: 応答直前の言語モデル解決（`language` フック）を乗っ取り、AI-SDK
  風の薄いラッパに差し替えます。ラッパは履歴をテキストへ変換して CLI を 1 回
  起動し、assistant 本文をトークンイベントとして OpenCode へ流し、CLI が返す
  実使用量で締めます。OpenCode 側は通常どおり会話を保存するので、履歴・分岐・
  共有はそのまま使えます。CLI は毎回全履歴を受け取るため、状態管理は不要です。
- **モード**: `自動` はパターン一致モデル（既定 `qwen*` / `swift*`）だけ、
  `常時` は全モデル（OpenCode 固有情報の補助モデル除く）、`オフ` は無効。
  既定は設定ページ、チャット単位の上書きは入力欄上の **Qwen** ピル（自動/常時/
  オフ）から行えます。
- **必要環境**: OpenCode Desktop と QwenCode CLI（サインイン済み）。
- **注意**: CLI は `--yolo`（自動承認）で動きます。許可ツールの範囲は設定の
  `allowedTools` で絞ってください。ツールの実行経過は CLI のテキストとして
  会話に現れます（OpenCode ネイティブのツールカードにはなりません）。

## License

MIT
