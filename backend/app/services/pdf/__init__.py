from . import docs
from . import links
from .annot import annotate, comments
from .core import (Locked, extract_images, extract_tables, extract_text, info, merge, page_count, pages_zip, parse_pages, render_png,
                   split, tables_xlsx)
from .edit import (compress, crop, fill_fields, header_footer, metadata, organize, page_numbers, protect, read_fields, redact, unlock,
                   watermark)
from .compare import compare
from .create import from_files
from .forms import prepare as prepare_form
from .layout import reflow
from .sanitize import sanitize
from .sanitize import scan as scan_hidden
from .search import areas as match_areas
from .search import find
from .slides import contact_sheet, to_pptx
from .word import to_docx

__all__ = ["docs", "Locked", "info", "extract_text", "extract_images", "extract_tables", "merge", "split", "page_count", "pages_zip",
           "parse_pages", "render_png", "tables_xlsx", "annotate", "comments", "organize", "read_fields", "fill_fields", "protect", "unlock",
           "redact", "metadata", "compress", "page_numbers", "header_footer", "watermark", "crop", "find", "match_areas", "compare", "from_files",
           "prepare_form", "reflow", "sanitize", "scan_hidden", "to_docx", "to_pptx", "contact_sheet"]
