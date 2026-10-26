import { SUPPORTED_LANGUAGES } from "./types.js";

export interface ValidationErrorBody {
  error: string;
  details?: string;
  supportedLanguages?: readonly string[];
}

export enum ValidationErrorType {
  EMPTY_TEXT = "empty_text",
  EMPTY_LANGUAGES = "empty_languages",
  TOO_MANY_LANGUAGES = "too_many_languages",
  INVALID_LANGUAGES = "invalid_languages",
}

export interface ValidationError {
  statusCode: number;
  body: ValidationErrorBody;
  errorType: ValidationErrorType;
  spanMessage: string;
}

export function validateTranslationRequest(
  text: unknown,
  targetLanguages: unknown,
): ValidationError | null {
  if (!text || typeof text !== "string" || !text.trim()) {
    return {
      statusCode: 400,
      body: {
        error: "Text is required",
        details: "Text must be a non-empty string",
      },
      errorType: ValidationErrorType.EMPTY_TEXT,
      spanMessage: "Empty text",
    };
  }

  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    return {
      statusCode: 400,
      body: {
        error: "At least one target language is required",
        details: "targetLanguages must be a non-empty array",
      },
      errorType: ValidationErrorType.EMPTY_LANGUAGES,
      spanMessage: "No target languages",
    };
  }

  if (targetLanguages.length > 3) {
    return {
      statusCode: 400,
      body: {
        error: "Maximum 3 target languages allowed",
        details: `You requested ${targetLanguages.length} languages`,
      },
      errorType: ValidationErrorType.TOO_MANY_LANGUAGES,
      spanMessage: "Too many target languages",
    };
  }

  const unsupportedLanguages = targetLanguages.filter(
    (language) =>
      typeof language !== "string" ||
      !SUPPORTED_LANGUAGES.some(
        (supportedLanguage) => supportedLanguage === language,
      ),
  );

  if (unsupportedLanguages.length > 0) {
    return {
      statusCode: 400,
      body: {
        error: `Unsupported language: ${unsupportedLanguages.join(", ")}`,
        supportedLanguages: [...SUPPORTED_LANGUAGES],
      },
      errorType: ValidationErrorType.INVALID_LANGUAGES,
      spanMessage: "Unsupported language",
    };
  }

  return null;
}
