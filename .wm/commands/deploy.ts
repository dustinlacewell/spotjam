import { cmd } from "@ldlework/workmark/define";
import { compose } from "../traits/compose.js";

/** Rebuild a Compose stack's images, restart it, and show its containers. */
export default cmd({
  needs: [compose],
  handler: (_, { traits, sh }) =>
    sh([
      `docker compose -p ${traits.compose.project} up -d --build`,
      `docker compose -p ${traits.compose.project} ps`,
    ]),
});
