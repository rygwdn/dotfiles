import { expect, it } from "vitest";
import { ompProviderDeclaration } from "./declaration.js";
import { ompContextNotesStateSchema } from "./hub-contract.js";
import { DEFAULT_OMP_MODEL_FILTER } from "./model-curation.js";

it("declares the context-notes extension state", () => {
  const state = ompProviderDeclaration(DEFAULT_OMP_MODEL_FILTER).extensionKinds?.["context-notes"]?.state;
  expect(state).toBe(ompContextNotesStateSchema);
});
