import { z } from "zod";

// Materialize on the execution host, never assume the BB server's filesystem.
export const ompCutoverHostContract = {
  prepareOmpMemoryOverlay: {
    input: z.null(),
    output: z.object({ configFiles: z.string().min(1) }).strict(),
  },
};
