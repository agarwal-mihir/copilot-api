import { describe, expect, test } from "bun:test"

import {
  assertCopilotModelAllowed,
  isCopilotModelAllowedByPolicy,
} from "~/lib/config"
import { ModelNotAllowedError } from "~/lib/error"

describe("Copilot model allowlist", () => {
  test("allows every model when the policy is omitted", () => {
    expect(isCopilotModelAllowedByPolicy("gpt-5-mini", undefined)).toBe(true)
  })

  test("allows only exact configured models", () => {
    const allowed = ["gpt-5.6-sol", "claude-opus-5"]

    expect(isCopilotModelAllowedByPolicy("gpt-5.6-sol", allowed)).toBe(true)
    expect(isCopilotModelAllowedByPolicy("claude-opus-5", allowed)).toBe(true)
    expect(isCopilotModelAllowedByPolicy("gpt-5-mini", allowed)).toBe(false)
  })

  test("matches client and upstream Claude version formats", () => {
    expect(
      isCopilotModelAllowedByPolicy("claude-opus-4.8", ["claude-opus-4-8"]),
    ).toBe(true)
  })

  test("fails closed for empty or malformed policies", () => {
    expect(isCopilotModelAllowedByPolicy("gpt-5.6-sol", [])).toBe(false)
    expect(isCopilotModelAllowedByPolicy("gpt-5.6-sol", null)).toBe(false)
  })

  test("rejects disallowed outbound models", () => {
    expect(() =>
      assertCopilotModelAllowed("gpt-5-mini", ["gpt-5.6-sol"]),
    ).toThrow(ModelNotAllowedError)
  })
})
