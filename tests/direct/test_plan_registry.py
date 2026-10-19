"""PlanRegistry: the gatekeeper for published coverage rules.

The point of this contract is to refuse. A rule that has lapsed, been retired or was never
registered must not be argued against, and most of these tests are about that refusal
happening rather than about the happy path.
"""

import json

import pytest

from conftest import (
    AETNA_0157,
    AETNA_SECTIONS,
    CMS_100_1,
    register_bariatric,
    serve,
)


# ----------------------------------------------------------------- registration

def test_registers_a_rule_and_reads_it_back(registry):
    plan_id = register_bariatric(registry)
    assert plan_id == "AETNA-COMMERCIAL-BARIATRIC"

    rule = registry.rule_for(plan_id)
    assert rule["insurer"] == "Aetna"
    assert rule["bulletin_number"] == "0157"
    assert rule["bulletin_url"] == AETNA_0157
    assert rule["cms_display_id"] == "100.1"
    assert rule["fetch_mode"] == "html"
    assert rule["state"] == "US"
    assert rule["active"] is True
    assert rule["retired"] is False
    assert rule["content_hash"] == ""
    assert rule["refresh_count"] == 0
    assert "Medical Necessity" in rule["clause_sections"]
    assert len(rule["clause_sections"]) == 5


def test_registry_stats_and_indexes_track_registration(registry):
    register_bariatric(registry)
    stats = registry.registry_stats()
    assert stats["rule_count"] == 1
    assert stats["active_count"] == 1
    assert stats["curator_count"] == 1

    assert registry.list_plan_ids() == ["AETNA-COMMERCIAL-BARIATRIC"]
    assert registry.plans_for_family("bariatric_surgery") == ["AETNA-COMMERCIAL-BARIATRIC"]
    assert registry.plans_for_insurer("Aetna") == ["AETNA-COMMERCIAL-BARIATRIC"]
    assert registry.plans_for_family("knee_arthroplasty") == []


def test_re_registering_updates_in_place_without_duplicating(registry):
    register_bariatric(registry)
    register_bariatric(registry, effective_to="2027-06-30")

    assert registry.registry_stats()["rule_count"] == 1
    assert len(registry.list_plan_ids()) == 1
    assert registry.rule_for("AETNA-COMMERCIAL-BARIATRIC")["effective_to"] == "2027-06-30"


# ------------------------------------------------------------- input validation

@pytest.mark.parametrize(
    "field,value,expected",
    [
        ("fetch_mode", "pdf", "fetch_mode must be one of"),
        ("state", "TEX", "state must be a two letter code"),
        ("effective_from", "15-06-2026", "must be an ISO date"),
        ("plan_id", "   ", "plan_id is required"),
        ("family_id", "", "family_id is required"),
    ],
)
def test_rejects_malformed_registration(registry, direct_vm, field, value, expected):
    args = {
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
        "cms_source_url": CMS_100_1,
        "cms_display_id": "100.1",
        "guideline_url": "",
        "clause_sections": AETNA_SECTIONS,
    }
    args[field] = value
    with direct_vm.expect_revert(expected):
        registry.register_rule(*args.values())


def test_rejects_an_expiry_that_precedes_the_start(registry, direct_vm):
    with direct_vm.expect_revert("effective_to must fall after effective_from"):
        register_bariatric(registry, effective_from="2026-06-01", effective_to="2026-01-01")


def test_rejects_a_bulletin_url_that_is_not_https(registry, direct_vm):
    with direct_vm.expect_revert("bulletin_url must be an https URL"):
        registry.register_rule(
            "X-Y-Z", "Aetna", "Commercial", "bariatric_surgery", "0157", "Obesity Surgery",
            "http://www.aetna.com/cpb/medical/data/100_199/0157.html", "html", "US",
            "2026-01-01", "2027-01-01", "", "", "", AETNA_SECTIONS,
        )


# ---------------------------------------------------------------- the gatekeeping

def test_a_rule_inside_its_window_is_usable(registry):
    register_bariatric(registry, effective_from="2026-01-01", effective_to="2027-01-01")
    assert registry.is_rule_active("AETNA-COMMERCIAL-BARIATRIC") is True
    assert registry.lapse_reason("AETNA-COMMERCIAL-BARIATRIC") == ""


def test_a_lapsed_rule_is_refused_and_says_why(registry, direct_vm):
    direct_vm.warp("2026-06-15T10:00:00Z")
    register_bariatric(registry, effective_from="2025-01-01", effective_to="2025-12-31")

    assert registry.is_rule_active("AETNA-COMMERCIAL-BARIATRIC") is False
    reason = registry.lapse_reason("AETNA-COMMERCIAL-BARIATRIC")
    assert "lapsed on 2025-12-31" in reason
    assert "Register the current bulletin" in reason


def test_a_rule_that_has_not_started_yet_is_refused(registry):
    register_bariatric(registry, effective_from="2026-11-01", effective_to="2027-11-01")
    assert registry.is_rule_active("AETNA-COMMERCIAL-BARIATRIC") is False
    assert "does not take effect until 2026-11-01" in registry.lapse_reason(
        "AETNA-COMMERCIAL-BARIATRIC"
    )


def test_an_unregistered_plan_is_refused(registry):
    assert registry.is_rule_active("CIGNA-COMMERCIAL-WHATEVER") is False
    assert "No rule is registered" in registry.lapse_reason("CIGNA-COMMERCIAL-WHATEVER")


def test_rule_for_raises_on_an_unknown_plan(registry, direct_vm):
    with direct_vm.expect_revert("no registered rule for plan"):
        registry.rule_for("NOPE")


def test_retiring_a_rule_takes_it_out_of_service(registry, direct_vm):
    register_bariatric(registry)
    registry.retire_rule("AETNA-COMMERCIAL-BARIATRIC")

    assert registry.is_rule_active("AETNA-COMMERCIAL-BARIATRIC") is False
    assert "has been retired" in registry.lapse_reason("AETNA-COMMERCIAL-BARIATRIC")
    assert registry.registry_stats()["active_count"] == 0
    assert registry.registry_stats()["rule_count"] == 1

    with direct_vm.expect_revert("already retired"):
        registry.retire_rule("AETNA-COMMERCIAL-BARIATRIC")


def test_extending_a_rule_brings_it_back_into_the_window(registry):
    direct = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry, effective_from="2025-01-01", effective_to="2025-12-31")
    assert registry.is_rule_active(direct) is False

    registry.extend_rule(direct, "2027-01-01")
    assert registry.is_rule_active(direct) is True


# ------------------------------------------------------------- access control

def test_only_a_curator_may_register(registry, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not a registry curator"):
        register_bariatric(registry)


def test_the_owner_can_appoint_a_curator_who_can_then_register(
    registry, direct_vm, direct_owner, direct_bob
):
    direct_vm.sender = direct_owner
    registry.set_curator(str(direct_bob), True)
    assert registry.is_curator(str(direct_bob)) is True

    direct_vm.sender = direct_bob
    register_bariatric(registry)
    assert registry.registry_stats()["rule_count"] == 1


def test_a_revoked_curator_loses_access(registry, direct_vm, direct_owner, direct_bob):
    direct_vm.sender = direct_owner
    registry.set_curator(str(direct_bob), True)
    registry.set_curator(str(direct_bob), False)
    assert registry.is_curator(str(direct_bob)) is False

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not a registry curator"):
        register_bariatric(registry)


def test_only_the_owner_may_appoint_curators(registry, direct_vm, direct_bob, direct_charlie):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not the registry owner"):
        registry.set_curator(str(direct_charlie), True)


def test_a_malformed_address_is_refused_as_a_curator(registry, direct_vm):
    with direct_vm.expect_revert("0x prefixed 20 byte address"):
        registry.set_curator("not-an-address", True)


# ------------------------------------------------------------------ sbc commitment

def test_an_sbc_hash_must_be_a_real_digest(registry, direct_vm):
    register_bariatric(registry)
    with direct_vm.expect_revert("must be 64 hex characters"):
        registry.set_sbc_hash("AETNA-COMMERCIAL-BARIATRIC", "deadbeef")


def test_an_sbc_hash_is_stored_and_an_empty_one_clears_it(registry):
    plan = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry)
    digest = "b" * 64
    registry.set_sbc_hash(plan, digest)
    assert registry.rule_for(plan)["sbc_hash"] == digest

    registry.set_sbc_hash(plan, "")
    assert registry.rule_for(plan)["sbc_hash"] == ""


def test_an_sbc_hash_survives_re_registration(registry):
    plan = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry)
    registry.set_sbc_hash(plan, "c" * 64)
    register_bariatric(registry, effective_to="2027-09-30")
    assert registry.rule_for(plan)["sbc_hash"] == "c" * 64


# -------------------------------------------------- refresh_rule, the nondet one

def test_refresh_hashes_the_real_bulletin_policy_region(
    registry, direct_vm, aetna_0157
):
    plan = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, aetna_0157)

    out = registry.refresh_rule(plan)

    assert out["first_observation"] is True
    assert out["changed"] is False
    assert out["mode"] == "html"
    assert len(out["content_hash"]) == 64
    # The anchor has to be a heading the real page actually carries.
    assert out["anchor"] in ("Scope of Policy", "Policy Scope of Policy", "Policy")
    # The sliced region must be substantial, which proves the slice found policy text and
    # not a navigation stub.
    assert out["region_len"] > 2000

    rule = registry.rule_for(plan)
    assert rule["content_hash"] == out["content_hash"]
    assert rule["refresh_count"] == 1
    assert rule["revision_count"] == 0
    assert rule["last_refreshed"].startswith("2026-")


def test_refresh_is_stable_across_repeated_fetches(registry, direct_vm, aetna_0157):
    plan = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, aetna_0157)

    first = registry.refresh_rule(plan)
    second = registry.refresh_rule(plan)

    # Same document, same digest. If this ever fails, strict_eq consensus would fail too.
    assert first["content_hash"] == second["content_hash"]
    assert second["changed"] is False
    assert registry.rule_for(plan)["refresh_count"] == 2
    assert registry.rule_for(plan)["revision_count"] == 0


def test_a_silent_policy_rewrite_is_recorded_as_a_revision(
    registry, direct_vm, aetna_0157
):
    plan = "AETNA-COMMERCIAL-BARIATRIC"
    register_bariatric(registry)

    serve(direct_vm, AETNA_0157, aetna_0157)
    first = registry.refresh_rule(plan)

    # The insurer quietly adds a criterion. Same URL, different rule.
    rewritten = aetna_0157.replace(
        b"Scope of Policy",
        b"Scope of Policy <p>Aetna now additionally requires six months of "
        b"supervised non surgical treatment before this procedure is considered.</p>",
        1,
    )
    assert rewritten != aetna_0157
    direct_vm.clear_mocks()
    serve(direct_vm, AETNA_0157, rewritten)

    second = registry.refresh_rule(plan)

    assert second["changed"] is True
    assert second["content_hash"] != first["content_hash"]
    assert second["previous_content_hash"] == first["content_hash"]

    rule = registry.rule_for(plan)
    assert rule["revision_count"] == 1
    assert rule["refresh_count"] == 2
    assert registry.registry_stats()["total_revisions"] == 1

    history = registry.revision_history(10)
    assert len(history) == 1
    entry = json.loads(history[0])
    assert entry["plan_id"] == plan
    assert entry["insurer"] == "Aetna"
    assert entry["from_hash"] == first["content_hash"]
    assert entry["to_hash"] == second["content_hash"]
    assert entry["bulletin_url"] == AETNA_0157


def test_refresh_reads_a_structured_coverage_document(registry, direct_vm, cms_100_1):
    """A json mode rule digests the CMS fields rather than slicing markup."""
    registry.register_rule(
        "CMS-NCD-BARIATRIC", "CMS", "Medicare", "bariatric_surgery", "100.1",
        "Bariatric Surgery for Treatment of Co-Morbid Conditions Related to Morbid Obesity",
        CMS_100_1, "json", "US", "2026-01-01", "2027-01-01",
        CMS_100_1, "100.1", "", "Indications and Limitations of Coverage",
    )
    serve(direct_vm, CMS_100_1, cms_100_1)

    out = registry.refresh_rule("CMS-NCD-BARIATRIC")
    assert out["mode"] == "json"
    assert out["anchor"] == "100.1"
    assert out["region_len"] > 1000
    assert len(out["content_hash"]) == 64


def test_refresh_classifies_a_dead_host_as_transient(registry, direct_vm):
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, b"", status=503)

    with direct_vm.expect_revert("[TRANSIENT]"):
        registry.refresh_rule("AETNA-COMMERCIAL-BARIATRIC")


def test_refresh_classifies_a_removed_bulletin_as_external(registry, direct_vm):
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, b"not here", status=404)

    with direct_vm.expect_revert("[EXTERNAL]"):
        registry.refresh_rule("AETNA-COMMERCIAL-BARIATRIC")


def test_refresh_refuses_a_page_with_no_policy_text(registry, direct_vm):
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, b"<html><body><p>Under maintenance.</p></body></html>")

    with direct_vm.expect_revert("no readable policy region"):
        registry.refresh_rule("AETNA-COMMERCIAL-BARIATRIC")


def test_refresh_refuses_a_retired_rule(registry, direct_vm, aetna_0157):
    register_bariatric(registry)
    registry.retire_rule("AETNA-COMMERCIAL-BARIATRIC")
    serve(direct_vm, AETNA_0157, aetna_0157)

    with direct_vm.expect_revert("is retired"):
        registry.refresh_rule("AETNA-COMMERCIAL-BARIATRIC")


def test_only_a_curator_may_refresh(registry, direct_vm, direct_bob, aetna_0157):
    register_bariatric(registry)
    serve(direct_vm, AETNA_0157, aetna_0157)
    direct_vm.sender = direct_bob

    with direct_vm.expect_revert("not a registry curator"):
        registry.refresh_rule("AETNA-COMMERCIAL-BARIATRIC")


# ------------------------------------------------------------------- ownership

def test_ownership_transfers_and_the_old_owner_loses_control(
    registry, direct_vm, direct_owner, direct_bob, direct_charlie
):
    direct_vm.sender = direct_owner
    registry.transfer_ownership(str(direct_bob))
    assert registry.get_owner() == str(direct_bob)

    with direct_vm.expect_revert("not the registry owner"):
        registry.set_curator(str(direct_charlie), True)

    direct_vm.sender = direct_bob
    registry.set_curator(str(direct_charlie), True)
    assert registry.is_curator(str(direct_charlie)) is True


def test_policy_versions_preserve_registration_extension_and_retirement(registry):
    plan = register_bariatric(registry)
    first = registry.policy_version(plan, 1)
    registry.extend_rule(plan, '2028-01-01')
    registry.set_sbc_hash(plan, 'b' * 64)
    registry.retire_rule(plan)
    history = registry.policy_history(plan)
    assert history['total'] == 4
    assert [v['event'] for v in history['items']] == ['RETIRED', 'SBC_UPDATED', 'EXTENDED', 'REGISTERED']
    assert registry.policy_version(plan, 1) == first
    assert first['effective_to'] == '2027-01-01'
    assert history['items'][0]['policy_digest'] != first['policy_digest']
    assert len({v['policy_digest'] for v in history['items']}) == 4


def test_monitoring_unchanged_source_does_not_invent_policy_revision(registry, direct_vm, aetna_0157):
    plan = register_bariatric(registry)
    serve(direct_vm, AETNA_0157, aetna_0157)
    registry.refresh_rule(plan)
    version = registry.rule_for(plan)['policy_version']
    digest = registry.rule_for(plan)['policy_digest']
    registry.refresh_rule(plan)
    assert registry.rule_for(plan)['policy_version'] == version
    assert registry.rule_for(plan)['policy_digest'] == digest
    assert registry.policy_history(plan)['items'][0]['event'] == 'SOURCE_OBSERVED'


def test_policy_active_count_tracks_calendar_expiry(registry, direct_vm):
    register_bariatric(registry, effective_from='2025-01-01', effective_to='2025-12-31')
    assert registry.registry_stats()['active_count'] == 0
    assert registry.registry_stats()['unretired_count'] == 1


def test_curator_access_is_case_insensitive(registry, direct_vm, direct_owner, direct_alice):
    direct_vm.sender = direct_owner
    registry.set_curator(str(direct_alice), True)
    assert registry.is_curator(str(direct_alice).lower())
    direct_vm.sender = direct_alice
    register_bariatric(registry)
    assert registry.registry_stats()['rule_count'] == 1


def test_reactivation_updates_counts_and_keeps_policy_history(registry):
    plan = register_bariatric(registry)
    registry.retire_rule(plan)
    assert registry.registry_stats()['active_count'] == 0
    register_bariatric(registry)
    assert registry.registry_stats()['active_count'] == 1
    assert registry.policy_history(plan)['total'] == 3
