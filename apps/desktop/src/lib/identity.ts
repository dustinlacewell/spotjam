import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  canonicalBytes,
  type CanonicalValue,
  type Envelope,
  type PublicKeyHex,
  type SignatureHex,
} from "@spotjam/protocol";

/** Matches the injected-invoke seam used by PlaybackDriver. */
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** What the app knows about the local user once onboarding has run. */
export interface StoredIdentity {
  publicKey: PublicKeyHex;
  username: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The exact shape the protocol signs. Mirrors `signingBody` in
 * packages/protocol/src/envelope.ts — the server verifies against that one, so
 * any divergence here produces envelopes nobody accepts.
 */
export function signingBody<P extends CanonicalValue>(
  payload: P,
  pubkey: PublicKeyHex,
  nonce: string,
  timestamp: number,
): CanonicalValue {
  return { nonce, payload, pubkey, timestamp };
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Assembles an envelope from a signature someone else produced.
 *
 * Pure: the caller supplies the signature, so this is testable without Rust
 * and is the half of sealing that carries the protocol's rules.
 */
export function envelopeFrom<P extends CanonicalValue>(
  payload: P,
  pubkey: PublicKeyHex,
  nonce: string,
  timestamp: number,
  signature: SignatureHex,
): Envelope<P> {
  return { payload, pubkey, nonce, timestamp, signature };
}

/**
 * Talks to the Rust identity commands. The secret key stays on that side: this
 * class can ask for a signature but never sees the key that made it.
 */
export class IdentityClient {
  constructor(private readonly invoke: Invoke = tauriInvoke as Invoke) {}

  /** The stored identity, or null when this machine has none yet. */
  async load(): Promise<StoredIdentity | null> {
    const publicKey = await this.invoke<string | null>("identity_load");
    if (!publicKey) return null;
    const username = await this.invoke<string | null>("identity_username");
    return { publicKey, username: username ?? "" };
  }

  /** Generates and stores a new keypair. */
  async create(username: string): Promise<StoredIdentity> {
    const publicKey = await this.invoke<string>("identity_create", { username });
    return { publicKey, username };
  }

  /** Installs an identity file from disk. */
  async import(path: string): Promise<StoredIdentity> {
    const publicKey = await this.invoke<string>("identity_import", { path });
    const username = await this.invoke<string | null>("identity_username");
    return { publicKey, username: username ?? "" };
  }

  /** Where the identity file lives, for the user to back up. */
  exportPath(): Promise<string> {
    return this.invoke<string>("identity_export_path");
  }

  /** Signs raw bytes. Hex in, hex out — the encoding the Rust side expects. */
  signBytes(bytes: Uint8Array): Promise<SignatureHex> {
    return this.invoke<SignatureHex>("identity_sign", { messageHex: toHex(bytes) });
  }

  /** Signs a payload's canonical bytes. */
  signPayload(payload: CanonicalValue): Promise<SignatureHex> {
    return this.signBytes(canonicalBytes(payload));
  }

  /**
   * Wraps a payload in a signed envelope — the protocol's `seal`, with the
   * signing step delegated to Rust so the secret key never reaches us.
   */
  async seal<P extends CanonicalValue>(
    payload: P,
    pubkey: PublicKeyHex,
    now: number = Date.now(),
  ): Promise<Envelope<P>> {
    const nonce = randomNonce();
    const signature = await this.signPayload(signingBody(payload, pubkey, nonce, now));
    return envelopeFrom(payload, pubkey, nonce, now, signature);
  }
}

/** The client the app uses. Tests construct their own with a fake invoke. */
export const identityClient = new IdentityClient();

export const loadIdentity = (): Promise<StoredIdentity | null> => identityClient.load();
export const createIdentity = (username: string): Promise<StoredIdentity> =>
  identityClient.create(username);
export const importIdentity = (path: string): Promise<StoredIdentity> =>
  identityClient.import(path);
export const identityExportPath = (): Promise<string> => identityClient.exportPath();
export const signPayload = (payload: CanonicalValue): Promise<SignatureHex> =>
  identityClient.signPayload(payload);
export const sealWithRust = <P extends CanonicalValue>(
  payload: P,
  pubkey: PublicKeyHex,
  now?: number,
): Promise<Envelope<P>> => identityClient.seal(payload, pubkey, now);
