// Denial Response Prompts - Strategic rebuttals for each denial type

const denialResponsePrompts = {
    // System prompt for generating denial rebuttals
    denialRebuttalSystemPrompt: `You are an expert at fighting FOIA denials for Matcher, a documentary production company. Your job is to craft intelligent, legally-grounded rebuttals that cite specific statutes and case law.

CORE STRATEGY:
- Always cite the specific state's public records law
- Reference segregability requirements (agencies must release non-exempt portions)
- Provide proof of existence when possible
- Offer to narrow scope or accept redactions
- Be firm but professional - never hostile
- Quote exact statutory language when helpful

TONE:
- Assertive but respectful
- Cite law confidently
- Show willingness to cooperate
- Make it clear you know your rights
- Keep under 250 words

You should push back hard on weak denials while showing good faith.`,

    // Specific strategies for each denial type
    denialStrategies: {
        overly_broad: {
            name: "Overly Broad / Undue Burden",
            strategy: `REBUTTAL STRATEGY:
1. Acknowledge their concern and offer to narrow immediately
2. Propose specific scope: primary officer BWC + badge/name, exact time window, specific location
3. Cite state law requirement that agencies assist requesters in narrowing
4. Offer phased delivery (Phase 1: essential records, Phase 2: additional if needed)
5. Reference that documentary purpose = public interest

TEMPLATE STRUCTURE:
- Thank them for review
- Narrow to: Officer [name/badge], [start time] to [end time], [location]
- Add: interrogation footage (if any) + 911 call
- Cite segregability requirement
- Offer to accept redactions (faces, plates, PII, juveniles)
- Reference state law on assisting requesters

KEY STATUTES TO CITE (by state):
- Illinois: 5 ILCS 140/6(f) - agencies must segregate and release non-exempt portions
- California: Gov Code 6253(a) - cannot deny solely on burden grounds
- New York: FOIL 87(2) - must identify specific exemption for each denial
- Texas: Gov Code 552.301 - agencies must assist in narrowing requests`,

            exampleRebuttal: `Thank you for your response. To address the burden concern, I'm happy to narrow the scope immediately.

Revised request:
- Body-worn camera footage from the primary responding officer only (if you can provide name/badge, or Officer [Name] if known), from [incident time - 30 min] to [incident time + 30 min], at [specific location]
- Any interrogation/interview footage (if it exists)
- 911 call audio for this incident

Under [State] law [cite statute], agencies must release segregable portions of records even when some content is exempt. We accept standard redactions for faces, license plates, PII, and juveniles.

This narrowed scope focuses on essential documentary footage. If phased delivery would help, we're open to Phase 1 (primary BWC + 911) first.

Please advise if this scope is manageable.`
        },

        no_records: {
            name: "No Responsive Records",
            strategy: `REBUTTAL STRATEGY:
1. Point to proof of existence (police report mentions BWC, news articles, CAD logs)
2. Request search details (systems searched, date ranges, custodians)
3. Ask for police report if not provided (this often mentions BWC/cameras)
4. Suggest specific units/divisions to search (patrol, detective, evidence)
5. Request re-search with specific officer names/badges if known
6. Cite state law requirement to conduct thorough search

TEMPLATE STRUCTURE:
- Challenge "no records" with evidence
- Request the police/incident report immediately
- Ask for search methodology details
- Propose specific search terms/units
- Cite state law on adequate search requirements
- Offer to provide additional identifying information

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/3 - requires diligent search
- California: Gov Code 6253.1 - must assist in identifying records
- New York: FOIL 89(3) - must certify search was diligent
- Texas: Gov Code 552.301 - must respond that records don't exist or provide them`,

            exampleRebuttal: `Your response indicates no responsive records were found. However, [police report/news articles/public sources] indicate that [body-worn cameras/911 calls/surveillance footage] exist for this incident.

Specifically: [cite specific evidence - "The incident report filed by Officer [Name] on [date] references activation of body-worn camera" or "News coverage from [source] states police reviewed surveillance footage"].

To assist your search:
1. Please provide the Police/Incident Report for this case if not already produced
2. Please search the following units/systems: [patrol division, detective bureau, evidence/property, CAD/RMS system]
3. Please confirm whether footage retention periods have expired and provide retention schedule
4. If Officer [Name/Badge] or other specific officers responded, please search their BWC recordings for [date/time window]

Under [State statute], agencies must conduct a diligent search and provide details when claiming no records exist. If another agency is the custodian, please advise or forward this request.

I'm happy to provide additional details to help locate these records.`
        },

        ongoing_investigation: {
            name: "Ongoing Investigation / Active Case",
            strategy: `REBUTTAL STRATEGY:
1. Request segregable non-investigative records NOW (police report, 911, basic BWC)
2. Cite state law requiring release of segregable portions
3. Offer to accept redactions protecting witnesses/confidential info
4. Request timeframe for when investigation will close
5. Propose timeboxed BWC (just scene arrival, not tactical discussions)
6. Emphasize public interest in transparency

TEMPLATE STRUCTURE:
- Acknowledge ongoing investigation
- Request segregable portions immediately
- Cite specific state law on active investigation exemption (it's usually narrow)
- Propose specific timeboxed footage (scene arrival, booking, transport)
- Accept redactions for witness protection
- Request estimate of when investigation closes
- Cite public interest in police accountability

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/7(1)(d)(vi) - narrow exemption, must release segregable parts
- California: Gov Code 6254(f) - ongoing investigation exemption is LIMITED
- New York: Civil Rights Law 50-a has been REPEALED - BWC often releasable
- Texas: Gov Code 552.108 - must prove specific harm from disclosure`,

            exampleRebuttal: `I understand this is an active investigation. However, under [State statute cite], the ongoing investigation exemption does not categorically exempt all records - segregable non-investigative portions must still be released.

I respectfully request the following segregable records that won't compromise the investigation:
- The primary Police/Incident Report (basic facts, no tactical details)
- 911 call audio (already public information)
- Timeboxed body-worn camera: scene arrival and initial response only ([time] to [time]), with redactions of witness statements or tactical discussions if needed
- Booking/transport footage (non-investigative)

We accept redactions to protect witness identities, confidential informants, and investigative techniques. We consent to blurring faces and bleeping audio as needed.

Additionally, please advise when the investigation is expected to close so we can re-request full records at that time.

Documentary transparency serves the public interest, and these segregable portions won't interfere with your ongoing work.`
        },

        privacy_exemption: {
            name: "Privacy / Victim Protection",
            strategy: `REBUTTAL STRATEGY:
1. Immediately confirm acceptance of ALL standard redactions
2. List specific redactions you accept (faces, plates, addresses, medical, juveniles)
3. Cite state law requiring segregability
4. Offer to pay additional redaction costs
5. Request segregable portions with privacy info removed
6. Emphasize that redaction ≠ complete denial

TEMPLATE STRUCTURE:
- Acknowledge privacy concerns
- Explicitly consent to comprehensive redactions
- List each type of redaction accepted
- Cite segregability requirement
- Offer to pay reasonable redaction costs
- Request segregable portions be released
- Note that public interest still exists

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/7(1)(c) - privacy exemption, but must segregate
- California: Gov Code 6254(c) - privacy exemption is not absolute
- Most states: Redaction is required before complete denial
- Emphasize segregability is mandatory`,

            exampleRebuttal: `I understand the privacy concerns. We fully consent to comprehensive redactions to protect all private information.

Specifically, we accept redactions/blurring/bleeping of:
- All faces of victims, witnesses, bystanders, and uninvolved parties
- License plate numbers
- Home addresses and phone numbers
- Medical information and health details
- Names and identities of juveniles
- Social security numbers and financial information
- Any other personally identifiable information (PII)

Under [State statute], even when privacy exemptions apply, agencies must release segregable portions with protected information redacted. Complete denial is only appropriate when segregation is impossible.

We are willing to pay reasonable redaction costs. Please provide the requested records (body-worn camera footage, 911 calls, reports) with appropriate privacy redactions applied.

Documentary accountability serves the public interest, and these redactions adequately protect individual privacy.`
        },

        excessive_fees: {
            name: "Excessive Fees (Barrier Tactic)",
            strategy: `REBUTTAL STRATEGY:
1. Request line-item breakdown (search, review, redaction, media)
2. Request file list with durations/file counts
3. Challenge unreasonable hourly rates if excessive
4. Propose narrowing to reduce costs
5. Cite state law fee limits and public interest waivers
6. Request fee waiver if available (documentary = public interest)
7. Compare to other agencies' costs for similar requests

TEMPLATE STRUCTURE:
- Request detailed cost breakdown
- Request file list to evaluate necessity
- Propose narrowing (primary officer + essential footage)
- Cite state law fee restrictions
- Request public interest fee waiver
- Note willingness to pay REASONABLE costs
- Propose phased delivery to reduce upfront costs

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/6 - fees limited to actual costs, public interest waiver available
- California: Gov Code 6253(b) - cannot charge more than direct costs
- Many states: Documentary/public interest = fee waiver eligibility
- Cannot use fees as barrier to access`,

            exampleRebuttal: `Thank you for the estimate. To better understand the costs, please provide:

1. Line-item breakdown: search time, review hours, redaction hours, media export costs (with hourly rates)
2. File list: specific files/footage with durations and file counts
3. Which officers/cameras are included and estimated duration of each

Under [State statute cite], fees must reflect actual direct costs only and cannot be used as a barrier to access.

To reduce costs, I propose narrowing to:
- Primary responding officer body-worn camera only (Officer [Name/Badge] if known)
- 911 call audio
- Incident report

This focuses on essential documentary footage. If the estimate remains high, please consider:
1. Public interest fee waiver (documentary transparency serves public interest per [statute])
2. Phased delivery: Phase 1 (essential records) now, Phase 2 (supplemental) if budget allows

I'm prepared to pay reasonable costs but the current estimate appears to exceed standard rates for similar requests.`
        },

        wrong_agency: {
            name: "Wrong Agency / Misdirected",
            strategy: `REBUTTAL STRATEGY:
1. Request they forward to correct custodian (many states require this)
2. Request custodian contact information
3. Cite state law requiring agencies to assist/forward
4. Thank them and confirm forwarding
5. Follow up with correct agency once identified

TEMPLATE STRUCTURE:
- Thank them for clarification
- Request custodian information
- Request they forward per state law
- Confirm you'll follow up with correct agency

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/6.5 - must forward to correct agency
- Many states require assistance in identifying custodian`,

            exampleRebuttal: `Thank you for clarifying that your agency is not the custodian of these records.

Under [State statute], when an agency receives a misdirected request, they must either forward it to the proper custodian or provide the requester with contact information for the correct agency.

Please:
1. Forward this request to the custodian agency and confirm you've done so, OR
2. Provide the name, department, and contact information (email/phone) for the correct custodian

Once I have this information, I will follow up directly with the appropriate agency.

Thank you for your assistance in directing this request properly.`
        },

        retention_expired: {
            name: "Retention Expired / Records Destroyed",
            strategy: `REBUTTAL STRATEGY:
1. Request retention schedule citation
2. Request destruction log/certification (date, authorizing official)
3. Question if retention period truly expired (often footage kept longer)
4. Request any remaining metadata/thumbnails/indexes
5. Request secondary sources (dispatch recordings, third-party copies)
6. Challenge premature destruction if within statute

TEMPLATE STRUCTURE:
- Request retention schedule and destruction documentation
- Question timeline (when incident vs. when destroyed)
- Request metadata/indexes that may remain
- Request alternative sources
- If premature, cite violation of retention law

KEY STATUTES TO CITE:
- State records retention laws
- Many states: BWC retention = 90 days minimum, longer for incidents
- Illinois: 50 ILCS 205 - Local Records Act`,

            exampleRebuttal: `Thank you for advising the records were destroyed/not retained. To verify this claim, please provide:

1. Citation to the specific retention schedule or policy authorizing destruction
2. Destruction log/certification including: date destroyed, authorizing official, and records management system reference
3. Timeline: incident date [DATE] vs. destruction date - please confirm retention period was met

Additionally, please advise:
- Do any metadata, file indexes, or thumbnails remain in your systems?
- Were dispatch/CAD recordings or 911 audio retained separately (often different retention)?
- Are there third-party copies (county dispatch, mutual aid agencies, court exhibits)?

Under [State retention statute], [body-worn camera footage/incident records] must be retained for [X days/months] minimum. If destruction occurred prematurely or without proper authorization, please provide replacement records or certification of the violation.

If retention legitimately expired, please provide the documentation requested above.`
        },

        format_issue: {
            name: "Format / Portal Issues",
            strategy: `REBUTTAL STRATEGY:
1. Request re-opening of portal or fresh links
2. Accept alternative delivery (email, mail, physical media)
3. Accept compressed/standard format copies
4. Cite state law requiring reasonable access

TEMPLATE STRUCTURE:
- Describe technical issue
- Request alternative delivery
- Confirm acceptance of standard formats
- Request they fulfill obligation via alternate method

KEY POINTS:
- Format issues are never valid denial grounds
- Must provide records in some accessible format`,

            exampleRebuttal: `I appreciate your response, but I'm experiencing [portal closure/expired links/technical issues] preventing access to the records.

Under [State statute], technical issues do not excuse the agency's obligation to provide public records. Please provide the records via an alternative method:

1. Fresh/re-opened download links with extended expiration
2. Email delivery (if file size permits)
3. Physical media mailed to: 3021 21st Ave W, Apt 202, Seattle, WA 98199
4. Cloud storage link (Google Drive, Dropbox, etc.)

I accept standard formats/codecs and compressed copies where allowed by law. Please advise which delivery method works best for your systems.

Thank you for ensuring access despite the technical difficulties.`
        }
    }
};

module.exports = denialResponsePrompts;
