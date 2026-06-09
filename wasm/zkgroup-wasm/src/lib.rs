//! zkgroup-WASM (Weg A).
//!
//! Zweck: Signals AUDITIERTE zkgroup-Crate (libsignal, gepinnt v0.95.0)
//! im Browser nutzen — wir schreiben KEINE eigene Krypto, nur dünne
//! wasm-bindgen-Exports + Tests, die die exakte Aufrufkette gegen die
//! echte Crate beweisen.
//!
//! Aufteilung:
//!  - `core_flow`: die geteilte Protokoll-Logik (deterministisch, fixe
//!    Test-Vektoren). Auf nativem Target via `cargo test`, im Browser via
//!    `roundtrip_self_test` — beide rufen denselben Code.
//!  - `wasm_api` (`#[cfg(target_arch = "wasm32")]`): die Browser-Exports.
//!    Auf nativem Target nicht kompiliert, damit `cargo test` ohne
//!    wasm-bindgen-Glue + getrandom-wasm-Backend läuft.

const GROUP_MASTER_KEY_LEN: usize = 32;

/// Geteilte, deterministische Roundtrip-Logik: ServerSecretParams →
/// Credential ausstellen → (Wire) → Client empfängt → Client präsentiert →
/// (Wire) → Server verifiziert; plus Negativprüfung (fremde Gruppe wird
/// abgelehnt). Fixe Test-Vektoren, kein RNG-Syscall. Rückgabe Ok(()) wenn
/// die komplette Mitgliedschafts-Proof-Kette korrekt durchläuft.
#[cfg(any(test, target_arch = "wasm32"))]
fn run_membership_roundtrip() -> Result<(), &'static str> {
    use libsignal_core::{Aci, Pni};
    use zkgroup::auth::{
        AuthCredentialWithPniZkcPresentation, AuthCredentialWithPniZkcResponse,
    };
    use zkgroup::groups::{GroupMasterKey, GroupSecretParams};
    use zkgroup::{ServerSecretParams, Timestamp};

    const SECONDS_PER_DAY: u64 = 86_400;

    let server_secret = ServerSecretParams::generate([1u8; 32]);
    let server_public = server_secret.get_public_params();

    let gsp = GroupSecretParams::derive_from_master_key(GroupMasterKey::new([9u8; 32]));
    let gpp = gsp.get_public_params();

    let aci = Aci::from_uuid_bytes([2u8; 16]);
    let pni = Pni::from_uuid_bytes([2u8; 16]);
    let redemption = Timestamp::from_epoch_seconds(100_000u64 * SECONDS_PER_DAY);

    // SERVER stellt Credential aus → Wire-Roundtrip
    let response = AuthCredentialWithPniZkcResponse::issue_credential(
        aci, pni, redemption, &server_secret, [3u8; 32],
    );
    let response_wire = zkgroup::serialize(&response);
    let response: AuthCredentialWithPniZkcResponse =
        zkgroup::deserialize(&response_wire).map_err(|_| "response wire roundtrip")?;

    // CLIENT empfängt + validiert
    let credential = response
        .receive(aci, pni, redemption, &server_public)
        .map_err(|_| "client receive failed")?;

    // CLIENT präsentiert → Wire-Roundtrip
    let presentation = credential.present(&server_public, &gsp, [4u8; 32]);
    let presentation_wire = zkgroup::serialize(&presentation);
    let presentation: AuthCredentialWithPniZkcPresentation =
        zkgroup::deserialize(&presentation_wire).map_err(|_| "presentation wire roundtrip")?;

    // SERVER verifiziert Mitgliedschaft OHNE Identität zu lernen
    presentation
        .verify(&server_secret, &gpp, redemption)
        .map_err(|_| "genuine member presentation rejected")?;

    // Negativ: fremde Gruppe → muss abgelehnt werden
    let other_gpp =
        GroupSecretParams::derive_from_master_key(GroupMasterKey::new([10u8; 32]))
            .get_public_params();
    if presentation.verify(&server_secret, &other_gpp, redemption).is_ok() {
        return Err("presentation verified against a different group");
    }

    // Negativ: außerhalb Einlöse-Fenster → muss abgelehnt werden
    let too_late = Timestamp::from_epoch_seconds(100_000u64 * SECONDS_PER_DAY + 3 * SECONDS_PER_DAY);
    if presentation.verify(&server_secret, &gpp, too_late).is_ok() {
        return Err("presentation verified past the redemption window");
    }

    Ok(())
}

/// Client-Hälfte des Flows aus Byte-I/O: aus einem SERVER-ausgestellten
/// Credential-Response + ServerPublicParams + GMK eine serialisierte
/// Mitgliedschafts-Presentation erzeugen (receive → present). Die
/// `randomness` kommt vom Aufrufer (JS: crypto.getRandomValues), damit
/// dieser Pfad ohne getrandom-Syscall auskommt und deterministisch testbar
/// ist. Geteilt zwischen wasm-Export und nativem Test.
#[cfg(any(test, target_arch = "wasm32"))]
fn build_presentation(
    master_key: &[u8],
    server_public_params: &[u8],
    credential_response: &[u8],
    uuid16: &[u8],
    redemption_time: u64,
    randomness: &[u8],
) -> Result<Vec<u8>, &'static str> {
    use libsignal_core::{Aci, Pni};
    use zkgroup::auth::AuthCredentialWithPniZkcResponse;
    use zkgroup::groups::{GroupMasterKey, GroupSecretParams};
    use zkgroup::{ServerPublicParams, Timestamp};

    let mk: [u8; GROUP_MASTER_KEY_LEN] = master_key
        .try_into()
        .map_err(|_| "master_key must be 32 bytes")?;
    let uuid: [u8; 16] = uuid16.try_into().map_err(|_| "uuid must be 16 bytes")?;
    let rand: [u8; 32] = randomness
        .try_into()
        .map_err(|_| "randomness must be 32 bytes")?;

    let gsp = GroupSecretParams::derive_from_master_key(GroupMasterKey::new(mk));
    let spp: ServerPublicParams =
        zkgroup::deserialize(server_public_params).map_err(|_| "bad server public params")?;
    let response: AuthCredentialWithPniZkcResponse =
        zkgroup::deserialize(credential_response).map_err(|_| "bad credential response")?;

    let aci = Aci::from_uuid_bytes(uuid);
    let pni = Pni::from_uuid_bytes(uuid);
    let ts = Timestamp::from_epoch_seconds(redemption_time);

    let credential = response
        .receive(aci, pni, ts, &spp)
        .map_err(|_| "credential receive failed")?;
    let presentation = credential.present(&spp, &gsp, rand);
    Ok(zkgroup::serialize(&presentation))
}

#[cfg(target_arch = "wasm32")]
mod wasm_api {
    use super::GROUP_MASTER_KEY_LEN;
    use wasm_bindgen::prelude::*;
    use zkgroup::groups::{GroupMasterKey, GroupSecretParams};

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
        "zkgroup-wasm 0.1.3 (libsignal v0.95.0)".to_string()
    }

    /// Erzeugt eine echte Mitgliedschafts-Presentation aus einem
    /// SERVER-ausgestellten Credential. Das ist die Client-Hälfte des
    /// realen Flows (A3-2d): das Ergebnis geht an den Server-Verify.
    #[wasm_bindgen]
    pub fn create_membership_presentation(
        master_key: &[u8],
        server_public_params: &[u8],
        credential_response: &[u8],
        uuid16: &[u8],
        redemption_time: u64,
        randomness: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        super::build_presentation(
            master_key,
            server_public_params,
            credential_response,
            uuid16,
            redemption_time,
            randomness,
        )
        .map_err(JsError::new)
    }

    /// GMK (32 Bytes, aus groupSecret.ts) → serialisierte GroupPublicParams.
    /// Das ist der Wert, den der Server später statt der Klartext-
    /// Mitgliederliste kennt.
    #[wasm_bindgen]
    pub fn derive_group_public_params(master_key: &[u8]) -> Result<Vec<u8>, JsError> {
        let secret = secret_params_from(master_key)?;
        Ok(zkgroup::serialize(&secret.get_public_params()))
    }

    /// GMK → GroupIdentifier (öffentliche, unverlinkbare Gruppen-Kennung).
    #[wasm_bindgen]
    pub fn derive_group_identifier(master_key: &[u8]) -> Result<Vec<u8>, JsError> {
        let secret = secret_params_from(master_key)?;
        Ok(secret.get_group_identifier().to_vec())
    }

    /// Leichter Determinismus-Check (GMK → Params).
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

    /// VOLLER Mitgliedschafts-Proof im Browser: Issue → Receive → Present →
    /// Verify (inkl. Negativprüfungen) gegen die echte auditierte Crate.
    /// Beweist, dass das gesamte zkgroup-Protokoll im App-Bundle läuft —
    /// nicht nur die Schlüsselableitung.
    #[wasm_bindgen]
    pub fn roundtrip_self_test() -> Result<bool, JsError> {
        super::run_membership_roundtrip().map_err(JsError::new)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    /// Native Variante des Browser-roundtrip_self_test — derselbe Code,
    /// schnell in CI.
    #[test]
    fn full_membership_flow_roundtrips() {
        super::run_membership_roundtrip().expect("full membership flow must pass");
    }

    /// Byte-Pfad von build_presentation: SERVER stellt aus → serialisiert →
    /// build_presentation (Client) → SERVER verifiziert. Beweist genau die
    /// Aufrufkette, die der wasm-Export create_membership_presentation +
    /// der Server-Verify (Node) fahren.
    #[test]
    fn presentation_from_bytes_verifies() {
        use libsignal_core::{Aci, Pni};
        use zkgroup::auth::{
            AuthCredentialWithPniZkcPresentation, AuthCredentialWithPniZkcResponse,
        };
        use zkgroup::groups::{GroupMasterKey, GroupSecretParams};
        use zkgroup::{ServerSecretParams, Timestamp};

        const SECONDS_PER_DAY: u64 = 86_400;
        let server_secret = ServerSecretParams::generate([5u8; 32]);
        let server_public_bytes = zkgroup::serialize(&server_secret.get_public_params());
        let gpp = GroupSecretParams::derive_from_master_key(GroupMasterKey::new([9u8; 32]))
            .get_public_params();
        let uuid = [2u8; 16];
        let redemption_secs = 100_000u64 * SECONDS_PER_DAY;
        let redemption = Timestamp::from_epoch_seconds(redemption_secs);

        let response = AuthCredentialWithPniZkcResponse::issue_credential(
            Aci::from_uuid_bytes(uuid),
            Pni::from_uuid_bytes(uuid),
            redemption,
            &server_secret,
            [3u8; 32],
        );
        let response_bytes = zkgroup::serialize(&response);

        let pres_bytes = super::build_presentation(
            &[9u8; 32],
            &server_public_bytes,
            &response_bytes,
            &uuid,
            redemption_secs,
            &[4u8; 32],
        )
        .expect("build_presentation");

        let presentation: AuthCredentialWithPniZkcPresentation =
            zkgroup::deserialize(&pres_bytes).expect("deserialize presentation");
        presentation
            .verify(&server_secret, &gpp, redemption)
            .expect("server verifies the bytes-built presentation");
    }

    /// GMK → GroupPublicParams ist deterministisch und kollisionsfrei.
    #[test]
    fn group_params_are_deterministic() {
        use zkgroup::groups::{GroupMasterKey, GroupSecretParams};
        let derive = |seed: u8| {
            zkgroup::serialize(
                &GroupSecretParams::derive_from_master_key(GroupMasterKey::new([seed; 32]))
                    .get_public_params(),
            )
        };
        assert_eq!(derive(7), derive(7), "derivation must be deterministic");
        assert_ne!(derive(7), derive(8), "distinct master keys must not collide");
    }
}
