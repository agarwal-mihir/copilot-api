import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { createHandlerLogger } from "~/lib/logger"
import { isCopilotModelAllowed } from "~/lib/model-policy"
import { findEndpointModel } from "~/lib/models"
import { PATHS } from "~/lib/paths"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ResponseInputCompaction,
  ResponseInputItem,
  ResponsesPayload,
  ResponsesResult,
} from "~/lib/types/responses"
import { isAsyncIterable } from "~/lib/utils"
import { createResponses } from "~/services/copilot/create-responses"

import {
  decodeMessagesCompaction,
  encodeMessagesCompaction,
  MESSAGES_COMPACTION_PROMPT,
} from "./messages-translation"
import { getResponsesTransportForModel } from "./utils"

const logger = createHandlerLogger("responses-compaction-bridge")

export const COMPACTION_BRIDGE_MODELS = [
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-6-astra",
] as const

export const COMPACTION_BRIDGE_FALLBACK_SUMMARY = [
  "An earlier part of this conversation was compacted by a different model, and its summary could not be recovered.",
  "Continue from the messages that follow. If important context seems to be missing, ask the user to restate it.",
].join("\n")

const BRIDGE_INSTRUCTIONS =
  "Convert the compacted conversation state you were given into a plain-text handoff summary. Do not continue the task."
const BRIDGE_MAX_OUTPUT_TOKENS = 16_000
const FAILURE_TTL_MS = 10 * 60 * 1000

export const compactionBridgeDependencies = {
  cacheDir: () => path.join(PATHS.APP_DIR, "compaction-summaries"),
  createResponses,
  findEndpointModel,
  isCopilotModelAllowed,
  now: () => Date.now(),
}

const memoryCache = new Map<string, string>()
const failedAt = new Map<string, number>()
const inFlight = new Map<string, Promise<string | null>>()

export function resetCompactionBridgeCache(): void {
  memoryCache.clear()
  failedAt.clear()
  inFlight.clear()
}

/**
 * Codex compaction items from GPT backends are OpenAI-encrypted. Before a
 * Messages-backed model reads the history, replace the latest foreign
 * compaction with a GPT-written plain-text summary. Summaries are cached on
 * disk by content hash so every later turn sees an identical prompt prefix.
 */
export async function bridgeForeignCompaction(
  payload: ResponsesPayload,
  options: { sessionId?: string } = {},
): Promise<"none" | "bridged" | "fallback"> {
  if (!Array.isArray(payload.input)) return "none"

  const index = findLatestCompactionIndex(payload.input)
  if (index < 0) return "none"

  const carrier = payload.input[index] as ResponseInputCompaction
  const encryptedContent = carrier.encrypted_content
  if (
    typeof encryptedContent !== "string"
    || !encryptedContent
    || decodeMessagesCompaction(encryptedContent) !== null
  ) {
    return "none"
  }

  const key = createHash("sha256").update(encryptedContent).digest("hex")
  const summary = await resolveSummary(key, carrier, options.sessionId)
  const replacement: ResponseInputCompaction = {
    id: carrier.id,
    type: "compaction",
    encrypted_content: encodeMessagesCompaction(
      summary ?? COMPACTION_BRIDGE_FALLBACK_SUMMARY,
    ),
  }
  payload.input = payload.input.map((item, itemIndex) =>
    itemIndex === index ? replacement : item,
  )
  return summary ? "bridged" : "fallback"
}

function findLatestCompactionIndex(input: Array<ResponseInputItem>): number {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if ((input[index] as { type?: unknown }).type === "compaction") {
      return index
    }
  }
  return -1
}

async function resolveSummary(
  key: string,
  carrier: ResponseInputCompaction,
  sessionId: string | undefined,
): Promise<string | null> {
  const cached = memoryCache.get(key)
  if (cached) return cached

  const failure = failedAt.get(key)
  if (
    failure !== undefined
    && compactionBridgeDependencies.now() - failure < FAILURE_TTL_MS
  ) {
    return null
  }

  const pending = inFlight.get(key)
  if (pending) return await pending

  const promise = loadOrCreateSummary(key, carrier, sessionId).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return await promise
}

async function loadOrCreateSummary(
  key: string,
  carrier: ResponseInputCompaction,
  sessionId: string | undefined,
): Promise<string | null> {
  const filePath = path.join(
    compactionBridgeDependencies.cacheDir(),
    `${key}.txt`,
  )
  const stored = await readCachedSummary(filePath)
  if (stored) {
    memoryCache.set(key, stored)
    return stored
  }

  const summary = await summarizeWithBridgeModels(carrier, sessionId)
  if (!summary) {
    failedAt.set(key, compactionBridgeDependencies.now())
    return null
  }

  memoryCache.set(key, summary)
  failedAt.delete(key)
  await writeCachedSummary(filePath, summary)
  return summary
}

async function readCachedSummary(filePath: string): Promise<string | null> {
  try {
    const text = await fs.readFile(filePath, "utf8")
    return text.trim() ? text : null
  } catch {
    return null
  }
}

async function writeCachedSummary(
  filePath: string,
  summary: string,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(tempPath, summary, "utf8")
    await fs.rename(tempPath, filePath)
  } catch (error) {
    logger.warn("Failed to persist bridged compaction summary", error)
  }
}

async function summarizeWithBridgeModels(
  carrier: ResponseInputCompaction,
  sessionId: string | undefined,
): Promise<string | null> {
  for (const model of COMPACTION_BRIDGE_MODELS) {
    if (!compactionBridgeDependencies.isCopilotModelAllowed(model)) continue
    const selectedModel = compactionBridgeDependencies.findEndpointModel(model)
    if (!selectedModel || !getResponsesTransportForModel(selectedModel)) {
      continue
    }

    try {
      const summary = await summarizeWithModel(
        selectedModel.id,
        carrier,
        sessionId,
      )
      if (summary) {
        logger.info(
          `Bridged a foreign compaction into a Messages summary with ${selectedModel.id}`,
        )
        return summary
      }
      logger.warn(`${selectedModel.id} returned an empty bridged summary`)
    } catch (error) {
      logger.warn(
        `Failed to bridge a foreign compaction with ${selectedModel.id}`,
        error,
      )
    }
  }
  return null
}

async function summarizeWithModel(
  model: string,
  carrier: ResponseInputCompaction,
  sessionId: string | undefined,
): Promise<string> {
  const requestId = randomUUID()
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: sessionId ?? requestId,
    model,
  })
  const payload: ResponsesPayload = {
    model,
    instructions: BRIDGE_INSTRUCTIONS,
    input: [
      {
        type: "compaction",
        id: carrier.id,
        encrypted_content: carrier.encrypted_content,
      },
      { type: "message", role: "user", content: MESSAGES_COMPACTION_PROMPT },
    ],
    max_output_tokens: BRIDGE_MAX_OUTPUT_TOKENS,
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  }

  const response = await compactionBridgeDependencies.createResponses(payload, {
    vision: false,
    initiator: "agent",
    requestId,
    sessionId,
    transport: "http",
  })

  if (!isAsyncIterable(response)) {
    const result = response
    recordUsage(toUsage(result))
    return extractOutputText(result.output).trim()
  }

  let deltas = ""
  let completedText: string | null = null
  let usage: UsageTokens = {}
  try {
    for await (const chunk of response) {
      const event = parseEvent(chunk)
      if (!event) continue
      if (
        event.type === "response.output_text.delta"
        && typeof event.delta === "string"
      ) {
        deltas += event.delta
      } else if (
        event.type === "response.completed"
        || event.type === "response.incomplete"
        || event.type === "response.failed"
      ) {
        const result = event.response as ResponsesResult | undefined
        usage = toUsage(result, event.copilot_usage)
        if (event.type === "response.failed") {
          throw new Error(result?.error?.message ?? "response.failed")
        }
        completedText = extractOutputText(result?.output)
      } else if (event.type === "error") {
        throw new Error(
          typeof event.message === "string" ? event.message : "stream error",
        )
      }
    }
  } finally {
    recordUsage(usage)
  }
  return (completedText || deltas).trim()
}

function parseEvent(chunk: unknown): Record<string, unknown> | null {
  const data = (chunk as { data?: unknown }).data
  if (typeof data !== "string" || !data || data === "[DONE]") return null
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed && typeof parsed === "object" ?
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function toUsage(
  result: Partial<ResponsesResult> | undefined,
  eventCopilotUsage?: unknown,
): UsageTokens {
  const copilotUsage =
    (eventCopilotUsage as ResponsesResult["copilot_usage"])
    ?? result?.copilot_usage
  return {
    ...normalizeResponsesUsage(result?.usage),
    total_nano_aiu: normalizeOptionalToken(copilotUsage?.total_nano_aiu),
  }
}

function extractOutputText(output: unknown): string {
  if (!Array.isArray(output)) return ""
  const parts: Array<string> = []
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const { type, content } = item as { type?: unknown; content?: unknown }
    if (type !== "message" || !Array.isArray(content)) continue
    for (const part of content) {
      const { type: partType, text } = part as {
        type?: unknown
        text?: unknown
      }
      if (partType === "output_text" && typeof text === "string") {
        parts.push(text)
      }
    }
  }
  return parts.join("")
}
