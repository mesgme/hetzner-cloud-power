/**
 * @mesgme/hetzner-cloud-power — power actions for @swamp/hetzner-cloud/servers.
 *
 * Adds `poweron`, `poweroff` and `shutdown` methods to the official Hetzner
 * Cloud servers model type, which can create, look up and sync servers but not
 * power them on or off. The method names are the Hetzner API action names.
 *
 * Bind a model to an existing server once, with the official type's `lookup`:
 *
 *   swamp model create @swamp/hetzner-cloud/servers my-server \
 *     --global-arg name=<your-server-name> \
 *     --global-arg 'token=${{ vault.get("<vault>", "HETZNER_API_TOKEN") }}'
 *   swamp model method run my-server lookup
 *
 * Then:
 *
 *   swamp model method run my-server poweron
 *   swamp model method run my-server shutdown   # graceful (ACPI)
 *   swamp model method run my-server poweroff   # hard, like pulling the plug
 *
 * Each run refreshes the official `state` resource and writes a `power`
 * resource recording what happened. `poweron` on a running server and
 * `poweroff` / `shutdown` on a powered-off one fail without calling the
 * action endpoint. Each Hetzner request times out after 30 seconds.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the Hetzner Cloud API (v1). */
export const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

/** How long one Hetzner request may take before it is abandoned. */
export const FETCH_TIMEOUT_MS = 30_000;

/** The power actions this extension adds, named as in the Hetzner API. */
export type PowerAction = "poweron" | "poweroff" | "shutdown";

/** Server status each action is trying to reach. */
const TARGET_STATUS: Record<PowerAction, string> = {
  poweron: "running",
  poweroff: "off",
  shutdown: "off",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The fields of a Hetzner server object this extension reads. */
const ServerSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
});

type Server = z.infer<typeof ServerSchema>;

const PowerRecordSchema = z.object({
  /** Server name from the model's `name` global argument. */
  serverName: z.string(),
  /** Hetzner numeric server id, from the looked-up state. */
  serverId: z.number().int(),
  /** Which power action ran. */
  action: z.enum(["poweron", "poweroff", "shutdown"]),
  /** Power status read just before the action. */
  previousStatus: z.string(),
  /** Power status when polling stopped. */
  status: z.string(),
  /** Whether the server reached the action's target status while polling. */
  reachedTarget: z.boolean(),
  /** Hetzner action id returned by the action endpoint. */
  actionId: z.number().int().optional(),
  /** When the record was written. */
  recordedAt: z.iso.datetime(),
});

type PowerRecord = z.infer<typeof PowerRecordSchema>;

/** Poll settings; each method supplies its own defaults. */
function pollArgs(maxPollAttempts: number, pollIntervalMs: number) {
  return z.object({
    maxPollAttempts: z.number().int().min(1).max(200).default(maxPollAttempts)
      .describe(
        "How many times to read the server while waiting for the target status",
      ),
    pollIntervalMs: z.number().int().min(0).max(60_000).default(pollIntervalMs)
      .describe("Milliseconds between status reads"),
  });
}

type PollArgs = { maxPollAttempts: number; pollIntervalMs: number };

/** Global arguments of @swamp/hetzner-cloud/servers that this extension uses. */
type ServerGlobalArgs = { name?: string; token?: string };

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * The instance name the official `lookup` / `adopt` / `sync` methods write
 * `state` under: the server name with path separators and `..` neutralised.
 */
export function stateInstanceName(name: string): string {
  return name.replace(/[\/\\]/g, "_").replace(/\.\./g, "_").replace(/\0/g, "");
}

/**
 * Instance name the `power` record is written under. It must differ from the
 * `state` instance: swamp rejects a run whose handles share an instance name.
 */
export function powerInstanceName(name: string): string {
  return `${stateInstanceName(name)}-power`;
}

/**
 * Resolve the API token the same way the official type does: the `token`
 * global argument first, then the HETZNER_API_TOKEN environment variable.
 */
export function resolveToken(
  globalArgs: ServerGlobalArgs,
  getEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string {
  const token = globalArgs.token || getEnv("HETZNER_API_TOKEN");
  if (!token) {
    throw new Error(
      "No Hetzner API token. Set the model's `token` global argument to " +
        '${{ vault.get("<vault>", "HETZNER_API_TOKEN") }}, or export HETZNER_API_TOKEN.',
    );
  }
  return token;
}

/**
 * Refuse a no-op power action with a clear message, before any POST.
 */
export function assertNotAlreadyInState(
  currentStatus: string,
  action: PowerAction,
  serverName: string,
): void {
  if (action === "poweron" && currentStatus === "running") {
    throw new Error(
      `Server "${serverName}" is already running — nothing to do.`,
    );
  }
  if (action !== "poweron" && currentStatus === "off") {
    throw new Error(
      `Server "${serverName}" is already powered off — nothing to do.`,
    );
  }
}

/**
 * Turn a non-2xx Hetzner response into a clear, actionable error.
 */
export function apiError(
  operation: string,
  status: number,
  payload: unknown,
): Error {
  const err =
    (payload as { error?: { code?: string; message?: string } } | null)?.error;
  const code = err?.code;
  const message = err?.message;

  if (status === 401 || code === "unauthorized") {
    return new Error(
      `Hetzner API authentication failed (HTTP ${status}) while ${operation}. ` +
        `Store a read & write token with: swamp vault put <vault> HETZNER_API_TOKEN, ` +
        `and set the model's token global argument to ` +
        `\${{ vault.get("<vault>", "HETZNER_API_TOKEN") }}.`,
    );
  }
  if (status === 403 || code === "forbidden" || code === "token_readonly") {
    return new Error(
      `Hetzner API authorisation failed (HTTP ${status}) while ${operation}` +
        `${code ? ` [${code}]` : ""}. ` +
        `The API token may be read-only; power actions need read & write.`,
    );
  }
  return new Error(
    `Hetzner API request failed (HTTP ${status}) while ${operation}` +
      `${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}.`,
  );
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: ServerGlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** fetch with a timeout; a hung request fails with a clear message. */
async function hetznerFetch(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `Hetzner API did not respond within ${
          FETCH_TIMEOUT_MS / 1000
        }s while ${operation}.`,
      );
    }
    throw err;
  }
}

async function getServer(id: number, token: string): Promise<Server> {
  const res = await hetznerFetch(
    `${HETZNER_API_BASE}/servers/${id}`,
    { headers: { Authorization: `Bearer ${token}` } },
    "reading the server",
  );
  const raw = await readJson(res);
  if (!res.ok) throw apiError("reading the server", res.status, raw);
  return z.object({ server: ServerSchema }).parse(raw).server;
}

async function postAction(
  id: number,
  action: PowerAction,
  token: string,
): Promise<number | undefined> {
  const res = await hetznerFetch(
    `${HETZNER_API_BASE}/servers/${id}/actions/${action}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    action,
  );
  const raw = await readJson(res);
  if (!res.ok) throw apiError(action, res.status, raw);
  const parsed = z
    .object({ action: z.object({ id: z.number().int() }).partial() })
    .safeParse(raw);
  return parsed.success ? parsed.data.action.id : undefined;
}

async function runPowerAction(
  action: PowerAction,
  args: PollArgs,
  ctx: MethodContext,
): Promise<{ server: Server; record: PowerRecord }> {
  const name = ctx.globalArgs.name;
  if (!name) {
    throw new Error(`${action} requires the global argument: name`);
  }
  const instance = stateInstanceName(name);
  const existing = await ctx.readResource(instance);
  const id = existing?.id;
  if (typeof id !== "number") {
    throw new Error(
      `No state for server "${name}". Run \`lookup\` (or \`adopt\`) on this model first.`,
    );
  }
  const token = resolveToken(ctx.globalArgs);

  const before = await getServer(id, token);
  assertNotAlreadyInState(before.status, action, name);
  const actionId = await postAction(id, action, token);

  const target = TARGET_STATUS[action];
  let after = before;
  for (let attempt = 0; attempt < args.maxPollAttempts; attempt++) {
    if (attempt > 0 && args.pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
    }
    after = await getServer(id, token);
    if (after.status === target) break;
  }

  return {
    server: after,
    record: {
      serverName: name,
      serverId: id,
      action,
      previousStatus: before.status,
      status: after.status,
      reachedTarget: after.status === target,
      ...(actionId !== undefined ? { actionId } : {}),
      recordedAt: new Date().toISOString(),
    },
  };
}

function powerMethod(
  action: PowerAction,
  description: string,
  defaults: PollArgs,
) {
  return {
    description,
    arguments: pollArgs(defaults.maxPollAttempts, defaults.pollIntervalMs),
    execute: async (args: PollArgs, ctx: MethodContext) => {
      const { server, record } = await runPowerAction(action, args, ctx);
      const log = record.reachedTarget ? ctx.logger.info : ctx.logger.warn;
      log(
        record.reachedTarget
          ? "{action} on {serverName} (id {serverId}): now {status}"
          : "{action} on {serverName} (id {serverId}): still {status} after polling",
        record,
      );
      const stateHandle = await ctx.writeResource(
        "state",
        stateInstanceName(record.serverName),
        server,
      );
      const powerHandle = await ctx.writeResource(
        "power",
        powerInstanceName(record.serverName),
        record,
      );
      if (!record.reachedTarget) {
        throw new Error(
          `Server "${record.serverName}" is still ${record.status} after ` +
            `${args.maxPollAttempts} polls; ${action} did not reach ` +
            `${TARGET_STATUS[action]}.` +
            (action === "shutdown"
              ? " The OS may be ignoring ACPI; run poweroff to force it off."
              : ""),
        );
      }
      return { dataHandles: [stateHandle, powerHandle] };
    },
  };
}

// ---------------------------------------------------------------------------
// Extension export
// ---------------------------------------------------------------------------

/** Adds poweron, poweroff and shutdown to `@swamp/hetzner-cloud/servers`. */
export const extension = {
  type: "@swamp/hetzner-cloud/servers",
  resources: {
    power: {
      description:
        "Last power action on the server: what ran, the status before and after, and whether it reached its target.",
      schema: PowerRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [
    {
      poweron: powerMethod(
        "poweron",
        "Power on the server (POST poweron) and wait until it is running.",
        { maxPollAttempts: 10, pollIntervalMs: 1500 },
      ),
      poweroff: powerMethod(
        "poweroff",
        "Hard power-off (POST poweroff), like pulling the plug, and wait until it is off.",
        { maxPollAttempts: 10, pollIntervalMs: 1500 },
      ),
      shutdown: powerMethod(
        "shutdown",
        "Graceful ACPI shutdown (POST shutdown) and wait for the OS to power off. " +
          "Fails (after recording reachedTarget=false) if it is still running when polling stops; use poweroff to force it.",
        { maxPollAttempts: 40, pollIntervalMs: 3000 },
      ),
    },
  ],
};
