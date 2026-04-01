const NATIVE_HOST_NAME = "com.opencode.browser_automation"
const KEEPALIVE_ALARM = "keepalive"
const PERMISSION_HINT = "Click the OpenCode Browser extension icon and approve requested permissions."
const OPTIONAL_RUNTIME_PERMISSIONS = ["nativeMessaging", "downloads", "debugger"]
const OPTIONAL_RUNTIME_ORIGINS = ["<all_urls>"]

const runtimeManifest = chrome.runtime.getManifest()
const declaredOptionalPermissions = new Set(runtimeManifest.optional_permissions || [])
const declaredOptionalOrigins = new Set(runtimeManifest.optional_host_permissions || [])

let port = null
let isConnected = false
let connectionAttempts = 0
let nativePermissionHintLogged = false

// Debugger state management for console/error capture
const debuggerState = new Map()
const mouseState = new Map()
const MAX_LOG_ENTRIES = 1000

async function hasPermissions(query) {
  if (!chrome.permissions?.contains) return true
  try {
    return await chrome.permissions.contains(query)
  } catch {
    return false
  }
}

async function hasNativeMessagingPermission() {
  return await hasPermissions({ permissions: ["nativeMessaging"] })
}

async function hasDebuggerPermission() {
  return await hasPermissions({ permissions: ["debugger"] })
}

async function hasDownloadsPermission() {
  return await hasPermissions({ permissions: ["downloads"] })
}

async function hasHostAccessPermission() {
  return await hasPermissions({ origins: ["<all_urls>"] })
}

async function requestOptionalPermissionsFromClick() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return { granted: true, requested: false, permissions: [], origins: [] }
  }

  const permissions = []
  for (const permission of OPTIONAL_RUNTIME_PERMISSIONS) {
    if (!declaredOptionalPermissions.has(permission)) continue
    const granted = await hasPermissions({ permissions: [permission] })
    if (!granted) permissions.push(permission)
  }

  const origins = []
  for (const origin of OPTIONAL_RUNTIME_ORIGINS) {
    if (!declaredOptionalOrigins.has(origin)) continue
    const granted = await hasPermissions({ origins: [origin] })
    if (!granted) origins.push(origin)
  }

  if (!permissions.length && !origins.length) {
    return { granted: true, requested: false, permissions, origins }
  }

  try {
    const granted = await chrome.permissions.request({ permissions, origins })
    return { granted, requested: true, permissions, origins }
  } catch (error) {
    return {
      granted: false,
      requested: true,
      permissions,
      origins,
      error: error?.message || String(error),
    }
  }
}

async function ensureDebuggerAvailable() {
  if (!chrome.debugger?.attach) {
    return {
      ok: false,
      reason: "Debugger API unavailable in this build.",
    }
  }

  const granted = await hasDebuggerPermission()
  if (!granted) {
    return {
      ok: false,
      reason: `Debugger permission not granted. ${PERMISSION_HINT}`,
    }
  }

  return { ok: true }
}

async function ensureDownloadsAvailable() {
  if (!chrome.downloads) {
    throw new Error(`Downloads API unavailable in this build. ${PERMISSION_HINT}`)
  }

  const granted = await hasDownloadsPermission()
  if (!granted) {
    throw new Error(`Downloads permission not granted. ${PERMISSION_HINT}`)
  }
}

async function ensureDebuggerAttached(tabId) {
  const availability = await ensureDebuggerAvailable()
  if (!availability.ok) {
    return {
      attached: false,
      unavailableReason: availability.reason,
      consoleMessages: [],
      pageErrors: [],
    }
  }

  if (debuggerState.has(tabId)) return debuggerState.get(tabId)

  const state = {
    attached: false,
    consoleMessages: [],
    pageErrors: [],
    networkRequests: [],
    requestsById: {},
    pendingDialog: null,
  }
  debuggerState.set(tabId, state)

  try {
    await chrome.debugger.attach({ tabId }, "1.3")
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
    await chrome.debugger.sendCommand({ tabId }, "Page.enable")
    await chrome.debugger.sendCommand({ tabId }, "Network.enable")
    state.attached = true
  } catch (e) {
    console.warn("[OpenCode] Failed to attach debugger:", e.message || e)
  }

  return state
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const state = debuggerState.get(source.tabId)
    if (!state) return

    if (method === "Runtime.consoleAPICalled") {
      if (state.consoleMessages.length >= MAX_LOG_ENTRIES) {
        state.consoleMessages.shift()
      }
      state.consoleMessages.push({
        type: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        timestamp: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      })
    }

    if (method === "Runtime.exceptionThrown") {
      if (state.pageErrors.length >= MAX_LOG_ENTRIES) {
        state.pageErrors.shift()
      }
      state.pageErrors.push({
        message: params.exceptionDetails.text,
        source: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        stack: params.exceptionDetails.exception?.description,
        timestamp: Date.now(),
      })
    }

    if (method === "Page.javascriptDialogOpening") {
      state.pendingDialog = {
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        url: params.url,
        timestamp: Date.now(),
      }
    }

    if (method === "Page.javascriptDialogClosed") {
      state.pendingDialog = null
    }

    if (method === "Network.requestWillBeSent") {
      const request = {
        id: params.requestId,
        url: params.request?.url,
        method: params.request?.method,
        type: params.type,
        status: null,
        timestamp: Date.now(),
      }
      state.requestsById[params.requestId] = request
      if (state.networkRequests.length >= MAX_LOG_ENTRIES) {
        const removed = state.networkRequests.shift()
        if (removed?.id) delete state.requestsById[removed.id]
      }
      state.networkRequests.push(request)
    }

    if (method === "Network.responseReceived") {
      const request = state.requestsById[params.requestId]
      if (request) {
        request.status = params.response?.status ?? null
        request.mimeType = params.response?.mimeType
      }
    }

    if (method === "Network.loadingFailed") {
      const request = state.requestsById[params.requestId]
      if (request) {
        request.failed = true
        request.errorText = params.errorText
      }
    }
  })
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (debuggerState.has(source.tabId)) {
      const state = debuggerState.get(source.tabId)
      state.attached = false
    }
  })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  mouseState.delete(tabId)
  if (debuggerState.has(tabId)) {
    if (chrome.debugger?.detach) chrome.debugger.detach({ tabId }).catch(() => {})
    debuggerState.delete(tabId)
  }
})

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) connect().catch(() => {})
  }
})

async function connect() {
  if (port) {
    try {
      port.disconnect()
    } catch {}
    port = null
  }

  const nativeMessagingAllowed = await hasNativeMessagingPermission()
  if (!nativeMessagingAllowed) {
    isConnected = false
    updateBadge(false)
    if (!nativePermissionHintLogged) {
      nativePermissionHintLogged = true
      console.log(`[OpenCode] Native messaging permission not granted. ${PERMISSION_HINT}`)
    }
    return
  }

  nativePermissionHintLogged = false

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[OpenCode] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[OpenCode] Native host not available. Run: npx github:Arjun-Ingole/opencode-browser install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[OpenCode] Still waiting for native host...")
        }
      }
    })

    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[OpenCode] connectNative failed:", e)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    set_active_tab: toolSetActiveTab,
    close_tab: toolCloseTab,
    get_url: toolGetUrl,
    get_title: toolGetTitle,
    list_frames: toolListFrames,
    navigate: toolNavigate,
    back: toolBack,
    forward: toolForward,
    reload: toolReload,
    mouse_move: toolMouseMove,
    left_click: toolLeftClick,
    right_click: toolRightClick,
    middle_click: toolMiddleClick,
    double_click: toolDoubleClick,
    triple_click: toolTripleClick,
    mouse_down: toolMouseDown,
    mouse_up: toolMouseUp,
    left_click_drag: toolLeftClickDrag,
    click: toolClick,
    hover: toolHover,
    focus: toolFocus,
    type: toolType,
    key: toolKey,
    key_down: toolKeyDown,
    key_up: toolKeyUp,
    select: toolSelect,
    get_box: toolGetBox,
    get_viewport: toolGetViewport,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    wait_for_url: toolWaitForUrl,
    wait_for_load_state: toolWaitForLoadState,
    download: toolDownload,
    list_downloads: toolListDownloads,
    set_file_input: toolSetFileInput,
    highlight: toolHighlight,
    console: toolConsole,
    errors: toolErrors,
    network_requests: toolNetworkRequests,
    dialog_accept: toolDialogAccept,
    dialog_dismiss: toolDialogDismiss,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function waitForTabStatusComplete(tabId, timeoutMs = 10000) {
  return await new Promise((resolve) => {
    let done = false

    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      if (timer) clearTimeout(timer)
      resolve()
    }

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        finish()
      }
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          finish()
        }, timeoutMs)
      : null

    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") finish()
    }).catch(() => {
      finish()
    })
  })
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function urlPatternToRegExp(pattern) {
  const escaped = escapeRegExp(pattern).replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

function matchesUrlPattern(url, pattern) {
  if (!pattern) return false
  try {
    return urlPatternToRegExp(pattern).test(String(url || ""))
  } catch {
    return false
  }
}

async function waitForUrlPattern(tabId, pattern, timeoutMs = 10000, pollMs = 200) {
  const timeout = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 10000)
  const poll = Math.max(50, Number.isFinite(pollMs) ? pollMs : 200)
  const start = Date.now()

  while (true) {
    const tab = await chrome.tabs.get(tabId)
    if (matchesUrlPattern(tab?.url, pattern)) return tab
    if (timeout && Date.now() - start >= timeout) {
      throw new Error(`Timed out waiting for URL matching ${pattern}`)
    }
    await sleep(poll)
  }
}

async function waitForDocumentReadyState(tabId, desiredState, timeoutMs = 10000, pollMs = 200) {
  if (desiredState === "networkidle") {
    throw new Error("networkidle is not supported on the native backend")
  }

  const timeout = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 10000)
  const poll = Math.max(50, Number.isFinite(pollMs) ? pollMs : 200)
  const start = Date.now()

  while (true) {
    const result = await runInPage(tabId, "load_state", {})
    const state = String(result?.value || "")
    const ready =
      desiredState === "domcontentloaded"
        ? state === "interactive" || state === "complete"
        : state === "complete"
    if (ready) return state
    if (timeout && Date.now() - start >= timeout) {
      throw new Error(`Timed out waiting for load state ${desiredState}`)
    }
    await sleep(poll)
  }
}

function keyTokenDescriptor(token, modifiers) {
  const raw = String(token || "").trim()
  if (!raw) throw new Error("key is required")

  const specials = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    space: { key: " ", code: "Space", keyCode: 32, text: " " },
    " ": { key: " ", code: "Space", keyCode: 32, text: " " },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  }

  const special = specials[raw.toLowerCase()]
  if (special) {
    if (modifiers) return { ...special, text: undefined }
    return special
  }

  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase()
    const useUpper = !!(modifiers & 8)
    const key = useUpper ? upper : upper.toLowerCase()
    return {
      key,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: modifiers && modifiers !== 8 ? undefined : key,
    }
  }

  if (/^[0-9]$/.test(raw)) {
    return {
      key: raw,
      code: `Digit${raw}`,
      keyCode: raw.charCodeAt(0),
      text: modifiers ? undefined : raw,
    }
  }

  if (raw.length === 1) {
    const keyCode = raw.toUpperCase().charCodeAt(0)
    return {
      key: raw,
      code: raw,
      keyCode,
      text: modifiers ? undefined : raw,
    }
  }

  return {
    key: raw,
    code: raw,
    keyCode: raw.toUpperCase().charCodeAt(0) || 0,
    text: undefined,
  }
}

function parseKeyChord(rawKey) {
  const text = String(rawKey || "").trim()
  if (!text) throw new Error("key is required")
  const parts = text.split("+").map((part) => part.trim()).filter(Boolean)
  if (!parts.length) throw new Error("key is required")

  let modifiers = 0
  let keyToken = parts[parts.length - 1]

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i].toLowerCase()
    if (part === "alt" || part === "option") modifiers |= 1
    else if (part === "ctrl" || part === "control") modifiers |= 2
    else if (part === "meta" || part === "cmd" || part === "command") modifiers |= 4
    else if (part === "shift") modifiers |= 8
    else keyToken = parts.slice(i).join("+")
  }

  const descriptor = keyTokenDescriptor(keyToken, modifiers)
  return { ...descriptor, modifiers }
}

async function dispatchDebuggerKey(tabId, rawKey) {
  const state = await ensureDebuggerAttached(tabId)
  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger is not available for keyboard input.")
  }

  const descriptor = parseKeyChord(rawKey)
  const basePayload = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers: descriptor.modifiers,
  }

  if (descriptor.text) {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: descriptor.text,
      unmodifiedText: descriptor.text,
      ...basePayload,
    })
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      text: descriptor.text,
      unmodifiedText: descriptor.text,
      ...basePayload,
    })
  } else {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...basePayload,
    })
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...basePayload,
  })
}

function normalizeMouseButton(button) {
  const raw = String(button || "left").trim().toLowerCase()
  if (raw === "right" || raw === "middle" || raw === "left") return raw
  return "left"
}

function mouseButtonMask(button) {
  if (button === "left") return 1
  if (button === "right") return 2
  if (button === "middle") return 4
  return 0
}

function clampMouseCoordinate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error("Mouse coordinates must be finite numbers")
  return Math.max(0, n)
}

function getMouseState(tabId) {
  return mouseState.get(tabId) || { x: 0, y: 0, buttons: 0, button: "left" }
}

async function dispatchDebuggerMouseEvent(tabId, type, options = {}) {
  const state = await ensureDebuggerAttached(tabId)
  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger is not available for mouse input.")
  }

  const prev = getMouseState(tabId)
  const x = options.x === undefined ? prev.x : clampMouseCoordinate(options.x)
  const y = options.y === undefined ? prev.y : clampMouseCoordinate(options.y)
  const button = normalizeMouseButton(options.button || prev.button || "left")
  let buttons = prev.buttons

  if (type === "mousePressed") {
    buttons = mouseButtonMask(button)
  } else if (type === "mouseReleased") {
    buttons = 0
  } else if (options.buttons !== undefined) {
    buttons = Number.isFinite(options.buttons) ? Number(options.buttons) : prev.buttons
  }

  const payload = {
    type,
    x,
    y,
    button: type === "mouseMoved" ? (buttons ? button : "none") : button,
    buttons,
    clickCount: Number.isFinite(options.clickCount) ? Number(options.clickCount) : 0,
  }

  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", payload)

  mouseState.set(tabId, {
    x,
    y,
    buttons,
    button,
  })

  return { x, y, button, buttons }
}

async function dispatchCoordinateClick(tabId, x, y, button, clickCount = 1) {
  const count = Math.max(1, Number.isFinite(clickCount) ? Number(clickCount) : 1)
  await dispatchDebuggerMouseEvent(tabId, "mouseMoved", { x, y })
  for (let i = 1; i <= count; i++) {
    await dispatchDebuggerMouseEvent(tabId, "mousePressed", { x, y, button, clickCount: i })
    await dispatchDebuggerMouseEvent(tabId, "mouseReleased", { x, y, button, clickCount: i })
  }
  return { x: clampMouseCoordinate(x), y: clampMouseCoordinate(y), button: normalizeMouseButton(button), clickCount: count }
}

async function dispatchCoordinateDrag(tabId, fromX, fromY, toX, toY, steps = 12) {
  const startX = clampMouseCoordinate(fromX)
  const startY = clampMouseCoordinate(fromY)
  const endX = clampMouseCoordinate(toX)
  const endY = clampMouseCoordinate(toY)
  const totalSteps = Math.max(1, Number.isFinite(steps) ? Math.floor(steps) : 12)

  await dispatchDebuggerMouseEvent(tabId, "mouseMoved", { x: startX, y: startY })
  await dispatchDebuggerMouseEvent(tabId, "mousePressed", { x: startX, y: startY, button: "left", clickCount: 1 })
  for (let i = 1; i <= totalSteps; i++) {
    const progress = i / totalSteps
    const x = startX + (endX - startX) * progress
    const y = startY + (endY - startY) * progress
    await dispatchDebuggerMouseEvent(tabId, "mouseMoved", { x, y, button: "left", buttons: mouseButtonMask("left") })
  }
  await dispatchDebuggerMouseEvent(tabId, "mouseReleased", { x: endX, y: endY, button: "left", clickCount: 1 })
  return { fromX: startX, fromY: startY, toX: endX, toY: endY, steps: totalSteps }
}

async function runInPage(tabId, command, args) {
  const hasHostAccess = await hasHostAccessPermission()
  if (!hasHostAccess) {
    throw new Error(`Site access permission not granted. ${PERMISSION_HINT}`)
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOps,
      args: [command, args || {}],
      world: "ISOLATED",
    })
    return result[0]?.result
  } catch (error) {
    const message = error?.message || String(error)
    if (message.includes("Cannot access contents of the page")) {
      throw new Error(`Site access permission not granted for this page. ${PERMISSION_HINT}`)
    }
    throw error
  }
}

async function pageOps(command, args) {
  const options = args || {}
  const MAX_DEPTH = 6
  const DEFAULT_TIMEOUT_MS = 2000

  function safeString(value) {
    return typeof value === "string" ? value : ""
  }

  function normalizeSelectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.map((s) => safeString(s).trim()).filter(Boolean)
    }
    if (typeof selector !== "string") return []
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length ? parts : [selector.trim()].filter(Boolean)
  }

  function stripQuotes(value) {
    return safeString(value).replace(/^['"]|['"]$/g, "")
  }

  function normalizeText(value) {
    return safeString(value).replace(/\s+/g, " ").trim().toLowerCase()
  }

  function matchesText(value, target) {
    if (!target) return false
    const normTarget = normalizeText(target)
    if (!normTarget) return false
    const normValue = normalizeText(value)
    return normValue === normTarget || normValue.includes(normTarget)
  }

  function normalizeLocatorKey(key) {
    if (key === "css") return "css"
    if (key === "label" || key === "field") return "label"
    if (key === "aria" || key === "aria-label") return "aria"
    if (key === "placeholder") return "placeholder"
    if (key === "name") return "name"
    if (key === "role") return "role"
    if (key === "text") return "text"
    if (key === "id") return "id"
    return null
  }

  function parseLocator(raw) {
    const trimmed = safeString(raw).trim()
    if (!trimmed) return { kind: "css", value: "", raw: "" }
    const match = trimmed.match(/^([a-zA-Z_-]+)\s*(=|:)\s*(.+)$/)
    if (match) {
      const key = match[1].toLowerCase()
      const kind = normalizeLocatorKey(key)
      if (kind) {
        return { kind, value: stripQuotes(match[3]), raw: trimmed }
      }
    }
    return { kind: "css", value: trimmed, raw: trimmed }
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > MAX_DEPTH) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function getAriaLabelledByText(el) {
    const ids = safeString(el?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean)
    if (!ids.length) return ""
    const parts = []
    for (const id of ids) {
      const ref = document.getElementById(id)
      if (ref) parts.push(ref.innerText || ref.textContent || "")
    }
    return parts.join(" ")
  }

  function findByAttribute(attr, target, allowedTags) {
    if (!target) return []
    const nodes = deepQuerySelectorAll(`[${attr}]`, document)
    return nodes.filter((el) => {
      if (Array.isArray(allowedTags) && allowedTags.length && !allowedTags.includes(el.tagName)) return false
      return matchesText(el.getAttribute(attr), target)
    })
  }

  function findByLabelText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const labels = deepQuerySelectorAll("label", document)
    for (const label of labels) {
      if (!matchesText(label.innerText || label.textContent || "", target)) continue
      const control = label.control || label.querySelector("input, textarea, select")
      if (control && !seen.has(control)) {
        seen.add(control)
        results.push(control)
      }
    }
    const labelled = deepQuerySelectorAll("[aria-labelledby]", document)
    for (const el of labelled) {
      if (!matchesText(getAriaLabelledByText(el), target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function findByRole(target) {
    if (!target) return []
    const nodes = deepQuerySelectorAll("[role]", document)
    return nodes.filter((el) => matchesText(el.getAttribute("role"), target))
  }

  function findByName(target) {
    return findByAttribute("name", target)
  }

  function findByText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const candidates = deepQuerySelectorAll(
      "button, a, label, option, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='listitem'], [role='row'], [tabindex]",
      document
    )
    for (const el of candidates) {
      if (!matchesText(el.innerText || el.textContent || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }

    const generic = deepQuerySelectorAll("div, span, li, article", document)
    for (const el of generic) {
      if (!matchesText(el.innerText || el.textContent || "", target)) continue
      const style = window.getComputedStyle(el)
      const likelyInteractive =
        !!el.getAttribute("onclick") ||
        !!el.getAttribute("role") ||
        el.tabIndex >= 0 ||
        style.cursor === "pointer"
      if (!likelyInteractive) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }

    const inputs = deepQuerySelectorAll("input[type='button'], input[type='submit'], input[type='reset']", document)
    for (const el of inputs) {
      if (!matchesText(el.value || "", target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function resolveLocator(locator) {
    if (locator.kind === "css") {
      const value = safeString(locator.value)
      if (!value) return []
      return deepQuerySelectorAll(value, document)
    }

    if (locator.kind === "label") return findByLabelText(locator.value)
    if (locator.kind === "aria") return findByAttribute("aria-label", locator.value)
    if (locator.kind === "placeholder") return findByAttribute("placeholder", locator.value, ["INPUT", "TEXTAREA"])
    if (locator.kind === "name") return findByName(locator.value)
    if (locator.kind === "role") return findByRole(locator.value)
    if (locator.kind === "text") return findByText(locator.value)

    if (locator.kind === "id") {
      const idValue = safeString(locator.value).trim()
      if (!idValue) return []
      const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(idValue) : idValue.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      return deepQuerySelectorAll(`#${escaped}`, document)
    }

    return []
  }

  function resolveMatchesOnce(selectors, index) {
    for (const sel of selectors) {
      const locator = parseLocator(sel)
      if (!locator.value) continue
      const matches = resolveLocator(locator)
      if (!matches.length) continue
      const visible = matches.filter(isVisible)
      const chosen = visible[index] || matches[index] || null
      return { selectorUsed: locator.raw, matches, chosen }
    }
    return { selectorUsed: selectors[0] || "", matches: [], chosen: null }
  }

  async function resolveMatches(selectors, index, timeoutMs, pollMs) {
    let match = resolveMatchesOnce(selectors, index)
    if (timeoutMs > 0) {
      const start = Date.now()
      while (!match.matches.length && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollMs))
        match = resolveMatchesOnce(selectors, index)
      }
    }
    return match
  }

  function clickElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
      el.dispatchEvent(new MouseEvent("click", opts))
    } catch {}

    try {
      el.click()
    } catch {}
  }

  function setNativeValue(el, value) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (setter) setter.call(el, value)
      else el.value = value
      return true
    }
    return false
  }

  function setSelectValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  function getInputValues() {
    const out = []
    const nodes = document.querySelectorAll("input, textarea")
    nodes.forEach((el) => {
      try {
        const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
        const value = el.value
        if (value != null && String(value).trim()) out.push(`${name}: ${value}`)
      } catch {}
    })
    return out.join("\n")
  }

  function getPseudoText() {
    const out = []
    const elements = Array.from(document.querySelectorAll("*"))
    for (let i = 0; i < elements.length && out.length < 2000; i++) {
      const el = elements[i]
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
        const before = window.getComputedStyle(el, "::before").content
        const after = window.getComputedStyle(el, "::after").content
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }
        pushContent(before)
        pushContent(after)
      } catch {}
    }
    return out.join("\n")
  }

  function buildMatches(text, pattern, flags) {
    if (!pattern) return []
    try {
      const re = new RegExp(pattern, flags || "")
      const found = []
      let m
      while ((m = re.exec(text)) && found.length < 50) {
        found.push(m[0])
        if (!re.global) break
      }
      return found
    } catch {
      return []
    }
  }

  function getPageText(limit, pattern, flags) {
    const parts = []
    const bodyText = safeString(document.body?.innerText || "")
    if (bodyText.trim()) parts.push(bodyText)
    const inputValues = getInputValues()
    if (inputValues) parts.push(inputValues)
    const pseudo = getPseudoText()
    if (pseudo) parts.push(pseudo)
    const text = parts.filter(Boolean).join("\n\n").slice(0, Math.max(0, limit))
    return {
      url: location.href,
      title: document.title,
      text,
      matches: buildMatches(text, pattern, flags),
    }
  }

  function getViewportMetadata() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      url: location.href,
      title: document.title,
    }
  }

  function getElementBox(el) {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    }
  }

  function getElementLabel(el) {
    const ariaLabel = safeString(el.getAttribute?.("aria-label"))
    if (ariaLabel) return ariaLabel
    const text = safeString(el.innerText || el.textContent).replace(/\s+/g, " ").trim()
    if (text) return text.slice(0, 200)
    const title = safeString(el.getAttribute?.("title"))
    if (title) return title
    const placeholder = safeString(el.getAttribute?.("placeholder"))
    if (placeholder) return placeholder
    return ""
  }

  function getElementRole(el) {
    return safeString(el.getAttribute?.("role")) || safeString(el.tagName).toLowerCase()
  }

  function isInteractiveElement(el) {
    const tag = safeString(el.tagName).toUpperCase()
    if (["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION", "SUMMARY"].includes(tag)) return true
    if (el.isContentEditable) return true
    if (safeString(el.getAttribute?.("onclick"))) return true
    if (safeString(el.getAttribute?.("role"))) return true
    if (Number(el.tabIndex) >= 0) return true
    try {
      return window.getComputedStyle(el).cursor === "pointer"
    } catch {
      return false
    }
  }

  function buildInteractiveItems(limit) {
    const maxItems = Math.min(Math.max(1, limit || 50), 200)
    const matches = deepQuerySelectorAll("*", document).filter((el) => isVisible(el) && isInteractiveElement(el))
    const nodes = matches.slice(0, maxItems)
    const items = nodes.map((el) => ({
      tag: safeString(el.tagName).toLowerCase(),
      role: getElementRole(el),
      label: getElementLabel(el),
      selector: el.id ? `#${el.id}` : undefined,
      ...getElementBox(el),
    }))
    return { items, count: matches.length }
  }

  const mode = typeof options.mode === "string" && options.mode ? options.mode : "text"
  const selectors = normalizeSelectorList(options.selector)
  const index = Number.isFinite(options.index) ? options.index : 0
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 200
  const limit = Number.isFinite(options.limit) ? options.limit : mode === "page_text" ? 20000 : 50
  const pattern = typeof options.pattern === "string" ? options.pattern : null
  const flags = typeof options.flags === "string" ? options.flags : "i"

  if (command === "click") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    clickElement(match.chosen)
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "hover") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = match.chosen.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      match.chosen.dispatchEvent(new MouseEvent("mouseover", opts))
      match.chosen.dispatchEvent(new MouseEvent("mouseenter", opts))
      match.chosen.dispatchEvent(new MouseEvent("mousemove", opts))
    } catch {}

    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "focus") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {
      return { ok: false, error: `Failed to focus: ${match.selectorUsed}` }
    }

    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "type") {
    const text = options.text
    const shouldClear = !!options.clear
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

    if (isTextInput) {
      if (shouldClear) setNativeValue(match.chosen, "")
      setNativeValue(match.chosen, (match.chosen.value || "") + text)
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    if (match.chosen.isContentEditable) {
      if (shouldClear) match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = (match.chosen.textContent || "") + text
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    return { ok: false, error: `Element is not typable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "history_back") {
    history.back()
    return { ok: true }
  }

  if (command === "history_forward") {
    history.forward()
    return { ok: true }
  }

  if (command === "select") {
    const value = typeof options.value === "string" ? options.value : null
    const label = typeof options.label === "string" ? options.label : null
    const optionIndex = Number.isFinite(options.optionIndex) ? options.optionIndex : null
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "SELECT") {
      return { ok: false, error: `Element is not a select: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    if (value === null && label === null && optionIndex === null) {
      return { ok: false, error: "value, label, or optionIndex is required" }
    }

    const selectEl = match.chosen
    const optionList = Array.from(selectEl.options || [])
    let option = null

    if (value !== null) {
      option = optionList.find((opt) => opt.value === value)
    }

    if (!option && label !== null) {
      const target = label.trim()
      option = optionList.find((opt) => (opt.label || opt.textContent || "").trim() === target)
    }

    if (!option && optionIndex !== null) {
      option = optionList[optionIndex]
    }

    if (!option) {
      return { ok: false, error: "Option not found" }
    }

    try {
      selectEl.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      selectEl.focus()
    } catch {}

    setSelectValue(selectEl, option.value)
    option.selected = true
    selectEl.dispatchEvent(new Event("input", { bubbles: true }))
    selectEl.dispatchEvent(new Event("change", { bubbles: true }))

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: selectEl.value,
      label: (option.label || option.textContent || "").trim(),
    }
  }

  if (command === "set_file_input") {
    const rawFiles = Array.isArray(options.files) ? options.files : options.files ? [options.files] : []
    if (!rawFiles.length) return { ok: false, error: "files is required" }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "INPUT" || match.chosen.type !== "file") {
      return { ok: false, error: `Element is not a file input: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    function decodeBase64(value) {
      const raw = safeString(value)
      const b64 = raw.includes(",") ? raw.split(",").pop() : raw
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    const dt = new DataTransfer()
    const names = []

    for (const fileInfo of rawFiles) {
      const name = safeString(fileInfo?.name) || "upload.bin"
      const mimeType = safeString(fileInfo?.mimeType) || "application/octet-stream"
      const base64 = safeString(fileInfo?.base64)
      if (!base64) return { ok: false, error: "file.base64 is required" }
      const bytes = decodeBase64(base64)
      const file = new File([bytes], name, { type: mimeType, lastModified: Date.now() })
      dt.items.add(file)
      names.push(name)
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    try {
      match.chosen.files = dt.files
    } catch {
      try {
        Object.defineProperty(match.chosen, "files", { value: dt.files, writable: false })
      } catch {
        return { ok: false, error: "Failed to set file input" }
      }
    }

    match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
    match.chosen.dispatchEvent(new Event("change", { bubbles: true }))

    return { ok: true, selectorUsed: match.selectorUsed, count: dt.files.length, names }
  }

  if (command === "scroll") {
    const scrollX = Number.isFinite(options.x) ? options.x : 0
    const scrollY = Number.isFinite(options.y) ? options.y : 0
    if (selectors.length) {
      const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      if (scrollX || scrollY) {
        try {
          if (typeof match.chosen.scrollBy === "function") {
            match.chosen.scrollBy({ left: scrollX, top: scrollY, behavior: "smooth" })
          } else {
            match.chosen.scrollLeft = Number(match.chosen.scrollLeft || 0) + scrollX
            match.chosen.scrollTop = Number(match.chosen.scrollTop || 0) + scrollY
          }
        } catch {
          match.chosen.scrollLeft = Number(match.chosen.scrollLeft || 0) + scrollX
          match.chosen.scrollTop = Number(match.chosen.scrollTop || 0) + scrollY
        }
        return { ok: true, selectorUsed: match.selectorUsed, elementScroll: { x: scrollX, y: scrollY } }
      }

      try {
        match.chosen.scrollIntoView({ behavior: "smooth", block: "center" })
      } catch {}
      return { ok: true, selectorUsed: match.selectorUsed }
    }
    window.scrollBy(scrollX, scrollY)
    return { ok: true }
  }

  if (command === "viewport") {
    return { ok: true, value: getViewportMetadata() }
  }

  if (command === "load_state") {
    return { ok: true, value: document.readyState }
  }

  if (command === "frames") {
    const items = [{ index: 0, name: "main", url: location.href, sameOrigin: true }]
    const elements = Array.from(document.querySelectorAll("iframe, frame"))
    elements.forEach((frame, idx) => {
      let sameOrigin = false
      let url = safeString(frame.getAttribute("src"))
      try {
        const frameLocation = frame.contentWindow?.location?.href
        if (frameLocation) {
          sameOrigin = true
          url = frameLocation
        }
      } catch {}
      items.push({
        index: idx + 1,
        name: safeString(frame.getAttribute("name")) || safeString(frame.id) || `frame-${idx + 1}`,
        url,
        sameOrigin,
      })
    })
    return { ok: true, value: items }
  }

  if (command === "highlight") {
    const duration = Number.isFinite(options.duration) ? options.duration : 3000
    const color = typeof options.color === "string" ? options.color : "#ff0000"
    const showInfo = !!options.showInfo

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const el = match.chosen
    const rect = el.getBoundingClientRect()

    // Remove any existing highlight overlay
    const existing = document.getElementById("__opc_highlight_overlay")
    if (existing) existing.remove()

    // Create overlay
    const overlay = document.createElement("div")
    overlay.id = "__opc_highlight_overlay"
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid ${color};
      box-shadow: 0 0 10px ${color};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 0.3s;
    `

    if (showInfo) {
      const info = document.createElement("div")
      info.style.cssText = `
        position: absolute;
        top: -25px;
        left: 0;
        background: ${color};
        color: white;
        padding: 2px 8px;
        font-size: 12px;
        font-family: monospace;
        border-radius: 3px;
        white-space: nowrap;
      `
      info.textContent = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
      overlay.appendChild(info)
    }

    document.body.appendChild(overlay)

    setTimeout(() => {
      overlay.style.opacity = "0"
      setTimeout(() => overlay.remove(), 300)
    }, duration)

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      highlighted: true,
      tag: el.tagName,
      id: el.id || null,
    }
  }

  if (command === "query") {
    if (mode === "page_text") {
      if (selectors.length && timeoutMs > 0) {
        await resolveMatches(selectors, index, timeoutMs, pollMs)
      }
      return { ok: true, value: getPageText(limit, pattern, flags) }
    }

    if (mode === "interactives") {
      return { ok: true, value: buildInteractiveItems(limit) }
    }

    if (!selectors.length) {
      return { ok: false, error: "Selector is required" }
    }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)

    if (mode === "exists") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { exists: match.matches.length > 0, count: match.matches.length },
      }
    }

    if (!match.chosen) {
      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    }

    if (mode === "text") {
      const text = (match.chosen.innerText || match.chosen.textContent || "").trim()
      return { ok: true, selectorUsed: match.selectorUsed, value: text }
    }

    if (mode === "value") {
      const value = match.chosen.value
      return { ok: true, selectorUsed: match.selectorUsed, value: typeof value === "string" ? value : String(value ?? "") }
    }

    if (mode === "attribute") {
      const value = options.attribute ? match.chosen.getAttribute(options.attribute) : null
      return { ok: true, selectorUsed: match.selectorUsed, value }
    }

    if (mode === "property") {
      if (!options.property) return { ok: false, error: "property is required" }
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen[options.property] }
    }

    if (mode === "html") {
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen.outerHTML }
    }

    if (mode === "bounding_box") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: getElementBox(match.chosen),
      }
    }

    if (mode === "list") {
      const maxItems = Math.min(Math.max(1, limit), 200)
      const items = match.matches.slice(0, maxItems).map((el) => ({
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        tag: (el.tagName || "").toLowerCase(),
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { items, count: match.matches.length },
      }
    }

    return { ok: false, error: `Unknown mode: ${mode}` }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId } }
}

async function toolOpenTab({ url, active = true }) {
  const createOptions = {}
  if (typeof url === "string" && url.trim()) createOptions.url = url.trim()
  if (typeof active === "boolean") createOptions.active = active

  const tab = await chrome.tabs.create(createOptions)
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active } }
}

async function toolSetActiveTab({ tabId }) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  const tab = await chrome.tabs.get(tabId)
  await chrome.tabs.update(tab.id, { active: true })
  if (Number.isFinite(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  return { tabId: tab.id, content: { tabId: tab.id, active: true, windowId: tab.windowId } }
}

async function toolCloseTab({ tabId }) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  await chrome.tabs.remove(tabId)
  return { tabId, content: { tabId, closed: true } }
}

async function toolGetUrl({ tabId }) {
  const tab = await getTabById(tabId)
  return { tabId: tab.id, content: tab.url || "" }
}

async function toolGetTitle({ tabId }) {
  const tab = await getTabById(tabId)
  return { tabId: tab.id, content: tab.title || "" }
}

async function toolListFrames({ tabId }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "frames", {})
  if (!result?.ok) throw new Error(result?.error || "Frame listing failed")
  return { tabId: tab.id, content: JSON.stringify(result.value || [], null, 2) }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })

  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolBack({ tabId }) {
  const tab = await getTabById(tabId)
  if (typeof chrome.tabs.goBack === "function") {
    await chrome.tabs.goBack(tab.id)
  } else {
    await runInPage(tab.id, "history_back", {})
  }
  await waitForTabStatusComplete(tab.id, 3000)
  return { tabId: tab.id, content: "Navigated back" }
}

async function toolForward({ tabId }) {
  const tab = await getTabById(tabId)
  if (typeof chrome.tabs.goForward === "function") {
    await chrome.tabs.goForward(tab.id)
  } else {
    await runInPage(tab.id, "history_forward", {})
  }
  await waitForTabStatusComplete(tab.id, 3000)
  return { tabId: tab.id, content: "Navigated forward" }
}

async function toolReload({ tabId }) {
  const tab = await getTabById(tabId)
  await chrome.tabs.reload(tab.id)
  await waitForTabStatusComplete(tab.id, 10000)
  return { tabId: tab.id, content: "Reloaded tab" }
}

async function toolMouseMove({ x, y, tabId }) {
  const tab = await getTabById(tabId)
  const point = await dispatchDebuggerMouseEvent(tab.id, "mouseMoved", { x, y })
  return { tabId: tab.id, content: { ok: true, ...point } }
}

async function toolLeftClick({ x, y, clickCount = 1, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateClick(tab.id, x, y, "left", clickCount)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolRightClick({ x, y, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateClick(tab.id, x, y, "right", 1)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolMiddleClick({ x, y, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateClick(tab.id, x, y, "middle", 1)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolDoubleClick({ x, y, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateClick(tab.id, x, y, "left", 2)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolTripleClick({ x, y, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateClick(tab.id, x, y, "left", 3)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolMouseDown({ x, y, button = "left", tabId }) {
  const tab = await getTabById(tabId)
  const point = await dispatchDebuggerMouseEvent(tab.id, "mouseMoved", { x, y })
  const result = await dispatchDebuggerMouseEvent(tab.id, "mousePressed", {
    x: point.x,
    y: point.y,
    button,
    clickCount: 1,
  })
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolMouseUp({ x, y, button = "left", tabId }) {
  const tab = await getTabById(tabId)
  const point = await dispatchDebuggerMouseEvent(tab.id, "mouseMoved", { x, y })
  const result = await dispatchDebuggerMouseEvent(tab.id, "mouseReleased", {
    x: point.x,
    y: point.y,
    button,
    clickCount: 1,
  })
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolLeftClickDrag({ fromX, fromY, toX, toY, steps = 12, tabId }) {
  const tab = await getTabById(tabId)
  const result = await dispatchCoordinateDrag(tab.id, fromX, fromY, toX, toY, steps)
  return { tabId: tab.id, content: { ok: true, ...result } }
}

async function toolClick({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Click failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Clicked ${used}` }
}

async function toolHover({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "hover", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Hover failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Hovered ${used}` }
}

async function toolFocus({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "focus", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Focus failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Focused ${used}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "type", { selector, text, clear, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Type failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Typed "${text}" into ${used}` }
}

async function toolKey({ key, selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!key) throw new Error("key is required")
  const tab = await getTabById(tabId)

  if (selector) {
    const focusResult = await runInPage(tab.id, "focus", { selector, index, timeoutMs, pollMs })
    if (!focusResult?.ok) throw new Error(focusResult?.error || "Focus failed")
  }

  await dispatchDebuggerKey(tab.id, key)
  return { tabId: tab.id, content: `Pressed ${key}` }
}

async function toolKeyDown({ key, tabId }) {
  if (!key) throw new Error("key is required")
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state.attached) throw new Error(state.unavailableReason || "Debugger is not available for keyboard input.")
  const descriptor = parseKeyChord(key)
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
    type: descriptor.text ? "keyDown" : "rawKeyDown",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers: descriptor.modifiers,
    ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
  })
  return { tabId: tab.id, content: `Key down ${key}` }
}

async function toolKeyUp({ key, tabId }) {
  if (!key) throw new Error("key is required")
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state.attached) throw new Error(state.unavailableReason || "Debugger is not available for keyboard input.")
  const descriptor = parseKeyChord(key)
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers: descriptor.modifiers,
  })
  return { tabId: tab.id, content: `Key up ${key}` }
}

async function toolSelect({ selector, value, label, optionIndex, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (value === undefined && label === undefined && optionIndex === undefined) {
    throw new Error("value, label, or optionIndex is required")
  }
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "select", { selector, value, label, optionIndex, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Select failed")
  const used = result.selectorUsed || selector
  const valueText = result.value ? String(result.value) : ""
  const labelText = result.label ? String(result.label) : ""
  const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText
  return { tabId: tab.id, content: `Selected ${summary || "option"} in ${used}` }
}

async function toolGetBox({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("selector is required")
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "query", {
    selector,
    mode: "bounding_box",
    index,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(result?.error || "Bounding box lookup failed")
  return {
    tabId: tab.id,
    content: {
      ok: true,
      selectorUsed: result.selectorUsed || selector,
      ...(result.value || {}),
    },
  }
}

async function toolGetViewport({ tabId }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "viewport", {})
  if (!result?.ok) throw new Error(result?.error || "Viewport lookup failed")
  return { tabId: tab.id, content: { ok: true, ...(result.value || {}) } }
}

async function toolScreenshot({ tabId, format }) {
  const tab = await getTabById(tabId)
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  if (format === "structured") {
    const viewport = await runInPage(tab.id, "viewport", {})
    if (!viewport?.ok) throw new Error(viewport?.error || "Viewport lookup failed")
    return {
      tabId: tab.id,
      content: {
        image: png,
        ...(viewport.value || {}),
      },
    }
  }
  return { tabId: tab.id, content: png }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const node = {
            uid: `e${uid}`,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
          }

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after

          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            node.value = el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }

          if (el.id) node.selector = `#${el.id}`
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          const r = build(el.shadowRoot.host, depth + 1, uid)
          uid = r.nextUid
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({
  tabId,
  selector,
  mode = "text",
  attribute,
  property,
  limit,
  index = 0,
  timeoutMs,
  pollMs,
  pattern,
  flags,
}) {
  if (!selector && mode !== "page_text" && mode !== "interactives") throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "query", {
    selector,
    mode,
    attribute,
    property,
    limit,
    index,
    timeoutMs,
    pollMs,
    pattern,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Query failed")

  if (
    mode === "list" ||
    mode === "property" ||
    mode === "exists" ||
    mode === "page_text" ||
    mode === "bounding_box" ||
    mode === "interactives"
  ) {
    return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
  }

  return { tabId: tab.id, content: typeof result.value === "string" ? result.value : JSON.stringify(result.value) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "scroll", { x, y, selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Scroll failed")
  const target = result.selectorUsed ? `to ${result.selectorUsed}` : `by (${x}, ${y})`
  return { tabId: tab.id, content: `Scrolled ${target}` }
}

async function toolWait({ ms = 1000, tabId }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

async function toolWaitForUrl({ pattern, tabId, timeoutMs, pollMs }) {
  if (!pattern) throw new Error("pattern is required")
  const tab = await getTabById(tabId)
  const matched = await waitForUrlPattern(tab.id, String(pattern), timeoutMs, pollMs)
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, url: matched.url || "", pattern: String(pattern) }, null, 2),
  }
}

async function toolWaitForLoadState({ state = "load", tabId, timeoutMs, pollMs }) {
  const targetState = typeof state === "string" && state ? state : "load"
  if (!["load", "domcontentloaded", "networkidle"].includes(targetState)) {
    throw new Error(`Unsupported load state: ${targetState}`)
  }
  const tab = await getTabById(tabId)
  const resolvedState = await waitForDocumentReadyState(tab.id, targetState, timeoutMs, pollMs)
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, requestedState: targetState, readyState: resolvedState }, null, 2),
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function normalizeDownloadTimeoutMs(value) {
  return clampNumber(value, 0, 60000, 60000)
}

function waitForNextDownloadCreated(timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    const listener = (item) => {
      cleanup()
      resolve(item)
    }

    const timer = timeout
      ? setTimeout(() => {
          cleanup()
          reject(new Error("Timed out waiting for download to start"))
        }, timeout)
      : null

    function cleanup() {
      chrome.downloads.onCreated.removeListener(listener)
      if (timer) clearTimeout(timer)
    }

    chrome.downloads.onCreated.addListener(listener)
  })
}

async function getDownloadById(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId })
  return items && items.length ? items[0] : null
}

async function waitForDownloadCompletion(downloadId, timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  const pollMs = 200
  const endAt = Date.now() + timeout

  while (true) {
    const item = await getDownloadById(downloadId)
    if (item && (item.state === "complete" || item.state === "interrupted")) return item
    if (!timeout || Date.now() >= endAt) return item
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function toolDownload({
  url,
  selector,
  filename,
  conflictAction,
  saveAs = false,
  wait = false,
  downloadTimeoutMs,
  tabId,
  index = 0,
  timeoutMs,
  pollMs,
}) {
  const hasUrl = typeof url === "string" && url.trim()
  const hasSelector = typeof selector === "string" && selector.trim()

  await ensureDownloadsAvailable()

  if (!hasUrl && !hasSelector) throw new Error("url or selector is required")
  if (hasUrl && hasSelector) throw new Error("Provide either url or selector, not both")

  let downloadId = null

  if (hasUrl) {
    const options = { url: url.trim() }
    if (typeof filename === "string" && filename.trim()) options.filename = filename.trim()
    if (typeof conflictAction === "string" && conflictAction.trim()) options.conflictAction = conflictAction.trim()
    if (typeof saveAs === "boolean") options.saveAs = saveAs

    downloadId = await chrome.downloads.download(options)
  } else {
    const tab = await getTabById(tabId)
    const created = waitForNextDownloadCreated(downloadTimeoutMs)
    const clicked = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
    if (!clicked?.ok) throw new Error(clicked?.error || "Click failed")
    const createdItem = await created
    downloadId = createdItem?.id
  }

  if (!Number.isFinite(downloadId)) throw new Error("Download did not start")

  if (!wait) {
    const item = await getDownloadById(downloadId)
    return { content: { downloadId, item } }
  }

  const item = await waitForDownloadCompletion(downloadId, downloadTimeoutMs)
  return { content: { downloadId, item } }
}

async function toolListDownloads({ limit = 20, state } = {}) {
  await ensureDownloadsAvailable()

  const limitValue = clampNumber(limit, 1, 200, 20)
  const query = { orderBy: ["-startTime"], limit: limitValue }
  if (typeof state === "string" && state.trim()) query.state = state.trim()

  const downloads = await chrome.downloads.search(query)
  const out = downloads.map((d) => ({
    id: d.id,
    url: d.url,
    filename: d.filename,
    state: d.state,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    startTime: d.startTime,
    endTime: d.endTime,
    error: d.error,
    mime: d.mime,
  }))

  return { content: JSON.stringify({ downloads: out }, null, 2) }
}

async function toolSetFileInput({ selector, tabId, index = 0, timeoutMs, pollMs, files }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "set_file_input", { selector, index, timeoutMs, pollMs, files })
  if (!result?.ok) throw new Error(result?.error || "Failed to set file input")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: JSON.stringify({ selector: used, ...result }, null, 2) }
}

async function toolHighlight({ selector, tabId, index = 0, duration, color, showInfo, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "highlight", {
    selector,
    index,
    duration,
    color,
    showInfo,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(result?.error || "Highlight failed")
  return {
    tabId: tab.id,
    content: JSON.stringify({
      highlighted: true,
      tag: result.tag,
      id: result.id,
      selectorUsed: result.selectorUsed,
    }),
  }
}

async function toolConsole({ tabId, clear = false, filter } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        messages: [],
      }),
    }
  }

  let messages = [...state.consoleMessages]

  if (filter && typeof filter === "string") {
    const filterType = filter.toLowerCase()
    messages = messages.filter((m) => m.type === filterType)
  }

  if (clear) {
    state.consoleMessages = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(messages, null, 2),
  }
}

async function toolErrors({ tabId, clear = false } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        errors: [],
      }),
    }
  }

  const errors = [...state.pageErrors]

  if (clear) {
    state.pageErrors = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(errors, null, 2),
  }
}

async function toolNetworkRequests({ tabId, clear = false, filter } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error: state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.",
        requests: [],
      }),
    }
  }

  let requests = [...state.networkRequests]
  if (filter && typeof filter === "string") {
    const needle = filter.toLowerCase()
    requests = requests.filter((request) => String(request.url || "").toLowerCase().includes(needle))
  }

  if (clear) {
    state.networkRequests = []
    state.requestsById = {}
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(requests, null, 2),
  }
}

async function toolDialogAccept({ tabId, text } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }

  await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", {
    accept: true,
    promptText: typeof text === "string" ? text : undefined,
  })
  const dialog = state.pendingDialog
  state.pendingDialog = null
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, action: "accept", dialog }, null, 2),
  }
}

async function toolDialogDismiss({ tabId } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    throw new Error(state.unavailableReason || "Debugger not attached. DevTools may be open or another debugger is active.")
  }

  await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", {
    accept: false,
  })
  const dialog = state.pendingDialog
  state.pendingDialog = null
  return {
    tabId: tab.id,
    content: JSON.stringify({ ok: true, action: "dismiss", dialog }, null, 2),
  }
}

chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}))
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}))

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => connect().catch(() => {}))
}

chrome.action.onClicked.addListener(async () => {
  const permissionResult = await requestOptionalPermissionsFromClick()
  if (!permissionResult.granted) {
    updateBadge(false)
    if (permissionResult.error) {
      console.warn("[OpenCode] Permission request failed:", permissionResult.error)
    } else {
      console.warn("[OpenCode] Permission request denied.")
    }
    return
  }

  if (permissionResult.requested) {
    const requestedPermissions = permissionResult.permissions.join(", ") || "none"
    const requestedOrigins = permissionResult.origins.join(", ") || "none"
    console.log(`[OpenCode] Requested permissions -> permissions: ${requestedPermissions}; origins: ${requestedOrigins}`)
  }

  await connect()
})

connect().catch(() => {})
