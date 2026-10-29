# retag.py
#
# Called by Sockseek's on-complete hook after each successful track
# download. Rewrites artist, title, and album tags to match the parsed
# query, so files from different seeders end up with consistent metadata.
#
# Exit codes:
#   0  success (written or unchanged)
#   1  bad arguments
#   2  file not found
#   3  mutagen could not open the file
#   4  unsupported container format
#   5  save failed

import sys
from pathlib import Path

from mutagen import File as MutagenFile


def _norm(value: str) -> str:
    return value.strip().casefold()


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: retag.py <path> <artist> <title> [album]", file=sys.stderr)
        return 1

    path = Path(sys.argv[1])
    artist = sys.argv[2].strip()
    title = sys.argv[3].strip()
    album = sys.argv[4].strip() if len(sys.argv) > 4 else ""

    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 2

    try:
        audio = MutagenFile(str(path), easy=True)
    except Exception as exc:
        print(f"mutagen open failed: {exc}", file=sys.stderr)
        return 3

    if audio is None:
        print(f"unsupported container: {path.suffix}", file=sys.stderr)
        return 4

    changed = False

    current_artist = (audio.get("artist") or [""])[0]
    if _norm(current_artist) != _norm(artist):
        audio["artist"] = artist
        changed = True

    current_title = (audio.get("title") or [""])[0]
    if _norm(current_title) != _norm(title):
        audio["title"] = title
        changed = True

    if album:
        current_album = (audio.get("album") or [""])[0]
        if _norm(current_album) != _norm(album):
            audio["album"] = album
            changed = True

    if not changed:
        return 0

    try:
        audio.save()
    except Exception as exc:
        print(f"mutagen save failed: {exc}", file=sys.stderr)
        return 5

    return 0


if __name__ == "__main__":
    sys.exit(main())