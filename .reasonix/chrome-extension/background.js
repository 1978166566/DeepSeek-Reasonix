/**
 * Reasonix Chrome Bridge — Background Service Worker
 *
 * Maintains a persistent WebSocket connection to the Reasonix agent.
 * Receives commands and forwards them to the active tab via content scripts.
 * Connection auto-reconnects on disconnect.
 */

const DEFAULT_WS_URL = 'ws://127.0.0.1:18889';
let ws = null;
let reconnectTimer = null;
let pendingCommands = new Map();
let commandId = 0;

// ─── WebSocket Connection ─────────────────────────────────────────

function connect(url) {
  if (ws) {
    ws.close();
    ws = null;
  }

  try {
    ws = new WebSocket(url || DEFAULT_WS_URL);
  } catch (e) {
    console.error('[Reasonix] WebSocket connection failed:', e);
    scheduleReconnect(url);
    return;
  }

  ws.onopen = () => {
    console.log('[Reasonix] Connected to Reasonix agent');
    chrome.storage.local.set({ reasonixConnected: true, reasonixUrl: url || DEFAULT_WS_URL });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Send hello message
    sendToAgent({ type: 'hello', version: '1.0.0', browser: navigator.userAgent });
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleAgentMessage(msg);
    } catch (e) {
      console.error('[Reasonix] Failed to parse message:', e);
    }
  };

  ws.onclose = () => {
    console.log('[Reasonix] Disconnected from Reasonix agent');
    chrome.storage.local.set({ reasonixConnected: false });
    ws = null;
    scheduleReconnect(url);
  };

  ws.onerror = (e) => {
    console.error('[Reasonix] WebSocket error');
    // onclose will fire after this and trigger reconnect
  };
}

function scheduleReconnect(url) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(url);
  }, 5000);
}

function sendToAgent(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Command Handling ──────────────────────────────────────────────

async function handleAgentMessage(msg) {
  const cmd = msg.command;
  const id = msg.id || ++commandId;
  const tabId = msg.tabId;

  try {
    let result;

    switch (cmd) {
      case 'ping':
        result = { pong: true, timestamp: Date.now() };
        break;

      case 'get_tabs': {
        const tabs = await chrome.tabs.query({});
        result = tabs.map(t => ({
          id: t.id,
          title: t.title,
          url: t.url,
          active: t.active,
          windowId: t.windowId,
        }));
        break;
      }

      case 'get_active_tab': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        result = tab ? { id: tab.id, title: tab.title, url: tab.url } : null;
        break;
      }

      case 'switch_tab': {
        const tid = msg.tabId || msg.targetTabId;
        if (tid) {
          await chrome.tabs.update(tid, { active: true });
          await chrome.windows.update(msg.windowId || (await chrome.tabs.get(tid)).windowId, { focused: true });
          result = { switched: true, tabId: tid };
        } else {
          result = { error: 'tabId required' };
        }
        break;
      }

      case 'navigate': {
        const url = msg.url;
        if (!url) { result = { error: 'url required' }; break; }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.update(tab.id, { url });
          result = { navigated: true, url, tabId: tab.id };
        } else {
          result = { error: 'no active tab' };
        }
        break;
      }

      case 'click':
      case 'type':
      case 'extract':
      case 'evaluate':
      case 'scroll':
      case 'screenshot': {
        // Forward to content script in active tab
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          result = { error: 'no active tab' };
          break;
        }
        try {
          const response = await chrome.tabs.sendMessage(activeTab.id, { ...msg, id });
          result = response;
        } catch (e) {
          result = { error: `Content script not available: ${e.message}. Try navigating to a page first.` };
        }
        break;
      }

      case 'screenshot_full': {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          result = { screenshot: dataUrl };
        } catch (e) {
          result = { error: `Screenshot failed: ${e.message}` };
        }
        break;
      }

      default:
        result = { error: `Unknown command: ${cmd}` };
    }

    sendToAgent({ type: 'result', id, command: cmd, result });

  } catch (e) {
    sendToAgent({ type: 'result', id, command: cmd, result: { error: e.message } });
  }
}

// ─── Storage Change Listener (for popup config) ────────────────────

chrome.storage.onChanged.addListener((changes) => {
  if (changes.reasonixUrl) {
    const newUrl = changes.reasonixUrl.newValue;
    if (newUrl) connect(newUrl);
  }
  if (changes.reasonixReconnect && changes.reasonixReconnect.newValue === true) {
    chrome.storage.local.set({ reasonixReconnect: false });
    connect();
  }
});

// ─── Initialization ───────────────────────────────────────────────

chrome.storage.local.get(['reasonixUrl'], (data) => {
  connect(data.reasonixUrl || DEFAULT_WS_URL);
});
