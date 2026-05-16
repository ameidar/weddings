# Wedding guest management site for Cloudflare Pages

Publish directory: `package/cloudflare-site`
Entry file: `index.html`
Suggested custom domain: `wedding.orma-ai.com` or `guests.orma-ai.com`

Important: the frontend still keeps the detailed event workspace data in the browser localStorage, but admin/client authentication and the event registry now use the Cloudflare Worker API when configured.

Required Cloudflare settings for production auth:
- Secret `ADMIN_USERNAME` = `admin`
- Secret `ADMIN_PASSWORD_HASH` = SHA-256 hex of the admin password
- Secret `SESSION_SECRET` = long random string
- KV binding `EVENTS_KV` for the admin event registry

If `EVENTS_KV` is missing, the UI falls back to local browser storage for the event registry, which is useful for testing but not multi-device production use.
