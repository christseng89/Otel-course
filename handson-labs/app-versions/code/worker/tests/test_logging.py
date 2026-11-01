import json as std_json
import logging

from pythonjsonlogger import json


def test_json_formatter_includes_structured_context():
    formatter = json.JsonFormatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s",
        rename_fields={"asctime": "timestamp", "levelname": "level"},
    )
    record = logging.LogRecord(
        name="src.worker",
        level=logging.INFO,
        pathname=__file__,
        lineno=10,
        msg="Processing translation job",
        args=(),
        exc_info=None,
    )
    record.job_id = "job-123"
    record.target_language = "es"

    payload = std_json.loads(formatter.format(record))

    assert payload["message"] == "Processing translation job"
    assert payload["level"] == "INFO"
    assert payload["job_id"] == "job-123"
    assert payload["target_language"] == "es"
    assert payload["timestamp"]
