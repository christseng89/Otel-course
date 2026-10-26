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

// Refactoring metrics.js, tracers.js and validation.ts
import {
  recordJobEnqueued,
  recordRequestDuration,
  recordServerError,
  recordTranslationRequest,
  recordValidationError,
} from "../metrics.js";

import {
  setSpanError,
  setSpanAttributes,
  setSpanSuccess,
  tracer,
} from "../tracers.js";
import { validateTranslationRequest } from "../validation.js";

export interface TranslationRouterDeps {
  queueService: QueueService;
  sseManager: SSEManager;
}

export function createTranslationRouter(deps: TranslationRouterDeps): Router {
  const router = Router();
  const { queueService, sseManager } = deps;

  // POST /api/translate - Submit translation request
  router.post("/", async (req: Request, res: Response) => {
    await tracer.startActiveSpan(
      "create_translation_session",
      async (sessionSpan) => {
        const start = Date.now();
        const body = req.body as TranslateRequest;

        try {
          const text = body?.text;
          const targetLanguages = body?.targetLanguages;

          // Add business attributes to the session span.
          setSpanAttributes(sessionSpan, {
            "translation.text_length": typeof text === "string" ? text.length : 0,
            "translation.target_language_count": Array.isArray(targetLanguages)
              ? targetLanguages.length
              : 0,
            "translation.target_languages": Array.isArray(targetLanguages)
              ? targetLanguages
              : [],
          });

          // Validation with error tracking and a dedicated business span.
          const validationSucceeded = await tracer.startActiveSpan(
            "validate_request",
            async (validationSpan) => {
              try {
                const validationError = validateTranslationRequest(
                  text,
                  targetLanguages,
                );

                if (validationError) {
                  recordValidationError(validationError.errorType);
                  setSpanError(
                    validationSpan,
                    new Error(validationError.spanMessage),
                  );
                  res
                    .status(validationError.statusCode)
                    .json(validationError.body);
                  return false;
                }

                setSpanSuccess(validationSpan);
                return true;
              } finally {
                validationSpan.end();
              }
            },
          );

          if (!validationSucceeded) {
            // sessionSpan Error - Invalid translation requrest
            setSpanError(sessionSpan, new Error("Invalid translation request"));
            return;
          }

          // TypeScript can narrow these values after the validation span, but
          // keep the guard explicit because the validation runs asynchronously.
          if (typeof text !== "string" || !Array.isArray(targetLanguages)) {
            return;
          }

          // Create session
          const sessionId = uuidv4();
          setSpanAttributes(sessionSpan, {
            "translation.session_id": sessionId,
          });
          const jobs = new Map<string, JobStatus>();

          // Create and enqueue jobs
          const jobsList: TranslationJob[] = [];

          await tracer.startActiveSpan(
            "enqueue_translation_jobs",
            async (enqueueSpan) => {
              try {
                // Create and enqueue jobs
                setSpanAttributes(enqueueSpan, {
                  "translation.jobs_count": targetLanguages.length,
                  "translation.languages": targetLanguages,
                });

                const enqueuePromises = targetLanguages.map(
                  (targetLanguage) => {
                    const jobId = uuidv4();
                    const job: TranslationJob = {
                      jobId,
                      sessionId,
                      text,
                      sourceLanguage: "en",
                      targetLanguage,
                      createdAt: new Date().toISOString(),
                    };

                    jobsList.push(job);
                    jobs.set(targetLanguage, { status: "queued" });

                    // Enqueue job & Track each job enqueued
                    return queueService.enqueueJob(job).then(() => {
                      recordJobEnqueued(targetLanguage);
                    });
                  },
                );
                await Promise.all(enqueuePromises);

                // enqueueSpan OK
                setSpanSuccess(enqueueSpan);
              } catch (error) {
                setSpanError(enqueueSpan, error);
                throw error;
              } finally {
                enqueueSpan.end();
              }
            },
          );

          // Save session
          const session: TranslationSession = {
            sessionId,
            text,
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
          recordRequestDuration(Date.now() - start, targetLanguages.length);
          // Track successful request
          recordTranslationRequest("success", targetLanguages.length);

          // sessionSpan OK
          setSpanSuccess(sessionSpan);
          res.status(201).json(response);
        } catch (error) {
          console.error("Error creating translation session:", error);
          setSpanError(sessionSpan, error);
          recordServerError("create_translation");
          res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : "Unknown error",
          });
        } finally {
          sessionSpan.end();
        }
      },
    );
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
      recordServerError("get_session");
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
      recordServerError("session_events");
      res.status(500).json({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}
