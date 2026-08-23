import { defineCommand } from "citty"
import consola from "consola"

import { readGitHubToken } from "~/lib/credential-store"
import { getTokenUsageSummary, type TokenUsageSummary } from "~/lib/token-usage"
import {
  getCopilotUsage,
  type CopilotUsageResponse,
  type QuotaDetail,
} from "~/services/github/get-copilot-usage"

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 })
}

function formatQuota(label: string, quota?: QuotaDetail): string {
  if (!quota) {
    return `${label}: not reported`
  }

  if (quota.unlimited === true) {
    return `${label}: unlimited`
  }

  const entitlement = quota.entitlement
  const remaining = quota.remaining ?? quota.quota_remaining
  if (
    typeof entitlement !== "number"
    || !Number.isFinite(entitlement)
    || typeof remaining !== "number"
    || !Number.isFinite(remaining)
  ) {
    return `${label}: not reported`
  }

  const reportedPercent = quota.percent_remaining
  const percentRemaining =
    typeof reportedPercent === "number" && Number.isFinite(reportedPercent) ?
      reportedPercent
    : entitlement > 0 ? (remaining / entitlement) * 100
    : 0
  const used = Math.max(0, entitlement - remaining)
  const overageCount = quota.overage_count ?? 0
  const overage =
    overageCount > 0 ? `, ${formatNumber(overageCount)} overage` : ""

  return `${label}: ${formatNumber(used)} used / ${formatNumber(entitlement)}, ${formatNumber(remaining)} remaining (${formatNumber(percentRemaining)}%${overage})`
}

export function formatUsageReport(
  account: CopilotUsageResponse,
  local: TokenUsageSummary,
): string {
  const quotas = account.quota_snapshots ?? {}
  const localAiu =
    local.totals.total_nano_aiu === null ?
      "not reported"
    : `${formatNumber(local.totals.total_nano_aiu / 1_000_000_000)} AIU`

  return [
    `GitHub Copilot usage for ${account.login}`,
    `Plan: ${account.copilot_plan ?? account.access_type_sku}`,
    `Quota reset: ${account.quota_reset_date ?? "not reported"}`,
    formatQuota(
      "AI credits / premium interactions",
      quotas.premium_interactions,
    ),
    formatQuota("Chat", quotas.chat),
    formatQuota("Completions", quotas.completions),
    "",
    "This local gateway, last 30 days:",
    `Requests: ${formatNumber(local.totals.request_count)}`,
    `Tokens: ${formatNumber(local.totals.total_tokens)}`,
    `Provider-reported AI units: ${localAiu}`,
    "",
    "GitHub's AI-credit quota is account-wide across Copilot clients; it does not identify which client consumed each credit. Local AIU is provider telemetry, not the premium-credit count.",
  ].join("\n")
}

export const usage = defineCommand({
  meta: {
    name: "usage",
    description: "Show GitHub Copilot AI-credit quota and local gateway usage",
  },
  async run() {
    const githubToken = await readGitHubToken()
    if (!githubToken) {
      throw new Error(
        "GitHub token not found. Run `copilot-api auth login --provider copilot` first.",
      )
    }

    const [account, local] = await Promise.all([
      getCopilotUsage(githubToken),
      getTokenUsageSummary("month"),
    ])
    if (!account) {
      throw new Error("GitHub Copilot usage was not returned.")
    }

    consola.log(formatUsageReport(account, local))
  },
})
