"""Optional D01 Docling comparison. Isolated Python venv only; no product integration."""
import hashlib
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
sys.stdout.reconfigure(encoding="utf-8")
artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
if not artifacts or not Path(artifacts).is_dir():
    raise SystemExit("Set DOCLING_ARTIFACTS_PATH to an existing empty local directory")

def deny_network(*_args, **_kwargs):
    raise RuntimeError("network disabled during D01 conversion")

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.create_connection = deny_network

import psutil  # noqa: E402
from importlib.metadata import version  # noqa: E402

process = psutil.Process()
peak = [process.memory_info().rss]
stop = threading.Event()

def sample():
    while not stop.wait(0.01):
        peak[0] = max(peak[0], process.memory_info().rss)

thread = threading.Thread(target=sample, daemon=True)
thread.start()
start = time.perf_counter()

from docling.datamodel.base_models import InputFormat  # noqa: E402
from docling.datamodel.pipeline_options import NativePdfPipelineOptions  # noqa: E402
from docling.document_converter import DocumentConverter, NativePdfFormatOption  # noqa: E402

root = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "evidence"
digest = "495a2c6eb4d3bbf81e2027f5f7d2c9fae57bcf79cfa36c378bb6b9d1f994f153"
if hashlib.sha256((root / "complex-deflate-props.docx").read_bytes()).hexdigest() != digest:
    raise SystemExit("fixture drift")

result = []
for name in ("sample.md", "complex-deflate-props.docx", "complex.pdf"):
    before = time.perf_counter()
    if name.endswith(".pdf"):
        converter = DocumentConverter(format_options={InputFormat.PDF: NativePdfFormatOption(pipeline_options=NativePdfPipelineOptions())})
    else:
        converter = DocumentConverter()
    try:
        conversion = converter.convert(root / name, max_num_pages=200, max_file_size=50 * 1024 * 1024)
        doc = conversion.document
        data = doc.export_to_dict()
        tables = [[[cell.text for cell in row] for row in table.data.grid] for table in doc.tables]
        text = [item.text for item in doc.texts]
        result.append({
            "name": name, "status": str(conversion.status), "elapsedMs": round((time.perf_counter() - before) * 1000, 1),
            "text": text, "tables": tables, "pictures": len(doc.pictures), "pages": len(doc.pages),
            "commentAnchors": sum(bool(item.get("comments")) for item in data["texts"]),
            "commentAuthors": [item["text"] for item in data["texts"] if "[author:" in item["text"]],
            "footnoteTextPresent": any("Fictional sample of two observations." in item for item in text),
            "pictureCaptions": [len(item.get("captions", [])) for item in data["pictures"]],
        })
    except Exception as exc:
        result.append({"name": name, "failure": f"{type(exc).__name__}: {str(exc)[:200]}", "elapsedMs": round((time.perf_counter() - before) * 1000, 1)})
stop.set()
thread.join()
print(json.dumps({
    "versions": {key: version(key) for key in ("docling-slim", "docling-core", "docling-parse", "psutil")},
    "platform": sys.platform, "python": sys.version.split()[0], "offlineSocketGuard": True,
    "nativePdfNoModels": True, "elapsedMs": round((time.perf_counter() - start) * 1000, 1),
    "rssPeakSampledBytes": max(peak[0], process.memory_info().rss), "rows": result,
}, ensure_ascii=False, indent=2))
