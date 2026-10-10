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

BPS = 10000

DOCKET = "OMB-2026-000001"
MEMBER = "0x" + "bb" * 20


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


def test_a_part_payment_leaves_the_advance_open(pool, direct_vm, direct_alice):
    """A debt that is half paid is not a debt that is settled.

    This used to close the advance and write the remainder off, which is how a member
    could discharge their own advance for a wei. A payment that does not cover principal
    plus fee is now credited and the advance stays OUTSTANDING.
    """
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS

    short = advance // 2
    direct_vm.value = short
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert out["status"] == "OUTSTANDING"
    assert int(out["credited_atto"]) == short
    assert int(out["owed_atto"]) == advance + fee
    assert int(out["outstanding_atto"]) == advance + fee - short
    assert int(out["shortfall_atto"]) == 0
    assert pool.get_advance(DOCKET)["status"] == "OUTSTANDING"

    # Nothing is written off, because nothing has been given up on yet.
    stats = pool.pool_stats()
    assert int(stats["total_written_off_atto"]) == 0
    assert int(stats["outstanding_atto"]) == advance


def test_an_insurer_can_pay_an_advance_off_in_instalments(pool, direct_vm, direct_alice):
    """Credit accumulates across payments, and the last one closes it."""
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS
    owed = advance + fee

    direct_vm.value = owed // 3
    first = pool.record_recovery(DOCKET)
    assert first["status"] == "OUTSTANDING"

    direct_vm.value = owed - (owed // 3)
    last = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert last["status"] == "RECOVERED"
    assert int(last["credited_atto"]) == owed
    assert int(last["fee_atto"]) == fee
    assert int(last["to_member_atto"]) == 0
    assert int(pool.pool_stats()["outstanding_atto"]) == 0
    assert int(pool.pool_stats()["total_written_off_atto"]) == 0


def test_only_the_owner_may_close_an_advance_short(
    pool, direct_vm, direct_owner, direct_alice
):
    """Giving up on a debt is a judgement about a document, so it is an owner decision.

    Anybody may pay. Nobody but the settlement authority may declare that what arrived is
    all that is coming, and the loss is shared pro rata when they do.
    """
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    direct_vm.value = advance // 2
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    direct_vm.sender = MEMBER
    with direct_vm.expect_revert("caller is not the pool owner"):
        pool.settle_short(DOCKET, "I would rather not pay the rest")

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("needs a stated reason"):
        pool.settle_short(DOCKET, "   ")

    out = pool.settle_short(DOCKET, "insurer remittance advice shows final payment")
    assert out["status"] == "RECOVERED"
    assert int(out["shortfall_atto"]) == advance - advance // 2
    assert int(out["fee_atto"]) == 0

    stats = pool.pool_stats()
    assert int(stats["outstanding_atto"]) == 0
    assert int(stats["total_written_off_atto"]) == advance - advance // 2
    assert int(stats["total_value_governed_atto"]) == 100 * ATTO - (advance - advance // 2)


def test_a_fully_paid_advance_cannot_be_closed_short(
    pool, direct_vm, direct_owner, direct_alice
):
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS
    direct_vm.value = advance + fee
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("already RECOVERED"):
        pool.settle_short(DOCKET, "trying it on")


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
    """Once an advance is discharged in full it is closed for good."""
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS
    direct_vm.value = advance + fee
    assert pool.record_recovery(DOCKET)["status"] == "RECOVERED"
    with direct_vm.expect_revert("already RECOVERED"):
        pool.record_recovery(DOCKET)
    direct_vm.value = 0


def test_a_recovery_tells_the_court_to_settle(make_pool, direct_vm, direct_alice):
    """And only once the advance is actually discharged, not on a part payment."""
    pool, stub = make_pool()
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS

    direct_vm.value = advance // 4
    pool.record_recovery(DOCKET)
    assert [c for c in stub.calls if c[0] == "mark_settled"] == []

    direct_vm.value = advance + fee - advance // 4
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
    assert int(out["from_fees_atto"]) == 0
    assert int(out["from_principal_atto"]) == 4 * ATTO
    assert int(out["active_principal_atto"]) == 6 * ATTO
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


def test_a_stranger_may_pay_an_advance_off_but_cannot_discharge_it_short(
    pool, direct_vm, direct_alice
):
    """Paying is open. Declaring the debt finished is not.

    record_recovery used to gate on who the caller was and then trust the figure they
    sent, which is the wrong way round: it let the member discharge their own advance for
    a wei while refusing an honest payment from a third party. Anybody may now pay, and
    the amount is what decides whether the advance closes.
    """
    install_stubs(direct_vm, court_stub(filer=MEMBER))
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS

    stranger = "0x" + "99" * 20
    direct_vm.sender = stranger
    direct_vm.value = 1
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0
    # One wei buys a credit of one wei, and nothing else.
    assert out["status"] == "OUTSTANDING"
    assert int(out["credited_atto"]) == 1
    assert int(pool.pool_stats()["total_written_off_atto"]) == 0

    # And they cannot write the rest off either.
    with direct_vm.expect_revert("caller is not the pool owner"):
        pool.settle_short(DOCKET, "close it please")

    # Paying the whole thing does work, from anybody.
    direct_vm.sender = stranger
    direct_vm.value = advance + fee - 1
    assert pool.record_recovery(DOCKET)["status"] == "RECOVERED"
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



# ------------------------------------------------- withdrawn principal, over many cycles
#
# One recovery is not enough to catch the thing that was actually wrong here. The old
# code did not store how much principal an underwriter had taken out; it worked the figure
# out as `withdrawn - fees_earned` whenever it was asked. That is right exactly once. The
# next recovery raises fees_earned, which shrinks the subtraction, which hands the
# underwriter back principal that left the pool weeks ago, and their share of every
# subsequent fee grows with it. So these tests all run several cycles and watch the figure
# that is supposed to stand still.


def cycle(pool, vm, docket, payer):
    """Advance against a docket, then have payer settle it in full. Returns the fee."""
    amount = int(pool.advance(docket)["amount_atto"])
    fee = (amount * 1200) // BPS
    vm.sender = payer
    vm.value = amount + fee
    pool.record_recovery(docket)
    vm.value = 0
    return fee


def active_of(pool, who) -> int:
    return int(pool.position_of(str(who))["active_principal_atto"])


def fees_of(pool, who) -> int:
    return int(pool.position_of(str(who))["fees_earned_atto"])


def test_fee_accrual_never_gives_back_withdrawn_principal(
    pool, direct_vm, direct_alice, direct_bob
):
    """Bob took half his capital out. Three recoveries later it is still out.

    This is the test the previous version fails. Under `withdrawn - fees_earned` Bob's
    active principal reads 50 GEN before the first recovery and 50 GEN plus his own fee
    cut after it, which is capital the pool does not hold.
    """
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 100 * ATTO)

    direct_vm.sender = direct_bob
    pool.withdraw(str(50 * ATTO))
    assert active_of(pool, direct_bob) == 50 * ATTO
    assert active_of(pool, direct_alice) == 100 * ATTO

    earned = 0
    for round_number in (1, 2, 3):
        fee = cycle(pool, direct_vm, f"OMB-2026-00000{round_number}", direct_alice)
        earned += (fee * 50) // 150

        # The whole point. Fees are earned on 50 GEN and keep being earned on 50 GEN.
        assert active_of(pool, direct_bob) == 50 * ATTO
        assert active_of(pool, direct_alice) == 100 * ATTO
        assert fees_of(pool, direct_bob) == earned
        assert pool.position_of(str(direct_bob))["share_bps"] == (50 * BPS) // 150


def test_a_withdrawal_takes_fees_first_and_then_principal(
    pool, direct_vm, direct_alice, direct_bob
):
    """A withdrawal larger than the fees owed eats into principal, and says how much.

    Fees first is the order that favours the underwriter: it keeps their capital working
    for as long as the arithmetic allows. What it must not do is lose track of the part
    that was principal, which is what the receipt now states outright.
    """
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 100 * ATTO)

    first_fee = cycle(pool, direct_vm, "OMB-2026-000001", direct_alice)
    bob_fees = (first_fee * 100) // 200
    assert fees_of(pool, direct_bob) == bob_fees
    assert active_of(pool, direct_bob) == 100 * ATTO

    direct_vm.sender = direct_bob
    receipt = pool.withdraw(str(bob_fees + 10 * ATTO))
    assert int(receipt["from_fees_atto"]) == bob_fees
    assert int(receipt["from_principal_atto"]) == 10 * ATTO
    assert int(receipt["active_principal_atto"]) == 90 * ATTO
    assert active_of(pool, direct_bob) == 90 * ATTO

    # The second cycle is where the old arithmetic went wrong: Bob's withdrawal is now
    # smaller than the fees he has earned in total, so the derived figure reads his
    # principal back as whole again.
    second_fee = cycle(pool, direct_vm, "OMB-2026-000002", direct_alice)
    assert active_of(pool, direct_bob) == 90 * ATTO
    assert fees_of(pool, direct_bob) == bob_fees + (second_fee * 90) // 190
    assert active_of(pool, direct_alice) == 100 * ATTO


def test_withdrawing_only_fees_leaves_principal_working(
    pool, direct_vm, direct_alice, direct_bob
):
    """Taking the fees out is not taking capital out, and must not read as if it were."""
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 100 * ATTO)

    first_fee = cycle(pool, direct_vm, "OMB-2026-000001", direct_alice)
    bob_fees = (first_fee * 100) // 200

    direct_vm.sender = direct_bob
    receipt = pool.withdraw(str(bob_fees))
    assert int(receipt["from_fees_atto"]) == bob_fees
    assert int(receipt["from_principal_atto"]) == 0
    assert active_of(pool, direct_bob) == 100 * ATTO

    second_fee = cycle(pool, direct_vm, "OMB-2026-000002", direct_alice)
    assert active_of(pool, direct_bob) == 100 * ATTO
    assert fees_of(pool, direct_bob) == bob_fees + (second_fee * 100) // 200


def test_an_underwriter_who_left_earns_nothing_from_later_recoveries(
    pool, direct_vm, direct_alice, direct_bob
):
    """A position closed to zero stays closed, however many recoveries come in after."""
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 50 * ATTO)

    direct_vm.sender = direct_bob
    pool.withdraw(str(50 * ATTO))
    assert active_of(pool, direct_bob) == 0

    for round_number in (1, 2, 3):
        fee = cycle(pool, direct_vm, f"OMB-2026-00000{round_number}", direct_alice)
        assert active_of(pool, direct_bob) == 0
        assert fees_of(pool, direct_bob) == 0
        assert pool.position_of(str(direct_bob))["share_bps"] == 0
        # Alice is the only active capital, so the whole fee is hers.
        assert fees_of(pool, direct_alice) > 0
        assert fee > 0


def test_depositing_again_after_a_withdrawal_adds_only_the_new_capital(
    pool, direct_vm, direct_alice, direct_bob
):
    """A fresh deposit raises active principal by the deposit, not back to the old figure."""
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    fund(pool, direct_vm, direct_bob, 100 * ATTO)

    direct_vm.sender = direct_bob
    pool.withdraw(str(50 * ATTO))

    first_fee = cycle(pool, direct_vm, "OMB-2026-000001", direct_alice)
    bob_fees = (first_fee * 50) // 150
    assert active_of(pool, direct_bob) == 50 * ATTO

    fund(pool, direct_vm, direct_bob, 30 * ATTO)
    assert active_of(pool, direct_bob) == 80 * ATTO
    assert int(pool.position_of(str(direct_bob))["principal_atto"]) == 130 * ATTO

    second_fee = cycle(pool, direct_vm, "OMB-2026-000002", direct_alice)
    assert active_of(pool, direct_bob) == 80 * ATTO
    assert fees_of(pool, direct_bob) == bob_fees + (second_fee * 80) // 180


def test_active_principal_is_exactly_deposits_less_withdrawn_principal(
    pool, direct_vm, direct_alice, direct_bob, direct_charlie
):
    """The invariant behind all of the above, checked after every step.

    Total active principal is deposits less the part of every withdrawal that came out of
    principal, and nothing else moves it. Each withdrawal receipt states that part, so the
    test adds up what the contract said and holds the running total against it. A figure
    that drifts upward between recoveries fails here even if no single assertion above
    happened to look at the position that drifted.
    """
    everyone = (direct_alice, direct_bob, direct_charlie)
    deposited = 0
    withdrawn = 0
    withdrawn_principal = 0

    def invariant():
        total_active = sum(active_of(pool, who) for who in everyone)
        stats = pool.pool_stats()
        assert int(stats["total_deposited_atto"]) == deposited
        assert int(stats["total_withdrawn_atto"]) == withdrawn
        assert total_active == deposited - withdrawn_principal
        shares = sum(pool.position_of(str(who))["share_bps"] for who in everyone)
        # Integer division loses at most one basis point per underwriter.
        assert total_active == 0 or BPS - len(everyone) <= shares <= BPS

    def take_out(who, amount):
        nonlocal withdrawn, withdrawn_principal
        direct_vm.sender = who
        receipt = pool.withdraw(str(amount))
        withdrawn += amount
        withdrawn_principal += int(receipt["from_principal_atto"])
        assert int(receipt["from_fees_atto"]) + int(receipt["from_principal_atto"]) == amount
        invariant()

    for who, amount in ((direct_alice, 60 * ATTO), (direct_bob, 30 * ATTO), (direct_charlie, 10 * ATTO)):
        fund(pool, direct_vm, who, amount)
        deposited += amount
    invariant()

    for round_number in (1, 2, 3, 4):
        cycle(pool, direct_vm, f"OMB-2026-00000{round_number}", direct_alice)
        invariant()
        take_out(direct_bob, 2 * ATTO)

    # Charlie closes out entirely, fees and all, and the invariant still holds.
    charlie_all = (
        int(pool.position_of(str(direct_charlie))["principal_atto"])
        + fees_of(pool, direct_charlie)
    )
    take_out(direct_charlie, charlie_all)
    assert active_of(pool, direct_charlie) == 0

    cycle(pool, direct_vm, "OMB-2026-000005", direct_alice)
    assert active_of(pool, direct_charlie) == 0
    invariant()


# -------------------------------------------- the member the money is actually bound to
#
# An advance is paid to the address the court recorded as the filer, which is now the
# member's own address rather than the relayer's. Two things follow. The pool has to
# recognise that member when they turn up, whichever spelling of their address they
# arrive in, and it must refuse to pay an address nobody holds a key to.


def test_the_member_may_settle_their_own_advance(
    pool, direct_vm, direct_alice, direct_bob
):
    """The member is named in the authorisation check, so the check has to find them.

    The court hands the pool the filer in the lowercase spelling the API filed it with,
    while `str(gl.message.sender_address)` is the EIP-55 checksummed one. Comparing the
    two unnormalised reads as correct and never matches, which locked the member out of
    the one branch written for them.
    """
    member = str(direct_bob)
    assert member != member.lower()  # otherwise this test proves nothing
    install_stubs(direct_vm, court_stub(filer=member.lower()))

    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS

    direct_vm.sender = direct_bob
    direct_vm.value = advance + fee
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert out["status"] == "RECOVERED"
    assert pool.get_advance(DOCKET)["status"] == "RECOVERED"


def test_the_member_cannot_discharge_their_own_advance_cheaply(
    pool, direct_vm, direct_alice, direct_bob
):
    """The drain this whole change exists to close.

    The member received the advance. They used to be allowed to record its recovery AND
    choose the figure, so one wei closed it and the underwriters absorbed the principal.
    Settling also reset outstanding_atto, so the utilisation ceiling never re-bound and
    the loop ran until the pool was empty: eight GEN for eleven wei.
    """
    install_stubs(direct_vm, court_stub(filer=str(direct_bob).lower()))
    fund(pool, direct_vm, direct_alice, 8 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    direct_vm.sender = direct_bob
    direct_vm.value = 1
    out = pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert out["status"] == "OUTSTANDING"
    assert int(pool.pool_stats()["total_written_off_atto"]) == 0
    # The capital is still committed, so the ceiling still counts it.
    assert int(pool.pool_stats()["outstanding_atto"]) == advance

    # And the docket cannot be advanced against a second time either.
    with direct_vm.expect_revert("already been advanced against"):
        pool.advance(DOCKET)


def test_a_position_reads_back_in_any_spelling(pool, direct_vm, direct_alice):
    """position_of answers to the checksummed and the lowercase form of one address."""
    fund(pool, direct_vm, direct_alice, 12 * ATTO)
    checksummed = str(direct_alice)
    assert checksummed != checksummed.lower()  # otherwise this test proves nothing
    for spelling in (checksummed, checksummed.lower(), checksummed.upper().replace("0X", "0x")):
        assert int(pool.position_of(spelling)["principal_atto"]) == 12 * ATTO


def test_a_claim_reads_back_in_any_spelling(make_pool, direct_vm, direct_alice):
    mixed = "0x" + "Bb" * 20
    pool, _ = make_pool(stub=court_stub(filer=mixed))
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])
    fee = (advance * 1200) // BPS

    direct_vm.sender = direct_alice
    direct_vm.value = advance + fee + (3 * ATTO)
    pool.record_recovery(DOCKET)
    direct_vm.value = 0

    assert int(pool.claimable_of(mixed)) == 3 * ATTO
    assert int(pool.claimable_of(mixed.lower())) == 3 * ATTO
    assert int(pool.claim_for(mixed.lower())) == 3 * ATTO
    assert int(pool.claimable_of(mixed)) == 0


def test_the_pool_refuses_to_advance_to_the_zero_address(make_pool, direct_vm, direct_alice):
    """An advance to the burn address is money destroyed, so it is refused at the gate."""
    pool, _ = make_pool(stub=court_stub(filer="0x" + "0" * 40))
    fund(pool, direct_vm, direct_alice, 100 * ATTO)
    with direct_vm.expect_revert("must not be the zero address"):
        pool.advance(DOCKET)


def test_the_pool_refuses_to_claim_to_the_zero_address(pool, direct_vm, direct_alice):
    fund(pool, direct_vm, direct_alice, 10 * ATTO)
    with direct_vm.expect_revert("must not be the zero address"):
        pool.claim_for("0x" + "0" * 40)


def test_the_constructor_refuses_the_zero_address_as_the_court(
    direct_deploy, direct_vm, direct_owner
):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("must not be the zero address"):
        direct_deploy(CONTRACTS["pool"], "0x" + "0" * 40, 3500, 1200, 7000, CAPS_CSV)


def test_the_court_cannot_be_repointed_at_the_zero_address(pool, direct_vm, direct_owner):
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("must not be the zero address"):
        pool.set_court("0x" + "0" * 40)


# ---------------------------------------------------- losses, and who actually bears them
#
# Fees were always shared pro rata by capital at work. Losses were not shared at all:
# `entitled` was principal plus fees less withdrawals and never shrank, so the first
# underwriter out after a write off took their principal whole and the slowest one
# carried the lot. Alice could take all fifty of her fifty GEN and leave bob forty nine
# of his. A write off now reduces each position's active principal by its share.


def test_a_write_off_is_shared_pro_rata_by_capital_at_work(
    pool, direct_vm, direct_owner, direct_alice, direct_bob
):
    fund(pool, direct_vm, direct_alice, 50 * ATTO)
    fund(pool, direct_vm, direct_bob, 50 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    direct_vm.sender = direct_owner
    pool.write_off(DOCKET, "the insurer never paid")

    half = advance // 2
    for who in (direct_alice, direct_bob):
        position = pool.position_of(str(who))
        assert int(position["loss_borne_atto"]) == half
        assert int(position["active_principal_atto"]) == 50 * ATTO - half
        assert int(position["withdrawable_atto"]) == 50 * ATTO - half

    assert int(pool.pool_stats()["total_written_off_atto"]) == advance


def test_the_first_underwriter_out_cannot_leave_the_loss_behind(
    pool, direct_vm, direct_owner, direct_alice, direct_bob
):
    """The race this closes. Alice withdrawing first must not make the loss bob's."""
    fund(pool, direct_vm, direct_alice, 50 * ATTO)
    fund(pool, direct_vm, direct_bob, 50 * ATTO)
    advance = int(pool.advance(DOCKET)["amount_atto"])

    direct_vm.sender = direct_owner
    pool.write_off(DOCKET, "the insurer never paid")

    half = advance // 2
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("may withdraw at most"):
        pool.withdraw(str(50 * ATTO))
    alice_out = int(pool.withdraw(str(50 * ATTO - half))["withdrawn_atto"])

    # Bob can still take everything he is owed after the loss, which is the point.
    direct_vm.sender = direct_bob
    bob_out = int(pool.withdraw(str(50 * ATTO - half))["withdrawn_atto"])
    assert alice_out == bob_out
    assert alice_out + bob_out == 100 * ATTO - advance


def test_a_loss_reduces_the_weight_a_position_carries_for_later_fees(
    pool, direct_vm, direct_owner, direct_alice, direct_bob
):
    """An underwriter with less capital at work earns less of the next fee. Correctly."""
    fund(pool, direct_vm, direct_alice, 90 * ATTO)
    fund(pool, direct_vm, direct_bob, 10 * ATTO)

    direct_vm.sender = direct_owner
    first = int(pool.advance(DOCKET)["amount_atto"])
    pool.write_off(DOCKET, "written off")

    alice_active = int(pool.position_of(str(direct_alice))["active_principal_atto"])
    bob_active = int(pool.position_of(str(direct_bob))["active_principal_atto"])
    assert alice_active + bob_active == 100 * ATTO - first

    second = "OMB-2026-000002"
    advance = int(pool.advance(second)["amount_atto"])
    fee = (advance * 1200) // BPS
    direct_vm.sender = direct_alice
    direct_vm.value = advance + fee
    pool.record_recovery(second)
    direct_vm.value = 0

    total_active = alice_active + bob_active
    assert int(pool.position_of(str(direct_alice))["fees_earned_atto"]) == (
        fee * alice_active
    ) // total_active
    assert int(pool.position_of(str(direct_bob))["fees_earned_atto"]) == (
        fee * bob_active
    ) // total_active
