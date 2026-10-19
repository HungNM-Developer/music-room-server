// Vote-to-skip arithmetic (R-25, spec §8.3). Pure.

/** Votes needed = max(minVotes, 1, ceil(onlineVoters × threshold)). */
export function requiredVotes(
  onlineVoters: number,
  threshold: number,
  minVotes = 1,
): number {
  // Subtract a tiny epsilon so 10 × 0.7 = 7.000000000000001 does not become 8.
  return Math.max(minVotes, 1, Math.ceil(onlineVoters * threshold - 1e-9));
}

/** Only online voters count, each once (I-09). */
export function countVotes(
  voterIds: readonly string[],
  online: ReadonlySet<string>,
): { votes: number; voters: string[] } {
  const voters = [...new Set(voterIds)].filter((id) => online.has(id));
  return { votes: voters.length, voters };
}
