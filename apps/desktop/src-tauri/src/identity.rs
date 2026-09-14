// Identity — ed25519 key storage and signing, kept out of the webview.
//
// The secret key is the whole of a user's account: it is their id, and there
// is no server-side password to fall back on if it leaks. So it lives here and
// never crosses into JavaScript. The webview may ask for the public key, and
// it may ask for a signature over bytes it supplies, but it can never read the
// key that produced them.

use std::fs;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey, SECRET_KEY_LENGTH};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The on-disk format. Versioned so a later key format can be recognised
/// rather than misread as this one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityFile {
    pub version: u32,
    pub username: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "secretKey")]
    pub secret_key: String,
}

const FILE_VERSION: u32 = 1;
const FILE_NAME: &str = "identity.json";

// ---------------------------------------------------------------------------
// Pure helpers — no filesystem, no app handle. Unit-testable below.
// ---------------------------------------------------------------------------

/// Builds a fresh identity from 32 random bytes.
fn new_identity(username: String) -> IdentityFile {
    let mut seed = [0u8; SECRET_KEY_LENGTH];
    OsRng.fill_bytes(&mut seed);
    let signing = SigningKey::from_bytes(&seed);
    IdentityFile {
        version: FILE_VERSION,
        username,
        public_key: hex::encode(signing.verifying_key().to_bytes()),
        secret_key: hex::encode(seed),
    }
}

/// Rebuilds the signing key from a stored secret, and checks the stored public
/// key really is the one it derives. A mismatch means a hand-edited or corrupt
/// file, which would otherwise produce signatures nobody can verify.
fn signing_key_of(identity: &IdentityFile) -> Result<SigningKey, String> {
    let bytes = hex::decode(&identity.secret_key).map_err(|_| "secret key is not hex".to_string())?;
    let seed: [u8; SECRET_KEY_LENGTH] = bytes
        .try_into()
        .map_err(|_| "secret key is not 32 bytes".to_string())?;

    let signing = SigningKey::from_bytes(&seed);
    let derived = hex::encode(signing.verifying_key().to_bytes());
    if derived != identity.public_key.to_lowercase() {
        return Err("public key does not match secret key".to_string());
    }
    Ok(signing)
}

/// Rejects anything that is not a version-1 file with a usable keypair.
fn validate(identity: &IdentityFile) -> Result<(), String> {
    if identity.version != FILE_VERSION {
        return Err(format!("unsupported identity version {}", identity.version));
    }
    signing_key_of(identity).map(|_| ())
}

/// Decodes the message the webview asked us to sign. Hex is the one encoding
/// used across this boundary — the same form the protocol uses for keys and
/// signatures — so there is never a question of which one a caller meant.
fn decode_message(message_hex: &str) -> Result<Vec<u8>, String> {
    hex::decode(message_hex).map_err(|_| "message is not hex".to_string())
}

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

fn read_identity(path: &Path) -> Result<Option<IdentityFile>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let identity: IdentityFile =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
    validate(&identity)?;
    Ok(Some(identity))
}

fn write_identity(path: &Path, identity: &IdentityFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(identity).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))?;
    restrict_permissions(path)
}

/// Owner-only on Unix. Windows has no mode bits; the file sits in the
/// per-user AppData config dir, which is already not readable by other
/// standard users, so the default ACL is left as it is.
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Loads the identity the commands operate on, or fails if onboarding has not
/// happened yet.
fn require_identity(app: &AppHandle) -> Result<IdentityFile, String> {
    read_identity(&identity_path(app)?)?.ok_or_else(|| "no identity on this machine".to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The stored public key, or `None` when this machine has no identity yet.
/// The caller uses `None` to decide that onboarding must run.
#[tauri::command]
pub fn identity_load(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_identity(&identity_path(&app)?)?.map(|identity| identity.public_key))
}

/// Generates a keypair, stores it, and hands back the public key — the user id.
#[tauri::command]
pub fn identity_create(app: AppHandle, username: String) -> Result<String, String> {
    let identity = new_identity(username);
    write_identity(&identity_path(&app)?, &identity)?;
    Ok(identity.public_key)
}

/// Signs `message_hex` (hex-encoded bytes) with the stored secret key and
/// returns the signature as hex.
#[tauri::command]
pub fn identity_sign(app: AppHandle, message_hex: String) -> Result<String, String> {
    let identity = require_identity(&app)?;
    let signing = signing_key_of(&identity)?;
    let message = decode_message(&message_hex)?;
    Ok(hex::encode(signing.sign(&message).to_bytes()))
}

/// Installs an identity file copied from elsewhere — a backup, or another
/// machine. Validated before it replaces the current one, so a bad file leaves
/// the existing identity intact.
#[tauri::command]
pub fn identity_import(app: AppHandle, path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let text = fs::read_to_string(&source).map_err(|e| format!("read {path}: {e}"))?;
    let identity: IdentityFile =
        serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))?;
    validate(&identity)?;
    write_identity(&identity_path(&app)?, &identity)?;
    Ok(identity.public_key)
}

/// Where the identity file lives, so the UI can tell the user what to back up.
#[tauri::command]
pub fn identity_export_path(app: AppHandle) -> Result<String, String> {
    Ok(identity_path(&app)?.display().to_string())
}

/// The username stored alongside the key. Read separately from the key so the
/// load path stays a single question: is there an identity or not?
#[tauri::command]
pub fn identity_username(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_identity(&identity_path(&app)?)?.map(|identity| identity.username))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_public_key_derives_from_its_secret() {
        let identity = new_identity("alice".to_string());
        assert_eq!(identity.version, FILE_VERSION);
        assert_eq!(identity.public_key.len(), 64);
        assert_eq!(identity.secret_key.len(), 64);
        assert!(validate(&identity).is_ok());
    }

    #[test]
    fn two_identities_differ() {
        let a = new_identity("a".to_string());
        let b = new_identity("b".to_string());
        assert_ne!(a.secret_key, b.secret_key);
    }

    #[test]
    fn mismatched_public_key_is_rejected() {
        let mut identity = new_identity("alice".to_string());
        identity.public_key = "0".repeat(64);
        assert!(validate(&identity).is_err());
    }

    #[test]
    fn unknown_version_is_rejected() {
        let mut identity = new_identity("alice".to_string());
        identity.version = 2;
        assert!(validate(&identity).is_err());
    }

    #[test]
    fn signature_verifies_against_the_public_key() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};

        let identity = new_identity("alice".to_string());
        let signing = signing_key_of(&identity).unwrap();
        let message = b"canonical bytes";
        let signature = hex::encode(signing.sign(message).to_bytes());

        let key_bytes: [u8; 32] = hex::decode(&identity.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let verifying = VerifyingKey::from_bytes(&key_bytes).unwrap();
        let sig_bytes: [u8; 64] = hex::decode(&signature).unwrap().try_into().unwrap();

        assert!(verifying
            .verify(message, &Signature::from_bytes(&sig_bytes))
            .is_ok());
    }

    #[test]
    fn non_hex_message_is_rejected() {
        assert!(decode_message("zz").is_err());
        assert_eq!(decode_message("616263").unwrap(), b"abc");
    }

    #[test]
    fn round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("spotjam-id-{}", std::process::id()));
        let path = dir.join("identity.json");
        let identity = new_identity("alice".to_string());

        write_identity(&path, &identity).unwrap();
        let loaded = read_identity(&path).unwrap().unwrap();
        assert_eq!(loaded.public_key, identity.public_key);
        assert_eq!(loaded.username, "alice");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_reads_as_none() {
        let path = std::env::temp_dir().join("spotjam-absent-identity.json");
        fs::remove_file(&path).ok();
        assert!(read_identity(&path).unwrap().is_none());
    }
}
