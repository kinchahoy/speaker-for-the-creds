## In a sandbox

`BOTTLE_SCHOOL=1` means you run in a bottle-school sandbox. You are already enrolled: `SPEAKER_URL` and `SPEAKER_TOKEN` are set. Send `Authorization: Bearer $SPEAKER_TOKEN` and do not enroll.

- Use the `request_capability` tool to ask for items; it waits for the owner and returns the decision. You may ask for every item kind above, not only services.
- A granted `site:`, `secret:`, `folder:`, `mcp:` or `ext:` item is applied by the sandbox; retry what was blocked once it is granted. An item the sandbox has not applied yet is reported as `applying`.
- `mcp:` is for MCP servers that run inside the sandbox; remote MCP servers are services: ask for `<service>.read` and call `$SPEAKER_URL/<service>`.
- For a `secret:`, set only the variable `/me` shows (a placeholder) on the command that needs it. Your sandbox already sends requests to the secret's hosts through speaker, so there are no proxy settings or certificate to add.
- `GET /_speaker/me` lists the groups you may ask for.
