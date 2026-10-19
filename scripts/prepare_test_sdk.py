"""Pin the direct-test SDK bundle; upstream renamed its release asset in v0.3.

The contract header still selects the exact content-addressed runner inside this
bundle. Keep this project cache separate from other projects' SDK versions.
"""
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request

VERSION = "v0.3.0-rc7"
SHA256 = "e218a1854214681560351051f76fe2b878545cf3409455ef372d57014a88ca67"
# The SDK's VM cleanup recognizes paths containing "gltest-direct".
CACHE = Path(__file__).resolve().parents[1] / ".genlayer" / "gltest-direct"
FILENAME = f"genvm-universal-{VERSION}.tar.xz"
URL = f"https://github.com/genlayerlabs/genvm/releases/download/{VERSION}/genvm-runners-all.tar.xz"


def verified(path: Path) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == SHA256


def prepare() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / FILENAME
    if not verified(target):
        existing = Path.home() / ".cache" / "gltest-direct" / FILENAME
        with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            try:
                if verified(existing):
                    with existing.open("rb") as source:
                        shutil.copyfileobj(source, temporary)
                else:
                    print(f"Downloading pinned test SDK {VERSION}...", flush=True)
                    request = urllib.request.Request(URL, headers={"User-Agent": "ombuds-tests"})
                    with urllib.request.urlopen(request, timeout=300) as source:
                        shutil.copyfileobj(source, temporary)
                temporary.flush()
                if not verified(temporary_path):
                    raise RuntimeError("Test SDK checksum mismatch; refusing to load the bundle")
                os.replace(temporary_path, target)
            finally:
                temporary_path.unlink(missing_ok=True)
    return CACHE


if __name__ == "__main__":
    from gltest.direct import sdk_loader

    sdk_loader.CACHE_DIR = prepare()
    sdk_loader.setup_sdk_paths(CACHE.parents[1] / "contracts" / "advance_pool.py", VERSION)
    print(f"Verified and extracted test SDK: {CACHE / FILENAME}")
