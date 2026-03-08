const db = require('./database');

/**
 * Adaptive Learning Service for FOIA Requests
 *
 * This service implements a reinforcement learning approach:
 * 1. Generate variations of request strategies
 * 2. Track which strategies get positive/negative responses
 * 3. Learn patterns and optimize future requests
 */
class AdaptiveLearningService {
    constructor() {
        // Strategy categories we can vary
        this.strategicDimensions = {
            tone: ['collaborative', 'assertive', 'formal', 'urgent'],
            emphasis: ['legal_pressure', 'public_interest', 'documentary', 'transparency'],
            detail_level: ['minimal', 'moderate', 'comprehensive'],
            legal_citations: ['few', 'moderate', 'extensive'],
            fee_waiver_approach: ['none', 'brief', 'detailed'],
            urgency_level: ['none', 'moderate', 'high']
        };

        // Outcome weights (how we score responses)
        this.outcomeWeights = {
            'full_approval': 10,        // Got everything requested
            'partial_approval': 5,      // Got some records
            'quick_response': 3,        // Responded within deadline
            'fee_waived': 2,           // Fee waiver granted
            'no_response': -5,         // No response (negative)
            'denial': -3,              // Denied (but at least responded)
            'partial_denial': 0,       // Mixed result
            'slow_response': -1        // Slow but eventual response
        };
    }

    /**
     * Generate a variation of the request based on learned patterns
     */
    async generateStrategicVariation(caseData, baseStrategy = null) {
        // If no base strategy, start with defaults
        if (!baseStrategy) {
            baseStrategy = {
                tone: 'collaborative',
                emphasis: 'documentary',
                detail_level: 'moderate',
                legal_citations: 'moderate',
                fee_waiver_approach: 'brief',
                urgency_level: 'moderate'
            };
        }

        // Get successful patterns for this agency/state
        const learnedPatterns = await this.getLearnedPatterns(
            caseData.agency_name,
            caseData.state
        );

        // If we have learned patterns, use them
        if (learnedPatterns && learnedPatterns.best_strategy) {
            console.log(`Using learned strategy for ${caseData.agency_name}:`, learnedPatterns.best_strategy);
            return learnedPatterns.best_strategy;
        }

        // Otherwise, generate a variation to explore
        return this.exploreNewStrategy(baseStrategy);
    }

    /**
     * Explore a new strategy variation (A/B testing)
     */
    exploreNewStrategy(baseStrategy) {
        const variation = { ...baseStrategy };

        // Randomly vary 1-2 dimensions to explore
        const dimensionsToVary = Math.random() > 0.5 ? 1 : 2;
        const dimensions = Object.keys(this.strategicDimensions);

        for (let i = 0; i < dimensionsToVary; i++) {
            const randomDimension = dimensions[Math.floor(Math.random() * dimensions.length)];
            const options = this.strategicDimensions[randomDimension];
            variation[randomDimension] = options[Math.floor(Math.random() * options.length)];
        }

        console.log('Exploring new strategy variation:', variation);
        return variation;
    }

    /**
     * Get learned patterns for an agency/state
     */
    async getLearnedPatterns(agencyName, state) {
        try {
            // Query database for successful strategies
            const query = `
                SELECT
                    strategy_config,
                    AVG(outcome_score) as avg_score,
                    COUNT(*) as sample_size
                FROM foia_strategy_outcomes
                WHERE (agency_name = $1 OR state = $2)
                  AND outcome_score > 0
                GROUP BY strategy_config
                HAVING COUNT(*) >= 3  -- Need at least 3 samples
                ORDER BY avg_score DESC
                LIMIT 1
            `;

            const result = await db.query(query, [agencyName, state]);

            if (result.rows.length > 0) {
                return {
                    best_strategy: result.rows[0].strategy_config,
                    avg_score: result.rows[0].avg_score,
                    sample_size: result.rows[0].sample_size
                };
            }

            return null;
        } catch (error) {
            console.error('Error getting learned patterns:', error);
            return null;
        }
    }

    /**
     * Record the outcome of a strategy
     */
    async recordOutcome(caseId, strategy, outcome) {
        try {
            const caseData = await db.getCaseById(caseId);
            if (!caseData) return;

            // Calculate outcome score
            const score = this.calculateOutcomeScore(outcome);

            // Store in database
            await db.query(`
                INSERT INTO foia_strategy_outcomes (
                    case_id,
                    agency_name,
                    state,
                    strategy_config,
                    outcome_type,
                    outcome_score,
                    response_time_days,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            `, [
                caseId,
                caseData.agency_name,
                caseData.state,
                strategy,
                outcome.type,
                score,
                outcome.response_time_days || null
            ]);

            console.log(`Recorded outcome for case ${caseId}: ${outcome.type} (score: ${score})`);

            // Trigger learning update
            await this.updateLearningModel(caseData.agency_name, caseData.state);
        } catch (error) {
            console.error('Error recording outcome:', error);
        }
    }

    /**
     * Calculate outcome score based on response
     */
    calculateOutcomeScore(outcome) {
        let score = 0;

        // Base score from outcome type
        score += this.outcomeWeights[outcome.type] || 0;

        // Bonus for quick response
        if (outcome.response_time_days && outcome.response_time_days <= 10) {
            score += this.outcomeWeights['quick_response'];
        } else if (outcome.response_time_days && outcome.response_time_days > 30) {
            score += this.outcomeWeights['slow_response'];
        }

        // Bonus if fee was waived
        if (outcome.fee_waived) {
            score += this.outcomeWeights['fee_waived'];
        }

        return score;
    }

    /**
     * Update learning model with new data
     */
    async updateLearningModel(agencyName, state) {
        try {
            // Get all outcomes for this agency/state
            const outcomes = await db.query(`
                SELECT
                    strategy_config,
                    outcome_score,
                    created_at
                FROM foia_strategy_outcomes
                WHERE agency_name = $1 OR state = $2
                ORDER BY created_at DESC
                LIMIT 100
            `, [agencyName, state]);

            if (outcomes.rows.length < 5) {
                console.log('Not enough data to update learning model yet');
                return;
            }

            // Analyze which strategies are working
            const strategyPerformance = this.analyzeStrategyPerformance(outcomes.rows);

            // Store insights
            await this.storeInsights(agencyName, state, strategyPerformance);

            console.log(`Updated learning model for ${agencyName}/${state}`);
        } catch (error) {
            console.error('Error updating learning model:', error);
        }
    }

    /**
     * Analyze which strategies perform best
     */
    analyzeStrategyPerformance(outcomes) {
        const strategyScores = {};

        outcomes.forEach(outcome => {
            const strategyKey = JSON.stringify(outcome.strategy_config);

            if (!strategyScores[strategyKey]) {
                strategyScores[strategyKey] = {
                    config: outcome.strategy_config,
                    scores: [],
                    total_score: 0,
                    count: 0
                };
            }

            strategyScores[strategyKey].scores.push(outcome.outcome_score);
            strategyScores[strategyKey].total_score += outcome.outcome_score;
            strategyScores[strategyKey].count += 1;
        });

        // Calculate averages and sort
        const performance = Object.values(strategyScores)
            .map(s => ({
                config: s.config,
                avg_score: s.total_score / s.count,
                sample_size: s.count
            }))
            .sort((a, b) => b.avg_score - a.avg_score);

        return performance;
    }

    /**
     * Store learned insights
     */
    async storeInsights(agencyName, state, performance) {
        try {
            await db.query(`
                INSERT INTO foia_learned_insights (
                    agency_name,
                    state,
                    best_strategies,
                    worst_strategies,
                    sample_size,
                    last_updated
                ) VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (agency_name, state)
                DO UPDATE SET
                    best_strategies = $3,
                    worst_strategies = $4,
                    sample_size = $5,
                    last_updated = NOW()
            `, [
                agencyName,
                state,
                JSON.stringify(performance.slice(0, 3)), // Top 3 strategies
                JSON.stringify(performance.slice(-3)),   // Bottom 3 strategies
                performance.reduce((sum, p) => sum + p.sample_size, 0)
            ]);
        } catch (error) {
            console.error('Error storing insights:', error);
        }
    }

    /**
     * Build prompt modifications based on strategy
     */
    buildPromptModifications(strategy) {
        const modifications = {
            tone_instruction: '',
            emphasis_instruction: '',
            detail_instruction: '',
            legal_instruction: '',
            fee_instruction: '',
            urgency_instruction: ''
        };

        // Tone
        switch (strategy.tone) {
            case 'collaborative':
                modifications.tone_instruction = 'Use a collaborative, cooperative tone that seeks to work with the agency.';
                break;
            case 'assertive':
                modifications.tone_instruction = 'Use an assertive, demanding tone that emphasizes legal rights and obligations.';
                break;
            case 'formal':
                modifications.tone_instruction = 'Use highly formal, traditional legal language with maximum respect.';
                break;
            case 'urgent':
                modifications.tone_instruction = 'Convey appropriate urgency while maintaining professionalism.';
                break;
        }

        // Emphasis
        switch (strategy.emphasis) {
            case 'legal_pressure':
                modifications.emphasis_instruction = 'Emphasize legal obligations, statutory deadlines, and potential consequences.';
                break;
            case 'public_interest':
                modifications.emphasis_instruction = 'Emphasize public interest, transparency, and civic importance.';
                break;
            case 'documentary':
                modifications.emphasis_instruction = 'Emphasize documentary production and educational purposes.';
                break;
            case 'transparency':
                modifications.emphasis_instruction = 'Emphasize government transparency and accountability.';
                break;
        }

        // Detail level
        switch (strategy.detail_level) {
            case 'minimal':
                modifications.detail_instruction = 'Keep the request concise and to the point.';
                break;
            case 'moderate':
                modifications.detail_instruction = 'Provide moderate detail with clear specifications.';
                break;
            case 'comprehensive':
                modifications.detail_instruction = 'Provide comprehensive detail, covering all bases.';
                break;
        }

        // Legal citations
        switch (strategy.legal_citations) {
            case 'few':
                modifications.legal_instruction = 'Include only essential legal citations.';
                break;
            case 'moderate':
                modifications.legal_instruction = 'Include moderate legal citations and case law.';
                break;
            case 'extensive':
                modifications.legal_instruction = 'Include extensive legal citations, case law, and statutory references.';
                break;
        }

        // Fee waiver
        switch (strategy.fee_waiver_approach) {
            case 'none':
                modifications.fee_instruction = 'Do not include fee waiver language.';
                break;
            case 'brief':
                modifications.fee_instruction = 'Include brief fee waiver request.';
                break;
            case 'detailed':
                modifications.fee_instruction = 'Include detailed fee waiver justification with legal basis.';
                break;
        }

        // Urgency
        switch (strategy.urgency_level) {
            case 'none':
                modifications.urgency_instruction = 'Standard processing timeframe is acceptable.';
                break;
            case 'moderate':
                modifications.urgency_instruction = 'Request timely response within statutory deadlines.';
                break;
            case 'high':
                modifications.urgency_instruction = 'Request expedited processing with urgency justification.';
                break;
        }

        return modifications;
    }

    /**
     * Get insights report for an agency
     */
    async getInsightsReport(agencyName, state) {
        try {
            const result = await db.query(`
                SELECT
                    best_strategies,
                    worst_strategies,
                    sample_size,
                    last_updated
                FROM foia_learned_insights
                WHERE agency_name = $1 OR state = $2
                ORDER BY sample_size DESC
                LIMIT 1
            `, [agencyName, state]);

            if (result.rows.length > 0) {
                return {
                    agency: agencyName,
                    state: state,
                    insights: result.rows[0],
                    has_insights: true
                };
            }

            return {
                agency: agencyName,
                state: state,
                has_insights: false,
                message: 'Not enough data yet - still exploring strategies'
            };
        } catch (error) {
            console.error('Error getting insights report:', error);
            return null;
        }
    }
}

module.exports = new AdaptiveLearningService();
