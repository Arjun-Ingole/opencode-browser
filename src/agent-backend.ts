import net from "net";
import { mkdirSync, readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { createRequire } from "module";

type AgentResponse =
  | { id: string; success: true; data: any }
  | { id: string; success: false; error: string };

type AgentConnectionInfo =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

const agentRequire = createRequire(import.meta.url);
const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_PAGE_TEXT_LIMIT = 20000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_POLL_MS = 200;

const BASE_DIR = join(homedir(), ".opencode-browser");
const DEFAULT_DOWNLOADS_DIR = join(BASE_DIR, "downloads");

function getAgentCapabilities(): Record<string, boolean | string> {
  return {
    profile_access: false,
    headless: true,
    tab_claims: false,
    file_uploads: true,
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

export type AgentBackend = {
  mode: "agent";
  session: string;
  connection: AgentConnectionInfo;
  getVersion: () => string | null;
  status: () => Promise<any>;
  requestTool: (tool: string, args: Record<string, any>) => Promise<any>;
};

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

async function sleep(ms: number): Promise<void> {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAgentSession(sessionId: string): string {
  const override = process.env.OPENCODE_BROWSER_AGENT_SESSION?.trim();
  if (override) return override;
  return `opencode-${sessionId}`;
}

function getAgentPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

function getAgentConnectionInfo(session: string): AgentConnectionInfo {
  const socketOverride = process.env.OPENCODE_BROWSER_AGENT_SOCKET?.trim();
  if (socketOverride) {
    return { type: "unix", path: socketOverride };
  }

  const hostOverride = process.env.OPENCODE_BROWSER_AGENT_HOST?.trim();
  const portOverride = parseEnvNumber(process.env.OPENCODE_BROWSER_AGENT_PORT);
  const transportOverride = process.env.OPENCODE_BROWSER_AGENT_TRANSPORT?.toLowerCase();
  const forceTcp = transportOverride === "tcp" || process.env.OPENCODE_BROWSER_AGENT_TCP === "1";

  if (hostOverride || portOverride !== null || forceTcp || process.platform === "win32") {
    const host = hostOverride || "127.0.0.1";
    const port = portOverride ?? getAgentPortForSession(session);
    return { type: "tcp", host, port };
  }

  return { type: "unix", path: join(tmpdir(), `agent-browser-${session}.sock`) };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolveAgentDaemonPath(): string | null {
  const override = process.env.OPENCODE_BROWSER_AGENT_DAEMON?.trim();
  if (override) return override;
  try {
    return agentRequire.resolve("agent-browser/dist/daemon.js");
  } catch {
    return null;
  }
}

function resolveAgentNodePath(): string {
  const override = process.env.OPENCODE_BROWSER_AGENT_NODE?.trim();
  return override || process.execPath;
}

export function getAgentPackageVersion(): string | null {
  try {
    const pkgPath = agentRequire.resolve("agent-browser/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function shouldAutoStartAgent(connection: AgentConnectionInfo): boolean {
  const autoStart = process.env.OPENCODE_BROWSER_AGENT_AUTOSTART?.toLowerCase();
  if (autoStart && ["0", "false", "no"].includes(autoStart)) return false;
  if (connection.type === "unix") return true;
  return connection.type === "tcp" && process.platform === "win32" && isLocalHost(connection.host);
}

async function maybeStartAgentDaemon(connection: AgentConnectionInfo, session: string): Promise<void> {
  if (!shouldAutoStartAgent(connection)) return;
  const daemonPath = resolveAgentDaemonPath();
  if (!daemonPath) {
    throw new Error(
      "agent-browser dependency not found. Install agent-browser or set OPENCODE_BROWSER_AGENT_DAEMON."
    );
  }
  try {
    const child = spawn(resolveAgentNodePath(), [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_DAEMON: "1",
      },
    });
    child.unref();
  } catch {
    // ignore
  }
}

function buildEvalScript(body: string): string {
  return `(() => { ${body} })()`;
}

function buildAgentTypeScript(selector: string, indexValue: number, text: string, clear: boolean): string {
  const payload = { selector, index: indexValue, text, clear };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const tag = element.tagName ? element.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (payload.clear) element.value = "";
      element.value = (element.value || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    if (element.isContentEditable) {
      if (payload.clear) element.textContent = "";
      element.textContent = (element.textContent || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    return { ok: false, error: "Element is not typable" };
  `);
}

function buildAgentFocusScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch {}
    try {
      element.focus();
    } catch {}
    return { ok: true };
  `);
}

function buildAgentHoverScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    try {
      element.scrollIntoView({ block: "center", inline: "center" });
    } catch {}
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try {
      element.dispatchEvent(new MouseEvent("mouseover", opts));
      element.dispatchEvent(new MouseEvent("mouseenter", opts));
      element.dispatchEvent(new MouseEvent("mousemove", opts));
    } catch {}
    return { ok: true };
  `);
}

function normalizeMouseButton(button: unknown): "left" | "right" | "middle" {
  const raw = typeof button === "string" ? button.trim().toLowerCase() : "";
  if (raw === "right" || raw === "middle") return raw;
  return "left";
}

function buildAgentSelectScript(
  selector: string,
  indexValue: number,
  value: string | undefined,
  label: string | undefined,
  optionIndex: number | undefined
): string {
  const payload = {
    selector,
    index: indexValue,
    value: value ?? null,
    label: label ?? null,
    optionIndex: Number.isFinite(optionIndex) ? optionIndex : null,
  };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    if (!element.tagName || element.tagName.toUpperCase() !== "SELECT") {
      return { ok: false, error: "Element is not a select" };
    }
    const options = Array.from(element.options || []);
    let chosen = null;
    if (payload.value !== null) {
      chosen = options.find((option) => option.value === payload.value) || null;
    }
    if (!chosen && payload.label !== null) {
      const target = payload.label.trim();
      chosen = options.find((option) => (option.label || option.textContent || "").trim() === target) || null;
    }
    if (!chosen && payload.optionIndex !== null) {
      chosen = options[payload.optionIndex] || null;
    }
    if (!chosen) return { ok: false, error: "Option not found" };
    element.value = chosen.value;
    chosen.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      value: element.value,
      label: (chosen.label || chosen.textContent || "").trim(),
    };
  `);
}

function buildAgentPageTextScript(limit: number, pattern: string | null, flags: string): string {
  const payload = { limit, pattern, flags };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    const safeString = (value) => (typeof value === "string" ? value : "");
    const bodyText = safeString(document.body ? document.body.innerText : "");
    const inputText = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
      .map((element) => {
        if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
          return safeString(element.value);
        }
        return safeString(element.textContent);
      })
      .filter(Boolean)
      .join("\n");
    const combined = [bodyText, inputText].filter(Boolean).join("\n\n");
    const maxSize = Number.isFinite(payload.limit) ? payload.limit : ${DEFAULT_PAGE_TEXT_LIMIT};
    const text = combined.slice(0, Math.max(0, maxSize));
    let matches = [];
    if (payload.pattern) {
      try {
        const re = new RegExp(payload.pattern, payload.flags || "i");
        let match;
        while ((match = re.exec(text)) && matches.length < 50) {
          matches.push(match[0]);
          if (!re.global) break;
        }
      } catch {
        matches = [];
      }
    }
    return {
      url: location.href,
      title: document.title,
      text,
      matches,
    };
  `);
}

function buildAgentListScript(selector: string, limit: number): string {
  const payload = { selector, limit };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const maxItems = Math.min(Math.max(1, payload.limit || ${DEFAULT_LIST_LIMIT}), 200);
    const items = nodes.slice(0, maxItems).map((element) => ({
      text: (element.innerText || element.textContent || "").trim().slice(0, 200),
      tag: (element.tagName || "").toLowerCase(),
      ariaLabel: element.getAttribute ? element.getAttribute("aria-label") : null,
    }));
    return { ok: true, value: { items, count: nodes.length } };
  `);
}

function buildAgentNthValueScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const value = element.value !== undefined ? element.value : "";
    return { ok: true, value: typeof value === "string" ? value : String(value ?? "") };
  `);
}

function buildAgentNthAttributeScript(selector: string, indexValue: number, attribute: string): string {
  const payload = { selector, index: indexValue, attribute };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const value = element.getAttribute ? element.getAttribute(payload.attribute) : null;
    return { ok: true, value };
  `);
}

function buildAgentNthPropertyScript(selector: string, indexValue: number, property: string): string {
  const payload = { selector, index: indexValue, property };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    return { ok: true, value: element[payload.property] };
  `);
}

function buildAgentOuterHtmlScript(selector: string, indexValue: number): string {
  const payload = { selector, index: indexValue };
  return buildEvalScript(`
    const payload = ${JSON.stringify(payload)};
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(payload.selector));
    } catch {
      return { ok: false, error: "Invalid selector" };
    }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    return { ok: true, value: element.outerHTML };
  `);
}

function ensureEvalResult(result: any, fallback: string): any {
  if (!result || typeof result !== "object" || result.ok !== true) {
    const message = typeof result?.error === "string" ? result.error : fallback;
    throw new Error(message);
  }
  return result.value;
}

export function createAgentBackend(sessionId: string): AgentBackend {
  const session = getAgentSession(sessionId);
  const connection = getAgentConnectionInfo(session);

  const downloadsDir = (() => {
    const raw = process.env.OPENCODE_BROWSER_AGENT_DOWNLOADS_DIR?.trim();
    if (!raw) return DEFAULT_DOWNLOADS_DIR;
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  })();

  try {
    mkdirSync(downloadsDir, { recursive: true });
  } catch {
    // Defer hard failures until a download is actually attempted.
  }

  const downloads: Array<{ path: string; filename?: string; url?: string; timestamp: string }> = [];

  function resolveDownloadPath(filename?: string, urlValue?: string): string {
    let name = typeof filename === "string" ? filename.trim() : "";
    if (!name && typeof urlValue === "string") {
      try {
        const u = new URL(urlValue);
        name = basename(u.pathname) || "";
      } catch {
        // ignore
      }
    }
    if (!name) name = `download-${Date.now()}`;

    const fullPath = isAbsolute(name) ? name : join(downloadsDir, name);
    mkdirSync(dirname(fullPath), { recursive: true });
    return fullPath;
  }

  function recordDownload(entry: { path: string; filename?: string; url?: string }): void {
    downloads.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (downloads.length > 50) downloads.length = 50;
  }

  let agentSocket: net.Socket | null = null;
  let agentReqId = 0;
  const agentPending = new Map<string, PendingRequest>();

  async function connectToAgent(): Promise<net.Socket> {
    return await new Promise((resolve, reject) => {
      const socket =
        connection.type === "unix"
          ? net.createConnection(connection.path)
          : net.createConnection({ host: connection.host, port: connection.port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", (err) => reject(err));
    });
  }

  async function ensureAgentSocket(): Promise<net.Socket> {
    if (agentSocket && !agentSocket.destroyed) return agentSocket;

    try {
      agentSocket = await connectToAgent();
    } catch {
      await maybeStartAgentDaemon(connection, session);
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        try {
          agentSocket = await connectToAgent();
          break;
        } catch {}
      }
    }

    if (!agentSocket || agentSocket.destroyed) {
      const target =
        connection.type === "unix" ? connection.path : `${connection.host}:${connection.port}`;
      throw new Error(`Could not connect to agent-browser daemon at ${target}.`);
    }

    agentSocket.setNoDelay(true);
    agentSocket.on(
      "data",
      createJsonLineParser((msg) => {
        if (!msg || msg.id === undefined) return;
        const messageId = typeof msg.id === "string" ? msg.id : String(msg.id);
        const pending = agentPending.get(messageId);
        if (!pending) return;
        agentPending.delete(messageId);
        const res = msg as AgentResponse;
        if (!res.success) pending.reject(new Error(res.error || "Agent browser error"));
        else pending.resolve(res.data);
      })
    );

    agentSocket.on("close", () => {
      for (const pending of agentPending.values()) {
        pending.reject(new Error("Agent browser connection closed"));
      }
      agentPending.clear();
      agentSocket = null;
    });

    agentSocket.on("error", () => {
      agentSocket = null;
    });

    return agentSocket;
  }

  async function agentRequest(action: string, payload: Record<string, any>): Promise<any> {
    const socket = await ensureAgentSocket();
    const id = `a${++agentReqId}`;

    return await new Promise((resolve, reject) => {
      agentPending.set(id, { resolve, reject });
      writeJsonLine(socket, { id, action, ...payload });
      setTimeout(() => {
        if (!agentPending.has(id)) return;
        agentPending.delete(id);
        reject(new Error("Timed out waiting for agent-browser response"));
      }, REQUEST_TIMEOUT_MS);
    });
  }

  async function agentCommand(action: string, payload: Record<string, any>): Promise<any> {
    return await agentRequest(action, payload);
  }

  async function withTab<T>(tabId: number | undefined, action: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(tabId)) return await action();
    await agentCommand("tab_switch", { index: tabId });
    return await action();
  }

  async function moveMouse(x: number, y: number): Promise<{ x: number; y: number }> {
    const point = { x: Number(x), y: Number(y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error("Mouse coordinates must be finite numbers");
    }
    await agentCommand("mousemove", point);
    return point;
  }

  async function mouseDown(button: unknown): Promise<"left" | "right" | "middle"> {
    const normalized = normalizeMouseButton(button);
    await agentCommand("mousedown", { button: normalized });
    return normalized;
  }

  async function mouseUp(button: unknown): Promise<"left" | "right" | "middle"> {
    const normalized = normalizeMouseButton(button);
    await agentCommand("mouseup", { button: normalized });
    return normalized;
  }

  async function coordinateClick(x: number, y: number, button: unknown, clickCount: number): Promise<void> {
    const point = await moveMouse(x, y);
    const count = Math.max(1, Number.isFinite(clickCount) ? Math.floor(clickCount) : 1);
    const normalized = normalizeMouseButton(button);
    for (let i = 0; i < count; i++) {
      await mouseDown(normalized);
      await mouseUp(normalized);
    }
  }

  async function coordinateDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number
  ): Promise<{ fromX: number; fromY: number; toX: number; toY: number; steps: number }> {
    const start = await moveMouse(fromX, fromY);
    const end = { x: Number(toX), y: Number(toY) };
    if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) {
      throw new Error("Mouse coordinates must be finite numbers");
    }
    const totalSteps = Math.max(1, Number.isFinite(steps) ? Math.floor(steps) : 12);
    await mouseDown("left");
    for (let i = 1; i <= totalSteps; i++) {
      const progress = i / totalSteps;
      const x = start.x + (end.x - start.x) * progress;
      const y = start.y + (end.y - start.y) * progress;
      await moveMouse(x, y);
    }
    await mouseUp("left");
    return { fromX: start.x, fromY: start.y, toX: end.x, toY: end.y, steps: totalSteps };
  }

  async function agentEvaluate(script: string): Promise<any> {
    const data = await agentCommand("evaluate", { script });
    return data?.result;
  }

  async function waitForCount(
    selector: string,
    minimum: number,
    timeoutMs: number,
    pollMs: number
  ): Promise<number> {
    const timeout = Math.max(0, timeoutMs);
    const poll = Math.max(0, pollMs || DEFAULT_POLL_MS);
    const start = Date.now();

    while (true) {
      const data = await agentCommand("count", { selector });
      const count = Number(data?.count ?? 0);
      if (count >= minimum) return count;
      if (!timeout || Date.now() - start >= timeout) return count;
      await sleep(poll);
    }
  }

  async function agentQuery(args: Record<string, any>): Promise<{ content: string }> {
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    const mode = typeof args.mode === "string" && args.mode ? args.mode : "text";
    const indexValue = Number.isFinite(args.index) ? args.index : 0;
    const limitValue = Number.isFinite(args.limit)
      ? args.limit
      : mode === "page_text"
        ? DEFAULT_PAGE_TEXT_LIMIT
        : DEFAULT_LIST_LIMIT;
    const timeoutValue = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 0;
    const pollValue = Number.isFinite(args.pollMs) ? args.pollMs : DEFAULT_POLL_MS;
    const pattern = typeof args.pattern === "string" ? args.pattern : null;
    const flags = typeof args.flags === "string" ? args.flags : "i";

    if (mode === "page_text") {
      if (selector && timeoutValue > 0) {
        await waitForCount(selector, 1, timeoutValue, pollValue);
      }
      const pageText = await agentEvaluate(buildAgentPageTextScript(limitValue, pattern, flags));
      return { content: JSON.stringify({ ok: true, value: pageText }, null, 2) };
    }

    if (!selector) throw new Error("selector is required");

    if (mode === "exists") {
      const count = await waitForCount(selector, 1, timeoutValue, pollValue);
      return {
        content: JSON.stringify({ ok: true, value: { exists: count > 0, count } }, null, 2),
      };
    }

    const count = await waitForCount(selector, indexValue + 1, timeoutValue, pollValue);
    if (count <= indexValue) {
      throw new Error(`No matches for selector: ${selector}`);
    }

    if (mode === "text") {
      const data =
        indexValue > 0
          ? await agentCommand("nth", { selector, index: indexValue, subaction: "text" })
          : await agentCommand("innertext", { selector });
      return { content: typeof data?.text === "string" ? data.text : "" };
    }

    if (mode === "value") {
      if (indexValue > 0) {
        const result = ensureEvalResult(
          await agentEvaluate(buildAgentNthValueScript(selector, indexValue)),
          "Value lookup failed"
        );
        return { content: typeof result === "string" ? result : JSON.stringify(result) };
      }
      const data = await agentCommand("inputvalue", { selector });
      return { content: typeof data?.value === "string" ? data.value : "" };
    }

    if (mode === "attribute") {
      if (!args.attribute) throw new Error("attribute is required");
      if (indexValue > 0) {
        const result = ensureEvalResult(
          await agentEvaluate(buildAgentNthAttributeScript(selector, indexValue, args.attribute)),
          "Attribute lookup failed"
        );
        return { content: typeof result === "string" ? result : JSON.stringify(result) };
      }
      const data = await agentCommand("getattribute", { selector, attribute: args.attribute });
      return { content: typeof data?.value === "string" ? data.value : JSON.stringify(data?.value) };
    }

    if (mode === "property") {
      if (!args.property) throw new Error("property is required");
      const result = ensureEvalResult(
        await agentEvaluate(buildAgentNthPropertyScript(selector, indexValue, args.property)),
        "Property lookup failed"
      );
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    if (mode === "html") {
      const result = ensureEvalResult(
        await agentEvaluate(buildAgentOuterHtmlScript(selector, indexValue)),
        "HTML lookup failed"
      );
      return { content: typeof result === "string" ? result : JSON.stringify(result) };
    }

    if (mode === "list") {
      const listResult = ensureEvalResult(
        await agentEvaluate(buildAgentListScript(selector, limitValue)),
        "List lookup failed"
      );
      return { content: JSON.stringify({ ok: true, value: listResult }, null, 2) };
    }

    throw new Error(`Unknown mode: ${mode}`);
  }

  async function requestTool(tool: string, args: Record<string, any>): Promise<any> {
    switch (tool) {
      case "get_tabs": {
        const data = await agentCommand("tab_list", {});
        const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
        const mapped = tabs.map((tab: any) => ({
          id: tab.index,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId ?? 0,
        }));
        return { content: JSON.stringify(mapped, null, 2) };
      }
      case "list_downloads": {
        return { content: JSON.stringify({ downloads }, null, 2) };
      }
      case "open_tab": {
        const active = args.active;
        let previousActive: number | null = null;
        if (active === false) {
          const list = await agentCommand("tab_list", {});
          if (Number.isFinite(list?.active)) previousActive = list.active;
        }
        const created = await agentCommand("tab_new", {});
        if (args.url) {
          await agentCommand("navigate", { url: args.url });
        }
        if (active === false && previousActive !== null) {
          await agentCommand("tab_switch", { index: previousActive });
        }
        return { content: { tabId: created.index, url: args.url, active: active !== false } };
      }
      case "set_active_tab": {
        if (!Number.isFinite(args.tabId)) throw new Error("tabId is required");
        await agentCommand("tab_switch", { index: args.tabId });
        return { content: { tabId: args.tabId, active: true } };
      }
      case "close_tab": {
        const payload: Record<string, any> = {};
        if (Number.isFinite(args.tabId)) payload.index = args.tabId;
        const result = await agentCommand("tab_close", payload);
        const closed = Number.isFinite(result?.closed) ? result.closed : args.tabId;
        return { content: { tabId: closed, remaining: result?.remaining } };
      }
      case "navigate": {
        return await withTab(args.tabId, async () => {
          if (!args.url) throw new Error("URL is required");
          await agentCommand("navigate", { url: args.url });
          return { content: `Navigated to ${args.url}` };
        });
      }
      case "back": {
        return await withTab(args.tabId, async () => {
          await agentCommand("back", {});
          return { content: "Navigated back" };
        });
      }
      case "forward": {
        return await withTab(args.tabId, async () => {
          await agentCommand("forward", {});
          return { content: "Navigated forward" };
        });
      }
      case "reload": {
        return await withTab(args.tabId, async () => {
          await agentCommand("reload", {});
          return { content: "Reloaded tab" };
        });
      }
      case "mouse_move": {
        return await withTab(args.tabId, async () => {
          const point = await moveMouse(args.x, args.y);
          return { content: { ok: true, ...point } };
        });
      }
      case "left_click": {
        return await withTab(args.tabId, async () => {
          const count = Number.isFinite(args.clickCount) ? args.clickCount : 1;
          await coordinateClick(args.x, args.y, "left", count);
          return { content: { ok: true, x: Number(args.x), y: Number(args.y), button: "left", clickCount: Math.max(1, Math.floor(count)) } };
        });
      }
      case "right_click": {
        return await withTab(args.tabId, async () => {
          await coordinateClick(args.x, args.y, "right", 1);
          return { content: { ok: true, x: Number(args.x), y: Number(args.y), button: "right", clickCount: 1 } };
        });
      }
      case "middle_click": {
        return await withTab(args.tabId, async () => {
          await coordinateClick(args.x, args.y, "middle", 1);
          return { content: { ok: true, x: Number(args.x), y: Number(args.y), button: "middle", clickCount: 1 } };
        });
      }
      case "double_click": {
        return await withTab(args.tabId, async () => {
          await coordinateClick(args.x, args.y, "left", 2);
          return { content: { ok: true, x: Number(args.x), y: Number(args.y), button: "left", clickCount: 2 } };
        });
      }
      case "triple_click": {
        return await withTab(args.tabId, async () => {
          await coordinateClick(args.x, args.y, "left", 3);
          return { content: { ok: true, x: Number(args.x), y: Number(args.y), button: "left", clickCount: 3 } };
        });
      }
      case "mouse_down": {
        return await withTab(args.tabId, async () => {
          const point = await moveMouse(args.x, args.y);
          const button = await mouseDown(args.button);
          return { content: { ok: true, ...point, button } };
        });
      }
      case "mouse_up": {
        return await withTab(args.tabId, async () => {
          const point = await moveMouse(args.x, args.y);
          const button = await mouseUp(args.button);
          return { content: { ok: true, ...point, button } };
        });
      }
      case "left_click_drag": {
        return await withTab(args.tabId, async () => {
          const result = await coordinateDrag(args.fromX, args.fromY, args.toX, args.toY, args.steps);
          return { content: { ok: true, ...result } };
        });
      }
      case "download": {
        return await withTab(args.tabId, async () => {
          const url = typeof args.url === "string" ? args.url.trim() : "";
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          const filename = typeof args.filename === "string" ? args.filename.trim() : "";
          const waitValue = args.wait === undefined ? false : !!args.wait;
          const timeoutValue = Number.isFinite(args.downloadTimeoutMs) ? args.downloadTimeoutMs : undefined;

          if (!url && !selector) throw new Error("url or selector is required");
          if (url && selector) throw new Error("Provide either url or selector, not both");

          if (!waitValue) {
            if (selector) {
              await agentCommand("click", { selector });
              return { content: JSON.stringify({ ok: true, started: true, selector }, null, 2) };
            }
            await agentCommand("navigate", { url });
            return { content: JSON.stringify({ ok: true, started: true, url }, null, 2) };
          }

          if (selector) {
            const path = resolveDownloadPath(filename || undefined);
            const data = await agentCommand("download", { selector, path });
            const entry = {
              path: String(data?.path || path),
              filename: typeof data?.suggestedFilename === "string" ? data.suggestedFilename : undefined,
              url: url || undefined,
            };
            recordDownload({ path: entry.path, filename: entry.filename, url: entry.url });
            return { content: JSON.stringify({ ok: true, ...entry }, null, 2) };
          }

          const path = resolveDownloadPath(filename || undefined, url);
          await agentCommand("navigate", { url });
          const data = await agentCommand("waitfordownload", { path, timeout: timeoutValue });
          const entry = {
            path: String(data?.path || path),
            filename: typeof data?.filename === "string" ? data.filename : undefined,
            url: typeof data?.url === "string" ? data.url : url,
          };
          recordDownload({ path: entry.path, filename: entry.filename, url: entry.url });
          return { content: JSON.stringify({ ok: true, ...entry }, null, 2) };
        });
      }
      case "click": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (indexValue) {
            await agentCommand("nth", { selector: args.selector, index: indexValue, subaction: "click" });
          } else {
            await agentCommand("click", { selector: args.selector });
          }
          return { content: `Clicked ${args.selector}` };
        });
      }
      case "hover": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (indexValue > 0) {
            await agentCommand("nth", { selector: args.selector, index: indexValue, subaction: "hover" });
          } else if (indexValue < 0) {
            const result = await agentEvaluate(buildAgentHoverScript(args.selector, indexValue));
            if (!result?.ok) throw new Error(result?.error || "Hover failed");
          } else {
            await agentCommand("hover", { selector: args.selector });
          }
          return { content: `Hovered ${args.selector}` };
        });
      }
      case "focus": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (indexValue === 0) {
            await agentCommand("focus", { selector: args.selector });
          } else {
            const result = await agentEvaluate(buildAgentFocusScript(args.selector, indexValue));
            if (!result?.ok) throw new Error(result?.error || "Focus failed");
          }
          return { content: `Focused ${args.selector}` };
        });
      }
      case "type": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (args.text === undefined) throw new Error("Text is required");
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (!indexValue) {
            await agentCommand("type", {
              selector: args.selector,
              text: String(args.text),
              clear: args.clear,
            });
          } else {
            const result = await agentEvaluate(
              buildAgentTypeScript(args.selector, indexValue, String(args.text), !!args.clear)
            );
            if (!result?.ok) {
              throw new Error(result?.error || "Type failed");
            }
          }
          return { content: `Typed "${args.text}" into ${args.selector}` };
        });
      }
      case "key": {
        return await withTab(args.tabId, async () => {
          if (!args.key) throw new Error("key is required");
          const keyValue = String(args.key);
          const selector = typeof args.selector === "string" ? args.selector : undefined;
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          if (selector) {
            if (indexValue === 0) {
              await agentCommand("press", { key: keyValue, selector });
            } else {
              const result = await agentEvaluate(buildAgentFocusScript(selector, indexValue));
              if (!result?.ok) throw new Error(result?.error || "Focus failed");
              await agentCommand("press", { key: keyValue });
            }
          } else {
            await agentCommand("press", { key: keyValue });
          }
          return { content: `Pressed ${keyValue}` };
        });
      }
      case "key_down": {
        return await withTab(args.tabId, async () => {
          if (!args.key) throw new Error("key is required");
          await agentCommand("keydown", { key: String(args.key) });
          return { content: `Key down ${args.key}` };
        });
      }
      case "key_up": {
        return await withTab(args.tabId, async () => {
          if (!args.key) throw new Error("key is required");
          await agentCommand("keyup", { key: String(args.key) });
          return { content: `Key up ${args.key}` };
        });
      }
      case "select": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (args.value === undefined && args.label === undefined && args.optionIndex === undefined) {
            throw new Error("value, label, or optionIndex is required");
          }
          const indexValue = Number.isFinite(args.index) ? args.index : 0;
          let selectedValue = args.value;
          let selectedLabel = args.label;
          if (indexValue || args.label !== undefined || args.optionIndex !== undefined) {
            const result = await agentEvaluate(
              buildAgentSelectScript(
                args.selector,
                indexValue,
                args.value,
                args.label,
                args.optionIndex
              )
            );
            if (!result?.ok) {
              throw new Error(result?.error || "Select failed");
            }
            selectedValue = result.value;
            selectedLabel = result.label;
          } else if (args.value !== undefined) {
            await agentCommand("select", { selector: args.selector, values: args.value });
          }
          const valueText = selectedValue ? String(selectedValue) : "";
          const labelText = selectedLabel ? String(selectedLabel) : "";
          const summary =
            labelText && valueText && labelText !== valueText
              ? `${labelText} (${valueText})`
              : labelText || valueText || "option";
          return { content: `Selected ${summary} in ${args.selector}` };
        });
      }
      case "set_file_input": {
        return await withTab(args.tabId, async () => {
          if (!args.selector) throw new Error("Selector is required");
          if (!args.filePath) throw new Error("filePath is required");
          const rawPath = String(args.filePath).trim();
          if (!rawPath) throw new Error("filePath is required");
          const absPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
          const data = await agentCommand("upload", { selector: args.selector, files: absPath });
          return {
            content: JSON.stringify({ ok: true, selector: args.selector, uploaded: data?.uploaded ?? [absPath] }, null, 2),
          };
        });
      }
      case "screenshot": {
        return await withTab(args.tabId, async () => {
          const data = await agentCommand("screenshot", { format: "png" });
          const base64 = data?.base64 ? String(data.base64) : "";
          if (!base64) throw new Error("Screenshot failed");
          return { content: `data:image/png;base64,${base64}` };
        });
      }
      case "snapshot": {
        return await withTab(args.tabId, async () => {
          const data = await agentCommand("snapshot", {});
          const payload = {
            snapshot: data?.snapshot ?? "",
            refs: data?.refs ?? {},
          };
          return { content: JSON.stringify(payload, null, 2) };
        });
      }
      case "query": {
        return await withTab(args.tabId, async () => {
          return await agentQuery(args);
        });
      }
      case "scroll": {
        return await withTab(args.tabId, async () => {
          const x = Number.isFinite(args.x) ? args.x : 0;
          const y = Number.isFinite(args.y) ? args.y : 0;
          await agentCommand("scroll", {
            selector: args.selector,
            x,
            y,
          });
          const target = args.selector ? `to ${args.selector}` : `by (${x}, ${y})`;
          return { content: `Scrolled ${target}` };
        });
      }
      case "wait": {
        return await withTab(args.tabId, async () => {
          const ms = Number.isFinite(args.ms) ? args.ms : 1000;
          await agentCommand("wait", { timeout: ms });
          return { content: `Waited ${ms}ms` };
        });
      }
      default:
        throw new Error(`Unsupported tool for agent backend: ${tool}`);
    }
  }

  async function status(): Promise<any> {
    let connected = false;
    let error: string | undefined;
    try {
      await ensureAgentSocket();
      connected = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      backend: "agent-browser",
      session,
      connection,
      connected,
      error,
      agentBrowserVersion: getAgentPackageVersion(),
      capabilities: getAgentCapabilities(),
      active_session: session,
    };
  }

  return {
    mode: "agent",
    session,
    connection,
    getVersion: getAgentPackageVersion,
    status,
    requestTool,
  };
}
