require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Log Redis connection status on startup
console.log('🔍 Environment Check:');
console.log('  NODE_ENV:', process.env.NODE_ENV);
console.log('  PORT:', PORT);
console.log('  REDIS_URL:', process.env.REDIS_URL ? `${process.env.REDIS_URL.substring(0, 20)}...` : '❌ NOT SET');
console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ NOT SET');

// Middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for dashboard
}));
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'autobot-dev-secret'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Serve Next.js dashboard static files
const dashboardPath = path.join(__dirname, 'dashboard', 'out');
app.use(express.static(dashboardPath));

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const dbHealth = await db.healthCheck();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: dbHealth,
            environment: process.env.NODE_ENV
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

// Import routes
const webhookRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const testRoutes = require('./routes/test');
const requestRoutes = require('./routes/requests');
const agencyRoutes = require('./routes/agencies');
const runEngineRoutes = require('./routes/run-engine');
const portalTasksRoutes = require('./routes/portal-tasks');
const shadowModeRoutes = require('./routes/shadow-mode');
const casesRoutes = require('./routes/cases');
const monitorRoutes = require('./routes/monitor');
const phoneCallRoutes = require('./routes/phone-calls');
const userRoutes = require('./routes/users');
const authRoutes = require('./routes/auth');
const caseAgenciesRoutes = require('./routes/case-agencies');
const evalRoutes = require('./routes/eval');

app.use('/webhooks', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api/test', testRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/agencies', agencyRoutes);
app.use('/api', runEngineRoutes);  // Run Engine (Phase 3): /api/cases/:id/run-*, /api/proposals/:id/decision
app.use('/api/portal-tasks', portalTasksRoutes);  // Portal Tasks (Phase 4): manual submission tracking
app.use('/api/shadow', shadowModeRoutes);  // Shadow Mode (Phase 7.1): review tracking and metrics
app.use('/api/cases', casesRoutes);  // Cases: /api/cases/import-notion
app.use('/api/monitor', monitorRoutes);  // Monitor: /api/monitor/* for debugging
app.use('/api/phone-calls', phoneCallRoutes);  // Phone Call Queue: escalation for unresponsive email cases
app.use('/api/users', userRoutes);  // Users: multi-user email routing
app.use('/api/auth', authRoutes);  // Auth: login/logout/me
app.use('/api/cases', caseAgenciesRoutes);  // Case Agencies: multi-agency support per case
app.use('/api/eval', evalRoutes);  // Eval: AI decision quality tracking

// SSE endpoint for real-time dashboard updates
const { eventBus } = require('./services/event-bus');
app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write(':\n\n'); // initial comment to flush headers

    const onUpdate = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    eventBus.on('data_update', onUpdate);

    // Keep-alive every 30s
    const keepAlive = setInterval(() => res.write(':\n\n'), 30000);

    req.on('close', () => {
        eventBus.off('data_update', onUpdate);
        clearInterval(keepAlive);
    });
});

// Import cron service and email queue workers
const cronService = require('./services/cron-service');
const discordService = require('./services/discord-service');
const { emailWorker, analysisWorker, generateWorker, portalWorker } = require('./queues/email-queue');
const fs = require('fs');

/**
 * Run database migrations automatically
 */
async function runMigrations() {
    try {
        const migrationsDir = path.join(__dirname, 'migrations');

        // Check if migrations directory exists
        if (!fs.existsSync(migrationsDir)) {
            console.log('No migrations directory found, skipping...');
            return;
        }

        // Get all migration files
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort(); // Ensure they run in order

        if (migrationFiles.length === 0) {
            console.log('No migration files found, skipping...');
            return;
        }

        // Create migrations tracking table if it doesn't exist
        await db.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                applied_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Check which migrations have been run
        const appliedMigrations = await db.query(
            'SELECT filename FROM schema_migrations'
        );
        const appliedSet = new Set(appliedMigrations.rows.map(r => r.filename));

        // Run pending migrations
        let ranCount = 0;
        for (const filename of migrationFiles) {
            if (appliedSet.has(filename)) {
                console.log(`  ✓ ${filename} (already applied)`);
                continue;
            }

            console.log(`  Running ${filename}...`);
            const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');

            try {
                await db.query(sql);
                await db.query(
                    'INSERT INTO schema_migrations (filename) VALUES ($1)',
                    [filename]
                );
                console.log(`  ✓ ${filename} applied successfully`);
                ranCount++;
            } catch (error) {
                console.error(`  ✗ ${filename} failed:`, error.message);
                throw error;
            }
        }

        if (ranCount > 0) {
            console.log(`\n✓ Applied ${ranCount} migration(s)`);
        } else {
            console.log('✓ All migrations up to date');
        }
    } catch (error) {
        console.error('Migration error:', error);
        throw error;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Dashboard SPA fallback - serve index.html for unmatched routes
app.get('*', (req, res, next) => {
    // Skip API and webhook routes
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) {
        return res.status(404).json({ error: 'Not found', path: req.path });
    }

    // Try to serve the specific HTML file for the route
    const fs = require('fs');
    const htmlPath = path.join(dashboardPath, req.path, 'index.html');

    if (fs.existsSync(htmlPath)) {
        return res.sendFile(htmlPath);
    }

    // Fallback to root index.html for SPA routing
    const rootIndex = path.join(dashboardPath, 'index.html');
    if (fs.existsSync(rootIndex)) {
        return res.sendFile(rootIndex);
    }

    // If no dashboard files exist, return 404
    return res.status(404).json({ error: 'Not found', path: req.path });
});

// Initialize database and start server
async function startServer() {
    try {
        console.log('Initializing database...');
        await db.initialize();
        console.log('Database initialized successfully');

        // Run migrations automatically
        console.log('\nRunning database migrations...');
        await runMigrations();

        // Initialize Discord notifications
        console.log('\nInitializing Discord notifications...');
        await discordService.initialize();

        // Start cron jobs
        console.log('\nStarting automated services...');
        cronService.start();

        // BullMQ workers are automatically started when imported
        console.log('\nStarting BullMQ workers...');
        console.log('   ✓ Email worker started');
        console.log('   ✓ Analysis worker started');
        console.log('   ✓ Generate worker started');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n Autobot MVP Server Running`);
            console.log(`   Port: ${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
            console.log(`   Redis: ${process.env.REDIS_URL ? 'Connected' : 'Not configured'}`);
            console.log(`\n   Dashboard: http://localhost:${PORT}/requests`);
            console.log(`   Health check: http://localhost:${PORT}/health`);
            console.log(`   API: http://localhost:${PORT}/api`);
            console.log(`   Webhooks: http://localhost:${PORT}/webhooks/inbound`);
            console.log(`\n   Agent pipeline: Trigger.dev (cloud)`);
            console.log(`   BullMQ workers: email/analysis/portal only`);
            console.log(`   Automated follow-ups enabled`);
            console.log(`   Notion sync every 15 minutes`);
            console.log(`   Adaptive learning system active`);

            // Log shadow mode status
            const shadowMode = require('./services/shadow-mode');
            if (shadowMode.isShadowMode()) {
                console.log(`\n   ⚠️  SHADOW MODE ACTIVE`);
                console.log(`   ⚠️  Execution: DRY (no actual sends)`);
                console.log(`   ⚠️  Review metrics: http://localhost:${PORT}/api/shadow/metrics`);
            } else {
                console.log(`   ✓ Execution mode: LIVE`);
            }

            console.log(`   ✓ Ready to receive requests!`);
            console.log(``);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    cronService.stop();
    await db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    cronService.stop();
    await db.close();
    process.exit(0);
});

startServer();

module.exports = app;
