import { z } from "zod";
import { defineTrait } from "@ldlework/workmark/define";

/** A project that runs as a Docker Compose stack from its own directory. */
export const compose = defineTrait({
  name: "compose",
  schema: z.object({ project: z.string() }),
});
