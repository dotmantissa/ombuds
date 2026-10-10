# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
AdvancePool
===========

The part that turns a good verdict into money this week.

A member who has just been told their claim was wrongly denied still has not been paid.
The insurer's internal appeal, then the state external review, then the actual cheque,
is a process measured in months. Most people give up somewhere in the middle, which is
the whole reason denials work as a business practice.

So underwriters put capital in here, and the pool advances a share of the disputed amount
to the member the moment a verdict clears the confidence band. When the insurer eventually
pays, the pool takes its principal back plus a fee and the rest goes to the member. If the
insurer never pays, the underwriters eat it. That is the risk they are paid to take, and
it is only a sane risk to take because the verdict it rests on is a consensus object with
an auditable evidence trail rather than one model's opinion.

The capital sitting in escrow here is the Total Value Governed. It is governed in a fairly
literal sense: no human decides when it moves. The pool reads the court, and the court will
only say yes when independent validators agreed on the decision, the ground, the clause and
the band.

Risk controls, because a pool with none is a faucet
--------------------------------------------------
- A rate. The pool advances a percentage of the disputed amount, never all of it.
- A per band ceiling. A verdict in the top band cannot drain the pool on its own.
- A utilisation ceiling. Some share of capital always stays free so withdrawals work.
- One advance per docket, enforced on both sides.
- Underwriters can only withdraw capital that is not currently out on an advance.

Consensus boundary
------------------
This contract is entirely deterministic. It calls no model and fetches nothing. Every
judgement it acts on was already made in OmbudsCourt under validator consensus, and this
contract only reads the result. Money movement should never depend on a fresh inference.
"""

import json
from dataclasses import dataclass

from genlayer import *


ERROR_EXPECTED = "[EXPECTED]"

BPS = 10000
ATTO = 10**18

ADVANCE_STATUSES = ("OUTSTANDING", "RECOVERED", "WRITTEN_OFF")

ZERO_ADDRESS = "0x" + "0" * 40


@allow_storage
@dataclass
class Underwriter:
    address: str
    principal_atto: u256
    withdrawn_atto: u256
    fees_earned_atto: u256
    first_deposit_at: str
    last_deposit_at: str
    deposit_count: u256
    # Principal still working in the pool. Rises on a deposit, falls on a withdrawal that
    # reaches past the fees owed, and falls on this position's share of a write off. It is
    # never derived from anything else. See withdraw() and _absorb_loss().
    active_principal_atto: u256
    # This position's share of every loss the pool has booked. Kept so a withdrawal limit
    # can account for capital that is gone, and so the UI can show it.
    loss_borne_atto: u256


@allow_storage
@dataclass
class Advance:
    docket: str
    member: str
    amount_atto: u256
    disputed_atto: u256
    band: u256
    status: str
    made_at: str
    recovered_atto: u256
    fee_atto: u256
    member_balance_atto: u256
    closed_at: str


def _chain_stamp() -> str:
    raw = str(gl.message_raw.get("datetime", ""))
    if raw == "":
        return "1970-01-01T00:00:00Z"
    return raw


def _normalise_address(value) -> str:
    """The one spelling of an address this contract keys maps by and compares on.

    `str(gl.message.sender_address)` hands back the EIP-55 checksummed spelling, whereas an
    address that arrived as a string has been through `_require_address` and is lowercase.
    Comparing the two directly reads as correct and silently never matches, so everything
    here is folded to lowercase first.
    """
    return str(value).strip().lower() if value is not None else ""


def _require_address(label: str, value) -> str:
    cleaned = _normalise_address(value)
    if not cleaned.startswith("0x") or len(cleaned) != 42:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must be a 0x prefixed 20 byte address")
    try:
        int(cleaned[2:], 16)
    except ValueError:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must be a 0x prefixed 20 byte address")
    # Nothing is allowed to point at the burn address. This contract pays out to whatever
    # address it is handed, so an address nobody holds the key to is money destroyed.
    if cleaned == ZERO_ADDRESS:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} {label} must not be the zero address")
    return cleaned


def _parse_caps(csv: str) -> list:
    """Per band ceilings, in atto, lowest band first."""
    out = []
    for piece in csv.split(","):
        cleaned = piece.strip()
        if cleaned == "":
            continue
        value = int(cleaned)
        if value < 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a band ceiling cannot be negative")
        out.append(value)
    if len(out) == 0:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} at least one band ceiling is required")
    return out


class AdvancePool(gl.Contract):
    owner: Address
    court: Address

    advance_rate_bps: u256
    fee_bps: u256
    max_utilisation_bps: u256
    band_caps_atto: DynArray[u256]

    underwriters: TreeMap[str, Underwriter]
    underwriter_list: DynArray[str]

    advances: TreeMap[str, Advance]
    advance_dockets: DynArray[str]

    claimable_atto: TreeMap[str, u256]

    total_capital_atto: u256
    total_withdrawn_atto: u256
    outstanding_atto: u256
    total_advanced_atto: u256
    total_recovered_atto: u256
    total_fees_atto: u256
    total_written_off_atto: u256
    total_member_share_atto: u256
    advance_count: u256

    def __init__(
        self,
        court_address: str,
        advance_rate_bps: int,
        fee_bps: int,
        max_utilisation_bps: int,
        band_caps_atto: str,
    ) -> None:
        cleaned_court = _require_address("court_address", court_address)
        rate = int(advance_rate_bps)
        fee = int(fee_bps)
        utilisation = int(max_utilisation_bps)
        if rate < 1 or rate > BPS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} advance_rate_bps must sit between 1 and {BPS}")
        if fee < 0 or fee > 3000:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} fee_bps must sit between 0 and 3000")
        if utilisation < 1000 or utilisation > BPS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} max_utilisation_bps must sit between 1000 and {BPS}"
            )

        self.owner = gl.message.sender_address
        self.court = Address(cleaned_court)
        self.advance_rate_bps = u256(rate)
        self.fee_bps = u256(fee)
        self.max_utilisation_bps = u256(utilisation)
        for cap in _parse_caps(band_caps_atto):
            self.band_caps_atto.append(u256(cap))

        self.total_capital_atto = u256(0)
        self.total_withdrawn_atto = u256(0)
        self.outstanding_atto = u256(0)
        self.total_advanced_atto = u256(0)
        self.total_recovered_atto = u256(0)
        self.total_fees_atto = u256(0)
        self.total_written_off_atto = u256(0)
        self.total_member_share_atto = u256(0)
        self.advance_count = u256(0)

    # ------------------------------------------------------------------------- internals

    def _assert_owner(self) -> None:
        if _normalise_address(gl.message.sender_address) != _normalise_address(self.owner):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} caller is not the pool owner")

    def _free_capital(self) -> int:
        """Cash the pool actually holds and is free to commit.

        Follow the money rather than the bookkeeping. Deposits came in. Withdrawals went
        out. Advances went out to members. Recoveries came back in, counting only the part
        that belongs to the pool, because a surplus above principal plus fee belongs to the
        member and is held for them under claimable_atto rather than treated as capital.
        """
        free = int(self.total_capital_atto)
        free = free + int(self.total_recovered_atto)
        free = free - int(self.total_withdrawn_atto)
        free = free - int(self.total_advanced_atto)
        return free if free > 0 else 0

    def _equity(self) -> int:
        """Underwriter equity, which is the Total Value Governed.

        Cash on hand plus the advances still out with members. An outstanding advance is
        not gone, it is a receivable against an insurer, so making one does not change the
        total governed. Losing one does, and that is what a write off records.
        """
        return self._free_capital() + int(self.outstanding_atto)

    def _band_cap(self, band: int) -> int:
        total = len(self.band_caps_atto)
        if total == 0:
            return 0
        index = band if band < total else total - 1
        if index < 0:
            index = 0
        return int(self.band_caps_atto[index])

    def _utilisation_headroom(self) -> int:
        """How much more may go out before the utilisation ceiling is hit."""
        equity = self._equity()
        if equity <= 0:
            return 0
        ceiling = (equity * int(self.max_utilisation_bps)) // BPS
        headroom = ceiling - int(self.outstanding_atto)
        return headroom if headroom > 0 else 0

    def _active_principal(self, position: Underwriter) -> int:
        """Principal this position still has working in the pool.

        Read, never recomputed. Deriving it from `principal - (withdrawn - fees_earned)`
        looks equivalent and is not: every later fee accrual raises `fees_earned`, which
        shrinks the derived withdrawn principal and hands back capital the underwriter has
        already taken out of the pool. withdraw() is the only thing that lowers this.
        """
        return int(position.active_principal_atto)

    def _total_active_principal(self) -> int:
        """Sum of all underwriters' active principal. The denominator for a fee split."""
        total = 0
        for address in self.underwriter_list:
            pos = self.underwriters.get(address)
            if pos is not None:
                total += self._active_principal(pos)
        return total

    def _entitlement(self, position: Underwriter) -> int:
        """Everything this position may still take out of the pool.

        Deposits plus fees earned, less what has already been taken and less the losses
        this position has borne. One definition, read by both position_of and withdraw,
        so what the UI promises and what the contract allows cannot drift apart.
        """
        value = (
            int(position.principal_atto)
            + int(position.fees_earned_atto)
            - int(position.withdrawn_atto)
            - int(position.loss_borne_atto)
        )
        return value if value > 0 else 0

    def _accrue_fees(self, fee: int) -> None:
        """Credit a fee to underwriters in proportion to the capital that bore the risk."""
        if fee <= 0:
            return
        total_active = self._total_active_principal()
        if total_active <= 0:
            return
        for address in self.underwriter_list:
            position = self.underwriters.get(address)
            if position is None:
                continue
            cut = (fee * self._active_principal(position)) // total_active
            if cut > 0:
                position.fees_earned_atto = u256(int(position.fees_earned_atto) + cut)

    def _absorb_loss(self, loss: int) -> None:
        """Write a loss down against every open position, in proportion to its capital.

        Losses used to be left to show up through _free_capital alone, which sounds
        neutral and is not. `entitled` never shrank, so the first underwriter to withdraw
        after a write off took their principal out whole and the loss landed entirely on
        whoever was slowest: alice could take all fifty of her fifty GEN and leave bob
        forty nine of his. Fees were already shared pro rata by active principal, so
        sharing losses the same way is the only version of this that is consistent.

        The write down reduces active principal, which is both the claim on capital and
        the weight used for future fees. An underwriter who has taken a loss therefore
        earns proportionately less afterwards, which is correct: they have less capital
        at work.
        """
        if loss <= 0:
            return
        total_active = self._total_active_principal()
        if total_active <= 0:
            return
        if loss > total_active:
            loss = total_active

        # Integer division leaves a remainder. It is carried, so the figures add up to the
        # loss exactly rather than drifting by a few atto on every write off.
        remaining = loss
        addresses = [a for a in self.underwriter_list]
        for index, address in enumerate(addresses):
            position = self.underwriters.get(address)
            if position is None:
                continue
            active = self._active_principal(position)
            if active <= 0:
                continue
            if index == len(addresses) - 1:
                share = remaining
            else:
                share = (loss * active) // total_active
            if share > remaining:
                share = remaining
            if share > active:
                share = active
            position.active_principal_atto = u256(active - share)
            position.loss_borne_atto = u256(int(position.loss_borne_atto) + share)
            remaining -= share
            if remaining <= 0:
                break

    # ----------------------------------------------------------------------------- views

    @gl.public.view
    def get_config(self) -> dict:
        return {
            "owner": str(self.owner),
            "court": str(self.court),
            "advance_rate_bps": int(self.advance_rate_bps),
            "fee_bps": int(self.fee_bps),
            "max_utilisation_bps": int(self.max_utilisation_bps),
            "band_caps_atto": [str(int(c)) for c in self.band_caps_atto],
        }

    @gl.public.view
    def pool_stats(self) -> dict:
        """Total Value Governed, and the honest version of the numbers under it."""
        equity = self._equity()
        outstanding = int(self.outstanding_atto)
        utilisation = (outstanding * BPS) // equity if equity > 0 else 0
        return {
            "total_value_governed_atto": str(equity),
            "net_capital_atto": str(equity),
            "free_capital_atto": str(self._free_capital()),
            "outstanding_atto": str(outstanding),
            "total_deposited_atto": str(int(self.total_capital_atto)),
            "total_withdrawn_atto": str(int(self.total_withdrawn_atto)),
            "total_advanced_atto": str(int(self.total_advanced_atto)),
            "total_recovered_atto": str(int(self.total_recovered_atto)),
            "total_fees_atto": str(int(self.total_fees_atto)),
            "total_written_off_atto": str(int(self.total_written_off_atto)),
            "claimable_to_members_atto": str(int(self.total_member_share_atto)),
            "advance_count": int(self.advance_count),
            "underwriter_count": len(self.underwriter_list),
            "utilisation_bps": utilisation,
            "utilisation_headroom_atto": str(self._utilisation_headroom()),
        }

    @gl.public.view
    def position_of(self, address: str) -> dict:
        cleaned = _normalise_address(address)
        record = self.underwriters.get(cleaned)
        if record is None:
            return {
                "address": cleaned,
                "principal_atto": "0",
                "active_principal_atto": "0",
                "withdrawn_atto": "0",
                "fees_earned_atto": "0",
                "loss_borne_atto": "0",
                "withdrawable_atto": "0",
                "deposit_count": 0,
                "share_bps": 0,
                "first_deposit_at": "",
                "last_deposit_at": "",
            }
        total_active = self._total_active_principal()
        active = self._active_principal(record)
        return {
            "address": record.address,
            "principal_atto": str(int(record.principal_atto)),
            "active_principal_atto": str(active),
            "withdrawn_atto": str(int(record.withdrawn_atto)),
            "fees_earned_atto": str(int(record.fees_earned_atto)),
            "loss_borne_atto": str(int(record.loss_borne_atto)),
            "withdrawable_atto": str(self._entitlement(record)),
            "deposit_count": int(record.deposit_count),
            "share_bps": (active * BPS) // total_active if total_active > 0 else 0,
            "first_deposit_at": record.first_deposit_at,
            "last_deposit_at": record.last_deposit_at,
        }

    @gl.public.view
    def claimable_of(self, address: str) -> str:
        cleaned = _require_address("address", address)
        return str(int(self.claimable_atto.get(cleaned, u256(0))))

    @gl.public.view
    def get_advance(self, docket: str) -> dict:
        record = self.advances.get(docket)
        if record is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing has been advanced against '{docket}'")
        return {
            "docket": record.docket,
            "member": record.member,
            "amount_atto": str(int(record.amount_atto)),
            "disputed_atto": str(int(record.disputed_atto)),
            "band": int(record.band),
            "status": record.status,
            "made_at": record.made_at,
            "recovered_atto": str(int(record.recovered_atto)),
            "fee_atto": str(int(record.fee_atto)),
            "member_balance_atto": str(int(record.member_balance_atto)),
            "closed_at": record.closed_at,
        }

    @gl.public.view
    def advance_ledger(self, limit: int) -> list:
        """Newest first. Every movement of capital this pool has made."""
        total = len(self.advance_dockets)
        take = 25 if limit <= 0 else limit
        if take > 100:
            take = 100
        out = []
        index = total - 1
        while index >= 0 and len(out) < take:
            docket = self.advance_dockets[index]
            record = self.advances.get(docket)
            if record is not None:
                out.append(
                    {
                        "docket": record.docket,
                        "member": record.member,
                        "amount_atto": str(int(record.amount_atto)),
                        "band": int(record.band),
                        "status": record.status,
                        "made_at": record.made_at,
                        "recovered_atto": str(int(record.recovered_atto)),
                    }
                )
            index -= 1
        return out

    @gl.public.view
    def quote_advance(self, docket: str) -> dict:
        """What the pool would pay against this docket right now, and why.

        A read only dry run, so the UI can tell a member what is coming before anybody
        sends a transaction.
        """
        court = gl.get_contract_at(self.court)
        gate = court.view().is_advanceable(docket)
        if not bool(gate.get("ok", False)):
            return {
                "eligible": False,
                "reason": str(gate.get("reason", "The court has not cleared this docket.")),
                "amount_atto": "0",
            }
        if self.advances.get(docket) is not None:
            return {
                "eligible": False,
                "reason": "This pool has already advanced against that docket.",
                "amount_atto": "0",
            }

        disputed = int(gate.get("disputed_atto", "0"))
        band = int(gate.get("band", 0))
        by_rate = (disputed * int(self.advance_rate_bps)) // BPS
        cap = self._band_cap(band)
        free = self._free_capital()
        headroom = self._utilisation_headroom()

        amount = by_rate
        limiter = "the pool's advance rate"
        if cap > 0 and cap < amount:
            amount = cap
            limiter = "the ceiling on this payout band"
        if headroom < amount:
            amount = headroom
            limiter = "the pool's utilisation ceiling"
        if free < amount:
            amount = free
            limiter = "free capital in the pool"

        if amount <= 0:
            return {
                "eligible": False,
                "reason": "The pool has no capital free to advance against this docket today.",
                "amount_atto": "0",
            }
        return {
            "eligible": True,
            "reason": "",
            "amount_atto": str(amount),
            "disputed_atto": str(disputed),
            "band": band,
            "limited_by": limiter,
            "by_rate_atto": str(by_rate),
            "band_cap_atto": str(cap),
            "free_capital_atto": str(free),
            "member": str(gate.get("filer", "")),
        }

    # ---------------------------------------------------------------------------- writes

    @gl.public.write.payable
    def deposit(self) -> dict:
        """Put capital behind the verdicts. This is the Total Value Governed."""
        amount = int(gl.message.value)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a deposit must carry value")

        address = _normalise_address(gl.message.sender_address)
        stamp = _chain_stamp()
        record = self.underwriters.get(address)
        if record is None:
            self.underwriters[address] = Underwriter(
                address=address,
                principal_atto=u256(amount),
                withdrawn_atto=u256(0),
                fees_earned_atto=u256(0),
                first_deposit_at=stamp,
                last_deposit_at=stamp,
                deposit_count=u256(1),
                active_principal_atto=u256(amount),
                loss_borne_atto=u256(0),
            )
            self.underwriter_list.append(address)
        else:
            record.principal_atto = u256(int(record.principal_atto) + amount)
            record.active_principal_atto = u256(int(record.active_principal_atto) + amount)
            record.last_deposit_at = stamp
            record.deposit_count = u256(int(record.deposit_count) + 1)

        self.total_capital_atto = u256(int(self.total_capital_atto) + amount)
        return {
            "address": address,
            "deposited_atto": str(amount),
            "principal_atto": str(int(self.underwriters[address].principal_atto)),
            "free_capital_atto": str(self._free_capital()),
        }

    @gl.public.write
    def withdraw(self, amount_atto: str) -> dict:
        """Take capital back out, but only what is not currently out on an advance."""
        address = _normalise_address(gl.message.sender_address)
        record = self.underwriters.get(address)
        if record is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} {address} has no position in this pool")

        amount = int(amount_atto)
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} the withdrawal must be above zero")

        # What this position may still take out: everything it put in, plus the fees it
        # earned, less what it has already taken and less the losses it has borne.
        #
        # The last term is the new one. This used to be `principal + fees_earned -
        # withdrawn`, which never shrank when the pool took a loss, and that made a write
        # off a race: the first underwriter out took their principal whole and the slowest
        # one carried the whole loss. Active principal now falls by this position's pro
        # rata share of every write off, and so does this limit, so nobody can withdraw
        # capital that no longer exists.
        entitled = self._entitlement(record)
        if amount > entitled:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} {address} may withdraw at most {entitled} atto, "
                "counting capital still at work and fees earned but not yet taken out"
            )

        free = self._free_capital()
        if amount > free:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} only {free} atto is free right now, the rest is out on "
                "advances that have not been recovered yet"
            )

        # Split the withdrawal between fees and principal, and remember the split.
        #
        # `entitled` is active principal plus the fees this position has earned and not yet
        # taken out, so `entitled - active` is exactly the unwithdrawn fee balance. Fees
        # come out first and only the remainder bites into principal.
        #
        # The subtraction has to be recorded, not re-derived later. `withdrawn -
        # fees_earned` is the same number today and a different one tomorrow, because the
        # next recovery raises `fees_earned` and so quietly gives back principal that is
        # already out of the pool. Recording it means a withdrawal is permanent: active
        # principal only ever falls here and only ever rises on a deposit.
        active = int(record.active_principal_atto)
        unwithdrawn_fees = entitled - active if entitled > active else 0
        from_principal = amount - unwithdrawn_fees if amount > unwithdrawn_fees else 0
        remaining_active = active - from_principal
        record.active_principal_atto = u256(remaining_active if remaining_active > 0 else 0)

        record.withdrawn_atto = u256(int(record.withdrawn_atto) + amount)
        self.total_withdrawn_atto = u256(int(self.total_withdrawn_atto) + amount)
        gl.get_contract_at(gl.message.sender_address).emit_transfer(
            value=u256(amount), on="finalized"
        )
        return {
            "address": address,
            "withdrawn_atto": str(amount),
            "from_fees_atto": str(amount - from_principal),
            "from_principal_atto": str(from_principal),
            "active_principal_atto": str(int(record.active_principal_atto)),
            "remaining_principal_atto": str(entitled - amount),
            "free_capital_atto": str(self._free_capital()),
        }

    @gl.public.write
    def advance(self, docket: str) -> dict:
        """Pay the member now, against a verdict the court has already cleared.

        Permissionless on purpose. Anybody may trigger it, and the money can only ever go
        to the person who filed the case, because that address comes from the court and
        not from the caller.
        """
        if self.advances.get(docket) is not None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' has already been advanced against")

        court = gl.get_contract_at(self.court)
        gate = court.view().is_advanceable(docket)
        if not bool(gate.get("ok", False)):
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} {gate.get('reason', 'the court has not cleared this docket')}"
            )

        member = _require_address("member", gate.get("filer", ""))
        disputed = int(gate.get("disputed_atto", "0"))
        band = int(gate.get("band", 0))
        if disputed <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' has no disputed amount")

        amount = (disputed * int(self.advance_rate_bps)) // BPS
        cap = self._band_cap(band)
        if cap > 0 and cap < amount:
            amount = cap
        headroom = self._utilisation_headroom()
        if headroom < amount:
            amount = headroom
        free = self._free_capital()
        if free < amount:
            amount = free
        if amount <= 0:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} the pool has no capital free to advance against '{docket}'"
            )

        stamp = _chain_stamp()
        self.advances[docket] = Advance(
            docket=docket,
            member=member,
            amount_atto=u256(amount),
            disputed_atto=u256(disputed),
            band=u256(band),
            status="OUTSTANDING",
            made_at=stamp,
            recovered_atto=u256(0),
            fee_atto=u256(0),
            member_balance_atto=u256(0),
            closed_at="",
        )
        self.advance_dockets.append(docket)
        self.advance_count = u256(int(self.advance_count) + 1)
        self.outstanding_atto = u256(int(self.outstanding_atto) + amount)
        self.total_advanced_atto = u256(int(self.total_advanced_atto) + amount)

        # Tell the court, so the same verdict cannot be advanced against twice.
        court.emit(on="accepted").note_advance(docket, str(amount))
        # Pay the member.
        gl.get_contract_at(Address(member)).emit_transfer(value=u256(amount), on="finalized")

        return {
            "docket": docket,
            "member": member,
            "amount_atto": str(amount),
            "band": band,
            "made_at": stamp,
            "outstanding_atto": str(int(self.outstanding_atto)),
        }

    @gl.public.write.payable
    def record_recovery(self, docket: str) -> dict:
        """The insurer paid. Settle the advance and split what came in.

        The pool takes its principal plus the agreed fee. Anything above that belongs to
        the member and is left claimable for them rather than swept into the pool.

        Who may call this, and why it is not the member
        -----------------------------------------------
        Anybody may PAY. Nobody but the pool's settlement authority may DECLARE A
        SETTLEMENT CLOSED, and the two used to be the same action.

        The member is the party who received the advance. Letting them record the recovery
        let them choose the figure that discharged it: one wei closed a one GEN advance and
        booked the rest as an underwriter write off, and because closing resets
        outstanding_atto the utilisation ceiling never re-bound, so the loop ran until the
        pool was empty. Eight GEN left a test pool for eleven wei that way.

        So a payment that does not cover principal plus fee no longer closes anything. It
        is credited against the advance and the advance stays OUTSTANDING, which is the
        honest description of a debt that is not yet paid. Only the owner, acting as the
        settlement authority with the insurer's remittance in hand, may close an advance
        short through settle_short, and that is an openly attributed decision with a stated
        reason rather than a side effect of sending a transaction.
        """
        record = self.advances.get(docket)
        if record is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing has been advanced against '{docket}'")
        if record.status != "OUTSTANDING":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already {record.status}")

        received = int(gl.message.value)
        if received <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a recovery must carry value")

        principal = int(record.amount_atto)
        fee = (principal * int(self.fee_bps)) // BPS
        owed_to_pool = principal + fee

        # Everything paid against this docket so far, not just what arrived in this
        # transaction. An insurer paying in instalments has to be able to finish.
        credited = int(record.recovered_atto) + received

        if credited < owed_to_pool:
            # Not enough to discharge the advance. Credit it and leave the advance open.
            record.recovered_atto = u256(credited)
            self.total_recovered_atto = u256(int(self.total_recovered_atto) + received)
            return {
                "docket": docket,
                "received_atto": str(received),
                "credited_atto": str(credited),
                "owed_atto": str(owed_to_pool),
                "outstanding_atto": str(owed_to_pool - credited),
                "to_pool_atto": str(received),
                "fee_atto": "0",
                "to_member_atto": "0",
                "shortfall_atto": "0",
                "status": "OUTSTANDING",
                "closed_at": "",
            }

        # Fully discharged. The pool takes principal plus fee; the surplus is the
        # member's and is held for them.
        fee = owed_to_pool - principal
        member_share = credited - owed_to_pool
        # This transaction's share of what goes to the pool, since earlier instalments
        # were already counted when they arrived.
        to_pool_now = received - member_share
        stamp = _chain_stamp()

        record.status = "RECOVERED"
        record.recovered_atto = u256(credited)
        record.fee_atto = u256(fee)
        record.member_balance_atto = u256(member_share)
        record.closed_at = stamp

        held = int(self.outstanding_atto) - principal
        self.outstanding_atto = u256(held if held > 0 else 0)
        self.total_recovered_atto = u256(int(self.total_recovered_atto) + to_pool_now)
        self.total_fees_atto = u256(int(self.total_fees_atto) + fee)

        if member_share > 0:
            current = int(self.claimable_atto.get(record.member, u256(0)))
            self.claimable_atto[record.member] = u256(current + member_share)
            self.total_member_share_atto = u256(
                int(self.total_member_share_atto) + member_share
            )

        self._accrue_fees(fee)

        court = gl.get_contract_at(self.court)
        court.emit(on="accepted").mark_settled(docket, str(credited))

        return {
            "docket": docket,
            "received_atto": str(received),
            "credited_atto": str(credited),
            "owed_atto": str(owed_to_pool),
            "to_pool_atto": str(to_pool_now),
            "fee_atto": str(fee),
            "to_member_atto": str(member_share),
            "shortfall_atto": "0",
            "status": "RECOVERED",
            "closed_at": stamp,
        }

    @gl.public.write
    def settle_short(self, docket: str, note: str) -> dict:
        """Close an advance the insurer settled for less than it owed.

        The owner is the pool's settlement authority: the party that holds the insurer's
        remittance advice and can say "this is all that is coming". That is a judgement
        about a document, so it is made by an accountable address with a stated reason and
        it is recorded as a write off, rather than being inferable from whoever happened
        to send the smallest transaction.

        Whatever was already credited stays credited. The unpaid remainder is booked as a
        loss against the underwriters, which is what it is.
        """
        self._assert_owner()
        record = self.advances.get(docket)
        if record is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing has been advanced against '{docket}'")
        if record.status != "OUTSTANDING":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already {record.status}")
        if note.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a short settlement needs a stated reason")

        principal = int(record.amount_atto)
        credited = int(record.recovered_atto)
        fee = (principal * int(self.fee_bps)) // BPS
        if credited >= principal + fee:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} '{docket}' has been paid in full, so record_recovery "
                "closes it rather than this"
            )

        # The pool keeps what arrived. A fee is only earned once principal is whole.
        earned_fee = credited - principal if credited > principal else 0
        shortfall = principal - credited if principal > credited else 0
        stamp = _chain_stamp()

        record.status = "RECOVERED"
        record.fee_atto = u256(earned_fee)
        record.member_balance_atto = u256(0)
        record.closed_at = stamp

        held = int(self.outstanding_atto) - principal
        self.outstanding_atto = u256(held if held > 0 else 0)
        self.total_fees_atto = u256(int(self.total_fees_atto) + earned_fee)
        if shortfall > 0:
            self.total_written_off_atto = u256(int(self.total_written_off_atto) + shortfall)
            self._absorb_loss(shortfall)

        self._accrue_fees(earned_fee)

        court = gl.get_contract_at(self.court)
        court.emit(on="accepted").mark_settled(docket, str(credited))

        return {
            "docket": docket,
            "credited_atto": str(credited),
            "fee_atto": str(earned_fee),
            "shortfall_atto": str(shortfall),
            "note": note,
            "status": "RECOVERED",
            "closed_at": stamp,
        }

    @gl.public.write
    def write_off(self, docket: str, note: str) -> dict:
        """The insurer never paid. The underwriters take the loss, openly."""
        self._assert_owner()
        record = self.advances.get(docket)
        if record is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing has been advanced against '{docket}'")
        if record.status != "OUTSTANDING":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} '{docket}' is already {record.status}")
        if note.strip() == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} a write off needs a stated reason")

        principal = int(record.amount_atto)
        credited = int(record.recovered_atto)
        loss = principal - credited if principal > credited else 0
        record.status = "WRITTEN_OFF"
        record.closed_at = _chain_stamp()
        held = int(self.outstanding_atto) - principal
        self.outstanding_atto = u256(held if held > 0 else 0)
        self.total_written_off_atto = u256(int(self.total_written_off_atto) + loss)
        # Share the loss out now, pro rata by capital at work, rather than leaving it to
        # fall on whoever withdraws last.
        self._absorb_loss(loss)
        return {
            "docket": docket,
            "written_off_atto": str(loss),
            "credited_atto": str(credited),
            "note": note,
            "total_written_off_atto": str(int(self.total_written_off_atto)),
            "claimable_to_members_atto": str(int(self.total_member_share_atto)),
        }

    @gl.public.write
    def claim_for(self, member_address: str) -> str:
        """A relayed claim: transfers surplus directly to the member."""
        target = _require_address("member_address", member_address)
        owed = int(self.claimable_atto.get(target, u256(0)))
        if owed <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nothing is claimable for {target}")
        self.claimable_atto[target] = u256(0)
        held = int(self.total_member_share_atto) - owed
        self.total_member_share_atto = u256(held if held > 0 else 0)
        gl.get_contract_at(Address(target)).emit_transfer(
            value=u256(owed), on="finalized"
        )
        return str(owed)

    @gl.public.write
    def claim(self) -> str:
        """A member taking the surplus from a recovery that came in above the advance."""
        return self.claim_for(str(gl.message.sender_address))

    @gl.public.write
    def set_terms(self, advance_rate_bps: int, fee_bps: int, max_utilisation_bps: int) -> None:
        self._assert_owner()
        rate = int(advance_rate_bps)
        fee = int(fee_bps)
        utilisation = int(max_utilisation_bps)
        if rate < 1 or rate > BPS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} advance_rate_bps must sit between 1 and {BPS}")
        if fee < 0 or fee > 3000:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} fee_bps must sit between 0 and 3000")
        if utilisation < 1000 or utilisation > BPS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} max_utilisation_bps must sit between 1000 and {BPS}"
            )
        self.advance_rate_bps = u256(rate)
        self.fee_bps = u256(fee)
        self.max_utilisation_bps = u256(utilisation)

    @gl.public.write
    def set_band_caps(self, band_caps_atto: str) -> list:
        self._assert_owner()
        caps = _parse_caps(band_caps_atto)
        while len(self.band_caps_atto) > 0:
            self.band_caps_atto.pop()
        for cap in caps:
            self.band_caps_atto.append(u256(cap))
        return [str(c) for c in caps]

    @gl.public.write
    def set_court(self, court_address: str) -> None:
        self._assert_owner()
        cleaned = _require_address("court_address", court_address)
        self.court = Address(cleaned)
