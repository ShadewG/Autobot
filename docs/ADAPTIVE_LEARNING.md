# Adaptive Learning System for FOIA Requests

## Overview

The system implements **reinforcement learning** to continuously improve FOIA request effectiveness by:
1. Generating strategic variations of requests
2. Tracking which strategies get positive/negative responses
3. Learning patterns and optimizing future requests
4. Automatically adapting to each agency's preferences

## How It Works

### 1. Strategic Dimensions (What We Vary)

Each FOIA request uses a combination of these strategic choices:

```javascript
{
  tone: ['collaborative', 'assertive', 'formal', 'urgent'],
  emphasis: ['legal_pressure', 'public_interest', 'documentary', 'transparency'],
  detail_level: ['minimal', 'moderate', 'comprehensive'],
  legal_citations: ['few', 'moderate', 'extensive'],
  fee_waiver_approach: ['none', 'brief', 'detailed'],
  urgency_level: ['none', 'moderate', 'high']
}
```

**Example Variations:**

- **Strategy A**: Collaborative tone + Documentary emphasis + Moderate detail
- **Strategy B**: Assertive tone + Legal pressure emphasis + Comprehensive detail
- **Strategy C**: Formal tone + Public interest emphasis + Minimal detail

### 2. Outcome Scoring (What We Measure)

Responses are scored based on multiple factors:

```javascript
{
  'full_approval': +10 points,      // Got everything requested
  'partial_approval': +5 points,    // Got some records
  'quick_response': +3 points,      // Responded within deadline
  'fee_waived': +2 points,          // Fee waiver granted
  'no_response': -5 points,         // No response (negative)
  'denial': -3 points,              // Denied (but at least responded)
  'partial_denial': 0 points,       // Mixed result
  'slow_response': -1 point         // Slow but eventual response
}
```

**Example Scoring:**
- Full approval + Quick response + Fee waived = **15 points**
- Denial + Slow response = **-4 points**

### 3. Learning Process

```
┌─────────────────┐
│  Generate       │ → Try different strategies
│  Variations     │   (A/B testing)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Track          │ → Record outcomes
│  Outcomes       │   (approvals, denials, timing)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Learn          │ → Analyze which strategies
│  Patterns       │   work for each agency
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Optimize       │ → Use best strategies
│  Future         │   for future requests
│  Requests       │
└─────────────────┘
```

### 4. Exploration vs. Exploitation

**Phase 1: Exploration (First 10-20 requests per agency)**
- Try random strategy variations
- Build initial dataset
- Discover what works

**Phase 2: Exploitation (After sufficient data)**
- Use top-performing strategies
- Occasionally explore new variations (20% of time)
- Continuously refine

## Database Schema

### foia_strategy_outcomes
Stores individual outcomes:
```sql
- case_id: Link to case
- agency_name: Which agency
- state: Which state
- strategy_config: JSON of strategy used
- outcome_type: full_approval, denial, etc.
- outcome_score: Calculated score
- response_time_days: How long to respond
```

### foia_learned_insights
Stores aggregated knowledge:
```sql
- agency_name: Agency name
- state: State code
- best_strategies: Top 3 performing strategies
- worst_strategies: Bottom 3 performing strategies
- sample_size: Number of data points
- last_updated: When insights were updated
```

## API Endpoints

### Get Insights for Specific Agency
```bash
GET /api/insights/Oakland%20Police%20Department?state=CA
```

Response:
```json
{
  "success": true,
  "insights": {
    "agency": "Oakland Police Department",
    "state": "CA",
    "has_insights": true,
    "insights": {
      "best_strategies": [
        {
          "config": {
            "tone": "collaborative",
            "emphasis": "documentary",
            "detail_level": "comprehensive"
          },
          "avg_score": 12.5,
          "sample_size": 8
        }
      ],
      "sample_size": 25,
      "last_updated": "2025-10-21T14:30:00Z"
    }
  }
}
```

### Get All Insights
```bash
GET /api/insights
```

Returns top 50 agencies with most data.

### Get Strategy Performance Dashboard
```bash
GET /api/strategy-performance
```

Response:
```json
{
  "success": true,
  "stats": {
    "total_cases": 150,
    "approvals": 45,
    "denials": 30,
    "completion_rate": 0.75
  },
  "topStrategies": [...]
}
```

## Example: How System Learns

### Scenario: Oakland PD (First 3 Requests)

**Request 1:**
- Strategy: Assertive tone + Legal pressure
- Outcome: Denial (-3 points)
- ❌ System learns: "Don't be too aggressive with Oakland PD"

**Request 2:**
- Strategy: Collaborative tone + Documentary emphasis
- Outcome: Full approval + Quick response (+13 points)
- ✅ System learns: "Oakland PD responds well to documentary angle"

**Request 3:**
- Strategy: Collaborative + Public interest
- Outcome: Partial approval (+5 points)
- ✅ System learns: "Collaborative works, documentary works best"

**Request 4 and beyond:**
- System uses: Collaborative + Documentary (proven winner)
- Occasionally tries: New variations to explore (20% of time)

### After 20 Requests to Oakland PD

The system has learned:
```json
{
  "best_strategy": {
    "tone": "collaborative",
    "emphasis": "documentary",
    "detail_level": "comprehensive",
    "legal_citations": "moderate",
    "fee_waiver_approach": "detailed",
    "urgency_level": "moderate"
  },
  "avg_score": 11.2,
  "sample_size": 20,
  "success_rate": "85%"
}
```

## Benefits

1. **Continuous Improvement**: Gets better over time
2. **Agency-Specific**: Learns each agency's preferences
3. **State-Level Patterns**: Identifies state-wide trends
4. **Data-Driven**: No guesswork, uses actual outcomes
5. **Automatic**: No manual tuning required

## Monitoring

Track learning progress through:
- Strategy performance dashboard
- Agency-specific insights
- Success rate trends over time
- Most/least effective strategies

## Future Enhancements

1. **Multi-Armed Bandit**: Implement Thompson Sampling for better exploration/exploitation
2. **Contextual Learning**: Factor in request type (body cam vs. reports)
3. **Temporal Patterns**: Learn when agencies are most responsive
4. **Network Effects**: Share learnings across similar agencies
5. **A/B Testing Framework**: Run formal experiments

## Technical Implementation

See:
- `services/adaptive-learning-service.js` - Core learning logic
- `services/ai-service.js` - Integration with FOIA generation
- `migrations/005_adaptive_learning_tables.sql` - Database schema
- `routes/api.js` - API endpoints

## Example Usage in Code

```javascript
// Generate request with adaptive strategy
const strategy = await adaptiveLearning.generateStrategicVariation(caseData);
// strategy = { tone: 'collaborative', emphasis: 'documentary', ... }

// Use strategy in prompt generation
const systemPrompt = buildFOIASystemPrompt(state, strategy);

// After response received
await adaptiveLearning.recordOutcome(caseId, strategy, {
  type: 'full_approval',
  response_time_days: 8,
  fee_waived: true
});
// System learns and updates insights automatically
```

## Migration Required

Run the database migration to enable adaptive learning:

```bash
psql $DATABASE_URL -f migrations/005_adaptive_learning_tables.sql
```

This creates the necessary tables to track strategies and outcomes.
