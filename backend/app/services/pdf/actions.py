from dataclasses import dataclass, field
from typing import Callable

KINDS = ("read", "change", "export")


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    type: str = "text"
    default: object = None
    options: tuple = ()
    hint: str = ""


@dataclass(frozen=True)
class Action:
    name: str
    kind: str
    label: str
    suffix: str = ""
    words: tuple = ()
    ext: str = ".pdf"
    fields: tuple = ()
    run: Callable | None = None
    owner: str = "formpdf"

    @property
    def batch(self) -> bool:
        return self.kind != "read" and self.name not in ("merge", "fill", "annotate", "form", "organize", "unlock", "spell_fix", "measure", "edit_attachments", "edit_items")

    def describe(self) -> dict:
        return {"name": self.name, "kind": self.kind, "label": self.label, "words": list(self.words), "ext": self.ext, "batch": self.batch,
                "owner": self.owner, "fields": [{"name": f.name, "label": f.label, "type": f.type, "default": f.default, "options": list(f.options), "hint": f.hint}
                                                for f in self.fields]}


REGISTRY: dict[str, Action] = {}
READ: list[str] = []
CHANGE: list[str] = []
EXPORT: list[str] = []
ALL: list[str] = []
LABEL: dict[str, str] = {}
SUFFIX: dict[str, str] = {}
_LISTS = {"read": READ, "change": CHANGE, "export": EXPORT}


def register(action: Action) -> Action:
    if action.kind not in KINDS:
        raise ValueError(f"kind is one of {', '.join(KINDS)}")
    if action.name in REGISTRY:
        raise ValueError(f"{action.name} is already an action")
    REGISTRY[action.name] = action
    _LISTS[action.kind].append(action.name)
    ALL[:] = READ + CHANGE + EXPORT
    LABEL[action.name] = action.label
    if action.suffix or action.kind == "change":
        SUFFIX[action.name] = action.suffix or action.name.replace("_", "-")
    return action


def get(name: str) -> Action | None:
    return REGISTRY.get(name)


def catalogue() -> list[dict]:
    return [REGISTRY[n].describe() for n in ALL]


PAGES = Field("pages", "Pages", hint="All pages when empty; 1-3, 5, 8-")
COLOR = Field("color", "Colour", "color", "#333333")

for a in (
    Action("info", "read", "Document properties", words=("properties", "metadata", "page count")),
    Action("text", "read", "Extract text", words=("copy text", "plain text", "markdown")),
    Action("images", "read", "Extract pictures", words=("images", "photos")),
    Action("tables", "read", "Extract tables", words=("csv", "excel", "spreadsheet")),
    Action("find", "read", "Find text", words=("search", "look up")),
    Action("comments", "read", "List comments", words=("annotations", "review", "replies")),
    Action("fields", "read", "List form fields", words=("form", "fields")),
    Action("hidden", "read", "Find hidden information", words=("metadata", "javascript", "attachments", "layers")),
    Action("compare", "read", "Compare with another PDF", words=("diff", "differences", "versions")),
    Action("header_footer", "change", "Add header and footer", "header-footer", ("bates", "bates numbers", "legal numbering", "footer", "header"),
           fields=(Field("footer.center", "Footer centre", default="<<page>>", hint="Tokens <<page>> <<pages>> <<date>> <<file>> <<bates>>"),
                   Field("header.center", "Header centre"), Field("bates.on", "Add Bates numbers", "bool", False, hint="Placed where <<bates>> is, or bottom right"),
                   Field("bates.prefix", "Bates prefix"), Field("bates.suffix", "Bates suffix"),
                   Field("bates.start", "Bates start", "number", 1), Field("bates.digits", "Bates digits", "number", 6),
                   Field("bates.across", "Continue numbers from file to file", "bool", True, hint="Also writes Bates numbers.csv with each file's range"),
                   Field("size", "Text size", "number", 10),
                   COLOR, PAGES)),
    Action("page_numbers", "change", "Add page numbers", "numbered", ("number pages", "pagination"),
           fields=(Field("position", "Position", "select", "bottom-center", ("bottom-center", "bottom-right", "bottom-left", "top-center", "top-right", "top-left")),
                   Field("format", "Format", default="{n}", hint="{n} and {total}, for example Page {n} of {total}"), Field("start", "Start at", "number", 1),
                   Field("size", "Text size", "number", 10), COLOR, PAGES)),
    Action("watermark", "change", "Add watermark", "watermarked", ("draft", "confidential", "stamp text"),
           fields=(Field("text", "Text", default="CONFIDENTIAL"), Field("opacity", "Opacity", "number", 0.15), Field("angle", "Angle", "number", 45),
                   Field("size", "Text size", "number", 64), Field("color", "Colour", "color", "#888888"), PAGES)),
    Action("crop", "change", "Crop pages", "cropped", ("trim", "margins", "white margins"),
           fields=(Field("auto", "Remove white margins", "bool", True), PAGES)),
    Action("redact", "change", "Redact", "redacted", ("black out", "remove text", "privacy", "pii"),
           fields=(Field("preset", "Find", "select", "email", ("email", "phone", "card", "date")), Field("query", "Or words", hint="Used when set, instead of the preset"), PAGES)),
    Action("organize", "change", "Organize pages", "organized", ("rotate", "delete pages", "reorder", "insert blank")),
    Action("protect", "change", "Protect with password", "protected", ("encrypt", "lock", "password"),
           fields=(Field("password", "Password to open", "password"), Field("owner", "Permissions password", "password"))),
    Action("unlock", "change", "Remove password", "unlocked", ("decrypt", "unlock")),
    Action("metadata", "change", "Edit metadata", "metadata", ("title", "author", "properties"),
           fields=(Field("title", "Title"), Field("author", "Author"), Field("subject", "Subject"), Field("keywords", "Keywords"), Field("strip", "Remove all metadata", "bool", False))),
    Action("compress", "change", "Compress", "compressed", ("reduce size", "optimize", "smaller"), fields=(Field("quality", "Picture quality", "number", 70, hint="10 to 95"),)),
    Action("sanitize", "change", "Remove hidden information", "clean", ("sanitize", "scrub", "strip metadata"),
           fields=(Field("remove", "Remove", "multi", ["metadata", "javascript", "attachments", "private", "thumbnails"],
                         ("metadata", "javascript", "attachments", "comments", "fields", "layers", "links", "bookmarks", "thumbnails", "private", "hidden_text")),)),
    Action("fill", "change", "Fill form", "filled", ("form fill", "fill in")),
    Action("annotate", "change", "Add comments", "commented", ("highlight", "note", "markup")),
    Action("form", "change", "Prepare form", "form", ("form fields", "fillable")),
    Action("merge", "change", "Merge PDFs", "merged", ("combine", "join", "append")),
    Action("split", "export", "Split into files", ext="", words=("extract pages", "separate"), fields=(Field("ranges", "Ranges", "list", ["1-"], hint="One file per range"),)),
    Action("to_docx", "export", "Save as Word", ext=".docx", words=("word", "docx", "convert")),
    Action("to_pptx", "export", "Export to PowerPoint", ext=".pptx", words=("powerpoint", "pptx", "slides", "deck"), fields=(Field("text", "Editable text boxes", "bool", True),)),
):
    register(a)
