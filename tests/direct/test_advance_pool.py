"""AdvancePool: underwriter capital, the advance, and getting the money back.

The pool is deliberately dull. It calls no model and fetches nothing. Every judgement it
acts on was already made under validator consensus in OmbudsCourt, and all this contract
does is read that result and move capital. So these tests are mostly arithmetic and
refusal, which is exactly what you want from the part that holds the money.
"""

import pytest

from conftest import (
    ATTO,
    COURT_ADDRESS,
    CONTRACTS,
    ContractStub,
    install_stubs,
)

BAND_CAPS = (ATTO // 4, ATTO // 2, ATTO, ATTO * 2, ATTO * 3, ATTO * 4)
CAPS_CSV = ",".join(str(v) for v in BAND_CAPS)

DOCKET = "OMB-2026-000001"


def court_stub(
    *,
    ok: bool = True,
    reason: str = "",
    band: int = 2,
    disputed_atto: int = 12_000 * ATTO,
    filer: str = "0x" + "aa" * 20,
) -> ContractStub:
    stub = ContractStub(COURT_ADDRESS)
    answer = {
        "ok": ok,
        "reason": reason,
        "band": band,
        "disputed_atto": str(disputed_atto),
        "filer": filer,
    }
    if not ok:
        answer = {"ok": False, "reason": reason, "band": band}
    stub.view("is_advanceable", lambda _docket="": answer)
    return stub


@pytest.fixture
def make_pool(direct_deploy, direct_vm, direct_owner):
    def build(*, stub: ContractStub | None = None, rate=3500, fee=1200, utilisation=7000):
        direct_vm.sender = direct_owner
        direct_vm.warp("2026-06-15T10:00:00Z")
        active = stub or court_stub()
        install_stubs(direct_vm, active)
        pool = direct_deploy(
            CONTRACTS["pool"], COURT_ADDRESS, rate, fee, utilisation, CAPS_CSV
        )
        return pool, active

    return build


@pytest.fixture
def pool(make_pool):
    contract, _ = make_pool()
    return contract


def fund(pool, vm, who, amount):
    vm.sender = who
    vm.value = amount
    out = pool.deposit()
    vm.value = 0
    return out


# ------------------------------------------------------------------ construction

def test_the_constructor_records_the_terms(pool):
    config = pool.get_config()
    assert config["court"].lower() == COURT_ADDRESS.lower()
    assert config["advance_rate_bps"] == 3500
    assert config["fee_bps"] == 1200
    assert config["max_utilisation_bps"] == 7000
    assert [int(c) for c in config["band_caps_atto"]] == list(BAND_CAPS)


@pytest.mark.parametrize(
    "rate,fee,util,expected",
    [
        (0, 1200, 7000, "advance_rate_bps must sit between"),
        (10001, 1200, 7000, "advance_rate_bps must sit between"),
        (3500, 3001, 7000, "fee_bps must sit between"),
        (3500, 1200, 500, "max_utilisation_bps must sit between"),
        (3500, 1200, 10001, "max_utilisation_bps must sit between"),
    ],
)
def test_the_constructor_refuses_impossible_terms(
    direct_deploy, direct_vm, direct_owner, rate, fee, util, expected
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert(expected):
        direct_deploy(CONTRACTS["pool"], COURT_ADDRESS, rate, fee, util, CAPS_CSV)


def test_the_constructor_refuses_a_bad_court_address(direct_deploy, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("20 byte address"):
        direct_deploy(CONTRACTS["pool"], "0xnope", 3500, 1200, 7000, CAPS_CSV)


def test_an_empty_pool_governs_nothing(pool):
    stats = pool.pool_stats()
    assert int(stats["total_value_governed_atto"]) == 0
    assert int(stats["free_capital_atto"]) == 0
    assert int(stats["outstanding_atto"]) == 0
    assert stats["underwriter_count"] == 0
    assert stats["utilisation_bps"] == 0


# ---------------------------------------------------------------------- deposits

def test_a_deposit_becomes_governed_capital(pool, direct_vm, direct_alice):
    out = fund(pool, direct_vm, direct_alice, 10 * ATTO)
    assert int(out["deposited_atto"]) == 10 * ATTO

    stats = pool.pool_stats()
    assert int(stats["total_value_governed_atto"]) == 10 * ATTO
    assert int(stats["free_capital_atto"]) == 10 * ATTO
    assert stats["underwriter_count"] == 1

    position = pool.position_of(str(direct_alice))
    assert int(position["principal_atto"]) == 10 * ATTO
    assert position["deposit_count"] == 1
    assert position["share_bps"] == 10000


def test_two_underwriters_split_the_pool_by_share(pool, direct_vm, direct_alice, direct_bob):
    fund(pool, direct_vm, direct_alice, 30 * ATTO)
    fund(pool, direct_vm, direct_bob, 10 * ATTO)

    assert pool.position_of(str(direct_alice))["share_bps"] == 7500
    assert pool.position_of(str(direct_bob))["share_bps"] == 2500
    assert pool.pool_stats()["underwriter_count"] == 2
    assert int(pool.pool_stats()["total_value_governed_atto"]) == 40 * ATTO


def test_repeat_deposits_add_up(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 5 * ATTO)
    fund(pool, direct_vm, direct_alice, 7 * ATTO)
    position = pool.position_of(str(direct_alice))
    assert int(position["principal_atto"]) == 12 * ATTO
    assert position["deposit_count"] == 2
    assert pool.pool_stats()["underwriter_count"] == 1


def test_a_deposit_with_no_value_is_refused(pool, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("deposit must carry value"):
        pool.deposit()


def test_an_unknown_address_has_an_empty_position(pool):
    position = pool.position_of("0x" + "99" * 20)
    assert int(position["principal_atto"]) == 0
    assert position["share_bps"] == 0


# ------------------------------------------------------------- quoting an advance

def test_a_quote_explains_what_limits_the_payout(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    quote = pool.quote_advance(DOCKET)

    assert quote["eligible"] is True
    # 35 percent of 12,000 is 4,200, which is far above the band 2 ceiling of one unit.
    assert int(quote["by_rate_atto"]) == (12_000 * ATTO * 3500) // 10000
    assert int(quote["band_cap_atto"]) == BAND_CAPS[2]
    assert int(quote["amount_atto"]) == BAND_CAPS[2]
    assert quote["limited_by"] == "the ceiling on this payout band"
    assert quote["member"] == "0x" + "aa" * 20


def test_a_quote_reports_the_court_refusing(make_pool, direct_vm, direct_alice):
    pool, _ = make_pool(
        stub=court_stub(ok=False, reason="The verdict upheld the denial, so there is nothing to advance against.")
    )
    fund(pool, direct_vm, direct_alice, 100 * ATTO)

    quote = pool.quote_advance(DOCKET)
    assert quote["eligible"] is False
    assert "upheld the denial" in quote["reason"]
    assert int(quote["amount_atto"]) == 0


def test_a_quote_against_an_empty_pool_is_honest_about_it(pool):
    quote = pool.quote_advance(DOCKET)
    assert quote["eligible"] is False
    assert "no capital free" in quote["reason"]


def test_the_utilisation_ceiling_caps_a_quote(make_pool, direct_vm, direct_alice):
    """Band 5 wants four units, but seventy percent of a five unit pool is three and a half."""
    pool, _ = make_pool(stub=court_stub(band=5, disputed_atto=200_000 * ATTO))
    fund(pool, direct_vm, direct_alice, 5 * ATTO)

    quote = pool.quote_advance(DOCKET)
    assert quote["eligible"] is True
    assert int(quote["amount_atto"]) == (5 * ATTO * 7000) // 10000
    assert quote["limited_by"] == "the pool's utilisation ceiling"


# ------------------------------------------------------------------- advancing

def test_an_advance_pays_the_member_and_is_recorded(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    out = pool.advance(DOCKET)

    assert out["docket"] == DOCKET
    assert out["member"] == "0x" + "aa" * 20
    assert int(out["amount_atto"]) == BAND_CAPS[2]
    assert out["band"] == 2

    record = pool.get_advance(DOCKET)
    assert record["status"] == "OUTSTANDING"
    assert int(record["amount_atto"]) == BAND_CAPS[2]
    assert int(record["disputed_atto"]) == 12_000 * ATTO
    assert record["made_at"].startswith("2026-")

    stats = pool.pool_stats()
    assert int(stats["outstanding_atto"]) == BAND_CAPS[2]
    assert int(stats["free_capital_atto"]) == 100 * ATTO - BAND_CAPS[2]
    assert stats["advance_count"] == 1


def test_an_advance_tells_the_court(make_pool, direct_vm, direct_alice):
    contract, stub = make_pool()
    fund(contract, direct_vm, direct_alice, 100 * ATTO)
    contract.advance(DOCKET)

    emitted = [call for call in stub.calls if call[0] == "note_advance"]
    assert len(emitted) == 1
    assert emitted[0][1][0] == DOCKET
    assert int(emitted[0][1][1]) == BAND_CAPS[2]


def test_the_same_docket_cannot_be_advanced_twice(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    pool.advance(DOCKET)
    with direct_vm.expect_revert("already been advanced against"):
        pool.advance(DOCKET)


def test_an_advance_the_court_refuses_is_refused(make_pool, direct_vm, direct_alice):
    pool, _ = make_pool(
        stub=court_stub(ok=False, reason="That case has not been adjudicated yet.")
    )
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    with direct_vm.expect_revert("not been adjudicated"):
        pool.advance(DOCKET)


def test_an_advance_from_an_empty_pool_is_refused(pool, direct_vm):
    with direct_vm.expect_revert("no capital free to advance"):
        pool.advance(DOCKET)


def test_an_advance_is_capped_by_free_capital(make_pool, direct_vm, direct_alice):
    """Band 0 wants a quarter unit. A pool holding a tenth can only give a tenth."""
    pool, _ = make_pool(stub=court_stub(band=0, disputed_atto=400 * ATTO))
    fund(pool, direct_vm, direct_alice, ATTO // 10)

    out = pool.advance(DOCKET)
    assert int(out["amount_atto"]) == (ATTO // 10 * 7000) // 10000
    assert int(pool.pool_stats()["free_capital_atto"]) == ATTO // 10 - int(out["amount_atto"])


def test_an_advance_to_a_malformed_member_is_refused(make_pool, direct_vm, direct_alice):
    pool, _ = make_pool(stub=court_stub(filer="0xnot-an-address"))
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    with direct_vm.expect_revert("member must be a 0x prefixed 20 byte address"):
        pool.advance(DOCKET)


# -------------------------------------------------------------------- recovery

def test_a_full_recovery_returns_principal_and_a_fee(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    fee = (advance * 1200) // 10000
    paid = advance + fee + (2 * ATTO)  # the insurer pays more than the advance

    direct_vm.value = paid
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert out["status"] == "RECOVERED"
    assert int(out["received_atto"]) == paid
    assert int(out["fee_atto"]) == fee
    assert int(out["to_pool_atto"]) == advance + fee
    # Everything above principal plus fee belongs to the member, not the pool.
    assert int(out["to_member_atto"]) == 2 * ATTO
    assert int(out["shortfall_atto"]) == 0

    assert int(pool.claimable_of("0x" + "aa" * 20)) == 2 * ATTO
    stats = pool.pool_stats()
    assert int(stats["outstanding_atto"]) == 0
    assert int(stats["total_value_governed_atto"]) == 100 * ATTO + fee
    assert int(stats["total_fees_atto"]) == fee


def test_the_fee_accrues_to_underwriters_by_share(pool, direct_vm, direct_alice, direct_bob):
    fund(pool, direct_vm, direct_alice, 75 * ATTO)
    fund(pool, direct_vm, direct_bob, 25 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000

    direct_vm.value = advance + fee
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    alice_cut = int(pool.position_of(str(direct_alice))["fees_earned_atto"])
    bob_cut = int(pool.position_of(str(direct_bob))["fees_earned_atto"])
    assert alice_cut == (fee * 75) // 100
    assert bob_cut == (fee * 25) // 100


def test_an_insurer_paying_less_than_the_advance_books_a_loss(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    short = advance // 2
    direct_vm.value = short
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert int(out["fee_atto"]) == 0
    assert int(out["to_member_atto"]) == 0
    assert int(out["shortfall_atto"]) == advance - short

    stats = pool.pool_stats()
    assert int(stats["outstanding_atto"]) == 0
    assert int(stats["total_written_off_atto"]) == advance - short
    # Equity is down by exactly what was never recovered.
    assert int(stats["total_value_governed_atto"]) == 100 * ATTO - (advance - short)


def test_a_recovery_against_an_unknown_docket_is_refused(pool, direct_vm):
    direct_vm.value = ATTO
    with direct_vm.expect_revert("nothing has been advanced against"):
        pool.record_recovery("OMB-2026-999999")
    direct_vm.value = 0


def test_a_recovery_with_no_value_is_refused(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    pool.advance(DOCKET)
    direct_vm.value = 0
    with direct_vm.expect_revert("recovery must carry value"):
        pool.record_recovery(DOCKET)


def test_a_docket_cannot_be_recovered_twice(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    direct_vm.value = advance
    pool.record_recovery(DOCKET)
    with direct_vm.expect_revert("already RECOVERED"):
        pool.record_recovery(DOCKET)
    direct_vm.value = 0


def test_a_recovery_tells_the_court_to_settle(make_pool, direct_vm, direct_alice):
    pool, stub = make_pool()
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    direct_vm.value = advance
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    settled = [call for call in stub.calls if call[0] == "mark_settled"]
    assert len(settled) == 1
    assert settled[0][1][0] == DOCKET


# -------------------------------------------------------------------- write offs

def test_a_write_off_takes_the_loss_openly(pool, direct_vm, direct_owner, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    direct_vm.sender = direct_owner
    out = pool.write_off(DOCKET, "The insurer went through external review and prevailed.")

    assert int(out["written_off_atto"]) == advance
    assert pool.get_advance(DOCKET)["status"] == "WRITTEN_OFF"
    stats = pool.pool_stats()
    assert int(stats["outstanding_atto"]) == 0
    assert int(stats["total_value_governed_atto"]) == 100 * ATTO - advance


def test_a_write_off_needs_a_reason(pool, direct_vm, direct_owner, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    pool.advance(DOCKET)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("needs a stated reason"):
        pool.write_off(DOCKET, "   ")


def test_only_the_owner_may_write_off(pool, direct_vm, direct_alice, direct_bob):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    pool.advance(DOCKET)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not the pool owner"):
        pool.write_off(DOCKET, "I just feel like it.")


# ------------------------------------------------------------------ withdrawals

def test_an_underwriter_can_take_free_capital_back(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 10 * ATTO)
    out = pool.withdraw(str(4 * ATTO))

    assert int(out["withdrawn_atto"]) == 4 * ATTO
    assert int(out["remaining_principal_atto"]) == 6 * ATTO
    assert int(pool.pool_stats()["total_value_governed_atto"]) == 6 * ATTO


def test_capital_out_on_an_advance_cannot_be_withdrawn(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 2 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    free = 2 * ATTO - advance

    with direct_vm.expect_revert("is free right now"):
        pool.withdraw(str(2 * ATTO))

    out = pool.withdraw(str(free))
    assert int(out["withdrawn_atto"]) == free


def test_an_underwriter_cannot_withdraw_more_than_they_put_in(
    pool, direct_vm, direct_alice, direct_bob
):
    fund(pool, direct_vm, direct_alice, 10 * ATTO)
    fund(pool, direct_vm, direct_bob, 10 * ATTO)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("may withdraw at most"):
        pool.withdraw(str(15 * ATTO))


def test_earned_fees_are_withdrawable(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000
    direct_vm.value = advance + fee
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    out = pool.withdraw(str(100 * ATTO + fee))
    assert int(out["withdrawn_atto"]) == 100 * ATTO + fee
    assert int(pool.pool_stats()["total_value_governed_atto"]) == 0


def test_a_stranger_cannot_withdraw(pool, direct_vm, direct_alice, direct_charlie):
    fund(pool, direct_vm, direct_alice, 10 * ATTO)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("has no position in this pool"):
        pool.withdraw(str(ATTO))


def test_a_zero_withdrawal_is_refused(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 10 * ATTO)
    with direct_vm.expect_revert("withdrawal must be above zero"):
        pool.withdraw("0")


# -------------------------------------------------------------- member claims

def test_a_member_claims_the_surplus(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000
    direct_vm.value = advance + fee + (3 * ATTO)
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    member = "0x" + "aa" * 20
    assert int(pool.claimable_of(member)) == 3 * ATTO


def test_claiming_nothing_is_refused(pool, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("nothing is claimable"):
        pool.claim()


# ------------------------------------------------------------------- the ledger

def test_the_ledger_lists_advances_newest_first(make_pool, direct_vm, direct_alice):
    pool, stub = make_pool()
    fund(pool, direct_vm, direct_alice, 200 * ATTO)
    pool.advance("OMB-2026-000001")
    pool.advance("OMB-2026-000002")

    ledger = pool.advance_ledger(10)
    assert [row["docket"] for row in ledger] == ["OMB-2026-000002", "OMB-2026-000001"]
    assert all(row["status"] == "OUTSTANDING" for row in ledger)


def test_an_unknown_advance_raises(pool, direct_vm):
    with direct_vm.expect_revert("nothing has been advanced against"):
        pool.get_advance("OMB-2026-404404")


# ---------------------------------------------------------------- administration

def test_the_owner_can_retune_the_terms(pool, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    pool.set_terms(2500, 800, 6000)
    config = pool.get_config()
    assert config["advance_rate_bps"] == 2500
    assert config["fee_bps"] == 800
    assert config["max_utilisation_bps"] == 6000


def test_retuning_is_owner_only(pool, direct_vm, direct_bob):
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not the pool owner"):
        pool.set_terms(2500, 800, 6000)


def test_band_caps_can_be_replaced(pool, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    pool.set_band_caps(f"{ATTO},{2 * ATTO},{3 * ATTO}")
    assert [int(c) for c in pool.get_config()["band_caps_atto"]] == [ATTO, 2 * ATTO, 3 * ATTO]


def test_empty_band_caps_are_refused(pool, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("at least one band ceiling is required"):
        pool.set_band_caps("  ")


def test_a_band_above_the_cap_list_uses_the_last_cap(make_pool, direct_vm, direct_alice):
    """A band index past the end clamps rather than reading off the end of the array."""
    pool, _ = make_pool(stub=court_stub(band=9, disputed_atto=500_000 * ATTO))
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    out = pool.advance(DOCKET)
    assert int(out["amount_atto"]) == BAND_CAPS[-1]


def test_the_court_address_can_be_repointed(pool, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    fresh = "0x" + "33" * 20
    pool.set_court(fresh)
    assert pool.get_config()["court"].lower() == fresh.lower()


def test_advance_pays_member_bound_address(make_pool, direct_vm, direct_alice):
    member = "0x" + "bb" * 20
    stub = court_stub(filer=member)
    pool, _ = make_pool(stub=stub)
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    out = pool.advance(DOCKET)
    assert out["member"].lower() == member.lower()
    assert pool.get_advance(DOCKET)["member"].lower() == member.lower()


def test_claim_for_transfers_surplus_to_member(make_pool, direct_vm, direct_alice):
    member = "0x" + "bb" * 20
    stub = court_stub(filer=member)
    pool, _ = make_pool(stub=stub)
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000

    direct_vm.sender = direct_alice
    direct_vm.value = advance + fee + (3 * ATTO)
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert int(pool.claimable_of(member)) == 3 * ATTO

    with direct_vm.expect_revert("must be a 0x prefixed 20 byte address"):
        pool.claim_for("not-an-address")

    with direct_vm.expect_revert("nothing is claimable"):
        pool.claim_for("0x" + "cc" * 20)

    claimed = pool.claim_for(member)
    assert int(claimed) == 3 * ATTO
    assert int(pool.claimable_of(member)) == 0


def test_record_recovery_refuses_unauthorised_stranger(make_pool, direct_vm, direct_alice):
    member = "0x" + "bb" * 20
    stub = court_stub(filer=member)
    pool, _ = make_pool(stub=stub)
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    stranger = "0x" + "99" * 20
    direct_vm.sender = stranger
    direct_vm.value = advance
    with direct_vm.expect_revert("caller is not authorised to record recovery"):
        pool.record_recovery(DOCKET)
    direct_vm.value = 0


def test_withdrawn_principal_fee_allocation(pool, direct_vm, direct_alice, direct_bob):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 100 * ATTO)

    direct_vm.sender = direct_bob
    pool.withdraw(str(50 * ATTO))

    pos_bob = pool.position_of(str(direct_bob))
    assert int(pos_bob["active_principal_atto"]) == 50 * ATTO
    pos_alice = pool.position_of(str(direct_alice))
    assert int(pos_alice["active_principal_atto"]) == 100 * ATTO

    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000

    direct_vm.sender = direct_alice
    direct_vm.value = advance + fee
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    alice_cut = int(pool.position_of(str(direct_alice))["fees_earned_atto"])
    bob_cut = int(pool.position_of(str(direct_bob))["fees_earned_atto"])
    assert alice_cut == (fee * 100) // 150
    assert bob_cut == (fee * 50) // 150


def test_full_withdrawal_receives_zero_fee_allocation(pool, direct_vm, direct_alice, direct_bob):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 50 * ATTO)

    direct_vm.sender = direct_bob
    pool.withdraw(str(50 * ATTO))

    assert int(pool.position_of(str(direct_bob))["active_principal_atto"]) == 0

    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // 10000

    direct_vm.sender = direct_alice
    direct_vm.value = advance + fee
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    alice_cut = int(pool.position_of(str(direct_alice))["fees_earned_atto"])
    bob_cut = int(pool.position_of(str(direct_bob))["fees_earned_atto"])
    assert bob_cut == 0
    assert alice_cut == fee
