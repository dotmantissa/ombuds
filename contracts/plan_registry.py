# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
PlanRegistry
============

The registry of published coverage rules that Ombuds is allowed to argue against.

An appeal only has force if it is grounded in the rule the insurer itself published, as
that rule stood on the day the service happened. So this contract keeps one record per
plan and procedure family: where the insurer's clinical policy bulletin lives, which CMS
National Coverage Determination backs it, which state's external review law applies, and
the window during which that rule was in force.

Two jobs, and only these two:

1. Gatekeeping. Rules expire. A rule whose effective window has closed, or that has been
   retired, cannot be used to adjudicate a case. OmbudsCourt reads this contract before
   it spends a single validator cycle, and a lapsed rule is refused outright rather than
   quietly argued against. Arguing against last year's policy is how an appeal gets
   thrown out, so the refusal happens here.

2. Tamper evidence. refresh_rule() re-fetches the published bulletin, normalises it down
   to the policy text alone, and stores a digest of that text. Insurers revise bulletins
   mid year without announcement. When the digest moves, the registry records a revision
   and keeps the previous digest, so a silent policy change becomes a visible on-chain
   event instead of a thing you discover after you have already lost.

Consensus boundary
------------------
The only non-deterministic work here is the re-fetch, and it runs under strict_eq. No
model is called. That is deliberate: the question "what does this document say right
now" has one correct answer, and every validator can reach it by asking the same URL.
The digest is computed from a sliced, tag stripped, whitespace collapsed region of the
document rather than from raw bytes, because raw bytes carry session identifiers and
markup churn that would break agreement without any policy having changed.

Everything judgemental happens in OmbudsCourt. This contract never decides whether a
denial was wrong.

Privacy
-------
Nothing here is patient data. A plan rule is a public document, a public URL and a date
range. The one member supplied field is sbc_hash, which is a SHA-256 of the member's own
Summary of Benefits and Coverage, committed so the document can be proved later without
ever publishing it.
"""

import json
import re
import hashlib
from dataclasses import dataclass

from genlayer import *


# Error classes. Deterministic failures must match across validators exactly. A transient
# failure only needs both sides to agree that the outside world was unreachable, which is
# what stops a dead host from being scored as genuine disagreement.
ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"

# How a bulletin is read. html means a published web page, json means a structured API
# such as the CMS coverage database.
FETCH_MODES = ("html", "json")

# Where the policy text starts inside an insurer bulletin. Tried in order. These are the
# real section headings used by published clinical policy bulletins, so the digest covers
# the part of the page that carries the rule and not the navigation around it.
HTML_REGION_STARTS = (
    "Scope of Policy",
    "Policy Scope of Policy",
    "Coverage Policy",
    "Policy",
    "Medical Necessity",
    "Indications",
)

# Where it ends. Also tried in order. References and revision logs move for reasons that
# have nothing to do with the rule, so they are cut.
HTML_REGION_ENDS = (
    "The above policy is based on the following references",
    "References",
    "Background",
    "Revision History",
    "Review History",
)

# Fields of a CMS coverage document that carry the rule. Order is fixed so the digest is
# reproducible.
CMS_RULE_FIELDS = (
    "item_service_description",
    "indications_limitations",
    "reasons_for_denial",
)

_TAG_RE = re.compile(r"<[^>]*>")
_SCRIPT_RE = re.compile(r"<(script|style|noscript)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_WS_RE = re.compile(r"\s+")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

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


@allow_storage
@dataclass
class PlanRule:
    """One published coverage rule, pinned to a plan and a procedure family."""

    plan_id: str
    insurer: str
    plan_line: str
    family_id: str
    bulletin_number: str
    bulletin_title: str
    bulletin_url: str
    fetch_mode: str
    state: str
    effective_from: str
    effective_to: str
    sbc_hash: str
    cms_source_url: str
    cms_display_id: str
    guideline_url: str
    clause_sections: str
    content_hash: str
    previous_content_hash: str
    last_refreshed: str
    registered_at: str
    refresh_count: u256
    revision_count: u256
    retired: bool


def _unescape(text: str) -> str:
    """Resolve the entity set that appears in published bulletins. Deterministic."""
    out = text
    for needle, replacement in _ENTITIES:
        out = out.replace(needle, replacement)
    return out


def _strip_markup(raw: str) -> str:
    """Reduce a published page to its readable text, twice over.

    CMS returns policy text that is itself HTML escaped inside a JSON field, so the
    unescape and strip pass runs a second time. Anything that survives is prose.
    """
    body = _SCRIPT_RE.sub(" ", raw)
    body = _COMMENT_RE.sub(" ", body)
    body = _TAG_RE.sub(" ", body)
    body = _unescape(body)
    body = _TAG_RE.sub(" ", body)
    return _unescape(body)


def _collapse(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _slice_region(text: str, starts: tuple, ends: tuple) -> tuple:
    """Cut the policy bearing region out of a page. Returns (region, anchor_used)."""
    start_at = 0
    anchor = ""
    for candidate in starts:
        found = text.find(candidate)
        if found >= 0:
            start_at = found
            anchor = candidate
            break
    tail = text[start_at:]
    for candidate in ends:
        found = tail.find(candidate)
        if found > 0:
            tail = tail[:found]
            break
    return (tail.strip(), anchor)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_body(url: str) -> str:
    """Fetch a URL and return its decoded body, with errors classified for consensus."""
    res = gl.nondet.web.get(url, headers={"User-Agent": "Ombuds/1.0 (+coverage-appeal)"})
    status = int(res.status)
    if status >= 500:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} source unreachable, status {status}")
    if status >= 400:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} source refused, status {status}")
    if res.body is None:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} source returned an empty body")
    return res.body.decode("utf-8", errors="ignore")


def _policy_digest_html(url: str) -> dict:
    """Digest the policy region of a published bulletin page."""
    text = _collapse(_strip_markup(_read_body(url)))
    region, anchor = _slice_region(text, HTML_REGION_STARTS, HTML_REGION_ENDS)
    if len(region) < 400:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} bulletin carried no readable policy region, {len(region)} chars"
        )
    return {
        "digest": _digest(region),
        "region_len": len(region),
        "anchor": anchor,
        "mode": "html",
    }


def _policy_digest_json(url: str) -> dict:
    """Digest a structured coverage document from the CMS coverage database."""
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
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} coverage API document had an unexpected shape")

    parts = []
    for field in CMS_RULE_FIELDS:
        value = record.get(field)
        if isinstance(value, str) and value.strip() != "":
            parts.append(field + "=" + _collapse(_strip_markup(value)))
    if len(parts) == 0:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} coverage document carried no rule text")

    region = "\n".join(parts)
    if len(region) < 200:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} coverage document rule text was too short, {len(region)} chars"
        )
    return {
        "digest": _digest(region),
        "region_len": len(region),
        "anchor": str(record.get("document_display_id", "")),
        "mode": "json",
    }


def _chain_date() -> str:
    """The transaction date the chain supplied, as YYYY-MM-DD.

    Validators all see the same transaction datetime, so this is deterministic. Using it
    rather than a caller supplied date means nobody can argue a lapsed rule back into
    force by lying about what day it is.
    """
    raw = str(gl.message_raw.get("datetime", ""))
    if len(raw) >= 10:
        return raw[:10]
    return "1970-01-01"


def _chain_stamp() -> str:
    raw = str(gl.message_raw.get("datetime", ""))
    if raw == "":
        return "1970-01-01T00:00:00Z"
    return raw


def _require_iso_date(label: str, value: str) -> str:
    if _ISO_DATE_RE.match(value) is None:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must be an ISO date, got '{value}'")
    return value


def _require_sha256(label: str, value: str) -> str:
    """Empty is allowed and means not supplied. Anything else must be a real digest."""
    if value == "":
        return ""
    lowered = value.lower()
    if _HEX64_RE.match(lowered) is None:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must be 64 hex characters")
    return lowered


def _require_https(label: str, value: str, allow_empty: bool) -> str:
    if value == "":
        if allow_empty:
            return ""
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} is required")
    if not value.startswith("https://"):
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must be an https URL")
    return value


class PlanRegistry(gl.Contract):
    owner: Address

    rules: TreeMap[str, PlanRule]
    plan_ids: DynArray[str]

    # Secondary indexes so the court and the web index never scan the whole registry.
    family_members: TreeMap[str, DynArray[str]]
    insurer_members: TreeMap[str, DynArray[str]]

    curators: TreeMap[str, bool]
    curator_list: DynArray[str]

    # Append only log of digest changes, so a silent revision stays visible after the
    # fact. One JSON line per observed change.
    revision_log: DynArray[str]

    rule_count: u256
    active_count: u256
    total_refreshes: u256
    total_revisions: u256

    def __init__(self) -> None:
        self.owner = gl.message.sender_address
        self.rule_count = u256(0)
        self.active_count = u256(0)
        self.total_refreshes = u256(0)
        self.total_revisions = u256(0)
        key = str(gl.message.sender_address)
        self.curators[key] = True
        self.curator_list.append(key)

    # ---------------------------------------------------------------- access control

    def _assert_curator(self) -> None:
        caller = str(gl.message.sender_address)
        if caller == str(self.owner):
            return
        if not self.curators.get(caller, False):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} caller is not a registry curator")

    def _assert_owner(self) -> None:
        if str(gl.message.sender_address) != str(self.owner):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} caller is not the registry owner")

    def _rule_or_raise(self, plan_id: str) -> PlanRule:
        rule = self.rules.get(plan_id)
        if rule is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} no registered rule for plan '{plan_id}'")
        return rule

    # ------------------------------------------------------------------------- views

    @gl.public.view
    def get_owner(self) -> str:
        return str(self.owner)

    @gl.public.view
    def is_curator(self, address: str) -> bool:
        if address == str(self.owner):
            return True
        return bool(self.curators.get(address, False))

    @gl.public.view
    def rule_for(self, plan_id: str) -> dict:
        """The full rule record, plus whether it may be argued against today.

        OmbudsCourt calls this synchronously from inside its nondet block, which is why
        the contract stays deterministic.
        """
        rule = self._rule_or_raise(plan_id)
        today = _chain_date()
        within = rule.effective_from <= today <= rule.effective_to
        return {
            "plan_id": rule.plan_id,
            "insurer": rule.insurer,
            "plan_line": rule.plan_line,
            "family_id": rule.family_id,
            "bulletin_number": rule.bulletin_number,
            "bulletin_title": rule.bulletin_title,
            "bulletin_url": rule.bulletin_url,
            "fetch_mode": rule.fetch_mode,
            "state": rule.state,
            "effective_from": rule.effective_from,
            "effective_to": rule.effective_to,
            "sbc_hash": rule.sbc_hash,
            "cms_source_url": rule.cms_source_url,
            "cms_display_id": rule.cms_display_id,
            "guideline_url": rule.guideline_url,
            "clause_sections": [s for s in rule.clause_sections.split("|") if s != ""],
            "content_hash": rule.content_hash,
            "previous_content_hash": rule.previous_content_hash,
            "last_refreshed": rule.last_refreshed,
            "registered_at": rule.registered_at,
            "refresh_count": int(rule.refresh_count),
            "revision_count": int(rule.revision_count),
            "retired": bool(rule.retired),
            "active": bool((not rule.retired) and within),
            "as_of": today,
        }

    @gl.public.view
    def is_rule_active(self, plan_id: str) -> bool:
        rule = self.rules.get(plan_id)
        if rule is None:
            return False
        if rule.retired:
            return False
        today = _chain_date()
        return rule.effective_from <= today <= rule.effective_to

    @gl.public.view
    def lapse_reason(self, plan_id: str) -> str:
        """Why a rule cannot be used. Empty string means it can.

        The court quotes this straight back to the member, so it reads as a sentence and
        not as a code.
        """
        rule = self.rules.get(plan_id)
        if rule is None:
            return f"No rule is registered for plan '{plan_id}'."
        if rule.retired:
            return f"The rule for '{plan_id}' has been retired and cannot be argued against."
        today = _chain_date()
        if today < rule.effective_from:
            return (
                f"The rule for '{plan_id}' does not take effect until {rule.effective_from}."
            )
        if today > rule.effective_to:
            return (
                f"The rule for '{plan_id}' lapsed on {rule.effective_to}. "
                "Register the current bulletin before filing against it."
            )
        return ""

    @gl.public.view
    def list_plan_ids(self) -> list:
        return [p for p in self.plan_ids]

    @gl.public.view
    def plans_for_family(self, family_id: str) -> list:
        bucket = self.family_members.get(family_id)
        if bucket is None:
            return []
        return [p for p in bucket]

    @gl.public.view
    def plans_for_insurer(self, insurer: str) -> list:
        bucket = self.insurer_members.get(insurer)
        if bucket is None:
            return []
        return [p for p in bucket]

    @gl.public.view
    def registry_stats(self) -> dict:
        return {
            "rule_count": int(self.rule_count),
            "active_count": int(self.active_count),
            "total_refreshes": int(self.total_refreshes),
            "total_revisions": int(self.total_revisions),
            "curator_count": len(self.curator_list),
            "as_of": _chain_date(),
        }

    @gl.public.view
    def revision_history(self, limit: int) -> list:
        """Newest first. A non empty result means a bulletin moved under someone's feet."""
        total = len(self.revision_log)
        take = total if limit <= 0 or limit > total else limit
        out = []
        index = total - 1
        while index >= total - take:
            out.append(self.revision_log[index])
            index -= 1
        return out

    # ------------------------------------------------------------------------ writes

    @gl.public.write
    def register_rule(
        self,
        plan_id: str,
        insurer: str,
        plan_line: str,
        family_id: str,
        bulletin_number: str,
        bulletin_title: str,
        bulletin_url: str,
        fetch_mode: str,
        state: str,
        effective_from: str,
        effective_to: str,
        cms_source_url: str,
        cms_display_id: str,
        guideline_url: str,
        clause_sections: str,
    ) -> str:
        """Register or replace a plan rule. Curator only.

        clause_sections is a pipe separated list of the section headings the bulletin
        actually publishes. The court may only cite a clause that sits inside one of
        them, which is half of the anti hallucination clamp.
        """
        self._assert_curator()

        if plan_id.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} plan_id is required")
        if fetch_mode not in FETCH_MODES:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} fetch_mode must be one of {', '.join(FETCH_MODES)}"
            )
        if family_id.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} family_id is required")
        if len(state) != 2:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} state must be a two letter code or 'US'")

        _require_iso_date("effective_from", effective_from)
        _require_iso_date("effective_to", effective_to)
        if effective_to <= effective_from:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} effective_to must fall after effective_from")

        _require_https("bulletin_url", bulletin_url, False)
        _require_https("cms_source_url", cms_source_url, True)
        _require_https("guideline_url", guideline_url, True)

        existing = self.rules.get(plan_id)
        is_new = existing is None

        preserved_sbc = "" if existing is None else existing.sbc_hash
        preserved_hash = "" if existing is None else existing.content_hash
        preserved_prev = "" if existing is None else existing.previous_content_hash
        preserved_refreshed = "" if existing is None else existing.last_refreshed
        preserved_refreshes = u256(0) if existing is None else existing.refresh_count
        preserved_revisions = u256(0) if existing is None else existing.revision_count
        registered_at = _chain_stamp() if existing is None else existing.registered_at

        self.rules[plan_id] = PlanRule(
            plan_id=plan_id,
            insurer=insurer,
            plan_line=plan_line,
            family_id=family_id,
            bulletin_number=bulletin_number,
            bulletin_title=bulletin_title,
            bulletin_url=bulletin_url,
            fetch_mode=fetch_mode,
            state=state.upper(),
            effective_from=effective_from,
            effective_to=effective_to,
            sbc_hash=preserved_sbc,
            cms_source_url=cms_source_url,
            cms_display_id=cms_display_id,
            guideline_url=guideline_url,
            clause_sections=clause_sections,
            content_hash=preserved_hash,
            previous_content_hash=preserved_prev,
            last_refreshed=preserved_refreshed,
            registered_at=registered_at,
            refresh_count=preserved_refreshes,
            revision_count=preserved_revisions,
            retired=False,
        )

        if is_new:
            self.plan_ids.append(plan_id)
            self.rule_count = u256(int(self.rule_count) + 1)
            self.active_count = u256(int(self.active_count) + 1)

            family_bucket = self.family_members.get(family_id)
            if family_bucket is None:
                self.family_members[family_id] = DynArray[str]()
                family_bucket = self.family_members[family_id]
            family_bucket.append(plan_id)

            insurer_bucket = self.insurer_members.get(insurer)
            if insurer_bucket is None:
                self.insurer_members[insurer] = DynArray[str]()
                insurer_bucket = self.insurer_members[insurer]
            insurer_bucket.append(plan_id)
        elif existing is not None and existing.retired:
            self.active_count = u256(int(self.active_count) + 1)

        return plan_id

    @gl.public.write
    def set_sbc_hash(self, plan_id: str, sbc_hash: str) -> None:
        """Commit the SHA-256 of a member's Summary of Benefits and Coverage.

        The document itself never comes near the chain. Only the commitment does, so the
        member can prove later which document they were holding.
        """
        self._assert_curator()
        rule = self._rule_or_raise(plan_id)
        rule.sbc_hash = _require_sha256("sbc_hash", sbc_hash)

    @gl.public.write
    def extend_rule(self, plan_id: str, effective_to: str) -> None:
        """Push a rule's expiry out after confirming the bulletin still stands."""
        self._assert_curator()
        rule = self._rule_or_raise(plan_id)
        _require_iso_date("effective_to", effective_to)
        if effective_to <= rule.effective_from:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} effective_to must fall after effective_from")
        rule.effective_to = effective_to

    @gl.public.write
    def retire_rule(self, plan_id: str) -> None:
        self._assert_curator()
        rule = self._rule_or_raise(plan_id)
        if rule.retired:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} rule '{plan_id}' is already retired")
        rule.retired = True
        if int(self.active_count) > 0:
            self.active_count = u256(int(self.active_count) - 1)

    @gl.public.write
    def set_curator(self, address: str, enabled: bool) -> None:
        self._assert_owner()
        if not address.startswith("0x") or len(address) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} address must be a 0x prefixed 20 byte address")
        known = self.curators.get(address)
        self.curators[address] = enabled
        if known is None:
            self.curator_list.append(address)

    @gl.public.write
    def transfer_ownership(self, address: str) -> None:
        self._assert_owner()
        if not address.startswith("0x") or len(address) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} address must be a 0x prefixed 20 byte address")
        self.owner = Address(address)

    # ------------------------------------------------------- the non deterministic one

    @gl.public.write
    def refresh_rule(self, plan_id: str) -> dict:
        """Re-fetch the published bulletin and record a digest of its policy text.

        Runs under strict_eq because there is exactly one right answer to "what does this
        document say", and every validator can get it by asking the same URL. The digest
        covers a normalised slice of the document rather than raw bytes, so markup churn
        and session identifiers do not masquerade as a policy change.

        When the digest moves, the previous one is kept and a revision is logged. That is
        the whole point of this method: an insurer quietly rewriting a bulletin mid year
        becomes a visible on-chain event.
        """
        self._assert_curator()
        rule = self._rule_or_raise(plan_id)
        if rule.retired:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} rule '{plan_id}' is retired")

        url = rule.bulletin_url
        mode = rule.fetch_mode

        def fetch_digest() -> dict:
            if mode == "json":
                return _policy_digest_json(url)
            return _policy_digest_html(url)

        observed = gl.eq_principle.strict_eq(fetch_digest)

        fresh = str(observed["digest"])
        previous = rule.content_hash
        stamp = _chain_stamp()
        changed = previous != "" and previous != fresh

        rule.content_hash = fresh
        rule.last_refreshed = stamp
        rule.refresh_count = u256(int(rule.refresh_count) + 1)
        self.total_refreshes = u256(int(self.total_refreshes) + 1)

        if changed:
            rule.previous_content_hash = previous
            rule.revision_count = u256(int(rule.revision_count) + 1)
            self.total_revisions = u256(int(self.total_revisions) + 1)
            self.revision_log.append(
                json.dumps(
                    {
                        "plan_id": plan_id,
                        "insurer": rule.insurer,
                        "bulletin_number": rule.bulletin_number,
                        "bulletin_url": url,
                        "from_hash": previous,
                        "to_hash": fresh,
                        "observed_at": stamp,
                        "region_len": int(observed.get("region_len", 0)),
                    },
                    sort_keys=True,
                )
            )

        return {
            "plan_id": plan_id,
            "content_hash": fresh,
            "previous_content_hash": rule.previous_content_hash,
            "changed": changed,
            "first_observation": previous == "",
            "region_len": int(observed.get("region_len", 0)),
            "anchor": str(observed.get("anchor", "")),
            "mode": str(observed.get("mode", mode)),
            "observed_at": stamp,
            "refresh_count": int(rule.refresh_count),
            "revision_count": int(rule.revision_count),
        }
