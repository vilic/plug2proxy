use std::{net::UdpSocket, sync::Arc};

use quinn::{
    crypto::rustls::QuicClientConfig, ClientConfig, Endpoint, EndpointConfig, ServerConfig,
    TokioRuntime,
};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};

pub fn create_server_endpoint(socket: UdpSocket) -> anyhow::Result<Endpoint> {
    let server_config = {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let cert_der = CertificateDer::from(cert.cert);
        let key = PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der());

        ServerConfig::with_single_cert(vec![cert_der.clone()], key.into()).unwrap()
    };

    Ok(Endpoint::new(
        EndpointConfig::default(),
        Some(server_config),
        socket,
        Arc::new(TokioRuntime),
    )?)
}

pub fn create_client_endpoint(socket: UdpSocket) -> anyhow::Result<Endpoint> {
    let client_config = {
        let crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
            .with_no_client_auth();

        let crypto = Arc::new(QuicClientConfig::try_from(crypto).unwrap());

        ClientConfig::new(crypto)
    };

    let mut endpoint = Endpoint::new(
        EndpointConfig::default(),
        None,
        socket,
        Arc::new(TokioRuntime),
    )?;

    endpoint.set_default_client_config(client_config);

    Ok(endpoint)
}

#[derive(Debug)]
struct SkipServerVerification;

impl rustls::client::danger::ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
