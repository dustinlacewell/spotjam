import { defineProject } from "@ldlework/workmark/define";

export default defineProject({
  name: "server",
  tags: ["backend"],
  has: { compose: { project: "spotjam" } },
});
