import { z } from "zod";

export const OMP_PRESET_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

// Preset defaults exclude `off`; individual role selectors can still use it.
export const OMP_PRESET_DEFAULT_THINKING_LEVELS = [
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface OmpPresetRole {
  id: string;
  name: string;
  section: "chat" | "kind";
}

// OMP's MODEL_ROLES order and labels (config/model-roles.ts).
export const OMP_PRESET_BUILT_IN_ROLES: readonly OmpPresetRole[] = [
  { id: "default", name: "Default", section: "chat" },
  { id: "smol", name: "Fast", section: "chat" },
  { id: "slow", name: "Thinking", section: "chat" },
  { id: "vision", name: "Vision", section: "chat" },
  { id: "plan", name: "Architect", section: "chat" },
  { id: "commit", name: "Commit", section: "chat" },
  { id: "tiny", name: "Tiny", section: "chat" },
  { id: "memory", name: "Memory", section: "chat" },
  { id: "task", name: "Subtask", section: "chat" },
  { id: "advisor", name: "Advisor", section: "chat" },
  { id: "widget", name: "Job widgets", section: "chat" },
  { id: "image", name: "Image generation", section: "kind" },
  { id: "web", name: "Web search", section: "kind" },
  { id: "speech", name: "Speech", section: "kind" },
  { id: "dictation", name: "Dictation", section: "kind" },
  { id: "judge", name: "Judge", section: "kind" },
];

export const ompModelPresetValueSchema = z.object({
  modelRoles: z.record(z.string().min(1), z.string().refine((value) => value.trim() !== "", "Choose a model or remove the role.")),
  defaultThinkingLevel: z.string().optional(),
}).strict();

export const ompEditableModelPresetSchema = ompModelPresetValueSchema.extend({
  name: z.string().min(1),
});

export const ompModelPresetsRevisionSchema = z.object({
  mtimeMs: z.number().nullable(),
  contentHash: z.string().nullable(),
}).strict();

export const ompModelPresetsSnapshotSchema = z.object({
  configPath: z.string(),
  revision: ompModelPresetsRevisionSchema,
  presetsRevision: z.string(),
  presets: z.array(ompEditableModelPresetSchema),
  modelRoles: z.record(z.string(), z.string()),
});

export const ompPresetModelOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  thinkingLevels: z.array(z.string()),
});

export const ompModelPresetsHostMethods = {
  listModelPresets: {
    input: z.object({}).strict(),
    output: ompModelPresetsSnapshotSchema.extend({
      models: z.array(ompPresetModelOptionSchema),
      catalogError: z.string().optional(),
    }),
  },
  saveModelPreset: {
    input: z.object({
      name: z.string().min(1),
      previousName: z.string().min(1).optional(),
      preset: ompModelPresetValueSchema,
      expectedRevision: ompModelPresetsRevisionSchema,
    }).strict(),
    output: ompModelPresetsSnapshotSchema,
  },
  deleteModelPreset: {
    input: z.object({
      name: z.string().min(1),
      expectedRevision: ompModelPresetsRevisionSchema,
    }).strict(),
    output: ompModelPresetsSnapshotSchema,
  },
} as const;

// Both boundaries validate the same input; the server selects the primary host.
export const ompModelPresetsRpcContract = ompModelPresetsHostMethods;

export type OmpModelPresetValue = z.infer<typeof ompModelPresetValueSchema>;
export type OmpEditableModelPreset = z.infer<typeof ompEditableModelPresetSchema>;
export type OmpModelPresetsRevision = z.infer<typeof ompModelPresetsRevisionSchema>;
export type OmpModelPresetsSnapshot = z.infer<typeof ompModelPresetsSnapshotSchema>;
export type OmpPresetModelOption = z.infer<typeof ompPresetModelOptionSchema>;
export type OmpModelPresetsList = z.infer<typeof ompModelPresetsHostMethods.listModelPresets.output>;
export type OmpModelPresetsRpcContract = typeof ompModelPresetsRpcContract;
