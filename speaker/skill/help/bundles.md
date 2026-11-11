# Bundles

A bundle is a named set of capabilities the owner approves in one decision. `GET /_speaker/bundles` lists those you may request, each with a one-line description and its members; a bundle with any member you cannot request is not listed.

When a task needs several members, request the bundle once instead of each member:
`POST /_speaker/requests` with `{"bundle":"<name>","reason":"<one sentence>","duration":"1h"}`.
