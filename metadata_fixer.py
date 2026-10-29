# metadata_fixer.py
import asyncio
import re
from typing import Dict, List, Optional

import httpx

ITUNES_URL = "https://itunes.apple.com/search"


def _similarity(query: str, candidate: str) -> float:
    """
    Compare two strings by looking at overlapping words. 
    Handles scrambled input and split words (e.g., 'king snake' vs 'kingsnake').
    """
    # Extract alphanumeric words
    q_words = set(re.findall(r'\w+', query.lower()))
    c_words = set(re.findall(r'\w+', candidate.lower()))
    
    if not q_words or not c_words:
        return 0.0
        
    # 1. Exact word matches
    intersection = q_words.intersection(c_words)
    score = len(intersection) / min(len(q_words), len(c_words))
    
    # 2. Partial word matches (e.g., 'king' matches 'kingsnake')
    for qw in q_words:
        for cw in c_words:
            if qw != cw and (qw in cw or cw in qw):
                score += 0.2
                
    return min(score, 1.0)


async def _query_itunes(client: httpx.AsyncClient, term: str) -> Optional[Dict]:
    """Query the iTunes Search API and return the best matching song result."""
    try:
        r = await client.get(
            ITUNES_URL,
            params={
                "term": term,
                "entity": "song",
                "limit": 5,
                "country": "US",
            },
            timeout=5.0,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        results = data.get("results", [])
        if not results:
            return None

        # Pick the result whose artist+title is closest to the query
        best = None
        best_score = 0.0
        for item in results:
            artist = item.get("artistName", "")
            title = item.get("trackName", "")
            
            # Check both the combined string and the title alone
            score = max(
                _similarity(term, f"{artist} {title}"),
                _similarity(term, title)
            )
            
            if score > best_score:
                best_score = score
                best = item

        # Lowered threshold to 0.4 because our new word-matcher is much smarter
        if best and best_score > 0.4:
            return best
        return None
    except Exception:
        return None


async def canonicalize_tracks(
    tracks: List[Dict],
    *,
    rate_limit_delay: float = 3.1,  # ~20 requests per minute
) -> List[Dict]:
    """
    For each track that looks like manual input (no album, no duration),
    query iTunes to get the canonical artist, title, album, and duration.
    If no good match is found, the original track is kept unchanged.
    """
    fixed: List[Dict] = []

    async with httpx.AsyncClient() as client:
        for t in tracks:
            artist = (t.get("artist") or "").strip()
            title = (t.get("title") or "").strip()

            # Only canonicalize manual entries. VK tracks already have album/duration.
            is_manual = not t.get("album") and not t.get("duration")
            if not is_manual or not title:
                fixed.append(t)
                continue

            term = f"{artist} {title}".strip() if artist else title
            match = await _query_itunes(client, term)

            if match:
                duration_ms = match.get("trackTimeMillis")
                fixed.append({
                    "artist": match.get("artistName", artist) or artist,
                    "title": match.get("trackName", title) or title,
                    "album": match.get("collectionName", ""),
                    "duration": int(duration_ms / 1000) if duration_ms else t.get("duration", 0),
                })
                print(f"[metadata] Corrected '{term}' -> '{match.get('artistName')} - {match.get('trackName')}'")
            else:
                print(f"[metadata] No good match found for '{term}', keeping original.")
                fixed.append(t)

            # Respect the rate limit (~20 calls/min)
            await asyncio.sleep(rate_limit_delay)

    return fixed