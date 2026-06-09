//! zkgroup-WASM-Spike (Weg A).
//!
//! Zweck: Signals AUDITIERTE zkgroup-Crate (libsignal, gepinnt v0.95.0)
//! im Browser nutzen — wir schreiben KEINE eigene Krypto, nur dünne
//! wasm-bindgen-Exports + einen End-to-End-Test, der die exakte
//! Aufrufkette gegen die echte Crate beweist.
//!
//! Aufteilung:
//!  - `#[cfg(target_arch = "wasm32")]`: die Browser-Exports (deterministische
//!    GMK-Ableitungen für A3). Auf nativem Target nicht kompiliert, damit
//!    `cargo test` ohne wasm-bindgen-Glue + ohne getrandom-wasm-Backend läuft.
//!  - `#[cfg(test)]`: nativer End-to-End-Test der vollen
//!    Mitgliedschafts-Credential-Flows (läuft schnell in CI).

#[cfg(target_arch = "wasm32")]
mod wasm_api {
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
        "zkgroup-wasm 0.1.0 (libsignal v0.95.0)".to_string()
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

    /// Selbsttest für den Browser: Determinismus + Nicht-Trivialität.
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
}

#[cfg(test)]
mod tests {
    use libsignal_core::{Aci, Pni};
    use zkgroup::auth::AuthCredentialWithPniZkcResponse;
    use zkgroup::groups::{GroupMasterKey, GroupSecretParams};
    use zkgroup::{ServerSecretParams, Timestamp};

    const SECONDS_PER_DAY: u64 = 86_400;

    /// Beweist die VOLLE Mitgliedschafts-Credential-Sequenz gegen die echte
    /// auditierte Crate — exakt die Aufrufkette, die später Server
    /// (libsignal-client, Issue+Verify) und Client (WASM, Receive+Present)
    /// fahren. Jeder Schritt, der über die Leitung geht, wird serialisiert
    /// und wieder deserialisiert (zkgroup::serialize/deserialize), damit auch
    /// das Wire-Format mitgetestet ist.
    #[test]
    fn full_membership_flow_roundtrips() {
        // --- SERVER: ServerSecretParams + öffentliche Params ---
        let server_secret = ServerSecretParams::generate([1u8; 32]);
        let server_public = server_secret.get_public_params();

        // --- GRUPPE: aus dem GMK (groupSecret.ts) abgeleitet ---
        let gsp = GroupSecretParams::derive_from_master_key(GroupMasterKey::new([9u8; 32]));
        let gpp = gsp.get_public_params();

        // --- Mitglied (ACI=PNI=User-UUID wie in server/src/zkgroup.ts) ---
        let aci = Aci::from_uuid_bytes([2u8; 16]);
        let pni = Pni::from_uuid_bytes([2u8; 16]);
        let redemption_secs = 100_000u64 * SECONDS_PER_DAY;
        let redemption = Timestamp::from_epoch_seconds(redemption_secs);

        // --- SERVER stellt Credential aus → Wire ---
        let response =
            AuthCredentialWithPniZkcResponse::issue_credential(
                aci, pni, redemption, &server_secret, [3u8; 32],
            );
        let response_wire = zkgroup::serialize(&response);
        let response: AuthCredentialWithPniZkcResponse =
            zkgroup::deserialize(&response_wire).expect("response wire roundtrip");

        // --- CLIENT empfängt + validiert das Credential ---
        let credential = response
            .receive(aci, pni, redemption, &server_public)
            .expect("client receives a valid credential");

        // --- CLIENT erzeugt die Presentation → Wire ---
        let presentation = credential.present(&server_public, &gsp, [4u8; 32]);
        let presentation_wire = zkgroup::serialize(&presentation);
        let presentation: zkgroup::auth::AuthCredentialWithPniZkcPresentation =
            zkgroup::deserialize(&presentation_wire).expect("presentation wire roundtrip");

        // --- SERVER verifiziert Mitgliedschaft OHNE die Identität zu lernen ---
        presentation
            .verify(&server_secret, &gpp, redemption)
            .expect("server accepts a genuine member presentation");

        // --- Negativ 1: Presentation gegen FREMDE Gruppe → abgelehnt ---
        let other_gpp =
            GroupSecretParams::derive_from_master_key(GroupMasterKey::new([10u8; 32]))
                .get_public_params();
        assert!(
            presentation.verify(&server_secret, &other_gpp, redemption).is_err(),
            "presentation must not verify against a different group"
        );

        // --- Negativ 2: außerhalb des Einlöse-Fensters → abgelehnt ---
        let too_late = Timestamp::from_epoch_seconds(redemption_secs + 3 * SECONDS_PER_DAY);
        assert!(
            presentation.verify(&server_secret, &gpp, too_late).is_err(),
            "presentation must not verify past the redemption window"
        );
    }

    /// GMK → GroupPublicParams ist deterministisch und kollisionsfrei
    /// (gleiche Garantie wie der Browser-self_test, aber nativ getestet).
    #[test]
    fn group_params_are_deterministic() {
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
