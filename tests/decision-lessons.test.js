const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Decision lesson injection', function () {
  it('formats relevant lessons for the decision prompt and tags them as decision-phase lessons', function () {
    const cwd = path.resolve(__dirname, '..');
    const script = `
      (async () => {
        const decisionMemoryService = (await import("./services/decision-memory-service.js")).default;
        const decisionStepModule = await import("./trigger/steps/decide-next-action.ts");
        const getDecisionLessons =
          decisionStepModule.getDecisionLessons
          || decisionStepModule.default?.getDecisionLessons
          || decisionStepModule["module.exports"]?.getDecisionLessons;

        decisionMemoryService.getRelevantLessons = async () => ([{
          id: 11,
          category: "general",
          trigger_pattern: "dismissed SEND_REBUTTAL for Synthetic Records Unit",
          lesson: "Prefer clarification over rebuttal for this agency when they request identifiers.",
          relevance_score: 3,
          priority: 7,
          source: "auto",
        }]);
        decisionMemoryService.formatLessonsForPrompt = () => "\\nLESSONS FROM EXPERIENCE (follow these strictly):\\n1. [GENERAL] Test lesson\\n";

        const result = await getDecisionLessons(
          902,
          { agency_name: "Synthetic Records Unit", status: "needs_human_review" },
          [{ id: 1, direction: "inbound", body_text: "Need a case number before processing." }],
          [{ action_type: "SEND_REBUTTAL", status: "DISMISSED" }],
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

    assert.match(result.lessonsContext, /LESSONS FROM EXPERIENCE/);
    assert.strictEqual(result.lessonsApplied.length, 1);
    assert.deepStrictEqual(result.lessonsApplied[0], {
      id: 11,
      category: 'general',
      trigger: 'dismissed SEND_REBUTTAL for Synthetic Records Unit',
      lesson: 'Prefer clarification over rebuttal for this agency when they request identifiers.',
      score: 3,
      priority: 7,
      source: 'auto',
      phase: 'decision',
    });
  });
});
