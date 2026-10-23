use aes_gcm::{
    Aes256Gcm, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

use crate::config::Secret;

const ENVELOPE_PREFIX: &str = "v1.";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const GITHUB_TOKEN_AAD: &[u8] = b"openreview:github-token:v1";
const OAUTH_STATE_AAD: &[u8] = b"openreview:oauth-state:v1";
const KEY_CONTEXT: &[u8] = b"openreview:auth-encryption:v1\0";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("failed to gather random bytes")]
    Random,

    #[error("failed to encrypt value")]
    Encrypt,

    #[error("failed to decrypt value")]
    Decrypt,

    #[error("invalid encrypted envelope")]
    InvalidEnvelope,

    #[error("invalid encrypted payload encoding")]
    Encoding,
}

/// AES-256-GCM wrapper used for OAuth state and GitHub credentials.
pub struct Crypto {
    cipher: Aes256Gcm,
}

impl Crypto {
    pub fn new(secret: &Secret) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(KEY_CONTEXT);
        hasher.update(secret.expose().as_bytes());
        let digest = hasher.finalize();

        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(digest.as_slice());

        Self {
            cipher: Aes256Gcm::new(&Key::<Aes256Gcm>::from(key_bytes)),
        }
    }

    pub fn encrypt_github_token(&self, value: &str) -> Result<String, CryptoError> {
        self.encrypt(value, GITHUB_TOKEN_AAD)
    }

    pub fn decrypt_github_token(&self, value: &str) -> Result<String, CryptoError> {
        self.decrypt(value, GITHUB_TOKEN_AAD)
    }

    pub fn encrypt_oauth_state(&self, value: &str) -> Result<String, CryptoError> {
        self.encrypt(value, OAUTH_STATE_AAD)
    }

    pub fn decrypt_oauth_state(&self, value: &str) -> Result<String, CryptoError> {
        self.decrypt(value, OAUTH_STATE_AAD)
    }

    fn encrypt(&self, plaintext: &str, aad: &[u8]) -> Result<String, CryptoError> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce_bytes).map_err(|_| CryptoError::Random)?;
        let nonce = Nonce::from(nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad,
                },
            )
            .map_err(|_| CryptoError::Encrypt)?;

        let mut envelope = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        envelope.extend_from_slice(&nonce_bytes);
        envelope.extend_from_slice(&ciphertext);

        Ok(format!(
            "{ENVELOPE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(envelope)
        ))
    }

    fn decrypt(&self, value: &str, aad: &[u8]) -> Result<String, CryptoError> {
        let encoded = value
            .strip_prefix(ENVELOPE_PREFIX)
            .ok_or(CryptoError::InvalidEnvelope)?;
        let envelope = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| CryptoError::Encoding)?;

        if envelope.len() < NONCE_LEN + TAG_LEN {
            return Err(CryptoError::InvalidEnvelope);
        }

        let (nonce_bytes, ciphertext) = envelope.split_at(NONCE_LEN);
        let nonce_array: [u8; NONCE_LEN] = nonce_bytes
            .try_into()
            .map_err(|_| CryptoError::InvalidEnvelope)?;
        let nonce = Nonce::from(nonce_array);

        let plaintext = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)?;

        String::from_utf8(plaintext).map_err(|_| CryptoError::Encoding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypto() -> Crypto {
        Crypto::new(&Secret::new(
            "test-session-secret-that-is-long-enough-for-validation",
        ))
    }

    #[test]
    fn github_token_roundtrip() {
        let crypto = crypto();
        let encrypted = crypto.encrypt_github_token("gho_secret_token").unwrap();

        assert_ne!(encrypted, "gho_secret_token");
        assert!(!encrypted.contains("gho_secret_token"));
        assert_eq!(
            crypto.decrypt_github_token(&encrypted).unwrap(),
            "gho_secret_token"
        );
    }

    #[test]
    fn oauth_state_roundtrip() {
        let crypto = crypto();
        let encrypted = crypto.encrypt_oauth_state(r#"{"state":"abc"}"#).unwrap();

        assert_eq!(
            crypto.decrypt_oauth_state(&encrypted).unwrap(),
            r#"{"state":"abc"}"#
        );
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let crypto = crypto();
        let mut encrypted = crypto.encrypt_github_token("gho_secret_token").unwrap();
        let last = encrypted.pop().unwrap();
        encrypted.push(if last == 'A' { 'B' } else { 'A' });

        assert!(crypto.decrypt_github_token(&encrypted).is_err());
    }

    #[test]
    fn domain_separation_is_enforced() {
        let crypto = crypto();
        let encrypted = crypto.encrypt_github_token("gho_secret_token").unwrap();

        assert!(crypto.decrypt_oauth_state(&encrypted).is_err());
    }
}
