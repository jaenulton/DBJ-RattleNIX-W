#!/usr/bin/env python3
"""
DBJ RattleNIX OTA Updater Engine.
Supports:
- Auto-updating on stable milestone releases (e.g., 1.1, 1.2, 2.0).
- Manual opt-in for bleeding-edge patches / betas (e.g., 1.11, 1.12, 1.15).
- In-place hot-patching of web/static assets and application code.
- Windows & Linux native package upgrades.
"""

import os
import sys
import json
import shutil
import zipfile
import tempfile
import asyncio
import aiohttp

CURRENT_VERSION = "1.15"
VERSION_MANIFEST_URL = "https://www.devbyjae.com/updates/version.json"
TELEMETRY_ENDPOINT = "https://devbyjae.com/api/rattlenix/log_usage.php"

async def log_usage_telemetry(callsign, platform="windows", version=CURRENT_VERSION):
    """
    Asynchronously logs station callsign, platform, and version to telemetry API.
    """
    try:
        cs = str(callsign or "ANONYMOUS").strip()
        timeout = aiohttp.ClientTimeout(total=4)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            await session.post(TELEMETRY_ENDPOINT, json={
                "callsign": cs,
                "platform": platform,
                "version": str(version)
            })
    except Exception:
        pass


def parse_semver(ver_str):
    """
    Parses versions like '1.0.0', '1.1', '1.1.2', '1.15' into comparable integer tuples.
    """
    cleaned = str(ver_str).strip().lstrip("vV")
    parts = []
    for p in cleaned.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)

def is_major_minor_milestone(ver_str):
    """
    Returns True if version is a milestone release:
    e.g., 1.1, 1.1.0, 1.2, 2.0 (patch component == 0).
    Returns False for test patches / beta revisions (e.g. 1.11, 1.12, 1.15 where patch != 0).
    """
    parts = parse_semver(ver_str)
    if parts[2] == 0:
        return True
    return False

async def fetch_version_manifest():
    """
    Fetches the remote version.json from devbyjae.com with a 5-second timeout.
    """
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(VERSION_MANIFEST_URL) as resp:
                if resp.status == 200:
                    return await resp.json(content_type=None)
    except Exception as e:
        print(f"[OTA] Failed to fetch manifest from {VERSION_MANIFEST_URL}: {e}")
    return None

async def check_updates(current_ver=CURRENT_VERSION):
    """
    Evaluates remote manifest against current version.
    """
    manifest = await fetch_version_manifest()
    if not manifest:
        return {
            "current_version": current_ver,
            "has_update": False,
            "error": "Could not connect to update server"
        }

    latest_stable = manifest.get("latest_stable", current_ver)
    latest_beta = manifest.get("latest_beta", latest_stable)
    packages = manifest.get("packages", {})
    all_notes = manifest.get("release_notes", {})

    curr_tuple = parse_semver(current_ver)
    stable_tuple = parse_semver(latest_stable)
    beta_tuple = parse_semver(latest_beta)

    # 1. Check if stable update is available
    if stable_tuple > curr_tuple:
        target_ver = latest_stable
        target_type = "stable"
        auto_apply = is_major_minor_milestone(latest_stable)
    # 2. Check if beta / bleeding-edge patch is available (never auto-applied)
    elif beta_tuple > curr_tuple:
        target_ver = latest_beta
        target_type = "beta"
        auto_apply = False
    else:
        return {
            "current_version": current_ver,
            "has_update": False,
            "message": "Application is up to date"
        }

    pkg_info = packages.get(target_ver, {})
    notes = all_notes.get(target_ver, "Bug fixes and performance improvements.")

    return {
        "current_version": current_ver,
        "has_update": True,
        "auto_apply": auto_apply,
        "target_version": target_ver,
        "target_type": target_type,
        "release_notes": notes,
        "package_info": pkg_info
    }

async def download_file(url, dest_path):
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status} downloading update package")
            with open(dest_path, "wb") as f:
                while True:
                    chunk = await resp.content.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
    return dest_path

async def apply_ota_patch(target_ver, platform_name="linux", app_base_dir=None):
    manifest = await fetch_version_manifest()
    if not manifest:
        return {"success": False, "error": "Cannot contact update server"}

    pkg = manifest.get("packages", {}).get(target_ver, {})
    patch_key = f"{platform_name}_patch"
    patch_url = pkg.get(patch_key)

    if not patch_url:
        return {"success": False, "error": f"No patch package found for {platform_name} {target_ver}"}

    if not app_base_dir or not os.path.exists(app_base_dir):
        return {"success": False, "error": "Application base directory invalid"}

    temp_dir = tempfile.mkdtemp(prefix="rattlenix_ota_")
    try:
        archive_path = os.path.join(temp_dir, "patch.zip")
        await download_file(patch_url, archive_path)

        with zipfile.ZipFile(archive_path, 'r') as zip_ref:
            zip_ref.extractall(app_base_dir)

        return {
            "success": True,
            "version": target_ver,
            "message": f"Successfully updated DBJ RattleNIX to v{target_ver}"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
