import { expect, it } from "vitest";
import { runSettlementError } from "./run-settlement.js";

it("does not infer interruption from successful assistant prose", () => {
  expect(runSettlementError([{
    role: "assistant", stopReason: "stop", content: "I was aborted; continue?",
  }])).toBeUndefined();
});

it("recognizes an aborted assistant snapshot even after trailing tool results", () => {
  expect(runSettlementError([
    { role: "assistant", stopReason: "aborted" },
    { role: "toolResult" },
  ])).toBe("OMP run interrupted unexpectedly; no automatic resume was attempted");
});

it.each([
  [undefined, "OMP run failed"],
  ["", "OMP run failed"],
  ["  ", "OMP run failed"],
  ["provider unavailable", "provider unavailable"],
])("reports assistant errors with detail %j", (errorMessage, expected) => {
  expect(runSettlementError([{ role: "assistant", stopReason: "error", errorMessage }])).toBe(expected);
});

it("uses the final assistant instead of an earlier retry failure", () => {
  expect(runSettlementError([
    { role: "assistant", stopReason: "error", errorMessage: "retryable" },
    { role: "assistant", stopReason: "stop" },
  ])).toBeUndefined();
});

it.each([null, undefined, {}, [], [null, "not a message", { role: "toolResult" }]])(
  "has no assistant failure for %j", (messages) => {
    expect(runSettlementError(messages)).toBeUndefined();
  },
);
