import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { z } from "zod";

const sessionHeaderSchema = z
  .object({
    type: z.literal("session"),
    cwd: z.string(),
  })
  .passthrough();

export function ompSessionNeedsRelocation(
  sessionFile: string,
  cwd: string,
): boolean {
  if (!statSync(cwd).isDirectory()) {
    throw new Error(
      `Cannot resume: working directory "${cwd}" is not a directory.`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  const [firstLine, secondLine] = contents.split("\n", 2);
  const firstRecord: unknown = JSON.parse(firstLine ?? "");
  const header = sessionHeaderSchema.parse(
    firstRecord !== null &&
      typeof firstRecord === "object" &&
      "type" in firstRecord &&
      firstRecord.type === "title"
      ? JSON.parse(secondLine ?? "")
      : firstRecord,
  );
  return (
    header.cwd !== cwd &&
    !(existsSync(header.cwd) && realpathSync(header.cwd) === realpathSync(cwd))
  );
}
