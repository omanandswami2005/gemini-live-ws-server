import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import winston from "winston";
import WebSocket from "ws";

export const presets = {
  translateText: {
    functionDeclarations: [{
      name: "translate_text",
      description: "Translate text to a target language",
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "Text to translate" },
          targetLanguage: { type: "STRING", description: "Target language code (e.g., 'es', 'fr')" },
        },
        required: ["text", "targetLanguage"],
      },
    }],
  },
  summarizeText: {
    functionDeclarations: [{
      name: "summarize_text",
      description: "Summarize a given text",
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "Text to summarize" },
          maxLength: { type: "INTEGER", description: "Maximum summary length (words)" },
        },
        required: ["text"],
      },
    }],
  },
  generateCode: {
    functionDeclarations: [{
      name: "generate_code",
      description: "Generate code in a specified language",
      parameters: {
        type: "OBJECT",
        properties: {
          language: { type: "STRING", description: "Programming language (e.g., 'python', 'javascript')" },
          task: { type: "STRING", description: "Description of the coding task" },
        },
        required: ["language", "task"],
      },
    }],
  },
  searchWeb: {
    googleSearch: {},
  },
  codeExecution: {
    codeExecution: {},
  },
};

export class GeminiLiveWsServer {
  constructor(config = {}) {
    this.config = {
      port: config.port || 8080,
      googleApiKey: config.googleApiKey,
      googleWsUrl: config.googleWsUrl || "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent",
      jwtSecret: config.jwtSecret,
      authMiddleware: config.authMiddleware,
      cors: config.cors || { origin: "*", methods: ["GET", "POST"] },
      googleSetup: {
        model: "models/gemini-2.0-flash-exp",
        outputAudioTranscription: {}, // Empty object to enable transcription
        system_instruction: { role: "user", parts: [{ text: config?.systemInstruction || "You are a helpful assistant." }] },
        tools: config.tools ? this.tools(config.tools) : (config.googleSetup?.tools || []),
        ...config.googleSetup,
      },
      logger: config.logger,
      retryConfig: {
        maxAttempts: config.retryConfig?.maxAttempts || 3,
        retryDelay: config.retryConfig?.retryDelay || 2000,
        backoffFactor: config.retryConfig?.backoffFactor || 2,
      },
      hooks: {
        onClientConnect: config.hooks?.onClientConnect || (() => this.logger.debug(`Client connected`)),
        onMessage: config.hooks?.onMessage || ((data, socket) => {
          console.log("Message from Gemini:", data);
        }),
        onToolCall: config.hooks?.onToolCall || ((toolCall, socket) => {
          this.logger.debug(`Tool call received: ${JSON.stringify(toolCall)}`);
        }),
        onDisconnect: config.hooks?.onDisconnect || ((socket, reason) => this.logger.debug(`Disconnected: ${reason}`)),
        onError: config.hooks?.onError || ((err, socket) => this.logger.error(`Error: ${err.message}`)),
      },
      enableMetrics: config.enableMetrics || false,
      metricsInterval: config.metricsInterval || 5000,
      debug: config.debug || false,
    };

    if (!this.config.googleApiKey) {
      throw new Error("googleApiKey is required");
    }

    this.logger = this.config.logger || winston.createLogger({
      level: this.config.debug ? "debug" : "info",
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
      transports: [new winston.transports.Console()],
    });

    this.metricsData = this.config.enableMetrics ? { activeConnections: 0, messagesProcessed: 0, errors: 0 } : null;
    this.metricsSubscribers = new Set();
    this.googleWsConnections = new Map();

    this.httpServer = createServer();
    this.io = new Server(this.httpServer, {
      cors: this.config.cors,
      connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: true },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    this.setupMiddleware();
  }

  tools(toolConfigs) {
    const result = [];
    for (const tool of toolConfigs) {
      if (typeof tool === "string" && presets[tool]) {
        result.push(presets[tool]);
      } else if (typeof tool === "object") {
        result.push(tool);
      }
    }
    return result;
  }

  setupMiddleware() {
    if (this.config.authMiddleware) {
      this.io.use(this.config.authMiddleware);
    } else if (this.config.jwtSecret) {
      this.io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) return next(new Error("Authentication error"));
        try {
          socket.user = jwt.verify(token, this.config.jwtSecret);
          next();
        } catch (err) {
          next(new Error("Authentication failed"));
        }
      });
    }
  }

  sendToolResponse(socket, functionResponses) {
    const googleWs = this.googleWsConnections.get(socket.id);
    if (!googleWs || googleWs.readyState !== WebSocket.OPEN) {
      this.logger.error("Cannot send tool response: Google WebSocket not open");
      socket.emit("error", "Google WebSocket not connected");
      return;
    }

    const response = {
      tool_response: {
        function_responses: Array.isArray(functionResponses) ? functionResponses : [functionResponses],
      },
    };

    try {
      googleWs.send(JSON.stringify(response));
      this.logger.debug(`Sent tool response: ${JSON.stringify(response)}`);
    } catch (err) {
      this.logger.error(`Failed to send tool response: ${err.message}`);
      socket.emit("error", `Failed to send tool response: ${err.message}`);
    }
  }

  start() {
    this.setupEventHandlers();
    this.httpServer.listen(this.config.port, () => {
      this.logger.info(`Server running on port ${this.config.port}`);
    });

    if (this.config.enableMetrics) {
      this.startMetricsBroadcast();
    }

    const shutdown = () => {
      this.logger.info("Shutting down");
      this.stopMetricsBroadcast();
      this.io.close(() => {
        this.httpServer.close(() => process.exit(0));
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  setupEventHandlers() {
    this.io.on("connection", (socket) => {
      this.metricsData && this.metricsData.activeConnections++;
      this.config.hooks.onClientConnect(socket);
  
      const messageQueue = [];
      let googleWs = null;
      let connectionAttempts = 0;
  
      const setupGoogleConnection = () => {
        if (connectionAttempts >= this.config.retryConfig.maxAttempts) {
          this.logger.error("Max Google WS attempts reached");
          socket.emit("error", "Failed to connect to AI");
          this.config.hooks.onError(new Error("Max attempts reached"), socket);
          this.metricsData && this.metricsData.errors++;
          return;
        }
  
        connectionAttempts++;
        const delay = this.config.retryConfig.retryDelay * Math.pow(this.config.retryConfig.backoffFactor, connectionAttempts - 1);
        const url = `${this.config.googleWsUrl}?key=${this.config.googleApiKey}`;
        googleWs = new WebSocket(url);
  
        this.googleWsConnections.set(socket.id, googleWs);
  
        googleWs.on("open", () => {
          if (googleWs.readyState !== WebSocket.OPEN) return;
          this.logger.info("Connected to Google API");
          connectionAttempts = 0;
          try {
            googleWs.send(JSON.stringify({ setup: this.config.googleSetup }));
            while (messageQueue.length > 0 && googleWs.readyState === WebSocket.OPEN) {
              googleWs.send(messageQueue.shift());
            }
            socket.emit("ready", { status: "connected", timestamp: new Date().toISOString() });
          } catch (err) {
            this.logger.error(`Setup error: ${err.message}`);
            this.config.hooks.onError(err, socket);
            this.metricsData && this.metricsData.errors++;
          }
        });
  
        googleWs.on("message", (data) => {
          let parsedData;
          try {
            parsedData = JSON.parse(data.toString());
          } catch (err) {
            parsedData = data.toString();
            this.logger.error(`Parsing error: ${err.message}`);
            this.config.hooks.onError(err, socket);
          }
  
          // Handle transcription messages
          if (parsedData.serverContent && parsedData.serverContent.outputTranscription) {
            const transcriptionText = parsedData.serverContent.outputTranscription.text;
            socket.emit("transcription", { text: transcriptionText, timestamp: new Date().toISOString() });
            // this.logger.debug(`Transcription emitted: ${transcriptionText} at ${new Date().toISOString()}`);
          } else {
            socket.emit("message", parsedData);
            if (parsedData.toolCall) {
              const toolCall = Array.isArray(parsedData.toolCall.functionCalls)
                ? parsedData.toolCall.functionCalls
                : [parsedData.toolCall];
              toolCall.forEach((tc) => this.config.hooks.onToolCall(tc, socket));
            }
            this.config.hooks.onMessage(parsedData, socket);
          }
  
          this.metricsData && this.metricsData.messagesProcessed++;
        });
  
        googleWs.on("close", (code, reason) => {
          this.logger.info(`Google WS closed: ${code} ${reason.toString()}`);
          this.googleWsConnections.delete(socket.id);
          if (code !== 1000) {
            setTimeout(setupGoogleConnection, delay);
          }
        });
  
        googleWs.on("error", (err) => {
          this.logger.error(`Google WS error: ${err.message}`);
          this.config.hooks.onError(err, socket);
          this.metricsData && this.metricsData.errors++;
          setTimeout(setupGoogleConnection, delay);
        });
      };
  
      socket.on("message", (message) => {
        if (!message) {
          socket.emit("error", "Empty message");
          this.config.hooks.onError(new Error("Empty message"), socket);
          this.metricsData && this.metricsData.errors++;
          return;
        }
  
        const messageStr = JSON.stringify(message);
        if (googleWs?.readyState === WebSocket.OPEN) {
          try {
            googleWs.send(messageStr);
          } catch (err) {
            socket.emit("error", `Send failed: ${err.message}`);
            this.config.hooks.onError(err, socket);
            this.metricsData && this.metricsData.errors++;
          }
        } else {
          messageQueue.push(messageStr);
          if (!googleWs || googleWs.readyState === WebSocket.CLOSED) {
            setupGoogleConnection();
          }
        }
      });
  
      socket.on("disconnect", (reason) => {
        this.metricsData && this.metricsData.activeConnections--;
        this.config.hooks.onDisconnect(socket, reason);
        if (googleWs) {
          googleWs.close(1000, "Client disconnected");
          this.googleWsConnections.delete(socket.id);
        }
      });
  
      socket.on("error", (err) => {
        this.config.hooks.onError(err, socket);
        this.metricsData && this.metricsData.errors++;
      });
  
      setupGoogleConnection();
    });
  }

  metrics() {
    if (!this.metricsData) throw new Error("Metrics not enabled");
    return {
      subscribe: (callback, duration) => {
        this.metricsSubscribers.add(callback);
        if (duration) {
          setTimeout(() => this.metricsSubscribers.delete(callback), duration);
        }
        return () => this.metricsSubscribers.delete(callback);
      },
      get: () => ({ ...this.metricsData }),
    };
  }

  startMetricsBroadcast() {
    if (!this.metricsData) return;
    this.metricsIntervalId = setInterval(() => {
      const metricsApi = this.metrics();
      this.metricsSubscribers.forEach((callback) => {
        try {
          callback(metricsApi.get());
        } catch (err) {
          this.logger.error(`Metrics subscriber error: ${err.message}`);
        }
      });
    }, this.config.metricsInterval);
  }

  stopMetricsBroadcast() {
    if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = null;
    }
  }
}