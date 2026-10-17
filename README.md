# DBJ RattleNIX - Windows Standalone Port

This package contains the complete, self-contained Windows port of **DBJ RattleNIX** (COFDM Rattlegram modem & CW Repeater ID decoder).

---

## What is in this directory:
- `rattlegram_win.py`: Cross-platform Windows server with automatic browser launching and Windows WASAPI / MME audio capture.
- `morse_decoder.py`: Real-time vectorized CW / Morse Code Repeater ID decoder.
- `web/static/`: Exact glassmorphic web UI with `Bazinga` and `Asteroid Blaster` title typography, live audio VU meter, settings modal, and RxMoni DevByJae footer.
- `src/`: C++ source code for `encode.exe` and `decode_stream.exe`.
- `build_exe.bat`: One-click script to build `DBJ_RattleNIX.exe` on any Windows PC with Python installed.
- `.github/workflows/build-windows.yml`: Automated CI/CD workflow that builds the standalone Windows `.exe` on push and publishes the executable artifact.

---

## How to build `DBJ_RattleNIX.exe` on Windows:

1. **Option 1: One-Click Local Build**
   - Copy this `DBJ_RattleNIX_Windows` folder to your Windows machine.
   - Double-click `build_exe.bat`.
   - The compiled standalone executable will be generated in `dist\DBJ_RattleNIX.exe`.

2. **Option 2: Automated GitHub Actions Build (No Compiler Needed)**
   - Push this directory to GitHub.
   - The included `.github/workflows/build-windows.yml` will automatically compile `encode.exe`, `decode_stream.exe`, and bundle everything into a clean `DBJ_RattleNIX.exe` available for immediate download in the **Actions** tab artifacts.
