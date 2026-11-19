import { describe, expect, it } from "vitest"

import { buildTranscript, globToRegExp, matchModel } from "../src/runner"

describe("globToRegExp", () => {
  it("anchors the pattern at both ends", () => {
    const re = globToRegExp("qwen*")
    expect(re.test("qwen3.8-flash")).toBe(true)
    expect(re.test("gpt-qwen")).toBe(false)
  })

  it("treats ? as a single character", () => {
    const re = globToRegExp("swift?")
    expect(re.test("swift2")).toBe(true)
    expect(re.test("swift")).toBe(false)
  })

  it("is case-insensitive and escapes regex metacharacters", () => {
    expect(globToRegExp("QWEN*").test("qwen-max")).toBe(true)
    // The dot in "qwen3.8" must not match any character.
    expect(globToRegExp("qwen3.8*").test("qwen3x8-flash")).toBe(false)
    expect(globToRegExp("qwen3.8*").test("QWEN3.8-FLASH")).toBe(true)
  })
})

describe("matchModel", () => {
  const patterns = ["qwen*", "qwencoder*", "swift*"]

  it("matches the bare model id", () => {
    expect(matchModel("qwen3.6-27b", patterns)).toBe(true)
    expect(matchModel("swift2", patterns)).toBe(true)
  })

  it("matches a provider/model path by segment", () => {
    expect(matchModel("custom-x/qwen3.8-flash-next", patterns)).toBe(true)
  })

  it("does not match unrelated models", () => {
    expect(matchModel("openai/gpt-5", patterns)).toBe(false)
    expect(matchModel("anthropic/claude-sonnet-4.5", patterns)).toBe(false)
  })

  it("never matches on empty input", () => {
    expect(matchModel("", patterns)).toBe(false)
    expect(matchModel("qwen3", [])).toBe(false)
  })
})

describe("buildTranscript", () => {
  it("renders system text and labelled messages", () => {
    const text = buildTranscript({
      system: "Be terse.",
      prompt: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi there" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    })
    expect(text).toContain("# System Instructions\nBe terse.")
    expect(text).toContain("# user\nhello")
    expect(text).toContain("# assistant\nhi there")
    expect(text).toContain("# instruction\nReply to the most recent user message above")
  })

  it("joins array system parts and skips empty messages", () => {
    const text = buildTranscript({
      system: ["rule one", "", "rule two"],
      prompt: [
        { role: "user", content: [] },
        { role: "user", content: [{ type: "text", text: "real question" }] },
      ],
    })
    expect(text).toContain("rule one\n\nrule two")
    expect(text).toContain("# user\nreal question")
    // The empty message must not leave a stray "# user" section behind.
    expect(text.match(/# user\n/g)?.length).toBe(1)
  })

  it("annotates files and tool results instead of dropping them", () => {
    const text = buildTranscript({
      prompt: [
        {
          role: "user",
          content: [
            { type: "file", mediaType: "image/png" },
            { type: "tool-result", output: { ok: true } },
          ],
        },
      ],
    })
    expect(text).toContain("[attached file: image/png]")
    expect(text).toContain('[tool result: {"ok":true}]')
  })
})
