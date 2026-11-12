import type { Backend } from "../backend.ts";
import { gondolin } from "./gondolin.ts";
import { microsandbox } from "./microsandbox.ts";

/** Every supported sandbox backend, selected by the config's `backend`. */
export const backends = { gondolin, microsandbox } satisfies Record<string, Backend>;
