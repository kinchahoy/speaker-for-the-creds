import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startGuestListener } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import type { Tasks } from "../src/tasks.ts";

test("Hono's own errors answer speaker's shape: a bad bearer token is 401 denied, malformed JSON is 400 invalid", async (t) => {
  const tasks = { byGuestToken: new Map([["good", { state: "ready", live: {} }]]) } as unknown as Tasks;
  const server = startGuestListener({ guestPort: 0 } as Config, tasks);
  t.after(() => server.close());
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/guest/status`;
  const post = async (token: string, body: string) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
    return { status: response.status, body: (await response.json()) as { error: string; message: string } };
  };

  const unauthorized = await post("wrong", "{}");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, "denied");
  assert.equal(typeof unauthorized.body.message, "string");

  const malformed = await post("good", "{nope");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, "invalid");
  assert.match(malformed.body.message, /Malformed JSON/);
});
