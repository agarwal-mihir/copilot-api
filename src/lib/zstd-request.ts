import type { MiddlewareHandler } from "hono"

type NodeZlibModule = {
  zstdDecompress?: (
    input: Uint8Array,
    options: {
      maxOutputLength: number
    },
    callback: (error: Error | null, result: Uint8Array) => void,
  ) => void
}

const ZSTD_CONTENT_ENCODING = "zstd"
const INVALID_BODY_STATUS = 400
const BODY_TOO_LARGE_STATUS = 413

export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

let nodeZlibPromise: Promise<NodeZlibModule | null> | null = null

class DecompressedBodyTooLargeError extends Error {}

export function createZstdDecompressionMiddleware(
  maxDecompressedBytes = MAX_REQUEST_BODY_BYTES,
): MiddlewareHandler {
  return async (c, next) => {
    const contentEncoding = c.req
      .header("content-encoding")
      ?.trim()
      .toLowerCase()
    if (contentEncoding !== ZSTD_CONTENT_ENCODING) {
      return next()
    }

    let decompressedBody: Uint8Array
    try {
      const compressedBody = new Uint8Array(await c.req.raw.arrayBuffer())
      decompressedBody = await decompressZstd(
        compressedBody,
        maxDecompressedBytes,
      )
    } catch (error) {
      if (error instanceof DecompressedBodyTooLargeError) {
        return c.json(
          {
            error: {
              message: "Decompressed request body is too large.",
              type: "request_too_large",
            },
          },
          BODY_TOO_LARGE_STATUS,
        )
      }

      return c.json(
        {
          error: {
            message: "Failed to decompress zstd request body.",
            type: "invalid_request_error",
          },
        },
        INVALID_BODY_STATUS,
      )
    }

    const headers = new Headers(c.req.raw.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")

    c.req.raw = new Request(c.req.raw.url, {
      body: decompressedBody,
      headers,
      method: c.req.raw.method,
      signal: c.req.raw.signal,
    })
    c.req.bodyCache = {}

    return next()
  }
}

export const zstdDecompressionMiddleware = createZstdDecompressionMiddleware()

const decompressZstd = async (
  input: Uint8Array,
  maxOutputLength: number,
): Promise<Uint8Array> => {
  const nodeZlib = await getNodeZlib()
  const zstdDecompress = nodeZlib?.zstdDecompress
  if (!zstdDecompress) {
    throw new Error("This runtime does not support bounded zstd decompression")
  }

  return new Promise((resolve, reject) => {
    zstdDecompress(input, { maxOutputLength }, (error, result) => {
      if (error) {
        if ("code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
          reject(new DecompressedBodyTooLargeError())
          return
        }

        reject(error)
        return
      }

      if (result.byteLength > maxOutputLength) {
        reject(new DecompressedBodyTooLargeError())
        return
      }

      resolve(result)
    })
  })
}

const getNodeZlib = async (): Promise<NodeZlibModule | null> => {
  nodeZlibPromise ??= import("node:zlib")
    .then((module) => module as NodeZlibModule)
    .catch(() => null)

  return nodeZlibPromise
}
