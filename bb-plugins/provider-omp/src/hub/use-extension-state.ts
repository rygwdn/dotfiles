import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";

export function useLatestExtensionState<T>(
  threadId: string,
  kind: string,
  schema: z.ZodType<T>,
): T | null {
  const sdk = useSdk();
  const [snapshot, setSnapshot] = useState<{
    threadId: string;
    kind: string;
    value: T | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const currentRevision = ++revision;
      let beforeSeq: string | undefined;
      try {
        while (!disposed && currentRevision === revision) {
          const events = await sdk.threads.events.list({
            threadId,
            types: ["thread/extensionState/updated"],
            order: "desc",
            limit: "100",
            beforeSeq,
            signal: controller.signal,
          });
          if (disposed || currentRevision !== revision) return;
          const event = events.find(
            (event) =>
              event.threadId === threadId &&
              event.type === "thread/extensionState/updated" &&
              event.data.kind === kind,
          );
          if (event?.type === "thread/extensionState/updated") {
            const parsed = schema.safeParse(event.data.payload);
            setSnapshot({
              threadId,
              kind,
              value: parsed.success ? parsed.data : null,
            });
            return;
          }
          if (events.length < 100) {
            setSnapshot({ threadId, kind, value: null });
            return;
          }
          beforeSeq = String(events[events.length - 1]!.seq);
        }
      } catch {}
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.id === undefined || event.id === threadId) void refresh();
      },
    });
    const unsubscribeConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) void refresh();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
      unsubscribeConnection();
    };
  }, [sdk, threadId, kind, schema]);

  return snapshot?.threadId === threadId && snapshot.kind === kind
    ? snapshot.value
    : null;
}
