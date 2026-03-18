const assert = require('assert');
const sinon = require('sinon');
const portalPlaywright = require('../services/portal-agent-service-playwright');

describe('portal-agent-service-playwright helpers', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('normalizes portal providers from mixed labels and URLs', function () {
    assert.strictEqual(portalPlaywright.normalizeProviderName('JustFOIA', null), 'justfoia');
    assert.strictEqual(portalPlaywright.normalizeProviderName('GovQA', null), 'govqa');
    assert.strictEqual(portalPlaywright.normalizeProviderName('Auto-detected', 'https://cityofbuffalony.nextrequest.com/'), 'nextrequest');
    assert.strictEqual(portalPlaywright.normalizeProviderName('Form Center (custom city form)', null), 'formcenter');
  });

  it('resolves browser backend selection from explicit and automatic modes', function () {
    assert.strictEqual(portalPlaywright.normalizeBrowserBackend('browserbase'), 'browserbase');
    assert.strictEqual(portalPlaywright.normalizeBrowserBackend('local'), 'local');
    assert.strictEqual(portalPlaywright.normalizeBrowserBackend(''), 'auto');

    // Default is now 'local' — Browserbase is the fallback
    assert.strictEqual(
      portalPlaywright.resolveBrowserBackendSelection('auto', true),
      'local'
    );
    assert.strictEqual(
      portalPlaywright.resolveBrowserBackendSelection('auto', false),
      'local'
    );
    assert.strictEqual(
      portalPlaywright.resolveBrowserBackendSelection('browserbase', false),
      'browserbase'
    );
  });

  it('builds Browserbase launch settings with safe defaults for the current plan', function () {
    const launchOptions = portalPlaywright.buildBrowserbaseLaunchOptions({
      projectId: 'proj_123',
      region: 'us-east-1',
      timeoutMs: 45000,
      advancedStealth: false,
      solveCaptchas: true,
      proxies: true,
      keepAlive: false,
      blockAds: false,
      os: '',
      caseId: 25150,
      provider: 'formcenter',
      label: 'South St. Paul Police Department',
    });

    assert.strictEqual(launchOptions.projectId, 'proj_123');
    assert.strictEqual(launchOptions.region, 'us-east-1');
    assert.strictEqual(launchOptions.timeout, 75);
    assert.strictEqual(launchOptions.proxies, true);
    assert.strictEqual(launchOptions.browserSettings.advancedStealth, false);
    assert.strictEqual(launchOptions.browserSettings.solveCaptchas, true);
    assert.strictEqual(launchOptions.browserSettings.os, 'linux');
    assert.strictEqual(launchOptions.userMetadata.caseId, '25150');
    assert.strictEqual(launchOptions.userMetadata.provider, 'formcenter');
  });

  it('attaches Browserbase auth contexts and persistence when provided', function () {
    const launchOptions = portalPlaywright.buildBrowserbaseLaunchOptions({
      projectId: 'proj_123',
      provider: 'nextrequest',
      caseId: 25481,
      contextId: 'ctx_abc123',
      persistContext: true,
      keepAlive: true,
    });

    assert.deepStrictEqual(launchOptions.browserSettings.context, {
      id: 'ctx_abc123',
      persist: true,
    });
    assert.strictEqual(launchOptions.keepAlive, true);
  });

  it('builds Browserbase cost policy for auth-capable providers', function () {
    const policy = portalPlaywright.buildBrowserbaseCostPolicy({
      provider: 'nextrequest',
      portalUrl: 'https://raleighnc.nextrequest.com/requests/new',
      mode: 'submit',
      keepAlive: false,
      solveCaptchas: true,
    });

    assert.strictEqual(policy.provider, 'nextrequest');
    assert.strictEqual(policy.useAuthContext, true);
    assert.strictEqual(policy.persistContext, true);
    assert.strictEqual(policy.keepAlive, true);
    assert.strictEqual(policy.solveCaptchas, true);
  });

  it('builds Browserbase cost policy that blocks low-value assets for cheap formcenter runs', function () {
    const policy = portalPlaywright.buildBrowserbaseCostPolicy({
      provider: 'formcenter',
      portalUrl: 'https://southstpaulmn.gov/FormCenter/Police-8',
      mode: 'submit',
      keepAlive: false,
    });

    assert.deepStrictEqual(policy.blockResourceTypes, ['image', 'media', 'font']);
    assert.strictEqual(policy.useAuthContext, false);
    assert.strictEqual(policy.keepAlive, false);
  });

  it('recognizes Browserbase quota exhaustion errors distinctly from portal failures', function () {
    assert.strictEqual(
      portalPlaywright.isBrowserbaseQuotaErrorMessage('402 Free plan browser minutes limit reached. Please upgrade your account.'),
      true
    );
    assert.strictEqual(
      portalPlaywright.isBrowserbaseQuotaErrorMessage('Low on credits: You have 140 credits remaining.'),
      true
    );
    assert.strictEqual(
      portalPlaywright.isBrowserbaseQuotaErrorMessage('submit_button_not_found'),
      false
    );
  });

  it('scores GovQA request links toward the matching agency', function () {
    const policeScore = portalPlaywright.scoreGovQaRequestLink(
      'Lubbock Police Department, Texas',
      'Lubbock Police Department Open Records Request'
    );
    const fireScore = portalPlaywright.scoreGovQaRequestLink(
      'Lubbock Police Department, Texas',
      'Lubbock Fire Open Records Request'
    );

    assert.ok(policeScore > fireScore);
  });

  it('allows provider-known URLs even when the generic portal filter would reject them', function () {
    assert.strictEqual(
      portalPlaywright.isSupportedPlaywrightUrl(
        'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
        'govqa',
        'Submission completed (completed)'
      ),
      true
    );
  });

  it('blocks generic JustFOIA root URLs from Browserbase automation', function () {
    assert.strictEqual(
      portalPlaywright.isSupportedPlaywrightUrl(
        'https://request.justfoia.com/',
        'justfoia',
        null
      ),
      false
    );
  });

  it('prefers the public-records launch form on JustFOIA landing pages', function () {
    const publicRecords = portalPlaywright.scoreJustFoiaLaunchLink(
      'Public Records Request Make a Public Records Request Pursuant to Florida’s Public Records Law'
    );
    const backgroundCheck = portalPlaywright.scoreJustFoiaLaunchLink(
      'Local Background Check Local Criminal Records Check or Letter of Good Standing'
    );

    assert.ok(publicRecords > backgroundCheck);
  });

  it('detects anchor-based submit controls used by FormCenter pages', function () {
    const ranked = portalPlaywright.scoreSubmitControlCandidates([
      {
        index: 0,
        tag: 'a',
        text: 'Submit',
        id: 'btnFormSubmit',
        name: '',
        ariaLabel: '',
        className: 'modern-button',
        visible: true,
        disabled: false,
      },
      {
        index: 1,
        tag: 'a',
        text: '',
        id: 'btnSearchIcon',
        name: '',
        ariaLabel: 'Search',
        className: 'widgetSearchButton',
        visible: true,
        disabled: false,
      },
    ]);

    assert.strictEqual(ranked[0].id, 'btnFormSubmit');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('flags visible captcha fields for Skyvern fallback', function () {
    assert.strictEqual(
      portalPlaywright.isCaptchaLikeField({
        label: 'Captcha',
        placeholder: 'Type the characters shown',
        ariaLabel: '',
        name: 'captcha',
        id: 'captchaInput',
      }),
      true
    );

    assert.strictEqual(
      portalPlaywright.isCaptchaLikeField({
        label: 'Other information and or requests.',
        placeholder: 'What other information are you looking for.',
        ariaLabel: '',
        name: 'fields[18].Value',
        id: 'e_24',
      }),
      false
    );
  });

  it('recognizes auth intervention blocker states for Browserbase handoff', function () {
    assert.strictEqual(portalPlaywright.isBrowserbaseAuthInterventionState('auth_intervention_required'), true);
    assert.strictEqual(portalPlaywright.isBrowserbaseAuthInterventionState('totp_required'), true);
    assert.strictEqual(portalPlaywright.isBrowserbaseAuthInterventionState('request_form_public'), false);
  });

  it('maps common request form labels to requester and case values', function () {
    const caseData = {
      case_name: 'Test homicide case',
      subject_name: 'John Doe',
      incident_date: '2025-01-15',
      incident_location: '123 Main St',
      requested_records: ['Police report', 'Body camera footage'],
      additional_details: 'Need any supplements and related media.',
    };
    const requester = {
      name: 'Samuel Hylton',
      firstName: 'Samuel',
      lastName: 'Hylton',
      email: 'sam@example.com',
      phone: '555-0100',
      address: '3021 21st Ave W',
      addressLine2: 'Apt 202',
      city: 'Seattle',
      state: 'WA',
      zip: '98199',
      organization: 'FOIB',
      title: 'Reporter',
    };

    assert.strictEqual(
      portalPlaywright.mapFieldValue({ label: 'First Name', type: 'text', tag: 'input' }, { caseData, requester, portalAccount: null, pageKind: 'request_form' }),
      'Samuel'
    );
    assert.strictEqual(
      portalPlaywright.mapFieldValue({ label: 'Name', name: 'name', type: 'text', tag: 'input' }, { caseData, requester, portalAccount: null, pageKind: 'request_form' }),
      'Samuel Hylton'
    );
    assert.strictEqual(
      portalPlaywright.mapFieldValue({ label: 'Email Address', type: 'email', tag: 'input' }, { caseData, requester, portalAccount: null, pageKind: 'request_form' }),
      'sam@example.com'
    );
    assert.strictEqual(
      portalPlaywright.mapFieldValue({ label: 'Person or Persons Involved', type: 'text', tag: 'input' }, { caseData, requester, portalAccount: null, pageKind: 'request_form' }),
      'John Doe'
    );

    const description = portalPlaywright.mapFieldValue(
      { label: 'Other information and or requests.', type: 'textarea', tag: 'textarea' },
      { caseData, requester, portalAccount: null, pageKind: 'request_form' }
    );

    assert.match(description, /Police report/);
    assert.match(description, /John Doe/);
    assert.match(description, /123 Main St/);

    assert.strictEqual(
      portalPlaywright.mapFieldValue({ label: 'Audio Statements', type: 'text', tag: 'input' }, { caseData, requester, portalAccount: null, pageKind: 'request_form' }),
      'Requested if available'
    );
  });

  it('builds account credentials from requester or stored portal account state', function () {
    const requester = {
      name: 'Samuel Hylton',
      firstName: 'Samuel',
      lastName: 'Hylton',
      email: 'sam@example.com',
    };

    const requesterDerived = portalPlaywright.buildPortalCredentialProfile(requester, null);
    assert.strictEqual(requesterDerived.email, 'sam@example.com');
    assert.strictEqual(requesterDerived.firstName, 'Samuel');
    assert.ok(requesterDerived.password);

    const storedAccount = portalPlaywright.buildPortalCredentialProfile(requester, {
      email: 'requests@foib-request.com',
      password: 'hunter2',
      first_name: 'Portal',
      last_name: 'Account',
    });
    assert.strictEqual(storedAccount.email, 'requests@foib-request.com');
    assert.strictEqual(storedAccount.password, 'hunter2');
    assert.strictEqual(storedAccount.firstName, 'Portal');
    assert.strictEqual(storedAccount.lastName, 'Account');
  });

  it('builds provider action URLs and classifies NextRequest magic links', function () {
    assert.strictEqual(
      portalPlaywright.buildPortalActionUrl('https://raleighnc.nextrequest.com/requests/new', '/users/sign_in'),
      'https://raleighnc.nextrequest.com/users/sign_in'
    );
    assert.strictEqual(
      portalPlaywright.inferNextRequestLinkKind('https://raleighnc.nextrequest.com/users/unlock?unlock_token=abc'),
      'unlock'
    );
    assert.strictEqual(
      portalPlaywright.inferNextRequestLinkKind('https://raleighnc.nextrequest.com/users/confirmation?confirmation_token=abc'),
      'confirmation'
    );
  });

  it('retrieves a verification code and enters it back into the portal field', async function () {
    class FakeLocator {
      constructor({ visible = true } = {}) {
        this.visible = visible;
        this.filledValue = null;
        this.clicked = 0;
        this.pressed = [];
      }

      first() {
        return this;
      }

      async count() {
        return this.visible ? 1 : 0;
      }

      async isVisible() {
        return this.visible;
      }

      async fill(value) {
        this.filledValue = value;
      }

      async click() {
        this.clicked += 1;
      }

      async press(key) {
        this.pressed.push(key);
      }
    }

    const codeField = new FakeLocator();
    const verifyButton = new FakeLocator();
    const emptyLocator = new FakeLocator({ visible: false });

    const fakePage = {
      getByLabel(regex) {
        return /verification code/i.test(String(regex)) ? codeField : emptyLocator;
      },
      locator() {
        return emptyLocator;
      },
      getByRole(role, options = {}) {
        return role === 'button' && /verify/i.test(String(options.name || ''))
          ? verifyButton
          : emptyLocator;
      },
      waitForLoadState() {
        return Promise.resolve();
      },
    };

    const service = new portalPlaywright.PortalAgentServicePlaywright({
      browserBackend: 'local',
    });

    const originalWaitForCode = service._waitForPortalVerificationCode.bind(service);
    service._waitForPortalVerificationCode = async function () {
      return {
        success: true,
        code: '654321',
        inboxAddress: 'requests@foib-request.com',
        fromEmail: 'no-reply@portal.example.com',
      };
    };

    try {
      const result = await service._attemptPortalEmailCodeVerification(
        fakePage,
        'https://portal.example.com/users/sign_in',
        'requests@foib-request.com',
        { provider: 'nextrequest', fromEmailHints: ['portal.example.com'] }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.codeInbox, 'requests@foib-request.com');
      assert.strictEqual(result.codeSender, 'no-reply@portal.example.com');
      assert.strictEqual(codeField.filledValue, '654321');
      assert.strictEqual(verifyButton.clicked, 1);
    } finally {
      service._waitForPortalVerificationCode = originalWaitForCode;
    }
  });

  it('forwards explicit dryRun=false into the real submission path', async function () {
    const runStub = sinon.stub(portalPlaywright, '_runPortal').resolves({ success: true });

    await portalPlaywright.submitToPortal({ id: 25150 }, 'https://example.gov/request', {
      dryRun: false,
    });

    sinon.assert.calledOnce(runStub);
    assert.strictEqual(runStub.firstCall.args[2].dryRun, false);
    assert.strictEqual(runStub.firstCall.args[2].mode, 'submit');
  });

  it('builds requester profiles from the assigned user identity first', function () {
    const requester = portalPlaywright.buildRequesterProfile(
      {
        requester_name: 'Wrong Fallback',
        requester_email: 'wrong@example.com',
      },
      {
        name: 'Samuel Hylton',
        email: 'samuel@foib-request.com',
        signature_name: 'Samuel Hylton',
        signature_phone: '209-800-7702',
        signature_title: 'Reporter',
        signature_organization: 'FOIB',
      }
    );

    assert.strictEqual(requester.name, 'Samuel Hylton');
    assert.strictEqual(requester.email, 'samuel@foib-request.com');
    assert.strictEqual(requester.firstName, 'Samuel');
    assert.strictEqual(requester.lastName, 'Hylton');
    assert.strictEqual(requester.organization, 'FOIB');
  });
});
