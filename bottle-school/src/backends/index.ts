import type { Backend } from "../backend.ts";
import { gondolin } from "./gondolin.ts";

/** Every supported sandbox backend, selected by the config's `backend`. */
export const backends = { gondolin } satisfies Record<string, Backend>;
