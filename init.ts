// `mise run init [speaker | bottle-school] [flags]`: guided setup. Without a name it sets up both for one machine and
// gives bottle-school the URL speaker was set up with. Each package owns its flags (see speakerFlags and bottleFlags).
import { parseArgs } from "node:util";
import { bottleFlags, initBottleSchool } from "./bottle-school/init.ts";
import { initSpeaker, speakerFlags } from "./speaker/init.ts";

const HELP = {
  speaker: `speaker flags:
  --data-dir DIR        where speaker keeps its data (keys, settings)
  --port N              web port: the admin page and agents use it (3000)
  --proxy-port N        secrets proxy port: agents send HTTPS here to use secrets (3128)
  --ssh-port N          SSH jump server port: SSH and folders go through it (2222)
  --address IP          address agents and VMs use to reach this machine (default: its LAN address)
  --public-url URL      URL you open in the browser, when speaker is behind a reverse proxy
  --trusted-proxy IP    the reverse proxy's IP address
  --password-stdin      read the owner password from standard input
  --start | --no-start  start speaker in the background, or not
  --env-path FILE       where to write the settings (default: speaker/.env)`,
  "bottle-school": `bottle-school flags:
  --home DIR            where bottle-school keeps its config, state, and output
  --control-port N      control port: bottle-school's own API (7001)
  --guest-port N        guest port: VMs reach bottle-school here (7002)
  --speaker-url URL     speaker's URL as the VMs see it, for example http://192.168.1.10:3000
  --model-endpoint H:P  the model server, an OpenAI-compatible host:port
  --model ID            the model to use (needed when the server lists several)
  --image TAG           guest image tag (bottle-school-guest)
  --password-stdin      read speaker's owner password from standard input
  --config FILE         where to write config.json
  --skip-build | --skip-register | --skip-smoke   leave out that step`,
};
const USAGE = `usage: mise run init [speaker | bottle-school] [flags]

Guided setup; it needs a real terminal. For scripts pass --yes (take every default) and the flags below.
Both flags: --yes, --force (replace existing settings), --help.

${HELP.speaker}

${HELP["bottle-school"]}`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...speakerFlags, ...bottleFlags, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    const [named] = positionals;
    console.log(named === "speaker" || named === "bottle-school" ? `usage: mise run init ${named} [flags]\n\n${HELP[named]}` : USAGE);
    process.exit(0);
  }
  const [which, ...extra] = positionals;
  if (extra.length || (which !== undefined && which !== "speaker" && which !== "bottle-school"))
    throw new Error("usage: mise run init [speaker | bottle-school] [flags]");
  let speakerUrl = values["speaker-url"];
  let password: string | undefined;
  if (which !== "bottle-school") {
    const speaker = await initSpeaker(values);
    speakerUrl ??= speaker.url;
    password = speaker.password; // so the owner is not asked again to unlock speaker
  }
  if (which !== "speaker") await initBottleSchool({ ...values, "speaker-url": speakerUrl }, password);
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
