const assert = require('assert');

const {
  extractMetadataAgencyHint,
  extractMetadataCityHint,
  extractAgencyNameFromAdditionalDetails,
  detectCaseMetadataAgencyMismatch,
  detectAgencyCityMismatch,
  evaluateImportAutoDispatchSafety,
  hasCompoundAgencyIdentity,
  isGenericAgencyLabel,
  isPlaceholderCaseTitle,
  pickSafeSubjectDescriptor,
} = require('../utils/request-normalization');

describe('request normalization helpers', function () {
  it('extracts an explicit police department from additional details', function () {
    const hint = extractMetadataAgencyHint(`
**Case Summary:** Example
**Police Department:** Gwinnett County Police Department, Georgia
`);

    assert.deepStrictEqual(hint, {
      name: 'Gwinnett County Police Department, Georgia',
      state: 'GA',
      source: 'additional_details',
    });
  });

  it('extracts a city hint from additional details metadata', function () {
    const hint = extractMetadataCityHint(`
**Case Summary:** Example
City : Princeton
`);

    assert.deepStrictEqual(hint, {
      name: 'Princeton',
      source: 'additional_details',
    });
  });

  it('detects a wrong-agency mismatch when metadata names a different jurisdiction', function () {
    const mismatch = detectCaseMetadataAgencyMismatch({
      currentAgencyName: 'Lubbock Police Department, Texas',
      additionalDetails: `
**Case Summary:** Example
**Police Department:** Gwinnett County Police Department, Georgia
`,
    });

    assert.deepStrictEqual(mismatch, {
      expectedAgencyName: 'Gwinnett County Police Department, Georgia',
      expectedState: 'GA',
      currentAgencyName: 'Lubbock Police Department, Texas',
      source: 'additional_details',
    });
  });

  it('does not flag a mismatch when metadata names the same agency', function () {
    const mismatch = detectCaseMetadataAgencyMismatch({
      currentAgencyName: 'Lubbock Police Department, Texas',
      additionalDetails: `
**Case Summary:** Example
**Police Department:** Lubbock Police Department, Texas
`,
    });

    assert.strictEqual(mismatch, null);
  });

  it('detects a police-department city mismatch when metadata city conflicts with the routed department city', function () {
    const mismatch = detectAgencyCityMismatch({
      currentAgencyName: 'Westbrook Police Department',
      additionalDetails: `
**Case Summary:** Example
City : Princeton
`,
    });

    assert.deepStrictEqual(mismatch, {
      currentAgencyName: 'Westbrook Police Department',
      expectedCity: 'Princeton',
      source: 'additional_details',
    });
  });

  it('treats a generic agency label as a mismatch when metadata names the real department', function () {
    const mismatch = detectCaseMetadataAgencyMismatch({
      currentAgencyName: 'Police Department',
      additionalDetails: `
**Case Summary:** Example
**Police Department:** Gwinnett County Police Department, Georgia
`,
    });

    assert.deepStrictEqual(mismatch, {
      expectedAgencyName: 'Gwinnett County Police Department, Georgia',
      expectedState: 'GA',
      currentAgencyName: 'Police Department',
      source: 'additional_details',
    });
  });

  it('recognizes generic placeholder agency labels', function () {
    assert.strictEqual(isGenericAgencyLabel('Police Department'), true);
    assert.strictEqual(isGenericAgencyLabel('Unknown agency'), true);
    assert.strictEqual(isGenericAgencyLabel('Gwinnett County Police Department, Georgia'), false);
  });

  it('recognizes an unscoped multi-agency import blob', function () {
    assert.strictEqual(
      hasCompoundAgencyIdentity("Vanderburgh County Prosecutor’s Office, Evansville Police Department, Vanderburgh County Sheriff’s Office"),
      true
    );
    assert.strictEqual(hasCompoundAgencyIdentity('Grand Rapids Police Department'), false);
  });

  it('treats nbsp and untitled values as placeholder case titles', function () {
    assert.strictEqual(isPlaceholderCaseTitle('&nbsp;'), true);
    assert.strictEqual(isPlaceholderCaseTitle('Untitled Case'), true);
    assert.strictEqual(isPlaceholderCaseTitle('Ryan Campbell'), false);
  });

  it('picks a safe draft subject descriptor when imported subject fields are placeholder text', function () {
    assert.strictEqual(
      pickSafeSubjectDescriptor('&nbsp;', 'Untitled Case', 'Body camera footage'),
      'Body camera footage'
    );
  });

  it('blocks auto-dispatch when imported metadata names a different department', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Denver case',
      subjectName: 'Ryan Campbell',
      agencyName: 'Police Department',
      agencyEmail: 'orr@mylubbock.us',
      portalUrl: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      additionalDetails: '**Police Department:** Denver Police Department, Colorado',
      importWarnings: [],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'AGENCY_METADATA_MISMATCH');
    assert.strictEqual(result.metadataMismatch.expectedAgencyName, 'Denver Police Department, Colorado');
  });

  it('allows auto-dispatch when imported subject is real and agency metadata matches', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Untitled Case',
      subjectName: 'Ryan Campbell',
      agencyName: 'Denver Police Department, Colorado',
      state: 'CO',
      agencyEmail: 'records@denvergov.org',
      portalUrl: null,
      additionalDetails: '**Police Department:** Denver Police Department, Colorado',
      importWarnings: [],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, false);
  });

  it('blocks auto-dispatch when routed agency state conflicts with the case state', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      subjectName: 'Jose Sandoval-Romero',
      agencyName: 'Lubbock Police Department, Texas',
      state: 'CO',
      agencyEmail: 'orr@mylubbock.us',
      portalUrl: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      additionalDetails: 'Title: Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      importWarnings: [],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'AGENCY_STATE_MISMATCH');
    assert.deepStrictEqual(result.agencyStateMismatch, {
      currentAgencyName: 'Lubbock Police Department, Texas',
      agencyState: 'TX',
      caseState: 'CO',
      source: 'case_state',
    });
  });

  it('blocks auto-dispatch when import warnings flag a generic agency identity', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Kyneddi Miller records request',
      subjectName: 'Kyneddi Miller',
      agencyName: 'Police Department',
      state: 'WV',
      agencyEmail: 'orr@mylubbock.us',
      portalUrl: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      additionalDetails: '',
      importWarnings: [{ type: 'GENERIC_AGENCY_IDENTITY' }],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'GENERIC_AGENCY_IDENTITY');
  });

  it('does not block auto-dispatch when only a secondary-agency state mismatch warning is present', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Pennsylvania homicide records request',
      subjectName: 'Jennifer Brown',
      agencyName: 'Pennsylvania State Police',
      state: 'PA',
      agencyEmail: 'ra-crrtip@pa.gov',
      portalUrl: 'https://rtklsp.nextrequest.com/requests/new',
      additionalDetails: [
        '### Police Departments Involved',
        '- **Pennsylvania State Police:** Primary investigating agency.',
        '- **Ohio State Highway Patrol:** Assisted at the scene.',
      ].join('\n'),
      importWarnings: [{ type: 'ADDITIONAL_AGENCY_STATE_MISMATCH' }],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, false);
    assert.strictEqual(result.reasonCode, null);
  });

  it('blocks auto-dispatch when metadata city conflicts with a routed police department', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Princeton Dad Sentenced To Life',
      subjectName: 'Kevin Dixon',
      agencyName: 'Westbrook Police Department',
      state: 'TX',
      agencyEmail: null,
      portalUrl: 'https://www.princetontx.gov/296/Submit-an-Open-Records-Request',
      additionalDetails: 'City : Princeton',
      importWarnings: [],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'AGENCY_CITY_MISMATCH');
    assert.deepStrictEqual(result.agencyCityMismatch, {
      currentAgencyName: 'Westbrook Police Department',
      expectedCity: 'Princeton',
      source: 'additional_details',
    });
  });

  it('does not block on city metadata when the narrative explicitly names the routed agency', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Jason Chen',
      subjectName: 'Jasmine Pace',
      agencyName: 'Chattanooga Police Department, Tennessee',
      state: 'TN',
      agencyEmail: null,
      portalUrl: 'https://chattanoogatn.mycusthelp.com/public-records',
      additionalDetails: [
        'City : Nolensville',
        '',
        '### Police Departments Involved',
        '- **Chattanooga Police Department:** Handled the initial investigation and arrest.',
      ].join('\n'),
      importWarnings: [],
    });

    assert.strictEqual(result.agencyCityMismatch, null);
    assert.strictEqual(result.shouldBlockAutoDispatch, false);
  });

  it('ignores raw Notion relation ids in metadata agency hints', function () {
    const hint = extractMetadataAgencyHint(`
**Case Summary:** Example
**Police Department:** 20987c20-070a-8183-b16b-d52aba959eb7, 24587c20-070a-8046-b4d8-fdef0dd2713f
`);

    assert.strictEqual(hint, null);
  });

  it('extracts a concrete agency from Police Departments Involved bullet lines', function () {
    const agency = extractAgencyNameFromAdditionalDetails(`
### Police Departments Involved
- **Chattanooga Police Department:** Handled the initial investigation, crime scene processing, and arrest.
- **Tennessee Bureau of Investigation:** Assisted with forensic analysis.
`);

    assert.strictEqual(agency, 'Chattanooga Police Department');
  });

  it('prefers the primary investigating agency from multi-agency law-enforcement bullets', function () {
    const agency = extractAgencyNameFromAdditionalDetails(`
### LAW ENFORCEMENT INVOLVEMENT
- **Pennsylvania State Police:** Served as the primary investigating agency for the homicide, conducted the initial welfare check, and filed charges against the suspect.
- **Ohio State Highway Patrol:** Apprehended the suspect during a traffic stop in Ohio.
- **Adams County Coroner’s Office:** Performed the autopsy on the victim.
`);

    assert.strictEqual(agency, 'Pennsylvania State Police');
  });

  it('blocks auto-dispatch when import warnings flag a duplicate case', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Charles Miles Sentenced to Prison in 2024 Beating Death Case',
      subjectName: 'Charles Ethan Miles',
      agencyName: 'Evansville Police Department',
      state: 'IN',
      agencyEmail: 'records@example.gov',
      portalUrl: null,
      additionalDetails: '',
      importWarnings: [{ type: 'POSSIBLE_DUPLICATE_CASE' }],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'POSSIBLE_DUPLICATE_CASE');
  });

  it('blocks auto-dispatch when agency field contains multiple agencies without scoping', function () {
    const result = evaluateImportAutoDispatchSafety({
      caseName: 'Charles Miles Sentenced to Prison in 2024 Beating Death Case',
      subjectName: 'Charles Ethan Miles',
      agencyName: "Vanderburgh County Prosecutor’s Office, Evansville Police Department, Vanderburgh County Sheriff’s Office",
      state: 'IN',
      agencyEmail: 'prosecutorinfo@vanderburghgov.org',
      portalUrl: 'https://vanderburghsheriff.org/public-records/',
      additionalDetails: '',
      importWarnings: [{ type: 'MULTI_AGENCY_UNSCOPED' }],
    });

    assert.strictEqual(result.shouldBlockAutoDispatch, true);
    assert.strictEqual(result.reasonCode, 'MULTI_AGENCY_UNSCOPED');
  });
});
