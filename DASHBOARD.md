# 🤖 Autobot KPI Dashboard

Real-time monitoring dashboard for the autonomous FOIA bot.

## Features

### 📊 Key Metrics
- **Total Cases**: All cases imported from Notion
- **Requests Sent**: FOIA requests sent to agencies
- **Responses Received**: Inbound emails from agencies
- **Auto-Replies Sent**: Autonomous bot responses (denials, follow-ups, etc.)
- **Denials Received**: Number of denial responses
- **Active Threads**: Ongoing email conversations
- **Response Rate**: Percentage of sent requests that got responses
- **Avg Response Time**: Average days for agencies to respond

### 📬 Message Statistics
- Messages sent/received in last 7 and 30 days
- Auto-reply counts and trends
- Message type breakdown

### 🎯 Denial Breakdown
Track denial types automatically detected by GPT-5:
- **Overly Broad**: Requests deemed too broad
- **Ongoing Investigation**: Active case exemption
- **No Records**: Agency claims no responsive records
- **Privacy Exemption**: Privacy/confidentiality concerns
- **Excessive Fees**: Cost-based denials
- **Wrong Agency**: Request sent to incorrect department

### 📧 Latest Bot Messages
Real-time feed of the last 10 messages sent by the bot:
- Initial FOIA requests
- Auto-replies to agency responses
- Denial rebuttals with legal citations
- Follow-up messages

### ⚡ Recent Activity
Live activity log showing:
- Email sent/received events
- Auto-reply generation and sending
- Follow-up scheduling
- Case status changes

## Accessing the Dashboard

### Local Development
```bash
# Start the server
node server.js

# Open in browser
http://localhost:3000/dashboard.html
```

### Production (Railway)
```
https://your-app.up.railway.app/dashboard.html
```

## API Endpoints

The dashboard uses these API endpoints:

### Get KPI Metrics
```
GET /api/dashboard/kpi
```

Returns comprehensive metrics including:
- Total counts
- Message statistics
- Response rates
- Denial breakdown
- Auto-reply stats
- Recent activity
- Status breakdown
- State breakdown
- Performance metrics

### Get Latest Messages
```
GET /api/dashboard/messages?limit=20
```

Returns the latest messages sent by the bot with context.

### Get Hourly Activity
```
GET /api/dashboard/hourly-activity
```

Returns activity grouped by hour for the last 24 hours.

## Auto-Refresh

The dashboard auto-refreshes every 30 seconds to show real-time data.

## Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Express.js, PostgreSQL
- **Styling**: Custom CSS with gradient backgrounds and card-based UI
- **Data**: Real-time PostgreSQL queries

## Database Queries

The dashboard service (`services/dashboard-service.js`) includes optimized queries:

- **Total Counts**: Aggregate counts across all tables
- **Message Stats**: Time-based filtering for 7/30 day metrics
- **Response Rates**: JOIN queries to calculate response percentages
- **Denial Stats**: JSON field filtering for denial subtypes
- **Activity Feed**: JOIN queries for contextual activity log

## Performance

All queries are optimized with:
- Database indexes on frequently queried columns
- FILTER clauses for efficient aggregation
- Parallel query execution using Promise.all()
- Result caching (TODO: implement Redis caching)

## Future Enhancements

- [ ] Real-time WebSocket updates
- [ ] Chart visualizations (Chart.js or D3.js)
- [ ] Export to CSV/PDF
- [ ] Date range filters
- [ ] Search and filter functionality
- [ ] Mobile-responsive improvements
- [ ] Dark mode toggle
- [ ] Redis caching for faster loads
