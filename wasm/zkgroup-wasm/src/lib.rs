//! zkgroup-WASM-Spike (Weg A, Phase A2).
//!
//! Zweck: beweisen, dass Signals AUDITIERTE zkgroup-Crate (libsignal,
//! gepinnt auf v0.95.0) nach wasm32-unknown-unknown baut und im Browser
//! läuft — und die Bundle-Größe messen. Wir schreiben hier KEINE eigene
//! Krypto: nur dünne wasm-bindgen-Exports um deterministische zkgroup-
//! Operationen.
//!
//! Bewusst NUR deterministische Ableitungen im Spike (kein RNG-Pfad,
//! keine Credential-/Proof-Erstellung) — die kommen in A3, wenn der
//! Build steht und gegen die Server-Seite (server/src/zkgroup.ts)
//! getestet werden kann.

use wasm_bindgen::prelude::*;
use zkgroup::groups::{GroupMasterKey, GroupSecretParams};

const GROUP_MASTER_KEY_LEN: usize = 32;

fn secret_params_from(master_key: &[u8]) -> Result<GroupSecretParams, JsError> {
    let bytes: [u8; GROUP_MASTER_KEY_LEN] = master_key
        .try_into()
        .map_err(|_| JsError::new("master_key must be exactly 32 bytes"))?;
    Ok(GroupSecretParams::derive_from_master_key(
        GroupMasterKey::new(bytes),
    ))
}

/// Build-Identität für den Status-/Debug-Pfad im Client.
#[wasm_bindgen]
pub fn version() -> String {
    "zkgroup-wasm spike 0.1.0 (libsignal v0.95.0)".to_string()
}

/// GMK (32 Bytes, aus groupSecret.ts) → serialisierte GroupPublicParams.
/// Das ist der Wert, den der Server später statt der Klartext-
/// Mitgliederliste kennt.
#[wasm_bindgen]
pub fn derive_group_public_params(master_key: &[u8]) -> Result<Vec<u8>, JsError> {
    let secret = secret_params_from(master_key)?;
    Ok(zkgroup::serialize(&secret.get_public_params()))
}

/// GMK → GroupIdentifier (öffentliche, unverlinkbare Gruppen-Kennung
/// aus den Params — ersetzt perspektivisch die server-vergebene groupId
/// als Routing-Schlüssel).
#[wasm_bindgen]
pub fn derive_group_identifier(master_key: &[u8]) -> Result<Vec<u8>, JsError> {
    let secret = secret_params_from(master_key)?;
    Ok(secret.get_group_identifier().to_vec())
}

/// Selbsttest für den Browser: Determinismus + Nicht-Trivialität.
/// Läuft beim Client-Boot des Experiments einmal durch.
#[wasm_bindgen]
pub fn self_test() -> Result<bool, JsError> {
    let mk_a = [7u8; GROUP_MASTER_KEY_LEN];
    let mk_b = [8u8; GROUP_MASTER_KEY_LEN];
    let a1 = derive_group_public_params(&mk_a)?;
    let a2 = derive_group_public_params(&mk_a)?;
    let b1 = derive_group_public_params(&mk_b)?;
    if a1.is_empty() || a1 != a2 {
        return Err(JsError::new("derive is not deterministic"));
    }
    if a1 == b1 {
        return Err(JsError::new("different master keys collided"));
    }
    Ok(true)
}
