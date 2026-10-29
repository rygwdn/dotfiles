import type { ApprovalPendingInteractionPayload } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const OMP_PLUGIN_ID = "provider-omp";

export const OMP_EXTENSION_UI_KIND = `${OMP_PLUGIN_ID}/extension-ui`;

export const OMP_EXTENSION_UI_RENDERER_ID = "extension-ui";

export const OMP_EXTENSION_UI_STATE_KIND = `${OMP_PLUGIN_ID}/extension-ui-state`;

export const ompExtensionUiStateSchema = z.object({
  coordinatorId: z.string().min(1),
  issuedThrough: z.number().int().nonnegative(),
  pendingRequestIds: z.array(z.string()),
});

export type OmpExtensionUiState = z.infer<typeof ompExtensionUiStateSchema>;

export const OMP_EDITOR_TEXT_STATE_KIND = `${OMP_PLUGIN_ID}/editor-text`;

export const ompEditorTextSchema = z.object({
  requestId: z.string().min(1),
  text: z.string(),
});

export type OmpEditorText = z.infer<typeof ompEditorTextSchema>;

export const OMP_STATUS_STATE_KIND = `${OMP_PLUGIN_ID}/status`;

export const OMP_NOTICE_KIND = `${OMP_PLUGIN_ID}/notice`;

export const OMP_STATUS_LIMITS = {
  statusKeys: 24,
  widgetKeys: 8,
  keyLength: 128,
  statusLength: 512,
  widgetLines: 16,
  lineLength: 512,
  stateBytes: 24576,
} as const;

const statusStateEncoder = new TextEncoder();

export const ompStatusStateSchema = z
  .object({
    statuses: z
      .array(
        z.object({
          key: z.string().max(OMP_STATUS_LIMITS.keyLength),
          text: z.string().max(OMP_STATUS_LIMITS.statusLength),
        }),
      )
      .max(OMP_STATUS_LIMITS.statusKeys),
    widgets: z
      .array(
        z.object({
          key: z.string().max(OMP_STATUS_LIMITS.keyLength),
          lines: z
            .array(z.string().max(OMP_STATUS_LIMITS.lineLength))
            .max(OMP_STATUS_LIMITS.widgetLines),
          placement: z.enum(["aboveEditor", "belowEditor"]),
        }),
      )
      .max(OMP_STATUS_LIMITS.widgetKeys),
    truncated: z.boolean().optional(),
  })
  .refine(
    (state) =>
      statusStateEncoder.encode(JSON.stringify(state)).byteLength <=
      OMP_STATUS_LIMITS.stateBytes,
    "OMP status state exceeds its serialized UTF-8 limit",
  );

export type OmpStatusState = z.infer<typeof ompStatusStateSchema>;

export const ompNoticeSchema = z.object({
  severity: z.enum(["info", "warning", "error"]).default("info"),
  message: z.string(),
  url: z.string().optional(),
  launchUrl: z.string().optional(),
  instructions: z.string().optional(),
});

export type OmpNotice = z.infer<typeof ompNoticeSchema>;

export const OMP_CARD_KIND = `${OMP_PLUGIN_ID}/card`;

export const OMP_CARD_LIMITS = {
  sections: 64,
  typeLength: 128,
  titleLength: 200,
  headingLength: 512,
  badgeLength: 128,
  metaLength: 2048,
  bodyLength: 32768,
  payloadBytes: 64 * 1024,
} as const;

const ompCardToneSchema = z.enum(["info", "warning", "error", "success"]);
const ompCardSectionSchema = z.object({
  heading: z.string().max(OMP_CARD_LIMITS.headingLength).optional(),
  badge: z.object({
    label: z.string().max(OMP_CARD_LIMITS.badgeLength),
    tone: ompCardToneSchema.optional(),
  }).optional(),
  meta: z.string().max(OMP_CARD_LIMITS.metaLength).optional(),
  body: z.string().max(OMP_CARD_LIMITS.bodyLength).optional(),
});

export const ompCardSchema = z.object({
  type: z.string().min(1).max(OMP_CARD_LIMITS.typeLength),
  title: z.string().min(1).max(OMP_CARD_LIMITS.titleLength),
  /** Short collapsed-row text shown after the title, e.g. note counts. */
  summary: z.string().min(1).max(OMP_CARD_LIMITS.titleLength).optional(),
  tone: ompCardToneSchema.optional(),
  sections: z.array(ompCardSectionSchema).max(OMP_CARD_LIMITS.sections),
}).refine(
  (card) => statusStateEncoder.encode(JSON.stringify(card)).byteLength <= OMP_CARD_LIMITS.payloadBytes,
  "OMP card exceeds its serialized UTF-8 limit",
);

export type OmpCard = z.infer<typeof ompCardSchema>;
export type OmpCardSection = z.infer<typeof ompCardSectionSchema>;

const ompAnsiPattern =
  /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)|\u001b[ -/]*[0-~]/gu;

export function stripOmpAnsi(text: string): string {
  return text.replace(ompAnsiPattern, "");
}

export const OMP_TOOL_BODY_LIMITS = {
  argumentsLength: 8192,
  outputLength: 32768,
  contentBlocks: 64,
  links: 16,
  urlLength: 2048,
} as const;

export const ompToolBodyNameSchema = z.enum([
  "read", "grep", "glob", "find", "ast_grep", "web_search", "write", "edit",
]);

// Non-text results stay with Original rather than silently dropping attachments.
export const ompToolBodyPayloadSchema = z.object({
  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  output: z.union([
    z.string(),
    z.null(),
    z.object({
      content: z.array(z.object({
        type: z.literal("text"),
        text: z.string(),
      }).strict()).max(OMP_TOOL_BODY_LIMITS.contentBlocks),
    }).passthrough(),
  ]),
});

export const OMP_EXTENSION_UI_LIMITS = {
  titleLength: 160,
  payloadBytes: 64 * 1024,
} as const;

const titleSchema = z.string().refine(
  (value) => value.trim().length > 0,
  "Extension UI title cannot be blank",
);
const timeoutSchema = z.number().finite().optional();

export const OMP_EXTENSION_UI_MAX_OPTIONS = 64;

const selectDialogSchema = z.object({
  method: z.literal("select"),
  options: z
    .array(z.string().max(512))
    .min(1)
    .max(OMP_EXTENSION_UI_MAX_OPTIONS),
  optionDetails: z
    .array(z.object({ description: z.string().optional() }))
    .max(OMP_EXTENSION_UI_MAX_OPTIONS)
    .optional(),
  timeout: timeoutSchema,
});

const confirmDialogSchema = z.object({
  method: z.literal("confirm"),
  message: z.string(),
  timeout: timeoutSchema,
});

const inputDialogSchema = z.object({
  method: z.literal("input"),
  placeholder: z.string().optional(),
  timeout: timeoutSchema,
});

const editorDialogSchema = z.object({
  method: z.literal("editor"),
  prefill: z.string().optional(),
  promptStyle: z.boolean().optional(),
});

const askQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  header: z.string().optional(),
  options: z
    .array(
      z.object({
        label: z.string().max(512),
        description: z.string().optional(),
        preview: z.string().optional(),
      }),
    )
    .max(OMP_EXTENSION_UI_MAX_OPTIONS),
  multi: z.boolean().optional(),
  recommended: z.number().int().nonnegative().optional(),
});

const askDialogSchema = z.object({
  method: z.literal("ask"),
  questions: z
    .array(askQuestionSchema)
    .min(1)
    .refine(
      (questions) =>
        new Set(questions.map((question) => question.id)).size === questions.length,
      "Ask question ids must be unique",
    ),
  timeout: timeoutSchema,
});

const titledRequestFields = { id: z.string(), title: titleSchema };

export const ompExtensionUiRequestSchema = z.discriminatedUnion("method", [
  selectDialogSchema.extend(titledRequestFields),
  confirmDialogSchema.extend(titledRequestFields),
  inputDialogSchema.extend(titledRequestFields),
  editorDialogSchema.extend(titledRequestFields),
  askDialogSchema.extend({ id: z.string() }),
]);

export type OmpExtensionUiRequest = z.infer<typeof ompExtensionUiRequestSchema>;

const payloadFields = {
  requestId: z.string().min(1),
  expiresAt: z.number().finite().optional(),
  detail: z.string().optional(),
  truncated: z.boolean().optional(),
  lifecycle: z
    .object({
      coordinatorId: z.string().min(1),
      sequence: z.number().int().positive(),
    })
    .optional(),
};

const dialogPayloadSchema = z.discriminatedUnion("method", [
  selectDialogSchema.extend(payloadFields),
  confirmDialogSchema.extend(payloadFields),
  inputDialogSchema.extend(payloadFields),
  editorDialogSchema.extend(payloadFields),
  askDialogSchema.extend(payloadFields),
]);

export const ompExtensionUiPayloadDataSchema = dialogPayloadSchema.refine(
  (data) =>
    statusStateEncoder.encode(JSON.stringify(data)).byteLength <=
    OMP_EXTENSION_UI_LIMITS.payloadBytes,
  "OMP dialog data exceeds 64 KiB",
);

export type OmpExtensionUiPayloadData = z.infer<
  typeof ompExtensionUiPayloadDataSchema
>;

export function createBoundedExtensionUiPayload(
  value: unknown,
): OmpExtensionUiPayloadData {
  const data = dialogPayloadSchema.parse(value);
  let bytes = statusStateEncoder.encode(JSON.stringify(data)).byteLength;
  if (bytes <= OMP_EXTENSION_UI_LIMITS.payloadBytes) return data;

  data.truncated = true;
  bytes = statusStateEncoder.encode(JSON.stringify(data)).byteLength;
  const marker = "\n[… truncated to fit bb's 64 KiB dialog limit …]";
  const markerBytes = statusStateEncoder.encode(JSON.stringify(marker)).byteLength;
  const fields: Array<{
    owner: Record<string, unknown>;
    key: string;
    text: string;
    bytes: number;
  }> = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value !== null && typeof value === "object") {
      const owner = value as Record<string, unknown>;
      for (const [key, text] of Object.entries(owner)) {
        // Keep response identities intact, even when display text is shortened.
        if (["method", "requestId", "coordinatorId", "id", "label"].includes(key)) {
          continue;
        }
        if (typeof text === "string") {
          fields.push({
            owner,
            key,
            text,
            bytes: statusStateEncoder.encode(JSON.stringify(text)).byteLength,
          });
        } else {
          collect(text);
        }
      }
    }
  };
  collect(data);
  fields.sort((left, right) => right.bytes - left.bytes);
  for (const field of fields) {
    if (bytes <= OMP_EXTENSION_UI_LIMITS.payloadBytes) break;
    if (field.bytes <= markerBytes) continue;
    const target = Math.max(
      markerBytes,
      field.bytes - (bytes - OMP_EXTENSION_UI_LIMITS.payloadBytes),
    );
    let low = 0;
    let high = field.text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = field.text.slice(0, mid) + marker;
      if (statusStateEncoder.encode(JSON.stringify(candidate)).byteLength <= target) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    if (low > 0 && /[\ud800-\udbff]/u.test(field.text[low - 1]!)) low -= 1;
    const text = field.text.slice(0, low) + marker;
    field.owner[field.key] = text;
    bytes += statusStateEncoder.encode(JSON.stringify(text)).byteLength - field.bytes;
  }
  // Do not shorten labels or question ids: an answer must retain its meaning.
  return ompExtensionUiPayloadDataSchema.parse(data);
}

export const ompExtensionUiResolutionSchema = z.object({
  kind: z.literal("request_answer"),
  value: z.unknown(),
});

export type OmpExtensionUiResolution = z.infer<
  typeof ompExtensionUiResolutionSchema
>;

export type OmpExtensionUiResponseFields =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true; timedOut?: boolean }
  | {
      answers: Array<{
        id: string;
        selectedOptions: string[];
        customInput?: string;
      }>;
    };

export interface InteractionUiRequest {
  jsonrpc: "2.0";
  id: string;
  method: "interaction/request";
  params: {
    providerThreadId: string;
    threadId: string;
    turnId: null;
    payload:
      | {
          kind: typeof OMP_EXTENSION_UI_KIND;
          title: string;
          data: OmpExtensionUiPayloadData;
        }
      | ApprovalPendingInteractionPayload;
  };
}

export type RuntimeInteractionUiResponse = {
  id: string | number;
  result?: unknown;
  error?: { message?: string };
};

const cancellationSchema = z.object({
  cancelled: z.literal(true),
  timedOut: z.boolean().optional(),
});

const askAnswersSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      selectedOptions: z.array(z.string()),
      customInput: z.string().optional(),
    }),
  ),
});

export function resolveExtensionUiResponseFields(
  request: OmpExtensionUiRequest,
  result: OmpExtensionUiResolution,
): OmpExtensionUiResponseFields {
  const { value } = result;
  const cancellation = cancellationSchema.safeParse(value);
  if (cancellation.success) {
    return cancellation.data.timedOut
      ? { cancelled: true, timedOut: true }
      : { cancelled: true };
  }
  if (request.method === "ask") {
    const parsed = askAnswersSchema.safeParse(value);
    if (!parsed.success || parsed.data.answers.length !== request.questions.length) {
      return { cancelled: true };
    }
    for (let index = 0; index < request.questions.length; index += 1) {
      const question = request.questions[index]!;
      const answer = parsed.data.answers[index]!;
      const customInput = answer.customInput?.trim() || undefined;
      if (
        answer.id !== question.id ||
        answer.selectedOptions.some(
          (label) => !question.options.some((option) => option.label === label),
        ) ||
        new Set(answer.selectedOptions).size !== answer.selectedOptions.length ||
        (!question.multi &&
          (answer.selectedOptions.length > 1 ||
            (answer.selectedOptions.length > 0 && customInput !== undefined)))
      ) {
        return { cancelled: true };
      }
      if (customInput === undefined) {
        delete answer.customInput;
      } else {
        answer.customInput = customInput;
      }
    }
    return parsed.data;
  }
  if (request.method === "confirm") {
    return typeof value === "boolean"
      ? { confirmed: value }
      : { cancelled: true };
  }
  if (typeof value !== "string") {
    return { cancelled: true };
  }
  if (request.method === "select" && !request.options.includes(value)) {
    return { cancelled: true };
  }
  return { value };
}
