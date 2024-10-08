use std::net::SocketAddr;

use plug2proxy::{
    config::MatchServerUrlOrConfig,
    route::config::{InRuleConfig, OutRuleConfig},
    utils::OneOrMany,
};

use crate::constants::{
    fake_ip_dns_address_default, geolite2_url_default, in_routing_rules_default,
    transparent_proxy_address_default, transparent_proxy_traffic_mark_default,
    tunnel_connections_default,
};

#[derive(serde::Deserialize)]
pub struct InConfig {
    #[serde(default)]
    pub dns_resolver: InDnsResolverConfig,
    #[serde(default)]
    pub fake_ip_dns: InFakeIpDnsConfig,
    #[serde(default)]
    pub transparent_proxy: InTransparentProxyConfig,
    pub tunneling: InTunnelingConfig,
    #[serde(default)]
    pub routing: InRoutingConfig,
}

#[derive(serde::Deserialize)]
pub struct InDnsResolverConfig {
    pub server: Option<OneOrMany<String>>,
}

#[allow(clippy::derivable_impls)]
impl Default for InDnsResolverConfig {
    fn default() -> Self {
        Self { server: None }
    }
}

#[derive(serde::Deserialize)]
pub struct InFakeIpDnsConfig {
    #[serde(default = "fake_ip_dns_address_default")]
    pub listen: SocketAddr,
}

impl Default for InFakeIpDnsConfig {
    fn default() -> Self {
        Self {
            listen: fake_ip_dns_address_default(),
        }
    }
}

#[derive(serde::Deserialize)]
pub struct InTransparentProxyConfig {
    #[serde(default = "transparent_proxy_address_default")]
    pub listen: SocketAddr,
    #[serde(default = "transparent_proxy_traffic_mark_default")]
    pub traffic_mark: u32,
}

impl Default for InTransparentProxyConfig {
    fn default() -> Self {
        Self {
            listen: transparent_proxy_address_default(),
            traffic_mark: transparent_proxy_traffic_mark_default(),
        }
    }
}

#[derive(serde::Deserialize)]
pub struct InTunnelingConfig {
    pub stun_server: Option<OneOrMany<String>>,
    pub match_server: MatchServerUrlOrConfig,
    #[serde(default = "tunnel_connections_default")]
    pub connections: usize,
}

#[derive(serde::Deserialize)]
pub struct InRoutingConfig {
    #[serde(default)]
    pub geolite2: InRoutingGeoLite2Config,
    #[serde(default = "in_routing_rules_default")]
    pub rules: Vec<InRuleConfig>,
}

impl Default for InRoutingConfig {
    fn default() -> Self {
        Self {
            geolite2: Default::default(),
            rules: in_routing_rules_default(),
        }
    }
}

#[derive(serde::Deserialize)]
pub struct InRoutingGeoLite2Config {
    #[serde(default = "geolite2_url_default")]
    pub url: String,
    pub update_interval: Option<String>,
}

impl Default for InRoutingGeoLite2Config {
    fn default() -> Self {
        Self {
            url: geolite2_url_default(),
            update_interval: None,
        }
    }
}

#[derive(serde::Deserialize)]
pub struct OutConfig {
    pub tunneling: OutTunnelingConfig,
    #[serde(default)]
    pub routing: OutRoutingConfig,
}

#[derive(serde::Deserialize)]
pub struct OutTunnelingConfig {
    pub label: Option<OneOrMany<String>>,
    #[serde(default)]
    pub priority: i64,
    pub stun_server: Option<OneOrMany<String>>,
    pub match_server: MatchServerUrlOrConfig,
}

#[derive(serde::Deserialize)]
pub struct OutRoutingConfig {
    #[serde(default)]
    pub rules: Vec<OutRuleConfig>,
}

#[allow(clippy::derivable_impls)]
impl Default for OutRoutingConfig {
    fn default() -> Self {
        Self { rules: Vec::new() }
    }
}
