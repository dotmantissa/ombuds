#!/usr/bin/env python3
"""Re-capture the source documents the direct mode tests run against.

tests/fixtures holds the real Aetna clinical policy bulletin pages and the real CMS
National Coverage Determination payloads, byte for byte as those hosts returned them.
The contracts slice policy text out of a page by looking for real section headings, so a
hand written stub would quietly prove nothing. When a bulletin moves, re-capture rather
than edit.

    python3 scripts/capture_fixtures.py            re-capture anything missing
    python3 scripts/capture_fixtures.py --force    re-capture everything
    python3 scripts/capture_fixtures.py --check    report drift, write nothing

`--check` is the one worth wiring into CI. It tells you a bulletin changed under you,
which is a real event this project cares about: the registry tracks exactly that through
content_hash and revision_count.
"""

import argparse
import hashlib
import pathlib
import ssl
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

# The exact URLs the registry points at, and the exact filenames conftest.py asks for.
# Keep these in step with tests/direct/conftest.py and deploy/seed_registry.mjs.
SOURCES = (
    (
        "aetna_cpb_0157.html",
        "https://www.aetna.com/cpb/medical/data/100_199/0157.html",
        "Aetna CPB 0157, obesity surgery",
    ),
    (
        "aetna_cpb_0004.html",
        "https://www.aetna.com/cpb/medical/data/1_99/0004.html",
        "Aetna CPB 0004, obstructive sleep apnea",
    ),
    (
        "cms_ncd_100_1.json",
        "https://api.coverage.cms.gov/v1/data/ncd?ncdid=57&ncdver=5",
        "CMS NCD 100.1, bariatric surgery",
    ),
    (
        "cms_ncd_240_4.json",
        "https://api.coverage.cms.gov/v1/data/ncd?ncdid=226&ncdver=3",
        "CMS NCD 240.4, continuous positive airway pressure",
    ),
)


def fetch(url: str) -> bytes:
    context = ssl.create_default_context()
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=45, context=context) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} answered {response.status}")
        return response.read()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-capture even if present")
    parser.add_argument("--check", action="store_true", help="report drift, write nothing")
    args = parser.parse_args()

    FIXTURES.mkdir(parents=True, exist_ok=True)
    drifted = 0
    failed = 0

    for name, url, label in SOURCES:
        path = FIXTURES / name
        present = path.exists()

        if present and not (args.force or args.check):
            print(f"  kept     {name}  ({label})")
            continue

        try:
            fresh = fetch(url)
        except (urllib.error.URLError, RuntimeError, OSError) as err:
            print(f"  FAILED   {name}  {err}")
            failed += 1
            continue

        if present:
            current = path.read_bytes()
            if current == fresh:
                print(f"  same     {name}  {digest(fresh)}")
                continue
            drifted += 1
            if args.check:
                print(f"  DRIFTED  {name}  {digest(current)} -> {digest(fresh)}  ({label})")
                continue
            print(f"  updated  {name}  {digest(current)} -> {digest(fresh)}")
        else:
            if args.check:
                print(f"  MISSING  {name}  ({label})")
                drifted += 1
                continue
            print(f"  captured {name}  {digest(fresh)}  ({label})")

        path.write_bytes(fresh)

    if failed > 0:
        print(f"\n{failed} source(s) could not be reached. Nothing was written for those.")
        return 2
    if args.check and drifted > 0:
        print(
            f"\n{drifted} fixture(s) no longer match the live source. Re-run without "
            "--check to update them, then re-read the tests that quote the bulletin."
        )
        return 1
    print("\nFixtures are in step with the live sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
