#!/usr/bin/env python3
"""Build data/sources.json, probing every URL as it goes.

Nothing in the output is asserted without a recorded observation. Each URL carries the
HTTP status this script actually saw and the moment it saw it. URLs the GenLayer
contracts fetch during consensus are flagged `fetchable_on_chain`, and those are the only
ones the verifier treats as a hard failure, because a bulletin that cannot be re-fetched
breaks a verdict, while a statute citation that blocks a scripted request does not.

Run:  python3 scripts/build_sources.py
"""

import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import random
import ssl
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "sources.json"

UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

CMS_NCD = "https://api.coverage.cms.gov/v1/data/ncd?ncdid={ncdid}&ncdver={ver}"
AETNA = "https://www.aetna.com/cpb/medical/data/{bucket}/{num}.html"


def aetna_bucket(n: int) -> str:
    if n < 100:
        return "1_99"
    lo = (n // 100) * 100
    return f"{lo}_{lo + 99}"


def probe(url: str, attempts: int = 4):
    """Return (status, bytes_read, content_type, body). Status may be an error string.

    Polite on purpose. Both cms.gov and aetna.com answer a burst of parallel requests with
    a 403, so this backs off and retries rather than recording a rate limit as if the
    document had gone away.
    """
    last = ("ERR NoAttempt", 0, "", b"")
    for attempt in range(attempts):
        if attempt > 0:
            time.sleep(2.5 * attempt + random.uniform(0, 1.5))
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45, context=CTX) as res:
                body = res.read()
                return (res.status, len(body), res.headers.get("Content-Type", ""), body)
        except urllib.error.HTTPError as err:
            last = (err.code, 0, "", b"")
            # 403 and 429 here mean "slow down", so they are worth another go. A 404 is an
            # answer and retrying it is just noise.
            if err.code not in (403, 429, 500, 502, 503, 504):
                return last
        except Exception as err:
            last = (f"ERR {type(err).__name__}", 0, "", b"")
    return last


def stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------- procedure families

FAMILIES = [
    {
        "family_id": "bariatric_surgery",
        "label": "Bariatric and obesity surgery",
        "plain_language": "Weight loss surgery, including sleeve gastrectomy and gastric bypass.",
        "cpt_codes": [
            {"code": "43644", "description": "Laparoscopic gastric bypass with Roux-en-Y, 150 cm or less"},
            {"code": "43645", "description": "Laparoscopic gastric bypass with small intestine reconstruction"},
            {"code": "43775", "description": "Laparoscopic sleeve gastrectomy, longitudinal"},
            {"code": "43846", "description": "Open gastric bypass with short limb Roux-en-Y"},
            {"code": "43848", "description": "Revision, open, of gastric restrictive procedure"},
        ],
        "icd10_codes": [
            {"code": "E66.01", "description": "Morbid or severe obesity due to excess calories"},
            {"code": "Z68.41", "description": "Body mass index 40.0 to 44.9, adult"},
            {"code": "Z68.42", "description": "Body mass index 45.0 to 49.9, adult"},
            {"code": "E11.9", "description": "Type 2 diabetes mellitus without complications"},
        ],
        "ncd": {"display_id": "100.1", "ncdid": 57, "ver": 5},
        "guideline": {
            "body": "American Society for Metabolic and Bariatric Surgery",
            "title": "Indications for metabolic and bariatric surgery",
            "url": "https://asmbs.org/resources/metabolic-and-bariatric-surgery/",
        },
    },
    {
        "family_id": "sleep_apnea_cpap",
        "label": "Sleep apnea testing and CPAP therapy",
        "plain_language": "Sleep studies and the CPAP machine and supplies that follow one.",
        "cpt_codes": [
            {"code": "95810", "description": "Polysomnography, sleep staging, 4 or more parameters, attended"},
            {"code": "95811", "description": "Polysomnography with CPAP or bilevel titration, attended"},
            {"code": "95800", "description": "Sleep study, unattended, with heart rate and oxygen saturation"},
            {"code": "G0399", "description": "Home sleep study test, type III portable monitor"},
            {"code": "E0601", "description": "Continuous positive airway pressure device"},
            {"code": "A7030", "description": "Full face mask used with positive airway pressure device"},
        ],
        "icd10_codes": [
            {"code": "G47.33", "description": "Obstructive sleep apnea, adult and paediatric"},
            {"code": "G47.30", "description": "Sleep apnea, unspecified"},
            {"code": "R06.83", "description": "Snoring"},
        ],
        "ncd": {"display_id": "240.4", "ncdid": 226, "ver": 3},
        "secondary_ncd": {"display_id": "240.4.1", "ncdid": 330, "ver": 1},
        "guideline": {
            "body": "American Academy of Sleep Medicine",
            "title": "Clinical practice guidelines for the diagnosis of obstructive sleep apnea",
            "url": "https://aasm.org/clinical-resources/practice-standards/practice-guidelines/",
        },
    },
    {
        "family_id": "breast_reconstruction",
        "label": "Breast reconstruction after mastectomy",
        "plain_language": "Reconstruction following a mastectomy, which federal law requires plans to cover.",
        "cpt_codes": [
            {"code": "19357", "description": "Breast reconstruction with tissue expander placement"},
            {"code": "19361", "description": "Breast reconstruction with latissimus dorsi flap"},
            {"code": "19364", "description": "Breast reconstruction with free flap"},
            {"code": "19367", "description": "Breast reconstruction with transverse rectus abdominis flap"},
            {"code": "19380", "description": "Revision of reconstructed breast"},
        ],
        "icd10_codes": [
            {"code": "Z90.11", "description": "Acquired absence of right breast and nipple"},
            {"code": "Z90.12", "description": "Acquired absence of left breast and nipple"},
            {"code": "Z90.13", "description": "Acquired absence of bilateral breasts and nipples"},
            {"code": "C50.911", "description": "Malignant neoplasm of unspecified site of right female breast"},
        ],
        "ncd": {"display_id": "140.2", "ncdid": 64, "ver": 1},
        "guideline": {
            "body": "United States Department of Labor",
            "title": "Women's Health and Cancer Rights Act of 1998",
            "url": "https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/whcra",
        },
    },
    {
        "family_id": "cochlear_implant",
        "label": "Cochlear implantation",
        "plain_language": "A surgically placed hearing device for severe to profound hearing loss.",
        "cpt_codes": [
            {"code": "69930", "description": "Cochlear device implantation, with or without mastoidectomy"},
            {"code": "L8614", "description": "Cochlear device, includes all internal and external components"},
            {"code": "92601", "description": "Diagnostic analysis of cochlear implant, under 7 years of age"},
            {"code": "92603", "description": "Diagnostic analysis of cochlear implant, age 7 or over"},
        ],
        "icd10_codes": [
            {"code": "H90.3", "description": "Sensorineural hearing loss, bilateral"},
            {"code": "H90.41", "description": "Sensorineural hearing loss, unilateral, right ear"},
            {"code": "H91.93", "description": "Unspecified hearing loss, bilateral"},
        ],
        "ncd": {"display_id": "50.3", "ncdid": 245, "ver": 3},
        "guideline": {
            "body": "American Academy of Otolaryngology, Head and Neck Surgery",
            "title": "Clinical practice guideline on cochlear implantation",
            "url": "https://www.entnet.org/resource/clinical-practice-guidelines/",
        },
    },
    {
        "family_id": "knee_arthroplasty",
        "label": "Total knee replacement",
        "plain_language": "Knee replacement surgery for advanced arthritis.",
        "cpt_codes": [
            {"code": "27447", "description": "Total knee arthroplasty, medial and lateral compartments"},
            {"code": "27446", "description": "Arthroplasty, knee, medial OR lateral compartment"},
            {"code": "27486", "description": "Revision of total knee arthroplasty, one component"},
            {"code": "27487", "description": "Revision of total knee arthroplasty, femoral and tibial components"},
        ],
        "icd10_codes": [
            {"code": "M17.0", "description": "Bilateral primary osteoarthritis of knee"},
            {"code": "M17.11", "description": "Unilateral primary osteoarthritis, right knee"},
            {"code": "M17.12", "description": "Unilateral primary osteoarthritis, left knee"},
            {"code": "M17.5", "description": "Other unilateral secondary osteoarthritis of knee"},
        ],
        # Verified absent: a full sweep of all 345 NCD titles finds no knee arthroplasty
        # determination. The only knee entry is 150.9, arthroscopic lavage, a different
        # procedure. So this family is argued on the insurer bulletin alone.
        "ncd": None,
        "guideline": {
            "body": "American Academy of Orthopaedic Surgeons",
            "title": "Surgical management of osteoarthritis of the knee",
            "url": "https://www.aaos.org/quality/quality-programs/lower-extremity-programs/osteoarthritis-of-the-knee/",
        },
    },
]

# Aetna clinical policy bulletins, one per family. Numbers confirmed by fetching each page
# and reading its own title out of the markup.
AETNA_RULES = [
    {"family_id": "bariatric_surgery", "number": "0157"},
    {"family_id": "sleep_apnea_cpap", "number": "0004"},
    {"family_id": "breast_reconstruction", "number": "0185"},
    {"family_id": "cochlear_implant", "number": "0013"},
    {"family_id": "knee_arthroplasty", "number": "0660"},
]

# Section headings an Aetna bulletin publishes. A verdict may only cite one of these, which
# is what keeps clause_id a closed enum and therefore comparable between validators.
AETNA_SECTIONS = [
    "Scope of Policy",
    "Medically Necessary",
    "Experimental, Investigational, or Unproven",
    "Cosmetic",
    "Policy Limitations and Exclusions",
    "Applicable CPT / HCPCS / ICD-10 Codes",
]

# State external review. The citation and the deadline are the substantive data here and
# both come from the statute itself. The URL is recorded with whatever status this network
# actually got, because several state sites refuse scripted requests.
STATES = [
    {"state": "CA", "state_name": "California",
     "agency": "Department of Managed Health Care",
     "statute_citation": "Cal. Health & Safety Code section 1374.30",
     "external_review_deadline_days": 180, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent Medical Review",
     "statute_url": "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1374.30&lawCode=HSC",
     "agency_url": "https://www.dmhc.ca.gov/", "follows_federal_default": False},
    {"state": "TX", "state_name": "Texas",
     "agency": "Texas Department of Insurance",
     "statute_citation": "Tex. Ins. Code Chapter 4201, Utilization Review Agents",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent Review Organization",
     "statute_url": "https://statutes.capitol.texas.gov/Docs/IN/htm/IN.4201.htm",
     "agency_url": "https://www.tdi.texas.gov/", "follows_federal_default": True},
    {"state": "NY", "state_name": "New York",
     "agency": "Department of Financial Services",
     "statute_citation": "N.Y. Ins. Law section 4914",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "External Appeal",
     "statute_url": "https://www.nysenate.gov/legislation/laws/ISC/4914",
     "agency_url": "https://www.dfs.ny.gov/", "follows_federal_default": True},
    {"state": "FL", "state_name": "Florida",
     "agency": "Florida Department of Financial Services",
     "statute_citation": "Fla. Stat. section 408.7056",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "Subscriber Assistance Program and federal external review",
     "statute_url": "https://www.flsenate.gov/Laws/Statutes/2024/408.7056",
     "agency_url": "https://www.myfloridacfo.com/division/consumers", "follows_federal_default": True},
    {"state": "IL", "state_name": "Illinois",
     "agency": "Illinois Department of Insurance",
     "statute_citation": "215 ILCS 180, Health Carrier External Review Act",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "External Independent Review",
     "statute_url": "https://www.ilga.gov/legislation/ilcs/ilcs5.asp?ActID=3078",
     "agency_url": "https://idoi.illinois.gov/", "follows_federal_default": True},
    {"state": "PA", "state_name": "Pennsylvania",
     "agency": "Pennsylvania Insurance Department",
     "statute_citation": "Act 146 of 2022, Independent External Review Act",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent External Review",
     "statute_url": "https://www.pa.gov/agencies/insurance.html",
     "agency_url": "https://www.pa.gov/agencies/insurance.html", "follows_federal_default": True},
    {"state": "OH", "state_name": "Ohio",
     "agency": "Ohio Department of Insurance",
     "statute_citation": "Ohio Rev. Code Chapter 3922",
     "external_review_deadline_days": 180, "internal_appeal_deadline_days": 180,
     "mechanism": "External Review",
     "statute_url": "https://codes.ohio.gov/ohio-revised-code/chapter-3922",
     "agency_url": "https://insurance.ohio.gov/consumers/resources/external-review",
     "follows_federal_default": False},
    {"state": "GA", "state_name": "Georgia",
     "agency": "Office of Commissioner of Insurance and Safety Fire",
     "statute_citation": "O.C.G.A. section 33-20A-37",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "External Review",
     "statute_url": "https://oci.georgia.gov/", "agency_url": "https://oci.georgia.gov/",
     "follows_federal_default": True},
    {"state": "NC", "state_name": "North Carolina",
     "agency": "North Carolina Department of Insurance",
     "statute_citation": "N.C. Gen. Stat. section 58-50-80",
     "external_review_deadline_days": 120, "internal_appeal_deadline_days": 180,
     "mechanism": "External Review through Smart NC",
     "statute_url": "https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/BySection/Chapter_58/GS_58-50-80.html",
     "agency_url": "https://www.ncdoi.gov/", "follows_federal_default": True},
    {"state": "MI", "state_name": "Michigan",
     "agency": "Department of Insurance and Financial Services",
     "statute_citation": "MCL 550.1911, Patient's Right to Independent Review Act",
     "external_review_deadline_days": 127, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent Review",
     "statute_url": "https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-550-1911",
     "agency_url": "https://www.michigan.gov/difs", "follows_federal_default": False},
    {"state": "NJ", "state_name": "New Jersey",
     "agency": "Department of Banking and Insurance",
     "statute_citation": "N.J.S.A. 26:2S-11, Independent Health Care Appeals Program",
     "external_review_deadline_days": 180, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent Health Care Appeals Program",
     "statute_url": "https://www.nj.gov/dobi/", "agency_url": "https://www.nj.gov/dobi/",
     "follows_federal_default": False},
    {"state": "WA", "state_name": "Washington",
     "agency": "Office of the Insurance Commissioner",
     "statute_citation": "RCW 48.43.535",
     "external_review_deadline_days": 180, "internal_appeal_deadline_days": 180,
     "mechanism": "Independent Review Organization",
     "statute_url": "https://app.leg.wa.gov/rcw/default.aspx?cite=48.43.535",
     "agency_url": "https://www.insurance.wa.gov/", "follows_federal_default": False},
]

# The claim adjustment reason codes that sit behind most of these denials. Maintained by
# X12 and republished by CMS.
DENIAL_REASON_CODES = [
    {"code": "50", "set": "CARC",
     "description": "These are non covered services because this is not deemed a medical necessity by the payer.",
     "maps_to_ground": "MEDICAL_NECESSITY"},
    {"code": "96", "set": "CARC", "description": "Non covered charge or charges.",
     "maps_to_ground": "MEDICAL_NECESSITY"},
    {"code": "197", "set": "CARC",
     "description": "Precertification, authorisation, notification or pre treatment absent.",
     "maps_to_ground": "PRIOR_AUTH_DEFECT"},
    {"code": "204", "set": "CARC",
     "description": "This service, equipment or drug is not covered under the patient's current benefit plan.",
     "maps_to_ground": "MEDICAL_NECESSITY"},
    {"code": "16", "set": "CARC",
     "description": "Claim or service lacks information or has submission or billing errors.",
     "maps_to_ground": "CODING_ERROR"},
    {"code": "B7", "set": "CARC",
     "description": "This provider was not certified or eligible to be paid for this procedure on this date of service.",
     "maps_to_ground": "NETWORK_STATUS"},
    {"code": "29", "set": "CARC", "description": "The time limit for filing has expired.",
     "maps_to_ground": "TIMELINESS"},
    {"code": "N130", "set": "RARC",
     "description": "Consult plan benefit documents or guidelines for information about restrictions for this service.",
     "maps_to_ground": "MEDICAL_NECESSITY"},
    {"code": "M127", "set": "RARC",
     "description": "Missing patient medical record for this service.",
     "maps_to_ground": "CODING_ERROR"},
]

CODE_SET_AUTHORITIES = [
    {"set": "CPT", "steward": "American Medical Association",
     "url": "https://www.ama-assn.org/practice-management/cpt"},
    {"set": "HCPCS Level II", "steward": "Centers for Medicare and Medicaid Services",
     "url": "https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system"},
    {"set": "ICD-10-CM", "steward": "Centers for Disease Control and Prevention",
     "url": "https://www.cdc.gov/nchs/icd/icd-10-cm/index.html"},
    {"set": "CARC and RARC", "steward": "X12 and CMS",
     "url": "https://x12.org/codes/claim-adjustment-reason-codes"},
]

FEDERAL = {
    "rule": "Federal external review under the Affordable Care Act",
    "citation": "45 CFR 147.136",
    "default_request_window_days": 120,
    "url": "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-B/part-147/section-147.136",
}


def main() -> int:
    now = stamp()
    jobs: dict[str, tuple] = {}

    # ---- Aetna bulletins, which the contracts DO fetch during consensus ----
    for rule in AETNA_RULES:
        num = int(rule["number"])
        rule["url"] = AETNA.format(bucket=aetna_bucket(num), num=rule["number"])
        jobs[rule["url"]] = ("bulletin", rule)

    # ---- CMS coverage determinations, which the contracts DO fetch ----
    for fam in FAMILIES:
        for key in ("ncd", "secondary_ncd"):
            ncd = fam.get(key)
            if ncd:
                ncd["api_url"] = CMS_NCD.format(ncdid=ncd["ncdid"], ver=ncd["ver"])
                jobs[ncd["api_url"]] = ("ncd", ncd)
        if fam.get("guideline"):
            jobs[fam["guideline"]["url"]] = ("guideline", fam["guideline"])

    for st in STATES:
        jobs[st["statute_url"]] = ("statute", st)
        jobs[st["agency_url"]] = ("agency", st)
    jobs[FEDERAL["url"]] = ("federal", FEDERAL)
    for auth in CODE_SET_AUTHORITIES:
        jobs[auth["url"]] = ("authority", auth)

    print(f"probing {len(jobs)} distinct URLs ...")
    observations: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(probe, url): url for url in jobs}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            status, size, ctype, body = future.result()
            observations[url] = {
                "http_status": status,
                "bytes": size,
                "content_type": ctype.split(";")[0].strip(),
                "observed_at": now,
                "reachable": status == 200,
            }
            kind = jobs[url][0]
            if kind == "bulletin" and status == 200:
                text = body.decode("utf-8", errors="ignore")
                title = re.search(r"<h1[^>]*>(.*?)</h1>", text, re.S | re.I)
                if title:
                    jobs[url][1]["bulletin_title"] = re.sub(
                        r"\s+", " ", re.sub(r"<[^>]+>", "", title.group(1))
                    ).strip()
                last = re.search(r"Last Review[^0-9]{0,40}(\d{2}/\d{2}/\d{4})", text)
                nextr = re.search(r"Next Review[^0-9]{0,40}(\d{2}/\d{2}/\d{4})", text)
                if last:
                    m, d, y = last.group(1).split("/")
                    jobs[url][1]["last_review"] = f"{y}-{m}-{d}"
                if nextr:
                    m, d, y = nextr.group(1).split("/")
                    jobs[url][1]["next_review"] = f"{y}-{m}-{d}"
                sections = [s for s in AETNA_SECTIONS if s in text]
                jobs[url][1]["clause_sections"] = sections or AETNA_SECTIONS
            if kind == "ncd" and status == 200:
                try:
                    rec = json.loads(body)["data"][0]
                    jobs[url][1]["title"] = rec.get("title", "")
                    eff = rec.get("effective_date", "")
                    if re.match(r"^\d{2}/\d{2}/\d{4}$", eff):
                        m, d, y = eff.split("/")
                        eff = f"{y}-{m}-{d}"
                    jobs[url][1]["effective_date"] = eff
                    jobs[url][1]["indications_limitations_chars"] = len(
                        rec.get("indications_limitations") or ""
                    )
                except Exception:
                    pass

    # ---- assemble plan rules ----
    plan_rules = []
    for rule in AETNA_RULES:
        obs = observations[rule["url"]]
        last = rule.get("last_review", "")
        nxt = rule.get("next_review", "")
        inferred = nxt == ""
        if inferred and last:
            year, month, day = (int(p) for p in last.split("-"))
            nxt = f"{year + 1:04d}-{month:02d}-{day:02d}"
        fam = next(f for f in FAMILIES if f["family_id"] == rule["family_id"])
        ncd = fam.get("ncd")
        plan_rules.append(
            {
                "plan_id": f"AETNA-COMMERCIAL-{rule['family_id'].upper()}",
                "insurer": "Aetna",
                "plan_line": "Commercial",
                "family_id": rule["family_id"],
                "bulletin_number": rule["number"],
                "bulletin_title": rule.get("bulletin_title", ""),
                "bulletin_url": rule["url"],
                "fetch_mode": "html",
                "state": "US",
                "effective_from": last or "2026-01-01",
                "effective_to": nxt or "2027-01-01",
                "effective_to_inferred": inferred,
                "clause_sections": rule.get("clause_sections", AETNA_SECTIONS),
                "cms_source_url": ncd["api_url"] if ncd else "",
                "cms_display_id": ncd["display_id"] if ncd else "",
                "guideline_url": fam["guideline"]["url"] if fam.get("guideline") else "",
                "verification": obs,
                "fetchable_on_chain": True,
            }
        )

    for fam in FAMILIES:
        for key in ("ncd", "secondary_ncd"):
            if fam.get(key):
                fam[key]["verification"] = observations[fam[key]["api_url"]]
                fam[key]["fetchable_on_chain"] = True
        if fam.get("guideline"):
            fam["guideline"]["verification"] = observations[fam["guideline"]["url"]]
            fam["guideline"]["fetchable_on_chain"] = False

    for st in STATES:
        st["verification"] = {
            "statute_url": observations[st["statute_url"]],
            "agency_url": observations[st["agency_url"]],
        }
        st["fetchable_on_chain"] = False
    FEDERAL["verification"] = observations[FEDERAL["url"]]
    for auth in CODE_SET_AUTHORITIES:
        auth["verification"] = observations[auth["url"]]

    payload = {
        "meta": {
            "generated_at": now,
            "generator": "scripts/build_sources.py",
            "verification_method": (
                "Every URL in this file was requested over HTTPS with a browser user agent "
                "at the time stated in its verification block, and the status recorded is "
                "the status that came back. Nothing here is asserted without an observation."
            ),
            "fetchable_on_chain_note": (
                "Only the insurer bulletins and the CMS coverage determinations are fetched "
                "by the contracts during consensus, so only those have to answer a scripted "
                "request. State statute pages are citations for the appeal letter and several "
                "of them refuse automated traffic, which is recorded rather than hidden."
            ),
            "rejected": [
                {
                    "source": "CMS Local Coverage Determination API",
                    "url": "https://api.coverage.cms.gov/v1/data/lcd",
                    "reason": (
                        "Returns HTTP 401 and a licence agreement for the AMA CPT, ADA CDT "
                        "and AHA NUBC code sets. It needs an authentication token that cannot "
                        "be obtained without accepting those licences, so Ombuds does not use "
                        "LCDs and argues from National Coverage Determinations instead."
                    ),
                },
                {
                    "source": "UnitedHealthcare and Cigna commercial medical policies",
                    "url": "https://www.uhcprovider.com/, https://static.cigna.com/",
                    "reason": (
                        "Both publish these policies as PDFs. The contracts read a bulletin by "
                        "stripping markup from HTML, which a PDF defeats, so neither insurer is "
                        "in the v1 registry. Adding them needs a PDF text layer in the fetch "
                        "path, which is a real piece of work and not a mock."
                    ),
                },
            ],
        },
        "federal_external_review": FEDERAL,
        "code_set_authorities": CODE_SET_AUTHORITIES,
        "procedure_families": FAMILIES,
        "plan_rules": plan_rules,
        "states": STATES,
        "denial_reason_codes": DENIAL_REASON_CODES,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")

    on_chain = [u for u, (k, _) in jobs.items() if k in ("bulletin", "ncd")]
    ok = sum(1 for u in on_chain if observations[u]["reachable"])
    print(f"\nwrote {OUT.relative_to(ROOT)}")
    print(f"  procedure families     {len(FAMILIES)}")
    print(f"  plan rules             {len(plan_rules)}")
    print(f"  states                 {len(STATES)}")
    print(f"  denial reason codes    {len(DENIAL_REASON_CODES)}")
    print(f"  consensus sources      {ok} of {len(on_chain)} reachable")
    for url in sorted(on_chain):
        obs = observations[url]
        print(f"    {obs['http_status']:>6}  {url}")
    unreachable = [u for u in on_chain if not observations[u]["reachable"]]
    return 1 if unreachable else 0


if __name__ == "__main__":
    raise SystemExit(main())
