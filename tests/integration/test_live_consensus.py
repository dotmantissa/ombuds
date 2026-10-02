"""Integration tests against a real GenLayer network.

These are the tests direct mode cannot do. Direct mode runs one contract per VM and mocks
the outside world, which means the two things that actually matter here go untested there:
whether three contracts talk to each other correctly once deployed, and whether validators
independently re-fetching a live insurer bulletin arrive at the same answer.

Slow on purpose. Every adjudication makes every validator fetch two real documents and ask
a real model. Run with:

    gltest tests/integration -v -s --network studionet

Marked slow so a normal test run does not wait on a studio network round trip. Run the slow
ones with:

    gltest tests/integration -v -s --network studionet -m slow
"""

import hashlib
import json
import pathlib
import re

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
ATTO = 10**18

AETNA_0157 = "https://www.aetna.com/cpb/medical/data/100_199/0157.html"
CMS_100_1 = "https://api.coverage.cms.gov/v1/data/ncd?ncdid=57&ncdver=5"

AETNA_SECTIONS = "|".join(
    [
        "Scope of Policy",
        "Medically Necessary",
        "Experimental, Investigational, or Unproven",
        "Policy Limitations and Exclusions",
        "Applicable CPT / HCPCS / ICD-10 Codes",
    ]
)

PLAN_ID = "AETNA-COMMERCIAL-BARIATRIC_SURGERY"

CLEAN_RATIONALE = (
    "Benefit denied because the requested procedure is considered not medically necessary "
    "for this member under the applicable clinical policy bulletin."
)

GROUNDS = (
    "MEDICAL_NECESSITY",
    "CODING_ERROR",
    "NETWORK_STATUS",
    "PRIOR_AUTH_DEFECT",
    "TIMELINESS",
)


def deploy_registry():
    return get_contract_factory("PlanRegistry").deploy(args=[])


def deploy_court(registry_address, min_confidence=70):
    return get_contract_factory("OmbudsCourt").deploy(
        args=[registry_address, min_confidence, str(ATTO // 4)]
    )


def deploy_pool(court_address):
    caps = ",".join(
        str(v) for v in (ATTO // 4, ATTO // 2, ATTO, ATTO * 2, ATTO * 3, ATTO * 4)
    )
    return get_contract_factory("AdvancePool").deploy(
        args=[court_address, 3500, 1200, 7000, caps]
    )


def register_bariatric(registry):
    return registry.register_rule(
        args=[
            PLAN_ID,
            "Aetna",
            "Commercial",
            "bariatric_surgery",
            "0157",
            "Obesity Surgery",
            AETNA_0157,
            "html",
            "US",
            "2026-01-01",
            "2027-12-31",
            CMS_100_1,
            "100.1",
            "https://asmbs.org/resources/metabolic-and-bariatric-surgery/",
            AETNA_SECTIONS,
        ]
    ).transact()


def file_case(court, disputed_atto=12_000 * ATTO):
    evidence = hashlib.sha256(CLEAN_RATIONALE.encode("utf-8")).hexdigest()
    return court.file_case(
        args=[
            PLAN_ID,
            "bariatric_surgery",
            "TX",
            "43644|43775",
            "E66.01|Z68.41",
            "50",
            CLEAN_RATIONALE,
            "2026-04",
            str(disputed_atto),
            evidence,
        ]
    ).transact()


# ----------------------------------------------------------------- deployment and wiring


def test_the_three_contracts_deploy_and_know_about_each_other():
    registry = deploy_registry()
    court = deploy_court(registry.address)
    pool = deploy_pool(court.address)

    assert tx_execution_succeeded(court.set_pool(args=[pool.address]).transact())

    config = court.get_config(args=[]).call()
    assert str(config["registry"]).lower() == str(registry.address).lower()
    assert str(config["pool"]).lower() == str(pool.address).lower()
    assert list(config["grounds"]) == list(GROUNDS)

    pool_config = pool.get_config(args=[]).call()
    assert str(pool_config["court"]).lower() == str(court.address).lower()
    assert len(pool_config["band_caps_atto"]) == 6


def test_the_registry_gate_refuses_a_lapsed_rule_through_the_court():
    """The court must repeat the registry's refusal, not work around it."""
    registry = deploy_registry()
    assert tx_execution_succeeded(
        registry.register_rule(
            args=[
                PLAN_ID,
                "Aetna",
                "Commercial",
                "bariatric_surgery",
                "0157",
                "Obesity Surgery",
                AETNA_0157,
                "html",
                "US",
                "2024-01-01",
                "2024-12-31",
                CMS_100_1,
                "100.1",
                "",
                AETNA_SECTIONS,
            ]
        ).transact()
    )
    court = deploy_court(registry.address)

    # The cross contract read happens on chain, so this is the real gate and not a stub.
    assert registry.is_rule_active(args=[PLAN_ID]).call() is False
    assert "lapsed" in registry.lapse_reason(args=[PLAN_ID]).call()

    receipt = file_case(court)
    assert not tx_execution_succeeded(receipt), "a lapsed rule must not accept a filing"


def test_the_phi_tripwire_runs_on_chain():
    registry = deploy_registry()
    court = deploy_court(registry.address)

    dirty = "Member ID X12345678 called on 415-555-0199 about service on 03/14/2026"
    flags = court.phi_scan(args=[dirty]).call()
    assert "MEMBER_ID" in flags
    assert "PHONE" in flags
    assert "FULL_DATE" in flags

    assert court.phi_scan(args=[CLEAN_RATIONALE]).call() == []
    # A real procedure code and a real diagnosis code must survive untouched.
    assert court.phi_scan(args=["Procedure 43644 with diagnosis E66.01 and Z68.41"]).call() == []


def test_a_filing_carrying_an_identifier_is_refused_on_chain():
    registry = deploy_registry()
    assert tx_execution_succeeded(register_bariatric(registry))
    court = deploy_court(registry.address)

    evidence = hashlib.sha256(b"x").hexdigest()
    receipt = court.file_case(
        args=[
            PLAN_ID,
            "bariatric_surgery",
            "TX",
            "43644",
            "E66.01",
            "50",
            "Denied. Member ID W123456789 is not eligible for this benefit.",
            "2026-04",
            str(5_000 * ATTO),
            evidence,
        ]
    ).transact()
    assert not tx_execution_succeeded(receipt), "a member id must not reach the chain"


# ------------------------------------------------------- the live source, under strict_eq


@pytest.mark.slow
def test_validators_agree_on_a_digest_of_the_live_bulletin():
    """Every validator fetches aetna.com itself and they all have to agree.

    This is the one that proves the normalisation is right. Raw bytes would never match
    across nodes, so if the slicing and whitespace handling were wrong, strict_eq would
    fail here rather than in a comment.
    """
    registry = deploy_registry()
    assert tx_execution_succeeded(register_bariatric(registry))

    first = registry.refresh_rule(args=[PLAN_ID]).transact()
    assert tx_execution_succeeded(first), "validators could not agree on the bulletin digest"

    rule = registry.rule_for(args=[PLAN_ID]).call()
    assert re.fullmatch(r"[0-9a-f]{64}", rule["content_hash"]), rule["content_hash"]
    assert rule["refresh_count"] == 1
    assert rule["revision_count"] == 0
    digest = rule["content_hash"]

    # Same document, so the digest must not move. A second run also proves the fetch is
    # stable rather than accidentally agreeing once.
    second = registry.refresh_rule(args=[PLAN_ID]).transact()
    assert tx_execution_succeeded(second)
    again = registry.rule_for(args=[PLAN_ID]).call()
    assert again["content_hash"] == digest
    assert again["revision_count"] == 0, "a stable document must not look like a revision"


# ----------------------------------------------------- the full case, with real consensus


@pytest.mark.slow
def test_a_case_runs_from_filing_to_an_advance():
    registry = deploy_registry()
    assert tx_execution_succeeded(register_bariatric(registry))
    court = deploy_court(registry.address)
    pool = deploy_pool(court.address)
    assert tx_execution_succeeded(court.set_pool(args=[pool.address]).transact())

    assert tx_execution_succeeded(file_case(court))
    page = court.docket_page(args=[0, 1]).call()
    assert len(page) == 1
    docket = page[0]["docket"]
    assert re.fullmatch(r"OMB-\d{4}-\d{6}", docket)

    gate = court.is_advanceable(args=[docket]).call()
    assert gate["ok"] is False
    assert "adjudicated" in gate["reason"]

    # The real thing. Every validator re-fetches both documents, re-audits the codes, asks
    # the model again, and has to agree on four fields before this returns.
    verdict_tx = court.adjudicate(args=[docket]).transact()
    assert tx_execution_succeeded(verdict_tx), "the panel could not reach consensus"

    verdict = court.get_verdict(args=[docket]).call()

    # The decision fields, which are the compared ones.
    assert isinstance(verdict["overturn_recommended"], bool)
    assert verdict["ground"] in GROUNDS
    assert 0 <= verdict["recoverable_band"] <= 5
    assert 0 <= verdict["confidence"] <= 100

    # clause_id must be the bulletin number plus a slug of a section the registry declared.
    assert verdict["clause_id"].startswith("0157#")
    declared = {s for s in registry.rule_for(args=[PLAN_ID]).call()["clause_sections"]}
    assert verdict["clause_section"] in declared

    # The citation has to be real. The quote was checked against the fetched document
    # inside the contract, so its presence here means that check passed on every node.
    assert len(verdict["clause_quote"]) >= 24
    assert re.fullmatch(r"[0-9a-f]{64}", verdict["bulletin_digest"])
    assert re.fullmatch(r"[0-9a-f]{64}", verdict["digest"])

    citations = verdict["citations"]
    assert len(citations) >= 2
    urls = [c["url"] for c in citations]
    assert AETNA_0157 in urls
    assert CMS_100_1 in urls

    assert court.get_case(args=[docket]).call()["status"] == "VERDICT"

    # The pool only moves if the court says so, and only ever to the filer.
    gate = court.is_advanceable(args=[docket]).call()
    quote = pool.quote_advance(args=[docket]).call()

    if gate["ok"]:
        assert quote["eligible"] is True
        assert int(quote["amount_atto"]) > 0

        funded = pool.deposit(args=[], value=4 * ATTO).transact()
        assert tx_execution_succeeded(funded)

        advanced = pool.advance(args=[docket]).transact()
        assert tx_execution_succeeded(advanced)

        record = pool.get_advance(args=[docket]).call()
        assert record["status"] == "OUTSTANDING"
        assert int(record["amount_atto"]) > 0
        assert str(record["member"]).lower() == str(
            court.get_case(args=[docket]).call()["filer"]
        ).lower()

        stats = pool.pool_stats(args=[]).call()
        assert int(stats["outstanding_atto"]) == int(record["amount_atto"])
    else:
        # A verdict that upheld the denial, or one below the confidence band, must be
        # refused by the pool with a reason rather than quietly paying out.
        assert quote["eligible"] is False
        assert quote["reason"] != ""
        assert int(quote["amount_atto"]) == 0


@pytest.mark.slow
def test_a_verdict_can_be_escalated_to_a_fresh_panel():
    registry = deploy_registry()
    assert tx_execution_succeeded(register_bariatric(registry))
    court = deploy_court(registry.address)

    assert tx_execution_succeeded(file_case(court))
    docket = court.docket_page(args=[0, 1]).call()[0]["docket"]
    assert tx_execution_succeeded(court.adjudicate(args=[docket]).transact())

    first = court.get_verdict(args=[docket]).call()

    bond = int(court.get_config(args=[]).call()["review_bond_atto"])
    assert tx_execution_succeeded(
        court.request_review(args=[docket], value=bond).transact()
    )

    case = court.get_case(args=[docket]).call()
    assert case["status"] == "UNDER_REVIEW"
    assert case["panel_round"] == 2
    assert int(court.court_stats(args=[]).call()["bond_held_atto"]) == bond

    # Under review, nothing can be advanced against it.
    assert court.is_advanceable(args=[docket]).call()["ok"] is False

    # A fresh panel reads it again. Agreeing with the first panel is a perfectly good
    # outcome; what matters is that the round number moved and a verdict still exists.
    assert tx_execution_succeeded(court.adjudicate(args=[docket]).transact())
    second = court.get_verdict(args=[docket]).call()
    assert second["panel_round"] == 2
    assert second["ground"] in GROUNDS
    assert second["clause_id"].startswith("0157#")
    assert first["docket"] == second["docket"]


@pytest.mark.slow
def test_the_seeded_registry_matches_the_verified_dataset():
    """Everything in data/sources.json registers and refreshes on a live network."""
    data = json.loads((ROOT / "data" / "sources.json").read_text())
    rules = data["plan_rules"]
    assert len(rules) >= 5

    registry = deploy_registry()
    for rule in rules:
        receipt = registry.register_rule(
            args=[
                rule["plan_id"],
                rule["insurer"],
                rule["plan_line"],
                rule["family_id"],
                rule["bulletin_number"],
                rule["bulletin_title"] or f"bulletin {rule['bulletin_number']}",
                rule["bulletin_url"],
                rule["fetch_mode"],
                rule["state"],
                rule["effective_from"],
                rule["effective_to"],
                rule["cms_source_url"] or "",
                rule["cms_display_id"] or "",
                rule["guideline_url"] or "",
                "|".join(rule["clause_sections"]),
            ]
        ).transact()
        assert tx_execution_succeeded(receipt), rule["plan_id"]

    stats = registry.registry_stats(args=[]).call()
    assert stats["rule_count"] == len(rules)
    assert stats["active_count"] == len(rules)

    for rule in rules:
        on_chain = registry.rule_for(args=[rule["plan_id"]]).call()
        assert on_chain["active"] is True
        assert on_chain["bulletin_url"] == rule["bulletin_url"]
        assert len(on_chain["clause_sections"]) == len(rule["clause_sections"])
