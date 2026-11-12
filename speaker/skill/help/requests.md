# Requests without Speaker-Wait

Use this when you cannot hold a call open, or need access before making the call.

1. `POST /_speaker/requests` with `{"capability":{"kind":"<kind>","ref":"<ref>"},"reason":"<one sentence>","duration":"15m"}`. Use the shortest duration that fits: `15m`, `30m`, `1h`, `1d`, `7d`, `30d`, `90d`. A pending request for the same access is updated, not duplicated.
2. Tell the user what the reply's `tell_user` says.
3. `GET /_speaker/requests/<id>?wait=60` returns once the owner decides; when `approved` it carries `expiresAt` (UTC, `null` = no expiry). Repeat while `pending`; stop on `denied` or `expired`.
4. `GET /_speaker/requests` lists your requests and their status.
