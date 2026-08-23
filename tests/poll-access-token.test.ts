import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import consola from "consola"

import { pollAccessToken } from "~/services/github/poll-access-token"

import type { DeviceCodeResponse } from "~/services/github/get-device-code"

const deviceCode = {
  device_code: "device-code",
  expires_in: 900,
  interval: 0,
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
} satisfies DeviceCodeResponse

function fetchResponse(response: Response): typeof fetch {
  return Object.assign(() => Promise.resolve(response), {
    preconnect: () => undefined,
  })
}

afterEach(() => {
  mock.restore()
})

describe("GitHub device authorization polling", () => {
  test("returns the token without writing it to debug logs", async () => {
    const token = "secret-oauth-token"
    spyOn(globalThis, "fetch").mockImplementation(
      fetchResponse(
        new Response(
          JSON.stringify({
            access_token: token,
            scope: "read:user",
            token_type: "bearer",
          }),
          { status: 200 },
        ),
      ),
    )
    const debug = spyOn(consola, "debug")

    expect(await pollAccessToken(deviceCode)).toBe(token)
    expect(JSON.stringify(debug.mock.calls)).not.toContain(token)
  })

  test("surfaces an authorization denial", async () => {
    spyOn(globalThis, "fetch").mockImplementation(
      fetchResponse(
        new Response(
          JSON.stringify({
            error: "access_denied",
            error_description: "The user denied the request",
          }),
          { status: 200 },
        ),
      ),
    )

    try {
      await pollAccessToken(deviceCode)
      throw new Error("Expected authorization denial")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        "GitHub device authorization failed (access_denied)",
      )
    }
  })
})
