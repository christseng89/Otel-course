import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import { QueueService } from '../../src/services/queue.js';
import type { TranslationJob, TranslationSession } from '../../src/types.js';

const createJob = (): TranslationJob => ({
  jobId: 'job-1',
  sessionId: 'session-1',
  text: 'Hello',
  sourceLanguage: 'en',
  targetLanguage: 'es',
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('QueueService', () => {
  let queue: QueueService;

  beforeEach(() => {
    Redis.instances.length = 0;
    queue = new QueueService({ host: 'localhost', port: 6379 });
  });

  it('connects both Redis clients and enqueues a job with trace context', async () => {
    await queue.connect();
    await queue.enqueueJob(createJob());

    const clients = Redis.instances;
    expect(clients).toHaveLength(2);
    expect(clients[0].__getMock('lpush')).toHaveBeenCalledWith(
      'translation:queue',
      expect.stringContaining('"jobId":"job-1"'),
    );
  });

  it('rejects operations before connecting', async () => {
    await expect(queue.enqueueJob(createJob())).rejects.toThrow(
      'QueueService not connected',
    );
    await expect(queue.subscribeToResults(jest.fn())).rejects.toThrow(
      'QueueService not connected',
    );
    await expect(queue.saveSession({} as TranslationSession)).rejects.toThrow(
      'QueueService not connected',
    );
    await expect(queue.getSession('session-1')).rejects.toThrow(
      'QueueService not connected',
    );
    await expect(queue.updateJobStatus('session-1', 'es', 'queued')).rejects.toThrow(
      'QueueService not connected',
    );
  });

  it('subscribes and dispatches valid messages while ignoring invalid JSON', async () => {
    await queue.connect();
    const callback = jest.fn();
    await queue.subscribeToResults(callback);

    const subscriber = Redis.instances[1];
    subscriber.__triggerMessage('translation:results', '{"jobId":"job-1"}');
    subscriber.__triggerMessage('other-channel', '{"jobId":"ignored"}');
    subscriber.__triggerMessage('translation:results', 'invalid');

    expect(callback).toHaveBeenCalledWith({ jobId: 'job-1' });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('saves and reads session job state', async () => {
    await queue.connect();
    const client = Redis.instances[0];
    client.__getMock('hgetall').mockResolvedValue({
      text: 'Hello',
      sourceLanguage: 'en',
      status: 'queued',
      totalJobs: '1',
      'job:es:status': 'completed',
      'job:es:translatedText': 'Hola',
    });
    const session: TranslationSession = {
      sessionId: 'session-1',
      text: 'Hello',
      sourceLanguage: 'en',
      status: 'queued',
      jobs: new Map([['es', { status: 'queued' }]]),
    };

    await queue.saveSession(session);
    expect(client.__getMock('hset')).toHaveBeenCalled();
    expect(await queue.getSession('session-1')).toEqual({
      sessionId: 'session-1',
      text: 'Hello',
      sourceLanguage: 'en',
      status: 'queued',
      jobs: new Map([
        ['es', { status: 'completed', translatedText: 'Hola', error: undefined }],
      ]),
    });
  });

  it('returns null for an empty session hash', async () => {
    await queue.connect();
    await expect(queue.getSession('missing')).resolves.toBeNull();
  });

  it('updates job progress and completes the session', async () => {
    await queue.connect();
    const client = Redis.instances[0];
    client.__getMock('hgetall').mockResolvedValue({
      totalJobs: '1',
      completedJobs: '1',
      status: 'queued',
    });

    await queue.updateJobStatus('session-1', 'es', 'completed', 'Hola');
    expect(client.__getMock('hincrby')).toHaveBeenCalledWith(
      'translation:session:session-1',
      'completedJobs',
      1,
    );
    expect(client.__getMock('hset')).toHaveBeenCalledWith(
      'translation:session:session-1',
      'status',
      'completed',
    );
  });

  it('moves queued sessions in progress and disconnects clients', async () => {
    await queue.connect();
    const client = Redis.instances[0];
    client.__getMock('hgetall').mockResolvedValue({
      totalJobs: '2',
      completedJobs: '1',
      status: 'queued',
    });

    await queue.updateJobStatus('session-1', 'fr', 'processing', undefined, '');
    expect(client.__getMock('hset')).toHaveBeenCalledWith(
      'translation:session:session-1',
      'status',
      'in_progress',
    );

    await queue.disconnect();
    expect(client.__getMock('quit')).toHaveBeenCalled();
    expect(Redis.instances[1].__getMock('quit')).toHaveBeenCalled();
  });
});
