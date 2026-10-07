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
from genlayer_py.types import TRANSACTION_STATUS_NUMBER_TO_NAME, VOTE_TYPE_NUMBER_TO_NAME
from gltest import get_contract_factory
from gltest.accounts import get_default_account
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


COMMITTED = ("ACCEPTED", "FINALIZED")


def _status_name(tx: dict) -> str:
    """The lifecycle state the network actually landed a transaction in."""
    raw = tx.get("status")
    if raw is None:
        return "MISSING"
    status = TRANSACTION_STATUS_NUMBER_TO_NAME.get(str(raw), raw)
    return str(getattr(status, "value", status))


def _votes(tx: dict) -> dict:
    """Validator votes, by address, with the enum numbers turned back into names."""
    raw = (tx.get("consensus_data") or {}).get("votes") or {}
    out = {}
    for who, vote in raw.items():
        name = VOTE_TYPE_NUMBER_TO_NAME.get(str(vote), vote)
        out[str(who)[:10]] = str(getattr(name, "value", name))
    return out


def assert_committed(tx: dict, what: str) -> dict:
    """Assert the PANEL committed this transaction, not merely that the leader liked it.

    `tx_execution_succeeded` reads nothing but `consensus_data.leader_receipt[0]`, and
    `wait_for_transaction_receipt(status=ACCEPTED)` returns on any decided state, a set
    that includes UNDETERMINED, VALIDATORS_TIMEOUT and LEADER_TIMEOUT. So a transaction
    whose validators disagreed, and which therefore changed no state whatsoever, sails
    through `assert tx_execution_succeeded(...)`. For a contract whose entire purpose this
    round is that validators re-derive and bind the leader's text, that is the single
    failure mode a test must not wave through, so every write expected to succeed goes
    through this. The refusal tests are the one place `tx_execution_succeeded` is still the
    right question, because what they assert is precisely that the leader itself failed.
    """
    status = _status_name(tx)
    detail = f"{what}: status {status}, votes {_votes(tx)}"
    assert tx_execution_succeeded(tx), f"{detail}, and the leader itself did not succeed"
    assert status in COMMITTED, (
        f"{detail}. The leader succeeded but the panel did not commit, so no state changed."
    )
    return tx


def _verdict_exists(court, docket: str) -> bool:
    """Did a verdict actually land, whatever the client was told."""
    try:
        court.get_verdict(args=[docket]).call()
        return True
    except Exception:
        return False


# Adjudication costs every validator two model calls on top of two live document fetches,
# so it is slower than anything else here and more exposed to one node stalling. Let the
# protocol's own answer to disagreement do the work: rotations replace the panel, which is
# the designed response, and the wait has to be long enough for those rotations to finish
# or the client gives up on a transaction that was still progressing.
PANEL_ROTATIONS = 5
PANEL_WAIT_RETRIES = 400


def run_panel(court, docket: str, what: str, attempts: int = 2):
    """Adjudicate, and insist the panel actually committed a verdict.

    Three ways a panel can fail to produce one, and they are not the same thing:

    The leader's own execution fails. A contract fault. Not retried.

    The leader succeeds and the validators refuse to confirm it, so the transaction lands
    UNDETERMINED and writes nothing. The case and its round counter are untouched, so
    adjudicating again is a genuinely fresh panel rather than a retry of a half write.

    Nobody decides in time and `transact()` raises rather than returning a receipt, having
    given up on a transaction that may still be in flight. That one is the trap: the
    verdict can land after the client stopped looking, so the chain is re-read before
    anything is retried, and a verdict that did arrive counts.

    Every miss is printed. A systematically unreachable consensus cannot hide behind the
    retry, which is the whole reason the bound is 2 and not 10.
    """
    for attempt in range(1, attempts + 1):
        try:
            tx = court.adjudicate(args=[docket]).transact(
                consensus_max_rotations=PANEL_ROTATIONS,
                wait_retries=PANEL_WAIT_RETRIES,
            )
        except Exception as err:
            first_line = str(err).split("\n")[0][:200]
            print(f"    {what}: attempt {attempt} of {attempts} gave up waiting: {first_line}")
            if _verdict_exists(court, docket):
                print(f"    {what}: the verdict landed after the wait gave up, taking it")
                return None
            continue

        status = _status_name(tx)
        if not tx_execution_succeeded(tx):
            raise AssertionError(
                f"{what}: the leader's own execution failed, status {status}, "
                f"votes {_votes(tx)}. This is a contract fault, not a consensus miss."
            )
        if status in COMMITTED:
            if attempt > 1:
                print(f"    {what}: committed on attempt {attempt}")
            return tx
        print(
            f"    {what}: attempt {attempt} of {attempts} ended {status}, "
            f"votes {_votes(tx)}. Nothing was committed, so the panel sits again."
        )

    if _verdict_exists(court, docket):
        print(f"    {what}: a verdict is on chain despite the last wait, taking it")
        return None
    raise AssertionError(
        f"{what}: {attempts} panels failed to commit a verdict. The leader succeeded, so "
        "the validators are refusing to confirm it or the network never decided."
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

    assert_committed(
        court.set_pool(args=[pool.address]).transact(), "wiring the court to the pool"
    )

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
    assert_committed(
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
        ).transact(),
        "registering a rule that has already lapsed",
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
    assert_committed(register_bariatric(registry), "registering the bariatric rule")
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
    assert_committed(register_bariatric(registry), "registering the bariatric rule")

    first = registry.refresh_rule(args=[PLAN_ID]).transact()
    assert_committed(first, "validators could not agree on the bulletin digest")

    rule = registry.rule_for(args=[PLAN_ID]).call()
    assert re.fullmatch(r"[0-9a-f]{64}", rule["content_hash"]), rule["content_hash"]
    assert rule["refresh_count"] == 1
    assert rule["revision_count"] == 0
    digest = rule["content_hash"]

    # Same document, so the digest must not move. A second run also proves the fetch is
    # stable rather than accidentally agreeing once.
    second = registry.refresh_rule(args=[PLAN_ID]).transact()
    assert_committed(second, "the second refresh of the same bulletin")
    again = registry.rule_for(args=[PLAN_ID]).call()
    assert again["content_hash"] == digest
    assert again["revision_count"] == 0, "a stable document must not look like a revision"


# ----------------------------------------------------- the full case, with real consensus


@pytest.mark.slow
def test_a_case_runs_from_filing_to_an_advance():
    registry = deploy_registry()
    assert_committed(register_bariatric(registry), "registering the bariatric rule")
    court = deploy_court(registry.address)
    pool = deploy_pool(court.address)
    assert_committed(
        court.set_pool(args=[pool.address]).transact(), "wiring the court to the pool"
    )

    assert_committed(file_case(court), "filing the case")
    page = court.docket_page(args=[0, 1]).call()
    assert len(page) == 1
    docket = page[0]["docket"]
    assert re.fullmatch(r"OMB-\d{4}-\d{6}", docket)

    gate = court.is_advanceable(args=[docket]).call()
    assert gate["ok"] is False
    assert "adjudicated" in gate["reason"]

    # The real thing. Every validator re-fetches both documents, re-audits the codes, asks
    # the model again, and has to agree on four fields before this returns.
    run_panel(court, docket, "the panel")

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

        funded = pool.deposit(args=[]).transact(value=4 * ATTO)
        assert_committed(funded, "funding the pool")

        advanced = pool.advance(args=[docket]).transact()
        assert_committed(advanced, "advancing against the verdict")

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
def test_the_whole_appeal_lifecycle_runs_on_chain_and_frees_the_bond():
    """Bond posted, fresh panel sits, status moves, bond released. On a real network.

    Two live adjudications and four writes, so it is slow. It earns the time because this
    is the sequence that used to be impossible to finish: re-adjudication overwrote the
    status with VERDICT, resolve_review then refused because the case was no longer under
    review, and the bond stayed in the contract permanently. Every join is asserted here,
    against real validator consensus rather than a mock.
    """
    registry = deploy_registry()
    assert_committed(register_bariatric(registry), "registering the bariatric rule")
    court = deploy_court(registry.address)

    assert_committed(file_case(court), "filing the case")
    docket = court.docket_page(args=[0, 1]).call()[0]["docket"]

    # ---- first panel ------------------------------------------------------
    run_panel(court, docket, "the first panel")
    first = court.get_verdict(args=[docket]).call()
    assert court.get_case(args=[docket]).call()["status"] == "VERDICT"
    assert re.fullmatch(r"[0-9a-f]{64}", first["ruling_digest"]), first["ruling_digest"]

    # ---- the bond is posted ------------------------------------------------
    bond = int(court.get_config(args=[]).call()["review_bond_atto"])
    assert_committed(
        court.request_review(args=[docket]).transact(value=bond), "posting the bond"
    )

    case = court.get_case(args=[docket]).call()
    assert case["status"] == "UNDER_REVIEW"
    assert case["panel_round"] == 2
    assert case["review_open"] is True
    # The ruling to measure the appeal against was pinned, not the round stamped digest.
    assert case["pre_review_ruling"] == first["ruling_digest"]
    assert int(court.court_stats(args=[]).call()["bond_held_atto"]) == bond

    # Under review, nothing can be advanced against it.
    assert court.is_advanceable(args=[docket]).call()["ok"] is False

    # ---- the fresh panel sits ---------------------------------------------
    # Agreeing with the first panel is a perfectly good outcome. What matters is that the
    # round moved and the case did NOT fall back to VERDICT while a bond was held.
    run_panel(court, docket, "the fresh panel")
    second = court.get_verdict(args=[docket]).call()
    assert second["panel_round"] == 2
    assert second["ground"] in GROUNDS
    assert second["clause_id"].startswith("0157#")
    assert first["docket"] == second["docket"]

    # ---- the status transition that was missing ---------------------------
    case = court.get_case(args=[docket]).call()
    assert case["status"] == "REVIEWED", "a heard appeal must not read as a plain verdict"
    assert case["review_open"] is True
    assert int(court.court_stats(args=[]).call()["bond_held_atto"]) == bond
    # Still not advanceable, because the appeal is not closed.
    assert court.is_advanceable(args=[docket]).call()["ok"] is False

    # ---- the bond is released --------------------------------------------
    resolved_tx = court.resolve_review(args=[docket]).transact()
    assert_committed(resolved_tx, "resolving a heard appeal must not revert")

    case = court.get_case(args=[docket]).call()
    assert case["status"] == "VERDICT"
    assert case["review_open"] is False
    assert int(case["review_bond_atto"]) == 0
    assert case["pre_review_ruling"] == ""

    # Nothing is held any more, and whether the challenger got it back is decided by the
    # chain comparing the two rulings, not by anybody asserting it.
    stats = court.court_stats(args=[]).call()
    assert int(stats["bond_held_atto"]) == 0

    # The bond was posted by the account gltest signs with, which is not exposed on the
    # contract handle: `Contract.account` is only populated by `connect()`, and reading it
    # off a deployed handle gives None.
    challenger = str(get_default_account().address)
    moved = second["ruling_digest"] != first["ruling_digest"]
    claimable = int(court.bond_of(args=[challenger]).call())
    if moved:
        assert claimable == bond, "a changed ruling owes the challenger its bond"
    else:
        assert claimable == 0, "an unchanged ruling forfeits the bond to the court"

    # The whole point of releasing it: the money is now reachable.
    if moved:
        assert_committed(court.withdraw_bond(args=[]).transact(), "withdrawing the bond")
        assert int(court.bond_of(args=[challenger]).call()) == 0


@pytest.mark.slow
def test_a_live_panel_binds_the_leaders_text_to_the_document_it_fetched():
    """Consensus succeeding IS the proof, now that the bindings are inside the vote.

    There is nothing to assert about the leader's quote from out here, because the check
    happens on every validator: each one looks for the leader's sentence in the bulletin
    it fetched itself, re-derives both digests, and disagrees if any of it fails. So a
    transaction that reaches consensus is a transaction where every validator found the
    committed citation in its own copy of aetna.com. If the binding were broken this
    would not produce a verdict at all.

    Deliberately not re-fetching the bulletin from here. That would test this machine's
    network access, not the contract, and this box's IP is rate limited by aetna.com.
    The validators reach it fine, which is the only thing that matters.
    """
    registry = deploy_registry()
    assert_committed(register_bariatric(registry), "registering the bariatric rule")
    court = deploy_court(registry.address)

    # Two independent cases against the same published rule, each read by its own panel.
    assert_committed(file_case(court), "filing the case")
    first_docket = court.docket_page(args=[0, 1]).call()[0]["docket"]
    run_panel(
        court,
        first_docket,
        "a panel that cannot bind the leader's text to the bulletin reaches no verdict",
    )

    assert_committed(file_case(court), "filing the case")
    second_docket = court.docket_page(args=[0, 1]).call()[0]["docket"]
    assert second_docket != first_docket
    run_panel(court, second_docket, "the second panel")

    first = court.get_verdict(args=[first_docket]).call()
    second = court.get_verdict(args=[second_docket]).call()

    # The citation that survived the panel is a real sentence of real length.
    assert len(str(first["clause_quote"])) >= 24
    assert str(first["clause_section"]) in AETNA_SECTIONS.split("|")
    assert str(first["clause_id"]).startswith("0157#")

    # Both digests are re-derived by every validator and compared exactly, so they have
    # to be well formed and they have to be stable across two separate panels reading the
    # same document. That stability is what makes exact digest comparison safe to require
    # rather than a standing consensus hazard.
    assert re.fullmatch(r"[0-9a-f]{64}", str(first["bulletin_digest"]))
    assert first["bulletin_digest"] == second["bulletin_digest"], (
        "two panels reading the same bulletin must compute the same digest"
    )
    if str(first["cms_digest"]) != "":
        assert re.fullmatch(r"[0-9a-f]{64}", str(first["cms_digest"]))
        assert first["cms_digest"] == second["cms_digest"]

    # The rationale is bound too, by a validator judging it against the bulletin it
    # fetched. It reached state, so it passed that on every node.
    assert len(str(first["reasoning"])) >= 20


@pytest.mark.slow
def test_the_seeded_registry_matches_the_verified_dataset():
    """Everything in data/sources.json registers and refreshes on a live network."""
    data = json.loads((ROOT / "web" / "data" / "sources.json").read_text())
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
        assert_committed(receipt, f"registering {rule['plan_id']}")

    stats = registry.registry_stats(args=[]).call()
    assert stats["rule_count"] == len(rules)
    assert stats["active_count"] == len(rules)

    for rule in rules:
        on_chain = registry.rule_for(args=[rule["plan_id"]]).call()
        assert on_chain["active"] is True
        assert on_chain["bulletin_url"] == rule["bulletin_url"]
        assert len(on_chain["clause_sections"]) == len(rule["clause_sections"])
