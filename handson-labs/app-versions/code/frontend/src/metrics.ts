import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

const meter = metrics.getMeter('translation-frontend', '1.0.0');

type CounterKey =
  | 'translationRequests'
  | 'jobsEnqueued'
  | 'validationErrors'
  | 'serverErrors';

interface CounterDefinition {
  key: CounterKey;
  name: string;
  description: string;
}

const counterDefinitions: CounterDefinition[] = [
  {
    key: 'translationRequests',
    name: 'translation.requests.total',
    description: 'Total translation requests',
  },
  {
    key: 'jobsEnqueued',
    name: 'translation.jobs.enqueued.total',
    description: 'Total translation jobs enqueued',
  },
  {
    key: 'validationErrors',
    name: 'translation.validation.errors.total',
    description: 'Translation validation errors',
  },
  {
    key: 'serverErrors',
    name: 'translation.server.errors.total',
    description: 'Translation API 5xx server errors',
  },
];

const counters = counterDefinitions.reduce<Record<CounterKey, Counter>>(
  (createdCounters, definition) => {
    createdCounters[definition.key] = meter.createCounter(definition.name, {
      description: definition.description,
    });
    return createdCounters;
  },
  {} as Record<CounterKey, Counter>,
);

export const translationRequestsCounter = counters.translationRequests;
export const jobsEnqueuedCounter = counters.jobsEnqueued;
export const validationErrorsCounter = counters.validationErrors;
export const serverErrorsCounter = counters.serverErrors;

export const requestDuration = meter.createHistogram(
  'translation.request.duration',
  { description: 'Translation request processing time', unit: 'ms' },
);

export const recordValidationError = (errorType: string): void => {
  validationErrorsCounter.add(1, { error_type: errorType });
};

export const recordJobEnqueued = (targetLanguage: string): void => {
  jobsEnqueuedCounter.add(1, { target_language: targetLanguage });
};

export const recordRequestDuration = (
  durationMs: number,
  targetLanguageCount: number,
): void => {
  requestDuration.record(durationMs, {
    target_language_count: targetLanguageCount.toString(),
  });
};

export const recordTranslationRequest = (
  status: string,
  languageCount: number,
): void => {
  translationRequestsCounter.add(1, {
    status,
    language_count: languageCount.toString(),
  });
};

export const recordServerError = (operation: string): void => {
  serverErrorsCounter.add(1, { operation });
};
