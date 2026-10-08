/**
 * Tests for the @mesgme/hetzner-cloud-power extension of
 * @swamp/hetzner-cloud/servers.
 *
 * Covers the pure helpers and the poweron / poweroff / shutdown execute paths
 * with the Hetzner Cloud API mocked via withMockedFetch. No real network calls.
 *
 * Run with: $(swamp doctor extensions --json | jq -r '.denoPath') test --allow-env extensions/models/hetzner_cloud_power_test.ts
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20261001.42";
import {
  apiError,
  assertNotAlreadyInState,
  extension,
  FETCH_TIMEOUT_MS,
  HETZNER_API_BASE,
  resolveToken,
  stateInstanceName,
} from "./hetzner_cloud_power.ts";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

type Write = { specName: string; name: string; data: Record<string, unknown> };

/** A minimal Hetzner server object as returned by GET /servers/{id}. */
function server(id: number, name: string, status: string) {
  return {
    id,
    name,
    status,
    public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8::/64" } },
  };
}

/** Fake method context: `state` holds what `lookup` would have written. */
function makeContext(
  globalArgs: Record<string, unknown>,
  state: Record<string, Record<string, unknown>> = {},
  writes: Write[] = [],
) {
  return {
    globalArgs,
    logger: { info: () => {}, warn: () => {} },
    readResource(name: string) {
      return Promise.resolve(state[name] ?? null);
    },
    writeResource(
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) {
      writes.push({ specName, name, data });
      return Promise.resolve({ name });
    },
  };
}

/** The extension's methods, flattened from the `methods: [{...}]` shape. */
// deno-lint-ignore no-explicit-any
const methods = Object.assign({}, ...extension.methods) as Record<string, any>;

const FAST = { maxPollAttempts: 1, pollIntervalMs: 0 };

/** A mock API: GET /servers/42 answers with `statuses` in turn (last repeats). */
function api(action: string, statuses: string[]) {
  let reads = 0;
  return (req: Request) => {
    const url = new URL(req.url);
    if (
      req.method === "POST" &&
      url.pathname === `/v1/servers/42/actions/${action}`
    ) {
      return Response.json(
        { action: { id: 7, status: "running", command: action } },
        { status: 201 },
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/servers/42") {
      const status = statuses[Math.min(reads++, statuses.length - 1)];
      return Response.json({ server: server(42, "web-1", status) });
    }
    return new Response("unexpected", { status: 500 });
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("HETZNER_API_BASE is the v1 Hetzner Cloud API", () => {
  assertEquals(HETZNER_API_BASE, "https://api.hetzner.cloud/v1");
});

Deno.test("stateInstanceName matches the name lookup writes state under", () => {
  assertEquals(stateInstanceName("web-1"), "web-1");
  assertEquals(stateInstanceName("a/b\\c"), "a_b_c");
  assertEquals(stateInstanceName("x..y"), "x_y");
});

Deno.test("resolveToken prefers the token global argument", () => {
  assertEquals(resolveToken({ token: "arg" }, () => "env"), "arg");
});

Deno.test("resolveToken falls back to HETZNER_API_TOKEN", () => {
  assertEquals(
    resolveToken({}, (k) => k === "HETZNER_API_TOKEN" ? "env" : undefined),
    "env",
  );
});

Deno.test("resolveToken throws a clear error when there is no token", () => {
  assertThrows(
    () => resolveToken({}, () => undefined),
    Error,
    "HETZNER_API_TOKEN",
  );
});

Deno.test("assertNotAlreadyInState: poweron on a running server throws", () => {
  assertThrows(
    () => assertNotAlreadyInState("running", "poweron", "web-1"),
    Error,
    "already running",
  );
});

Deno.test("assertNotAlreadyInState: poweroff and shutdown on an off server throw", () => {
  for (const action of ["poweroff", "shutdown"] as const) {
    assertThrows(
      () => assertNotAlreadyInState("off", action, "web-1"),
      Error,
      "already powered off",
    );
  }
});

Deno.test("assertNotAlreadyInState: valid transitions are allowed", () => {
  assertNotAlreadyInState("off", "poweron", "web-1");
  assertNotAlreadyInState("running", "poweroff", "web-1");
  assertNotAlreadyInState("running", "shutdown", "web-1");
});

Deno.test("apiError: 401 explains how to wire a vault token", () => {
  const err = apiError("reading the server", 401, {
    error: { code: "unauthorized" },
  });
  assertStringIncludes(err.message, "authentication failed");
  assertStringIncludes(
    err.message,
    'vault.get("<vault>", "HETZNER_API_TOKEN")',
  );
});

Deno.test("apiError: a read-only token says read & write is needed", () => {
  const err = apiError("poweron", 403, { error: { code: "token_readonly" } });
  assertStringIncludes(err.message, "read & write");
});

// ---------------------------------------------------------------------------
// Extension shape
// ---------------------------------------------------------------------------

Deno.test("extension targets @swamp/hetzner-cloud/servers", () => {
  assertEquals(extension.type, "@swamp/hetzner-cloud/servers");
});

Deno.test("extension adds poweron, poweroff and shutdown", () => {
  assertEquals(Object.keys(methods).sort(), [
    "poweroff",
    "poweron",
    "shutdown",
  ]);
});

Deno.test("extension declares a power resource", () => {
  assertEquals("power" in extension.resources, true);
});

// ---------------------------------------------------------------------------
// execute — happy paths
// ---------------------------------------------------------------------------

Deno.test("poweron: powers on the server from looked-up state and refreshes state", async () => {
  const writes: Write[] = [];
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "off") },
    writes,
  );

  const { calls } = await withMockedFetch(
    api("poweron", ["off", "running"]),
    () => methods.poweron.execute(FAST, ctx),
  );

  const posts = calls.filter((c) => c.method === "POST");
  assertEquals(posts.length, 1);
  assertStringIncludes(posts[0].url, "/servers/42/actions/poweron");
  assertEquals(calls[0].headers["authorization"], "Bearer tok");

  const state = writes.find((w) => w.specName === "state")!;
  assertEquals(state.name, "web-1");
  assertEquals(state.data.status, "running");

  const power = writes.find((w) => w.specName === "power")!;
  assertEquals(power.data.serverName, "web-1");
  assertEquals(power.data.serverId, 42);
  assertEquals(power.data.action, "poweron");
  assertEquals(power.data.previousStatus, "off");
  assertEquals(power.data.status, "running");
  assertEquals(power.data.reachedTarget, true);
  assertEquals(power.data.actionId, 7);
});

Deno.test("poweron: writes state and power under distinct instance names", async () => {
  const writes: Write[] = [];
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "off") },
    writes,
  );

  await withMockedFetch(
    api("poweron", ["off", "running"]),
    () => methods.poweron.execute(FAST, ctx),
  );

  // swamp rejects a run whose data handles share an instance name.
  const names = writes.map((w) => w.name);
  assertEquals(new Set(names).size, names.length);
  assertEquals(writes.find((w) => w.specName === "state")!.name, "web-1");
});

Deno.test("poweroff: hard powers off the server", async () => {
  const writes: Write[] = [];
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "running") },
    writes,
  );

  const { calls } = await withMockedFetch(
    api("poweroff", ["running", "off"]),
    () => methods.poweroff.execute(FAST, ctx),
  );

  assertStringIncludes(
    calls.filter((c) => c.method === "POST")[0].url,
    "/servers/42/actions/poweroff",
  );
  const power = writes.find((w) => w.specName === "power")!;
  assertEquals(power.data.action, "poweroff");
  assertEquals(power.data.status, "off");
});

Deno.test("shutdown: sends an ACPI shutdown and polls until the server is off", async () => {
  const writes: Write[] = [];
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "running") },
    writes,
  );

  const { calls } = await withMockedFetch(
    api("shutdown", ["running", "stopping", "stopping", "off"]),
    () =>
      methods.shutdown.execute({ maxPollAttempts: 5, pollIntervalMs: 0 }, ctx),
  );

  assertStringIncludes(
    calls.filter((c) => c.method === "POST")[0].url,
    "/servers/42/actions/shutdown",
  );
  const power = writes.find((w) => w.specName === "power")!;
  assertEquals(power.data.status, "off");
  assertEquals(power.data.reachedTarget, true);
});

Deno.test("shutdown: fails, after recording state and power, when the OS has not powered off", async () => {
  const writes: Write[] = [];
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "running") },
    writes,
  );

  const err = await withMockedFetch(
    api("shutdown", ["running"]),
    () =>
      assertRejects(() =>
        methods.shutdown.execute({ maxPollAttempts: 2, pollIntervalMs: 0 }, ctx)
      ),
  );

  const message = (err.result as Error).message;
  assertStringIncludes(message, '"web-1"');
  assertStringIncludes(message, "still running");
  assertStringIncludes(message, "poweroff");
  const power = writes.find((w) => w.specName === "power")!;
  assertEquals(power.data.status, "running");
  assertEquals(power.data.reachedTarget, false);
  assertEquals(writes.some((w) => w.specName === "state"), true);
});

for (
  const [action, from, stuck] of [
    ["poweroff", "running", "running"],
    ["poweron", "off", "off"],
  ] as const
) {
  Deno.test(`${action}: fails when the server never reaches its target`, async () => {
    const writes: Write[] = [];
    const ctx = makeContext(
      { name: "web-1", token: "tok" },
      { "web-1": server(42, "web-1", from) },
      writes,
    );

    const err = await withMockedFetch(
      api(action, [from, stuck]),
      () => assertRejects(() => methods[action].execute(FAST, ctx)),
    );

    assertStringIncludes((err.result as Error).message, `still ${stuck}`);
    const power = writes.find((w) => w.specName === "power")!;
    assertEquals(power.data.reachedTarget, false);
  });
}

Deno.test("shutdown waits longer by default than poweroff", () => {
  const shutdownDefaults = methods.shutdown.arguments.parse({});
  const poweroffDefaults = methods.poweroff.arguments.parse({});
  assertEquals(
    shutdownDefaults.maxPollAttempts * shutdownDefaults.pollIntervalMs >
      poweroffDefaults.maxPollAttempts * poweroffDefaults.pollIntervalMs,
    true,
  );
});

// ---------------------------------------------------------------------------
// execute — error paths
// ---------------------------------------------------------------------------

Deno.test("poweron: without looked-up state, says to run lookup and calls no API", async () => {
  const ctx = makeContext({ name: "web-1", token: "tok" });
  let fetched = false;

  await assertRejects(
    () =>
      withMockedFetch(() => {
        fetched = true;
        return new Response("unexpected", { status: 500 });
      }, () => methods.poweron.execute(FAST, ctx)),
    Error,
    "lookup",
  );
  assertEquals(fetched, false);
});

Deno.test("poweron: requires the name global argument", async () => {
  const ctx = makeContext({ token: "tok" });
  await assertRejects(
    () => methods.poweron.execute(FAST, ctx),
    Error,
    "name",
  );
});

Deno.test("poweron: refuses a running server without POSTing", async () => {
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "off") },
  );
  let posted = false;

  await assertRejects(
    () =>
      withMockedFetch((req) => {
        if (req.method === "POST") posted = true;
        return api("poweron", ["running"])(req);
      }, () => methods.poweron.execute(FAST, ctx)),
    Error,
    "already running",
  );
  assertEquals(posted, false);
});

Deno.test("poweroff: surfaces an auth failure with vault guidance", async () => {
  const ctx = makeContext(
    { name: "web-1", token: "bad" },
    { "web-1": server(42, "web-1", "running") },
  );

  await assertRejects(
    () =>
      withMockedFetch(
        () =>
          Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
        () => methods.poweroff.execute(FAST, ctx),
      ),
    Error,
    "authentication failed",
  );
});

Deno.test("poweroff: surfaces a failure from the action itself", async () => {
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "running") },
  );

  await assertRejects(
    () =>
      withMockedFetch((req) => {
        if (req.method === "POST") {
          return Response.json(
            { error: { code: "locked", message: "server is locked" } },
            { status: 423 },
          );
        }
        return api("poweroff", ["running"])(req);
      }, () => methods.poweroff.execute(FAST, ctx)),
    Error,
    "server is locked",
  );
});

// ---------------------------------------------------------------------------
// Request timeout
// ---------------------------------------------------------------------------

/** Swap globalThis.fetch for `stub` while `fn` runs. */
async function withFetchStub<T>(
  stub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("FETCH_TIMEOUT_MS is 30 seconds", () => {
  assertEquals(FETCH_TIMEOUT_MS, 30_000);
});

Deno.test("poweron: every Hetzner request carries a timeout signal", async () => {
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "off") },
  );
  const handler = api("poweron", ["off", "running"]);
  const signals: (AbortSignal | null | undefined)[] = [];

  await withFetchStub((input, init) => {
    signals.push(init?.signal);
    return Promise.resolve(handler(new Request(input, init)));
  }, () => methods.poweron.execute(FAST, ctx));

  // before-read, POST, one poll read
  assertEquals(signals.length >= 3, true);
  for (const signal of signals) {
    assertEquals(signal instanceof AbortSignal, true);
  }
});

Deno.test("poweron: a hung Hetzner request fails with a clear timeout error", async () => {
  const ctx = makeContext(
    { name: "web-1", token: "tok" },
    { "web-1": server(42, "web-1", "off") },
  );

  await assertRejects(
    () =>
      withFetchStub(
        () =>
          Promise.reject(
            new DOMException("The signal timed out.", "TimeoutError"),
          ),
        () => methods.poweron.execute(FAST, ctx),
      ),
    Error,
    "did not respond within 30s while reading the server",
  );
});
