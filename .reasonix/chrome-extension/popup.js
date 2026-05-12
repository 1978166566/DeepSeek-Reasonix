// Reasonix Chrome Bridge — Popup Script
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const wsUrlInput = document.getElementById('wsUrl');
  const connectBtn = document.getElementById('connectBtn');
  const reconnectBtn = document.getElementById('reconnectBtn');
  const activeTabEl = document.getElementById('activeTab');

  // Load saved URL
  chrome.storage.local.get(['reasonixUrl', 'reasonixConnected'], (data) => {
    if (data.reasonixUrl) wsUrlInput.value = data.reasonixUrl;
    updateStatus(data.reasonixConnected === true);
  });

  // Get active tab info
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs?.[0]) {
      activeTabEl.textContent = `Active: ${tabs[0].title?.slice(0, 40) || 'unknown'}`;
    }
  });

  // Listen for connection changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.reasonixConnected) updateStatus(changes.reasonixConnected.newValue);
  });

  function updateStatus(connected) {
    statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`;
    statusText.textContent = connected ? 'Connected to Reasonix' : 'Disconnected';
  }

  connectBtn.addEventListener('click', () => {
    const url = wsUrlInput.value.trim();
    if (url) {
      chrome.storage.local.set({ reasonixUrl: url, reasonixReconnect: true });
      statusText.textContent = 'Reconnecting...';
    }
  });

  reconnectBtn.addEventListener('click', () => {
    chrome.storage.local.set({ reasonixReconnect: true });
    statusText.textContent = 'Reconnecting...';
  });
});
