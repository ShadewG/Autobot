/**
 * Eval Decision Task
 *
 * Evaluates historical AI decisions against human-verified ground truth.
 * For each eval case: loads the stored proposal, scores it with LLM-as-judge (Claude),
 * and saves results to eval_runs.
 *
 * Does NOT re-run the pipeline — evaluates the actual decision that was made.
 * This is safe (mostly read-only), fast, and reflects real production behavior.
 */

import { task } from "@trigger.dev/sdk/v3";
import { generateObject } from "ai";
import { z } from "zod";
import db, { logger } from "../lib/db";
import { fallbackDraftModel } from "../lib/ai";

const judgeSchema = z.object({
  score: z.number().min(1).max(5).int(),
  reasoning: z.string(),
  failure_category: z
    .enum([
      "WRONG_CLASSIFICATION",
      "WRONG_ROUTING",
      "THRESHOLD_ERROR",
      "DRAFT_QUALITY",
      "POLICY_VIOLATION",
      "CONTEXT_MISSED",
    ])
    .nullable(),
});

async function runJudge(
  evalCase: any,
  proposal: any,
  caseData: any,
  triggerMessage: any,
  latestAnalysis: any
): Promise<{ score: number; reasoning: string; failure_category: string | null }> {
  const requestedRecords = Array.isArray(caseData.requested_records)
    ? caseData.requested_records.join(", ")
    : caseData.requested_records || "Various records";

  const messageSnippet = triggerMessage
    ? `Subject: ${triggerMessage.subject || "N/A"}\nBody: ${(triggerMessage.body_text || "").substring(0, 600)}`
    : "No trigger message";

  const classification = latestAnalysis
    ? `${latestAnalysis.intent} (confidence: ${latestAnalysis.confidence_score}, sentiment: ${latestAnalysis.sentiment})`
    : "Classification not available";

  const reasoning = Array.isArray(proposal.reasoning)
    ? proposal.reasoning.join("\n")
    : JSON.stringify(proposal.reasoning || []);

  const prompt = `You are an expert FOIA case manager evaluating an AI decision.

## Case Context
Agency: ${caseData.agency_name || "Unknown"} (${caseData.state || "Unknown"})
Status before decision: ${caseData.status || "Unknown"}
Records requested: ${requestedRecords}
Fee amount on file: ${caseData.fee_amount != null ? `$${caseData.fee_amount}` : "None"}

## Trigger Message
${messageSnippet}

## AI Classification
${classification}

## AI Decision
Action chosen: **${proposal.action_type}**
AI Reasoning:
${reasoning}

Draft preview:
${(proposal.draft_body_text || "").substring(0, 400) || "(no draft)"}

## Human Ground Truth
Expected action: **${evalCase.expected_action}**
${evalCase.notes ? `Human notes: ${evalCase.notes}` : ""}

## Scoring Instructions
Rate the AI decision quality 1–5:
- **5**: Correct action, excellent reasoning, high-quality draft
- **4**: Correct action, good reasoning, minor issues
- **3**: Correct action but weak reasoning; OR borderline case with understandable wrong choice
- **2**: Wrong action but a reasonable mistake given available context
- **1**: Clearly wrong action, poor reasoning, or dangerous decision

If the action is wrong, categorize the failure:
- **WRONG_CLASSIFICATION**: AI misidentified the message type (e.g., thought fee was denial)
- **WRONG_ROUTING**: Correct classification but chose wrong response action
- **THRESHOLD_ERROR**: Fee/confidence threshold boundary case (borderline auto-approve vs negotiate)
- **DRAFT_QUALITY**: Correct action but draft is poor quality
- **POLICY_VIOLATION**: Violates FOIA best practices or legal requirements
- **CONTEXT_MISSED**: Ignored important case history or prior communications`;

  const { object } = await generateObject({
    model: fallbackDraftModel,
    schema: judgeSchema,
    prompt,
  });

  return {
    score: object.score,
    reasoning: object.reasoning,
    failure_category: object.failure_category,
  };
}

export const evalDecision = task({
  id: "eval-decision",
  maxDuration: 300,
  retry: { maxAttempts: 1 },

  run: async (payload: { evalCaseId?: number; runAll?: boolean }) => {
    // Load eval cases to run
    let evalCases: any[];
    if (payload.evalCaseId) {
      const r = await db.query(
        "SELECT * FROM eval_cases WHERE id = $1 AND is_active = true",
        [payload.evalCaseId]
      );
      evalCases = r.rows;
    } else if (payload.runAll) {
      const r = await db.query(
        "SELECT * FROM eval_cases WHERE is_active = true ORDER BY created_at DESC"
      );
      evalCases = r.rows;
    } else {
      return { error: "Must provide evalCaseId or runAll: true" };
    }

    if (evalCases.length === 0) {
      logger.info("No eval cases found");
      return { totalCases: 0, message: "No eval cases to run" };
    }

    logger.info("Starting eval run", { count: evalCases.length });

    const results: any[] = [];

    for (const evalCase of evalCases) {
      try {
        // Load the stored proposal (AI's actual decision)
        const proposalResult = await db.query(
          "SELECT * FROM proposals WHERE id = $1",
          [evalCase.proposal_id]
        );
        const proposal = proposalResult.rows[0];

        if (!proposal) {
          logger.warn("Eval case has no proposal", { evalCaseId: evalCase.id });
          results.push({ evalCaseId: evalCase.id, error: "Proposal not found", skipped: true });
          continue;
        }

        const predictedAction: string = proposal.action_type;
        const expectedAction: string = evalCase.expected_action;
        const actionCorrect = predictedAction === expectedAction;

        // Load supporting context for the judge
        const caseData = await db.getCaseById(evalCase.case_id);

        const triggerMessage = evalCase.trigger_message_id
          ? await db.getMessageById(evalCase.trigger_message_id)
          : null;

        const latestAnalysis = triggerMessage
          ? await db.getResponseAnalysisByMessageId(triggerMessage.id)
          : null;

        // Run LLM-as-judge
        let judgeScore: number | null = null;
        let judgeReasoning: string | null = null;
        let failureCategory: string | null = null;

        try {
          const judgment = await runJudge(evalCase, proposal, caseData, triggerMessage, latestAnalysis);
          judgeScore = judgment.score;
          judgeReasoning = judgment.reasoning;
          failureCategory = actionCorrect ? null : (judgment.failure_category || "WRONG_ROUTING");
        } catch (judgeErr: any) {
          logger.warn("LLM judge failed", { evalCaseId: evalCase.id, error: judgeErr.message });
          // Still record the result — but flag wrong decisions so they're visible in dashboard
          if (!actionCorrect) {
            failureCategory = "UNKNOWN";
          }
        }

        // Save eval run result
        await db.query(
          `INSERT INTO eval_runs
             (eval_case_id, predicted_action, action_correct, judge_score, judge_reasoning, failure_category, pipeline_output)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            evalCase.id,
            predictedAction,
            actionCorrect,
            judgeScore,
            judgeReasoning,
            failureCategory,
            JSON.stringify({ proposal_id: proposal.id, reasoning: proposal.reasoning }),
          ]
        );

        logger.info("Eval case scored", {
          evalCaseId: evalCase.id,
          predictedAction,
          expectedAction,
          actionCorrect,
          judgeScore,
          failureCategory,
        });

        results.push({
          evalCaseId: evalCase.id,
          predictedAction,
          expectedAction,
          actionCorrect,
          judgeScore,
          failureCategory,
        });
      } catch (err: any) {
        logger.error("Eval case failed", { evalCaseId: evalCase.id, error: err.message });
        results.push({ evalCaseId: evalCase.id, error: err.message });
      }
    }

    // Aggregate stats
    const scoredResults = results.filter((r) => !r.error && !r.skipped);
    const correctCount = scoredResults.filter((r) => r.actionCorrect).length;
    const judgedResults = scoredResults.filter((r) => r.judgeScore != null);
    const avgJudgeScore =
      judgedResults.length > 0
        ? judgedResults.reduce((sum, r) => sum + r.judgeScore, 0) / judgedResults.length
        : null;

    // Failure category breakdown
    const failureBreakdown: Record<string, number> = {};
    for (const r of scoredResults.filter((r) => r.failureCategory)) {
      failureBreakdown[r.failureCategory] = (failureBreakdown[r.failureCategory] || 0) + 1;
    }

    const summary = {
      totalCases: evalCases.length,
      scoredCases: scoredResults.length,
      correctCount,
      passRate: scoredResults.length > 0 ? correctCount / scoredResults.length : 0,
      avgJudgeScore,
      failureBreakdown,
    };

    logger.info("Eval run complete", summary);

    return { ...summary, results };
  },
});
