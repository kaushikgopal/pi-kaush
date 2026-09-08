/**
 * Pure argument parsing for the `pi-browser capture-export` CLI command,
 * kept out of bin/pi-browser.mjs so it is unit-testable without running
 * the CLI entrypoint (which would spawn the daemon).
 */

export interface CaptureExportArgs {
  session?: string | undefined;
  /** Comma-separated domain patterns (exact or `*.example.com` style). */
  domain?: string | undefined;
  sinceSeq?: number | undefined;
  minStatus?: number | undefined;
  /** Print the bare summary JSON instead of the {ok,value} envelope. */
  json?: boolean | undefined;
}

export type CaptureExportArgsParse =
  | { ok: true; args: CaptureExportArgs }
  | { ok: false; error: string };

const INTEGER_FLAGS = {
  "--since-seq": "non-negative integer",
  "--min-status": "non-negative integer",
} as const;

const readInteger = (
  args: string[],
  index: number,
  flag: string,
): { ok: true; value: number; next: number } | { ok: false; error: string } => {
  const raw = args[index + 1];
  if (raw === undefined || raw === "")
    return { ok: false, error: `${flag} needs a value` };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    return {
      ok: false,
      error: `${flag} must be a ${INTEGER_FLAGS[flag as keyof typeof INTEGER_FLAGS]}`,
    };
  return { ok: true, value, next: index + 1 };
};

export const parseCaptureExportArgs = (
  args: string[],
): CaptureExportArgsParse => {
  const out: CaptureExportArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];
    switch (flag) {
      case "--session":
        if (next === undefined || next === "")
          return { ok: false, error: "--session needs a value" };
        out.session = next;
        i++;
        break;
      case "--domain":
        if (next === undefined || next === "")
          return { ok: false, error: "--domain needs a value" };
        out.domain = next;
        i++;
        break;
      case "--since-seq":
      case "--min-status": {
        const parsed = readInteger(args, i, flag);
        if (!parsed.ok) return parsed;
        if (flag === "--since-seq") out.sinceSeq = parsed.value;
        else out.minStatus = parsed.value;
        i = parsed.next;
        break;
      }
      case "--json":
        out.json = true;
        break;
      default:
        return { ok: false, error: `unknown flag: ${flag}` };
    }
  }
  return { ok: true, args: out };
};
