# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
OmbudsCourt
===========

The adjudicator. It decides whether a denied health insurance claim should be overturned,
and it decides it the only way that is worth anything: by reading the insurer's own
published rule and checking the denial against it.

Why this belongs on chain
-------------------------
An off-chain model that says "this denial looks wrong" is worth nothing. The insurer will
not accept a chatbot's opinion and neither will a state regulator. What has value is a
verdict that several independent validators each reached by re-fetching the same public
documents, that is timestamped and immutable, that carries the citation it rests on, and
that had real money staked on being right. That is a consensus object, not an inference,
and it is the thing capital will advance against.

What gets compared, and why those four things
---------------------------------------------
A validator does not read the leader's reasoning and nod along. It re-runs the whole job:
re-fetches the bulletin and the coverage determination at the same URLs, re-audits the
codes, asks the question again, and then compares exactly four fields.

1. overturn_recommended. The decision. Exact match.
2. ground. One of five values. Exact match. A disagreement about whether this is a coding
   error or a medical necessity dispute is a real disagreement, because it changes the
   appeal letter and the statute you file under.
3. clause_id. The section of the bulletin being turned against the denial. Exact match.
   This is the anti hallucination clamp, and it is checkable precisely because the section
   is in the document both sides just re-fetched. A model that invents a clause cannot
   survive it.
4. recoverable_band. A discrete band, never a continuous figure. Two honest readers will
   never agree on $4,312.88, and they do not need to. They need to agree that the money
   at stake sits between two thousand and seven and a half thousand dollars.

Free text is handled differently. The quoted clause is not compared between validators,
because two readers can cite different sentences from the same section and both be right.
Instead each validator verifies independently that the sentence it is about to commit
actually appears, verbatim, in the document it just fetched. A quote that cannot be found
raises an LLM error, which forces a rotation rather than locking a fabricated citation
into state.

The code audit is deliberately not asked of a model
---------------------------------------------------
Models mangle code formats. They drop leading zeros, they invent modifiers, they cannot
reliably count characters. So CPT and ICD-10 validity, and whether a code appears in the
bulletin's own applicable codes table, is computed in a sandbox and handed to the model as
ground truth it is told not to override.

Privacy
-------
Prompts are public on GenLayer. That is why nothing patient shaped is allowed in. file_case
runs a tripwire over every text field and refuses the filing if anything that looks like a
member id, a social security number, a phone number, an email address or a full date of
service gets through the client's de-identification. The original denial letter is
committed as a SHA-256 and never uploaded.

What this contract does not do
------------------------------
It does not give medical advice. It never decides whether a treatment is right for anyone.
It decides whether a denial is consistent with the coverage rule the insurer published,
which is a contract question.
"""

import json
import re
import hashlib
from dataclasses import dataclass

from genlayer import *


ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

# The five grounds an appeal can stand on. Closed set, compared exactly across validators.
GROUNDS = (
    "MEDICAL_NECESSITY",
    "CODING_ERROR",
    "NETWORK_STATUS",
    "PRIOR_AUTH_DEFECT",
    "TIMELINESS",
)

CASE_STATUSES = (
    "FILED",
    "VERDICT",
    "UNDER_REVIEW",
    "ADVANCED",
    "SETTLED",
    "REJECTED",
)

# Payout bands in whole dollars. The web client carries the identical boundaries in
# web/lib/bands.ts and any change has to be made in both places or the UI will label a
# verdict with a band the chain did not issue.
BAND_UPPER_USD = (500, 2000, 7500, 25000, 75000)

ATTO = 10**18

# Section headings a published bulletin actually uses. A verdict may only cite a section
# the registry declared for that bulletin, which keeps clause_id a closed enum and
# therefore comparable.
_SECTION_SLUG_RE = re.compile(r"[^a-z0-9]+")

_TAG_RE = re.compile(r"<[^>]*>")
_SCRIPT_RE = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_WS_RE = re.compile(r"\s+")
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_DOCKET_RE = re.compile(r"^OMB-\d{4}-\d{6}$")

_CPT_RE = re.compile(r"^(?:\d{5}|[A-Z]\d{4})$")
_ICD10_RE = re.compile(r"^[A-TV-Z]\d{2}(?:\.[0-9A-Z]{1,4})?$")

# The tripwire. If the client's de-identification let any of these through, the filing is
# refused rather than written to a public chain.
_PHI_PATTERNS = (
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("EMAIL", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    ("PHONE", re.compile(r"\b(?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b")),
    ("FULL_DATE", re.compile(r"\b(?:0?[1-9]|1[0-2])[/\-](?:0?[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}\b")),
    ("ISO_DATE", re.compile(r"\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b")),
    ("ZIP4", re.compile(r"\b\d{5}-\d{4}\b")),
    ("MRN", re.compile(r"\bMRN\b\s*[:#]?\s*[A-Za-z0-9]{4,}", re.IGNORECASE)),
    (
        "MEMBER_ID",
        re.compile(
            r"\b(?:member|subscriber|policy|group|certificate|claim)\s*"
            r"(?:id|no\.?|number|#)\s*[:#]?\s*[A-Za-z0-9\-]{6,}",
            re.IGNORECASE,
        ),
    ),
)

_ENTITIES = (
    ("&nbsp;", " "),
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", '"'),
    ("&#39;", "'"),
    ("&apos;", "'"),
    ("&rsquo;", "'"),
    ("&lsquo;", "'"),
    ("&ldquo;", '"'),
    ("&rdquo;", '"'),
    ("&mdash;", " "),
    ("&ndash;", " "),
)

CMS_RULE_FIELDS = ("item_service_description", "indications_limitations", "reasons_for_denial")


@allow_storage
@dataclass
class Case:
    """A de-identified case record. Nothing here identifies a patient."""

    docket: str
    filer: Address
    plan_id: str
    family_id: str
    state: str
    cpt_codes: str
    icd10_codes: str
    denial_reason_code: str
    denial_rationale: str
    service_month: str
    disputed_atto: u256
    evidence_sha256: str
    status: str
    filed_at: str
    panel_round: u256
    review_bond_atto: u256
    review_requester: str
    settled_atto: u256
    advanced_atto: u256


@allow_storage
@dataclass
class Verdict:
    docket: str
    overturn_recommended: bool
    ground: str
    clause_id: str
    clause_section: str
    clause_quote: str
    recoverable_band: u256
    confidence: u256
    reasoning: str
    citations: str
    bulletin_digest: str
    cms_digest: str
    digest: str
    adjudicated_at: str
    panel_round: u256


# -------------------------------------------------------------------- text normalisation


def _unescape(text: str) -> str:
    out = text
    for needle, replacement in _ENTITIES:
        out = out.replace(needle, replacement)
    return out


def _strip_markup(raw: str) -> str:
    body = _SCRIPT_RE.sub(" ", raw)
    body = _COMMENT_RE.sub(" ", body)
    body = _TAG_RE.sub(" ", body)
    body = _unescape(body)
    body = _TAG_RE.sub(" ", body)
    return _unescape(body)


def _collapse(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _chain_stamp() -> str:
    """The transaction datetime the chain supplied. Same for every validator."""
    raw = str(gl.message_raw.get("datetime", ""))
    if raw == "":
        return "1970-01-01T00:00:00Z"
    return raw


def _slug(text: str) -> str:
    return _SECTION_SLUG_RE.sub("-", text.strip().lower()).strip("-")


def _read_body(url: str) -> str:
    res = gl.nondet.web.get(url, headers={"User-Agent": "Ombuds/1.0 (+coverage-appeal)"})
    status = int(res.status)
    if status >= 500:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} source unreachable, status {status}")
    if status >= 400:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} source refused, status {status}")
    if res.body is None:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} source returned an empty body")
    return res.body.decode("utf-8", errors="ignore")


def _bulletin_text(url: str, fetch_mode: str) -> str:
    """The readable policy text of a published bulletin, normalised."""
    if fetch_mode == "json":
        body = _read_body(url)
        try:
            payload = json.loads(body)
        except ValueError:
            raise gl.vm.UserError(f"{ERROR_EXTERNAL} bulletin API returned content that is not JSON")
        rows = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(rows, list) or len(rows) == 0:
            raise gl.vm.UserError(f"{ERROR_EXTERNAL} bulletin API returned no document")
        record = rows[0]
        parts = []
        for field in CMS_RULE_FIELDS:
            value = record.get(field) if isinstance(record, dict) else None
            if isinstance(value, str) and value.strip() != "":
                parts.append(_collapse(_strip_markup(value)))
        text = " ".join(parts)
    else:
        text = _collapse(_strip_markup(_read_body(url)))

    if len(text) < 400:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} bulletin carried no readable policy text, {len(text)} chars"
        )
    return text


def _cms_rule_text(url: str) -> str:
    """The coverage determination's own criteria text. Empty url means none applies."""
    if url == "":
        return ""
    body = _read_body(url)
    try:
        payload = json.loads(body)
    except ValueError:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} coverage API returned content that is not JSON")
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) == 0:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} coverage API returned no document")
    record = rows[0]
    if not isinstance(record, dict):
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} coverage document had an unexpected shape")
    parts = []
    for field in CMS_RULE_FIELDS:
        value = record.get(field)
        if isinstance(value, str) and value.strip() != "":
            parts.append(_collapse(_strip_markup(value)))
    return " ".join(parts)


def _window(text: str, limit: int) -> str:
    """Trim evidence to a bounded size so the prompt stays inside the model's context."""
    if len(text) <= limit:
        return text
    return text[:limit]


# -------------------------------------------------------------------------- band and money


def band_for_usd(amount_usd: int) -> int:
    """Discrete payout band. Identical boundaries live in web/lib/bands.ts."""
    index = 0
    while index < len(BAND_UPPER_USD):
        if amount_usd < BAND_UPPER_USD[index]:
            return index
        index += 1
    return len(BAND_UPPER_USD)


def band_label(band: int) -> str:
    if band <= 0:
        return "under $500"
    if band >= len(BAND_UPPER_USD):
        return "$75,000 and above"
    lower = BAND_UPPER_USD[band - 1]
    upper = BAND_UPPER_USD[band]
    return f"${lower:,} to ${upper:,}"


# ------------------------------------------------------------------------- LLM resilience


def _parse_bool(raw) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, int):
        return raw != 0
    text = str(raw).strip().lower()
    if text in ("true", "yes", "y", "1", "overturn", "overturned"):
        return True
    if text in ("false", "no", "n", "0", "uphold", "upheld"):
        return False
    raise gl.vm.UserError(f"{ERROR_LLM} could not read a decision from '{raw}'")


def _parse_int(raw, label: str) -> int:
    if raw is None:
        raise gl.vm.UserError(f"{ERROR_LLM} missing '{label}'")
    text = str(raw).strip().replace(",", "").replace("$", "")
    if text == "":
        raise gl.vm.UserError(f"{ERROR_LLM} empty '{label}'")
    try:
        return int(round(float(text)))
    except (ValueError, TypeError):
        raise gl.vm.UserError(f"{ERROR_LLM} '{label}' was not a number: '{raw}'")


def _pick(payload: dict, primary: str, alternates: tuple):
    if primary in payload:
        return payload[primary]
    for alternate in alternates:
        if alternate in payload:
            return payload[alternate]
    return None


def _match_section(candidate: str, allowed: tuple) -> str:
    """Resolve a model's section name onto the closed set the registry declared."""
    wanted = _slug(candidate)
    if wanted == "":
        raise gl.vm.UserError(f"{ERROR_LLM} no clause section was cited")
    for section in allowed:
        if _slug(section) == wanted:
            return section
    for section in allowed:
        section_slug = _slug(section)
        if section_slug in wanted or wanted in section_slug:
            return section
    raise gl.vm.UserError(
        f"{ERROR_LLM} cited section '{candidate}' is not a section this bulletin publishes"
    )


def _verify_quote(quote: str, haystack: str) -> str:
    """A citation has to exist. Verified against the document this node just fetched.

    Not compared between validators, because two readers may quote different sentences
    from the same section and both be correct. Compared against the source instead, which
    is the check that actually matters.
    """
    cleaned = _collapse(quote)
    if len(cleaned) < 24:
        raise gl.vm.UserError(f"{ERROR_LLM} quoted clause was too short to verify")
    if cleaned in haystack:
        return cleaned
    # Allow a quote that was trimmed mid sentence by matching a generous leading run.
    probe = cleaned[:120]
    if len(probe) >= 60 and probe in haystack:
        return probe
    raise gl.vm.UserError(
        f"{ERROR_LLM} quoted clause does not appear in the fetched bulletin, "
        "the citation was fabricated"
    )


def _handle_leader_error(leaders_res, leader_fn) -> bool:
    """Agree about failure only when the failure is the same deterministic failure.

    A dead cms.gov is not a disagreement, so two nodes that both hit a transient failure
    agree. An LLM failure is always a disagreement, which forces the panel to rotate
    rather than locking broken output into state.
    """
    leader_msg = leaders_res.message if hasattr(leaders_res, "message") else ""
    try:
        leader_fn()
        return False
    except gl.vm.UserError as err:
        validator_msg = err.message if hasattr(err, "message") else str(err)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


# --------------------------------------------------------------------------- code auditing


def audit_codes(cpt_list: tuple, icd_list: tuple, bulletin_text: str) -> list:
    """Deterministic code audit. Runs in a sandbox, never asked of a model.

    Two findings per code: whether the code is well formed, and whether the bulletin
    mentions it at all. The second one is the interesting one. A bulletin that lists the
    exact CPT code it is denying, in a section that says the procedure is covered when
    criteria are met, is the whole appeal in one line.
    """
    findings = []
    for code in cpt_list:
        normalised = code.strip().upper()
        if normalised == "":
            continue
        findings.append(
            {
                "code": normalised,
                "kind": "CPT",
                "well_formed": bool(_CPT_RE.match(normalised)),
                "appears_in_bulletin": normalised in bulletin_text,
            }
        )
    for code in icd_list:
        normalised = code.strip().upper()
        if normalised == "":
            continue
        findings.append(
            {
                "code": normalised,
                "kind": "ICD10",
                "well_formed": bool(_ICD10_RE.match(normalised)),
                "appears_in_bulletin": normalised in bulletin_text,
            }
        )
    return findings


def _audit_summary(findings: list) -> str:
    lines = []
    for item in findings:
        shape = "valid format" if item["well_formed"] else "MALFORMED"
        seen = "listed in the bulletin" if item["appears_in_bulletin"] else "not listed in the bulletin"
        lines.append(f"- {item['kind']} {item['code']}: {shape}, {seen}")
    if len(lines) == 0:
        return "- no codes were supplied"
    return "\n".join(lines)


def _split_codes(raw: str) -> tuple:
    return tuple([piece.strip().upper() for piece in raw.split("|") if piece.strip() != ""])


# ----------------------------------------------------------------------------- the contract


class OmbudsCourt(gl.Contract):
    owner: Address
    registry: Address
    pool: Address

    min_confidence: u256
    review_bond_atto: u256

    cases: TreeMap[str, Case]
    verdicts: TreeMap[str, Verdict]
    dockets: DynArray[str]
    by_filer: TreeMap[str, DynArray[str]]
    status_counts: TreeMap[str, u256]
    ground_counts: TreeMap[str, u256]

    # Bonds posted to escalate a verdict, held until the review resolves.
    bond_claimable: TreeMap[str, u256]
    bond_held_atto: u256

    case_seq: u256
    verdict_count: u256
    overturn_count: u256
    total_disputed_atto: u256
    total_overturned_atto: u256
    review_count: u256

    def __init__(self, registry_address: str, min_confidence: int, review_bond_atto: str) -> None:
        if not registry_address.startswith("0x") or len(registry_address) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} registry_address must be a 20 byte address")
        confidence = int(min_confidence)
        if confidence < 1 or confidence > 100:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} min_confidence must sit between 1 and 100")
        self.owner = gl.message.sender_address
        self.registry = Address(registry_address)
        self.pool = Address("0x" + "00" * 20)
        self.min_confidence = u256(confidence)
        self.review_bond_atto = u256(int(review_bond_atto))
        self.case_seq = u256(0)
        self.verdict_count = u256(0)
        self.overturn_count = u256(0)
        self.total_disputed_atto = u256(0)
        self.total_overturned_atto = u256(0)
        self.review_count = u256(0)
        self.bond_held_atto = u256(0)

    # ------------------------------------------------------------------------- internals

    def _assert_owner(self) -> None:
        if str(gl.message.sender_address) != str(self.owner):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} caller is not the court owner")

    def _case_or_raise(self, docket: str) -> Case:
        case = self.cases.get(docket)
        if case is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} no case filed under docket '{docket}'")
        return case

    def _bump_status(self, status: str, delta: int) -> None:
        current = int(self.status_counts.get(status, u256(0)))
        nxt = current + delta
        self.status_counts[status] = u256(nxt if nxt > 0 else 0)

    def _next_docket(self) -> str:
        nxt = int(self.case_seq) + 1
        self.case_seq = u256(nxt)
        year = _chain_stamp()[:4]
        return f"OMB-{year}-{nxt:06d}"

    # ----------------------------------------------------------------------------- views

    @gl.public.view
    def get_config(self) -> dict:
        return {
            "owner": str(self.owner),
            "registry": str(self.registry),
            "pool": str(self.pool),
            "min_confidence": int(self.min_confidence),
            "review_bond_atto": str(int(self.review_bond_atto)),
            "grounds": list(GROUNDS),
            "band_upper_usd": list(BAND_UPPER_USD),
        }

    @gl.public.view
    def get_case(self, docket: str) -> dict:
        case = self._case_or_raise(docket)
        return {
            "docket": case.docket,
            "filer": str(case.filer),
            "plan_id": case.plan_id,
            "family_id": case.family_id,
            "state": case.state,
            "cpt_codes": list(_split_codes(case.cpt_codes)),
            "icd10_codes": list(_split_codes(case.icd10_codes)),
            "denial_reason_code": case.denial_reason_code,
            "denial_rationale": case.denial_rationale,
            "service_month": case.service_month,
            "disputed_atto": str(int(case.disputed_atto)),
            "evidence_sha256": case.evidence_sha256,
            "status": case.status,
            "filed_at": case.filed_at,
            "panel_round": int(case.panel_round),
            "review_bond_atto": str(int(case.review_bond_atto)),
            "review_requester": case.review_requester,
            "settled_atto": str(int(case.settled_atto)),
            "advanced_atto": str(int(case.advanced_atto)),
            "has_verdict": self.verdicts.get(docket) is not None,
        }

    @gl.public.view
    def get_verdict(self, docket: str) -> dict:
        verdict = self.verdicts.get(docket)
        if verdict is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} no verdict has been issued for '{docket}'")
        band = int(verdict.recoverable_band)
        return {
            "docket": verdict.docket,
            "overturn_recommended": bool(verdict.overturn_recommended),
            "ground": verdict.ground,
            "clause_id": verdict.clause_id,
            "clause_section": verdict.clause_section,
            "clause_quote": verdict.clause_quote,
            "recoverable_band": band,
            "recoverable_band_label": band_label(band),
            "confidence": int(verdict.confidence),
            "reasoning": verdict.reasoning,
            "citations": json.loads(verdict.citations) if verdict.citations != "" else [],
            "bulletin_digest": verdict.bulletin_digest,
            "cms_digest": verdict.cms_digest,
            "digest": verdict.digest,
            "adjudicated_at": verdict.adjudicated_at,
            "panel_round": int(verdict.panel_round),
            "crosses_confidence_band": int(verdict.confidence) >= int(self.min_confidence),
        }

    @gl.public.view
    def verdict_digest(self, docket: str) -> str:
        verdict = self.verdicts.get(docket)
        if verdict is None:
            return ""
        return verdict.digest

    @gl.public.view
    def is_advanceable(self, docket: str) -> dict:
        """What the AdvancePool asks before it moves money.

        A verdict only unlocks an advance if it recommends overturning, it clears the
        confidence band, it is not currently under review, and nothing has been advanced
        against it already.
        """
        case = self.cases.get(docket)
        if case is None:
            return {"ok": False, "reason": "No case under that docket.", "band": 0}
        verdict = self.verdicts.get(docket)
        if verdict is None:
            return {"ok": False, "reason": "That case has not been adjudicated yet.", "band": 0}
        if not verdict.overturn_recommended:
            return {
                "ok": False,
                "reason": "The verdict upheld the denial, so there is nothing to advance against.",
                "band": 0,
            }
        if int(verdict.confidence) < int(self.min_confidence):
            return {
                "ok": False,
                "reason": "The verdict sits below the confidence band the pool requires.",
                "band": int(verdict.recoverable_band),
            }
        if case.status == "UNDER_REVIEW":
            return {"ok": False, "reason": "The verdict is under review.", "band": int(verdict.recoverable_band)}
        if int(case.advanced_atto) > 0:
            return {"ok": False, "reason": "An advance has already been made.", "band": int(verdict.recoverable_band)}
        return {
            "ok": True,
            "reason": "",
            "band": int(verdict.recoverable_band),
            "disputed_atto": str(int(case.disputed_atto)),
            "filer": str(case.filer),
        }

    @gl.public.view
    def docket_page(self, offset: int, limit: int) -> list:
        """Newest first, bounded. The public record of what this court has decided."""
        total = len(self.dockets)
        if total == 0:
            return []
        take = 20 if limit <= 0 else limit
        if take > 100:
            take = 100
        start = total - 1 - (offset if offset > 0 else 0)
        out = []
        index = start
        while index >= 0 and len(out) < take:
            docket = self.dockets[index]
            case = self.cases.get(docket)
            if case is not None:
                verdict = self.verdicts.get(docket)
                out.append(
                    {
                        "docket": docket,
                        "plan_id": case.plan_id,
                        "family_id": case.family_id,
                        "state": case.state,
                        "status": case.status,
                        "filed_at": case.filed_at,
                        "disputed_atto": str(int(case.disputed_atto)),
                        "overturn_recommended": bool(verdict.overturn_recommended)
                        if verdict is not None
                        else False,
                        "ground": verdict.ground if verdict is not None else "",
                        "recoverable_band": int(verdict.recoverable_band) if verdict is not None else 0,
                        "confidence": int(verdict.confidence) if verdict is not None else 0,
                    }
                )
            index -= 1
        return out

    @gl.public.view
    def cases_for_filer(self, filer: str) -> list:
        bucket = self.by_filer.get(filer)
        if bucket is None:
            return []
        return [d for d in bucket]

    @gl.public.view
    def court_stats(self) -> dict:
        grounds = {}
        for ground in GROUNDS:
            grounds[ground] = int(self.ground_counts.get(ground, u256(0)))
        statuses = {}
        for status in CASE_STATUSES:
            statuses[status] = int(self.status_counts.get(status, u256(0)))
        return {
            "case_count": len(self.dockets),
            "verdict_count": int(self.verdict_count),
            "overturn_count": int(self.overturn_count),
            "review_count": int(self.review_count),
            "total_disputed_atto": str(int(self.total_disputed_atto)),
            "total_overturned_atto": str(int(self.total_overturned_atto)),
            "bond_held_atto": str(int(self.bond_held_atto)),
            "grounds": grounds,
            "statuses": statuses,
        }

    @gl.public.view
    def bond_of(self, address: str) -> str:
        return str(int(self.bond_claimable.get(address, u256(0))))

    @gl.public.view
    def phi_scan(self, text: str) -> list:
        """Run the tripwire without filing anything.

        The client calls this before it submits so a member finds out that their letter
        still carries a member id while they can still fix it, rather than after a
        rejected transaction.
        """
        return [kind for kind, pattern in _PHI_PATTERNS if pattern.search(text) is not None]

    # ---------------------------------------------------------------------------- writes

    @gl.public.write
    def file_case(
        self,
        plan_id: str,
        family_id: str,
        state: str,
        cpt_codes: str,
        icd10_codes: str,
        denial_reason_code: str,
        denial_rationale: str,
        service_month: str,
        disputed_atto: str,
        evidence_sha256: str,
    ) -> str:
        """Open a case. Refuses anything patient shaped, and anything against a lapsed rule."""
        if _MONTH_RE.match(service_month) is None:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} service_month must be YYYY-MM, a full date is more than this "
                "contract is willing to hold"
            )
        if _HEX64_RE.match(evidence_sha256.lower()) is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} evidence_sha256 must be 64 hex characters")
        if len(state) != 2:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} state must be a two letter code")
        if denial_rationale.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the denial rationale sentence is required")
        if len(denial_rationale) > 2000:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the denial rationale sentence is too long")

        # The tripwire, over every free text field that will end up in a public prompt.
        for label, blob in (
            ("denial_rationale", denial_rationale),
            ("denial_reason_code", denial_reason_code),
            ("cpt_codes", cpt_codes),
            ("icd10_codes", icd10_codes),
        ):
            for kind, pattern in _PHI_PATTERNS:
                if pattern.search(blob) is not None:
                    raise gl.vm.UserError(
                        f"{ERROR_EXPECTED} {label} still contains something that looks like "
                        f"{kind}. Nothing identifying a patient is allowed on chain."
                    )

        cpt_tuple = _split_codes(cpt_codes)
        icd_tuple = _split_codes(icd10_codes)
        if len(cpt_tuple) == 0 and len(icd_tuple) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} at least one CPT or ICD-10 code is required")
        for code in cpt_tuple:
            if _CPT_RE.match(code) is None:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} '{code}' is not a CPT or HCPCS code")
        for code in icd_tuple:
            if _ICD10_RE.match(code) is None:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} '{code}' is not an ICD-10-CM code")

        disputed = int(disputed_atto)
        if disputed <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the disputed amount must be above zero")

        # The gate that lifted this design: never argue against a rule that has lapsed.
        registry = gl.get_contract_at(self.registry)
        lapse = str(registry.view().lapse_reason(plan_id))
        if lapse != "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} {lapse}")

        rule = registry.view().rule_for(plan_id)
        if str(rule["family_id"]) != family_id:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} plan '{plan_id}' covers "
                f"'{rule['family_id']}', not '{family_id}'"
            )

        docket = self._next_docket()
        stamp = _chain_stamp()
        filer = gl.message.sender_address

        self.cases[docket] = Case(
            docket=docket,
            filer=filer,
            plan_id=plan_id,
            family_id=family_id,
            state=state.upper(),
            cpt_codes="|".join(cpt_tuple),
            icd10_codes="|".join(icd_tuple),
            denial_reason_code=denial_reason_code,
            denial_rationale=denial_rationale,
            service_month=service_month,
            disputed_atto=u256(disputed),
            evidence_sha256=evidence_sha256.lower(),
            status="FILED",
            filed_at=stamp,
            panel_round=u256(1),
            review_bond_atto=u256(0),
            review_requester="",
            settled_atto=u256(0),
            advanced_atto=u256(0),
        )
        self.dockets.append(docket)
        self._bump_status("FILED", 1)
        self.total_disputed_atto = u256(int(self.total_disputed_atto) + disputed)

        self.by_filer.get_or_insert_default(str(filer)).append(docket)

        return docket

    @gl.public.write
    def adjudicate(self, docket: str) -> dict:
        """Read the insurer's own rule and decide whether the denial survives it.

        Everything the validators compare is built here. Nothing in the closure touches
        contract storage, because the closure is serialised and shipped to every node.
        """
        case = self._case_or_raise(docket)
        if case.status not in ("FILED", "UNDER_REVIEW"):
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} case '{docket}' is {case.status} and is not awaiting a verdict"
            )

        registry = gl.get_contract_at(self.registry)
        lapse = str(registry.view().lapse_reason(case.plan_id))
        if lapse != "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} {lapse}")
        rule = registry.view().rule_for(case.plan_id)

        # Plain locals only from here down. A storage proxy cannot be serialised.
        bulletin_url = str(rule["bulletin_url"])
        bulletin_number = str(rule["bulletin_number"])
        bulletin_title = str(rule["bulletin_title"])
        fetch_mode = str(rule["fetch_mode"])
        cms_url = str(rule["cms_source_url"])
        cms_display_id = str(rule["cms_display_id"])
        guideline_url = str(rule["guideline_url"])
        insurer = str(rule["insurer"])
        sections = tuple([str(s) for s in rule["clause_sections"] if str(s) != ""])
        if len(sections) == 0:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} the registered rule for '{case.plan_id}' declares no clause "
                "sections, so a verdict could not cite anything checkable"
            )

        cpt_tuple = _split_codes(case.cpt_codes)
        icd_tuple = _split_codes(case.icd10_codes)
        rationale = str(case.denial_rationale)
        reason_code = str(case.denial_reason_code)
        family = str(case.family_id)
        state_code = str(case.state)
        service_month = str(case.service_month)
        disputed_atto_int = int(case.disputed_atto)
        disputed_usd = disputed_atto_int // ATTO
        confidence_floor = int(self.min_confidence)
        allowed_grounds = GROUNDS

        def leader_fn() -> dict:
            bulletin = _bulletin_text(bulletin_url, fetch_mode)
            coverage = _cms_rule_text(cms_url)

            def run_audit() -> list:
                return audit_codes(cpt_tuple, icd_tuple, bulletin)

            # The audit runs in a sandbox so a malformed code cannot take the whole
            # transaction down with it. The sandbox is an isolation boundary, not a
            # source of truth: run_audit is pure, deterministic and reads nothing but its
            # arguments, so if the sandbox is unavailable the same function run inline
            # produces the identical answer. Every validator computes it the same way
            # either path, which is what the comparison depends on.
            sandboxed = None
            try:
                sandboxed = gl.vm.unpack_result(gl.vm.spawn_sandbox(run_audit))
            except Exception:
                sandboxed = None
            findings = sandboxed if isinstance(sandboxed, list) else run_audit()
            audit_text = _audit_summary(findings)

            prompt = f"""You are adjudicating a denied health insurance claim against the
coverage rule the insurer itself published. You are deciding a contract question, not a
medical one. Never comment on whether a treatment is advisable for anyone.

THE DENIAL
Insurer: {insurer}
Procedure family: {family}
Member state: {state_code}
Month of service: {service_month}
Denial reason code: {reason_code}
Amount in dispute: {disputed_usd} US dollars
The insurer's stated rationale, verbatim: "{rationale}"
CPT or HCPCS codes billed: {', '.join(cpt_tuple) if len(cpt_tuple) > 0 else 'none supplied'}
ICD-10-CM diagnosis codes: {', '.join(icd_tuple) if len(icd_tuple) > 0 else 'none supplied'}

GROUND TRUTH FROM A DETERMINISTIC CODE AUDIT. This was computed by running code, not by
reading. Do not override it, do not re-derive it, and do not contradict it.
{audit_text}

THE INSURER'S OWN PUBLISHED RULE
{insurer} bulletin {bulletin_number}, titled "{bulletin_title}".
Sections this bulletin publishes, and the only ones you may cite:
{chr(10).join('- ' + s for s in sections)}

Bulletin text:
{_window(bulletin, 14000)}

THE FEDERAL COVERAGE DETERMINATION
{('CMS ' + cms_display_id) if cms_display_id != '' else 'None applies to this procedure.'}
{_window(coverage, 6000) if coverage != '' else ''}

YOUR TASK
Decide whether this denial is consistent with the rule above. The single most persuasive
finding available to you is the insurer's own published text contradicting its own denial
letter, so look for that first.

Choose exactly one ground from this closed list:
- MEDICAL_NECESSITY: the bulletin's own criteria are met on the facts stated
- CODING_ERROR: the codes billed are handled differently by the bulletin than the denial assumed
- NETWORK_STATUS: the denial rests on a network or provider status question
- PRIOR_AUTH_DEFECT: the prior authorisation requirement was misapplied or did not apply
- TIMELINESS: the denial rests on a filing or notice deadline that was misapplied

Quote one sentence from the bulletin text above, copied exactly, character for character,
that carries your reasoning. Do not paraphrase it and do not stitch two sentences
together. If you cannot find a sentence that supports your conclusion, say the denial
stands.

Estimate what the member could recover, in whole US dollars, capped at the amount in
dispute. If the denial stands, that number is zero.

Return JSON with exactly these keys:
{{"overturn_recommended": true or false,
  "ground": "one of the five values above",
  "clause_section": "the exact section heading you are citing from the list",
  "clause_quote": "the verbatim sentence",
  "recoverable_usd": a whole number,
  "confidence": a whole number from 0 to 100,
  "reasoning": "two or three sentences a person who is not a lawyer can follow"}}"""

            answer = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(answer, dict):
                raise gl.vm.UserError(f"{ERROR_LLM} model returned {type(answer)} rather than JSON")

            overturn = _parse_bool(
                _pick(answer, "overturn_recommended", ("overturn", "overturned", "decision"))
            )

            ground_raw = _pick(answer, "ground", ("ground_of_appeal", "basis", "reason"))
            if ground_raw is None:
                raise gl.vm.UserError(f"{ERROR_LLM} missing 'ground'")
            ground = str(ground_raw).strip().upper().replace(" ", "_").replace("-", "_")
            if ground not in allowed_grounds:
                raise gl.vm.UserError(f"{ERROR_LLM} '{ground}' is not one of the five grounds")

            section_raw = _pick(answer, "clause_section", ("section", "clause", "clause_id"))
            section = _match_section(str(section_raw if section_raw is not None else ""), sections)

            quote_raw = _pick(answer, "clause_quote", ("quote", "citation", "excerpt"))
            quote = _verify_quote(str(quote_raw if quote_raw is not None else ""), bulletin)

            confidence = _parse_int(
                _pick(answer, "confidence", ("confidence_score", "certainty")), "confidence"
            )
            if confidence < 0:
                confidence = 0
            if confidence > 100:
                confidence = 100

            if overturn:
                recoverable = _parse_int(
                    _pick(answer, "recoverable_usd", ("recoverable", "recoverable_amount", "amount")),
                    "recoverable_usd",
                )
                if recoverable < 0:
                    recoverable = 0
                if recoverable > disputed_usd:
                    recoverable = disputed_usd
            else:
                recoverable = 0

            band = band_for_usd(recoverable) if overturn else 0

            reasoning = str(
                _pick(answer, "reasoning", ("analysis", "explanation", "rationale")) or ""
            ).strip()
            if len(reasoning) < 20:
                raise gl.vm.UserError(f"{ERROR_LLM} the verdict carried no readable reasoning")

            # Citations are assembled here, from the documents this node actually fetched,
            # rather than taken from the model. A model cannot invent a source it was not
            # given.
            citations = [
                {
                    "source": f"{insurer} clinical policy bulletin {bulletin_number}",
                    "title": bulletin_title,
                    "url": bulletin_url,
                    "locator": section,
                    "digest": _digest(bulletin),
                }
            ]
            if coverage != "":
                citations.append(
                    {
                        "source": f"CMS National Coverage Determination {cms_display_id}",
                        "title": "Medicare coverage criteria",
                        "url": cms_url,
                        "locator": "indications and limitations of coverage",
                        "digest": _digest(coverage),
                    }
                )
            if guideline_url != "":
                citations.append(
                    {
                        "source": "Published clinical guideline",
                        "title": "Guideline for the indication",
                        "url": guideline_url,
                        "locator": "",
                        "digest": "",
                    }
                )

            return {
                "overturn_recommended": overturn,
                "ground": ground,
                "clause_id": f"{bulletin_number}#{_slug(section)}",
                "clause_section": section,
                "clause_quote": quote[:900],
                "recoverable_band": band,
                "confidence": confidence,
                "reasoning": reasoning[:1200],
                "citations": json.dumps(citations, sort_keys=True),
                "bulletin_digest": _digest(bulletin),
                "cms_digest": _digest(coverage) if coverage != "" else "",
                "code_findings": json.dumps(findings, sort_keys=True),
            }

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)

            leader = leaders_res.calldata
            mine = leader_fn()

            # The decision itself.
            if bool(leader["overturn_recommended"]) != bool(mine["overturn_recommended"]):
                return False
            # The ground, which changes the letter and the statute filed under.
            if str(leader["ground"]) != str(mine["ground"]):
                return False
            # The clause being turned against the denial. The anti hallucination clamp.
            if str(leader["clause_id"]) != str(mine["clause_id"]):
                return False
            # The money, as a band rather than a figure.
            if int(leader["recoverable_band"]) != int(mine["recoverable_band"]):
                return False
            # Both readings must land on the same side of the line that releases an advance.
            leader_clears = int(leader["confidence"]) >= confidence_floor
            mine_clears = int(mine["confidence"]) >= confidence_floor
            if leader_clears != mine_clears:
                return False
            # The deterministic code audit must agree exactly. It is computed by code, so
            # any difference means the two nodes were not looking at the same bulletin.
            if str(leader["code_findings"]) != str(mine["code_findings"]):
                return False
            return True

        outcome = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        stamp = _chain_stamp()
        overturn = bool(outcome["overturn_recommended"])
        ground = str(outcome["ground"])
        band = int(outcome["recoverable_band"])
        confidence = int(outcome["confidence"])
        round_number = int(case.panel_round)

        digest_payload = json.dumps(
            {
                "docket": docket,
                "plan_id": case.plan_id,
                "overturn_recommended": overturn,
                "ground": ground,
                "clause_id": str(outcome["clause_id"]),
                "recoverable_band": band,
                "bulletin_digest": str(outcome["bulletin_digest"]),
                "cms_digest": str(outcome["cms_digest"]),
                "panel_round": round_number,
                "evidence_sha256": case.evidence_sha256,
            },
            sort_keys=True,
        )

        # Read the outgoing verdict into plain locals FIRST. `previous` is a view onto the
        # same storage slot the write below replaces, so reading it afterwards would read
        # back the new values and the running totals would silently stop being corrected.
        previous = self.verdicts.get(docket)
        had_verdict = previous is not None
        prior_overturn = bool(previous.overturn_recommended) if previous is not None else False
        prior_ground = str(previous.ground) if previous is not None else ""

        self.verdicts[docket] = Verdict(
            docket=docket,
            overturn_recommended=overturn,
            ground=ground,
            clause_id=str(outcome["clause_id"]),
            clause_section=str(outcome["clause_section"]),
            clause_quote=str(outcome["clause_quote"]),
            recoverable_band=u256(band),
            confidence=u256(confidence),
            reasoning=str(outcome["reasoning"]),
            citations=str(outcome["citations"]),
            bulletin_digest=str(outcome["bulletin_digest"]),
            cms_digest=str(outcome["cms_digest"]),
            digest=_digest(digest_payload),
            adjudicated_at=stamp,
            panel_round=u256(round_number),
        )

        if not had_verdict:
            self.verdict_count = u256(int(self.verdict_count) + 1)
            if overturn:
                self.overturn_count = u256(int(self.overturn_count) + 1)
                self.total_overturned_atto = u256(
                    int(self.total_overturned_atto) + int(case.disputed_atto)
                )
            self.ground_counts[ground] = u256(int(self.ground_counts.get(ground, u256(0))) + 1)
        else:
            if prior_overturn != overturn:
                if overturn:
                    self.overturn_count = u256(int(self.overturn_count) + 1)
                    self.total_overturned_atto = u256(
                        int(self.total_overturned_atto) + int(case.disputed_atto)
                    )
                else:
                    if int(self.overturn_count) > 0:
                        self.overturn_count = u256(int(self.overturn_count) - 1)
                    held = int(self.total_overturned_atto) - int(case.disputed_atto)
                    self.total_overturned_atto = u256(held if held > 0 else 0)
            if prior_ground != ground:
                prior = int(self.ground_counts.get(prior_ground, u256(0)))
                self.ground_counts[prior_ground] = u256(prior - 1 if prior > 0 else 0)
                self.ground_counts[ground] = u256(int(self.ground_counts.get(ground, u256(0))) + 1)

        self._bump_status(case.status, -1)
        case.status = "VERDICT"
        self._bump_status("VERDICT", 1)

        return {
            "docket": docket,
            "overturn_recommended": overturn,
            "ground": ground,
            "clause_id": str(outcome["clause_id"]),
            "clause_section": str(outcome["clause_section"]),
            "recoverable_band": band,
            "recoverable_band_label": band_label(band),
            "confidence": confidence,
            "crosses_confidence_band": confidence >= int(self.min_confidence),
            "digest": _digest(digest_payload),
            "panel_round": round_number,
            "adjudicated_at": stamp,
        }

    @gl.public.write.payable
    def request_review(self, docket: str) -> dict:
        """Escalate a verdict to a fresh panel. Costs a bond.

        This is the honest answer to "what if it is wrong". Either side can post the bond
        and send the case back for a second reading by different validators. The bond
        goes to whoever turns out to be right, which is what stops the appeal path from
        being free noise.

        The escalation itself runs through Optimistic Democracy, triggered against the
        adjudicating transaction. The contract's job is to record who paid, hold the
        bond, and open the case for a second round.
        """
        case = self._case_or_raise(docket)
        verdict = self.verdicts.get(docket)
        if verdict is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' has no verdict to review")
        if case.status == "UNDER_REVIEW":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already under review")
        if case.status in ("SETTLED", "REJECTED"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is closed")

        posted = int(gl.message.value)
        required = int(self.review_bond_atto)
        if posted < required:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} a review bond of {required} atto is required, {posted} was sent"
            )

        requester = str(gl.message.sender_address)
        self._bump_status(case.status, -1)
        case.status = "UNDER_REVIEW"
        case.panel_round = u256(int(case.panel_round) + 1)
        case.review_bond_atto = u256(posted)
        case.review_requester = requester
        self._bump_status("UNDER_REVIEW", 1)
        self.review_count = u256(int(self.review_count) + 1)
        self.bond_held_atto = u256(int(self.bond_held_atto) + posted)

        return {
            "docket": docket,
            "panel_round": int(case.panel_round),
            "bond_atto": str(posted),
            "requester": requester,
            "prior_digest": verdict.digest,
        }

    @gl.public.write
    def resolve_review(self, docket: str, verdict_changed: bool) -> dict:
        """Close a review and award the bond.

        If the second panel moved the verdict, the challenger was right and the bond comes
        back to them. If it did not, the bond stays with the court and funds the next
        member who cannot afford to post one.
        """
        self._assert_owner()
        case = self._case_or_raise(docket)
        if case.status != "UNDER_REVIEW":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is not under review")

        bond = int(case.review_bond_atto)
        requester = case.review_requester
        if verdict_changed and bond > 0 and requester != "":
            current = int(self.bond_claimable.get(requester, u256(0)))
            self.bond_claimable[requester] = u256(current + bond)

        held = int(self.bond_held_atto) - bond
        self.bond_held_atto = u256(held if held > 0 else 0)
        case.review_bond_atto = u256(0)
        self._bump_status("UNDER_REVIEW", -1)
        case.status = "VERDICT"
        self._bump_status("VERDICT", 1)

        return {
            "docket": docket,
            "bond_returned": bool(verdict_changed),
            "bond_atto": str(bond),
            "awarded_to": requester if verdict_changed else str(self.owner),
        }

    @gl.public.write
    def withdraw_bond(self) -> str:
        """Take back a bond that was awarded to you."""
        caller = str(gl.message.sender_address)
        owed = int(self.bond_claimable.get(caller, u256(0)))
        if owed <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing is owed to {caller}")
        self.bond_claimable[caller] = u256(0)
        gl.get_contract_at(gl.message.sender_address).emit_transfer(value=u256(owed), on="finalized")
        return str(owed)

    @gl.public.write
    def note_advance(self, docket: str, advanced_atto: str) -> None:
        """Recorded by the AdvancePool when it moves money against a verdict."""
        if str(gl.message.sender_address) != str(self.pool):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the advance pool may record an advance")
        case = self._case_or_raise(docket)
        amount = int(advanced_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the advance must be above zero")
        if int(case.advanced_atto) > 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' has already been advanced against")
        case.advanced_atto = u256(amount)
        self._bump_status(case.status, -1)
        case.status = "ADVANCED"
        self._bump_status("ADVANCED", 1)

    @gl.public.write
    def mark_settled(self, docket: str, settled_atto: str) -> None:
        """The insurer paid. Closes the case and lets the pool recover."""
        caller = str(gl.message.sender_address)
        if caller != str(self.owner) and caller != str(self.pool):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only the court or the pool may settle a case")
        case = self._case_or_raise(docket)
        if case.status in ("SETTLED", "REJECTED"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already closed")
        amount = int(settled_atto)
        if amount < 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a settled amount cannot be negative")
        self._bump_status(case.status, -1)
        case.settled_atto = u256(amount)
        case.status = "SETTLED"
        self._bump_status("SETTLED", 1)

    @gl.public.write
    def reject_case(self, docket: str, reason: str) -> None:
        """Close a case that should never have been filed."""
        self._assert_owner()
        case = self._case_or_raise(docket)
        if case.status in ("SETTLED", "REJECTED"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already closed")
        if reason.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a rejection needs a stated reason")
        self._bump_status(case.status, -1)
        case.status = "REJECTED"
        self._bump_status("REJECTED", 1)

    @gl.public.write
    def set_pool(self, pool_address: str) -> None:
        self._assert_owner()
        if not pool_address.startswith("0x") or len(pool_address) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} pool_address must be a 20 byte address")
        self.pool = Address(pool_address)

    @gl.public.write
    def set_min_confidence(self, min_confidence: int) -> None:
        self._assert_owner()
        value = int(min_confidence)
        if value < 1 or value > 100:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} min_confidence must sit between 1 and 100")
        self.min_confidence = u256(value)

    @gl.public.write
    def set_review_bond(self, review_bond_atto: str) -> None:
        self._assert_owner()
        self.review_bond_atto = u256(int(review_bond_atto))

    @gl.public.write
    def set_registry(self, registry_address: str) -> None:
        self._assert_owner()
        if not registry_address.startswith("0x") or len(registry_address) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} registry_address must be a 20 byte address")
        self.registry = Address(registry_address)
