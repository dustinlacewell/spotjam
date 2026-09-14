import { open } from "@tauri-apps/plugin-dialog";

/**
 * Asks the OS for an identity file to import.
 *
 * Isolated from the identity client because it is the one piece of onboarding
 * that needs a native window. Returns null when the user cancels, and also
 * when the dialog is unavailable — the import form keeps a plain path input
 * alongside Browse, so a failure here costs the convenience, not the feature.
 */
export async function pickIdentityFile(): Promise<string | null> {
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose your identity file",
      filters: [{ name: "Identity", extensions: ["json"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}
