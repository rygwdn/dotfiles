/**
 * The cost of running at all.
 *
 * A memory monitor that polls hard is part of the problem it reports on, so
 * the cadence rule is a contract worth pinning: the configured interval is the
 * *pressured* rate, and a healthy machine is checked far less often.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cadenceMs, parsePorts, parseLines } from "../lib/policy.ts";

test("a healthy machine is polled far less often than a struggling one", () => {
  const config = { sampleSeconds: 10 };
  assert.equal(cadenceMs(config, "critical"), 10_000);
  assert.equal(cadenceMs(config, "warn"), 10_000);
  assert.equal(cadenceMs(config, "watch"), 20_000);
  assert.equal(cadenceMs(config, "ok"), 60_000);
});

test("parsePorts accepts lists and ranges, and rejects nonsense without widening", () => {
  assert.deepEqual([...parsePorts("3000")], [3000]);
  assert.deepEqual([...parsePorts("8080-8082")], [8080, 8081, 8082]);
  assert.deepEqual([...parsePorts("3000, 5173")].sort((a, b) => a - b), [3000, 5173]);

  // An empty setting protects nothing. This is the default and must stay so.
  assert.equal(parsePorts("").size, 0);

  // Malformed input contributes nothing rather than throwing — a typo must not
  // take the guard offline — but it must never add a port either.
  assert.equal(parsePorts("abc").size, 0);
  assert.equal(parsePorts("99999").size, 0);
  assert.equal(parsePorts("8080-3000").size, 0, "a reversed range is not a range");
  assert.equal(parsePorts("1-65535").size, 0, "an absurd range is refused, not expanded");
});

test("parseLines drops blanks and comments", () => {
  assert.deepEqual(parseLines("a\n\n  b  \n# note\nc"), ["a", "b", "c"]);
  assert.deepEqual(parseLines(""), []);
});
