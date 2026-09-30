import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Model } from "~/lib/types/models"
import type { ResponseInputItem, ResponsesPayload } from "~/lib/types/responses"
import { closeUsageStore } from "~/lib/token-usage"
import {
  COMPACTION_BRIDGE_FALLBACK_SUMMARY,
  bridgeForeignCompaction,
  compactionBridgeDependencies,
  resetCompactionBridgeCache,
} from "~/routes/responses/compaction-bridge"
import {
  decodeMessagesCompaction,
  encodeMessagesCompaction,
  MESSAGES_COMPACTION_PROMPT,
} from "~/routes/responses/messages-translation"
import type { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const defaults = { ...compactionBridgeDependencies }

let cacheDir = ""
let now = 1_000
let allowedModels = new Set(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])

const createResponses = mock((() =>
  Promise.resolve(streamOf([]))) as typeof createCopilotResponses)

async function* streamOf(events: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const event of events) {
    yield { data: JSON.stringify(event), event: String(event.type) }
  }
  yield { data: "[DONE]" }
}

const completedStream = (text: string) =>
  streamOf([
    { type: "response.output_text.delta", delta: "ignored" },
    {
      type: "response.completed",
      response: {
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            content: [
              { type: "output_text", text },
              { type: "refusal", refusal: "no" },
            ],
          },
        ],
        usage: {
          input_tokens: 5_000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 300,
        },
      },
      copilot_usage: { total_nano_aiu: 42 },
    },
  ])

const foreignPayload = (): ResponsesPayload => ({
  model: "claude-opus-5.5",
  input: [
    { role: "user", content: "Earlier", type: "message" },
    { id: "cmp-old", type: "compaction", encrypted_content: "gAAAA-old" },
    { id: "cmp-new", type: "compaction", encrypted_content: "gAAAA-new" },
    { role: "user", content: "Continue", type: "message" },
  ],
})

const bridgedSummary = (payload: ResponsesPayload): string | null => {
  const items = payload.input as Array<ResponseInputItem>
  const carrier = items[2] as { encrypted_content: string; id: string }
  expect(carrier.id).toBe("cmp-new")
  return decodeMessagesCompaction(carrier.encrypted_content)
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-bridge-"))
  now = 1_000
  allowedModels = new Set(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  createResponses.mockReset()
  resetCompactionBridgeCache()
  Object.assign(compactionBridgeDependencies, {
    cacheDir: () => cacheDir,
    createResponses,
    findEndpointModel: (id: string) =>
      ({ id, supported_endpoints: ["/responses"] }) as Model,
    isCopilotModelAllowed: (id: string) => allowedModels.has(id),
    now: () => now,
  })
})

afterEach(async () => {
  Object.assign(compactionBridgeDependencies, defaults)
  resetCompactionBridgeCache()
  await closeUsageStore()
  await fs.rm(cacheDir, { force: true, recursive: true })
})

describe("bridgeForeignCompaction", () => {
  test("ignores payloads without a foreign compaction", async () => {
    const own: ResponsesPayload = {
      model: "claude-opus-5.5",
      input: [
        {
          id: "cmp",
          type: "compaction",
          encrypted_content: encodeMessagesCompaction("Ours"),
        },
      ],
    }
    const before = structuredClone(own)

    expect(await bridgeForeignCompaction({ model: "m", input: "hi" })).toBe(
      "none",
    )
    expect(
      await bridgeForeignCompaction({
        model: "m",
        input: [{ role: "user", content: "hi", type: "message" }],
      }),
    ).toBe("none")
    expect(await bridgeForeignCompaction(own)).toBe("none")
    expect(own).toEqual(before)
    expect(createResponses).not.toHaveBeenCalled()
  })

  test("summarizes the latest foreign compaction and caches it on disk", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(completedStream("GPT handoff")),
    )

    const payload = foreignPayload()
    expect(await bridgeForeignCompaction(payload, { sessionId: "s1" })).toBe(
      "bridged",
    )
    expect(bridgedSummary(payload)).toBe("GPT handoff")
    expect((payload.input as Array<ResponseInputItem>)[1]).toEqual({
      id: "cmp-old",
      type: "compaction",
      encrypted_content: "gAAAA-old",
    })

    expect(createResponses).toHaveBeenCalledTimes(1)
    const [request, options] = createResponses.mock.calls[0]
    expect(request).toMatchObject({
      model: "gpt-6-luna",
      store: false,
      stream: true,
      input: [
        { id: "cmp-new", type: "compaction", encrypted_content: "gAAAA-new" },
        { type: "message", role: "user", content: MESSAGES_COMPACTION_PROMPT },
      ],
    })
    expect(options).toMatchObject({
      initiator: "agent",
      sessionId: "s1",
      transport: "http",
    })

    const files = await fs.readdir(cacheDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.txt$/u)

    const memoryHit = foreignPayload()
    expect(await bridgeForeignCompaction(memoryHit)).toBe("bridged")
    expect(bridgedSummary(memoryHit)).toBe("GPT handoff")

    resetCompactionBridgeCache()
    const diskHit = foreignPayload()
    expect(await bridgeForeignCompaction(diskHit)).toBe("bridged")
    expect(bridgedSummary(diskHit)).toBe("GPT handoff")
    expect(createResponses).toHaveBeenCalledTimes(1)
  })

  test("shares one in-flight summary between concurrent requests", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(completedStream("Shared handoff")),
    )

    const first = foreignPayload()
    const second = foreignPayload()
    const results = await Promise.all([
      bridgeForeignCompaction(first),
      bridgeForeignCompaction(second),
    ])

    expect(results).toEqual(["bridged", "bridged"])
    expect(bridgedSummary(first)).toBe("Shared handoff")
    expect(bridgedSummary(second)).toBe("Shared handoff")
    expect(createResponses).toHaveBeenCalledTimes(1)
  })

  test("tries the next allowed bridge model after a failure", async () => {
    allowedModels.delete("gpt-6-luna")
    createResponses
      .mockImplementationOnce(() => Promise.reject(new Error("decrypt failed")))
      .mockImplementationOnce(() =>
        Promise.resolve({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Astra handoff" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        } as never),
      )

    const payload = foreignPayload()
    expect(await bridgeForeignCompaction(payload)).toBe("bridged")
    expect(bridgedSummary(payload)).toBe("Astra handoff")
    expect(
      createResponses.mock.calls.map(([request]) => request.model),
    ).toEqual(["gpt-6.1-sol", "gpt-6-astra"])
  })

  test("uses streamed deltas when the completed event has no text", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamOf([
          { type: "response.output_text.delta", delta: "Delta " },
          { type: "response.output_text.delta", delta: "handoff" },
          { type: "response.incomplete", response: { output: [] } },
        ]),
      ),
    )

    const payload = foreignPayload()
    expect(await bridgeForeignCompaction(payload)).toBe("bridged")
    expect(bridgedSummary(payload)).toBe("Delta handoff")
  })

  test("falls back to a stable note and retries only after the failure TTL", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamOf([
          {
            type: "response.failed",
            response: { error: { message: "bad compaction" } },
          },
        ]),
      ),
    )

    const payload = foreignPayload()
    expect(await bridgeForeignCompaction(payload)).toBe("fallback")
    expect(bridgedSummary(payload)).toBe(COMPACTION_BRIDGE_FALLBACK_SUMMARY)
    expect(createResponses).toHaveBeenCalledTimes(3)

    now += 60_000
    expect(await bridgeForeignCompaction(foreignPayload())).toBe("fallback")
    expect(createResponses).toHaveBeenCalledTimes(3)
    expect(await fs.readdir(cacheDir)).toEqual([])

    createResponses.mockImplementation(() =>
      Promise.resolve(streamOf([{ type: "error", message: "still failing" }])),
    )
    now += 10 * 60 * 1000
    expect(await bridgeForeignCompaction(foreignPayload())).toBe("fallback")
    expect(createResponses).toHaveBeenCalledTimes(6)
  })

  test("falls back without calling Copilot when no bridge model is usable", async () => {
    compactionBridgeDependencies.findEndpointModel = (id: string) =>
      id === "gpt-6-luna" ?
        ({ id, supported_endpoints: ["/v1/messages"] } as Model)
      : undefined

    const payload = foreignPayload()
    expect(await bridgeForeignCompaction(payload)).toBe("fallback")
    expect(createResponses).not.toHaveBeenCalled()
  })
})
