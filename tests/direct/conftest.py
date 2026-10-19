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
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
from scripts.prepare_test_sdk import prepare
from gltest.direct import sdk_loader

sdk_loader.CACHE_DIR = prepare()
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
# Section headings the captured Aetna pages actually publish, verified against the
# fixtures. "Medically Necessary" and "Policy Limitations and Exclusions" were declared
# here for a long time and appear in neither document: the real heading is "Medical
# Necessity", and the exclusions one does not exist. _match_section resolved the
# mismatch by slug substring, so clause_id was being built from a heading the bulletin
# does not publish and no citation could be anchored to a section.
AETNA_SECTIONS = "Scope of Policy|Medical Necessity|Experimental, Investigational, or Unproven|Related Policies|Background"


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


def section_body(html: bytes, section: str, allowed=None) -> str:
    """Reproduce OmbudsCourt._section_body, so a test can quote the right section.

    The contract binds clause_quote to the body of the section named in clause_section,
    not to the document at large. A test that wants a citation the validator will accept
    therefore has to slice the same way the contract does: longest body wins, because the
    heading also appears once in the table of contents.
    """
    text = policy_text(html)
    sections = tuple(allowed if allowed is not None else AETNA_SECTIONS.split("|"))
    best = ""
    search_from = 0
    while True:
        start = text.find(section, search_from)
        if start < 0:
            break
        body_from = start + len(section)
        end = len(text)
        for other in sections:
            if other == section:
                continue
            where = text.find(other, body_from)
            if where >= 0 and where < end:
                end = where
        body = text[body_from:end]
        if len(body) > len(best):
            best = body
        search_from = body_from
    return best


def real_quote(html: bytes, minimum: int = 60, section: str = "Medical Necessity") -> str:
    """Pull a genuine sentence out of the section a verdict will cite.

    It has to come from that section specifically. The contract will refuse a quote that
    sits anywhere else in the document, because clause_section and clause_quote are
    stored and printed together and a reader follows the one to check the other.
    """
    region = section_body(html, section)
    if region == "":
        region = policy_text(html)
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
    section: str = "Medical Necessity",
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


def support_json(*, supported: bool = True, problem: str = "") -> str:
    """The validator's faithfulness check answer.

    Adjudication now costs two model calls on a validator and one on the leader. The
    leader decides. A validator decides again AND reads the leader's rationale back
    against the bulletin it fetched itself, because the leader's prose is what gets
    written to state and nothing else in the pipeline ever looks at it.
    """
    return json.dumps({"supported": supported, "problem": problem})


def leader_payload(direct_vm) -> dict:
    """The exact payload the leader handed back on the last adjudication.

    This is the thing the contract writes to state, so it is the thing a validator has
    to be able to reject. Lifting it out lets a test play a byzantine leader: take the
    honest payload, change one field, hand it to the validator and watch what happens.
    A real leader runs the honest code and cannot produce most of these, which is
    exactly why the validator cannot assume it did.
    """
    captured = getattr(direct_vm, "_captured_validators", None)
    if not captured:
        raise AssertionError("no validator captured, call adjudicate first")
    return dict(captured[-1][0])


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
def make_court(direct_deploy, direct_vm, direct_owner):
    """Build a court whose registry is stubbed, since direct mode runs one contract.

    Pass a lapse_reason to make the stubbed registry report the rule as unusable, which
    is how the gatekeeping tests work.
    """

    def build(*, lapse_reason: str = "", rule: dict | None = None, min_confidence: int = 70):
        direct_vm.sender = direct_owner
        direct_vm.warp("2026-06-15T10:00:00Z")
        stub = registry_stub(lapse_reason=lapse_reason, rule=rule)
        install_stubs(direct_vm, stub)
        contract = direct_deploy(
            CONTRACTS["court"], REGISTRY_ADDRESS, min_confidence, str(ATTO // 4)
        )
        return contract, stub

    return build


@pytest.fixture
def court(make_court):
    """A court with a live bariatric rule behind it."""
    contract, _ = make_court()
    return contract


CLEAN_RATIONALE = (
    "Benefit denied because the requested procedure is considered not medically necessary "
    "for this member under the applicable clinical policy."
)


def file_clean_case(court, *, disputed_atto=12_000 * ATTO, evidence=None, filer_address=""):
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
        filer_address,
    )

# ---------------------------------------------------------------- cross contract stubs
#
# Direct mode runs exactly one contract per VM, so a court cannot be deployed next to a
# real registry here. GenVM also forbids a cross contract call from inside a nondet block,
# which is why both contracts read their neighbour before the nondet work starts, and why
# a stub at the gl_call boundary is a faithful stand in rather than a shortcut.
#
# The genuine three contract wiring is exercised in tests/integration against studionet.


class ContractStub:
    """Answers CallContract and PostMessage for one address."""

    def __init__(self, address: str):
        self.address = address.lower()
        self.views: dict = {}
        self.calls: list = []

    def view(self, method: str, value):
        """Register a return value, or a callable taking the positional args."""
        self.views[method] = value
        return self


def install_stubs(vm, *stubs: ContractStub) -> None:
    """Install a gl_call hook that serves the given contract stubs.

    The genlayer package only exists once gltest has loaded the SDK, which happens when a
    contract is deployed. The hook runs later still, during contract execution, so the
    calldata codec is imported inside it rather than at module or fixture scope.
    """
    by_address = {stub.address: stub for stub in stubs}

    def hook(_vm, request):
        from genlayer.py import calldata as _calldata

        for key in ("CallContract", "PostMessage"):
            if key not in request:
                continue
            payload = request[key]
            raw = payload.get("address")
            address = _address_text(raw)
            stub = by_address.get(address)
            if stub is None:
                return None
            cd = payload.get("calldata") or {}
            method = cd.get("method", "")
            args = list(cd.get("args", []))
            stub.calls.append((method, args))
            if key == "PostMessage":
                # An emitted write is fire and forget. Nothing is returned to the caller.
                return bytes([0]) + _calldata.encode(None)
            if method not in stub.views:
                return bytes([1]) + f"stub has no view '{method}'".encode("utf-8")
            answer = stub.views[method]
            if callable(answer):
                answer = answer(*args)
            return bytes([0]) + _calldata.encode(answer)
        return None

    vm._gl_call_hook = hook


def _address_text(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.lower()
    as_bytes = bytes(raw) if hasattr(raw, "__bytes__") else None
    if as_bytes is not None:
        return "0x" + as_bytes.hex()
    return str(raw).lower()


REGISTRY_ADDRESS = "0x" + "11" * 20
COURT_ADDRESS = "0x" + "22" * 20

BARIATRIC_RULE = {
    "plan_id": "AETNA-COMMERCIAL-BARIATRIC",
    "insurer": "Aetna",
    "plan_line": "Commercial",
    "family_id": "bariatric_surgery",
    "bulletin_number": "0157",
    "bulletin_title": "Obesity Surgery",
    "bulletin_url": AETNA_0157,
    "fetch_mode": "html",
    "state": "US",
    "effective_from": "2026-01-01",
    "effective_to": "2027-01-01",
    "sbc_hash": "",
    "cms_source_url": CMS_100_1,
    "cms_display_id": "100.1",
    "guideline_url": "https://asmbs.org/resources/metabolic-and-bariatric-surgery/",
    "clause_sections": AETNA_SECTIONS.split("|"),
    "content_hash": "",
    "previous_content_hash": "",
    "last_refreshed": "",
    "registered_at": "2026-01-01T00:00:00Z",
    "refresh_count": 0,
    "revision_count": 0,
    "retired": False,
    "active": True,
    "as_of": "2026-06-15",
}


def registry_stub(*, lapse_reason: str = "", rule: dict | None = None) -> ContractStub:
    body = dict(rule or BARIATRIC_RULE)
    known = str(body["plan_id"])
    missing = f"No rule is registered for plan '{{}}'."

    def lapse(plan_id=""):
        if plan_id != known:
            return missing.format(plan_id)
        return lapse_reason

    def rule_for(plan_id=""):
        if plan_id != known:
            raise AssertionError(f"stub was asked for an unregistered plan '{plan_id}'")
        return body

    stub = ContractStub(REGISTRY_ADDRESS)
    stub.view("lapse_reason", lapse)
    stub.view("rule_for", rule_for)
    stub.view("is_rule_active", lambda plan_id="": plan_id == known and lapse_reason == "")
    return stub

