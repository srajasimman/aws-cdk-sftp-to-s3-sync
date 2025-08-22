interface LogMetadata {
  [key: string]: any;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: any;
}

class Logger {
  private formatMetadata(metadata: LogMetadata = {}): string {
    return Object.entries(metadata)
      .map(([key, value]) => {
        if (value instanceof Error) {
          return `${key}="${value.stack || value.message}"`;
        }
        return `${key}="${value}"`;
      })
      .join(' ');
  }

  private log(level: string, message: string, metadata: LogMetadata = {}): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...metadata
    };

    console.log(JSON.stringify(entry));
  }

  info(message: string, metadata?: LogMetadata): void {
    this.log('INFO', message, metadata);
  }

  warn(message: string, metadata?: LogMetadata): void {
    this.log('WARN', message, metadata);
  }

  error(message: string, metadata?: LogMetadata): void {
    this.log('ERROR', message, metadata);
  }

  debug(message: string, metadata?: LogMetadata): void {
    this.log('DEBUG', message, metadata);
  }
}

export const logger = new Logger();
