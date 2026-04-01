import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import net from "net";
import { createAgentBackend, type AgentBackend } from "./agent-backend.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;
let cachedName: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

function getPackageName(): string {
  if (cachedName) return cachedName;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.name === "string") {
      cachedName = pkg.name;
      return cachedName;
    }
  } catch {
    // ignore
  }
  cachedName = "@arjun-ingole/opencode-browser";
  return cachedName;
}

const { schema } = tool;

const BASE_DIR = join(homedir(), ".opencode-browser");
const CONFIG_PATH = join(BASE_DIR, "config.json");
const SOCKET_PATH = getBrokerSocketPath();
const LOG_PATH = join(BASE_DIR, "plugin.log");
const PACKAGE_INSTALL_SPEC = "github:Arjun-Ingole/opencode-browser";

type BackendMode = "auto" | "agent" | "native";
type BackendSource = "env" | "config" | "default";

type BackendPreference = {
  mode: BackendMode;
  source: BackendSource;
  raw: string | null;
};

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

type BackendProbe = {
  backend: "agent-browser" | "extension";
  connected: boolean;
  capabilities: Record<string, boolean | string>;
  active_session: string | null;
  error?: string;
  setup?: string[];
  [key: string]: any;
};

type BackendSelection =
  | {
      requestedMode: BackendMode;
      requestedBy: BackendSource;
      effectiveBackend: "agent" | "native";
      selectionReason: string;
      selected: BackendProbe;
      alternate: BackendProbe;
      probes: { agent: BackendProbe; native: BackendProbe };
    }
  | {
      requestedMode: BackendMode;
      requestedBy: BackendSource;
      effectiveBackend: null;
      selectionReason: string;
      selected: null;
      alternate: BackendProbe | null;
      probes: { agent: BackendProbe; native: BackendProbe };
    };

function getSafePipeName(): string {
  try {
    const username = userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath(): string {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return join(BASE_DIR, "broker.sock");
}

mkdirSync(BASE_DIR, { recursive: true });

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

logDebug(`plugin loaded v${getPackageVersion()} pid=${process.pid} socket=${SOCKET_PATH}`);

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.OPENCODE_BROWSER_MAX_UPLOAD_BYTES;
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_UPLOAD_BYTES;
})();

function resolveUploadPath(filePath: string): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): { name: string; mimeType?: string; base64: string } {
  const absPath = resolveUploadPath(filePath);
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (OPENCODE_BROWSER_MAX_UPLOAD_BYTES). ` +
        `For larger uploads, use OPENCODE_BROWSER_BACKEND=agent.`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : basename(absPath);
  const mt = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined;
  return { name, mimeType: mt, base64 };
}

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      lastBrokerError = err instanceof Error ? err : new Error(String(err));
      logDebug(`broker connect error socket=${SOCKET_PATH} error=${lastBrokerError.message}`);
      reject(err);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

function normalizeBackendMode(raw: string | undefined | null): BackendMode | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) return null;
  if (value === "auto") return "auto";
  if (["agent", "agent-browser", "agentbrowser"].includes(value)) return "agent";
  if (["native", "extension", "chrome"].includes(value)) return "native";
  return null;
}

function readPersistedConfig(): any | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function getConfiguredBackendPreference(): BackendPreference {
  const envRaw = process.env.OPENCODE_BROWSER_BACKEND ?? process.env.OPENCODE_BROWSER_MODE ?? null;
  const envMode = normalizeBackendMode(envRaw);
  if (envMode) {
    return { mode: envMode, source: "env", raw: envRaw };
  }

  const config = readPersistedConfig();
  const configRaw =
    typeof config?.browser?.backend === "string"
      ? config.browser.backend
      : typeof config?.backend === "string"
        ? config.backend
        : null;
  const configMode = normalizeBackendMode(configRaw);
  if (configMode) {
    return { mode: configMode, source: "config", raw: configRaw };
  }

  return { mode: "auto", source: "default", raw: null };
}

function getNativeCapabilities(): Record<string, boolean | string> {
  return {
    profile_access: true,
    headless: false,
    tab_claims: true,
    file_uploads: "limited",
    downloads: true,
    coordinate_actions: true,
    pointer_buttons: true,
    drag: true,
    geometry: false,
    frames: false,
    dialogs: false,
    network_observability: false,
    debugger_input: true,
  };
}

function getFallbackBackendMessage(backend: "agent" | "native"): string {
  return backend === "agent"
    ? "Set OPENCODE_BROWSER_BACKEND=agent or `opencode-browser backend agent` after agent-browser is installed."
    : "Set OPENCODE_BROWSER_BACKEND=native or `opencode-browser backend native` after the extension is connected.";
}

function nativeSetupSteps(): string[] {
  return [
    `Run \`npx ${PACKAGE_INSTALL_SPEC} install\` to install the broker and native host.`,
    "Load and pin the unpacked extension in chrome://extensions.",
    "Click the OpenCode Browser extension icon so the native host connection is established.",
  ];
}

function agentSetupSteps(): string[] {
  return [
    `Run \`npx ${PACKAGE_INSTALL_SPEC} agent-install\` or install \`agent-browser\` globally.`,
    "Ensure the agent-browser daemon or gateway is reachable.",
    "Set OPENCODE_BROWSER_BACKEND=agent to force it, or use auto mode to prefer it when available.",
  ];
}

let socket: net.Socket | null = null;
let lastBrokerError: Error | null = null;
const sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const agentBackend: AgentBackend = createAgentBackend(sessionId);

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {
        // retry
      }
    }
  }

  if (!socket || socket.destroyed) {
    const errorMessage = lastBrokerError?.message ? ` (${lastBrokerError.message})` : "";
    throw new Error(
      `Could not connect to local broker at ${SOCKET_PATH}${errorMessage}. ` +
        `Run \`npx ${PACKAGE_INSTALL_SPEC} install\` and ensure the extension is loaded.`
    );
  }

  socket.setNoDelay(true);
  logDebug(`broker connected socket=${SOCKET_PATH}`);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

async function probeNativeBackend(): Promise<BackendProbe> {
  try {
    const data = await brokerRequest("status", {});
    const connected = !!data?.broker && !!data?.hostConnected;
    const session = data?.session ?? null;
    return {
      backend: "extension",
      connected,
      broker: !!data?.broker,
      hostConnected: !!data?.hostConnected,
      claims: Array.isArray(data?.claims) ? data.claims : [],
      leaseTtlMs: data?.leaseTtlMs ?? null,
      session,
      capabilities: getNativeCapabilities(),
      active_session: session?.sessionId ?? sessionId,
      error: connected ? undefined : "Chrome extension is not connected (native host offline).",
      setup: connected ? undefined : nativeSetupSteps(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      backend: "extension",
      connected: false,
      broker: false,
      hostConnected: false,
      claims: [],
      leaseTtlMs: null,
      session: null,
      capabilities: getNativeCapabilities(),
      active_session: sessionId,
      error: message,
      setup: nativeSetupSteps(),
    };
  }
}

async function probeAgentBackend(): Promise<BackendProbe> {
  const status = await agentBackend.status();
  return {
    ...status,
    setup: status.connected ? undefined : agentSetupSteps(),
  };
}

async function resolveBackendSelection(): Promise<BackendSelection> {
  const preference = getConfiguredBackendPreference();
  const agent = await probeAgentBackend();
  const native = await probeNativeBackend();

  if (preference.mode === "auto") {
    if (agent.connected) {
      return {
        requestedMode: "auto",
        requestedBy: preference.source,
        effectiveBackend: "agent",
        selectionReason: "auto-preferred-agent",
        selected: agent,
        alternate: native,
        probes: { agent, native },
      };
    }
    if (native.connected) {
      return {
        requestedMode: "auto",
        requestedBy: preference.source,
        effectiveBackend: "native",
        selectionReason: "auto-fallback-native",
        selected: native,
        alternate: agent,
        probes: { agent, native },
      };
    }
    return {
      requestedMode: "auto",
      requestedBy: preference.source,
      effectiveBackend: null,
      selectionReason: "auto-no-backend-available",
      selected: null,
      alternate: null,
      probes: { agent, native },
    };
  }

  if (preference.mode === "agent") {
    if (agent.connected) {
      return {
        requestedMode: "agent",
        requestedBy: preference.source,
        effectiveBackend: "agent",
        selectionReason: "explicit-agent",
        selected: agent,
        alternate: native,
        probes: { agent, native },
      };
    }
    return {
      requestedMode: "agent",
      requestedBy: preference.source,
      effectiveBackend: null,
      selectionReason: "requested-agent-unavailable",
      selected: null,
      alternate: native.connected ? native : null,
      probes: { agent, native },
    };
  }

  if (native.connected) {
    return {
      requestedMode: "native",
      requestedBy: preference.source,
      effectiveBackend: "native",
      selectionReason: "explicit-native",
      selected: native,
      alternate: agent,
      probes: { agent, native },
    };
  }

  return {
    requestedMode: "native",
    requestedBy: preference.source,
    effectiveBackend: null,
    selectionReason: "requested-native-unavailable",
    selected: null,
    alternate: agent.connected ? agent : null,
    probes: { agent, native },
  };
}

function formatSelectionError(selection: BackendSelection): Error {
  if (selection.requestedMode === "auto") {
    const lines = [
      "No browser backend is available.",
      `Agent Browser: ${selection.probes.agent.error || "unavailable"}`,
      `Native Browser: ${selection.probes.native.error || "unavailable"}`,
      "",
      "Agent setup:",
      ...agentSetupSteps().map((step) => `- ${step}`),
      "",
      "Native setup:",
      ...nativeSetupSteps().map((step) => `- ${step}`),
    ];
    return new Error(lines.join("\n"));
  }

  const requestedLabel = selection.requestedMode === "agent" ? "Agent Browser" : "Native Browser";
  const requestedProbe = selection.requestedMode === "agent" ? selection.probes.agent : selection.probes.native;
  const fallbackProbe = selection.requestedMode === "agent" ? selection.probes.native : selection.probes.agent;
  const fallbackMode = selection.requestedMode === "agent" ? "native" : "agent";

  const lines = [
    `${requestedLabel} is unavailable.`,
    requestedProbe.error || "The selected backend could not be reached.",
  ];

  if (fallbackProbe.connected) {
    lines.push(
      "",
      `Fallback available: ${fallbackProbe.backend}.`,
      getFallbackBackendMessage(fallbackMode),
      "Use `browser_status` to inspect backend availability and selection details."
    );
  } else {
    lines.push("", "No fallback backend is currently available.");
  }

  const setup = selection.requestedMode === "agent" ? agentSetupSteps() : nativeSetupSteps();
  lines.push("", "Setup:", ...setup.map((step) => `- ${step}`));
  return new Error(lines.join("\n"));
}

async function statusRequest(): Promise<any> {
  const selection = await resolveBackendSelection();
  const selected = selection.selected;
  const alternate = selection.alternate;

  return {
    connected: !!selected?.connected,
    backend:
      selection.effectiveBackend === "agent"
        ? "agent-browser"
        : selection.effectiveBackend === "native"
          ? "extension"
          : null,
    requestedBackend: selection.requestedMode,
    selectionMode: selection.requestedMode,
    selectionSource: selection.requestedBy,
    selectionReason: selection.selectionReason,
    capabilities: selected?.capabilities ?? null,
    active_session: selected?.active_session ?? null,
    fallbackAvailable: !!alternate?.connected,
    fallbackBackend: alternate?.connected ? alternate.backend : null,
    pluginVersion: getPackageVersion(),
    agentBrowserVersion: agentBackend.getVersion(),
    backends: {
      agent: selection.probes.agent,
      native: selection.probes.native,
    },
  };
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  const selection = await resolveBackendSelection();
  if (!selection.effectiveBackend || !selection.selected) {
    throw formatSelectionError(selection);
  }

  if (selection.effectiveBackend === "agent") {
    return await agentBackend.requestTool(toolName, args);
  }
  return await brokerRequest("tool", { tool: toolName, args });
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  const selection = await resolveBackendSelection();
  if (selection.effectiveBackend !== "native") {
    const lines = [
      "This tool is only available on the native extension backend.",
      `Current selection: ${
        selection.effectiveBackend === "agent"
          ? "agent-browser"
          : selection.requestedMode === "auto"
            ? "none available"
            : selection.requestedMode
      }`,
    ];
    if (selection.probes.native.connected) {
      lines.push("Switch to the native backend with OPENCODE_BROWSER_BACKEND=native or `opencode-browser backend native`.");
    } else {
      lines.push(...nativeSetupSteps().map((step) => `- ${step}`));
    }
    throw new Error(lines.join("\n"));
  }
  return await brokerRequest(op, payload);
}

const plugin: Plugin = async () => {
  return {
    tool: {
      browser_debug: tool({
        description: "Debug plugin loading, backend preference, and connection status.",
        args: {},
        async execute() {
          const preference = getConfiguredBackendPreference();
          const status = await statusRequest();
          const lines = [
            "loaded: true",
            `sessionId: ${sessionId}`,
            `pid: ${process.pid}`,
            `pluginVersion: ${getPackageVersion()}`,
            `configPath: ${CONFIG_PATH}`,
            `requestedBackend: ${preference.mode}`,
            `selectionSource: ${preference.source}`,
            `effectiveBackend: ${status.backend ?? "none"}`,
            `selectionReason: ${status.selectionReason}`,
            `brokerSocket: ${SOCKET_PATH}`,
            `agentSession: ${agentBackend.session}`,
            `agentConnection: ${JSON.stringify(agentBackend.connection)}`,
            `agentBrowserVersion: ${agentBackend.getVersion() ?? ""}`,
            `timestamp: ${new Date().toISOString()}`,
          ];
          return lines.join("\n");
        },
      }),

      browser_version: tool({
        description: "Return the installed OpenCode Browser plugin version.",
        args: {},
        async execute() {
          const preference = getConfiguredBackendPreference();
          return JSON.stringify({
            name: getPackageName(),
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            requestedBackend: preference.mode,
            selectionSource: preference.source,
            agentBrowserVersion: agentBackend.getVersion(),
          });
        },
      }),

      browser_status: tool({
        description: "Check backend selection, connection status, capabilities, and current tab claims.",
        args: {},
        async execute() {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute() {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute() {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description: "Claim a browser tab for this session",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new browser tab",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }) {
          const data = await toolRequest("open_tab", { url, active });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_set_active_tab: tool({
        description: "Switch the active browser tab to a tab owned by this session.",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("set_active_tab", { tabId });
          return toolResultText(data, `Activated tab ${tabId}`);
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_back: tool({
        description: "Navigate back in the current tab history.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("back", { tabId });
          return toolResultText(data, "Navigated back");
        },
      }),

      browser_forward: tool({
        description: "Navigate forward in the current tab history.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("forward", { tabId });
          return toolResultText(data, "Navigated forward");
        },
      }),

      browser_reload: tool({
        description: "Reload the current tab.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("reload", { tabId });
          return toolResultText(data, "Reloaded tab");
        },
      }),

      browser_mouse_move: tool({
        description: "Move the mouse cursor to viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }) {
          const data = await toolRequest("mouse_move", { x, y, tabId });
          return toolResultText(data, `Moved mouse to (${x}, ${y})`);
        },
      }),

      browser_left_click: tool({
        description: "Left click at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          clickCount: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, clickCount, tabId }) {
          const data = await toolRequest("left_click", { x, y, clickCount, tabId });
          return toolResultText(data, `Left clicked at (${x}, ${y})`);
        },
      }),

      browser_right_click: tool({
        description: "Right click at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }) {
          const data = await toolRequest("right_click", { x, y, tabId });
          return toolResultText(data, `Right clicked at (${x}, ${y})`);
        },
      }),

      browser_middle_click: tool({
        description: "Middle click at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }) {
          const data = await toolRequest("middle_click", { x, y, tabId });
          return toolResultText(data, `Middle clicked at (${x}, ${y})`);
        },
      }),

      browser_double_click: tool({
        description: "Double click at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }) {
          const data = await toolRequest("double_click", { x, y, tabId });
          return toolResultText(data, `Double clicked at (${x}, ${y})`);
        },
      }),

      browser_triple_click: tool({
        description: "Triple click at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, tabId }) {
          const data = await toolRequest("triple_click", { x, y, tabId });
          return toolResultText(data, `Triple clicked at (${x}, ${y})`);
        },
      }),

      browser_mouse_down: tool({
        description: "Press and hold a mouse button at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          button: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, button, tabId }) {
          const data = await toolRequest("mouse_down", { x, y, button, tabId });
          return toolResultText(data, `Mouse down at (${x}, ${y})`);
        },
      }),

      browser_mouse_up: tool({
        description: "Release a mouse button at viewport coordinates.",
        args: {
          x: schema.number(),
          y: schema.number(),
          button: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ x, y, button, tabId }) {
          const data = await toolRequest("mouse_up", { x, y, button, tabId });
          return toolResultText(data, `Mouse up at (${x}, ${y})`);
        },
      }),

      browser_left_click_drag: tool({
        description: "Drag from one viewport coordinate to another using the left mouse button.",
        args: {
          fromX: schema.number(),
          fromY: schema.number(),
          toX: schema.number(),
          toY: schema.number(),
          steps: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ fromX, fromY, toX, toY, steps, tabId }) {
          const data = await toolRequest("left_click_drag", { fromX, fromY, toX, toY, steps, tabId });
          return toolResultText(data, `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
        },
      }),

      browser_click: tool({
        description: "Click an element on the page using a CSS selector",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Clicked ${selector}`);
        },
      }),

      browser_hover: tool({
        description: "Hover an element on the page using a selector.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("hover", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Hovered ${selector}`);
        },
      }),

      browser_focus: tool({
        description: "Focus an element on the page using a selector.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("focus", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Focused ${selector}`);
        },
      }),

      browser_type: tool({
        description: "Type text into an input element",
        args: {
          selector: schema.string(),
          text: schema.string(),
          clear: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, clear, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Typed "${text}" into ${selector}`);
        },
      }),

      browser_key: tool({
        description: "Press a keyboard key or chord, optionally targeting a selector first.",
        args: {
          key: schema.string(),
          selector: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ key, selector, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("key", { key, selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Pressed ${key}`);
        },
      }),

      browser_key_down: tool({
        description: "Press and hold a keyboard key.",
        args: {
          key: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ key, tabId }) {
          const data = await toolRequest("key_down", { key, tabId });
          return toolResultText(data, `Key down ${key}`);
        },
      }),

      browser_key_up: tool({
        description: "Release a held keyboard key.",
        args: {
          key: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ key, tabId }) {
          const data = await toolRequest("key_up", { key, tabId });
          return toolResultText(data, `Key up ${key}`);
        },
      }),

      browser_select: tool({
        description: "Select an option in a native select element",
        args: {
          selector: schema.string(),
          value: schema.string().optional(),
          label: schema.string().optional(),
          optionIndex: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs });
          const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
          return toolResultText(data, `Selected ${summary} in ${selector}`);
        },
      }),

      browser_screenshot: tool({
        description: "Take a screenshot of the current page. Returns base64 image data URL.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("screenshot", { tabId });
          return toolResultText(data, "Screenshot failed");
        },
      }),

      browser_snapshot: tool({
        description: "Get an accessibility tree snapshot of the page.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }) {
          const data = await toolRequest("snapshot", { tabId });
          return toolResultText(data, "Snapshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: schema.string().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, x, y, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_query: tool({
        description:
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
        args: {
          selector: schema.string().optional(),
          mode: schema.string().optional(),
          attribute: schema.string().optional(),
          property: schema.string().optional(),
          index: schema.number().optional(),
          limit: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          pattern: schema.string().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }) {
          const data = await toolRequest("query", {
            selector,
            mode,
            attribute,
            property,
            index,
            limit,
            timeoutMs,
            pollMs,
            pattern,
            flags,
            tabId,
          });
          return toolResultText(data, "Query failed");
        },
      }),

      browser_download: tool({
        description: "Download a file via URL or by clicking an element on the page.",
        args: {
          url: schema.string().optional(),
          selector: schema.string().optional(),
          filename: schema.string().optional(),
          conflictAction: schema.string().optional(),
          saveAs: schema.boolean().optional(),
          wait: schema.boolean().optional(),
          downloadTimeoutMs: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs }
        ) {
          const data = await toolRequest("download", {
            url,
            selector,
            filename,
            conflictAction,
            saveAs,
            wait,
            downloadTimeoutMs,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Download started");
        },
      }),

      browser_list_downloads: tool({
        description: "List recent downloads (Chrome backend) or session downloads (agent backend).",
        args: {
          limit: schema.number().optional(),
          state: schema.string().optional(),
        },
        async execute({ limit, state }) {
          const data = await toolRequest("list_downloads", { limit, state });
          return toolResultText(data, "[]");
        },
      }),

      browser_set_file_input: tool({
        description: "Set a file input element's selected file using a local file path.",
        args: {
          selector: schema.string(),
          filePath: schema.string(),
          fileName: schema.string().optional(),
          mimeType: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }) {
          const selection = await resolveBackendSelection();
          if (selection.effectiveBackend === "agent") {
            const data = await agentBackend.requestTool("set_file_input", { selector, filePath, tabId, index, timeoutMs, pollMs });
            return toolResultText(data, "Set file input");
          }
          if (selection.effectiveBackend !== "native") {
            throw formatSelectionError(selection);
          }

          const file = buildFileUploadPayload(filePath, fileName, mimeType);
          const data = await brokerRequest("tool", {
            tool: "set_file_input",
            args: {
              selector,
              tabId,
              index,
              timeoutMs,
              pollMs,
              files: [file],
            },
          });
          return toolResultText(data, "Set file input");
        },
      }),

      browser_highlight: tool({
        description: "Highlight an element on the page with a colored border for visual debugging.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          duration: schema.number().optional(),
          color: schema.string().optional(),
          showInfo: schema.boolean().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }) {
          const data = await toolRequest("highlight", {
            selector,
            index,
            duration,
            color,
            showInfo,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Highlight failed");
        },
      }),

      browser_console: tool({
        description:
          "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          filter: schema.string().optional(),
        },
        async execute({ tabId, clear, filter }) {
          const data = await toolRequest("console", { tabId, clear, filter });
          return toolResultText(data, "[]");
        },
      }),

      browser_errors: tool({
        description:
          "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, clear }) {
          const data = await toolRequest("errors", { tabId, clear });
          return toolResultText(data, "[]");
        },
      }),
    },
  };
};

export default plugin;
