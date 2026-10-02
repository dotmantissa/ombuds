"""Shared fixtures for the Ombuds direct mode tests.

The web mocks here serve documents that were captured from the real sources, not invented
ones. tests/fixtures holds the genuine Aetna clinical policy bulletin pages and the genuine
CMS National Coverage Determination payloads, byte for byte as those hosts returned them.
That matters: the contracts slice policy text out of a page by looking for real section
headings, and a hand written stub would quietly prove nothing.

Re-capture them with scripts/capture_fixtures.py if a bulletin moves.
"""

import json
import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

CONTRACTS = {
    "registry": str(ROOT / "contracts" / "plan_registry.py"),
    "court": str(ROOT / "contracts" / "ombuds_court.py"),
    "pool": str(ROOT / "contracts" / "advance_pool.py"),
}

ATTO = 10**18

# The real published URLs the registry points at.
AETNA_0157 = "https://www.aetna.com/cpb/medical/data/100_199/0157.html"
AETNA_0004 = "https://www.aetna.com/cpb/medical/data/1_99/0004.html"
CMS_100_1 = "https://api.coverage.cms.gov/v1/data/ncd?ncdid=57&ncdver=5"
CMS_240_4 = "https://api.coverage.cms.gov/v1/data/ncd?ncdid=226&ncdver=3"

# Section headings the captured Aetna pages actually publish.
AETNA_SECTIONS = "Scope of Policy|Medically Necessary|Experimental, Investigational, or Unproven|Policy Limitations and Exclusions|Applicable CPT / HCPCS / ICD-10 Codes"


def fixture_bytes(name: str) -> bytes:
    path = FIXTURES / name
    if not path.exists():
        pytest.skip(f"fixture {name} is missing, run scripts/capture_fixtures.py")
    return path.read_bytes()


@pytest.fixture
def aetna_0157() -> bytes:
    return fixture_bytes("aetna_cpb_0157.html")


@pytest.fixture
def aetna_0004() -> bytes:
    return fixture_bytes("aetna_cpb_0004.html")


@pytest.fixture
def cms_100_1() -> bytes:
    return fixture_bytes("cms_ncd_100_1.json")


@pytest.fixture
def cms_240_4() -> bytes:
    return fixture_bytes("cms_ncd_240_4.json")


def serve(vm, url: str, body: bytes, status: int = 200) -> None:
    """Point a web mock at an exact URL, escaping the query string properly."""
    vm.mock_web(re.escape(url), {"status": status, "body": body})


def serve_host(vm, pattern: str, body: bytes, status: int = 200) -> None:
    vm.mock_web(pattern, {"status": status, "body": body})


@pytest.fixture
def bariatric_sources(aetna_0157, cms_100_1):
    """Both real documents the bariatric plan rule depends on."""

    def apply(vm):
        serve(vm, AETNA_0157, aetna_0157)
        serve(vm, CMS_100_1, cms_100_1)

    return apply


def policy_text(html: bytes) -> str:
    """Reproduce the contract's own normalisation, so a test can quote a real sentence."""
    raw = html.decode("utf-8", errors="ignore")
    raw = re.sub(r"<(script|style|noscript)\b[^>]*>.*?</\1>", " ", raw, flags=re.I | re.S)
    raw = re.sub(r"<!--.*?-->", " ", raw, flags=re.S)
    raw = re.sub(r"<[^>]*>", " ", raw)
    for needle, replacement in (
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
        ("&quot;", '"'), ("&#39;", "'"), ("&apos;", "'"), ("&rsquo;", "'"),
        ("&lsquo;", "'"), ("&ldquo;", '"'), ("&rdquo;", '"'),
        ("&mdash;", " "), ("&ndash;", " "),
    ):
        raw = raw.replace(needle, replacement)
    raw = re.sub(r"<[^>]*>", " ", raw)
    return re.sub(r"\s+", " ", raw).strip()


def real_quote(html: bytes, minimum: int = 60) -> str:
    """Pull a genuine sentence out of a captured bulletin, long enough to be citable."""
    text = policy_text(html)
    start = text.find("Scope of Policy")
    region = text[start:] if start >= 0 else text
    for sentence in re.split(r"(?<=\.)\s+", region):
        cleaned = sentence.strip()
        if minimum <= len(cleaned) <= 400 and "Aetna" in cleaned:
            return cleaned
    for sentence in re.split(r"(?<=\.)\s+", region):
        cleaned = sentence.strip()
        if minimum <= len(cleaned) <= 400:
            return cleaned
    return region[:200]


def verdict_json(
    quote: str,
    *,
    overturn: bool = True,
    ground: str = "MEDICAL_NECESSITY",
    section: str = "Medically Necessary",
    recoverable_usd: int = 4200,
    confidence: int = 86,
    reasoning: str = (
        "The bulletin covers this procedure when the stated criteria are met, and the "
        "denial letter does not say which criterion failed. On the facts given the "
        "criteria are met, so the denial does not follow from the insurer's own rule."
    ),
) -> str:
    return json.dumps(
        {
            "overturn_recommended": overturn,
            "ground": ground,
            "clause_section": section,
            "clause_quote": quote,
            "recoverable_usd": recoverable_usd,
            "confidence": confidence,
            "reasoning": reasoning,
        }
    )


@pytest.fixture
def registry(direct_deploy, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    direct_vm.warp("2026-06-15T10:00:00Z")
    return direct_deploy(CONTRACTS["registry"])


def register_bariatric(contract, *, effective_from="2026-01-01", effective_to="2027-01-01"):
    """Register the real Aetna obesity surgery bulletin against NCD 100.1."""
    return contract.register_rule(
        "AETNA-COMMERCIAL-BARIATRIC",
        "Aetna",
        "Commercial",
        "bariatric_surgery",
        "0157",
        "Obesity Surgery",
        AETNA_0157,
        "html",
        "US",
        effective_from,
        effective_to,
        CMS_100_1,
        "100.1",
        "https://asmbs.org/resources/metabolic-and-bariatric-surgery/",
        AETNA_SECTIONS,
    )


@pytest.fixture
def court_stack(direct_deploy, direct_vm, direct_owner):
    """A registry with the bariatric rule registered, plus a court pointed at it."""
    direct_vm.sender = direct_owner
    direct_vm.warp("2026-06-15T10:00:00Z")
    reg = direct_deploy(CONTRACTS["registry"])
    register_bariatric(reg)
    court = direct_deploy(CONTRACTS["court"], str(reg.address), 70, str(ATTO // 4))
    return reg, court


@pytest.fixture
def full_stack(court_stack, direct_deploy, direct_vm, direct_owner):
    """Registry, court and pool, wired the way deploy/deploy.mjs wires them."""
    reg, court = court_stack
    direct_vm.sender = direct_owner
    pool = direct_deploy(
        CONTRACTS["pool"],
        str(court.address),
        3500,
        1200,
        7000,
        ",".join(
            str(v) for v in (ATTO // 4, ATTO // 2, ATTO, ATTO * 2, ATTO * 3, ATTO * 4)
        ),
    )
    court.set_pool(str(pool.address))
    return reg, court, pool


CLEAN_RATIONALE = (
    "Benefit denied because the requested procedure is considered not medically necessary "
    "for this member under the applicable clinical policy."
)


def file_clean_case(court, *, disputed_atto=12_000 * ATTO, evidence=None):
    return court.file_case(
        "AETNA-COMMERCIAL-BARIATRIC",
        "bariatric_surgery",
        "TX",
        "43644|43775",
        "E66.01|Z68.41",
        "50",
        CLEAN_RATIONALE,
        "2026-04",
        str(disputed_atto),
        evidence or ("a" * 64),
    )
