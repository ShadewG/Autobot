const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Portal failure learning helpers', function () {
  it('recommends email fallback when a portal fails and email is available', function () {
    const cwd = path.resolve(__dirname, '..');
    const script = `
      (async () => {
        const submitPortalModule = await import("./trigger/tasks/submit-portal.ts");
        const buildPortalFailureLesson =
          submitPortalModule.buildPortalFailureLesson
          || submitPortalModule.default?.buildPortalFailureLesson
          || submitPortalModule["module.exports"]?.buildPortalFailureLesson;
        const result = buildPortalFailureLesson(
          {
            id: 1001,
            agency_name: "Synthetic Police Department",
            agency_email: "records@example.gov",
            portal_provider: "GovQA",
          },
          "GovQA",
          "Portal submission rejected by blocked-words spam filter"
        );
        console.log(JSON.stringify(result));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    const stdout = execFileSync('npx', ['tsx', '-e', script], {
      cwd,
      encoding: 'utf8',
    });
    const lines = stdout.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1]);

    assert.strictEqual(result.category, 'portal');
    assert.strictEqual(result.priority, 8);
    assert.strictEqual(result.triggerPattern, 'portal failed for Synthetic Police Department via GovQA (blocked_words)');
    assert.match(result.lesson, /Prefer email instead of retrying the same portal path/);
  });

  it('recommends manual handling when no email fallback exists', function () {
    const cwd = path.resolve(__dirname, '..');
    const script = `
      (async () => {
        const submitPortalModule = await import("./trigger/tasks/submit-portal.ts");
        const buildPortalFailureLesson =
          submitPortalModule.buildPortalFailureLesson
          || submitPortalModule.default?.buildPortalFailureLesson
          || submitPortalModule["module.exports"]?.buildPortalFailureLesson;
        const result = buildPortalFailureLesson(
          {
            id: 1002,
            agency_name: "Synthetic Sheriff Office",
            agency_email: null,
            alternate_agency_email: null,
            portal_provider: "NextRequest",
          },
          "NextRequest",
          "Task timed out after deadline exceeded"
        );
        console.log(JSON.stringify(result));
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;

    const stdout = execFileSync('npx', ['tsx', '-e', script], {
      cwd,
      encoding: 'utf8',
    });
    const lines = stdout.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1]);

    assert.strictEqual(result.triggerPattern, 'portal failed for Synthetic Sheriff Office via NextRequest (timeout)');
    assert.match(result.lesson, /Prefer manual portal handling instead of retrying the same portal path/);
  });
});
