import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()

  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  let sleepDuration = (deviceCode.interval + 1) * 1000
  const expiresAt = Date.now() + deviceCode.expires_in * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  while (Date.now() < expiresAt) {
    const response = await fetch(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) {
      consola.warn(
        `GitHub device authorization polling failed with HTTP ${response.status}.`,
      )
      await sleep(sleepDuration)
      continue
    }

    const result = (await response.json()) as AccessTokenResponse
    if (typeof result.access_token === "string" && result.access_token.trim()) {
      consola.debug("GitHub device authorization completed")
      return result.access_token
    }

    if (result.error === "authorization_pending") {
      consola.debug("GitHub device authorization is pending")
      await sleep(sleepDuration)
      continue
    }

    if (result.error === "slow_down") {
      sleepDuration += 5000
      consola.debug(
        `GitHub requested slower device authorization polling (${sleepDuration}ms)`,
      )
      await sleep(sleepDuration)
      continue
    }

    const detail =
      typeof result.error_description === "string" ?
        `: ${result.error_description}`
      : ""
    const errorCode =
      typeof result.error === "string" ? result.error : "unexpected_response"
    throw new Error(
      `GitHub device authorization failed (${errorCode})${detail}`,
    )
  }

  throw new Error("GitHub device authorization expired before completion")
}

interface AccessTokenResponse {
  access_token?: unknown
  error?: unknown
  error_description?: unknown
}
