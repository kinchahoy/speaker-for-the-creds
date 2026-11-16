// `mise run init [speaker | bottle] [flags]`: guided setup. Without a name it sets up both for one machine and
// gives bottle the URL speaker was set up with. Each package owns its flags (see speakerFlags and bottleFlags).
import { parseArgs } from "node:util";
import { bottleFlags, initBottle } from "./bottle/init.ts";
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
  "bottle": `bottle keeps everything in ~/.bottle (set BOTTLE_HOME to change it). Flags:
  --control-port N      control port: bottle's own API (7001)
  --guest-port N        guest port: VMs reach bottle here (7002)
  --speaker-url URL     speaker's URL as the VMs see it, for example http://192.168.1.10:3000
  --model-endpoint H:P  the local model server, an OpenAI-compatible host:port (none: hosted models only)
  --model ID            the model to use (needed when the server lists several)
  --image TAG           guest image tag (bottle-guest)
  --password-stdin      read speaker's owner password from standard input
  --skip-link | --skip-build | --skip-register | --skip-smoke   leave out that step (link: bottle into ~/.local/bin)`,
};
const USAGE = `usage: mise run init [speaker | bottle] [flags]

Guided setup; it needs a real terminal. For scripts pass --yes (take every default) and the flags below.
Both flags: --yes, --force (replace existing settings), --help.

${HELP.speaker}

${HELP["bottle"]}`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...speakerFlags, ...bottleFlags, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    const [named] = positionals;
    console.log(named === "speaker" || named === "bottle" ? `usage: mise run init ${named} [flags]\n\n${HELP[named]}` : USAGE);
    process.exit(0);
  }
  const [which, ...extra] = positionals;
  if (extra.length || (which !== undefined && which !== "speaker" && which !== "bottle"))
    throw new Error("usage: mise run init [speaker | bottle] [flags]");
  let speakerUrl = values["speaker-url"];
  let password: string | undefined;
  if (which !== "bottle") {
    const speaker = await initSpeaker(values);
    speakerUrl ??= speaker.url;
    password = speaker.password; // so the owner is not asked again to unlock speaker
  }
  if (which !== "speaker") await initBottle({ ...values, "speaker-url": speakerUrl }, password);
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
