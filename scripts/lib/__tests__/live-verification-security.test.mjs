import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
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

const { verifyPublishedContent } = loadModule();

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
