// SPDX-License-Identifier: GPL-2.0-or-later

// No `gi://` imports here — pure string/number logic, plain-Node testable.

export function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

// Transcript JSONL repeats the same message id once per content block
// (text, tool_use, …), each carrying that turn's cumulative usage — dedupe
// by id or totals balloon by however many blocks the turn happened to have.
export function summarizeUsage(transcriptText) {
  const seenIds = new Set();
  let input = 0;
  let output = 0;
  let cached = 0;

  for (const line of transcriptText.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const usage = entry.message?.usage;
    const id = entry.message?.id;
    if (!usage || !id || seenIds.has(id)) continue;
    seenIds.add(id);
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    cached +=
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
  }

  return `In ${formatTokenCount(input)} · Out ${formatTokenCount(output)} · Cached ${formatTokenCount(cached)}`;
}
