"""OmbudsCourt: filing, the PHI tripwire, adjudication and the validator comparison rule.

The tests that matter most here are the ones about refusal and disagreement. A court that
happily writes a verdict is not interesting. A court that refuses a patient identifier,
refuses a lapsed rule, and refuses to agree with a validator that read a different clause
is the whole product.
"""

import json

import pytest

from conftest import (
    AETNA_0157,
    section_body as _section_text,
    ATTO,
    CLEAN_RATIONALE,
    CMS_100_1,
    file_clean_case,
    leader_payload,
    policy_text,
    real_quote,
    serve,
    support_json,
    verdict_json,
)

PROMPT_MATCH = r"(?s).*adjudicating a denied health insurance claim.*"
# The second prompt, the one only a validator asks: is the leader's rationale actually
# carried by the document this node fetched.
SUPPORT_MATCH = r"(?s).*checking one paragraph of reasoning.*"


def arm(direct_vm, aetna, cms, answer: str, *, supported: bool = True) -> None:
    """Serve both real documents and both model answers.

    Two prompts, because a validator asks two questions. The decision prompt is the job
    itself. The support prompt is the validator reading the leader's rationale back
    against the bulletin, which is the check that stops leader authored prose reaching
    state unexamined.
    """
    serve(direct_vm, AETNA_0157, aetna)
    serve(direct_vm, CMS_100_1, cms)
    direct_vm.mock_llm(SUPPORT_MATCH, support_json(supported=supported))
    direct_vm.mock_llm(PROMPT_MATCH, answer)


# ------------------------------------------------------------------- filing

def test_files_a_clean_case_and_reads_it_back(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice

    docket = file_clean_case(court)
    assert docket == "OMB-2026-000001"

    case = court.get_case(docket)
    assert case["plan_id"] == "AETNA-COMMERCIAL-BARIATRIC"
    assert case["family_id"] == "bariatric_surgery"
    assert case["state"] == "TX"
    assert case["cpt_codes"] == ["43644", "43775"]
    assert case["icd10_codes"] == ["E66.01", "Z68.41"]
    assert case["service_month"] == "2026-04"
    assert case["status"] == "FILED"
    assert case["filer"] == str(direct_alice)
    assert case["has_verdict"] is False
    assert int(case["disputed_atto"]) == 12_000 * ATTO


def test_dockets_increment_and_are_listed_per_filer(
    court, direct_vm, direct_alice, direct_bob
):
    direct_vm.sender = direct_alice
    first = file_clean_case(court)
    second = file_clean_case(court)
    direct_vm.sender = direct_bob
    third = file_clean_case(court)

    assert [first, second, third] == ["OMB-2026-000001", "OMB-2026-000002", "OMB-2026-000003"]
    assert court.cases_for_filer(str(direct_alice)) == [first, second]
    assert court.cases_for_filer(str(direct_bob)) == [third]
    assert court.cases_for_filer("0x" + "9" * 40) == []


def test_court_stats_track_filings(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    file_clean_case(court, disputed_atto=1_000 * ATTO)
    file_clean_case(court, disputed_atto=2_500 * ATTO)

    stats = court.court_stats()
    assert stats["case_count"] == 2
    assert stats["verdict_count"] == 0
    assert stats["statuses"]["FILED"] == 2
    assert int(stats["total_disputed_atto"]) == 3_500 * ATTO


# ------------------------------------------------------- the PHI tripwire

@pytest.mark.parametrize(
    "rationale,kind",
    [
        ("Denied. Member ID W123456789 is not eligible for this benefit.", "MEMBER_ID"),
        ("Denied. Call us on 415-555-0199 to discuss this decision.", "PHONE"),
        ("Denied. Write to appeals@insurer.example.com within thirty days.", "EMAIL"),
        ("Denied. Service on 03/14/2026 was not covered under the plan.", "FULL_DATE"),
        ("Denied. Service on 2026-03-14 was not covered under the plan.", "ISO_DATE"),
        ("Denied. SSN 123-45-6789 does not match our records for this plan.", "SSN"),
        ("Denied. MRN 88213 shows no prior authorisation on file for this.", "MRN"),
    ],
)
def test_a_patient_identifier_is_refused_at_the_door(
    court, direct_vm, direct_alice, rationale, kind
):
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert(kind):
        court.file_case(
            "AETNA-COMMERCIAL-BARIATRIC", "bariatric_surgery", "TX",
            "43644", "E66.01", "50", rationale, "2026-04", str(5_000 * ATTO), "a" * 64,
        )


def test_the_tripwire_can_be_run_before_filing(court):
    dirty = "Member ID X12345678 called on 415-555-0199 about 03/14/2026"
    found = court.phi_scan(dirty)
    assert "MEMBER_ID" in found
    assert "PHONE" in found
    assert "FULL_DATE" in found
    assert court.phi_scan(CLEAN_RATIONALE) == []


def test_the_tripwire_leaves_real_codes_alone(court, direct_vm, direct_alice):
    """A five digit CPT code and a five digit ZIP look identical. Codes must survive."""
    direct_vm.sender = direct_alice
    assert court.phi_scan("Procedure 43644 with diagnosis E66.01 and Z68.41") == []
    docket = file_clean_case(court)
    assert court.get_case(docket)["cpt_codes"] == ["43644", "43775"]


def test_a_full_service_date_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("service_month must be YYYY-MM"):
        court.file_case(
            "AETNA-COMMERCIAL-BARIATRIC", "bariatric_surgery", "TX", "43644", "E66.01",
            "50", CLEAN_RATIONALE, "2026-04-14", str(5_000 * ATTO), "a" * 64,
        )


# --------------------------------------------------------- filing validation

@pytest.mark.parametrize(
    "cpt,icd,expected",
    [
        ("4364", "E66.01", "invalid CPT or HCPCS code"),
        ("436445", "E66.01", "invalid CPT or HCPCS code"),
        ("43644", "E6601X9", "invalid ICD-10-CM code"),
        ("43644", "166.01", "invalid ICD-10-CM code"),
        ("", "", "at least one CPT or ICD-10 code is required"),
    ],
)
def test_malformed_codes_are_refused(court, direct_vm, direct_alice, cpt, icd, expected):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert(expected):
        court.file_case(
            "AETNA-COMMERCIAL-BARIATRIC", "bariatric_surgery", "TX", cpt, icd,
            "50", CLEAN_RATIONALE, "2026-04", str(5_000 * ATTO), "a" * 64,
        )


def test_a_bad_evidence_hash_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("evidence_sha256 must be 64 hex characters"):
        file_clean_case(court, evidence="nothash")


def test_a_zero_disputed_amount_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("disputed amount must be above zero"):
        file_clean_case(court, disputed_atto=0)


def test_an_empty_rationale_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("denial rationale sentence is required"):
        court.file_case(
            "AETNA-COMMERCIAL-BARIATRIC", "bariatric_surgery", "TX", "43644", "E66.01",
            "50", "   ", "2026-04", str(5_000 * ATTO), "a" * 64,
        )


# ------------------------------------------------- the registry gate on filing

def test_filing_against_a_lapsed_rule_is_refused(make_court, direct_vm, direct_alice):
    """The registry refuses, and the court repeats the refusal word for word."""
    court, _ = make_court(
        lapse_reason=(
            "The rule for 'AETNA-COMMERCIAL-BARIATRIC' lapsed on 2025-12-31. "
            "Register the current bulletin before filing against it."
        )
    )
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("lapsed on 2025-12-31"):
        file_clean_case(court)


def test_filing_against_an_unregistered_plan_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("No rule is registered"):
        court.file_case(
            "CIGNA-COMMERCIAL-BARIATRIC", "bariatric_surgery", "TX", "43644", "E66.01",
            "50", CLEAN_RATIONALE, "2026-04", str(5_000 * ATTO), "a" * 64,
        )


def test_a_family_mismatch_is_refused(court, direct_vm, direct_alice):
    """The plan covers obesity surgery. Filing a knee case against it is a mistake."""
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("covers 'bariatric_surgery', not 'knee_arthroplasty'"):
        court.file_case(
            "AETNA-COMMERCIAL-BARIATRIC", "knee_arthroplasty", "TX", "27447", "M17.0",
            "50", CLEAN_RATIONALE, "2026-04", str(5_000 * ATTO), "a" * 64,
        )


# ----------------------------------------------------------- adjudication

def test_adjudicates_against_the_real_bulletin(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)

    quote = real_quote(aetna_0157)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, recoverable_usd=4200))

    out = court.adjudicate(docket)

    assert out["overturn_recommended"] is True
    assert out["ground"] == "MEDICAL_NECESSITY"
    # clause_id is bulletin number plus a slug of a section the registry declared.
    assert out["clause_id"] == "0157#medical-necessity"
    assert out["clause_section"] == "Medical Necessity"
    # $4,200 sits in the band that runs from two thousand to seven and a half thousand.
    assert out["recoverable_band"] == 2
    assert out["recoverable_band_label"] == "$2,000 to $7,500"
    assert out["confidence"] == 86
    assert out["crosses_confidence_band"] is True
    assert len(out["digest"]) == 64
    assert out["panel_round"] == 1

    verdict = court.get_verdict(docket)
    assert verdict["clause_quote"] in quote
    assert verdict["bulletin_digest"] != ""
    assert verdict["cms_digest"] != ""
    assert court.get_case(docket)["status"] == "VERDICT"
    assert court.verdict_digest(docket) == out["digest"]


def test_citations_are_built_from_the_documents_not_from_the_model(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157)))
    court.adjudicate(docket)

    citations = court.get_verdict(docket)["citations"]
    urls = [c["url"] for c in citations]
    assert AETNA_0157 in urls
    assert CMS_100_1 in urls
    bulletin = next(c for c in citations if c["url"] == AETNA_0157)
    assert bulletin["locator"] == "Medical Necessity"
    assert len(bulletin["digest"]) == 64
    assert "Aetna clinical policy bulletin 0157" in bulletin["source"]


def test_an_upheld_denial_recovers_nothing(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), overturn=False, recoverable_usd=9000),
    )

    out = court.adjudicate(docket)
    assert out["overturn_recommended"] is False
    # Band is forced to zero when the denial stands, whatever the model said.
    assert out["recoverable_band"] == 0
    assert court.court_stats()["overturn_count"] == 0


def test_recovery_is_capped_at_the_amount_in_dispute(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court, disputed_atto=900 * ATTO)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), recoverable_usd=250_000),
    )

    out = court.adjudicate(docket)
    # Capped at $900, which lands in the 500 to 2,000 band, not the top one.
    assert out["recoverable_band"] == 1
    assert out["recoverable_band_label"] == "$500 to $2,000"


@pytest.mark.parametrize(
    "usd,band",
    [(0, 0), (499, 0), (500, 1), (1999, 1), (2000, 2), (7499, 2),
     (7500, 3), (24999, 3), (25000, 4), (74999, 4), (75000, 5), (400000, 5)],
)
def test_payout_bands_tile_with_no_gaps(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1, usd, band
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court, disputed_atto=500_000 * ATTO)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157), recoverable_usd=usd))
    assert court.adjudicate(docket)["recoverable_band"] == band


def test_grounds_are_counted_per_ground(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)

    first = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, ground="CODING_ERROR"))
    court.adjudicate(first)

    second = file_clean_case(court)
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, ground="CODING_ERROR"))
    court.adjudicate(second)

    stats = court.court_stats()
    assert stats["grounds"]["CODING_ERROR"] == 2
    assert stats["grounds"]["MEDICAL_NECESSITY"] == 0
    assert stats["verdict_count"] == 2
    assert stats["overturn_count"] == 2


# ----------------------------------------- the anti hallucination clamp

def test_a_fabricated_quote_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The clamp. A sentence that is not in the document cannot be committed."""
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(
            "Aetna considers this procedure medically necessary for all members "
            "regardless of any clinical criterion whatsoever."
        ),
    )

    with direct_vm.expect_revert("does not appear in the section it was filed under"):
        court.adjudicate(docket)


def test_a_section_the_bulletin_does_not_publish_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), section="Appendix Q, Secret Criteria"),
    )

    with direct_vm.expect_revert("not a section this bulletin publishes"):
        court.adjudicate(docket)


def test_a_ground_outside_the_closed_set_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), ground="VIBES"),
    )

    with direct_vm.expect_revert("is not one of the five grounds"):
        court.adjudicate(docket)


def test_a_quote_too_short_to_check_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json("Covered."))

    with direct_vm.expect_revert("too short to verify"):
        court.adjudicate(docket)


def test_empty_reasoning_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), reasoning="Yes."),
    )

    with direct_vm.expect_revert("no readable reasoning"):
        court.adjudicate(docket)


def test_the_model_returning_nonsense_is_an_llm_error(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, json.dumps({"thoughts": "I am not sure"}))

    with direct_vm.expect_revert("[LLM_ERROR]"):
        court.adjudicate(docket)


def test_a_dead_source_is_classified_as_transient(
    court, direct_vm, direct_alice, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    serve(direct_vm, AETNA_0157, b"", status=503)
    serve(direct_vm, CMS_100_1, cms_100_1)

    with direct_vm.expect_revert("[TRANSIENT]"):
        court.adjudicate(docket)


# --------------------------------------- the validator comparison rule

def _adjudicated(court, direct_vm, aetna, cms, answer=None, quote=None):
    docket = file_clean_case(court)
    arm(direct_vm, aetna, cms, answer or verdict_json(quote or real_quote(aetna)))
    court.adjudicate(docket)
    return docket


def test_a_validator_reaching_the_same_reading_agrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    # The validator re-runs the whole job against the same documents and the same answer.
    assert direct_vm.run_validator() is True


def test_a_validator_that_flips_the_decision_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    # Swap the model answer so the validator's own re-run upholds the denial instead.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    assert direct_vm.run_validator() is False


def test_a_validator_that_picks_a_different_ground_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, ground="CODING_ERROR"))
    assert direct_vm.run_validator() is False


def test_a_validator_that_cites_a_different_clause_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """clause_id is the clamp, and it is compared exactly.

    The second reader cites a different section of the same bulletin, and quotes from
    that section so its own run is internally sound. The disagreement therefore comes
    from the clause comparison itself and not from a refusal on the way to it.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    other = "Experimental, Investigational, or Unproven"
    other_quote = real_quote(aetna_0157, section=other)
    assert other_quote != quote

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(other_quote, section=other))
    assert direct_vm.run_validator() is False


def test_a_validator_in_a_different_payout_band_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, recoverable_usd=40_000))
    assert direct_vm.run_validator() is False


def test_a_different_figure_inside_the_same_band_still_agrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Two honest readers will never agree on a number. They do not have to."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.clear_mocks()
    # 4,200 and 6,980 both sit in the two thousand to seven and a half thousand band.
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, recoverable_usd=6_980))
    assert direct_vm.run_validator() is True


def test_a_validator_crossing_the_confidence_line_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Confidence is not compared as a number, only against the line that releases money."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, confidence=55))
    assert direct_vm.run_validator() is False

    # A wobble that stays on the same side of the line is fine.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, confidence=94))
    assert direct_vm.run_validator() is True


def test_a_validator_reading_a_rewritten_bulletin_disagrees(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """If the document moved between leader and validator, the code audit diverges."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    stripped = aetna_0157.replace(b"43644", b"XXXXX")
    direct_vm.clear_mocks()
    arm(direct_vm, stripped, cms_100_1, verdict_json(quote, recoverable_usd=4200))
    assert direct_vm.run_validator() is False


def test_both_sides_hitting_a_dead_host_agree_about_the_failure(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """A dead source is not a disagreement.

    A validator is only captured by a run that actually reached the nondet block, so the
    verdict is produced first. The sources are then taken away, which is what the
    validator sees when it re-runs the job, and the leader is told to have failed the
    same transient way.
    """
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.clear_mocks()
    serve(direct_vm, AETNA_0157, b"", status=503)
    serve(direct_vm, CMS_100_1, cms_100_1)

    assert direct_vm.run_validator(
        leader_error=RuntimeError("[TRANSIENT] source unreachable, status 503")
    ) is True


def test_a_transient_leader_failure_against_a_live_source_is_a_disagreement(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """If only the leader could not reach the source, that is not agreement."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    assert direct_vm.run_validator(
        leader_error=RuntimeError("[TRANSIENT] source unreachable, status 503")
    ) is False


def test_a_leader_failure_the_validator_cannot_reproduce_is_a_disagreement(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    # The leader claims the model broke, but the validator's own run succeeds.
    assert direct_vm.run_validator(
        leader_error=RuntimeError("[LLM_ERROR] model returned nothing useful")
    ) is False


# ------------------------------------- binding the leader's own words to the source
#
# The comparison tests above prove two honest readings agree. These prove something
# different and more important: that a leader which does NOT run the honest code cannot
# get prose onto the chain.
#
# A real leader's decide step verifies its own quote before returning it. A byzantine
# leader simply does not, and the payload it returns is what the contract writes to
# state. So every test here takes the honest payload, changes one field the way a
# dishonest node would, and hands it to a validator that fetched the real document.
# run_validator(leader_result=...) is how a leader that lies is played.


def _tampered(direct_vm, field: str, value):
    payload = leader_payload(direct_vm)
    payload[field] = value
    return payload


def test_the_committed_quote_is_always_verbatim_in_the_bulletin(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The invariant every binding below rests on.

    Whatever the model handed over, what reaches state is a run of characters that is
    in the document. That is what makes a plain substring check a sufficient test for a
    validator later.
    """
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    committed = court.get_verdict(docket)["clause_quote"]
    assert len(committed) >= 24
    assert committed in policy_text(aetna_0157)


def test_the_honest_payload_clears_every_binding(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The control. Without this the tests below would pass on a broken validator."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    assert direct_vm.run_validator(leader_result=leader_payload(direct_vm)) is True


def test_a_validator_refuses_a_quote_that_is_not_in_its_own_bulletin(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The defect this suite exists for.

    The leader agrees on every compared field. It simply made the citation up. Nothing
    in the field comparison can see that, because the validator was comparing its own
    quote with itself and never looked at the leader's.
    """
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    fabricated = (
        "Aetna considers bariatric surgery medically necessary for all members "
        "regardless of body mass index or documented comorbidity."
    )
    assert fabricated not in policy_text(aetna_0157)

    forged = _tampered(direct_vm, "clause_quote", fabricated)
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_a_quote_too_short_to_be_a_citation(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """A fragment short enough to appear in any document proves nothing."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    # Genuinely present in the bulletin, and still not a citation.
    assert "the" in policy_text(aetna_0157)
    assert direct_vm.run_validator(leader_result=_tampered(direct_vm, "clause_quote", "the")) is False


def test_a_validator_refuses_a_bulletin_digest_it_did_not_compute(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The fingerprint the whole verdict is anchored to is re-derived, not accepted."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    forged = _tampered(direct_vm, "bulletin_digest", "f" * 64)
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_a_coverage_digest_it_did_not_compute(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    forged = _tampered(direct_vm, "cms_digest", "a" * 64)
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_reasoning_the_bulletin_does_not_support(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Reasoning cannot be diffed, so it is judged against the document instead.

    The leader's rationale here is well formed, the right length, and agrees with a
    decision the panel reached. It just says something the bulletin does not. The
    validator reads it back against its own copy and says no.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    invented = (
        "The bulletin states plainly that prior authorisation is never required for this "
        "procedure in any circumstance, so the denial cannot stand on that footing."
    )
    forged = _tampered(direct_vm, "reasoning", invented)

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote), supported=False)
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_reasoning_carrying_a_patient_identifier(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The tripwire now covers what the model wrote, not only what the member typed.

    file_case screens the filing. Nothing used to screen the rationale, so a model that
    echoed something patient shaped put it in immutable public state. The same guard
    covers the quoted clause.
    """
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    leaky = (
        "The criteria in the bulletin are met on the facts stated, and the member id "
        "number A7741802263 appears on the denial letter the insurer sent."
    )
    assert direct_vm.run_validator(leader_result=_tampered(direct_vm, "reasoning", leaky)) is False


def test_a_validator_refuses_an_empty_rationale(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    assert direct_vm.run_validator(leader_result=_tampered(direct_vm, "reasoning", "")) is False


def test_a_validator_refuses_a_section_the_registry_never_declared(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """clause_section has to come from the closed set and match the agreed clause_id."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    forged = _tampered(direct_vm, "clause_section", "Guaranteed Coverage For Everything")
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_citations_it_did_not_assemble(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Citations are built from the registry and the fetched documents, never taken
    from the model, so the two sides are byte identical or something is wrong."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    forged = _tampered(
        direct_vm,
        "citations",
        json.dumps([{"source": "A journal nobody fetched", "url": "https://example.invalid"}]),
    )
    assert direct_vm.run_validator(leader_result=forged) is False


def test_a_validator_refuses_a_confidence_far_from_its_own(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Confidence is still not compared exactly, but it is no longer a free number.

    Both readings clear the band here, so the old check passes. The figure that gets
    written to state is twenty nine points away from what this node actually thought,
    which is not a judgement call any more.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1, answer=verdict_json(quote, confidence=71))

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, confidence=100))
    assert direct_vm.run_validator() is False

    # A gap inside the tolerance is still a difference of opinion, not an invention.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, confidence=90))
    assert direct_vm.run_validator() is True


def test_a_validator_refuses_a_payload_that_is_not_a_verdict(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """A malformed leader result is a disagreement, never an exception."""
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    assert direct_vm.run_validator(leader_result="not a verdict at all") is False
    assert direct_vm.run_validator(leader_result={}) is False
    assert direct_vm.run_validator(leader_result={"overturn_recommended": True}) is False


# --------------------------------------------------------------- the appeal path

def test_a_review_needs_a_bond(court, direct_vm, direct_alice, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.value = 0
    with direct_vm.expect_revert("review bond of"):
        court.request_review(docket)


def test_posting_a_bond_opens_a_second_round(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    out = court.request_review(docket)

    assert out["panel_round"] == 2
    assert int(out["bond_atto"]) == ATTO // 4
    assert out["requester"] == str(direct_bob).lower()
    case = court.get_case(docket)
    assert case["status"] == "UNDER_REVIEW"
    assert case["panel_round"] == 2
    assert court.court_stats()["review_count"] == 1
    assert int(court.court_stats()["bond_held_atto"]) == ATTO // 4


def test_a_case_cannot_be_reviewed_twice_at_once(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    with direct_vm.expect_revert("already under review"):
        court.request_review(docket)


def test_a_case_with_no_verdict_cannot_be_reviewed(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    direct_vm.value = ATTO // 4
    with direct_vm.expect_revert("has no verdict to review"):
        court.request_review(docket)


def test_the_full_appeal_lifecycle_releases_the_bond(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """Bond posted, fresh panel sits, status moves, bond comes back. End to end.

    This is the path that used to be impossible to finish. request_review opened the
    review, adjudicate overwrote the status with VERDICT, and resolve_review then
    refused forever because the case was no longer under review. The bond stayed in the
    contract with nobody able to ask for it. Every step below is asserted because the
    defect lived in the joins between them.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)
    first_ruling = court.get_verdict(docket)["ruling_digest"]
    assert court.get_case(docket)["status"] == "VERDICT"

    # 1. The bond is posted and the case opens for a second reading.
    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    case = court.get_case(docket)
    assert case["status"] == "UNDER_REVIEW"
    assert case["panel_round"] == 2
    assert case["review_open"] is True
    assert case["pre_review_ruling"] == first_ruling
    assert int(court.court_stats()["bond_held_atto"]) == ATTO // 4

    # 2. A fresh panel reads it the other way.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    out = court.adjudicate(docket)

    # 3. The status transition that was missing. Re-adjudication does NOT return the
    #    case to VERDICT, because the bond posted against it has not been settled yet.
    assert out["status"] == "REVIEWED"
    case = court.get_case(docket)
    assert case["status"] == "REVIEWED"
    assert case["review_open"] is True
    assert court.get_verdict(docket)["ruling_digest"] != first_ruling
    assert int(court.court_stats()["bond_held_atto"]) == ATTO // 4

    # 4. Resolution now works, which it did not before. The second panel moved the
    #    verdict, so the challenger was right and the bond is theirs.
    settled = court.resolve_review(docket)

    assert settled["heard"] is True
    assert settled["verdict_changed"] is True
    assert settled["bond_returned"] is True
    assert settled["awarded_to"] == str(direct_bob).lower()
    assert int(settled["bond_atto"]) == ATTO // 4

    # 5. The bond left the contract and is claimable by the person who posted it.
    assert int(court.bond_of(str(direct_bob))) == ATTO // 4
    assert int(court.court_stats()["bond_held_atto"]) == 0

    case = court.get_case(docket)
    assert case["status"] == "VERDICT"
    assert case["review_open"] is False
    assert int(case["review_bond_atto"]) == 0
    assert case["pre_review_ruling"] == ""

    # 6. And it can actually be withdrawn, which is the only thing that makes the rest
    #    of this mean anything.
    assert int(court.withdraw_bond()) == ATTO // 4
    assert int(court.bond_of(str(direct_bob))) == 0


def test_a_second_panel_that_changes_nothing_forfeits_the_bond(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """Who wins the bond is read off the chain, not asserted by an administrator."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)
    first_ruling = court.get_verdict(docket)["ruling_digest"]

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    # The fresh panel lands in exactly the same place.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote))
    court.adjudicate(docket)
    assert court.get_verdict(docket)["ruling_digest"] == first_ruling

    settled = court.resolve_review(docket)
    assert settled["heard"] is True
    assert settled["verdict_changed"] is False
    assert settled["bond_returned"] is False
    assert int(court.bond_of(str(direct_bob))) == 0
    assert int(court.court_stats()["bond_held_atto"]) == 0
    assert court.get_case(docket)["status"] == "VERDICT"


def test_a_reviewed_case_cannot_take_a_second_bond_before_it_resolves(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """Taking a second bond would strand the first one, so it is refused."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    court.adjudicate(docket)

    direct_vm.value = ATTO // 4
    with direct_vm.expect_revert("has not been resolved yet"):
        court.request_review(docket)


def test_a_reviewed_case_is_not_advanceable(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """The panel has ruled but the appeal is not closed, so the pool does not move."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote))
    court.adjudicate(docket)

    assert court.get_case(docket)["status"] == "REVIEWED"
    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "under review" in gate["reason"]

    # And it becomes advanceable the moment the appeal actually closes.
    court.resolve_review(docket)
    assert court.is_advanceable(docket)["ok"] is True


def test_a_review_the_panel_never_heard_can_be_abandoned_and_refunds(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """The escape hatch. A source that dies must not take the bond with it."""
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    out = court.resolve_review(docket)
    assert out["heard"] is False
    assert out["bond_returned"] is True
    assert int(court.bond_of(str(direct_bob))) == ATTO // 4
    assert int(court.court_stats()["bond_held_atto"]) == 0
    assert court.get_case(docket)["status"] == "VERDICT"


def test_a_passer_by_cannot_abandon_a_review_nobody_has_heard_yet(
    court, direct_vm, direct_alice, direct_bob, direct_charlie, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("only the challenger or the court"):
        court.resolve_review(docket)


def test_anyone_may_close_a_review_the_panel_has_heard(
    court, direct_vm, direct_alice, direct_bob, direct_charlie, aetna_0157, cms_100_1
):
    """The outcome is derived from chain state, so there is nothing to game.

    Letting only an administrator close it would mean an administrator who never got
    round to it could strand somebody else's money indefinitely.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    court.adjudicate(docket)

    direct_vm.sender = direct_charlie
    out = court.resolve_review(docket)
    assert out["bond_returned"] is True
    # Still awarded to whoever posted it, not to whoever happened to close it.
    assert out["awarded_to"] == str(direct_bob).lower()
    assert int(court.bond_of(str(direct_bob))) == ATTO // 4
    assert int(court.bond_of(str(direct_charlie))) == 0


def test_a_case_with_no_open_review_cannot_be_resolved(
    court, direct_vm, direct_alice, direct_owner, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("has no open review"):
        court.resolve_review(docket)


def test_settling_a_case_mid_review_hands_the_bond_back(
    court, direct_vm, direct_alice, direct_bob, direct_owner, aetna_0157, cms_100_1
):
    """The insurer paying ends the argument. It must not also eat the bond."""
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.sender = direct_owner
    court.mark_settled(docket, str(9_000 * ATTO))

    assert int(court.bond_of(str(direct_bob))) == ATTO // 4
    assert int(court.court_stats()["bond_held_atto"]) == 0
    assert court.get_case(docket)["status"] == "SETTLED"


def test_rejecting_a_case_mid_review_hands_the_bond_back(
    court, direct_vm, direct_alice, direct_bob, direct_owner, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.sender = direct_owner
    court.reject_case(docket, "Filed against the wrong plan rule.")

    assert int(court.bond_of(str(direct_bob))) == ATTO // 4
    assert int(court.court_stats()["bond_held_atto"]) == 0
    assert court.get_case(docket)["status"] == "REJECTED"


def test_no_path_out_of_a_review_leaves_money_held(
    court, direct_vm, direct_alice, direct_bob, direct_owner, aetna_0157, cms_100_1
):
    """The property the whole defect came down to: a bond never gets stuck.

    Every exit from an open review is walked here, and each one has to end with the
    contract holding nothing. A new exit added later without a release will fail this.
    """
    quote = real_quote(aetna_0157)

    def open_a_review():
        direct_vm.sender = direct_alice
        direct_vm.value = 0
        direct_vm.clear_mocks()
        arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote))
        docket = file_clean_case(court)
        court.adjudicate(docket)
        direct_vm.sender = direct_bob
        direct_vm.value = ATTO // 4
        court.request_review(docket)
        direct_vm.value = 0
        return docket

    def re_adjudicate(docket):
        direct_vm.clear_mocks()
        arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
        court.adjudicate(docket)

    # Exit 1: heard, then resolved.
    a = open_a_review()
    re_adjudicate(a)
    court.resolve_review(a)

    # Exit 2: never heard, abandoned by the challenger.
    b = open_a_review()
    direct_vm.sender = direct_bob
    court.resolve_review(b)

    # Exit 3: settled while the review was open.
    c = open_a_review()
    direct_vm.sender = direct_owner
    court.mark_settled(c, str(1_000 * ATTO))

    # Exit 4: rejected while the review was open.
    d = open_a_review()
    direct_vm.sender = direct_owner
    court.reject_case(d, "Should never have been filed.")

    assert int(court.court_stats()["bond_held_atto"]) == 0
    for docket in (a, b, c, d):
        assert int(court.get_case(docket)["review_bond_atto"]) == 0
        assert court.get_case(docket)["review_open"] is False


def test_withdrawing_with_nothing_owed_is_refused(court, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("nothing is owed"):
        court.withdraw_bond()


def test_a_second_round_can_be_adjudicated_again(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    # A fresh panel reads it the other way.
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    out = court.adjudicate(docket)

    assert out["overturn_recommended"] is False
    assert out["panel_round"] == 2
    # The overturn count is corrected rather than double counted.
    assert court.court_stats()["overturn_count"] == 0
    assert court.court_stats()["verdict_count"] == 1


# --------------------------------------------------------- advanceability gate

def test_a_case_with_no_verdict_is_not_advanceable(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "not been adjudicated" in gate["reason"]


def test_an_upheld_denial_is_not_advanceable(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), overturn=False),
    )
    court.adjudicate(docket)

    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "upheld the denial" in gate["reason"]


def test_a_low_confidence_verdict_is_not_advanceable(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(
        direct_vm, aetna_0157, cms_100_1,
        verdict_json(real_quote(aetna_0157), confidence=51),
    )
    court.adjudicate(docket)

    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "below the confidence band" in gate["reason"]


def test_a_case_under_review_is_not_advanceable(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "under review" in gate["reason"]


def test_a_confident_overturn_is_advanceable(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    gate = court.is_advanceable(docket)
    assert gate["ok"] is True
    assert gate["reason"] == ""
    assert gate["band"] == 2
    assert gate["filer"] == str(direct_alice)
    assert int(gate["disputed_atto"]) == 12_000 * ATTO


# ------------------------------------------------------------- administration

def test_only_the_pool_may_record_an_advance(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    with direct_vm.expect_revert("only the advance pool"):
        court.note_advance(docket, str(ATTO))


def test_the_court_can_settle_a_case(
    court, direct_vm, direct_owner, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_owner
    court.mark_settled(docket, str(5_000 * ATTO))
    case = court.get_case(docket)
    assert case["status"] == "SETTLED"
    assert int(case["settled_atto"]) == 5_000 * ATTO

    with direct_vm.expect_revert("already closed"):
        court.mark_settled(docket, str(ATTO))


def test_a_rejection_needs_a_reason(court, direct_vm, direct_owner, direct_alice):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("needs a stated reason"):
        court.reject_case(docket, "  ")
    court.reject_case(docket, "Filed against the wrong plan by mistake.")
    assert court.get_case(docket)["status"] == "REJECTED"


def test_configuration_is_owner_only(court, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    for call in (
        lambda: court.set_min_confidence(10),
        lambda: court.set_review_bond(str(ATTO)),
        lambda: court.set_pool("0x" + "11" * 20),
        lambda: court.set_registry("0x" + "22" * 20),
    ):
        with direct_vm.expect_revert("not the court owner"):
            call()


def test_min_confidence_must_be_a_percentage(court, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    for bad in (0, 101):
        with direct_vm.expect_revert("between 1 and 100"):
            court.set_min_confidence(bad)


def test_the_constructor_refuses_a_bad_registry(direct_deploy, direct_vm, direct_owner):
    from conftest import CONTRACTS

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("must be a 20 byte address"):
        direct_deploy(CONTRACTS["court"], "0xdeadbeef", 70, str(ATTO))


def test_the_config_view_reports_what_was_deployed(court):
    from conftest import REGISTRY_ADDRESS

    config = court.get_config()
    assert config["registry"].lower() == REGISTRY_ADDRESS.lower()
    assert config["min_confidence"] == 70
    assert config["grounds"] == [
        "MEDICAL_NECESSITY", "CODING_ERROR", "NETWORK_STATUS",
        "PRIOR_AUTH_DEFECT", "TIMELINESS",
    ]
    assert config["band_upper_usd"] == [500, 2000, 7500, 25000, 75000]


def test_the_public_docket_lists_newest_first(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    first = file_clean_case(court)
    second = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    page = court.docket_page(0, 10)
    assert [row["docket"] for row in page] == [second, first]
    assert page[0]["ground"] == "MEDICAL_NECESSITY"
    assert page[0]["overturn_recommended"] is True
    assert page[1]["ground"] == ""
    assert page[1]["status"] == "FILED"


def test_adjudicating_against_a_rule_that_lapsed_after_filing_is_refused(
    make_court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """A rule can lapse between filing and adjudication. The gate is checked twice."""
    court, stub = make_court()
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)

    stub.view("lapse_reason", lambda _plan_id="": "The rule for that plan lapsed on 2026-05-31.")
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157)))

    with direct_vm.expect_revert("lapsed on 2026-05-31"):
        court.adjudicate(docket)


def test_a_rule_with_no_declared_sections_cannot_be_adjudicated(
    make_court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """Without a closed set of sections there is nothing checkable to cite."""
    from conftest import BARIATRIC_RULE

    bare = dict(BARIATRIC_RULE)
    bare["clause_sections"] = []
    court, _ = make_court(rule=bare)
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157)))

    with direct_vm.expect_revert("declares no clause sections"):
        court.adjudicate(docket)


def test_file_case_with_member_bound_filer(court, direct_vm, direct_alice, direct_bob):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court, filer_address=str(direct_bob))
    case = court.get_case(docket)
    assert case["filer"].lower() == str(direct_bob).lower()
    assert docket in court.cases_for_filer(str(direct_bob))
    assert docket not in court.cases_for_filer(str(direct_alice))


def test_file_case_with_invalid_filer_address_is_refused(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("must be a 0x prefixed 20 byte address"):
        file_clean_case(court, filer_address="not-an-address")


def test_mark_settled_on_an_advanced_case_is_restricted_to_pool(
    court, direct_vm, direct_owner, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_owner
    court.set_pool(str(direct_bob))

    direct_vm.sender = direct_bob
    court.note_advance(docket, str(5_000 * ATTO))

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("only the advance pool may settle an advanced case"):
        court.mark_settled(docket, str(5_000 * ATTO))

    direct_vm.sender = direct_bob
    court.mark_settled(docket, str(5_000 * ATTO))
    case = court.get_case(docket)
    assert case["status"] == "SETTLED"
    assert int(case["settled_atto"]) == 5_000 * ATTO


def test_mark_settled_by_pool_on_non_advanced_case_is_refused(
    court, direct_vm, direct_owner, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_owner
    court.set_pool(str(direct_bob))

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("only an advanced case can be settled by the advance pool"):
        court.mark_settled(docket, str(5_000 * ATTO))


def test_mark_settled_on_unadjudicated_filed_case_is_refused(
    court, direct_vm, direct_owner, direct_alice
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("has not been adjudicated"):
        court.mark_settled(docket, str(5_000 * ATTO))


def test_withdraw_bond_for_relayed_payout(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    court.adjudicate(docket)
    court.resolve_review(docket)

    assert int(court.bond_of(str(direct_bob))) == ATTO // 4

    # Alice relays the withdrawal for Bob
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("must be a 0x prefixed 20 byte address"):
        court.withdraw_bond_for("invalid-address")

    with direct_vm.expect_revert("nothing is owed"):
        court.withdraw_bond_for(str(direct_alice))

    withdrawn = court.withdraw_bond_for(str(direct_bob))
    assert int(withdrawn) == ATTO // 4
    assert int(court.bond_of(str(direct_bob))) == 0



# ------------------------------------- the member a filing belongs to, in any spelling
#
# A filing is relayed. The member never signs anything, so the address the court records
# as the filer arrives as an argument, and it arrives from Privy in lowercase. The court
# derives the checksummed spelling from its own Address type, so the index a member is
# looked up in has to answer to both or "my cases" comes back empty for everybody.


def test_a_filing_is_found_by_the_member_address_in_any_spelling(
    court, direct_vm, direct_alice
):
    member = "0x" + "Bb" * 20
    direct_vm.sender = direct_alice
    docket = file_clean_case(court, filer_address=member.lower())

    for spelling in (member, member.lower(), member.upper().replace("0X", "0x")):
        assert court.cases_for_filer(spelling) == [docket]

    # And the relayer that signed it does not own the case.
    assert court.cases_for_filer(str(direct_alice)) == []


def test_a_filing_cannot_be_bound_to_the_zero_address(court, direct_vm, direct_alice):
    """An advance and a bond are both paid to the filer, so the burn address is refused."""
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("must not be the zero address"):
        file_clean_case(court, filer_address="0x" + "0" * 40)


def test_the_pool_cannot_be_pointed_at_the_zero_address(court, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("must not be the zero address"):
        court.set_pool("0x" + "0" * 40)
    with direct_vm.expect_revert("must not be the zero address"):
        court.set_registry("0x" + "0" * 40)


def test_a_bond_is_relayed_back_to_the_member_in_any_spelling(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """The member asks for their bond through the relayer, so the lookup cannot be fussy."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    court.adjudicate(docket)
    court.resolve_review(docket)

    mixed = str(direct_bob)
    assert mixed != mixed.lower()  # otherwise this test proves nothing
    assert int(court.bond_of(mixed)) == ATTO // 4
    assert int(court.bond_of(mixed.lower())) == ATTO // 4

    # Alice relays the withdrawal, naming Bob in the spelling the API holds.
    direct_vm.sender = direct_alice
    assert int(court.withdraw_bond_for(mixed.lower())) == ATTO // 4
    assert int(court.bond_of(mixed)) == 0


def test_a_relayed_bond_withdrawal_refuses_the_zero_address(court, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("must not be the zero address"):
        court.withdraw_bond_for("0x" + "0" * 40)


# ------------------------------------------- what the pool is allowed to be told, and when
#
# The advance gate used to look at open reviews and at whether an advance had already
# been made, and stop. SETTLED and REJECTED were absent from it, so the pool would pay
# real capital against a case the court had already closed, including one it had rejected
# as never having been fileable, and note_advance then walked that case back to ADVANCED.


def test_a_settled_case_cannot_be_advanced_against(
    court, direct_vm, direct_owner, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    assert court.is_advanceable(docket)["ok"] is True

    direct_vm.sender = direct_owner
    court.mark_settled(docket, str(9_000 * ATTO))

    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "closed" in gate["reason"]


def test_a_rejected_case_cannot_be_advanced_against(
    court, direct_vm, direct_owner, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_owner
    court.reject_case(docket, "filed against the wrong plan")

    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "closed" in gate["reason"]


def test_note_advance_refuses_to_reopen_a_closed_case(
    court, direct_vm, direct_owner, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """The second lock. The gate says no, and calling straight through says no too."""
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    direct_vm.sender = direct_owner
    court.set_pool(str(direct_bob))
    court.mark_settled(docket, str(9_000 * ATTO))

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("cannot be advanced against"):
        court.note_advance(docket, str(2 * ATTO))
    assert court.get_case(docket)["status"] == "SETTLED"


def test_note_advance_refuses_a_case_with_no_verdict(
    court, direct_vm, direct_owner, direct_alice, direct_bob
):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)

    direct_vm.sender = direct_owner
    court.set_pool(str(direct_bob))

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("nothing to advance against"):
        court.note_advance(docket, str(2 * ATTO))


# ------------------------------------------------ the payout predicate, settled once
#
# `confidence` is only bound to within CONFIDENCE_TOLERANCE, so it is a judgement figure
# and not a number two nodes agree on exactly. The gate used to recompute
# `confidence >= self.min_confidence` at advance time against a floor the owner can move,
# which meant a settled payout could be re-decided from a figure consensus never pinned.


def test_the_payout_gate_is_the_panels_own_answer_not_a_fresh_comparison(
    court, direct_vm, direct_owner, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(
        court, direct_vm, aetna_0157, cms_100_1, answer=verdict_json(quote, confidence=95)
    )

    verdict = court.get_verdict(docket)
    assert int(verdict["confidence"]) == 95
    assert int(verdict["confidence_floor"]) == 70
    assert verdict["crosses_confidence_band"] is True
    assert court.is_advanceable(docket)["ok"] is True

    # Moving the floor afterwards cannot unmake a decision the panel already agreed.
    direct_vm.sender = direct_owner
    court.set_min_confidence(100)
    assert court.get_verdict(docket)["crosses_confidence_band"] is True
    assert court.is_advanceable(docket)["ok"] is True

    # And lowering it cannot release a payout the panel refused either.
    court.set_min_confidence(1)
    assert int(court.get_verdict(docket)["confidence_floor"]) == 70


def test_a_verdict_below_the_floor_stays_below_it(
    court, direct_vm, direct_owner, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(
        court, direct_vm, aetna_0157, cms_100_1, answer=verdict_json(quote, confidence=40)
    )
    verdict = court.get_verdict(docket)
    assert verdict["crosses_confidence_band"] is False
    gate = court.is_advanceable(docket)
    assert gate["ok"] is False
    assert "confidence band" in gate["reason"]

    direct_vm.sender = direct_owner
    court.set_min_confidence(10)
    assert court.is_advanceable(docket)["ok"] is False


# ------------------------------------------------ a citation is bound to where it came from


def test_a_quote_from_another_section_is_refused(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    """The gap this closes.

    A validator accepted an exclusion lifted from Scope of Policy filed under Medical
    Necessity on a verdict that overturned a denial, because the binding asked only
    whether the sentence was somewhere in the bulletin. The member's letter prints the
    section and the sentence together, so that is a citation which fails the moment
    anybody looks it up.
    """
    direct_vm.sender = direct_alice
    _adjudicated(court, direct_vm, aetna_0157, cms_100_1)

    elsewhere = real_quote(aetna_0157, section="Scope of Policy")
    assert elsewhere in policy_text(aetna_0157)
    assert elsewhere not in _section_text(aetna_0157, "Medical Necessity")

    lifted = _tampered(direct_vm, "clause_quote", elsewhere)
    assert direct_vm.run_validator(leader_result=lifted) is False


def test_the_committed_quote_is_verbatim_in_the_section_it_cites(
    court, direct_vm, direct_alice, aetna_0157, cms_100_1
):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    verdict = court.get_verdict(docket)
    body = _section_text(aetna_0157, verdict["clause_section"])
    assert body != ""
    assert verdict["clause_quote"] in body


# --------------------------------------- an appeal turns on the decision, not the document


def test_a_revised_bulletin_does_not_award_the_bond_on_its_own(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """ruling_digest covers the decision. It used to cover the document fingerprint too.

    An appeal takes a second panel round in real time, and the registry tracks bulletin
    revisions precisely because insurers make them. So any edit between rounds moved the
    digest and returned the bond as though the challenger had been proved right, on a
    second reading that decided exactly the same thing.
    """
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)
    first = court.get_verdict(docket)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    edited = aetna_0157.replace(
        b"because the peer-reviewed medical literature shows them to be either unsafe",
        b"because the peer-reviewed medical literature as of 2026 shows them to be unsafe",
        1,
    )
    assert edited != aetna_0157

    direct_vm.clear_mocks()
    arm(direct_vm, edited, cms_100_1, verdict_json(quote))
    second = court.adjudicate(docket)

    # Same decision on every field that decides anything.
    assert bool(second["overturn_recommended"]) == bool(first["overturn_recommended"])
    assert second["ground"] == first["ground"]
    assert second["clause_id"] == first["clause_id"]
    assert int(second["recoverable_band"]) == int(first["recoverable_band"])
    # The document fingerprint moved, and the transaction digest moved with it.
    assert court.get_verdict(docket)["bulletin_digest"] != first["bulletin_digest"]
    assert second["digest"] != first["digest"]
    # The ruling did not, so the bond stays with the court.
    assert second["ruling_digest"] == first["ruling_digest"]

    out = court.resolve_review(docket)
    assert out["verdict_changed"] is False
    assert out["bond_returned"] is False
    assert int(court.bond_of(str(direct_bob))) == 0


def test_a_second_panel_that_decides_differently_still_frees_the_bond(
    court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1
):
    """The control. Narrowing the digest must not stop a real reversal paying out."""
    direct_vm.sender = direct_alice
    quote = real_quote(aetna_0157)
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1, quote=quote)

    direct_vm.sender = direct_bob
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0

    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(quote, overturn=False))
    court.adjudicate(docket)

    out = court.resolve_review(docket)
    assert out["verdict_changed"] is True
    assert out["bond_returned"] is True
    assert int(court.bond_of(str(direct_bob))) == ATTO // 4


def test_appeal_preserves_exact_original_evidence_and_verdict(court, direct_vm, direct_alice, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157)))
    court.adjudicate(docket)
    original = court.get_verdict(docket)
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    court.amend_evidence(docket, 'b' * 64, CLEAN_RATIONALE + ' The authorization criterion was satisfied.')
    direct_vm.clear_mocks()
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157), overturn=False))
    court.adjudicate(docket)
    history = court.verdict_history(docket)
    assert history['total'] == 2
    assert history['items'][0] == original
    assert history['items'][0]['provenance']['evidence_sha256'] == 'a' * 64
    assert history['items'][1]['provenance']['evidence_sha256'] == 'b' * 64
    assert history['items'][0]['provenance']['policy']['bulletin_url'] == AETNA_0157
    assert history['items'][0]['provenance']['sha256'] != history['items'][1]['provenance']['sha256']
    assert [e['kind'] for e in court.case_history(docket)['items']] == ['FILED', 'ADJUDICATED', 'APPEAL_OPENED', 'EVIDENCE_UPDATED', 'ADJUDICATED']


def test_evidence_amendment_requires_pending_panel_and_authority(court, direct_vm, direct_alice, direct_bob, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = file_clean_case(court)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert('only the filer'):
        court.amend_evidence(docket, 'b' * 64, CLEAN_RATIONALE)
    direct_vm.sender = direct_alice
    arm(direct_vm, aetna_0157, cms_100_1, verdict_json(real_quote(aetna_0157)))
    court.adjudicate(docket)
    with direct_vm.expect_revert('before a pending panel'):
        court.amend_evidence(docket, 'b' * 64, CLEAN_RATIONALE)


def test_appeal_after_advance_keeps_financial_state(court, direct_vm, direct_owner, direct_alice, direct_bob, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    direct_vm.sender = direct_owner
    court.set_pool(str(direct_bob))
    direct_vm.sender = direct_bob
    court.note_advance(docket, str(ATTO))
    court.note_advance(docket, str(ATTO))  # safe asynchronous duplicate
    direct_vm.sender = direct_alice
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    court.resolve_review(docket)
    assert court.get_case(docket)['status'] == 'ADVANCED'
    assert court.get_case(docket)['advanced_atto'] == str(ATTO)
    direct_vm.sender = direct_bob
    court.mark_settled(docket, str(ATTO))
    court.mark_settled(docket, str(ATTO))
    assert court.court_stats()['statuses']['SETTLED'] == 1


def test_evidence_only_change_does_not_award_bond(court, direct_vm, direct_alice, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    court.amend_evidence(docket, 'b' * 64, CLEAN_RATIONALE)
    court.adjudicate(docket)
    out = court.resolve_review(docket)
    assert out['verdict_changed'] is False
    assert out['bond_returned'] is False
    stats = court.court_stats()
    assert stats['bond_received_atto'] == stats['bond_forfeited_atto'] == str(ATTO // 4)
    assert stats['bond_claimable_atto'] == '0'


def test_bond_custody_and_funded_retry(court, direct_vm, direct_alice, aetna_0157, cms_100_1):
    direct_vm.sender = direct_alice
    docket = _adjudicated(court, direct_vm, aetna_0157, cms_100_1)
    direct_vm.value = ATTO // 4
    court.request_review(docket)
    direct_vm.value = 0
    abandoned = court.resolve_review(docket)
    assert abandoned['verdict_changed'] is False
    assert abandoned['bond_returned'] is True
    stats = court.court_stats()
    assert stats['bond_claimable_atto'] == stats['bond_received_atto']
    court.withdraw_bond()
    payment = court.bond_payment_history(str(direct_alice))['items'][0]
    assert payment['status'] == 'PENDING'
    assert court.court_stats()['bond_claimable_atto'] == '0'
    with direct_vm.expect_revert('funded refund'):
        court.retry_bond_payment(payment['id'])
    direct_vm.value = ATTO // 4
    court.refund_bond_payment(payment['id'])
    direct_vm.value = 0
    court.retry_bond_payment(payment['id'])
    assert court.bond_payment_history(str(direct_alice))['items'][0]['attempt'] == 2
    assert court.court_stats()['bond_paid_atto'] == str(ATTO // 4)


@pytest.mark.parametrize('text', [
    'Member ID: 43644', 'MRN: E66.01', 'Patient Name: Jane Example',
    'SSN 999\u200b-12\u200b-3456', 'Address: 42 Example Street',
])
def test_privacy_tripwire_rejects_labelled_codes_and_obfuscation(court, direct_vm, direct_alice, text):
    direct_vm.sender = direct_alice
    assert court.phi_scan(text)
    with direct_vm.expect_revert('contains'):
        court.file_case('AETNA-COMMERCIAL-BARIATRIC', 'bariatric_surgery', 'TX', '43644', 'E66.01', '50', text, '2026-04', str(ATTO), 'a' * 64)
    assert court.court_stats()['case_count'] == 0
