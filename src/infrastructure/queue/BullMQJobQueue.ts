import { Queue } from "bullmq";
import Redis from "ioredis";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { IJobQueue, JobPayload, JobStatus } from "../../queue/types";
import { ProcessIncomingMessageWorker } from "../../application/jobs/ProcessIncomingMessageWorker";
import { createRedisClient } from "../../infrastructure/cache/createRedisClient";

const logger = createLogger("BullMQJobQueue");

export class BullMQJobQueue implements IJobQueue {
  private queue: Queue;
  private titleQueue: Queue;
  private summaryQueue: Queue;
  private duplicateQueue: Queue;
  private planeSyncQueue: Queue;
  private platformEventQueue: Queue;
  private redisConnection: Redis;
  private worker: ProcessIncomingMessageWorker | null = null;

  constructor() {
    this.redisConnection = createRedisClient("bullmq-job-queue", {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableOfflineQueue: true,
    });

    const queueOptions = {
      connection: this.redisConnection as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    };

    this.queue = new Queue("message-queue", queueOptions);
    this.titleQueue = new Queue("ticket-title-queue", queueOptions);
    this.summaryQueue = new Queue("ticket-summary-queue", queueOptions);
    this.duplicateQueue = new Queue("ticket-duplicate-queue", queueOptions);
    this.planeSyncQueue = new Queue("ticket-plane-sync-queue", queueOptions);
    this.platformEventQueue = new Queue("automationx-platform-events-queue", queueOptions);

    this.redisConnection.on("error", (err) => {
      logger.error({ error: err.message }, "BullMQJobQueue Redis connection error");
    });
  }

  /**
   * Enqueues a message or ticket payload to BullMQ.
   */
  async enqueue(
    payload: Omit<JobPayload, "jobId" | "status" | "retryCount" | "maxRetry"> & { retryCount?: number; maxRetry?: number }
  ): Promise<string> {
    const jobId = payload.metadata?.requestId || require("crypto").randomUUID();
    
    if (payload.type === "ticket.title.generate") {
      logger.info({ jobId, type: payload.type }, "Enqueueing ticket title generate job");
      await this.titleQueue.add(payload.type, payload, { jobId });
    } else if (payload.type === "ticket.summary.update") {
      logger.info({ jobId, type: payload.type }, "Enqueueing ticket summary update job");
      await this.summaryQueue.add(payload.type, payload, { jobId });
    } else if (payload.type === "ticket.duplicate.check") {
      logger.info({ jobId, type: payload.type }, "Enqueueing ticket duplicate check job");
      await this.duplicateQueue.add(payload.type, payload, { jobId });
    } else if (payload.type === "ticket.sync.plane") {
      logger.info({ jobId, type: payload.type }, "Enqueueing ticket sync plane job");
      await this.planeSyncQueue.add(payload.type, payload, { jobId });
    } else if (payload.type === "TicketEnrichedEvent") {
      logger.info({ jobId, type: payload.type }, "Publishing platform event to AutomationX event queue");
      await this.platformEventQueue.add(payload.type, payload, { jobId });
    } else {
      logger.info({ jobId, type: payload.type }, "Enqueueing message job to BullMQ queue");
      const attempts = payload.maxRetry !== undefined ? (payload.maxRetry + 1) : 3;
      await this.queue.add("incoming-message", payload, { jobId, attempts });
    }

    return jobId;
  }

  /**
   * Starts background Ticket Intelligence workers.
   */
  startTicketWorkers(): void {
    const { TicketWorkersManager } = require("../../application/jobs/TicketWorkersManager");
    TicketWorkersManager.start();
  }

  /**
   * Registers the worker to handle queued jobs.
   */
  process(handler: (job: JobPayload) => Promise<any>): void {
    if (this.worker) {
      logger.warn("Worker already registered for BullMQJobQueue, ignoring second registration");
      return;
    }
    logger.info("Initializing BullMQ ProcessIncomingMessageWorker thread");
    this.worker = new ProcessIncomingMessageWorker(handler);
  }

  /**
   * Retrieves the current state/payload of a job from BullMQ.
   */
  async getJob(jobId: string): Promise<JobPayload | null> {
    let job = await this.queue.getJob(jobId);
    if (!job) job = await this.titleQueue.getJob(jobId);
    if (!job) job = await this.summaryQueue.getJob(jobId);
    if (!job) job = await this.duplicateQueue.getJob(jobId);
    if (!job) job = await this.planeSyncQueue.getJob(jobId);
    if (!job) job = await this.platformEventQueue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    let status: JobStatus = "QUEUED";
    if (state === "active") {
      status = "RUNNING";
    } else if (state === "completed") {
      status = "COMPLETED";
    } else if (state === "failed") {
      status = "FAILED";
    }

    return {
      jobId: job.id!,
      type: job.data.type,
      data: job.data.data,
      metadata: job.data.metadata,
      status,
      retryCount: job.attemptsMade,
      maxRetry: job.opts.attempts || 3,
      result: job.returnvalue,
      error: job.failedReason,
    };
  }

  /**
   * Retrieves the current queue depth (waiting, active, and delayed job counts).
   */
  async getQueueDepth(): Promise<number> {
    const qMsg = await this.queue.getJobCounts("wait", "active", "delayed");
    const qTitle = await this.titleQueue.getJobCounts("wait", "active", "delayed");
    const qSummary = await this.summaryQueue.getJobCounts("wait", "active", "delayed");
    const qDuplicate = await this.duplicateQueue.getJobCounts("wait", "active", "delayed");
    const qPlane = await this.planeSyncQueue.getJobCounts("wait", "active", "delayed");
    const qPlatformEvents = await this.platformEventQueue.getJobCounts("wait", "active", "delayed");
    
    return (
      (qMsg.wait || 0) + (qMsg.active || 0) + (qMsg.delayed || 0) +
      (qTitle.wait || 0) + (qTitle.active || 0) + (qTitle.delayed || 0) +
      (qSummary.wait || 0) + (qSummary.active || 0) + (qSummary.delayed || 0) +
      (qDuplicate.wait || 0) + (qDuplicate.active || 0) + (qDuplicate.delayed || 0) +
      (qPlane.wait || 0) + (qPlane.active || 0) + (qPlane.delayed || 0) +
      (qPlatformEvents.wait || 0) + (qPlatformEvents.active || 0) + (qPlatformEvents.delayed || 0)
    );
  }

  /**
   * Closes the queue and any active worker connections.
   */
  async disconnect(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    
    try {
      const { TicketWorkersManager } = require("../../application/jobs/TicketWorkersManager");
      await TicketWorkersManager.stop();
    } catch (err: any) {
      logger.error({ error: err.message }, "Error shutting down Ticket Intelligence workers");
    }

    await this.queue.close();
    await this.titleQueue.close();
    await this.summaryQueue.close();
    await this.duplicateQueue.close();
    await this.planeSyncQueue.close();
    await this.platformEventQueue.close();
    await this.redisConnection.quit();
  }
}
export default BullMQJobQueue;
