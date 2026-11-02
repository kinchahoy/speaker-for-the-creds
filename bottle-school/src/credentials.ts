import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const PREFIX = "BROKER_SECRET_";

/** One host-held credential . */
export type Credential = { name: string; value: string; placeholder: string };

/** `BROKER_SECRET_OPENROUTER=sk-...` in secrets.env or the process environment becomes the logical name `OPENROUTER`. */
export const loadSecrets = (secretsFile: string): Map<string, string> => {
  const fileValues = existsSync(secretsFile) ? parseEnv(readFileSync(secretsFile, "utf8")) : {};
  const secrets = new Map<string, string>();
  for (const [environmentName, value] of Object.entries({ ...fileValues, ...process.env })) {
    if (!environmentName.startsWith(PREFIX) || value === undefined) continue;
    const name = environmentName.slice(PREFIX.length).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name))
      throw new Error(`${environmentName} has an invalid logical secret name`);
    if (!value) throw new Error(`${environmentName} is empty`);
    secrets.set(name, value);
  }
  return secrets;
};

/** Every known secret gets a fresh meaningless placeholder per task; leases decide where it becomes real. */
export const mintCredentials = (secrets: Map<string, string>): Map<string, Credential> =>
  new Map(
    [...secrets].map(([name, value]) => [
      name,
      { name, value, placeholder: `pv_${randomBytes(18).toString("hex")}` },
    ]),
  );

export const secretNames = (secrets: Map<string, string>) => [...secrets.keys()].sort();
