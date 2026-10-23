export function runSettlementError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index];
    if (message === null || typeof message !== "object" ||
      !("role" in message) || message.role !== "assistant") continue;
    if ("stopReason" in message && message.stopReason === "aborted") {
      return "OMP run interrupted unexpectedly; no automatic resume was attempted";
    }
    if ("stopReason" in message && message.stopReason === "error") {
      return "errorMessage" in message && typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? message.errorMessage
        : "OMP run failed";
    }
    return undefined;
  }
  return undefined;
}
