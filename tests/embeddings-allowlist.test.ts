import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { ModelNotAllowedError } from "~/lib/error"

let allowedModels = ["gpt-5.6-sol"]
const actualConfigModule = await import("~/lib/config")

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  assertCopilotModelAllowed: (model: string) => {
    if (!allowedModels.includes(model)) {
      throw new ModelNotAllowedError(model)
    }
  },
}))

const { state } = await import("~/lib/state")
const { createEmbeddings } = await import(
  "~/services/copilot/create-embeddings"
)

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const fetchMock = Object.assign(
  mock((..._args: Parameters<typeof fetch>) =>
    Promise.resolve(new Response("{}")),
  ),
  { preconnect: (() => {}) satisfies typeof fetch.preconnect },
) satisfies typeof fetch

describe("Copilot embeddings model allowlist", () => {
  beforeEach(() => {
    allowedModels = ["gpt-5.6-sol"]
    state.copilotToken = "test-token"
    fetchMock.mockClear()
    globalThis.fetch = fetchMock
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    state.copilotToken = originalCopilotToken
  })

  test("rejects a disallowed model before the upstream request", async () => {
    let error: unknown
    try {
      await createEmbeddings({
        input: "hello",
        model: "text-embedding-3-small",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ModelNotAllowedError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
