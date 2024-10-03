use std::{collections::HashSet, net::SocketAddr, sync::Arc, time::Duration};

use redis::AsyncCommands;

use crate::{routing::config::OutRuleConfig, tunnel::TunnelId};

use super::match_server::{InMatchServer, MatchIn, MatchOut, OutMatchServer};

pub struct RedisInMatchServer {
    redis: redis::Client,
}

impl RedisInMatchServer {
    pub fn new(redis: redis::Client) -> Self {
        Self { redis }
    }
}

#[async_trait::async_trait]
impl InMatchServer for RedisInMatchServer {
    async fn match_out(
        &self,
        in_id: uuid::Uuid,
        in_address: SocketAddr,
    ) -> anyhow::Result<MatchOut> {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();

        let config = redis::aio::ConnectionManagerConfig::new().set_push_sender(sender);

        let mut conn = self
            .redis
            .get_connection_manager_with_config(config)
            .await?;

        conn.subscribe(match_channel_name(in_id, in_address))
            .await?;

        let match_task = async {
            while let Some(push) = receiver.recv().await {
                let Some(message) = redis::Msg::from_push_info(push) else {
                    continue;
                };

                let r#match: Match = serde_json::from_slice(message.get_payload_bytes())?;

                return Ok(r#match);
            }

            anyhow::bail!("failed to match a server.");
        };

        let announce_task = {
            async move {
                loop {
                    conn.publish(
                        IN_ANNOUNCEMENT_CHANNEL_NAME,
                        serde_json::to_string(&InAnnouncement {
                            id: in_id,
                            address: in_address,
                        })?,
                    )
                    .await?;

                    tokio::time::sleep(Duration::from_secs(1)).await;
                }

                #[allow(unreachable_code)]
                anyhow::Ok(())
            }
        };

        let Match {
            id,
            tunnel_id,
            tunnel_labels,
            tunnel_priority,
            routing_rules,
            address,
        } = tokio::select! {
            r#match = match_task => r#match?,
            _ = announce_task => anyhow::bail!("failed to match a server."),
        };

        println!("matched: {:?}", address);

        Ok(MatchOut {
            id,
            tunnel_id,
            tunnel_labels,
            tunnel_priority,
            routing_rules,
            address,
        })
    }
}

pub struct RedisOutMatchServer {
    labels: Vec<String>,
    in_id_set: Arc<tokio::sync::Mutex<HashSet<uuid::Uuid>>>,
    redis_connection: redis::aio::ConnectionManager,
    in_announcement_receiver:
        Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<InAnnouncement>>>,
}

impl RedisOutMatchServer {
    pub async fn new(redis: redis::Client, labels: Vec<String>) -> anyhow::Result<Self> {
        let (redis_conn, in_announcement_receiver) = {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let config = redis::aio::ConnectionManagerConfig::new().set_push_sender(sender);

            let mut connection = redis.get_connection_manager_with_config(config).await?;

            connection.subscribe(IN_ANNOUNCEMENT_CHANNEL_NAME).await?;

            let (in_announcement_sender, in_announcement_receiver) =
                tokio::sync::mpsc::unbounded_channel();

            tokio::spawn(async move {
                loop {
                    let push = receiver
                        .recv()
                        .await
                        .expect("unexpected end of server side match server subscription.");

                    let Some(message) = redis::Msg::from_push_info(push) else {
                        continue;
                    };

                    if message.get_channel_name() != IN_ANNOUNCEMENT_CHANNEL_NAME {
                        continue;
                    }

                    if let Result::<InAnnouncement, _>::Ok(in_announcement) =
                        serde_json::from_slice(message.get_payload_bytes())
                    {
                        let _ = in_announcement_sender.send(in_announcement);
                    }
                }
            });

            (connection, in_announcement_receiver)
        };

        Ok(Self {
            labels,
            in_id_set: Arc::new(tokio::sync::Mutex::new(HashSet::new())),
            redis_connection: redis_conn,
            in_announcement_receiver: Arc::new(tokio::sync::Mutex::new(in_announcement_receiver)),
        })
    }
}

#[async_trait::async_trait]
impl OutMatchServer for RedisOutMatchServer {
    async fn match_in(
        &self,
        out_id: uuid::Uuid,
        out_address: SocketAddr,
        out_priority: i64,
        out_routing_rules: &[OutRuleConfig],
    ) -> anyhow::Result<MatchIn> {
        loop {
            let in_announcement = self
                .in_announcement_receiver
                .lock()
                .await
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("in announcement subscription ended."))?;

            if self.in_id_set.lock().await.contains(&in_announcement.id) {
                continue;
            }

            let in_match_key = match_key(in_announcement.id, in_announcement.address);

            println!("key: {:?}", in_match_key);

            let mut redis_connection = self.redis_connection.clone();

            let match_key_locking = redis_connection
                .send_packed_command(
                    redis::cmd("SET")
                        .arg(in_match_key)
                        .arg(out_address.to_string())
                        .arg("NX")
                        .arg("EX")
                        .arg(MATCH_TIMEOUT_SECONDS),
                )
                .await?;

            if !matches!(match_key_locking, redis::Value::Okay) {
                continue;
            }

            let tunnel_id = TunnelId::new();

            redis_connection
                .publish(
                    match_channel_name(in_announcement.id, in_announcement.address),
                    serde_json::to_string(&Match {
                        id: out_id,
                        tunnel_id,
                        tunnel_labels: self.labels.clone(),
                        tunnel_priority: out_priority,
                        routing_rules: out_routing_rules.to_vec(),
                        address: out_address,
                    })?,
                )
                .await?;

            println!("matched: {:?}", in_announcement.address);

            break Ok(MatchIn {
                id: in_announcement.id,
                tunnel_id,
                address: in_announcement.address,
            });
        }
    }

    async fn register_in(&self, in_id: uuid::Uuid) -> anyhow::Result<()> {
        self.in_id_set.lock().await.insert(in_id);

        Ok(())
    }

    async fn unregister_in(&self, in_id: &uuid::Uuid) -> anyhow::Result<()> {
        self.in_id_set.lock().await.remove(in_id);

        Ok(())
    }
}

const IN_ANNOUNCEMENT_CHANNEL_NAME: &str = "in_announcement";

#[derive(serde::Serialize, serde::Deserialize)]
struct InAnnouncement {
    id: uuid::Uuid,
    address: SocketAddr,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Match {
    id: uuid::Uuid,
    tunnel_id: TunnelId,
    tunnel_labels: Vec<String>,
    tunnel_priority: i64,
    routing_rules: Vec<OutRuleConfig>,
    address: SocketAddr,
}

const MATCH_TIMEOUT_SECONDS: u64 = 30;

fn match_key(id: uuid::Uuid, address: SocketAddr) -> String {
    format!("{}/{}", id, address)
}

fn match_channel_name(id: uuid::Uuid, address: SocketAddr) -> String {
    format!("match/{}", match_key(id, address))
}
