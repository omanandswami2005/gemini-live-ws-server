interface GeminiLiveWsServerConfig {
    port?: number;
    googleApiKey: string;
    jwtSecret?: string;
    authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
    cors?: object;
    googleSetup?: object;
    logger?: any;
    retryConfig?: { maxAttempts: number; retryDelay: number };
    hooks?: {
      onClientConnect?: (socket: any) => void;
      onMessage?: (data: any, socket: any) => void;
      onDisconnect?: (socket: any, reason: string) => void;
      onError?: (err: Error, socket: any) => void;
    };
    enableMetrics?: boolean;
    enableFileLogging?: boolean;
    systemInstruction?: string;
  }
  
  export class GeminiLiveWsServer {
    constructor(config: GeminiLiveWsServerConfig);
    start(): void;
    getMetrics(): { activeConnections: number; messagesProcessed: number; errors: number } | null;
  }