import { logger } from "./logger";

type QueueTask<T> = () => Promise<T>;

/**
 * Serializes complete YouTube playlist jobs.
 *
 * The queue tail never rejects, so one failed/cancelled playlist cannot block
 * every playlist behind it. The task itself still receives and propagates its
 * own result/error to the conversion runner.
 */
class YouTubePlaylistQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get waitingCount(): number {
    return this.waiting;
  }

  enqueue<T>(jobId: number, task: QueueTask<T>): Promise<T> {
    this.waiting++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(async () => {
      this.waiting--;
      logger.info({ jobId, waiting: this.waiting }, "Starting queued YouTube playlist job");
      try {
        return await task();
      } finally {
        logger.info({ jobId }, "Released YouTube playlist queue");
        release();
      }
    });
  }
}

export const youtubePlaylistQueue = new YouTubePlaylistQueue();