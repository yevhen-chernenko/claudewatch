// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatRateLimitWindow,
  formatResetTime,
  resolveToken,
} from "./rateLimit";

describe("resolveToken", () => {
  it("treats non-JSON text as a raw bearer token", () => {
    expect(resolveToken("sk-ant-oat01-raw-token")).toEqual({
      token: "sk-ant-oat01-raw-token",
    });
  });

  it("errors on text that starts with { but isn't valid JSON", () => {
    expect(resolveToken("{not valid json")).toEqual({
      error: "Token file is neither a token nor valid JSON",
    });
  });

  it("errors when the JSON is missing claudeAiOauth.accessToken", () => {
    expect(resolveToken("{}")).toEqual({
      error: "No claudeAiOauth.accessToken in token file",
    });
    expect(resolveToken(JSON.stringify({ claudeAiOauth: {} }))).toEqual({
      error: "No claudeAiOauth.accessToken in token file",
    });
  });

  it("errors when the token is expired", () => {
    const text = JSON.stringify({
      claudeAiOauth: { accessToken: "abc", expiresAt: Date.now() - 1000 },
    });
    expect(resolveToken(text)).toEqual({
      error: "OAuth token expired — run claude to refresh it",
    });
  });

  it("returns the access token when valid and unexpired", () => {
    const text = JSON.stringify({
      claudeAiOauth: { accessToken: "abc", expiresAt: Date.now() + 100_000 },
    });
    expect(resolveToken(text)).toEqual({ token: "abc" });
  });

  it("returns the access token when expiresAt is absent", () => {
    const text = JSON.stringify({ claudeAiOauth: { accessToken: "abc" } });
    expect(resolveToken(text)).toEqual({ token: "abc" });
  });
});

describe("formatResetTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns unknown for an unparseable ISO string", () => {
    expect(formatResetTime("not-a-date")).toBe("unknown");
  });

  it("formats a same-day reset as a relative offset", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect(formatResetTime("2024-01-01T02:30:00Z")).toBe("in 2h 30m");
  });

  it("clamps a reset time already in the past to 0h 0m", () => {
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
    expect(formatResetTime("2024-01-01T11:00:00Z")).toBe("in 0h 0m");
  });

  it("formats a reset 24h or more away as a weekday/time", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect(formatResetTime("2024-01-02T00:00:00Z")).toBe("Tue 12:00 AM");
  });
});

describe("formatRateLimitWindow", () => {
  it("reports unavailable when there's no window or utilization", () => {
    expect(formatRateLimitWindow(undefined, "5h")).toBe("5h: unavailable");
    expect(formatRateLimitWindow({ utilization: null }, "5h")).toBe(
      "5h: unavailable",
    );
  });

  it("formats utilization without a reset time", () => {
    expect(formatRateLimitWindow({ utilization: 42.6 }, "5h")).toBe("5h 43%");
  });

  it("formats utilization with a reset time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect(
      formatRateLimitWindow(
        { utilization: 10, resets_at: "2024-01-01T01:00:00Z" },
        "5h",
      ),
    ).toBe("5h 10% (resets in 1h 0m)");
    vi.useRealTimers();
  });
});
