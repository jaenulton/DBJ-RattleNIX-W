// DBJ RattleNIX Client

let ws = null;
let audioLevel = 0.0;
let smoothLevel = 0.0;

document.addEventListener("DOMContentLoaded", () => {
  const savedCall = localStorage.getItem("rattlegram_callsign");
  if (savedCall) {
    const el = document.getElementById("callsign-input");
    if (el) el.value = savedCall;
  }
  connectWebSocket();
  setupUIEvents();
  startMeterLoop();
});

function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    updateSystemStatus("Connected to DBJ RattleNIX Engine");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerEvent(data);
    } catch (e) {
      console.error("Invalid WS message:", e);
    }
  };

  ws.onclose = () => {
    updateSystemStatus("Modem connection lost. Reconnecting...");
    setTimeout(connectWebSocket, 1500);
  };
}

function handleServerEvent(data) {
  switch (data.type) {
    case "audio_level":
      audioLevel = data.level;
      break;

    case "rx_sync":
      handleRxSync(data.callsign, data.cfo);
      break;

    case "rx_message":
      handleRxMessage(data.callsign, data.payload, data.flips);
      break;

    case "cw_message":
      handleCwMessage(data.callsign, data.payload);
      break;

    case "tx_started":
      handleTxStarted(data.callsign, data.payload);
      break;

    case "tx_finished":
      handleTxFinished();
      break;

    case "system_log":
      appendMessage("SYS", "MODEM", data.message);
      break;

    case "devices_list":
      populateDeviceSelects(data.inputs, data.outputs, data.current_in, data.current_out);
      break;

    case "config_state":
      const stored = localStorage.getItem("rattlegram_callsign");
      const finalCall = stored || data.callsign || "MYCALL";
      document.getElementById("callsign-input").value = finalCall;
      if (stored && stored !== data.callsign) {
        sendCommand("set_config", { callsign: stored });
      }
      break;
  }
}

function sendCommand(cmd, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ cmd, ...payload }));
  }
}

function setupUIEvents() {
  const modal = document.getElementById("settings-modal");
  const btnOpenSettings = document.getElementById("btn-open-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const btnSaveSettings = document.getElementById("btn-save-settings");

  const callsignInput = document.getElementById("callsign-input");
  const inDeviceSelect = document.getElementById("input-device-select");
  const outDeviceSelect = document.getElementById("output-device-select");

  // Modal show / hide
  btnOpenSettings.addEventListener("click", () => {
    modal.classList.remove("hidden");
    callsignInput.focus();
  });

  const closeModal = () => {
    modal.classList.add("hidden");
  };

  btnCloseSettings.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // ESC key closes the settings modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });

  const saveConfig = () => {
    const call = callsignInput.value.trim().toUpperCase() || "MYCALL";
    callsignInput.value = call;
    try {
      localStorage.setItem("rattlegram_callsign", call);
    } catch(e) {}

    sendCommand("set_config", {
      callsign: call,
      input_device: inDeviceSelect.value,
      output_device: outDeviceSelect.value
    });
    closeModal();
  };

  btnSaveSettings.addEventListener("click", saveConfig);

  // Direct Transmit
  const quickInput = document.getElementById("quick-message-input");
  const quickSendBtn = document.getElementById("btn-quick-send");
  const quickCharCount = document.getElementById("quick-char-count");

  quickInput.addEventListener("input", () => {
    const bytes = new TextEncoder().encode(quickInput.value).length;
    quickCharCount.textContent = `${bytes} / 170 bytes`;
    quickCharCount.style.color = bytes > 170 ? "var(--accent-red)" : "var(--text-muted)";
  });

  quickInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      transmitDirect();
    }
  });

  quickSendBtn.addEventListener("click", transmitDirect);

  // Clear Chat Log
  document.getElementById("btn-clear-chat").addEventListener("click", () => {
    document.getElementById("messages-list").innerHTML = "";
  });

  // Loopback Test
  document.getElementById("btn-test-loopback").addEventListener("click", () => {
    sendCommand("test_loopback");
  });
}

function transmitDirect() {
  const quickInput = document.getElementById("quick-message-input");
  const msg = quickInput.value.trim();
  if (!msg) return;

  const bytes = new TextEncoder().encode(msg).length;
  if (bytes > 170) {
    alert("Payload exceeds 170 bytes limit.");
    return;
  }

  sendCommand("transmit", { message: msg });
  quickInput.value = "";
  document.getElementById("quick-char-count").textContent = "0 / 170 bytes";
}

// -----------------------------------------------------------
// Chat / Messages Stream
// -----------------------------------------------------------
function appendMessage(type, callsign, text, meta = {}) {
  const list = document.getElementById("messages-list");
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble msg-${type.toLowerCase()}`;

  let metaHtml = "";
  if (type === "RX") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">${escapeHtml(callsign)}</span>
        <span class="msg-time">${timeStr}</span>
        <span class="msg-flips">${meta.flips || 0} flips</span>
      </div>
    `;
  } else if (type === "TX") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">TX [${escapeHtml(callsign)}]</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  } else if (type === "CW") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">📡 ${escapeHtml(callsign)}</span>
        <span class="msg-badge-tag">MORSE ID</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  } else {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">SYSTEM</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  }

  bubble.innerHTML = `
    ${metaHtml}
    <div class="msg-body">${escapeHtml(text)}</div>
  `;

  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

function handleRxSync(callsign, cfo) {
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `⚡ SYNC LOCKED: ${callsign} (CFO: ${cfo} Hz)`;
  syncLabel.style.color = "var(--accent-cyan)";
}

function handleRxMessage(callsign, payload, flips) {
  appendMessage("RX", callsign, payload, { flips });
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `✓ Packet Decoded from ${callsign}`;
  syncLabel.style.color = "var(--accent-green)";
  updateSystemStatus(`Decoded packet from ${callsign}`);
}

function handleCwMessage(callsign, payload) {
  appendMessage("CW", callsign, payload);
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `📻 CW / Morse Decoded: ${payload}`;
  syncLabel.style.color = "var(--accent-purple)";
  updateSystemStatus(`Decoded CW Repeater ID: ${payload}`);
}

function handleTxStarted(callsign, payload) {
  const badge = document.getElementById("rx-tx-badge");
  badge.className = "badge badge-tx";
  badge.innerHTML = `<span class="dot"></span> ▲ TRANSMITTING (TX)`;
  updateSystemStatus(`Broadcasting COFDM burst (${callsign})...`);
}

function handleTxFinished() {
  const badge = document.getElementById("rx-tx-badge");
  badge.className = "badge badge-rx";
  badge.innerHTML = `<span class="dot"></span> ● RX LISTENING`;
  updateSystemStatus("Ready • RX Monitoring 48 kHz");
}

function updateSystemStatus(text) {
  const footer = document.getElementById("status-footer");
  if (footer) footer.textContent = text;
}

function populateDeviceSelects(inputs, outputs, currentIn, currentOut) {
  const inSelect = document.getElementById("input-device-select");
  const outSelect = document.getElementById("output-device-select");

  inSelect.innerHTML = inputs.map(d => `<option value="${d.id}" ${d.id === currentIn ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
  outSelect.innerHTML = outputs.map(d => `<option value="${d.id}" ${d.id === currentOut ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
}

// -----------------------------------------------------------
// High-Responsiveness Realtime VU / Level Meter Animation
// -----------------------------------------------------------
function startMeterLoop() {
  const fill = document.getElementById("meter-fill");

  function render() {
    const raw = Math.max(0, audioLevel - 0.0015);
    const target = Math.min(100, Math.pow(raw * 18, 0.6) * 100);

    if (target > smoothLevel) {
      smoothLevel = smoothLevel * 0.4 + target * 0.6; // Instant attack
    } else {
      smoothLevel = smoothLevel * 0.85 + target * 0.15; // Smooth decay
    }

    if (fill) {
      fill.style.width = `${Math.max(0, smoothLevel).toFixed(1)}%`;
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

// Interactive Cursor Glow for DevByJae Logo (from RxMoni)
document.addEventListener("mousemove", (e) => {
  const logo = document.getElementById("dev-by-jae-logo");
  if (logo) {
    const x = (e.clientX - window.innerWidth / 2) / 30;
    const y = (e.clientY - window.innerHeight / 2) / 30;
    logo.style.filter = `
      drop-shadow(${x * 0.2}px ${y * 0.2}px 1px #fff)
      drop-shadow(${x * 0.5}px ${y * 0.5}px 2.4px #00d2ff)
      drop-shadow(${x}px ${y}px 4.8px #0066ff)
      drop-shadow(${x * 1.5}px ${y * 1.5}px 9.6px #0033cc)
      drop-shadow(${x * 2}px ${y * 2}px 16.8px #001166)
    `;
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
