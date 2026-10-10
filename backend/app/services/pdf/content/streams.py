from pypdf.generic import ContentStream, DecodedStreamObject, NameObject

from .interp import Stream


def write_page(page, writer, operations: list) -> None:
    cs = ContentStream(None, writer)
    cs.operations = operations
    page.replace_contents(cs)


def new_form(writer, form, operations: list):
    cs = ContentStream(None, writer)
    cs.operations = operations
    out = DecodedStreamObject()
    for k, v in form.items():
        if k not in ("/Length", "/Filter", "/DecodeParms"):
            out[NameObject(k)] = v
    out.set_data(cs.get_data())
    return writer._add_object(out)


def replace_form(writer, page_resources, stream: Stream, operations: list, parent_resources=None) -> str:
    res = parent_resources if parent_resources is not None else page_resources
    xobjects = res.get("/XObject").get_object()
    old = next((k for k, v in xobjects.items() if v.get_object() is stream.xobject), None)
    if old is None:
        raise ValueError("form not found in its parent's resources")
    ref = new_form(writer, stream.xobject, operations)
    n = 1
    while f"{old}_e{n}" in xobjects:
        n += 1
    name = f"{old}_e{n}"
    xobjects[NameObject(name)] = ref
    return name
