use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub github_id: i64,
    pub github_username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub id: Uuid,
    pub github_id: i64,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
}

impl From<User> for MeResponse {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            github_id: user.github_id,
            username: user.github_username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            email: user.email,
        }
    }
}

/// The subset of GitHub's `/user` response that OpenReview persists.
#[derive(Debug, Clone, Deserialize)]
pub struct GithubUser {
    pub id: i64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
}
