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
PYTHON_BIN = sys.executable  # the venv's python
INPUT_DIR = PROJECT_DIR / "sldl_input"
INPUT_DIR.mkdir(exist_ok=True)


# ──────────────────────────────────────────────────────────────
# TRACK LIST PARSING
# ──────────────────────────────────────────────────────────────

def parse_track_list(text: str) -> List[Dict]:
    """
    Parse one track per line. Handles:
        Artist - Title
        Artist - Title (Album) [243]
        Title only (if no dash)
    """
    tracks = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        # Strip leading numbering ("1. ", "1) ")
        line = re.sub(r'^\d+[\.\)]\s*', '', line)

        # Defensive: strip a Sockseek property keyword if it ended up
        # at the start of a normal track line.
        line = re.sub(
            r'^(?:artist|album|title|length|year)\s*:\s*',
            '',
            line,
            flags=re.IGNORECASE,
        )

        # Extract trailing duration: [243] or [4:03]
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

        # Split on any dash variant
        parts = re.split(r'\s+[-–—]\s+', line, maxsplit=1)
        
        if len(parts) == 2:
            artist, rest = parts[0].strip(), parts[1].strip()
        else:
            # No dash found. Treat the whole line as a title search.
            artist = ""
            rest = line.strip()

        # Trailing parentheses = album
        album = ""
        m = re.search(r'\(([^)]+)\)\s*$', rest)
        if m:
            album = m.group(1).strip()
            rest = rest[:m.start()].strip()

        if rest: # We only require a title, artist is optional now
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
    """True if the daemon's HTTP API responds."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{DAEMON_URL}/api/server/status")
            return r.status_code == 200
    except Exception:
        return False


async def daemon_is_ready(timeout: float = 3.0) -> bool:
    """True if the daemon is alive AND connected to Soulseek."""
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
    pref_bitrate: int = 320,
    length_tol: int = 5,
    album_mode: bool = False,
    playlist_name: str = "",
) -> Dict:
    csv_path = _write_csv(tracks, job_id)
    print("[submit_extract_job] csv path:", csv_path)

    # The JSON hierarchy is:
    # options -> downloadSettings -> search -> necessaryCond
    
    body = {
        "input": str(csv_path),
        "inputType": "csv",
        "autoStartExtractedResult": True,
        "options": {
            "outputParentDir": output_dir,
            "downloadSettings": {
                "output": {
                    "parentDir": output_dir,
                    "nameFormat": "{artist} - {title}",
                },
                "search": {
                    "necessaryCond": {
                        "artistMaybeWrong": True,
                        "acceptNoLength": True,  # Prevents the 0-second length rejection bug
                    }
                }
            },
        },
    }

    print("[submit_extract_job] body:", json.dumps(body, indent=2))

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
            # Try tree endpoint first
            r = await client.get(
                f"{DAEMON_URL}/api/workflows/{workflow_id}/tree",
                headers={"Accept": "application/json"}
            )
            if r.status_code == 200:
                return r.json()
            
            # Fallback to flat workflow endpoint
            r2 = await client.get(
                f"{DAEMON_URL}/api/workflows/{workflow_id}",
                headers={"Accept": "application/json"}
            )
            if r2.status_code == 200:
                data = r2.json()
                # Construct a pseudo-tree from the flat list
                return {"summary": data.get("summary"), "jobs": data.get("jobs")}
                
            print(f"[tree] status={r.status_code} (fallback: {r2.status_code})")
            return None
    except Exception as e:
        print(f"[tree] FAILED err={type(e).__name__}: {e}")
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
        walk(root)
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
    last_message = None
    consecutive_failures = 0

    # Initialize counters so the fallback block can use them safely
    total = job.get("total", 0)
    downloaded = 0
    failed = 0
    skipped = 0

    while True:
        tree = await get_workflow_tree(workflow_id)
        
        if tree is None:
            consecutive_failures += 1
            if consecutive_failures > 20:
                job["status"] = "error"
                job["message"] = "Lost connection to Sockseek daemon"
                return
            
            # Fallback: If workflow tree is 404, check if the root job is already done
            if root_job_id:
                root_detail = await get_job_detail(root_job_id)
                if root_detail and root_detail.get("summary"):
                    root_summary = root_detail["summary"]
                    outcome = root_summary.get("terminalOutcome")
                    
                    if outcome in ("Succeeded", "Failed", "PartialSuccess", "Cancelled"):
                        if outcome == "Succeeded":
                            job["status"] = "complete"
                            job["downloaded"] = total
                            job["failed"] = 0
                        elif outcome == "PartialSuccess":
                            job["status"] = "partial"
                            # We don't know the exact split, but we know it's partial
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
            await asyncio.sleep(poll_interval)
            continue

        # Reset failure counter if we successfully got the tree
        consecutive_failures = 0
        
        summary = tree.get("summary") or {}
        state = summary.get("state", "active")

        nodes = _flatten_tree(tree)
        song_nodes = [n for n in nodes if (n.get("summary") or {}).get("kind") == "song"]

        # Only update total if we actually found song nodes
        if song_nodes:
            total = len(song_nodes)
        
        downloaded = 0
        failed = 0
        skipped = 0

        for n in song_nodes:
            s = n.get("summary") or {}
            outcome = s.get("terminalOutcome")
            skip_reason = s.get("skipReason") or "None"

            if skip_reason != "None":
                skipped += 1
                continue

            if outcome == "Succeeded":
                downloaded += 1
            elif outcome in ("Failed", "PartialSuccess"):
                failed += 1

        job["downloaded"] = downloaded
        job["failed"] = failed
        job["skipped"] = skipped
        job["total"] = total
        job["progress"] = (downloaded + failed + skipped) / max(total, 1)

        active = [n for n in nodes if (n.get("summary") or {}).get("lifecycleState") == "Running"]
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

        # Fetch detail for each song job that needs it
        for n in song_nodes:
            s = n.get("summary") or {}
            jid = s.get("jobId")
            if not jid:
                continue

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
            filename = payload.get("resolvedFilename")
            query = payload.get("query") or {}
            track_key = (query.get("title") or s.get("queryText") or "").strip()

            if filename and username:
                entry_key = f"{track_key}|{username}"
                if entry_key not in job["browse_index"]:
                    idx = len(job["browse_entries"])
                    job["browse_index"][entry_key] = idx
                    job["browse_entries"].append({
                        "track": track_key,
                        "seeder": username,
                        "path": filename,
                        "state": "done" if outcome == "Succeeded" else "active",
                    })
                else:
                    idx = job["browse_index"][entry_key]
                    job["browse_entries"][idx]["state"] = (
                        "done" if outcome == "Succeeded" else "active"
                    )

            if outcome == "Succeeded" and username:
                key = f"{track_key}|{username}"
                if key not in seen_track_keys:
                    seen_track_keys.add(key)
                    counted_seeders[username] = counted_seeders.get(username, 0) + 1
                    job["leechers"] = dict(counted_seeders)

        # Terminal check
        if state != "active":
            if state == "completed":
                job["status"] = "complete" if failed == 0 else "partial"
            else:
                job["status"] = "error" if downloaded == 0 else "partial"
            job["finished_at"] = summary.get("title", "")
            if log_cb:
                log_cb(f"Workflow finished: {state} ({downloaded}/{total})")
            return

        await asyncio.sleep(poll_interval)