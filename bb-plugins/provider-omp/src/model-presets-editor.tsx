import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  OMP_PRESET_BUILT_IN_ROLES,
  OMP_PRESET_DEFAULT_THINKING_LEVELS,
  OMP_PRESET_THINKING_LEVELS,
  type OmpEditableModelPreset,
  type OmpModelPresetsList,
  type OmpModelPresetsRpcContract,
  type OmpPresetModelOption,
  type OmpPresetRole,
} from "./model-presets-contract.js";

const THINKING_LEVELS = new Set<string>(OMP_PRESET_THINKING_LEVELS);
const DEFAULT_THINKING_LEVELS = new Set<string>(OMP_PRESET_DEFAULT_THINKING_LEVELS);
const BUILT_IN_ROLE_NAMES = new Map(OMP_PRESET_BUILT_IN_ROLES.map((role) => [role.id, role.name]));
const CONTROL_CLASS = "h-9 w-full min-w-0 rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface RoleDraft {
  model: string;
  thinkingLevel: string;
  custom: boolean;
}

interface PresetDraft {
  name: string;
  previousName?: string;
  roles: Record<string, RoleDraft>;
  defaultThinkingLevel?: string;
}

const EMPTY_ROLE: RoleDraft = { model: "", thinkingLevel: "", custom: false };

/** Only the final, recognized thinking suffix is separate from the model selector. */
export function splitOmpPresetSelector(selector: string): { model: string; thinkingLevel: string } {
  const separator = selector.lastIndexOf(":");
  const suffix = selector.slice(separator + 1);
  if (separator > 0 && THINKING_LEVELS.has(suffix)) {
    return { model: selector.slice(0, separator), thinkingLevel: suffix };
  }
  return { model: selector, thinkingLevel: "" };
}

function draftRoles(roles: Record<string, string>, modelIds: ReadonlySet<string>): Record<string, RoleDraft> {
  return Object.fromEntries(Object.entries(roles).map(([role, selector]) => {
    const parts = splitOmpPresetSelector(selector);
    return [role, { ...parts, custom: parts.model !== "" && !modelIds.has(parts.model) }];
  }));
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return typeof cause === "string" && cause ? cause : fallback;
}

function ModelRoleRow({
  role,
  assignment,
  models,
  modelIds,
  disabled,
  onChange,
}: {
  role: OmpPresetRole;
  assignment: RoleDraft;
  models: OmpPresetModelOption[];
  modelIds: ReadonlySet<string>;
  disabled: boolean;
  onChange: (assignment: RoleDraft) => void;
}) {
  const labelId = useId();
  const custom = assignment.custom || (assignment.model !== "" && !modelIds.has(assignment.model));
  const selection = custom ? "custom" : assignment.model === "" ? "not-set" : `model:${assignment.model}`;

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2 rounded-md border border-border p-3">
      <p id={labelId} className="text-sm font-medium">
        {role.name}
        {role.name !== role.id ? <code className="ml-2 text-xs font-normal text-muted-foreground">{role.id}</code> : null}
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="min-w-0 space-y-2">
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>Model</span>
            <select
              aria-label={`${role.name} model`}
              className={CONTROL_CLASS}
              disabled={disabled}
              value={selection}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "not-set") onChange({ ...EMPTY_ROLE });
                else if (value === "custom") onChange({ ...assignment, custom: true });
                else onChange({ ...assignment, model: value.slice("model:".length), custom: false });
              }}
            >
              <option value="not-set">Not set</option>
              {models.map((model) => (
                <option key={model.id} value={`model:${model.id}`}>
                  {model.name === model.id ? model.id : `${model.name} — ${model.id}`}
                </option>
              ))}
              <option value="custom">Custom selector…</option>
            </select>
          </label>
          {custom ? (
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Custom model ID, alias or pattern</span>
              <input
                aria-label={`${role.name} custom selector`}
                className={CONTROL_CLASS}
                type="text"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={assignment.model}
                onChange={(event) => onChange({ ...assignment, model: event.target.value, custom: true })}
              />
            </label>
          ) : null}
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>Thinking suffix</span>
          <select
            aria-label={`${role.name} thinking suffix`}
            className={CONTROL_CLASS}
            disabled={disabled || assignment.model.trim() === ""}
            value={assignment.thinkingLevel}
            onChange={(event) => onChange({ ...assignment, thinkingLevel: event.target.value })}
          >
            <option value="">None</option>
            {OMP_PRESET_THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

export function OmpModelPresetsEditor() {
  const rpc = useRpc<OmpModelPresetsRpcContract>();
  const formId = useId();
  const [result, setResult] = useState<OmpModelPresetsList | null>(null);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [pending, setPending] = useState<"load" | "save" | "delete" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestId = useRef(0);
  const operationPending = useRef(false);
  const busy = pending !== null;
  const modelIds = useMemo(() => new Set(result?.models.map((model) => model.id) ?? []), [result?.models]);
  const roles = useMemo(() => {
    const builtInIds = new Set(OMP_PRESET_BUILT_IN_ROLES.map((role) => role.id));
    const customIds = new Set([
      ...Object.keys(result?.modelRoles ?? {}),
      ...(result?.presets.flatMap((preset) => Object.keys(preset.modelRoles)) ?? []),
      ...Object.keys(draft?.roles ?? {}),
    ]);
    return [
      ...OMP_PRESET_BUILT_IN_ROLES,
      ...[...customIds].filter((id) => !builtInIds.has(id)).sort().map((id) => ({ id, name: id, section: "chat" as const })),
    ];
  }, [result?.modelRoles, result?.presets, draft?.roles]);

  useEffect(() => {
    const request = ++requestId.current;
    operationPending.current = true;
    setPending("load");
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const next = await rpc.call("listModelPresets", {});
        if (request !== requestId.current) return;
        setResult(next);
        setDeleteName((name) => next.presets.some((preset) => preset.name === name) ? name : null);
        if (reloadVersion > 0) setNotice("Model presets reloaded. Any unsaved edits have been kept.");
      } catch (cause) {
        if (request === requestId.current) setError(errorMessage(cause, "Could not load model presets."));
      } finally {
        if (request === requestId.current) {
          operationPending.current = false;
          setPending(null);
        }
      }
    })();
    return () => {
      ++requestId.current;
      operationPending.current = false;
    };
  }, [rpc, reloadVersion]);

  const reload = () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setPending("load");
    setReloadVersion((version) => version + 1);
  };

  const edit = (preset?: OmpEditableModelPreset) => {
    if (operationPending.current || draft) return;
    setDraft({
      name: preset?.name ?? "",
      previousName: preset?.name,
      roles: draftRoles(preset?.modelRoles ?? {}, modelIds),
      defaultThinkingLevel: preset?.defaultThinkingLevel,
    });
    setDeleteName(null);
    setValidationError(null);
    setError(null);
    setNotice(null);
  };

  const save = async () => {
    if (!result || !draft || operationPending.current) return;
    if (!/^[a-zA-Z][\w-]*$/u.test(draft.name)) {
      setValidationError("Use a preset name starting with a letter, followed only by letters, numbers, underscores or hyphens.");
      return;
    }
    if (result.presets.some((preset) => preset.name === draft.name && preset.name !== draft.previousName)) {
      setValidationError(`A preset named “${draft.name}” already exists.`);
      return;
    }
    if (draft.defaultThinkingLevel !== undefined && !DEFAULT_THINKING_LEVELS.has(draft.defaultThinkingLevel)) {
      setValidationError("Choose a supported default thinking level or Not set before saving.");
      return;
    }
    const modelRoles = Object.fromEntries(Object.entries(draft.roles)
      .filter(([, assignment]) => assignment.model.trim() !== "")
      .map(([role, assignment]) => [role, assignment.model + (assignment.thinkingLevel ? `:${assignment.thinkingLevel}` : "")]));
    if (Object.keys(modelRoles).length === 0) {
      setValidationError("Assign at least one role to a model or custom selector.");
      return;
    }

    operationPending.current = true;
    const request = ++requestId.current;
    setPending("save");
    setValidationError(null);
    setError(null);
    setNotice(null);
    try {
      const next = await rpc.call("saveModelPreset", {
        name: draft.name,
        ...(draft.previousName === undefined ? {} : { previousName: draft.previousName }),
        preset: {
          modelRoles,
          ...(draft.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: draft.defaultThinkingLevel }),
        },
        expectedRevision: result.revision,
      });
      if (request !== requestId.current) return;
      setResult((current) => current ? { ...current, ...next } : current);
      setDraft(null);
      setNotice(`Saved preset “${draft.name}”.`);
    } catch (cause) {
      if (request === requestId.current) setError(errorMessage(cause, "Could not save the model preset."));
    } finally {
      if (request === requestId.current) {
        operationPending.current = false;
        setPending(null);
      }
    }
  };

  const remove = async (name: string) => {
    if (!result || draft || operationPending.current) return;
    operationPending.current = true;
    const request = ++requestId.current;
    setPending("delete");
    setError(null);
    setNotice(null);
    try {
      const next = await rpc.call("deleteModelPreset", { name, expectedRevision: result.revision });
      if (request !== requestId.current) return;
      setResult((current) => current ? { ...current, ...next } : current);
      setDeleteName(null);
      setNotice(`Deleted preset “${name}”.`);
    } catch (cause) {
      if (request === requestId.current) setError(errorMessage(cause, "Could not delete the model preset."));
    } finally {
      if (request === requestId.current) {
        operationPending.current = false;
        setPending(null);
      }
    }
  };

  const renderRole = (role: OmpPresetRole) => (
    <ModelRoleRow
      key={role.id}
      role={role}
      assignment={draft && Object.hasOwn(draft.roles, role.id) ? draft.roles[role.id] : EMPTY_ROLE}
      models={result?.models ?? []}
      modelIds={modelIds}
      disabled={busy}
      onChange={(assignment) => {
        setDraft((current) => current ? { ...current, roles: { ...current.roles, [role.id]: assignment } } : current);
        setValidationError(null);
      }}
    />
  );

  return (
    <section aria-label="OMP model presets" className="space-y-4 text-foreground" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">
        Edit presets in your global OMP configuration. Saving a preset does not change any thread’s active model.
      </p>
      {result ? (
        <p className="break-all text-xs text-muted-foreground">Global config: <code>{result.configPath}</code></p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || !result || draft !== null} onClick={() => edit()}>New preset</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={reload}>Reload presets</Button>
      </div>
      {pending === "load" ? <p role="status" className="text-sm text-muted-foreground">{result ? "Reloading model presets…" : "Loading model presets…"}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {error ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm">
          <p className="whitespace-pre-wrap break-words text-destructive">{error}</p>
          {result ? <p className="text-muted-foreground">If the configuration changed on disk, reload before saving again. Reloading keeps your unsaved form.</p> : null}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={reload}>
            {result ? "Reload and keep draft" : "Retry loading presets"}
          </Button>
        </div>
      ) : null}
      {result?.catalogError ? (
        <p className="break-words text-sm text-muted-foreground">Model catalog unavailable: {result.catalogError} You can still enter custom model selectors.</p>
      ) : null}
      {result ? (
        <>
          {result.presets.length === 0 ? <p className="text-sm text-muted-foreground">No model presets configured.</p> : (
            <ul aria-label="Model presets" className="space-y-3">
              {result.presets.map((preset) => (
                <li key={preset.name} className="min-w-0 space-y-3 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="break-all text-sm font-semibold">{preset.name}</h3>
                    <div className="flex gap-1">
                      <Button type="button" size="sm" variant="outline" aria-label={`Edit preset ${preset.name}`} disabled={busy || draft !== null} onClick={() => edit(preset)}>Edit</Button>
                      <Button type="button" size="sm" variant="ghost" aria-label={`Delete preset ${preset.name}`} disabled={busy || draft !== null} onClick={() => { setDeleteName(preset.name); setError(null); setNotice(null); }}>Delete</Button>
                    </div>
                  </div>
                  <dl aria-label={`${preset.name} role assignments`} className="space-y-1 text-xs">
                    {Object.entries(preset.modelRoles).map(([role, selector]) => (
                      <div key={role} className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">{BUILT_IN_ROLE_NAMES.get(role) ?? role}:</dt>
                        <dd className="min-w-0 break-all"><code>{selector}</code></dd>
                      </div>
                    ))}
                  </dl>
                  {preset.defaultThinkingLevel !== undefined ? <p className="break-all text-xs text-muted-foreground">Default thinking: {preset.defaultThinkingLevel || "(empty value)"}</p> : null}
                  {deleteName === preset.name ? (
                    <div role="alertdialog" aria-label={`Delete preset ${preset.name}?`} className="space-y-2 rounded-md border border-destructive p-3 text-sm">
                      <p>Delete “{preset.name}” from global presets? This cannot be undone.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="destructive" aria-label={`Confirm delete ${preset.name}`} disabled={busy} onClick={() => void remove(preset.name)}>{pending === "delete" ? "Deleting…" : "Delete preset"}</Button>
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeleteName(null)}>Cancel deletion</Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {draft ? (
            <form
              aria-label={draft.previousName === undefined ? "New model preset" : `Edit preset ${draft.previousName}`}
              className="space-y-4 rounded-md border border-border p-4"
              noValidate
              onSubmit={(event) => { event.preventDefault(); void save(); }}
            >
              <h3 className="text-sm font-semibold">{draft.previousName === undefined ? "New preset" : `Edit ${draft.previousName}`}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-xs text-muted-foreground" htmlFor={`${formId}-name`}>
                  <span>Preset name</span>
                  <input
                    id={`${formId}-name`}
                    aria-label="Preset name"
                    type="text"
                    className={CONTROL_CLASS}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    value={draft.name}
                    onChange={(event) => { const name = event.target.value; setDraft((current) => current ? { ...current, name } : current); setValidationError(null); }}
                    aria-describedby={`${formId}-name-help`}
                  />
                  <span id={`${formId}-name-help`}>Start with a letter; use letters, numbers, underscores and hyphens.</span>
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>Default thinking level</span>
                  <select
                    className={CONTROL_CLASS}
                    disabled={busy}
                    value={draft.defaultThinkingLevel === undefined ? "unset" : `level:${draft.defaultThinkingLevel}`}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDraft((current) => current ? { ...current, defaultThinkingLevel: value === "unset" ? undefined : value.slice("level:".length) } : current);
                      setValidationError(null);
                    }}
                  >
                    <option value="unset">Not set</option>
                    {OMP_PRESET_DEFAULT_THINKING_LEVELS.map((level) => <option key={level} value={`level:${level}`}>{level}</option>)}
                    {draft.defaultThinkingLevel !== undefined && !DEFAULT_THINKING_LEVELS.has(draft.defaultThinkingLevel) ? (
                      <option value={`level:${draft.defaultThinkingLevel}`}>Unsupported value: {draft.defaultThinkingLevel || "(empty value)"}</option>
                    ) : null}
                  </select>
                </label>
              </div>
              <div className="space-y-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDraft((current) => current ? { ...current, roles: draftRoles(result.modelRoles, modelIds) } : current);
                    setValidationError(null);
                  }}
                >Start from current roles</Button>
                <p className="text-xs text-muted-foreground">Not set omits a role from this preset. Custom selectors preserve model IDs, aliases and patterns; recognized final thinking suffixes are shown separately.</p>
              </div>
              <div className="space-y-3" aria-label="Chat and custom roles">
                {roles.filter((role) => role.section === "chat").map(renderRole)}
              </div>
              <details className="space-y-3 rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">Other roles</summary>
                <div className="space-y-3 pt-3">{roles.filter((role) => role.section === "kind").map(renderRole)}</div>
              </details>
              {validationError ? <p role="alert" className="text-sm text-destructive">{validationError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy}>{pending === "save" ? "Saving…" : "Save preset"}</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(null); setValidationError(null); setError(null); }}>Cancel editing</Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
