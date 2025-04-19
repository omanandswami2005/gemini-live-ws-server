# emini Live WebSocket Server

This package provides a WebSocket server that enables real-time interaction with web frontend by using  [gemini-live-web-sdk npm module](https://www.npmjs.com/package/gemini-live-web-sdk "npm i gemini-live-web-sdk").

It uses Socket.IO for managing client connections and WebSocket for communication with Google's AI service.

## Installation

Install the package via npm:

```bash
npm install gemini-live-ws-server
```

## Basic Usage

Import the `GeminiLiveWsServer` class, create an instance with your configuration, and start the server:

```javascript
import { GeminiLiveWsServer } from 'gemini-live-ws-server';

const server = new GeminiLiveWsServer({
  port: 8080,
  googleApiKey: 'your-google-api-key', // Required
  debug: true, // Optional: enable debug logging
});

server.start();
```

### Configuration Options

* **`port`** : Port to listen on (default: `8080`)
* **`googleApiKey`** : Your Google API key (required)
* **`googleWsUrl`** : Google WebSocket URL (default: `"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"`)
* **`jwtSecret`** : Secret for JWT authentication (optional)
* **`authMiddleware`** : Custom authentication middleware (optional)
* **`cors`** : Socket.IO CORS config (default: `{ origin: "*", methods: ["GET", "POST"] }`)
* **`googleSetup`** : Configuration for Google AI service, e.g., `model`, `tools`, `system_instruction`
* **`tools`** : Array of tool names (from presets) or custom tool objects
* **`systemInstruction`** : String for the AI's system instruction
* **`logger`** : Custom Winston logger (default: provided logger)
* **`retryConfig`** : Retry settings for Google WS (e.g., `maxAttempts`, `retryDelay`, `backoffFactor`)
* **`hooks`** : Event callbacks (`onClientConnect`, `onMessage`, `onToolCall`, `onDisconnect`, `onError`)
* **`enableMetrics`** : Enable metrics broadcasting (default: `false`)
* **`metricsInterval`** : Metrics broadcast interval in ms (default: `5000`)
* **`debug`** : Enable debug logging (default: `false`)

## Tools and Presets

Predefined tool configurations are available via `presets`:

```javascript
import { GeminiLiveWsServer, presets } from 'gemini-live-ws-server';

const server = new GeminiLiveWsServer({
  googleApiKey: 'your-google-api-key',
  tools: ["translateText", "summarizeText", { functionDeclarations: [{ name: "custom_tool", description: "Custom tool", parameters: { type: "OBJECT", properties: {} } }] }],
});
server.start();
```

Available presets: `translateText`, `summarizeText`, `generateCode`, `searchWeb`, `codeExecution`.

## Handling Tool Calls

Implement logic for tool calls in the `onToolCall` hook and use `sendToolResponse` to reply:

```javascript
const server = new GeminiLiveWsServer({
  googleApiKey: 'your-google-api-key',
  tools: ["translateText"],
  hooks: {
    onToolCall: (toolCall, socket) => {
      if (toolCall.name === "translate_text") {
        const { text, targetLanguage } = toolCall.args;
        const translatedText = handleTranslateText({ text, targetLanguage });
        server.sendToolResponse(socket, {
          name: toolCall.name,
          response: { translatedText },
          id: toolCall.id,
        });
      }
    },
  },
});
server.start();
```

## Authentication

### JWT Authentication

Enable JWT authentication with `jwtSecret`:

```javascript
const server = new GeminiLiveWsServer({
  googleApiKey: 'your-google-api-key',
  jwtSecret: 'your-secret',
});
```

Clients must provide a valid JWT token in the handshake.

### Custom Authentication Middleware

Define a custom middleware function:

```javascript
const server = new GeminiLiveWsServer({
  googleApiKey: 'your-google-api-key',
  authMiddleware: (socket, next) => {
    const apiKey = socket.handshake.query.apiKey;
    if (apiKey === "valid-key") {
      socket.user = { id: "custom-user" };
      next();
    } else {
      next(new Error("Invalid API key"));
    }
  },
});
```

## Metrics

If `enableMetrics` is `true`, subscribe to or get metrics:

```javascript
const metricsApi = server.metrics();
metricsApi.subscribe((metrics) => console.log(metrics), 10000); // 10s subscription
const currentMetrics = metricsApi.get(); // Get current metrics
```

## Client Example

Connect to the server using [gemini-live-web-sdk (frontend-npm-module](https://www.npmjs.com/package/gemini-live-web-sdk "npm i gemini-live-web-sdk")).

Refer to [this stackblitz space](https://stackblitz.com/edit/stackblitz-starters-6fcoinwx?file=index.html) for ref code 🙂

## Notes

* Refer to [Google&#39;s generative AI service](https://aistudio.google.com/apikey) to get API Key and refer [documentation](https://ai.google.dev/gemini-api/docs/live) for message formats and tool response structures.
