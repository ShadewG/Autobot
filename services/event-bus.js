const EventEmitter = require('events');

const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

function notify(type, message, meta = {}) {
    eventBus.emit('notification', {
        type,
        message,
        ...meta,
        timestamp: new Date().toISOString()
    });
}

/**
 * Emit a real-time data update for SSE consumers.
 * @param {'case_update'|'message_new'|'proposal_update'|'activity_new'|'stats_update'} eventType
 * @param {object} payload - The data to push to clients
 */
function emitDataUpdate(eventType, payload) {
    eventBus.emit('data_update', {
        event: eventType,
        ...payload,
        timestamp: new Date().toISOString()
    });
}

module.exports = { eventBus, notify, emitDataUpdate };
