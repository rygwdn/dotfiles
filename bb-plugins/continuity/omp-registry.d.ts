declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  export interface Setting {
    get(scope: unknown): unknown;
    provenance(scope: unknown): string;
    override(scope: unknown, value: unknown): void;
    clearOverride(scope: unknown): void;
  }
  export function lookup(id: string): Setting | undefined;
}
