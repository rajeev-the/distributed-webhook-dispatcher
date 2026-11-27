import { EventEmitter } from 'events';

class SystemLogger extends EventEmitter {
  constructor(maxSize = 200) {
    super();
    this.maxSize = maxSize;
    this.buffer = [];

    // Initial system boot logs
    this.addLog('SYSTEM', '⚡ Distributed Webhook Dispatcher Logger Initialized');
  }

  addLog(category, message, level = 'info') {
    const entry = {
      id: Date.now() + Math.random().toString(36).slice(2, 7),
      timestamp: new Date().toLocaleTimeString(),
      category,
      message,
      level
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    this.emit('log', entry);

    // Also write to standard stdout/stderr
    const formatted = `[${entry.timestamp}] [${category}] ${message}`;
    if (level === 'error') {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }

  getRecentLogs(limit = 100) {
    return this.buffer.slice(-limit);
  }
}

export const logger = new SystemLogger();
