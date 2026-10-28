import { Redis } from "ioredis";
import type {
  TranslationJob,
  TranslationResult,
  TranslationSession,
  JobStatus,
} from "../types.js";
import { logger } from "../logger.js";

export interface QueueServiceConfig {
  host: string;
  port: number;
}

type RedisClient = Redis;

export class QueueService {
  private client: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private config: QueueServiceConfig;
  private readonly queueKey = "translation:queue";
  private readonly resultChannel = "translation:results";
  private readonly sessionKeyPrefix = "translation:session:";

  constructor(config: QueueServiceConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    // Client for commands
    this.client = new Redis({
      host: this.config.host,
      port: this.config.port,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    // Separate client for pub/sub
    this.subscriber = new Redis({
      host: this.config.host,
      port: this.config.port,
      maxRetriesPerRequest: 3,
    });

    // Wait for connections
    await Promise.all([this.client.ping(), this.subscriber.ping()]);

    logger.info("Queue service connected to Redis", {
      host: this.config.host,
      port: this.config.port,
    });
  }

  async enqueueJob(job: TranslationJob): Promise<void> {
    if (!this.client) {
      logger.error("Queue service is not connected", {
        operation: "enqueueJob",
        jobId: job.jobId,
        sessionId: job.sessionId,
        targetLanguage: job.targetLanguage,
      });
      throw new Error("QueueService not connected");
    }
    const jobJson = JSON.stringify(job);
    await this.client.lpush(this.queueKey, jobJson);
    logger.info(`Translation job enqueued - ${job.targetLanguage}`, {
      jobId: job.jobId,
      sessionId: job.sessionId,
      targetLanguage: job.targetLanguage,
    });
  }

  async subscribeToResults(
    callback: (result: TranslationResult) => void,
  ): Promise<void> {
    if (!this.subscriber) {
      logger.error("Queue service is not connected", {
        operation: "subscribeToResults",
      });
      throw new Error("QueueService not connected");
    }

    await this.subscriber.subscribe(this.resultChannel);

    this.subscriber.on("message", (channel: string, message: string) => {
      if (channel === this.resultChannel) {
        try {
          const result = JSON.parse(message) as TranslationResult;
          callback(result);
        } catch (error) {
          logger.error("Error parsing translation result message", {
            channel,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    });

    logger.info("Subscribed to translation result channel", {
      channel: this.resultChannel,
    });
  }

  async saveSession(session: TranslationSession): Promise<void> {
    if (!this.client) {
      logger.error("Queue service is not connected", {
        operation: "saveSession",
        sessionId: session.sessionId,
      });
      throw new Error("QueueService not connected");
    }

    const key = this.sessionKeyPrefix + session.sessionId;
    const sessionData: Record<string, string> = {
      text: session.text,
      sourceLanguage: session.sourceLanguage,
      status: session.status,
      totalJobs: session.jobs.size.toString(),
      completedJobs: "0",
    };

    // Add job information
    for (const [lang, jobStatus] of session.jobs.entries()) {
      sessionData[`job:${lang}:status`] = jobStatus.status;
    }

    await this.client.hset(key, sessionData);
    await this.client.expire(key, 3600); // 1 hour TTL

    logger.info("Translation session saved", {
      sessionId: session.sessionId,
      jobCount: session.jobs.size,
      status: session.status,
    });
  }

  async getSession(sessionId: string): Promise<TranslationSession | null> {
    if (!this.client) {
      logger.error("Queue service is not connected", {
        operation: "getSession",
        sessionId,
      });
      throw new Error("QueueService not connected");
    }

    const key = this.sessionKeyPrefix + sessionId;
    const data = await this.client.hgetall(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    const jobs = new Map<string, JobStatus>();

    // Parse job data from hash
    for (const [field, value] of Object.entries(data)) {
      const jobMatch = field.match(/^job:([^:]+):status$/);
      if (jobMatch) {
        const lang = jobMatch[1];
        jobs.set(lang, {
          status: value as JobStatus["status"],
          translatedText: data[`job:${lang}:translatedText`],
          error: data[`job:${lang}:error`],
        });
      }
    }

    return {
      sessionId,
      text: data.text,
      sourceLanguage: data.sourceLanguage,
      status: data.status as TranslationSession["status"],
      jobs,
    };
  }

  async updateJobStatus(
    sessionId: string,
    language: string,
    status: JobStatus["status"],
    translatedText?: string,
    error?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.error("Queue service is not connected", {
        operation: "updateJobStatus",
        sessionId,
        targetLanguage: language,
        status,
      });
      throw new Error("QueueService not connected");
    }

    const key = this.sessionKeyPrefix + sessionId;
    const updates: Record<string, string> = {
      [`job:${language}:status`]: status,
    };

    if (translatedText) {
      updates[`job:${language}:translatedText`] = translatedText;
    }

    if (error) {
      updates[`job:${language}:error`] = error;
    }

    await this.client.hset(key, updates);

    // Update completed jobs count
    if (status === "completed" || status === "error") {
      await this.client.hincrby(key, "completedJobs", 1);
    }

    // Check if all jobs are done
    const data = await this.client.hgetall(key);
    const totalJobs = parseInt(data.totalJobs || "0", 10);
    const completedJobs = parseInt(data.completedJobs || "0", 10);

    if (completedJobs >= totalJobs) {
      await this.client.hset(key, "status", "completed");
    } else if (status === "processing" && data.status === "queued") {
      await this.client.hset(key, "status", "in_progress");
    }

    logger.info("Translation job status updated", {
      sessionId,
      targetLanguage: language,
      status,
      completedJobs,
      totalJobs,
    });
  }

  async disconnect(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    logger.info("Queue service disconnected");
  }
}
