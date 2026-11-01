"""Structured logging configuration for the translation worker."""

import logging
import sys

from pythonjsonlogger import json


_HANDLER_MARKER = "translation-worker-json"
_QUIET_LOGGERS = ("argostranslate", "argostranslate.utils", "ctranslate2")


def setup_logging(level: int | str = logging.INFO) -> None:
    """Configure the root logger to emit structured JSON to stdout.

    The marker makes this function safe to call more than once during tests or
    development reloads without adding duplicate handlers.
    """
    if isinstance(level, str):
        level = level.upper()

    root_logger = logging.getLogger()

    # Argos Translate emits very verbose INFO messages for tokenization and
    # translation internals. Keep warnings and errors visible, but leave the
    # worker's own logs at the configured level. 不顯示第三方套件的INFO訊息，僅顯示我們自己的訊息
    for logger_name in _QUIET_LOGGERS:
        logging.getLogger(logger_name).setLevel(logging.WARNING)

    for handler in root_logger.handlers:
        if getattr(handler, "_translation_worker_marker", None) == _HANDLER_MARKER:
            handler.setLevel(level)
            root_logger.setLevel(level)
            return

    handler = logging.StreamHandler(sys.stdout)
    handler._translation_worker_marker = _HANDLER_MARKER  # type: ignore[attr-defined]
    handler.setFormatter(
        json.JsonFormatter(
            ["asctime", "levelname", "name", "message"],
            rename_fields={"asctime": "timestamp", "levelname": "level"},
        )
    )
    handler.setLevel(level)
    root_logger.addHandler(handler)
    root_logger.setLevel(level)
