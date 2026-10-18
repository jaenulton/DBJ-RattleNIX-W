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
  initVisualizers();
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

    case "fft_frame":
      if (data.bins) {
        onNewFftFrame(data.bins);
      }
      break;

    case "shorten_result":
      handleShortenResult(data);
      break;

    case "url_click_update":
      onUrlClickUpdate(data.short_code, data.clicks);
      break;

    case "url_click_all":
      if (data.urls) {
        onUrlClickAll(data.urls);
      }
      break;

    case "config_state":
      const stored = localStorage.getItem("rattlegram_callsign");
      const finalCall = stored || data.callsign || "MYCALL";
      document.getElementById("callsign-input").value = finalCall;
      if (data.carrier) {
        const carrierSelect = document.getElementById("carrier-select");
        if (carrierSelect) carrierSelect.value = String(data.carrier);
      }
      if (data.mapping) {
        const bitrateSelect = document.getElementById("bitrate-select");
        if (bitrateSelect) bitrateSelect.value = String(data.mapping);
      }
      if (data.fancy_header !== undefined) {
        const fancyCheck = document.getElementById("fancy-header-check");
        if (fancyCheck) fancyCheck.checked = Boolean(data.fancy_header);
      }
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
  const carrierSelect = document.getElementById("carrier-select");
  const bitrateSelect = document.getElementById("bitrate-select");
  const fancyCheck = document.getElementById("fancy-header-check");
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
      carrier: carrierSelect ? carrierSelect.value : "1500",
      mapping: bitrateSelect ? bitrateSelect.value : "4",
      fancy_header: fancyCheck ? fancyCheck.checked : true,
      input_device: inDeviceSelect.value,
      output_device: outDeviceSelect.value
    });
    closeModal();
  };

  btnSaveSettings.addEventListener("click", saveConfig);

  // Emoji Picker Setup
  initEmojiPicker();

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

  // URL Shortener Feature (url.w8jae.com)
  initUrlShortener();
}

function initUrlShortener() {
  const shortenerInput = document.getElementById("shortener-url-input");
  const btnShorten = document.getElementById("btn-shorten-url");
  const btnText = document.getElementById("shorten-btn-text");
  const quickInput = document.getElementById("quick-message-input");

  if (!shortenerInput || !btnShorten) return;

  const triggerShorten = () => {
    const rawUrl = shortenerInput.value.trim();
    if (!rawUrl) {
      shortenerInput.focus();
      return;
    }

    btnShorten.disabled = true;
    if (btnText) {
      btnText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Shortening...`;
    }

    // Send through WebSocket to backend webhook bridge
    sendCommand("shorten_url", { url: rawUrl, req_id: "req_" + Date.now() });
  };

  btnShorten.addEventListener("click", triggerShorten);

  shortenerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerShorten();
    }
  });
}

function handleShortenResult(data) {
  const btnShorten = document.getElementById("btn-shorten-url");
  const btnText = document.getElementById("shorten-btn-text");
  const shortenerInput = document.getElementById("shortener-url-input");
  const quickInput = document.getElementById("quick-message-input");

  if (btnShorten) btnShorten.disabled = false;
  if (btnText) {
    btnText.innerHTML = `<i class="fa-solid fa-scissors"></i> Shorten &amp; Paste`;
  }

  if (data.error) {
    alert("URL Shortener error: " + data.error);
    return;
  }

  if (data.shortUrl) {
    const shortened = data.shortUrl;
    if (shortenerInput) shortenerInput.value = "";

    // Automatically paste shortened URL into the message text field box
    if (quickInput) {
      const currentVal = quickInput.value;
      const start = quickInput.selectionStart ?? currentVal.length;
      const end = quickInput.selectionEnd ?? currentVal.length;

      // Add a leading space if preceding character is not whitespace or start of line
      const needsLeadingSpace = start > 0 && !/\s$/.test(currentVal.slice(0, start));
      // Add a trailing space for convenient continuation of typing
      const toInsert = (needsLeadingSpace ? " " : "") + shortened + " ";

      quickInput.value = currentVal.slice(0, start) + toInsert + currentVal.slice(end);
      const newCursorPos = start + toInsert.length;
      quickInput.selectionStart = quickInput.selectionEnd = newCursorPos;
      quickInput.focus();
      quickInput.dispatchEvent(new Event("input"));
    }
  }
}

function initEmojiPicker() {
  const btnEmojiToggle = document.getElementById("btn-emoji-toggle");
  const emojiPopup = document.getElementById("emoji-popup");
  const emojiGrid = document.getElementById("emoji-grid");
  const quickInput = document.getElementById("quick-message-input");

  if (!btnEmojiToggle || !emojiPopup || !emojiGrid) return;

  const popularEmojis = [
    "😀", "😃", "😄", "😁", "😆", "😅",
    "😂", "🤣", "😊", "😇", "🙂", "😉",
    "😍", "🥰", "😘", "😋", "😎", "🤩",
    "🥳", "😏", "🤔", "🫡", "🤫", "😴",
    "👍", "👎", "👌", "✌️", "🤞", "🤝",
    "👋", "👏", "🙌", "❤️", "🔥", "✨",
    "📡", "📻", "⚡", "🔊", "⚠️", "🆘",
    "✅", "❌", "❓", "❗", "🌍", "🛰️"
  ];

  emojiGrid.innerHTML = popularEmojis.map(em => `<button type="button" class="emoji-btn" data-emoji="${em}">${em}</button>`).join("");

  btnEmojiToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPopup.classList.toggle("hidden");
  });

  emojiGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".emoji-btn");
    if (!btn) return;
    const emoji = btn.getAttribute("data-emoji");
    if (emoji && quickInput) {
      const start = quickInput.selectionStart || quickInput.value.length;
      const end = quickInput.selectionEnd || quickInput.value.length;
      const text = quickInput.value;
      quickInput.value = text.slice(0, start) + emoji + text.slice(end);
      quickInput.selectionStart = quickInput.selectionEnd = start + emoji.length;
      quickInput.focus();
      quickInput.dispatchEvent(new Event("input"));
    }
  });

  document.addEventListener("click", (e) => {
    if (!emojiPopup.contains(e.target) && e.target !== btnEmojiToggle) {
      emojiPopup.classList.add("hidden");
    }
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
// Chat / Messages Stream (with clickable hyperlink rendering)
// -----------------------------------------------------------
// Real-Time URL Click Tracking Cache & Audio Context
const urlClicksMap = new Map(); // short_code -> count
let audioCtx = null;

function playTricorderSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    const t = audioCtx.currentTime;
    // Classic Star Trek Tricorder dual-tone warble chirps
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc1.type = "sine";
    osc2.type = "triangle";

    // Frequency sweep / warble
    osc1.frequency.setValueAtTime(880, t);
    osc1.frequency.linearRampToValueAtTime(1760, t + 0.08);
    osc1.frequency.linearRampToValueAtTime(1100, t + 0.16);
    osc1.frequency.linearRampToValueAtTime(2200, t + 0.24);

    osc2.frequency.setValueAtTime(440, t);
    osc2.frequency.linearRampToValueAtTime(880, t + 0.12);
    osc2.frequency.linearRampToValueAtTime(550, t + 0.24);

    gainNode.gain.setValueAtTime(0.001, t);
    gainNode.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.18, t + 0.14);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.28);
    osc2.stop(t + 0.28);
  } catch (e) {
    console.debug("Tricorder audio error:", e);
  }
}

function extractShortCode(url) {
  if (!url) return null;
  // Match patterns like url.w8jae.com/63d6ba or 127.0.0.1:8998/r/63d6ba
  const m = url.match(/(?:url\.w8jae\.com|(?:\/|\/r\/))([a-zA-Z0-9]{5,8})\b/i);
  return m ? m[1] : null;
}

function onUrlClickAll(urlsObj) {
  if (!urlsObj) return;
  for (const [code, info] of Object.entries(urlsObj)) {
    const clicks = typeof info === "object" ? (info.clicks || 0) : info;
    urlClicksMap.set(code, clicks);
    updateTrackerTags(code, clicks, false);
  }
}

function onUrlClickUpdate(code, clicks) {
  const previous = urlClicksMap.get(code) || 0;
  urlClicksMap.set(code, clicks);

  // If the count increased, play the Star Trek tricorder sound effect
  if (clicks > previous) {
    playTricorderSound();
  }

  // Update in real-time without page refresh or reload
  updateTrackerTags(code, clicks, true);
}

function updateTrackerTags(code, clicks, highlight = false) {
  const tags = document.querySelectorAll(`.url-tracker-tag[data-code="${code}"]`);
  tags.forEach((tag) => {
    const countSpan = tag.querySelector(".tracker-count");
    if (countSpan) {
      countSpan.textContent = clicks;
    }
    if (highlight) {
      tag.classList.add("updated");
      setTimeout(() => tag.classList.remove("updated"), 1200);
    }
  });
}

function formatMessageContent(text) {
  if (!text) return "";
  // Escape HTML first to prevent XSS
  const escaped = escapeHtml(text);
  // Match URLs starting with http://, https://, or www.
  const urlPattern = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  return escaped.replace(urlPattern, (match) => {
    const href = match.toLowerCase().startsWith("http") ? match : `http://${match}`;
    const code = extractShortCode(match);
    let trackerHtml = "";
    if (code) {
      const initialCount = urlClicksMap.get(code) || 0;
      trackerHtml = `
        <span class="url-tracker-tag" data-code="${code}" title="Real-Time Visits from url.w8jae.com">
          <i class="fa-solid fa-eye tracker-icon"></i>
          <span class="tracker-count">${initialCount}</span>
          <span class="tracker-label">views</span>
        </span>
      `;
    }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="msg-link" data-code="${code || ''}">${match}</a>${trackerHtml}`;
  });
}

function appendMessage(type, callsign, text, meta = {}) {
  const list = document.getElementById("messages-list");
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble msg-${type.toLowerCase()}`;

  const isRetransmittable = (type === "RX" || type === "TX" || type === "CW") && text && text.trim().length > 0;
  if (isRetransmittable) {
    bubble.classList.add("msg-retransmittable");
    bubble.setAttribute("title", "Click message container to automatically retransmit");
  }

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
    <div class="msg-body">${formatMessageContent(text)}</div>
  `;

  if (isRetransmittable) {
    bubble.addEventListener("click", (e) => {
      // Do not retransmit if user clicked on a link, tracker tag, or is selecting text
      if (e.target && (e.target.tagName === "A" || e.target.closest(".url-tracker-tag"))) {
        return;
      }
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) {
        return;
      }
      const rawPayload = text.trim();
      const bytes = new TextEncoder().encode(rawPayload).length;
      if (bytes > 170) {
        alert("Payload exceeds 170 bytes limit for retransmission.");
        return;
      }
      sendCommand("transmit", { message: rawPayload });
    });
  }

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

// -----------------------------------------------------------
// Realtime Spectrum Analyzer & Waterfall Display
// -----------------------------------------------------------
let spectrumCanvas = null;
let spectrumCtx = null;
let waterfallCanvas = null;
let waterfallCtx = null;
let latestFftBins = null;
let smoothBins = null;

function initVisualizers() {
  spectrumCanvas = document.getElementById("spectrum-canvas");
  waterfallCanvas = document.getElementById("waterfall-canvas");

  if (spectrumCanvas) {
    spectrumCtx = spectrumCanvas.getContext("2d");
    spectrumCtx.fillStyle = "#05070a";
    spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  }

  if (waterfallCanvas) {
    waterfallCtx = waterfallCanvas.getContext("2d");
    waterfallCtx.fillStyle = "#05070a";
    waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
  }

  requestAnimationFrame(renderVisualizerLoop);
}

function onNewFftFrame(bins) {
  latestFftBins = bins;
  if (!waterfallCtx || !waterfallCanvas) return;

  const width = waterfallCanvas.width;
  const height = waterfallCanvas.height;

  // Scroll waterfall down by 1 pixel (newest line at top, matching Rattlegram convention)
  waterfallCtx.drawImage(waterfallCanvas, 0, 0, width, height - 1, 0, 1, width, height - 1);

  // Render newest FFT line at y = 0
  const imgData = waterfallCtx.createImageData(width, 1);
  const data = imgData.data;
  const binCount = bins.length;

  for (let x = 0; x < width; x++) {
    const binIdx = Math.min(binCount - 1, Math.floor((x / width) * binCount));
    const val = bins[binIdx] / 255.0; // 0.0 to 1.0
    const [r, g, b] = getRainbowColor(val);
    const p = x * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  waterfallCtx.putImageData(imgData, 0, 0);
}

// Rattlegram Rainbow Color Map (Ahmet Inan formula)
function getRainbowColor(v) {
  v = Math.max(0, Math.min(1, v));
  // Background floor
  if (v <= 0.02) return [5, 7, 10];
  const t = 4 * v - 2;
  let a = Math.max(0, Math.min(1, 4 * v));
  let r = Math.max(0, Math.min(1, t)) * a;
  let g = Math.max(0, Math.min(1, 1 - Math.abs(t))) * a;
  let b = Math.max(0, Math.min(1, -t)) * a;
  return [
    Math.round(255 * Math.sqrt(r)),
    Math.round(255 * Math.sqrt(g)),
    Math.round(255 * Math.sqrt(b))
  ];
}

function renderVisualizerLoop() {
  if (spectrumCtx && spectrumCanvas && latestFftBins) {
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    const binCount = latestFftBins.length;

    if (!smoothBins || smoothBins.length !== binCount) {
      smoothBins = new Float32Array(binCount);
    }

    for (let i = 0; i < binCount; i++) {
      const target = latestFftBins[i];
      if (target > smoothBins[i]) {
        smoothBins[i] = smoothBins[i] * 0.3 + target * 0.7; // Fast rise
      } else {
        smoothBins[i] = smoothBins[i] * 0.82 + target * 0.18; // Decay
      }
    }

    // Clear background
    spectrumCtx.fillStyle = "#05070a";
    spectrumCtx.fillRect(0, 0, width, height);

    // Draw subtle frequency grid lines (1 kHz, 2 kHz, 3 kHz)
    spectrumCtx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    spectrumCtx.lineWidth = 1;
    [1000, 2000, 3000].forEach((freq) => {
      // 0 to 4000 Hz mapped to 0 to width
      const x = (freq / 4000) * width;
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(x, 0);
      spectrumCtx.lineTo(x, height);
      spectrumCtx.stroke();
    });

    // Draw standard Rattlegram 1500 Hz carrier reference marker
    const carrierX = (1500 / 4000) * width;
    spectrumCtx.strokeStyle = "rgba(56, 189, 248, 0.3)";
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(carrierX, 0);
    spectrumCtx.lineTo(carrierX, height);
    spectrumCtx.stroke();

    // Draw Spectrum Path
    const grad = spectrumCtx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, "rgba(34, 197, 94, 0.8)");
    grad.addColorStop(0.5, "rgba(56, 189, 248, 0.9)");
    grad.addColorStop(0.85, "rgba(245, 158, 11, 0.95)");
    grad.addColorStop(1, "rgba(239, 68, 68, 1)");

    spectrumCtx.beginPath();
    spectrumCtx.moveTo(0, height);
    for (let x = 0; x < width; x++) {
      const binIdx = Math.min(binCount - 1, Math.floor((x / width) * binCount));
      const val = smoothBins[binIdx] / 255.0;
      const y = height - (val * (height - 4));
      if (x === 0) {
        spectrumCtx.moveTo(x, y);
      } else {
        spectrumCtx.lineTo(x, y);
      }
    }
    spectrumCtx.strokeStyle = grad;
    spectrumCtx.lineWidth = 1.8;
    spectrumCtx.stroke();
  }

  requestAnimationFrame(renderVisualizerLoop);
}
