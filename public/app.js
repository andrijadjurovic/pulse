import { initializeApp } from "@firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "@firebase/auth";

const authView = document.querySelector("#auth-view");
const appView = document.querySelector("#app-view");
const authForm = document.querySelector("#auth-form");
const monitorDialog = document.querySelector("#monitor-dialog");
const monitorForm = document.querySelector("#monitor-form");
const detailDialog = document.querySelector("#detail-dialog");
const labels = {
  status_code: "Status code",
  text_contains: "Text contains",
  response_time: "Response time",
  port_availability: "Port availability",
  custom_javascript: "Custom JavaScript",
};
const icons = { status_code: "↗", text_contains: "≡", response_time: "⌁", port_availability: "⌘", custom_javascript: "{ }" };
let monitors = [];
let user = null;
let firebaseAuth = null;
let registrationMode = false;
let searchTerm = "";
let showDownOnly = false;
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function api(path, options = {}) {
  const idToken = firebaseAuth?.currentUser ? await firebaseAuth.currentUser.getIdToken() : null;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showAuth();
    throw new Error(result.error || "Something went wrong.");
  }
  return result;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function showAuth() {
  appView.classList.add("hidden");
  authView.classList.remove("hidden");
}

function showFirebaseSetupError(message) {
  showAuth();
  document.querySelector("#auth-error").textContent = message;
}

async function initializeFirebase() {
  try {
    const response = await fetch("/api/firebase-config", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.configured) {
      throw new Error("Firebase is not configured yet. Follow the Firebase setup steps in README.md, then restart the server.");
    }
    const app = initializeApp(result.config);
    firebaseAuth = getAuth(app);
    if (result.authEmulatorUrl) connectAuthEmulator(firebaseAuth, result.authEmulatorUrl, { disableWarnings: true });
    onAuthStateChanged(firebaseAuth, async (signedInUser) => {
      user = signedInUser ? {
        id: signedInUser.uid,
        name: signedInUser.displayName || signedInUser.email?.split("@")[0] || "Pulse user",
        email: signedInUser.email || "",
      } : null;
      if (!signedInUser) {
        showAuth();
        return;
      }
      await loadDashboard();
    });
  } catch (error) {
    console.error("Firebase initialization failed:", error);
    showFirebaseSetupError(error.message);
  }
}

function showApp() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  render();
}

function updateAuthMode() {
  document.querySelector("#auth-title").textContent = registrationMode ? "Create your account." : "Good to see you.";
  document.querySelector("#auth-subtitle").textContent = registrationMode
    ? "Start keeping an eye on your services."
    : "Sign in to get your uptime overview.";
  document.querySelector("#name-field").classList.toggle("hidden", !registrationMode);
  authForm.elements.password.autocomplete = registrationMode ? "new-password" : "current-password";
  document.querySelector("#auth-submit").innerHTML = registrationMode
    ? 'Create account <span aria-hidden="true">→</span>'
    : 'Sign in <span aria-hidden="true">→</span>';
  document.querySelector("#auth-switch-label").textContent = registrationMode ? "Already have an account?" : "New to Pulse?";
  document.querySelector("#auth-switch").textContent = registrationMode ? "Sign in" : "Create an account";
}

function formatResponse(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
}

function formatDate(value) {
  if (!value) return "Waiting for first check";
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatRelative(value) {
  if (!value) return "Not checked yet";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds <= 5 ? "Just now" : `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderBars(monitor) {
  const checks = [...(monitor.recentChecks || [])].reverse();
  const bars = Array.from({ length: 30 }, (_, index) => {
    const check = checks[Math.max(0, checks.length - 30 + index)];
    if (!check || index < 30 - Math.min(checks.length, 30)) return '<i class="pending" title="No check yet"></i>';
    return `<i class="${check.status === "UP" ? "" : "down"}" title="${escapeHtml(check.status)} · ${escapeHtml(formatDate(check.checkedAt))}"></i>`;
  });
  return bars.join("");
}

function renderMonitor(monitor) {
  const isPort = monitor.type === "port_availability";
  const endpoint = isPort ? `${monitor.target}:${monitor.port}` : monitor.target;
  const status = monitor.status || "PENDING";
  const badgeClass = status === "UP" ? "badge-up" : status === "DOWN" ? "badge-down" : "badge-pending";
  const uptime = monitor.uptime === null ? "—" : `${monitor.uptime.toFixed(2)}%`;
  const responseValue = monitor.latestCheck?.responseTimeMs;
  return `<article class="monitor-card" data-id="${escapeHtml(monitor.id)}">
    <div class="monitor-primary"><span class="monitor-logo kind-${escapeHtml(monitor.type)}">${icons[monitor.type] || "◉"}</span><div class="monitor-title"><strong>${escapeHtml(monitor.name)}</strong><span class="monitor-url" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span></div></div>
    <div class="monitor-type"><span>Check type</span><strong class="type-label">${escapeHtml(labels[monitor.type] || monitor.type)}</strong></div>
    <div class="monitor-metric"><span>${isPort ? "Port" : "Response time"}</span><strong>${isPort ? escapeHtml(String(monitor.port)) : formatResponse(responseValue)}</strong></div>
    <div class="monitor-uptime"><div class="uptime-percent"><strong>${uptime}</strong><span>uptime</span></div><div class="mini-bars">${renderBars(monitor)}</div></div>
    <span class="status-badge ${badgeClass}"><i class="badge-dot"></i>${status === "PENDING" ? "Pending" : status}</span>
    <div class="monitor-actions"><button class="icon-button" data-action="run" title="Check now" aria-label="Check ${escapeHtml(monitor.name)} now">↻</button><button class="icon-button" data-action="edit" title="Edit" aria-label="Edit ${escapeHtml(monitor.name)}">✎</button><button class="icon-button danger" data-action="delete" title="Delete" aria-label="Delete ${escapeHtml(monitor.name)}">⌫</button></div>
  </article>`;
}

function render() {
  const name = user?.name || "there";
  document.querySelector("#greeting-name").textContent = name.split(/\s+/)[0];
  document.querySelector("#workspace-name").textContent = `${name.split(/\s+/)[0]}'s workspace`;
  document.querySelector("#profile-name").textContent = name;
  document.querySelector("#profile-email").textContent = user?.email || "";
  document.querySelector("#profile-avatar").textContent = name.charAt(0).toUpperCase();
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date());
  document.querySelector("#nav-count").textContent = monitors.length;
  document.querySelector("#monitor-count").textContent = monitors.length;

  const up = monitors.filter((monitor) => monitor.status === "UP").length;
  const down = monitors.filter((monitor) => monitor.status === "DOWN").length;
  const responses = monitors.map((monitor) => monitor.averageResponseTimeMs).filter((value) => value !== null);
  const average = responses.length ? responses.reduce((sum, value) => sum + value, 0) / responses.length : null;
  document.querySelector("#stat-total").textContent = monitors.length;
  document.querySelector("#stat-up").innerHTML = `${up}<span class="stat-unit"> / ${monitors.length}</span>`;
  document.querySelector("#stat-down").textContent = down;
  document.querySelector("#stat-response").innerHTML = `${average === null ? "—" : Math.round(average)}<span class="stat-unit"> ms</span>`;

  const filtered = monitors.filter((monitor) =>
    (!showDownOnly || monitor.status === "DOWN") &&
    `${monitor.name} ${monitor.target} ${labels[monitor.type]}`.toLowerCase().includes(searchTerm),
  );
  document.querySelector("#monitor-list").innerHTML = filtered.map(renderMonitor).join("");
  document.querySelector("#empty-state").classList.toggle("hidden", filtered.length > 0);
  document.querySelector("#monitor-list").classList.toggle("hidden", filtered.length === 0);
  const noResults = monitors.length > 0;
  document.querySelector("#empty-state").querySelector("h3").textContent = noResults
    ? showDownOnly && !searchTerm ? "No monitors need attention" : "No matching monitors"
    : "No monitors yet";
  document.querySelector("#empty-state").querySelector("p").textContent = noResults
    ? showDownOnly && !searchTerm ? "All monitored services are operational." : "Try another search or filter."
    : "Add your first endpoint and Pulse will start checking it automatically.";
  document.querySelector("#empty-add").classList.toggle("hidden", noResults);
}

async function loadDashboard() {
  try {
    const result = await api("/api/me");
    user = result.user;
    monitors = result.monitors;
    showApp();
  } catch (error) {
    console.error(error);
    showAuth();
    document.querySelector("#auth-error").textContent = error.message;
  }
}

function openMonitor(monitor = null) {
  monitorForm.reset();
  monitorForm.elements.id.value = monitor?.id || "";
  document.querySelector("#modal-title").textContent = monitor ? "Edit monitor" : "Add a monitor";
  document.querySelector("#save-monitor").innerHTML = monitor
    ? 'Save changes <span aria-hidden="true">→</span>'
    : 'Create monitor <span aria-hidden="true">→</span>';
  if (monitor) {
    for (const [key, value] of Object.entries(monitor)) {
      if (monitorForm.elements[key] && value !== null && value !== undefined) monitorForm.elements[key].value = value;
    }
  }
  updateMonitorFields();
  document.querySelector("#monitor-error").textContent = "";
  monitorDialog.showModal();
}

function updateMonitorFields() {
  const type = monitorForm.elements.type.value;
  document.querySelectorAll(".conditional-field").forEach((field) => {
    field.classList.toggle("hidden", !field.dataset.type.split(" ").includes(type));
  });
  const isPort = type === "port_availability";
  const target = document.querySelector("#target-input");
  target.type = isPort ? "text" : "url";
  target.placeholder = isPort ? "example.com" : "https://example.com";
  document.querySelector("#target-label").textContent = isPort ? "Host name" : "URL to monitor";
  target.required = true;
}

async function showDetails(monitor) {
  document.querySelector("#detail-title").textContent = monitor.name;
  const summary = document.querySelector("#detail-summary");
  summary.innerHTML = `<span>${escapeHtml(labels[monitor.type])}</span><span>Every ${monitor.intervalSeconds}s</span><span>Uptime ${monitor.uptime === null ? "—" : `${monitor.uptime.toFixed(2)}%`}</span><span>Avg. ${formatResponse(monitor.averageResponseTimeMs)}</span>`;
  document.querySelector("#history-list").innerHTML = '<p class="muted">Loading check history…</p>';
  detailDialog.showModal();
  try {
    const result = await api(`/api/monitors/${monitor.id}/checks?limit=100`);
    document.querySelector("#history-list").innerHTML = result.checks.length ? result.checks.map((check) => `
      <div class="history-row"><span class="history-state ${check.status.toLowerCase()}">${escapeHtml(check.status)}</span>
      <span class="history-message" title="${escapeHtml(check.message)}">${escapeHtml(check.message)}</span>
      <span class="history-time">${escapeHtml(formatResponse(check.responseTimeMs))}<br>${escapeHtml(formatDate(check.checkedAt))}</span></div>`).join("") : '<p class="muted">No checks have run yet.</p>';
  } catch (error) {
    document.querySelector("#history-list").innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = document.querySelector("#auth-error");
  errorBox.textContent = "";
  const form = Object.fromEntries(new FormData(authForm));
  try {
    if (!firebaseAuth) throw new Error("Firebase is not ready. Check the Firebase setup in README.md.");
    if (registrationMode) {
      const credentials = await createUserWithEmailAndPassword(firebaseAuth, form.email, form.password);
      const name = String(form.name || "").trim();
      if (name) await updateProfile(credentials.user, { displayName: name });
      await credentials.user.getIdToken(true);
    } else {
      await signInWithEmailAndPassword(firebaseAuth, form.email, form.password);
    }
    authForm.reset();
    await loadDashboard();
  } catch (error) {
    errorBox.textContent = error.code === "auth/email-already-in-use"
      ? "An account with this email already exists."
      : error.code === "auth/invalid-credential"
        ? "Email or password is incorrect."
        : error.message;
  }
});

document.querySelector("#auth-switch").addEventListener("click", () => {
  registrationMode = !registrationMode;
  document.querySelector("#auth-error").textContent = "";
  updateAuthMode();
});
document.querySelectorAll("#top-add, #nav-add, #empty-add").forEach((button) => button.addEventListener("click", () => openMonitor()));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelector("#check-type").addEventListener("change", updateMonitorFields);
document.querySelector("#monitor-search").addEventListener("input", (event) => {
  searchTerm = event.target.value.trim().toLowerCase();
  render();
});
document.querySelector("#filter-button").addEventListener("click", () => {
  showDownOnly = !showDownOnly;
  document.querySelector("#filter-button").classList.toggle("active", showDownOnly);
  document.querySelector("#filter-button").setAttribute("aria-pressed", String(showDownOnly));
  render();
});

monitorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorBox = document.querySelector("#monitor-error");
  errorBox.textContent = "";
  const id = monitorForm.elements.id.value;
  const data = Object.fromEntries(new FormData(monitorForm));
  for (const key of ["expectedStatus", "maxResponseTimeMs", "port", "intervalSeconds", "timeoutMs"]) {
    if (data[key]) data[key] = Number(data[key]);
  }
  delete data.id;
  try {
    await api(id ? `/api/monitors/${id}` : "/api/monitors", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(data),
    });
    monitorDialog.close();
    await loadDashboard();
    showToast(id ? "Monitor updated." : "Monitor created. First check started.");
  } catch (error) {
    errorBox.textContent = error.message;
  }
});

document.querySelector("#monitor-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  const card = event.target.closest(".monitor-card");
  if (!card) return;
  const monitor = monitors.find((item) => item.id === card.dataset.id);
  if (!monitor) return;
  if (!button) {
    await showDetails(monitor);
    return;
  }
  if (button.dataset.action === "edit") openMonitor(monitor);
  if (button.dataset.action === "run") {
    try {
      await api(`/api/monitors/${monitor.id}/run`, { method: "POST" });
      showToast("Check started.");
      setTimeout(loadDashboard, 1200);
    } catch (error) { showToast(error.message); }
  }
  if (button.dataset.action === "delete" && window.confirm(`Delete "${monitor.name}" and its check history?`)) {
    try {
      await api(`/api/monitors/${monitor.id}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Monitor and its history deleted.");
    } catch (error) { showToast(error.message); }
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await signOut(firebaseAuth);
    user = null;
    monitors = [];
    showAuth();
    showToast("You have signed out.");
  } catch (error) { showToast(error.message); }
});
document.querySelector("#refresh-button").addEventListener("click", loadDashboard);

document.querySelectorAll(".uptime-bars").forEach((container, index) => {
  container.innerHTML = Array.from({ length: 60 }, (_, bar) =>
    `<i class="${bar === 17 || bar === 44 ? "down" : ""}"></i>`,
  ).join("");
});

updateAuthMode();
void initializeFirebase();
setInterval(() => {
  if (firebaseAuth?.currentUser && !appView.classList.contains("hidden") && !monitorDialog.open && !detailDialog.open) loadDashboard();
}, 30000);
