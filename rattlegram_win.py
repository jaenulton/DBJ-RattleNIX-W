#!/usr/bin/env python3
"""
DBJ RattleNIX - Windows Standalone Edition.
Zero-dependency Windows audio stack with PyAudio / SoundDevice fallback,
native C++ COFDM modem bridge, CW/Morse ID decoder, FFT spectrum analyzer,
URL shortener webhook/analytics, and embedded web GUI.
"""

import os
import sys
import json
import time
import asyncio
import threading
import subprocess
import tempfile
import webbrowser
import numpy as np
import aiohttp

# Resolve local paths whether running from source or PyInstaller bundle
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
    DATA_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    DATA_DIR = BASE_DIR

BIN_DIR = os.path.join(BASE_DIR, "bin")
ENCODE_BIN = os.path.join(BIN_DIR, "encode.exe")
DECODE_STREAM_BIN = os.path.join(BIN_DIR, "decode_stream.exe")
STATIC_DIR = os.path.join(BASE_DIR, "web", "static")
CONFIG_DIR = os.path.join(os.environ.get("APPDATA", DATA_DIR), "DBJ_RattleNIX")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
URL_HISTORY_FILE = os.path.join(CONFIG_DIR, "urls.json")

sys.path.append(BASE_DIR)
from morse_decoder import MorseDecoder
from aiohttp import web, WSMsgType

# Audio engine import: sounddevice with fallback
try:
    import sounddevice as sd
    HAS_SD = True
except ImportError:
    HAS_SD = False

SAMPLE_RATE = 48000
FRAME_SAMPLES = 960  # 20ms at 48000Hz
BYTES_PER_FRAME = FRAME_SAMPLES * 2

class RattlegramCoreWin:
    def __init__(self):
        self.loop = None
        self.callsign = "MYCALL"
        self.carrier = "1500"
        self.mapping = "4"
        self.fancy_header = True
        self.input_device = None
        self.output_device = None

        self.ws_clients = set()
        self.decoder_proc = None
        self.is_running = True
        self.is_transmitting = False

        self.morse_decoder = MorseDecoder(SAMPLE_RATE, FRAME_SAMPLES)
        self._fft_buffer = np.zeros(1024, dtype=np.float32)
        self._fft_window = np.hanning(1024).astype(np.float32)
        self._last_fft_send = 0.0

        # Real-time URL Click Tracking & Analytics
        self.tracked_urls = {}
        self.url_history_file = URL_HISTORY_FILE
        self._load_tracked_urls()
        self._load_config()

    def _load_tracked_urls(self):
        try:
            if os.path.exists(self.url_history_file):
                with open(self.url_history_file, "r") as f:
                    self.tracked_urls = json.load(f)
        except Exception:
            pass

    def _save_tracked_urls(self):
        try:
            os.makedirs(os.path.dirname(self.url_history_file), exist_ok=True)
            with open(self.url_history_file, "w") as f:
                json.dump(self.tracked_urls, f, indent=2)
        except Exception:
            pass

    def record_short_url(self, short_code, short_url, target_url):
        if not short_code:
            return
        if short_code not in self.tracked_urls:
            self.tracked_urls[short_code] = {
                "short_code": short_code,
                "short_url": short_url,
                "target_url": target_url,
                "clicks": 0,
                "created_at": time.time()
            }
            self._save_tracked_urls()
        return self.tracked_urls[short_code]

    def increment_url_clicks(self, short_code):
        if short_code in self.tracked_urls:
            self.tracked_urls[short_code]["clicks"] += 1
            new_count = self.tracked_urls[short_code]["clicks"]
            self._save_tracked_urls()
            self.broadcast_ws({
                "type": "url_click_update",
                "short_code": short_code,
                "short_url": self.tracked_urls[short_code].get("short_url"),
                "clicks": new_count
            })
            return new_count
        return 0

    def _load_config(self):
        try:
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, "r") as f:
                    cfg = json.load(f)
                    self.callsign = cfg.get("callsign", self.callsign)
                    self.carrier = str(cfg.get("carrier", self.carrier))
                    self.mapping = str(cfg.get("mapping", self.mapping))
                    self.fancy_header = bool(cfg.get("fancy_header", self.fancy_header))
                    self.input_device = cfg.get("input_device", self.input_device)
                    self.output_device = cfg.get("output_device", self.output_device)
        except Exception:
            pass

    def _save_config(self):
        try:
            os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
            with open(CONFIG_FILE, "w") as f:
                json.dump({
                    "callsign": self.callsign,
                    "carrier": self.carrier,
                    "mapping": self.mapping,
                    "fancy_header": self.fancy_header,
                    "input_device": self.input_device,
                    "output_device": self.output_device
                }, f, indent=2)
        except Exception:
            pass

    def start(self, loop):
        self.loop = loop
        self._start_rx_engine()

    def get_audio_devices(self):
        inputs = [{"id": "default", "name": "Default Microphone (Windows Default)"}]
        outputs = [{"id": "default", "name": "Default Speakers (Windows Default)"}]
        if HAS_SD:
            try:
                devs = sd.query_devices()
                for i, d in enumerate(devs):
                    if d.get("max_input_channels", 0) > 0:
                        inputs.append({"id": str(i), "name": f"{d['name']} (MME/WASAPI)"})
                    if d.get("max_output_channels", 0) > 0:
                        outputs.append({"id": str(i), "name": f"{d['name']} (MME/WASAPI)"})
            except Exception:
                pass
        return inputs, outputs

    def broadcast_ws(self, data):
        if not self.ws_clients or not self.loop or self.loop.is_closed():
            return
        msg = json.dumps(data)
        for ws in list(self.ws_clients):
            if not ws.closed:
                try:
                    asyncio.run_coroutine_threadsafe(ws.send_str(msg), self.loop)
                except Exception:
                    pass

    def _start_rx_engine(self):
        self._stop_rx_engine()
        self.is_running = True

        decode_cmd = [DECODE_STREAM_BIN, str(SAMPLE_RATE), str(self.mapping), "0"]
        try:
            self.decoder_proc = subprocess.Popen(
                decode_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0
            )
        except Exception as e:
            self.broadcast_ws({"type": "system_log", "message": f"Modem binary error: {e}"})
            return

        threading.Thread(target=self._decoder_reader_thread, daemon=True).start()
        threading.Thread(target=self._audio_capture_thread, daemon=True).start()

    def _stop_rx_engine(self):
        self.is_running = False
        if self.decoder_proc:
            try:
                self.decoder_proc.stdin.close()
                self.decoder_proc.terminate()
            except Exception:
                pass
            self.decoder_proc = None

    def _audio_capture_thread(self):
        last_meter_send = 0.0
        dev_idx = None
        if self.input_device and self.input_device != "default":
            try:
                dev_idx = int(self.input_device)
            except ValueError:
                dev_idx = None

        if HAS_SD:
            try:
                with sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    blocksize=FRAME_SAMPLES,
                    device=dev_idx,
                    channels=1,
                    dtype="int16"
                ) as stream:
                    while self.is_running:
                        if self.is_transmitting:
                            time.sleep(0.04)
                            continue

                        data, overflowed = stream.read(FRAME_SAMPLES)
                        arr = np.frombuffer(data, dtype=np.int16)
                        peak = float(np.max(np.abs(arr)) / 32768.0)

                        now = time.time()
                        if now - last_meter_send >= 0.04:
                            last_meter_send = now
                            self.broadcast_ws({"type": "audio_level", "level": peak})

                        # Feed into CW / Morse Code Decoder
                        cw_words = self.morse_decoder.process_frame(arr)
                        for word in cw_words:
                            self.broadcast_ws({"type": "cw_message", "callsign": "CW ID", "payload": word})

                        # Stream into Rattlegram COFDM decoder
                        if self.decoder_proc and self.decoder_proc.stdin:
                            self.decoder_proc.stdin.write(data.tobytes())
                            self.decoder_proc.stdin.flush()

                        # Stream Spectrum / Waterfall FFT data at ~20-25 FPS
                        if now - self._last_fft_send >= 0.045:
                            self._last_fft_send = now
                            self._fft_buffer[:-FRAME_SAMPLES] = self._fft_buffer[FRAME_SAMPLES:]
                            self._fft_buffer[-FRAME_SAMPLES:] = arr.astype(np.float32) / 32768.0
                            fft_mag = np.abs(np.fft.rfft(self._fft_buffer * self._fft_window))
                            bins_4k = fft_mag[:86]
                            db = 20.0 * np.log10(np.maximum(bins_4k, 1e-4))
                            norm = np.clip((db + 75.0) * (255.0 / 65.0), 0, 255).astype(np.uint8)
                            self.broadcast_ws({
                                "type": "fft_frame",
                                "bins": norm.tolist()
                            })

            except Exception as e:
                self.broadcast_ws({"type": "system_log", "message": f"Windows audio capture error: {e}"})

    def _decoder_reader_thread(self):
        proc = self.decoder_proc
        if not proc or not proc.stdout:
            return

        last_sync_call = ""
        while self.is_running and proc.poll() is None:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                line_str = line.decode("utf-8", errors="ignore").strip()
            except Exception:
                continue

            if not line_str:
                continue

            if line_str.startswith("EVENT:SYNC"):
                parts = line_str.split("|")
                cfo = ""
                call = ""
                for p in parts[1:]:
                    if p.startswith("CFO:"):
                        cfo = p.split(":")[1]
                    elif p.startswith("CALL:"):
                        call = p.split(":", 1)[1].strip()
                last_sync_call = call
                self.broadcast_ws({"type": "rx_sync", "callsign": call, "cfo": cfo})

            elif line_str.startswith("EVENT:MESSAGE"):
                parts = line_str.split("|")
                flips = 0
                payload = ""
                for p in parts[1:]:
                    if p.startswith("FLIPS:"):
                        try:
                            flips = int(p.split(":")[1])
                        except Exception:
                            flips = 0
                    elif p.startswith("PAYLOAD:"):
                        payload = p.split(":", 1)[1]

                rx_call = last_sync_call or "UNKNOWN"
                self.broadcast_ws({
                    "type": "rx_message",
                    "callsign": rx_call,
                    "payload": payload,
                    "flips": flips
                })
                last_sync_call = ""

    def transmit(self, message):
        msg = message.strip()
        if not msg:
            return

        callsign = self.callsign.strip() or "N0CALL"
        if len(msg.encode("utf-8")) > 170:
            self.broadcast_ws({"type": "system_log", "message": "Payload exceeds 170 bytes limit"})
            return

        def _worker():
            self.is_transmitting = True
            self.broadcast_ws({"type": "tx_started", "callsign": callsign, "payload": msg})

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name

            try:
                cmd = [
                    ENCODE_BIN,
                    msg,
                    callsign,
                    "1",
                    str(self.carrier),
                    str(SAMPLE_RATE),
                    "16",
                    "0",
                    str(self.mapping),
                    wav_path,
                    "1" if self.fancy_header else "0"
                ]
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
                if res.returncode != 0:
                    self.broadcast_ws({"type": "system_log", "message": f"Encode error: {res.stderr.decode()}"})
                    return

                if HAS_SD:
                    import wave
                    with wave.open(wav_path, "rb") as wf:
                        framerate = wf.getframerate()
                        nframes = wf.getnframes()
                        audio_data = wf.readframes(nframes)
                        audio_arr = np.frombuffer(audio_data, dtype=np.int16)

                    out_idx = None
                    if self.output_device and self.output_device != "default":
                        try:
                            out_idx = int(self.output_device)
                        except ValueError:
                            out_idx = None

                    sd.play(audio_arr, samplerate=framerate, device=out_idx)
                    sd.wait()

            except Exception as e:
                self.broadcast_ws({"type": "system_log", "message": f"TX exception: {e}"})
            finally:
                try:
                    os.remove(wav_path)
                except Exception:
                    pass
                time.sleep(0.1)
                self.is_transmitting = False
                self.broadcast_ws({"type": "tx_finished"})

        threading.Thread(target=_worker, daemon=True).start()

    def test_loopback(self):
        callsign = self.callsign or "LOOP"
        test_msg = f"TEST LOOPBACK {time.strftime('%H:%M:%S')}"
        self.broadcast_ws({"type": "system_log", "message": f"Running loopback: {test_msg}..."})

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name

        def _worker():
            try:
                cmd = [
                    ENCODE_BIN,
                    test_msg,
                    callsign,
                    "1",
                    str(self.carrier),
                    str(SAMPLE_RATE),
                    "16",
                    "0",
                    str(self.mapping),
                    wav_path,
                    "1" if self.fancy_header else "0"
                ]
                subprocess.run(cmd, check=True)
                with open(wav_path, "rb") as f:
                    wav_bytes = f.read()

                pcm = wav_bytes[44:] + b"\x00" * (FRAME_SAMPLES * 2 * 22)
                if self.decoder_proc and self.decoder_proc.stdin:
                    self.decoder_proc.stdin.write(pcm)
                    self.decoder_proc.stdin.flush()
            except Exception as e:
                self.broadcast_ws({"type": "system_log", "message": f"Loopback error: {e}"})
            finally:
                try:
                    os.remove(wav_path)
                except Exception:
                    pass

        threading.Thread(target=_worker, daemon=True).start()

async def index_handler(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))

async def shorten_url_remote(url_to_shorten: str, core: RattlegramCoreWin = None) -> dict:
    url_to_shorten = url_to_shorten.strip()
    if not url_to_shorten:
        return {"error": "URL cannot be empty"}
    if not url_to_shorten.startswith(("http://", "https://")):
        url_to_shorten = "https://" + url_to_shorten

    async with aiohttp.ClientSession() as session:
        try:
            async with session.post(
                "https://url.w8jae.com/api/shorten",
                json={"targetUrl": url_to_shorten},
                headers={"Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=8)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    short_url = data.get("shortUrl")
                    short_code = data.get("shortCode", "")
                    if short_url:
                        if core:
                            core.record_short_url(short_code, short_url, url_to_shorten)
                        return {
                            "success": True,
                            "shortUrl": short_url,
                            "shortCode": short_code,
                            "targetUrl": url_to_shorten,
                            "clicks": core.tracked_urls.get(short_code, {}).get("clicks", 0) if core else 0
                        }
                    return {"error": "Invalid response from URL shortener service"}
                else:
                    return {"error": f"Shortener service returned HTTP {resp.status}"}
        except Exception as e:
            return {"error": f"Failed to connect to shortener service: {e}"}

async def track_redirect_handler(request):
    core = request.app["core"]
    short_code = request.match_info.get("code", "").strip()
    info = core.tracked_urls.get(short_code)
    if info:
        core.increment_url_clicks(short_code)
        target = info.get("target_url") or info.get("short_url")
        raise web.HTTPFound(location=target)
    raise web.HTTPNotFound(text="Short URL tracking code not found")

async def shorten_webhook_handler(request):
    core = request.app["core"]
    url_to_shorten = None
    if request.method == "POST":
        content_type = request.content_type.lower()
        if "application/json" in content_type:
            try:
                body = await request.json()
                url_to_shorten = body.get("url") or body.get("targetUrl")
            except Exception:
                return web.json_response({"error": "Malformed JSON body"}, status=400)
        else:
            try:
                post_data = await request.post()
                url_to_shorten = post_data.get("url") or post_data.get("targetUrl")
            except Exception:
                pass
    
    if not url_to_shorten:
        url_to_shorten = request.query.get("url") or request.query.get("targetUrl")

    if not url_to_shorten:
        return web.json_response({"error": "Missing 'url' or 'targetUrl' parameter"}, status=400)

    result = await shorten_url_remote(url_to_shorten, core)
    status_code = 200 if result.get("success") else 502
    return web.json_response(result, status=status_code)

async def webhook_click_recorder(request):
    core = request.app["core"]
    code = request.query.get("code") or request.query.get("short_code")
    if request.method == "POST":
        try:
            body = await request.json()
            code = body.get("code") or body.get("short_code") or code
        except Exception:
            pass
    if code and code in core.tracked_urls:
        new_cnt = core.increment_url_clicks(code)
        return web.json_response({"success": True, "code": code, "clicks": new_cnt})
    return web.json_response({"error": "Code not found or not provided"}, status=400)

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    core = request.app["core"]
    core.ws_clients.add(ws)

    inputs, outputs = core.get_audio_devices()
    await ws.send_str(json.dumps({
        "type": "devices_list",
        "inputs": inputs,
        "outputs": outputs,
        "current_in": core.input_device or "default",
        "current_out": core.output_device or "default"
    }))

    await ws.send_str(json.dumps({
        "type": "config_state",
        "callsign": core.callsign,
        "carrier": core.carrier,
        "mapping": core.mapping,
        "fancy_header": core.fancy_header
    }))

    # Send initial click counts for all tracked URLs
    await ws.send_str(json.dumps({
        "type": "url_click_all",
        "urls": core.tracked_urls
    }))

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                data = json.loads(msg.data)
                cmd = data.get("cmd")
                if cmd == "transmit":
                    core.transmit(data.get("message", ""))
                elif cmd == "test_loopback":
                    core.test_loopback()
                elif cmd == "shorten_url":
                    target_url = data.get("url", "")
                    res = await shorten_url_remote(target_url, core)
                    await ws.send_str(json.dumps({
                        "type": "shorten_result",
                        "req_id": data.get("req_id", ""),
                        **res
                    }))
                elif cmd == "record_url_click":
                    short_code = data.get("short_code", "")
                    core.increment_url_clicks(short_code)
                elif cmd == "set_config":
                    core.callsign = data.get("callsign", core.callsign)
                    new_carrier = data.get("carrier")
                    new_mapping = data.get("mapping")
                    new_in = data.get("input_device")
                    new_out = data.get("output_device")
                    if "fancy_header" in data:
                        core.fancy_header = bool(data["fancy_header"])

                    changed = False
                    if new_carrier and str(new_carrier) != str(core.carrier):
                        core.carrier = str(new_carrier)
                    if new_mapping and str(new_mapping) != str(core.mapping):
                        core.mapping = str(new_mapping)
                        changed = True
                    if new_in and new_in != core.input_device:
                        core.input_device = new_in
                        changed = True
                    if new_out and new_out != core.output_device:
                        core.output_device = new_out

                    core._save_config()

                    if changed:
                        core._start_rx_engine()

            elif msg.type == WSMsgType.ERROR:
                pass
    finally:
        core.ws_clients.remove(ws)

    return ws

async def on_startup(app):
    loop = asyncio.get_running_loop()
    app["core"].start(loop)
    # Automatically open default Windows browser to app UI
    port = app.get("port", 8998)
    def open_browser():
        time.sleep(1.0)
        webbrowser.open(f"http://127.0.0.1:{port}")
    threading.Thread(target=open_browser, daemon=True).start()

async def on_cleanup(app):
    app["core"]._stop_rx_engine()

def create_app():
    app = web.Application()
    core = RattlegramCoreWin()
    app["core"] = core

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    app.router.add_get("/", index_handler)
    app.router.add_get("/api/shorten", shorten_webhook_handler)
    app.router.add_post("/api/shorten", shorten_webhook_handler)
    app.router.add_post("/webhook/shorten", shorten_webhook_handler)
    app.router.add_get("/webhook/shorten", shorten_webhook_handler)
    app.router.add_get("/webhook/click", webhook_click_recorder)
    app.router.add_post("/webhook/click", webhook_click_recorder)
    app.router.add_get("/r/{code}", track_redirect_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_static("/static/", path=STATIC_DIR, name="static")

    return app

if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host="127.0.0.1", port=8998)
