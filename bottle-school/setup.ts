// Creates bottle-school/config.json and its config, state and output directories for a single-host setup.
// Usage: node setup.ts   (env: BOTTLE_HOME, SPEAKER_URL, SPEAKER_PROXY_PORT, SPEAKER_SSH_PORT, LLM_UPSTREAM host:port, LLM_MODEL id)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const target = process.env.PI_V2_CONFIG ?? join(here, "config.json");
if (existsSync(target)) throw new Error(`${target} already exists; edit it, or delete it to run setup again`);

const home = process.env.BOTTLE_HOME ?? join(homedir(), ".local", "share", "bottle-school");
const [configRoot, stateRoot, outputRoot, documents] = ["config", "state", "output", "share/documents"].map((name) =>
  join(home, name),
);
for (const directory of [configRoot, stateRoot, outputRoot, documents]) mkdirSync(directory, { recursive: true });

const config = JSON.parse(readFileSync(join(here, "config.example.json"), "utf8"));
Object.assign(config, {
  bindHost: "127.0.0.1",
  speaker: {
    url: process.env.SPEAKER_URL ?? "http://127.0.0.1:3000",
    ...(process.env.SPEAKER_PROXY_PORT ? { proxyPort: Number(process.env.SPEAKER_PROXY_PORT) } : {}),
    ...(process.env.SPEAKER_SSH_PORT ? { sshPort: Number(process.env.SPEAKER_SSH_PORT) } : {}),
  },
  configRoot,
  stateRoot,
  outputRoot,
  shareRoots: { documents },
  hostedProviders: [],
});
const upstream = process.env.LLM_UPSTREAM;
const model = process.env.LLM_MODEL;
if (upstream && model) config.localModel = { ...config.localModel, upstream, models: [{ id: model, label: model }] };
else console.warn("LLM_UPSTREAM and LLM_MODEL are not set; edit localModel in config.json before launching a task.");
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);

for (const file of ["templates.json", "catalog.json"]) copyFileSync(join(here, file), join(configRoot, file));
console.log(`wrote ${target}\nconfig, state and output are under ${home}\nnext: mise run doctor`);
