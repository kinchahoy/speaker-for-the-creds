// Real paths across the seam between bottle and speaker. Only the micro-VM is stood in for; see fixture.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "../src/config.ts";
import { egressDecision, modelDoor, secretRoute, type Live } from "../src/sandbox.ts";
import { speakerClient, watchGrants, type Snapshot } from "../src/speaker.ts";
import { control, startBottle, startSpeaker, listen, port, until } from "./fixture.ts";

const text = async (response: Response) => [response.status, await response.text()] as const;

test("a call from inside the sandbox reaches its service with the real key only after the owner approves the launch card", async (t) => {
  const f = await startBottle(t);
  const { agent, card, more, approve } = await f.launch();
  assert.equal(more.length, 0, "one card for the whole launch");
  const refused = [["/plain/a", "/svc:narrow/b", "/_speaker/secrets/RELEASED"].map((path) => f.guestCall(path).then((r) => r.status))].flat();
  assert.deepEqual(await Promise.all(refused), [403, 403, 403]);
  assert.deepEqual(f.up.seen, [], "nothing reached the upstream before approval");

  await approve();
  await until(() => agent.grants.length === card.items.length);
  assert.deepEqual(await text(await f.guestCall("/plain/a")), [200, "upstream"]);
  assert.deepEqual(await text(await f.guestCall("/svc:narrow/b")), [200, "upstream"]);
  assert.deepEqual(f.up.seen, [
    { url: "/plain/a", authorization: "Bearer plain-key" },
    { url: "/svc/narrow/b", authorization: "Bearer svc-key" },
  ]);
  assert.equal((await f.guestCall("/_speaker/catalog")).status, 200);
  assert.deepEqual(await text(await f.guestCall("/_speaker/secrets/RELEASED")), [200, "released-value"]);

  // What stays closed: the parent of the granted scope, speaker's admin, the hosted model's service and a scope of it,
  // another agent's records, and the rest of speaker's own routes.
  const other = await speakerClient(f.config, f.hostToken).createAgent("other", "m");
  const theirs = await speakerClient(f.config, f.hostToken).request({ agentId: other.id, want: ["plain.read"], reason: "x", duration: "30m" });
  for (const path of ["/svc/b", "/admin", "/llm/chat", "/llm:x/chat", `/_speaker/requests/${theirs.id}`, "/_speaker/hosts/self"])
    assert.notEqual((await f.guestCall(path)).status, 200, path);
  assert.equal(f.up.seen.length, 2);
});

test("launching creates one card with the template's items; approving puts them in force in bottle, revoking removes them", async (t) => {
  const f = await startBottle(t);
  const { agent, card, approve } = await f.launch();
  assert.deepEqual(card.items.map(({ item }) => item).sort(), [
    "ext:notes",
    "llm.full",
    "plain.read",
    "secret:RELEASED",
    "site:example.com",
    "site:notes.example.com",
    "svc:narrow.read",
  ]);
  await approve();
  const route = secretRoute(agent.live as Live, { close: async () => {} } as never);
  await until(() => agent.extRunning.includes("notes") && agent.state === "idle");
  assert.equal(await egressDecision(agent.live, route, "example.com"), "direct");
  assert.equal(await egressDecision(agent.live, route, "evil.test"), "refuse");

  const { grants } = (await f.speaker.owner("/active")) as { grants: { id: string; item: string }[] };
  for (const grant of grants.filter(({ item }) => ["site:example.com", "ext:notes"].includes(item))) await f.speaker.owner(`/grants/${grant.id}/revoke`, {});
  await until(() => agent.extRunning.length === 0 && agent.state === "idle");
  assert.equal(await egressDecision(agent.live, route, "example.com"), "refuse");
  assert.deepEqual(agent.grants.map(({ item }) => item).sort(), ["llm.full", "plain.read", "secret:RELEASED", "svc:narrow.read"]);
});

test("without word from speaker the grants are dropped and come back with it; a locked speaker is not a reason to stop", async (t) => {
  const sp = await startSpeaker(t);
  const token = await sp.host();
  const config = { speaker: { url: sp.url } } as Config;
  const client = speakerClient(config, token);
  const subject = await client.createAgent("a", "m");
  const asked = await client.request({ agentId: subject.id, want: ["site:example.com"], reason: "docs", duration: "30m" });
  await sp.decide(asked.id);
  const snapshots: Snapshot[] = [];
  let gone = "";
  const link = watchGrants(config, token, (s) => snapshots.push(s), undefined, { dropMs: 500, retryMs: 100, stopMs: 1_000, onGone: (why) => (gone = why) });
  t.after(link.stop);
  const granted = () => snapshots.at(-1)?.grants.length === 1;
  await until(granted);

  sp.cut();
  await until(() => snapshots.at(-1)?.grants.length === 0);
  await sp.heal();
  await until(granted);

  await sp.stop();
  await sp.start();
  // Locked after its restart: it says so itself, and bottle waits past the stop time without stopping.
  const why = ((await (await fetch(`${sp.url}/_speaker/hosts/self`, { headers: { authorization: `Bearer ${token}` } })).json()) as { message: string }).message;
  await until(() => link.status().includes(why));
  await sleep(1_300);
  assert.equal(gone, "");
  await sp.approveAgain();
  await until(() => link.status().startsWith("connected"));
});

test("a speaker that stays down for the stop time stops bottle", async (t) => {
  const sp = await startSpeaker(t);
  const token = await sp.host();
  let gone = "";
  const link = watchGrants({ speaker: { url: sp.url } } as Config, token, () => {}, undefined, { retryMs: 100, stopMs: 400, onGone: (why) => (gone = why) });
  t.after(link.stop);
  await until(() => link.status().startsWith("connected"));
  await sp.stop();
  await until(() => gone !== "");
});

test("a local model that cannot be reached is woken once and the call is sent again; hosted calls run under bottle's grant and count against the cap", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bottle-wake-"));
  const woke = join(dir, "woke");
  const free = await listen(createServer());
  const upstreamPort = port(free);
  free.close();
  // The model server starts once the wake command has run; the command waits for it to answer.
  const timer = setInterval(() => existsSync(woke) && !model.listening && void model.listen(upstreamPort, "127.0.0.1"), 20);
  const model = createServer((req, res) => void req.resume().on("end", () => res.end("woken")));
  t.after(() => (clearInterval(timer), model.closeAllConnections(), model.close()));
  const config = {
    hostedProviders: [],
    localModel: { guestHost: "model.internal", upstream: `127.0.0.1:${upstreamPort}`, wake: { command: `echo x >> ${woke}; sleep 0.3`, waitSeconds: 10 } },
  } as unknown as Config;
  const live: Live = { hosts: [], secretHosts: [], shares: new Map(), events: [], modelRequests: 0, modelCapNoted: false };
  const door = await listen(createServer(modelDoor(config, live, { url: "http://127.0.0.1:1", agentToken: "t" }, join(dir, "calls.jsonl"))));
  t.after(() => door.close());
  const ask = () => fetch(`http://127.0.0.1:${port(door)}/v1/chat/completions`, { method: "POST", body: "{}" }).then(text);
  assert.deepEqual(
    [await ask(), await ask()],
    [
      [200, "woken"],
      [200, "woken"],
    ],
  );
  assert.equal(readFileSync(woke, "utf8"), "x\n");

  const f = await startBottle(t);
  const { agent, approve } = await f.launch();
  await approve();
  await until(() => agent.grants.some(({ item }) => item === "llm.full"));
  const hosted = () => fetch(`${f.doors.model}/hosted/hosted/chat/completions`, { method: "POST", body: "{}" }).then((r) => r.status);
  assert.deepEqual([await hosted(), await hosted(), await hosted()], [200, 200, 429]);
  assert.deepEqual(f.up.seen, Array(2).fill({ url: "/llm/chat/completions", authorization: "Bearer llm-key" }));
  assert.equal(agent.live.modelRequests, 2);
});

test("the control API's state has what the Herdr mod reads", async (t) => {
  const f = await startBottle(t);
  control(t, f.config, f.agents);
  const state = async () => (await fetch(`http://127.0.0.1:${f.config.controlPort}/api/state`)).json() as Promise<Record<string, any>>;
  const { agent } = await f.launch();
  await until(async () => (await state()).agents[0]?.pendingRequests.length === 1);
  const open = (await state()).agents[0];
  assert.equal(open.id, agent.id);
  for (const field of ["name", "state", "model", "speakerAgentId", "outputDir"]) assert.equal(typeof open[field], "string", field);
  assert.deepEqual(Object.keys(open.pendingRequests[0]).sort(), ["id", "reason", "what"]);

  await f.agents.close(agent);
  const after = await state();
  assert.deepEqual(after.agents, []);
  assert.equal(typeof after.speaker, "string");
  assert.deepEqual([after.finished[0].id, after.finished[0].state, after.finished[0].model], [agent.id, "archived", agent.model]);
});
