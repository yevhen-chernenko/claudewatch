// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from "vitest";

import { formatTokenCount, summarizeUsage } from "./usage";

describe("formatTokenCount", () => {
  it("prints small counts as plain numbers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("rolls over to K at 1000", () => {
    expect(formatTokenCount(1000)).toBe("1.0K");
    expect(formatTokenCount(999_999)).toBe("1000.0K");
  });

  it("rolls over to M at 1,000,000", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

function transcriptLine(
  id: string,
  usage: Record<string, number>,
): string {
  return JSON.stringify({ message: { id, usage } });
}

describe("summarizeUsage", () => {
  it("sums input/output/cache tokens across entries", () => {
    const transcript = [
      transcriptLine("msg-1", { input_tokens: 100, output_tokens: 20 }),
      transcriptLine("msg-2", {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      }),
    ].join("\n");

    expect(summarizeUsage(transcript)).toBe("In 150 · Out 30 · Cached 8");
  });

  it("dedupes repeated content blocks sharing the same message id", () => {
    const transcript = [
      transcriptLine("msg-1", { input_tokens: 100, output_tokens: 20 }),
      transcriptLine("msg-1", { input_tokens: 100, output_tokens: 20 }),
      transcriptLine("msg-1", { input_tokens: 100, output_tokens: 20 }),
    ].join("\n");

    expect(summarizeUsage(transcript)).toBe("In 100 · Out 20 · Cached 0");
  });

  it("skips blank and malformed lines", () => {
    const transcript = [
      "",
      "not json",
      transcriptLine("msg-1", { input_tokens: 10, output_tokens: 1 }),
    ].join("\n");

    expect(summarizeUsage(transcript)).toBe("In 10 · Out 1 · Cached 0");
  });

  it("skips entries missing usage or a message id", () => {
    const transcript = [
      JSON.stringify({ message: { id: "no-usage" } }),
      JSON.stringify({ message: { usage: { input_tokens: 10 } } }),
      transcriptLine("msg-1", { input_tokens: 5, output_tokens: 1 }),
    ].join("\n");

    expect(summarizeUsage(transcript)).toBe("In 5 · Out 1 · Cached 0");
  });

  it("returns zeroed totals for an empty transcript", () => {
    expect(summarizeUsage("")).toBe("In 0 · Out 0 · Cached 0");
  });
});
