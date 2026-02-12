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

module.exports = { eventBus, notify };
