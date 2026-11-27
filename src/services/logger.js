import { EventEmitter } from 'events';

class SystemLogger extends EventEmitter {
  constructor(maxSize = 200) {
    super();
    this.maxSize = maxSize;
    this.buffer = [
      {
        id: 'init-1',
        timestamp: new Date().toLocaleTimeString(),
        category: 'SYSTEM',
        message: '⚡ Distributed Webhook Dispatcher started. Watching for webhook events...',
        level: 'info'
      }
    ];
  }

  addLog(category, message, level = 'info') {
    const entry = {
      id: Date.now() + Math.random().toString(36).slice(2, 6),
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

    // Also write to stdout so Render CLI logs have it
    const line = `[${entry.timestamp}] [${category}] ${message}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  getRecentLogs(limit = 100) {
    return this.buffer.slice(-limit);
  }
}

export const logger = new SystemLogger();
