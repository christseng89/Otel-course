import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('translation-frontend', '1.0.0');

export const translationRequestsCounter = meter.createCounter(
  'translation.requests.total',
  { description: 'Total translation requests' },
);

export const jobsEnqueuedCounter = meter.createCounter(
  'translation.jobs.enqueued.total',
  { description: 'Total translation jobs enqueued' },
);

export const requestDuration = meter.createHistogram(
  'translation.request.duration',
  { description: 'Translation request processing time', unit: 'ms' },
);

export const validationErrorsCounter = meter.createCounter(
  'translation.validation.errors.total',
  { description: 'Translation validation errors' },
);

export const serverErrorsCounter = meter.createCounter(
  'translation.server.errors.total',
  { description: 'Translation API 5xx server errors' },
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
