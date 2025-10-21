require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const db = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline scripts for dashboard
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

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

app.use('/webhooks', webhookRoutes);
app.use('/api', apiRoutes);

// Import cron service
const cronService = require('./services/cron-service');

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Initialize database and start server
async function startServer() {
    try {
        console.log('Initializing database...');
        await db.initialize();
        console.log('Database initialized successfully');

        // Start cron jobs
        console.log('\nStarting automated services...');
        cronService.start();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🤖 Autobot MVP Server Running`);
            console.log(`   Port: ${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
            console.log(`   Redis: ${process.env.REDIS_URL ? 'Connected' : 'Not configured'}`);
            console.log(`\n   Health check: http://localhost:${PORT}/health`);
            console.log(`   API: http://localhost:${PORT}/api`);
            console.log(`   Webhooks: http://localhost:${PORT}/webhooks/inbound`);
            console.log(`\n   ✓ Automated follow-ups enabled`);
            console.log(`   ✓ Notion sync every 15 minutes`);
            console.log(`   ✓ Ready to receive requests!\n`);
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
