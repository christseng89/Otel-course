import argostranslate.package
import argostranslate.translate
import logging

# Custom Traces
from opentelemetry import trace
from opentelemetry.trace import StatusCode

logger = logging.getLogger(__name__)
# Custom Traces
tracer = trace.get_tracer(__name__)

class Translator:
    """Local translation service using Argos Translate."""

    def __init__(self):
        """Initialize translator and ensure models are available."""
        try:
            # Update package index
            argostranslate.package.update_package_index()

            # Get installed packages
            installed_packages = argostranslate.package.get_installed_packages()
            logger.info(
                "Installed translation packages loaded",
                extra={"package_count": len(installed_packages)},
            )

            # Log available language pairs
            for pkg in installed_packages:
                logger.info(
                    "Translation package available",
                    extra={
                        "source_language": pkg.from_code,
                        "target_language": pkg.to_code,
                    },
                )

        except Exception as e:
            logger.error(
                "Failed to initialize translator",
                extra={"error": str(e)},
                exc_info=True,
            )
            raise

    def translate(self, text: str, source: str, target: str) -> str:
        """
        Translate text from source language to target language.

        Args:
            text: Text to translate
            source: Source language code (e.g., 'en')
            target: Target language code (e.g., 'es')

        Returns:
            Translated text

        Raises:
            ValueError: If language pair is not available
            RuntimeError: If translation fails
        """
        if not text or not text.strip():
            return text

        # Custom Tracers
        with tracer.start_as_current_span(
            f"translate_text - {target}",
            attributes={
                "translation.source_language": source,
                "translation.target_language": target,
                "translation.text_length": len(text),
            },
        ) as span:
            try:
                # Get translation object
                translation = argostranslate.translate.get_translation_from_codes(
                    source, target
                )

                if translation is None:
                    error_msg = f"Translation model not available for {source} -> {target}"
                    logger.error(
                        "Translation model unavailable",
                        extra={
                            "source_language": source,
                            "target_language": target,
                            "error": error_msg,
                        },
                    )
                    raise ValueError(error_msg)

                # Perform translation
                translated_text = translation.translate(text)

                # Custom Spans
                span.set_attribute("translation.output_length", len(translated_text))
                span.set_status(trace.Status(StatusCode.OK))

                logger.info(
                    "Translation completed",
                    extra={
                        "source_language": source,
                        "target_language": target,
                        "text_length": len(text),
                        "output_length": len(translated_text),
                    },
                )

                return translated_text

            except ValueError:
                raise
            except Exception as e:
                error_msg = f"Translation failed ({source} -> {target}): {str(e)}"
                logger.error(
                    "Translation failed",
                    extra={
                        "source_language": source,
                        "target_language": target,
                        "error": error_msg,
                    },
                    exc_info=True,
                )
                raise RuntimeError(error_msg) from e
