import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response } from "express";
import type { QueueService } from "../services/queue.js";
import type { SSEManager } from "../services/sse.js";
import type {
  TranslateRequest,
  TranslateResponse,
  SessionResponse,
  TranslationJob,
  JobStatus,
  TranslationSession,
} from "../types.js";
import { SUPPORTED_LANGUAGES } from "../types.js";
import {
  translationRequestsCounter,
  jobsEnqueuedCounter,
  requestDuration,
  validationErrorsCounter,
  serverErrorsCounter,
} from "../metrics.js";

export interface TranslationRouterDeps {
  queueService: QueueService;
  sseManager: SSEManager;
}

export function createTranslationRouter(deps: TranslationRouterDeps): Router {
  const router = Router();
  const { queueService, sseManager } = deps;

  // POST /api/translate - Submit translation request
  router.post("/", async (req: Request, res: Response) => {
    try {
      const start = Date.now();
      const body = req.body as TranslateRequest;

      // Validation with error tracking
      if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
        validationErrorsCounter.add(1, { error_type: "empty_text" });
        res.status(400).json({
          error: "Text is required",
          details: "Text must be a non-empty string",
        });
        return;
      }

      // Validate targetLanguages
      if (
        !Array.isArray(body.targetLanguages) ||
        body.targetLanguages.length === 0
      ) {
        validationErrorsCounter.add(1, { error_type: "empty_languages" });
        res.status(400).json({
          error: "At least one target language is required",
          details: "targetLanguages must be a non-empty array",
        });
        return;
      }

      // Check max languages
      if (body.targetLanguages.length > 3) {
        validationErrorsCounter.add(1, { error_type: "too_many_languages" });
        res.status(400).json({
          error: "Maximum 3 target languages allowed",
          details: `You requested ${body.targetLanguages.length} languages`,
        });
        return;
      }

      // Validate each language
      const unsupportedLanguages = body.targetLanguages.filter(
        (lang) => !SUPPORTED_LANGUAGES.includes(lang as any),
      );

      if (unsupportedLanguages.length > 0) {
        validationErrorsCounter.add(1, { error_type: "invalid_languages" });
        res.status(400).json({
          error: `Unsupported language: ${unsupportedLanguages.join(", ")}`,
          supportedLanguages: [...SUPPORTED_LANGUAGES],
        });
        return;
      }

      // Create session
      const sessionId = uuidv4();
      const jobs = new Map<string, JobStatus>();

      // Create and enqueue jobs
      const jobsList: TranslationJob[] = [];

      for (const targetLanguage of body.targetLanguages) {
        const jobId = uuidv4();
        const job: TranslationJob = {
          jobId,
          sessionId,
          text: body.text,
          sourceLanguage: "en",
          targetLanguage,
          createdAt: new Date().toISOString(),
        };

        jobsList.push(job);
        jobs.set(targetLanguage, { status: "queued" });

        // Enqueue job & Track each job enqueued
        await queueService.enqueueJob(job);
        jobsEnqueuedCounter.add(1, { target_language: targetLanguage });
      }

      // Save session
      const session: TranslationSession = {
        sessionId,
        text: body.text,
        sourceLanguage: "en",
        status: "queued",
        jobs,
      };

      await queueService.saveSession(session);

      // Return response
      const response: TranslateResponse = {
        sessionId,
        status: "queued",
        jobs: jobsList.map((job) => ({
          jobId: job.jobId,
          targetLanguage: job.targetLanguage,
          status: "queued",
        })),
      };

      console.log(
        `Created translation session ${sessionId} with ${jobsList.length} jobs`,
      );

      // Track request duration
      requestDuration.record(Date.now() - start, {
        target_language_count: body.targetLanguages.length.toString(),
      });
      // Track successful request
      translationRequestsCounter.add(1, {
        status: "success",
        language_count: body.targetLanguages.length.toString(),
      });
      res.status(201).json(response);
    } catch (error) {
      console.error("Error creating translation session:", error);
      serverErrorsCounter.add(1, { operation: "create_translation" });
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // GET /api/translate/:sessionId - Get session status
  router.get("/:sessionId", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params as unknown & { sessionId: string };

      const session = await queueService.getSession(sessionId);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Convert Map to object for JSON response
      const translations: Record<string, JobStatus> = {};
      for (const [lang, jobStatus] of session.jobs.entries()) {
        translations[lang] = jobStatus;
      }

      const response: SessionResponse = {
        sessionId: session.sessionId,
        text: session.text,
        status: session.status,
        translations,
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching session:", error);
      serverErrorsCounter.add(1, { operation: "get_session" });
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // GET /api/translate/:sessionId/events - SSE endpoint
  router.get("/:sessionId/events", async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params as unknown & { sessionId: string };

      // Verify session exists
      const session = await queueService.getSession(sessionId);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Add SSE connection
      sseManager.addConnection(sessionId, res);

      console.log(`Client connected to SSE for session ${sessionId}`);
    } catch (error) {
      console.error("Error establishing SSE connection:", error);
      serverErrorsCounter.add(1, { operation: "session_events" });
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}
