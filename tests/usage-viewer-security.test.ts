import { describe, expect, test } from "bun:test"

import { server } from "~/server"

describe("usage viewer security", () => {
  test("serves a self-contained same-origin viewer", async () => {
    const response = await server.request("/usage-viewer")
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(html).not.toContain("https://cdn.tailwindcss.com")
    expect(html).not.toContain("https://unpkg.com")
    expect(html).not.toContain("fonts.googleapis.com")
    expect(html).toContain("url.origin !== window.location.origin")
    expect(html).toContain("sessionStorage")
  })
})
