import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(repoRoot, "src/lib/content/live-verification.ts");
const require = createRequire(import.meta.url);

function loadModule() {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const cjsModule = { exports: {} };
  const sandbox = {
    module: cjsModule,
    exports: cjsModule.exports,
    require,
    process,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: sourcePath });
  return cjsModule.exports;
}

const { createPinnedLookup, requestDefault, verifyPublishedContent } = loadModule();
let opensslProbeError;
let tlsFixtureSkipReason = false;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch (error) {
  if (error?.code === "ENOENT") {
    tlsFixtureSkipReason = "TLS fixture requires openssl, but the executable was not found in PATH";
  } else {
    opensslProbeError = error;
  }
}

async function withEphemeralTlsFixture(run) {
  if (opensslProbeError) throw opensslProbeError;
  const fixtureDir = mkdtempSync(join(tmpdir(), "live-verification-tls-"));
  const keyPath = join(fixtureDir, "key.pem");
  const certPath = join(fixtureDir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey", "rsa:2048",
      "-nodes",
      "-sha256",
      "-days", "1",
      "-subj", "/CN=publish.test",
      "-addext", "subjectAltName=DNS:publish.test",
      "-keyout", keyPath,
      "-out", certPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    return await run({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function baseInput(url) {
  return {
    type: "blog",
    url,
    expectedTitle: "Safe publication",
    expectedSlug: "safe-publication",
    expectedDescription: "A sufficiently long expected publication phrase for verification.",
  };
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  try {
    return await run(address.port);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function withSecureServer(tlsFixture, handler, run) {
  const server = createSecureServer(tlsFixture, handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  try {
    return await run(address.port);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function withTcpServer(handler, run) {
  const sockets = new Set();
  const server = createTcpServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  try {
    return await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function realLoopbackTransport(port) {
  return async ({ url, timeoutMs, maxBodyBytes }) => {
    const rewritten = new URL(url);
    rewritten.hostname = "127.0.0.1";
    rewritten.port = String(port);
    const response = await fetch(rewritten, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { host: new URL(url).host },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBodyBytes) throw new Error("Response body exceeds configured limit");
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(bytes).toString("utf8"),
    };
  };
}

for (const [label, url] of [
  ["localhost", "http://localhost/private"],
  ["metadata IPv4", "http://169.254.169.254/latest/meta-data"],
  ["private IPv4", "http://10.0.0.1/private"],
  ["private IPv6", "http://[fd00::1]/private"],
  ["loopback IPv6", "http://[::1]/private"],
]) {
  test(`live verifier rejects ${label} even if explicitly allowlisted`, async () => {
    let transportCalls = 0;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const result = await verifyPublishedContent(baseInput(url), {
      allowedHosts: [host],
      request: async () => {
        transportCalls += 1;
        throw new Error("must not connect");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /private|loopback|link-local|metadata|forbidden/i);
    assert.equal(transportCalls, 0);
  });
}

for (const [label, url] of [
  ["IPv4 unspecified", "http://0.0.0.1/private"],
  ["IPv4 carrier-grade NAT", "http://100.64.0.1/private"],
  ["IPv4 benchmarking", "http://198.18.0.1/private"],
  ["IPv4 documentation", "http://192.0.2.1/private"],
  ["IPv4 protocol assignment", "http://192.0.0.1/private"],
  ["IPv4 deprecated 6to4 relay", "http://192.88.99.1/private"],
  ["IPv4 AS112", "http://192.31.196.1/private"],
  ["IPv4 AMT", "http://192.52.193.1/private"],
  ["IPv4 multicast", "http://224.0.0.1/private"],
  ["IPv4 future-use", "http://240.0.0.1/private"],
  ["IPv4 broadcast", "http://255.255.255.255/private"],
  ["IPv6 unspecified", "http://[::]/private"],
  ["IPv6 link-local", "http://[fe80::1]/private"],
  ["IPv6 deprecated site-local", "http://[fec0::1]/private"],
  ["IPv6 discard-only", "http://[100::1]/private"],
  ["IPv6 RFC 6145 translation", "http://[::ffff:0:0:1]/private"],
  ["IPv6 RFC 6052 translation", "http://[64:ff9b::1]/private"],
  ["IPv6 local-use translation", "http://[64:ff9b:1::1]/private"],
  ["IPv6 6to4", "http://[2002::1]/private"],
  ["IPv6 Teredo", "http://[2001::1]/private"],
  ["IPv6 benchmarking", "http://[2001:2::1]/private"],
  ["IPv6 AMT", "http://[2001:3::1]/private"],
  ["IPv6 AS112", "http://[2001:4:112::1]/private"],
  ["IPv6 deprecated ORCHID", "http://[2001:10::1]/private"],
  ["IPv6 ORCHIDv2", "http://[2001:20::1]/private"],
  ["IPv6 remote ID entity tag", "http://[2001:30::1]/private"],
  ["IPv6 segment routing", "http://[5f00::1]/private"],
  ["IPv4-compatible IPv6", "http://[::127.0.0.1]/private"],
  ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/private"],
  ["IPv6 documentation", "http://[2001:db8::1]/private"],
  ["IPv6 documentation v2", "http://[3fff::1]/private"],
  ["IPv6 multicast", "http://[ff02::1]/private"],
]) {
  test(`live verifier fail-closes the special range ${label}`, async () => {
    let transportCalls = 0;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const result = await verifyPublishedContent(baseInput(url), {
      allowedHosts: [host],
      request: async () => {
        transportCalls += 1;
        throw new Error("must not connect");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /forbidden|private|loopback|link-local|metadata/i);
    assert.equal(transportCalls, 0);
  });
}

for (const [label, address, family] of [
  ["IPv4", "8.8.8.8", 4],
  ["IPv6", "2606:4700:4700::1111", 6],
]) {
  test(`live verifier accepts a global-unicast public ${label} DNS answer`, async () => {
    const phrase = "A sufficiently long expected publication phrase for verification.";
    const result = await verifyPublishedContent(baseInput("https://publish.test/blog/safe-publication"), {
      allowedHosts: ["publish.test"],
      resolveHost: async () => [{ address, family }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<title>Safe publication</title>${phrase} safe-publication`,
      }),
    });

    assert.equal(result.ok, true, result.errors.join("; "));
  });
}

test("pinned lookup implements Node lookup callbacks for options.all false and true", async () => {
  const lookup = createPinnedLookup("93.184.216.34", 4);
  const one = await new Promise((resolveLookup, rejectLookup) => {
    lookup("publish.test", { all: false }, (error, address, family) => {
      if (error) rejectLookup(error);
      else resolveLookup({ address, family });
    });
  });
  const all = await new Promise((resolveLookup, rejectLookup) => {
    lookup("publish.test", { all: true }, (error, addresses) => {
      if (error) rejectLookup(error);
      else resolveLookup(addresses);
    });
  });

  assert.deepEqual(one, { address: "93.184.216.34", family: 4 });
  assert.equal(all.length, 1);
  assert.equal(all[0].address, "93.184.216.34");
  assert.equal(all[0].family, 4);
});

test("production HTTPS transport succeeds through its pinned all:true lookup", {
  skip: tlsFixtureSkipReason,
}, async () => {
  await withEphemeralTlsFixture(async (tlsFixture) => {
    await withSecureServer(tlsFixture, (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Safe publication</title>");
    }, async (port) => {
      const response = await requestDefault({
        url: `https://publish.test:${port}/safe-publication`,
        address: "127.0.0.1",
        family: 4,
        timeoutMs: 1_000,
        maxBodyBytes: 1_024,
        tlsCa: tlsFixture.cert,
      });

      assert.equal(response.status, 200);
      assert.match(response.body, /Safe publication/);
    });
  });
});

test("absolute deadline aborts a stalled TLS handshake", async () => {
  await withTcpServer(() => {
    // Accept TCP but intentionally never send a TLS ServerHello.
  }, async (port) => {
    const startedAt = Date.now();
    await assert.rejects(
      requestDefault({
        url: `https://publish.test:${port}/stalled-handshake`,
        address: "127.0.0.1",
        family: 4,
        timeoutMs: 70,
        maxBodyBytes: 1_024,
      }),
      /timeout/i,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 50, `handshake deadline fired too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs < 180, `TLS handshake timeout took ${elapsedMs}ms`);
  });
});

test("absolute deadline is shared across redirects", async () => {
  const startedAt = Date.now();
  let requestCalls = 0;
  const result = await verifyPublishedContent(baseInput("https://publish.test/start"), {
    allowedHosts: ["publish.test"],
    timeoutMs: 75,
    maxRedirects: 10,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async ({ url }) => {
      requestCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return { status: 302, headers: { location: new URL(`/hop-${requestCalls}`, url).toString() }, body: "" };
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /timeout/i);
  assert.ok(requestCalls >= 2, `expected multiple redirect requests, got ${requestCalls}`);
  assert.ok(elapsedMs >= 55, `redirect deadline fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 190, `redirect chain timeout took ${elapsedMs}ms`);
});

test("absolute deadline includes DNS resolution", async () => {
  const startedAt = Date.now();
  const result = await verifyPublishedContent(baseInput("https://publish.test/safe-publication"), {
    allowedHosts: ["publish.test"],
    timeoutMs: 40,
    resolveHost: () => new Promise(() => {}),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /timeout/i);
  assert.ok(elapsedMs < 160, `DNS timeout took ${elapsedMs}ms`);
});

test("production transport aborts a slow-drip body at the absolute deadline", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    const interval = setInterval(() => response.write("x"), 15);
    response.on("close", () => clearInterval(interval));
  }, async (port) => {
    const startedAt = Date.now();
    await assert.rejects(
      requestDefault({
        url: `http://publish.test:${port}/slow-drip`,
        address: "127.0.0.1",
        family: 4,
        timeoutMs: 70,
        maxBodyBytes: 1_024,
      }),
      /timeout/i,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 50, `deadline fired too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs < 180, `slow-drip timeout took ${elapsedMs}ms`);
  });
});

test("live smoke: production transport receives an HTTP response from aipaths.academy", {
  skip: process.env.RUN_LIVE_VERIFICATION_SMOKE !== "1",
}, async (context) => {
  const result = await verifyPublishedContent({
    type: "blog",
    url: "https://aipaths.academy",
    expectedTitle: "AI Paths",
  }, { timeoutMs: 8_000 });

  assert.ok(Number.isInteger(result.status), result.errors.join("; "));
  assert.ok(result.status >= 100 && result.status <= 599, `invalid HTTP status: ${result.status}`);
  context.diagnostic(`production response status=${result.status} finalUrl=${result.finalUrl}`);
});

test("live verifier rejects a redirect to a private target before the second request", async () => {
  await withServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end("unexpected");
  }, async (port) => {
    let resolveCalls = 0;
    let requestCalls = 0;
    const transport = realLoopbackTransport(port);
    const result = await verifyPublishedContent(baseInput("http://publish.test/start"), {
      allowedHosts: ["publish.test", "169.254.169.254"],
      resolveHost: async (hostname) => {
        resolveCalls += 1;
        return hostname === "publish.test"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }];
      },
      request: async (input) => {
        requestCalls += 1;
        return transport(input);
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /link-local|metadata|forbidden|private/i);
    assert.equal(requestCalls, 1);
    // The redirect target is a literal link-local IP, so it is rejected before
    // DNS or a second transport call. The original public host was resolved.
    assert.equal(resolveCalls, 1);
  });
});

test("live verifier enforces its timeout against a real slow response", async () => {
  await withServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Safe publication</title>");
    }, 200);
  }, async (port) => {
    const result = await verifyPublishedContent(baseInput("http://publish.test/safe-publication"), {
      allowedHosts: ["publish.test"],
      timeoutMs: 30,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      request: realLoopbackTransport(port),
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /timeout|abort/i);
  });
});

test("live verifier enforces its response body cap against a real oversized response", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>Safe publication</title>${"x".repeat(4096)}`);
  }, async (port) => {
    const result = await verifyPublishedContent(baseInput("http://publish.test/safe-publication"), {
      allowedHosts: ["publish.test"],
      maxBodyBytes: 256,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      request: realLoopbackTransport(port),
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /body.*limit|exceeds/i);
  });
});

test("live verifier accepts an allowed host only after public DNS validation and pinned transport", async () => {
  const phrase = "A sufficiently long expected publication phrase for verification.";
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<html><title>Safe publication</title><body>${phrase} safe-publication</body></html>`);
  }, async (port) => {
    const result = await verifyPublishedContent(baseInput("http://publish.test/blog/safe-publication"), {
      allowedHosts: ["publish.test"],
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      request: realLoopbackTransport(port),
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.finalUrl, "http://publish.test/blog/safe-publication");
  });
});

test("live verifier rejects DNS answers containing a private rebinding address", async () => {
  let transportCalls = 0;
  const result = await verifyPublishedContent(baseInput("https://publish.test/blog/safe-publication"), {
    allowedHosts: ["publish.test"],
    resolveHost: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    request: async () => {
      transportCalls += 1;
      throw new Error("must not connect");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /dns|loopback|forbidden|private/i);
  assert.equal(transportCalls, 0);
});
