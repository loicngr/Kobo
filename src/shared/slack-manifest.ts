/** Slack app manifest shown in Settings -> Integrations -> Slack. Kept separate from the MCP tool definitions so the client bundle stays small. */
export const SLACK_APP_MANIFEST = `{
  "display_information": {
    "name": "Kobo",
    "description": "Relie des canaux Slack aux agents d'un workspace Kobo",
    "background_color": "#1a1a1f"
  },
  "features": {
    "bot_user": {
      "display_name": "Kobo",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "channels:read",
        "groups:read",
        "chat:write",
        "reactions:write",
        "files:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "is_hosted": false,
    "token_rotation_enabled": false
  }
}`
