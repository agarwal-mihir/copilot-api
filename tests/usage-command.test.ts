import { describe, expect, test } from "bun:test"

import type { TokenUsageSummary } from "~/lib/token-usage"
import type { CopilotUsageResponse } from "~/services/github/get-copilot-usage"
import { formatUsageReport } from "~/usage"

const quota = {
  entitlement: 300,
  overage_count: 0,
  overage_permitted: false,
  percent_remaining: 75,
  quota_id: "premium_interactions",
  quota_remaining: 225,
  remaining: 225,
  unlimited: false,
}

describe("usage command", () => {
  test("distinguishes account credits from local AI units", () => {
    const account = {
      access_type_sku: "enterprise",
      analytics_tracking_id: "tracking",
      assigned_date: "2026-08-01",
      can_signup_for_limited: false,
      chat_enabled: true,
      copilot_plan: "enterprise",
      endpoints: { api: "https://api.githubcopilot.com", telemetry: "" },
      login: "octocat",
      organization_list: [],
      organization_login_list: [],
      quota_reset_date: "2026-09-01",
      quota_snapshots: {
        chat: { ...quota, unlimited: true },
        completions: { ...quota, unlimited: true },
        premium_interactions: quota,
      },
    } satisfies CopilotUsageResponse
    const local = {
      byModel: [],
      period: "month",
      range: {
        end_ms: 2,
        end_utc: "2026-09-01T00:00:00.000Z",
        start_ms: 1,
        start_utc: "2026-08-01T00:00:00.000Z",
      },
      totals: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        costs: [],
        input_tokens: 1_000,
        output_tokens: 500,
        request_count: 4,
        total_nano_aiu: 1_500_000_000,
        total_tokens: 1_500,
      },
    } satisfies TokenUsageSummary

    expect(formatUsageReport(account, local)).toContain(
      "AI credits / premium interactions: 75 used / 300, 225 remaining (75%)",
    )
    expect(formatUsageReport(account, local)).toContain(
      "Provider-reported AI units: 1.5 AIU",
    )
    expect(formatUsageReport(account, local)).toContain(
      "account-wide across Copilot clients",
    )
  })

  test("handles omitted quotas and quota_remaining responses", () => {
    const account = {
      access_type_sku: "enterprise",
      analytics_tracking_id: "tracking",
      assigned_date: "2026-08-01",
      can_signup_for_limited: false,
      chat_enabled: true,
      endpoints: { api: "https://api.githubcopilot.com", telemetry: "" },
      login: "octocat",
      organization_list: [],
      organization_login_list: [],
      quota_snapshots: {
        premium_interactions: {
          entitlement: 100,
          quota_remaining: 80,
          unlimited: false,
        },
      },
    } satisfies CopilotUsageResponse
    const local = {
      byModel: [],
      period: "month",
      range: {
        end_ms: 2,
        end_utc: "2026-09-01T00:00:00.000Z",
        start_ms: 1,
        start_utc: "2026-08-01T00:00:00.000Z",
      },
      totals: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        costs: [],
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
        total_nano_aiu: null,
        total_tokens: 0,
      },
    } satisfies TokenUsageSummary

    expect(formatUsageReport(account, local)).toContain(
      "AI credits / premium interactions: 20 used / 100, 80 remaining (80%)",
    )
    expect(formatUsageReport(account, local)).toContain(
      "Quota reset: not reported",
    )
    expect(formatUsageReport(account, local)).toContain("Chat: not reported")
  })
})
