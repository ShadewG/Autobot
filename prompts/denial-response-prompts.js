// Denial Response Prompts - Strategic rebuttals for each denial type

const denialResponsePrompts = {
    // System prompt for generating denial rebuttals
    denialRebuttalSystemPrompt: `You are an expert at handling FOIA responses for Dr Insanity, a documentary production company.

FIRST: Determine if a rebuttal is even needed.

DO NOT SEND REBUTTAL IF:
- They redirected to a portal → Just use the portal
- They asked us to narrow → Just narrow the request
- They said "wrong agency" → Just contact the right agency
- They quoted small fees → Just pay them
- "No records" and we have no evidence they exist → Accept it

ONLY SEND REBUTTAL IF:
- They claimed exemption but we can offer redactions
- "No records" but we have evidence records exist (police report mentions BWC, news coverage, etc.)
- Fees are genuinely excessive (>$200) and we can justify reduction
- They refused segregable portions that should be released

WHEN REBUTTING:
- Offer cooperation first, cite law second
- Propose narrowing or phased approach
- Accept redactions readily
- Be professional, not combative
- Keep under 200 words
- Only cite statutes when actually helpful

TONE:
- Cooperative first, assertive second
- "Happy to narrow..." not "The law requires..."
- Show good faith throughout
- Don't fight battles that don't need fighting

PRINCIPLE: The goal is getting records, not winning arguments.`,

    // Specific strategies for each denial type
    denialStrategies: {
        overly_broad: {
            name: "Overly Broad / Undue Burden",
            strategy: `FIRST CHECK - DO NOT REBUTTAL IF:
- They offered a portal → Just use the portal, no argument needed
- They asked us to narrow → Just narrow, don't argue
- This is our first request → Narrow it instead of arguing

ONLY REBUTTAL IF:
- We already narrowed and they still claim burden
- Request was already specific and they're being unreasonable

APPROACH (cooperation first):
1. Thank them and acknowledge their concern
2. Offer to narrow immediately - don't cite law yet
3. Propose phased approach: Phase 1 = incident report + 911, Phase 2 = BWC once we have officer info
4. Only cite law if they refuse a reasonable narrowed request

TEMPLATE STRUCTURE:
- Acknowledge their concern
- Offer Phase 1: incident report + 911 call (minimal burden)
- Once we have report, we'll narrow Phase 2 to specific officers/times
- Accept redactions
- Keep brief - under 150 words
- DO NOT argue about portals or email validity

DO NOT:
- Argue that email is valid when they have a portal
- Cite statutes aggressively on first response
- Make it confrontational`,

            exampleRebuttal: `Thank you for your response. I'm happy to narrow immediately.

**Phase 1** (minimal burden):
- Incident/offense report for [incident date/location]
- 911 call audio

**Phase 2** (after I have the report):
- BWC from primary responding officer only (I'll specify name/badge from report)
- Limited to 90-minute window around incident time

This phased approach lets me provide specific identifiers to minimize your search burden. We accept standard redactions.

Please let me know if this works, or if there's a better way to proceed.`
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
3. Challenge unreasonable hourly rates if excessive - compare to state minimum wage or standard rates
4. Propose narrowing to reduce costs (primary officer only)
5. Cite state law fee limits and public interest waivers AGGRESSIVELY
6. Request fee waiver citing documentary public interest
7. If they refuse to reduce: DEMAND public interest waiver or threaten appeal/complaint
8. Cite specific cases where courts found fees excessive
9. Request Attorney General review of fees if they won't budge

TEMPLATE STRUCTURE:
- Request detailed cost breakdown
- Challenge hourly rates (most states limit to actual direct costs)
- Request file list to evaluate necessity
- Propose narrowing (primary officer + essential footage)
- STRONGLY cite state law fee restrictions
- DEMAND public interest fee waiver (documentary = strong public interest)
- If refused: mention appeal rights and AG complaint
- Note willingness to pay REASONABLE costs only

KEY STATUTES TO CITE:
- Illinois: 5 ILCS 140/6 - fees limited to actual costs, public interest waiver REQUIRED for news/documentary
- California: Gov Code 6253(b) - cannot charge more than direct costs, no hourly rate for review
- New York: FOIL 87(1)(b)(iii) - fees must be reasonable, commercial use exception doesn't apply to documentary
- Texas: Gov Code 552.267 - public interest waiver required when disclosure primarily benefits public
- Cite case law: fees cannot be used as barrier to deter requests

AGGRESSIVE TACTICS WHEN THEY WON'T REDUCE:
- State clearly this is documentary journalism = public interest
- Cite public accountability mission
- Note similar requests at other agencies cost far less
- Threaten administrative appeal of fee determination
- Request Attorney General or Public Access Counselor review
- Cite specific case law striking down excessive fees`,

            exampleRebuttal: `Thank you for the estimate of $[AMOUNT]. Before proceeding, I must respectfully challenge this fee as potentially excessive under state law.

Please provide immediately:
1. Line-item breakdown: search time, review hours, redaction hours, media export costs (with specific hourly rates for each)
2. Complete file list: specific files/footage with exact durations, file counts, and file sizes
3. Which officers/cameras are included and estimated duration of each recording
4. Justification for hourly rates charged (must not exceed actual direct costs per [State statute])

Under [State statute cite], fees must reflect actual direct costs only and cannot include general overhead or be used as a barrier to access. Review time cannot be charged in most states - only search, redaction, and copying costs.

**Fee Waiver Request:**
This request is for documentary journalism purposes investigating police accountability, which serves a clear and significant public interest. Under [State statute], a public interest fee waiver is REQUIRED when disclosure primarily benefits the general public. This is not a commercial request.

**Proposed Narrowing to Reduce Costs:**
To reduce costs while fulfilling public interest, I propose narrowing to:
- Primary responding officer body-worn camera only (Officer [Name/Badge] if identifiable from incident report)
- 911 call audio
- Incident report (minimal cost)

This focuses on essential documentary footage. Even with this narrowed scope, I request a full public interest fee waiver as legally required.

**If the estimate remains excessive or fee waiver is denied:**
I reserve the right to file an administrative appeal of this fee determination and request review by the [State Attorney General/Public Access Counselor/relevant oversight body]. Case law in [State] establishes that fees exceeding $[reasonable amount] for similar requests are considered barriers to access.

I'm prepared to pay reasonable actual costs, but the current estimate appears to significantly exceed standard rates and statutory limits. Please reconsider the fee waiver and provide the detailed breakdown requested above.`
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

        glomar_ncnd: {
            name: "Glomar / Neither Confirm Nor Deny",
            strategy: `REBUTTAL STRATEGY:
1. Challenge the Glomar response — it's only valid when confirming/denying existence itself would cause harm
2. Argue that the existence of records is already public (incident reported in news, police responded publicly)
3. Request they provide records with redactions rather than a blanket NCND
4. Cite state law requiring specificity in exemption claims
5. Note that Glomar is narrower than most agencies claim — it originates from CIA/national security context
6. Request a Vaughn index or detailed exemption log

TEMPLATE STRUCTURE:
- Challenge applicability of Glomar to this request
- Cite evidence that existence of records is already public
- Request segregable portions with redactions
- Cite state law requirements for specificity
- Note Glomar's narrow legal scope`,

            exampleRebuttal: `Your response neither confirms nor denies the existence of responsive records. However, a Glomar response is only appropriate when the very existence of records would itself cause harm — which is not the case here.

The existence of records is already a matter of public record: [cite public evidence — news coverage, police blotter, court filing, etc.]. Given this, a NCND response is not legally supportable.

Under [State statute], agencies must provide specific legal authority for each exemption claimed. Please either:
1. Provide the requested records with appropriate redactions, or
2. Identify the specific statutory exemption that applies to each category of records and explain why confirming their existence would cause harm

I respectfully request you reconsider this response and provide records with necessary redactions applied.`
        },

        not_reasonably_described: {
            name: "Request Not Reasonably Described",
            strategy: `RESPONSE STRATEGY (cooperative, not combative):
1. Thank them for identifying the issue
2. Provide additional specificity immediately — dates, locations, names, incident numbers
3. Offer to narrow or clarify any ambiguous terms
4. Ask what additional identifiers they need
5. Resubmit with more precise language

TEMPLATE STRUCTURE:
- Acknowledge their concern
- Provide additional identifying information
- Ask what specific identifiers would help
- Offer to discuss by phone if needed
- Resubmit clarified request`,

            exampleRebuttal: `Thank you for your response. I'm happy to provide additional details to help locate these records.

To clarify my request:
- **Incident Date**: [specific date]
- **Location**: [specific address/intersection]
- **Subject**: [name if known]
- **Incident/Case Number**: [if available]
- **Specific Records**: [list each type clearly]

Please let me know if you need any additional identifying information. I'm also available to discuss by phone if that would be more efficient.`
        },

        no_duty_to_create: {
            name: "No Duty to Create Records",
            strategy: `REBUTTAL STRATEGY:
1. Clarify that you're requesting EXISTING records, not new compilations
2. Point out specific record types that must already exist (incident reports, BWC, 911 logs)
3. If the agency claims compiling a list constitutes "creating," argue that organizing existing records is retrieval, not creation
4. Cite state law on reasonable search and retrieval obligations
5. Request they identify which specific records exist vs. don't exist

TEMPLATE STRUCTURE:
- Clarify you're seeking existing records
- Identify specific record types that routinely exist
- Distinguish between retrieval and creation
- Request inventory of what exists`,

            exampleRebuttal: `I understand agencies have no duty to create new records. However, my request is for records that already exist in your systems:

- **Incident/offense reports** are routinely generated for every call for service
- **911/CAD records** are automatically logged
- **Body-worn camera footage** is automatically recorded per department policy
- **Dispatch recordings** are archived per retention schedules

Compiling or retrieving these existing records is not "creating" new records — it is fulfilling a standard records request. Under [State statute], agencies must conduct a reasonable search of existing systems.

Please identify which of the requested record types exist in your systems and provide them accordingly.`
        },

        privilege_attorney_work_product: {
            name: "Attorney-Client Privilege / Work Product",
            strategy: `REBUTTAL STRATEGY:
1. Note that attorney-client privilege is very narrow in public records — only applies to actual legal advice, not factual records
2. Request a privilege log identifying each withheld document, its author, date, and specific privilege claimed
3. Challenge overbroad privilege claims — incident reports, BWC, 911 calls are NOT attorney work product
4. Cite state law requiring segregation of privileged from non-privileged content
5. Note that most factual records related to an incident predate any legal consultation

TEMPLATE STRUCTURE:
- Request detailed privilege log
- Challenge scope of privilege claim
- Identify records that cannot be privileged
- Cite segregability requirements`,

            exampleRebuttal: `Attorney-client privilege and work product doctrine are narrow exceptions that do not apply to routine operational records. The requested records — incident reports, body-worn camera footage, 911 calls, and dispatch logs — are factual records created in the ordinary course of operations, not legal advice or litigation preparation.

Please provide:
1. A detailed privilege log for each withheld record (document description, date, author, specific privilege claimed)
2. All non-privileged records, which include at minimum: incident reports, BWC footage, 911 audio, and CAD/dispatch records

Under [State statute], agencies must segregate privileged material and release all non-privileged portions. A blanket privilege assertion over operational records is not legally supportable.`
        },

        juvenile_records: {
            name: "Juvenile Records Protection",
            strategy: `APPROACH (respectful of legal limits):
1. Acknowledge legitimate juvenile protections
2. Request redacted versions — juvenile identity can be protected while releasing other content
3. Request records of adult officers and responders (not subject to juvenile protections)
4. Request non-identifying records (CAD logs, dispatch, aggregate data)
5. Only escalate to human — don't push hard on juvenile protections

NOTE: This is one of the strongest exemptions. Be cooperative, not combative.`,

            exampleRebuttal: `I understand and respect juvenile privacy protections. I'm willing to accept comprehensive redactions of all juvenile-identifying information.

I request:
1. Body-worn camera footage with juvenile faces, names, and identifiers redacted/blurred
2. Incident reports with juvenile information redacted
3. 911 audio with juvenile identifiers bleeped
4. All records pertaining to adult officers and responders (not subject to juvenile protections)

Juvenile privacy protections require redaction, not blanket withholding. Please provide redacted versions of all requested records.`
        },

        sealed_court_order: {
            name: "Sealed by Court Order",
            strategy: `APPROACH (limited options):
1. Request a copy of or citation to the sealing order (verify it exists and its scope)
2. Determine if the seal covers ALL requested records or just some
3. Request any records NOT covered by the seal
4. Note when the seal expires (if applicable)
5. Escalate to human — court orders must be respected but can sometimes be challenged

NOTE: Court-sealed records are the hardest to obtain. Be respectful and factual.`,

            exampleRebuttal: `I understand a court order may restrict access to some records. To better understand the scope of this restriction, please provide:

1. The case number and court that issued the sealing order
2. The specific records covered by the seal
3. Whether the seal has an expiration date
4. Any records from this incident that are NOT covered by the sealing order

Records not specifically named in the court order remain subject to public records law. Please provide all non-sealed records with appropriate redactions.`
        },

        third_party_confidential: {
            name: "Third-Party Confidential Information",
            strategy: `REBUTTAL STRATEGY:
1. Agree to comprehensive redaction of third-party PII
2. Note that redaction is the remedy, not blanket withholding
3. Cite state law requiring segregation and release of non-confidential portions
4. Offer to pay reasonable redaction costs
5. Identify records that contain no third-party info (CAD logs, dispatch, officer reports)

TEMPLATE STRUCTURE:
- Accept all redactions of third-party information
- Cite segregability requirements
- Identify records with no third-party content
- Offer to pay redaction costs`,

            exampleRebuttal: `I fully consent to redaction of all third-party confidential information, including:
- Names, addresses, and contact information of third parties
- Medical and financial information
- Any other personally identifiable information

Under [State statute], the presence of third-party confidential information requires redaction of that information, not withholding of entire records. Please provide:

1. All requested records with third-party information redacted
2. Records containing no third-party information in full (CAD logs, dispatch audio, officer activity logs)

I'm willing to pay reasonable redaction costs. Please provide an estimate if applicable.`
        },

        records_not_yet_created: {
            name: "Records Not Yet Created / Pending",
            strategy: `RESPONSE STRATEGY:
1. Ask when the records will be available (processing timeline)
2. Request any records that ARE currently available
3. Ask to be notified when records are ready
4. Schedule a follow-up for the expected availability date
5. If records are "pending review" or "in processing," this is not a valid denial

TEMPLATE STRUCTURE:
- Request timeline for availability
- Request any currently available records
- Ask for notification when ready
- Challenge if "pending" is used as denial`,

            exampleRebuttal: `Thank you for advising that these records are not yet available. Please clarify:

1. When do you expect the records to be ready for release?
2. Are any of the requested records currently available? (e.g., incident report, 911 audio, CAD logs may be processed faster than video)
3. Can I be notified when the records are available for release?

Please note that records that exist but are pending administrative processing are still subject to public records law. Under [State statute], agencies must respond within [X days] and cannot indefinitely delay production.

I'll follow up on [expected date] if I haven't heard back.`
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
