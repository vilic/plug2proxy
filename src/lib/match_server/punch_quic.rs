use std::net::SocketAddr;

use super::{MatchCodec, MatchInId};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PunchQuicInData {
    pub address: SocketAddr,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PunchQuicOutData {
    pub address: SocketAddr,
}

impl MatchCodec<PunchQuicInData, PunchQuicOutData> for (PunchQuicInData, PunchQuicOutData) {
    fn get_redis_match_channel_name(in_id: MatchInId, in_data: &PunchQuicInData) -> String {
        format!("punch_quic:{}/{}", in_id, in_data.address)
    }

    fn get_redis_match_lock_key(in_id: MatchInId, in_data: &PunchQuicInData) -> String {
        format!("punch_quic:match:{}/{}", in_id, in_data.address)
    }

    fn get_redis_in_announcement_channel_name() -> String {
        "punch_quic:in_announcement".to_owned()
    }
}
