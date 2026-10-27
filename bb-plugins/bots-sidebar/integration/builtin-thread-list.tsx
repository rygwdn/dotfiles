import type { ComponentType } from "react";
import type { PluginAppBuilder, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import nativeApp from "../.generated/bb/thread-list/app";

let NativeThreadList: ComponentType<PluginThreadListProps> | undefined;

export function registerBuiltinThreadList(app: PluginAppBuilder) {
  NativeThreadList = undefined;
  // Capture the upstream entrypoint's complete component, not a hand-maintained
  // copy of its provider stack. The bundled thread-list remains enabled and
  // owns global actions (notably thread-list/move) and layout preferences.
  nativeApp.setup({
    ...app,
    slots: {
      ...app.slots,
      experimental_threadList(registration) {
        if (NativeThreadList) throw new Error("Builtin thread-list registered more than one list");
        NativeThreadList = registration.component;
      },
      experimental_threadAction(registration) {
        if (registration.id !== "move") {
          throw new Error(`Review new builtin thread action before upgrading: ${registration.id}`);
        }
        // thread-list/move is already registered by the bundled plugin.
      },
    },
  });
  if (!NativeThreadList) throw new Error("Builtin thread-list no longer exports a list registration");
}

export function BuiltinThreadList(props: PluginThreadListProps) {
  if (!NativeThreadList) throw new Error("Builtin thread-list has not been registered");
  return <NativeThreadList {...props} />;
}
