const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const firebaseAdminAuth = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

require("dotenv").config({ path: path.join(__dirname, ".env") });
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 32 * 1024;
const MAX_HISTORY = 500;
const DASHBOARD_HISTORY_LIMIT = 30;
const MAX_CUSTOM_SCRIPT_BYTES = 8 * 1024;
const MAX_CUSTOM_RESPONSE_BYTES = 128 * 1024;
const CUSTOM_CHECK_TIMEOUT_MS = 5000;
const CUSTOM_CONTAINER_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_CUSTOM_CHECKS = 2;
const CUSTOM_CHECK_IMAGE = process.env.CUSTOM_CHECK_IMAGE || "pulse-custom-check:local";
const activeChecks = new Set();
const activeCustomChecks = new Set();
const monitorSchedule = new Map();
const monitorCheckCounts = new Map();
const firebasePublicConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.FIREBASE_PROJECT_ID || "",
  appId: process.env.FIREBASE_APP_ID || "",
};
let firestore;
let firebaseAuth;

function firebaseNotConfigured() {
  return Object.assign(
    new Error("Firebase is not configured. Follow the Firebase setup steps in README.md."),
    { status: 503 },
  );
}

function getFirebaseServices() {
  if (Object.values(firebasePublicConfig).some((value) => !value)) throw firebaseNotConfigured();
  if (firestore && firebaseAuth) return { firestore, firebaseAuth };

  try {
    const app = getApps()[0] || initializeApp({
      credential: applicationDefault(),
      projectId: firebasePublicConfig.projectId,
    });
    firestore = getFirestore(app);
    const getAuth = firebaseAdminAuth.getAuth || firebaseAdminAuth.default?.getAuth;
    if (typeof getAuth !== "function") {
      throw new Error("Firebase Admin Auth SDK does not expose getAuth.");
    }
    firebaseAuth = getAuth(app);
    return { firestore, firebaseAuth };
  } catch (error) {
    throw Object.assign(
      new Error(`Could not initialize Firebase Admin SDK: ${error.message}`),
      { status: 503 },
    );
  }
}

function monitorReference(monitorId) {
  return getFirebaseServices().firestore.collection("monitors").doc(monitorId);
}

function monitorChecksReference(monitorId) {
  return monitorReference(monitorId).collection("checks");
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

async function monitorChecks(monitorId, limit = 100) {
  const snapshot = await monitorChecksReference(monitorId)
    .orderBy("checkedAt", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function monitorView(monitor) {
  const checks = await monitorChecks(monitor.id, DASHBOARD_HISTORY_LIMIT);
  const latest = checks[0] || null;
  const uptime = checks.length
    ? (checks.filter((check) => check.status === "UP").length / checks.length) * 100
    : null;
  const responseChecks = checks.filter((check) => check.responseTimeMs !== null);
  const averageResponseTimeMs = responseChecks.length
    ? responseChecks.reduce((total, check) => total + check.responseTimeMs, 0) / responseChecks.length
    : null;
  return {
    ...monitor,
    checkCount: undefined,
    status: latest?.status || "PENDING",
    latestCheck: latest,
    recentChecks: checks,
    uptime,
    averageResponseTimeMs,
  };
}

function validateMonitor(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? "").trim();
  const type = input.type ?? existing.type;
  const intervalSeconds = Number(input.intervalSeconds ?? existing.intervalSeconds ?? 60);
  const timeoutMs = Number(input.timeoutMs ?? existing.timeoutMs ?? 10000);
  const target = String(input.target ?? existing.target ?? "").trim();
  const expectedStatus = Number(input.expectedStatus ?? existing.expectedStatus ?? 200);
  const keyword = String(input.keyword ?? existing.keyword ?? "").trim();
  const maxResponseTimeMs = Number(input.maxResponseTimeMs ?? existing.maxResponseTimeMs ?? 3000);
  const port = Number(input.port ?? existing.port ?? 443);
  const customScript = String(input.customScript ?? existing.customScript ?? "");
  const errors = [];

  if (!name || name.length > 80) errors.push("Name is required and must be at most 80 characters.");
  if (!["status_code", "text_contains", "response_time", "port_availability", "custom_javascript"].includes(type)) {
    errors.push("Choose a supported check type.");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 86400) {
    errors.push("Check interval must be between 30 seconds and 24 hours.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    errors.push("Timeout must be between 1 and 30 seconds.");
  }
  if (type === "port_availability") {
    if (!target || target.length > 253 || /[\s/]/.test(target)) errors.push("Enter a valid host name.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("Port must be between 1 and 65535.");
  } else {
    try {
      const url = new URL(target);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        errors.push("URL must use HTTP or HTTPS and cannot contain credentials.");
      }
    } catch {
      errors.push("Enter a valid HTTP or HTTPS URL.");
    }
  }
  if ((type === "status_code" || type === "text_contains") &&
      (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) {
    errors.push("Expected status must be an HTTP status code.");
  }
  if (type === "text_contains" && (!keyword || keyword.length > 500)) {
    errors.push("Enter text to find (up to 500 characters).");
  }
  if (type === "response_time" &&
      (!Number.isInteger(maxResponseTimeMs) || maxResponseTimeMs < 100 || maxResponseTimeMs > 30000)) {
    errors.push("Maximum response time must be between 100 and 30000 ms.");
  }
  if (type === "custom_javascript" &&
      (!customScript.trim() || Buffer.byteLength(customScript, "utf8") > MAX_CUSTOM_SCRIPT_BYTES)) {
    errors.push("Custom JavaScript is required and must be at most 8 KiB.");
  }

  if (errors.length) throw Object.assign(new Error(errors.join(" ")), { status: 400 });
  return {
    name,
    type,
    target,
    intervalSeconds,
    timeoutMs,
    expectedStatus,
    keyword,
    maxResponseTimeMs,
    port,
    customScript: type === "custom_javascript" ? customScript : "",
  };
}

async function readResponseBody(response, limit = 1024 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, limit - size);
    chunks.push(chunk);
    size += chunk.length;
    if (chunk.length !== value.length) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("Connection timed out.")), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runCustomSandbox(customScript, responseData) {
  return new Promise((resolve, reject) => {
    const containerName = `pulse-check-${crypto.randomUUID()}`;
    const args = [
      "run", "--rm", "-i", "--name", containerName,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=16",
      "--memory=96m",
      "--memory-swap=96m",
      "--cpus=0.5",
      "--user=65532:65532",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1m",
      CUSTOM_CHECK_IMAGE,
    ];
    const child = spawn(process.env.DOCKER_BIN || "docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const killer = spawn(process.env.DOCKER_BIN || "docker", ["kill", containerName], { stdio: "ignore" });
      killer.on("error", () => {});
      reject(new Error("Custom check sandbox exceeded its 15-second execution limit."));
    }, CUSTOM_CONTAINER_TIMEOUT_MS);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4096) {
        child.kill("SIGKILL");
        fail(new Error("Custom check sandbox returned too much output."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("error", (error) => fail(new Error(`Could not start the custom check sandbox: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) {
          reject(new Error(String(result.error || "Custom check script failed.").slice(0, 300)));
          return;
        }
        if (code !== 0) {
          reject(new Error((stderr.trim() || `Sandbox exited with code ${code}.`).slice(0, 300)));
          return;
        }
        resolve(result.passed);
      } catch {
        reject(new Error("Custom check sandbox returned an invalid result."));
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(new Error(`Could not send response data to sandbox: ${error.message}`));
    });
    child.stdin.end(JSON.stringify({ customScript, response: responseData }));
  });
}

async function performCheck(monitor) {
  const startedAt = performance.now();
  try {
    if (monitor.type === "port_availability") {
      await checkPort(monitor.target, monitor.port, monitor.timeoutMs);
      return { status: "UP", responseTimeMs: Math.round(performance.now() - startedAt), message: `Port ${monitor.port} is accepting connections.` };
    }

    const response = await fetch(monitor.target, {
      signal: AbortSignal.timeout(monitor.timeoutMs),
      redirect: "manual",
      headers: { "User-Agent": "UptimeMonitor/1.0" },
    });
    const responseTimeMs = Math.round(performance.now() - startedAt);
    let isUp = response.ok;
    let message = `HTTP ${response.status} ${response.statusText}`.trim();
    if (monitor.type === "custom_javascript") {
      const body = await readResponseBody(response, MAX_CUSTOM_RESPONSE_BYTES);
      const safeHeaders = {};
      const allowedHeaders = new Set(["cache-control", "content-length", "content-type", "etag", "last-modified", "location"]);
      for (const [name, value] of response.headers) {
        if (allowedHeaders.has(name)) safeHeaders[name] = value.slice(0, 1024);
      }
      isUp = await runCustomSandbox(monitor.customScript, {
        status: response.status,
        statusText: response.statusText.slice(0, 200),
        headers: safeHeaders,
        body,
        responseTimeMs,
      });
      message = isUp ? "Custom check passed." : "Custom check returned false.";
    } else if (monitor.type === "status_code") {
      isUp = response.status === monitor.expectedStatus;
      message = isUp ? `Expected HTTP ${monitor.expectedStatus} received.` : `Expected HTTP ${monitor.expectedStatus}, received HTTP ${response.status}.`;
    } else if (monitor.type === "text_contains") {
      const body = await readResponseBody(response);
      isUp = response.status === monitor.expectedStatus && body.includes(monitor.keyword);
      message = response.status !== monitor.expectedStatus
        ? `Expected HTTP ${monitor.expectedStatus}, received HTTP ${response.status}.`
        : isUp ? "Expected text was found in the response." : "Expected text was not found in the response.";
    } else if (monitor.type === "response_time") {
      isUp = response.ok && responseTimeMs <= monitor.maxResponseTimeMs;
      message = !response.ok
        ? `HTTP ${response.status} ${response.statusText}`.trim()
        : isUp ? `Response was within ${monitor.maxResponseTimeMs} ms.` : `Response took ${responseTimeMs} ms (limit: ${monitor.maxResponseTimeMs} ms).`;
    }
    return { status: isUp ? "UP" : "DOWN", responseTimeMs, message };
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "AbortError"
      ? `Check timed out after ${monitor.timeoutMs} ms.`
      : error.message || "Connection failed.";
    return { status: "DOWN", responseTimeMs: null, message: message.slice(0, 300) };
  }
}

async function runCheck(monitor) {
  if (activeChecks.has(monitor.id)) return;
  if (monitor.type === "custom_javascript" && activeCustomChecks.size >= MAX_CONCURRENT_CUSTOM_CHECKS) return;
  activeChecks.add(monitor.id);
  if (monitor.type === "custom_javascript") activeCustomChecks.add(monitor.id);
  const scheduledMonitor = monitorSchedule.get(monitor.id);
  if (scheduledMonitor) scheduledMonitor.nextCheckAt = Date.now() + scheduledMonitor.intervalSeconds * 1000;
  try {
    const result = await performCheck(monitor);
    const checkedAt = new Date().toISOString();
    const monitorRef = monitorReference(monitor.id);
    const checksRef = monitorRef.collection("checks");
    const checkRef = checksRef.doc();
    const checkCount = (monitorCheckCounts.get(monitor.id) || 0) + 1;
    const batch = firestore.batch();
    batch.set(checkRef, {
      monitorId: monitor.id,
      checkedAt,
      ...result,
    });
    batch.update(monitorRef, { checkCount, lastCheckedAt: checkedAt });
    await batch.commit();
    monitorCheckCounts.set(monitor.id, checkCount);

    if (checkCount > MAX_HISTORY) {
      const expiredChecks = await checksRef
        .orderBy("checkedAt", "asc")
        .limit(Math.min(MAX_HISTORY, checkCount - MAX_HISTORY))
        .get();
      if (!expiredChecks.empty) {
        const pruneBatch = firestore.batch();
        expiredChecks.docs.forEach((doc) => pruneBatch.delete(doc.ref));
        await pruneBatch.commit();
      }
    }
  } catch (error) {
    console.error(`Could not save check for monitor ${monitor.id}:`, error);
  } finally {
    activeChecks.delete(monitor.id);
    activeCustomChecks.delete(monitor.id);
  }
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    }[path.extname(filePath)] || "application/octet-stream";
    const authEmulatorOrigin = process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? ` http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`
      : "";
    response.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com${authEmulatorOrigin}; frame-src https://*.firebaseapp.com https://*.web.app${authEmulatorOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    response.end(content);
  });
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const method = request.method;

  if (method === "GET" && pathname === "/api/firebase-config") {
    return sendJson(response, 200, {
      configured: Object.values(firebasePublicConfig).every(Boolean),
      config: firebasePublicConfig,
      authEmulatorUrl: process.env.FIREBASE_AUTH_EMULATOR_HOST
        ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`
        : null,
    });
  }

  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) throw Object.assign(new Error("Please sign in to continue."), { status: 401 });

  const services = getFirebaseServices();
  let identity;
  try {
    identity = await services.firebaseAuth.verifyIdToken(token);
  } catch {
    throw Object.assign(new Error("Your session is invalid or has expired. Please sign in again."), { status: 401 });
  }
  const user = {
    id: identity.uid,
    name: String(identity.name || identity.email?.split("@")[0] || "Pulse user").slice(0, 80),
    email: identity.email || "",
  };
  const profileRef = services.firestore.collection("users").doc(user.id);
  const profile = await profileRef.get();
  if (!profile.exists) {
    await profileRef.set({ ...user, createdAt: new Date().toISOString() });
  }

  if (method === "GET" && pathname === "/api/me") {
    const snapshot = await services.firestore.collection("monitors")
      .where("userId", "==", user.id)
      .get();
    const ownedMonitors = await Promise.all(snapshot.docs.map(async (doc) =>
      monitorView({ id: doc.id, ...doc.data() }),
    ));
    return sendJson(response, 200, {
      user: { id: user.id, name: user.name, email: user.email },
      monitors: ownedMonitors,
    });
  }
  if (method === "POST" && pathname === "/api/monitors") {
    const data = validateMonitor(await readJson(request));
    const monitor = {
      id: crypto.randomUUID(),
      userId: user.id,
      ...data,
      checkCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await monitorReference(monitor.id).set(monitor);
    monitorSchedule.set(monitor.id, { ...monitor, nextCheckAt: 0 });
    monitorCheckCounts.set(monitor.id, 0);
    void runCheck(monitor);
    return sendJson(response, 201, { monitor: await monitorView(monitor) });
  }

  const match = pathname.match(/^\/api\/monitors\/([0-9a-f-]+)(?:\/(checks|run))?$/i);
  if (match) {
    const [, monitorId, action] = match;
    const monitorRef = monitorReference(monitorId);
    const monitorSnapshot = await monitorRef.get();
    if (!monitorSnapshot.exists || monitorSnapshot.data().userId !== user.id) {
      throw Object.assign(new Error("Monitor not found."), { status: 404 });
    }
    const monitor = { id: monitorSnapshot.id, ...monitorSnapshot.data() };
    if (method === "GET" && action === "checks") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      return sendJson(response, 200, { checks: await monitorChecks(monitor.id, limit) });
    }
    if (method === "POST" && action === "run") {
      const scheduledMonitor = monitorSchedule.get(monitor.id);
      if (scheduledMonitor) scheduledMonitor.nextCheckAt = 0;
      void runCheck(monitor);
      return sendJson(response, 202, { message: "Check started." });
    }
    if (method === "PATCH" && !action) {
      const data = validateMonitor(await readJson(request), monitor);
      const updatedMonitor = { ...monitor, ...data, updatedAt: new Date().toISOString() };
      await monitorRef.set({ ...data, updatedAt: updatedMonitor.updatedAt }, { merge: true });
      monitorSchedule.set(monitor.id, { ...updatedMonitor, nextCheckAt: 0 });
      void runCheck(updatedMonitor);
      return sendJson(response, 200, { monitor: await monitorView(updatedMonitor) });
    }
    if (method === "DELETE" && !action) {
      await services.firestore.recursiveDelete(monitorRef);
      monitorSchedule.delete(monitor.id);
      monitorCheckCounts.delete(monitor.id);
      return sendJson(response, 200, { message: "Monitor deleted." });
    }
  }
  throw Object.assign(new Error("Endpoint not found."), { status: 404 });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : "An unexpected server error occurred.",
      });
    }
    if (!error.status) console.error(error);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const monitor of monitorSchedule.values()) {
    if (activeChecks.has(monitor.id)) continue;
    if (now >= (monitor.nextCheckAt || 0)) {
      void runCheck(monitor);
    }
  }
}, 1000).unref();

async function loadMonitorsForScheduler() {
  if (Object.values(firebasePublicConfig).some((value) => !value)) {
    console.warn("Firebase is not configured. Set up Firebase using README.md before using authenticated features.");
    return;
  }
  try {
    const { firestore: database } = getFirebaseServices();
    const snapshot = await database.collection("monitors").get();
    for (const doc of snapshot.docs) {
      const monitor = { id: doc.id, ...doc.data(), nextCheckAt: 0 };
      monitorSchedule.set(monitor.id, monitor);
      monitorCheckCounts.set(monitor.id, Number(monitor.checkCount) || 0);
    }
    console.log(`Loaded ${monitorSchedule.size} monitor(s) from Firestore.`);
  } catch (error) {
    console.error("Could not load monitors from Firestore:", error.message);
  }
}

server.listen(PORT, () => {
  console.log(`Uptime Monitor is available at http://localhost:${PORT}`);
  void loadMonitorsForScheduler();
});
