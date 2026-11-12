// `mise run init [speaker | bottle-school] [flags]`: guided setup. Without a name it sets up both for one machine and
// gives bottle-school the URL speaker was set up with. Each package owns its flags (see speakerFlags and bottleFlags).
import { parseArgs } from "node:util";
import { bottleFlags, initBottleSchool } from "./bottle-school/init.ts";
import { initSpeaker, speakerFlags } from "./speaker/init.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...speakerFlags, ...bottleFlags } });
  const [which, ...extra] = positionals;
  if (extra.length || (which !== undefined && which !== "speaker" && which !== "bottle-school"))
    throw new Error("usage: mise run init [speaker | bottle-school] [flags]");
  let speakerUrl = values["speaker-url"];
  if (which !== "bottle-school") speakerUrl ??= (await initSpeaker(values)).url;
  if (which !== "speaker") await initBottleSchool({ ...values, "speaker-url": speakerUrl });
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
