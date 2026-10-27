import "./instrumentation.js";

import express from "express";
import cors from "cors";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";
import { QueueService } from "./services/queue.js";
import { SSEManager } from "./services/sse.js";
import { createTranslationRouter } from "./routes/translation.js";
import type { TranslationResult } from "./types.js";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const PORT = parseInt(process.env.PORT || "3000", 10);
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

// Global state for graceful shutdown
let server: Server | null = null;
let queueService: QueueService | null = null;
let sseManager: SSEManager | null = null;

async function startServer(): Promise<void> {
  try {
    // Create Express app
    const app = express();

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.static(join(__dirname, "public")));

    // Initialize services
    logger.info("Initializing services");

    queueService = new QueueService({
      host: REDIS_HOST,
      port: REDIS_PORT,
    });

    await queueService.connect();

    sseManager = new SSEManager();

    // Subscribe to translation results
    await queueService.subscribeToResults(async (result: TranslationResult) => {
      logger.info("Translation result received", {
        jobId: result.jobId,
        sessionId: result.sessionId,
        targetLanguage: result.targetLanguage,
        status: result.status,
      });

      if (result.status === "error") {
        logger.error("Translation job failed", {
          jobId: result.jobId,
          sessionId: result.sessionId,
          targetLanguage: result.targetLanguage,
          error: result.error,
        });
      }

      try {
        // Update session in Redis
        await queueService!.updateJobStatus(
          result.sessionId,
          result.targetLanguage,
          result.status === "completed" ? "completed" : "error",
          result.translatedText,
          result.error,
        );

        // Send SSE event
        const eventType =
          result.status === "completed"
            ? "translation_complete"
            : "translation_error";

        sseManager!.sendEvent(result.sessionId, eventType, result);

        // Check if session is complete
        const session = await queueService!.getSession(result.sessionId);
        if (session && session.status === "completed") {
          sseManager!.sendEvent(result.sessionId, "session_complete", {
            sessionId: result.sessionId,
            status: "completed",
          });
        }
      } catch (error) {
        logger.error("Error processing translation result", {
          jobId: result.jobId,
          sessionId: result.sessionId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    });

    // Mount routes
    const translationRouter = createTranslationRouter({
      queueService,
      sseManager,
    });
    app.use("/api/translate", translationRouter);

    // Health check endpoint
    app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });

    // Start server
    server = app.listen(PORT, () => {
      logger.info("Frontend server started", { port: PORT });
      logger.info("Health check endpoint available", {
        url: `http://localhost:${PORT}/health`,
      });
    });
  } catch (error) {
    logger.error("Failed to start server", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info("Graceful shutdown started", { signal });

  try {
    // Close SSE connections
    if (sseManager) {
      sseManager.closeAll();
    }

    // Close HTTP server
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info("HTTP server closed");
    }

    // Disconnect from Redis
    if (queueService) {
      await queueService.disconnect();
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", {
      signal,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  gracefulShutdown("unhandledRejection");
});

// Start the server
startServer().catch((error) => {
  logger.error("Fatal server error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
