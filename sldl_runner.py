# sldl_runner.py
import asyncio
import csv
import json
import re
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional

import httpx

# ──────────────────────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────────────────────

DAEMON_URL = "http://127.0.0.1:5030"
PROJECT_DIR = Path(__file__).parent
RETAG_SCRIPT = PROJECT_DIR / "retag.py"
PYTHON_BIN = sys.executable
INPUT_DIR = PROJECT_DIR / "sldl_input"
INPUT_DIR.mkdir(exist_ok=True)

# ──────────────────────────────────────────────────────────────
# TRACK LIST PARSING
# ──────────────────────────────────────────────────────────────

def parse_track_list(text: str) -> List[Dict]:
    tracks = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        line = re.sub(r'^\d+[\.\)]\s*', '', line)
        line = re.sub(r'^(?:artist|album|title|length|year)\s*:\s*', '', line, flags=re.IGNORECASE)

        duration = 0
        m = re.search(r'\[(\d+)\]$', line)
        if m:
            duration = int(m.group(1))
            line = line[:m.start()].strip()
        else:
            m = re.search(r'\[(\d+):(\d+)\]$', line)
            if m:
                duration = int(m.group(1)) * 60 + int(m.group(2))
                line = line[:m.start()].strip()

        parts = re.split(r'\s+[-–—]\s+', line, maxsplit=1)
        
        if len(parts) == 2:
            artist, rest = parts[0].strip(), parts[1].strip()
        else:
            artist = ""
            rest = line.strip()

        album = ""
        m = re.search(r'\(([^)]+)\)\s*$', rest)
        if m:
            album = m.group(1).strip()
            rest = rest[:m.start()].strip()

        if rest:
            tracks.append({
                "artist": artist,
                "title": rest,
                "album": album,
                "duration": duration,
            })

    return tracks

# ──────────────────────────────────────────────────────────────
# DAEMON CLIENT
# ──────────────────────────────────────────────────────────────

async def daemon_is_alive(timeout: float = 3.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{DAEMON_URL}/api/server/status")
            return r.status_code == 200
    except Exception:
        return False

async def daemon_is_ready(timeout: float = 3.0) -> bool:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{DAEMON_URL}/api/server/status")
            if r.status_code != 200:
                return False
            return bool(r.json().get("soulseekClient", {}).get("isReady"))
    except Exception:
        return False

def _write_csv(tracks: List[Dict], job_id: str) -> Path:
    csv_path = INPUT_DIR / f"{job_id}.csv"
    has_length = any(t.get("duration") for t in tracks)
    
    fieldnames = ["Artist", "Title", "Album"]
    if has_length:
        fieldnames.append("Length")

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for t in tracks:
            row = {
                "Artist": t.get("artist", ""),
                "Title": t.get("title", ""),
                "Album": t.get("album", ""),
            }
            if has_length:
                row["Length"] = t.get("duration", 0)
            writer.writerow(row)
    return csv_path

async def submit_extract_job(
    tracks: List[Dict],
    job_id: str,
    output_dir: str,
    *,
    format_pref: str = "flac,mp3",
    min_bitrate: int = 192,
) -> Dict:
    csv_path = _write_csv(tracks, job_id)
    
    necessary_cond = {
        "artistMaybeWrong": True,
        "acceptNoLength": True,
        "acceptMissingProps": True,
        "lengthTolerance": 5,
    }
    preferred_cond = {
        "minBitrate": 320,
        "formats": {"replace": ["flac"]},
    }

    if format_pref == "flac":
        necessary_cond["formats"] = {"replace": ["flac"]}
    elif format_pref == "mp3":
        necessary_cond["formats"] = {"replace": ["mp3"]}
    elif format_pref == "flac,mp3":
        pass # Allow defaults (m4a, opus, wav, etc.)

    if min_bitrate:
        necessary_cond["minBitrate"] = min_bitrate

    search_block = {
        "necessaryCond": necessary_cond,
        "preferredCond": preferred_cond,
        "searchTimeout": 15000,
        "maxStaleTime": 60000,
    }

    # Use {sartist} and {stitle} from the CSV.
    # The ( - ) and fallback logic ensures we never get "-.wav"
    name_format = "{sartist( - )stitle|slsk-filename}"

    # Pass source variables to retag.py
    on_complete_cmd = (
        'when=success scope=track hidden -- '
        f'"{PYTHON_BIN}" "{RETAG_SCRIPT}" '
        '"{path}" "{sartist}" "{stitle}" "{salbum}"'
    )

    body = {
        "input": str(csv_path),
        "inputType": "csv",
        "autoStartExtractedResult": True,
        "options": {
            "outputParentDir": output_dir,
            "downloadSettings": {
                "output": {
                    "parentDir": output_dir,
                    "nameFormat": name_format,
                    "onComplete": {"replace": [on_complete_cmd]},
                },
                "search": search_block
            },
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(f"{DAEMON_URL}/api/jobs/extract", json=body)
        if r.status_code >= 400:
            print("[daemon reject] status:", r.status_code)
            print("[daemon reject] body:", repr(r.text))
        r.raise_for_status()
        return r.json()

async def get_workflow_tree(workflow_id: str) -> Optional[Dict]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{DAEMON_URL}/api/workflows/{workflow_id}/tree",
                headers={"Accept": "application/json"}
            )
            if r.status_code == 200:
                return r.json()
            
            r2 = await client.get(
                f"{DAEMON_URL}/api/workflows/{workflow_id}?includeAll=true",
                headers={"Accept": "application/json"}
            )
            if r2.status_code == 200:
                data = r2.json()
                return {"summary": data.get("summary"), "jobs": data.get("jobs")}
                
            return None
    except Exception:
        return None

async def get_job_detail(job_id: str) -> Optional[Dict]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"{DAEMON_URL}/api/jobs/{job_id}")
            if r.status_code != 200:
                return None
            return r.json()
    except Exception:
        return None

async def cancel_workflow(workflow_id: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{DAEMON_URL}/api/workflows/{workflow_id}/cancel")
            return r.status_code in (200, 202)
    except Exception:
        return False

# ──────────────────────────────────────────────────────────────
# MIRRORING LOOP
# ──────────────────────────────────────────────────────────────

def _flatten_tree(tree: Dict) -> List[Dict]:
    out = []
    def walk(node):
        out.append(node)
        for child in node.get("children") or []:
            walk(child)
    for root in tree.get("jobs") or []:
        if "summary" in root:
            walk(root)
        else:
            out.append({"summary": root, "children": []})
    return out

async def mirror_workflow(
    job: Dict,
    workflow_id: str,
    root_job_id: Optional[str] = None,
    *,
    log_cb: Optional[Callable[[str], None]] = None,
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
    poll_interval: float = 1.0,
) -> None:
    
    detail_cache: Dict[str, Dict] = {}
    counted_seeders: Dict[str, int] = {}
    seen_track_keys: set = set()
    logged_terminal_nodes: set = set()
    last_message = None
    consecutive_failures = 0
    consecutive_done = 0

    total = job.get("total", 0)
    downloaded = 0
    failed = 0
    skipped = 0

    while True:
        tree = await get_workflow_tree(workflow_id)
        
        if tree is None:
            consecutive_failures += 1
            
            if consecutive_failures > 300:
                job["status"] = "error"
                job["message"] = "Lost connection to Sockseek daemon"
                return
            
            if root_job_id:
                root_detail = await get_job_detail(root_job_id)
                if root_detail and root_detail.get("summary"):
                    root_summary = root_detail["summary"]
                    outcome = root_summary.get("terminalOutcome")
                    
                    if outcome in ("Succeeded", "Failed", "PartialSuccess", "Cancelled"):
                        tree_from_root = {"jobs": [{"summary": root_summary, "children": root_detail.get("children") or []}]}
                        fallback_nodes = _flatten_tree(tree_from_root)
                        fallback_active = [n for n in fallback_nodes if (n.get("summary") or {}).get("lifecycleState") == "Running"]
                        
                        if not fallback_active:
                            consecutive_done += 1
                            if consecutive_done > 3:
                                if outcome == "Succeeded":
                                    job["status"] = "complete"
                                    job["downloaded"] = total
                                    job["failed"] = 0
                                elif outcome == "PartialSuccess":
                                    job["status"] = "partial"
                                    job["downloaded"] = max(1, total - 1)
                                    job["failed"] = 1
                                else:
                                    job["status"] = "error"
                                    job["downloaded"] = 0
                                    job["failed"] = total

                                job["progress"] = 1.0
                                job["message"] = f"Finished - {outcome}"
                                job["finished_at"] = root_summary.get("title", "")
                                if log_cb:
                                    log_cb(f"Workflow finished (via root job fallback): {outcome}")
                                return

            if log_cb and consecutive_failures == 1:
                log_cb("Waiting for daemon to initialize...")
            elif log_cb and consecutive_failures == 30:
                log_cb("Daemon is unresponsive (check for Windows Firewall popup)...")
                
            await asyncio.sleep(poll_interval)
            continue

        consecutive_failures = 0
        
        summary = tree.get("summary") or {}
        state = summary.get("state", "active")

        nodes = _flatten_tree(tree)
        
        root_nodes = [n for n in nodes if not (n.get("summary") or {}).get("parentJobId")]
        root_outcome = "None"
        if root_nodes:
            root_outcome = (root_nodes[0].get("summary") or {}).get("terminalOutcome", "None")

        song_nodes = [n for n in nodes if (n.get("summary") or {}).get("kind") == "song"]

        if song_nodes:
            total = len(song_nodes)
        
        downloaded = 0
        failed = 0
        skipped = 0

        for n in song_nodes:
            s = n.get("summary") or {}
            jid = s.get("jobId")
            outcome = s.get("terminalOutcome")
            skip_reason = s.get("skipReason") or "None"
            track_key = (s.get("queryText") or s.get("itemName") or "Unknown Track").strip()

            if skip_reason != "None":
                skipped += 1
                if log_cb and jid not in logged_terminal_nodes:
                    logged_terminal_nodes.add(jid)
                    log_cb(f"[Skipped] {track_key} ({skip_reason})")
                continue

            if outcome == "Succeeded":
                downloaded += 1
                if log_cb and jid not in logged_terminal_nodes:
                    logged_terminal_nodes.add(jid)
                    log_cb(f"[Done] {track_key}")
            elif outcome in ("Failed", "PartialSuccess"):
                failed += 1
                if log_cb and jid not in logged_terminal_nodes:
                    logged_terminal_nodes.add(jid)
                    log_cb(f"[Failed] {track_key} ({s.get('failureMessage', 'Unknown error')})")

        job["downloaded"] = downloaded
        job["failed"] = failed
        job["skipped"] = skipped
        job["total"] = total
        job["progress"] = (downloaded + failed + skipped) / max(total, 1)

        active = [
            n for n in nodes
            if (n.get("summary") or {}).get("lifecycleState") == "Running" or 
               (n.get("summary") or {}).get("activityPhase") in ("RunningOnComplete", "Organizing", "Downloading")
        ]
        
        if active:
            top = (active[-1].get("summary") or {})
            msg = f"{top.get('kind', 'job')}: {top.get('queryText', '')}"
            if msg != last_message:
                last_message = msg
                job["message"] = msg
                if log_cb:
                    log_cb(msg)
        elif state == "completed":
            job["message"] = f"Done - {downloaded} downloaded, {failed} failed, {skipped} skipped"
        elif state == "failed":
            job["message"] = f"Failed - {downloaded} downloaded, {failed} failed"

        if progress_cb:
            progress_cb(downloaded, total, job["message"])

        for n in song_nodes:
            s = n.get("summary") or {}
            jid = s.get("jobId")
            outcome = s.get("terminalOutcome")
            phase = s.get("activityPhase")

            if outcome != "Succeeded" and phase != "Downloading":
                continue

            if jid not in detail_cache:
                detail = await get_job_detail(jid)
                if detail:
                    detail_cache[jid] = detail

            detail = detail_cache.get(jid)
            if not detail:
                continue

            payload = detail.get("payload") or {}
            username = payload.get("resolvedUsername")
            query = payload.get("query") or {}
            track_key = (query.get("title") or s.get("queryText") or "").strip()

            if outcome == "Succeeded" and username:
                key = f"{track_key}|{username}"
                if key not in seen_track_keys:
                    seen_track_keys.add(key)
                    counted_seeders[username] = counted_seeders.get(username, 0) + 1
                    job["leechers"] = dict(counted_seeders)

        # Only exit if the root job is completely finished AND no child jobs are running.
        if root_outcome in ("Succeeded", "Failed", "PartialSuccess", "Cancelled"):
            if not active:
                consecutive_done += 1
                if consecutive_done > 3: # Wait 3 seconds for any final logs
                    if root_outcome == "Succeeded":
                        job["status"] = "complete"
                    elif root_outcome == "PartialSuccess" or (root_outcome == "Failed" and downloaded > 0):
                        job["status"] = "partial"
                    else:
                        job["status"] = "error"
                        
                    job["finished_at"] = summary.get("title", "")
                    if log_cb:
                        log_cb(f"Workflow completely finished: {root_outcome} ({downloaded}/{total})")
                    return
            else:
                consecutive_done = 0
        else:
            consecutive_done = 0

        await asyncio.sleep(poll_interval)