// Apply formpdf changes: an InDesign script that applies a formpdf change list (Comment > Share comments >
// Export text changes) to the open document. Each change names its text with the words before and after it, so it is
// found in the stories even after the layout has moved. Deletions, replacements and insertions are made in the text;
// comments become InDesign notes. The whole run is one step in Edit > Undo, and with Track Changes on every edit can be
// accepted or rejected in the Story Editor. A report is written next to the change list.
//
// Install: copy this file to the Scripts Panel folder (Window > Utilities > Scripts, right-click User > Reveal), then
// double-click it in the Scripts panel with the document open.
//
// ExtendScript is ECMAScript 3: no JSON, no Array indexOf, no String trim, and reserved words (with, delete) are only
// used as quoted property names. The file is plain ASCII; characters outside it are written as character codes.

var FORMPDF = { version: 1 };

// ---- JSON (ExtendScript has no JSON object; this reads the change list without eval) ----

FORMPDF.parseJSON = function (src) {
  var i = 0;
  function fail(what) { throw new Error("The change list is not valid JSON (" + what + " at character " + i + ")"); }
  function ws() { while (i < src.length) { var c = src.charAt(i); if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; } else { break; } } }
  function str() {
    var out = "";
    i++;
    while (i < src.length) {
      var c = src.charAt(i++);
      if (c === "\"") { return out; }
      if (c === "\\") {
        var e = src.charAt(i++);
        if (e === "u") { out += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; }
        else if (e === "n") { out += "\n"; } else if (e === "t") { out += "\t"; } else if (e === "r") { out += "\r"; }
        else if (e === "b") { out += String.fromCharCode(8); } else if (e === "f") { out += String.fromCharCode(12); } else { out += e; }
      } else { out += c; }
    }
    fail("an unfinished string");
  }
  function num() {
    var m = /^-?\d+(\.\d+)?([eE][+\-]?\d+)?/.exec(src.substr(i));
    if (!m) { fail("an unexpected character"); }
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function value() {
    ws();
    var c = src.charAt(i);
    if (c === "{") {
      var o = {};
      i++; ws();
      if (src.charAt(i) === "}") { i++; return o; }
      while (true) {
        ws();
        if (src.charAt(i) !== "\"") { fail("a missing key"); }
        var k = str();
        ws();
        if (src.charAt(i++) !== ":") { fail("a missing colon"); }
        o[k] = value();
        ws();
        var d = src.charAt(i++);
        if (d === "}") { return o; }
        if (d !== ",") { fail("a missing comma"); }
      }
    }
    if (c === "[") {
      var a = [];
      i++; ws();
      if (src.charAt(i) === "]") { i++; return a; }
      while (true) {
        a.push(value());
        ws();
        var e2 = src.charAt(i++);
        if (e2 === "]") { return a; }
        if (e2 !== ",") { fail("a missing comma"); }
      }
    }
    if (c === "\"") { return str(); }
    if (src.substr(i, 4) === "true") { i += 4; return true; }
    if (src.substr(i, 5) === "false") { i += 5; return false; }
    if (src.substr(i, 4) === "null") { i += 4; return null; }
    return num();
  }
  if (src.charCodeAt(0) === 0xFEFF) { src = src.substr(1); }
  var v = value();
  ws();
  if (i < src.length) { fail("text after the end"); }
  return v;
};

// ---- Matching (pure: strings in, positions out) ----

// The PDF's text and the story differ in spaces, line breaks and hyphens where a word was broken across lines, so text
// is compared as a key that leaves those out, with a map from each key character back to the story.
FORMPDF.skip = function (c) {
  // spaces of every width, soft and non-breaking hyphens, line and paragraph breaks, the control characters InDesign
  // uses for markers (end of nested style, indent to here, right indent tab), the byte order mark, the object placeholder
  var n = c.charCodeAt(0);
  return c === " " || c === "-" || n < 0x20 || n === 0xAD || n === 0xA0 || (n >= 0x2000 && n <= 0x200B) || n === 0x2011 ||
    n === 0x202F || n === 0x2028 || n === 0x2029 || n === 0xFEFF || n === 0xFFFC;
};

FORMPDF.fold = function (c) {
  // typographic quotes as InDesign sets them, plain as some PDFs extract them; ligatures as their letters
  var n = c.charCodeAt(0);
  if (n === 0x2018 || n === 0x2019 || n === 0x201B) { return "'"; }
  if (n === 0x201C || n === 0x201D || n === 0x201F) { return "\""; }
  if (n === 0xFB00) { return "ff"; }
  if (n === 0xFB01) { return "fi"; }
  if (n === 0xFB02) { return "fl"; }
  if (n === 0xFB03) { return "ffi"; }
  if (n === 0xFB04) { return "ffl"; }
  return c;
};

FORMPDF.key = function (text) {
  var k = "", map = [];
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (FORMPDF.skip(c)) { continue; }
    var f = FORMPDF.fold(c);
    for (var j = 0; j < f.length; j++) { k += f.charAt(j); map.push(i); }
  }
  return { key: k, map: map };
};

FORMPDF.common = function (a, b, fromEnd) {
  var n = 0;
  if (fromEnd) {
    while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) { n++; }
  } else {
    while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) { n++; }
  }
  return n;
};

// Finds where a change applies among the stories' texts. Returns {story, start, end} (story positions, end exclusive;
// start equals end for an insertion) or {problem: "not found" | "ambiguous"}. pageOf(story, index) may give the
// document page of a position, which breaks ties in favour of the page the change was made on.
FORMPDF.locate = function (texts, change, pageOf) {
  var keys = [];
  for (var s = 0; s < texts.length; s++) { keys.push(FORMPDF.key(texts[s])); }
  var before = FORMPDF.key(change.before || "").key, after = FORMPDF.key(change.after || "").key;
  var target = FORMPDF.key(change.text || "").key;
  var found = [];
  if (change.type === "insert") {
    // the caret sits between before and after: search for the end of one running into the start of the other,
    // shortening both until something is found
    var lens = [24, 16, 10, 6];
    for (var li = 0; li < lens.length && !found.length; li++) {
      var bt = before.substr(Math.max(0, before.length - lens[li])), ah = after.substr(0, lens[li]);
      if (bt.length + ah.length < 6) { continue; }
      for (var s2 = 0; s2 < keys.length; s2++) {
        var k = keys[s2].key, at = k.indexOf(bt + ah);
        while (at >= 0) {
          var cut = at + bt.length;
          var pos = cut > 0 ? keys[s2].map[cut - 1] + 1 : 0;
          if (bt.length === 0 && cut < keys[s2].map.length) { pos = keys[s2].map[cut]; }
          found.push({ story: s2, start: pos, end: pos, score: FORMPDF.common(before, k.substr(0, cut), true) + FORMPDF.common(after, k.substr(cut), false) });
          at = k.indexOf(bt + ah, at + 1);
        }
      }
    }
  } else {
    if (!target.length) { return { problem: "not found" }; }
    for (var s3 = 0; s3 < keys.length; s3++) {
      var k3 = keys[s3].key, at3 = k3.indexOf(target);
      while (at3 >= 0) {
        var e3 = at3 + target.length;
        found.push({ story: s3, start: keys[s3].map[at3], end: keys[s3].map[e3 - 1] + 1,
          score: FORMPDF.common(before, k3.substr(0, at3), true) + FORMPDF.common(after, k3.substr(e3), false) });
        at3 = k3.indexOf(target, at3 + 1);
      }
    }
  }
  if (!found.length) { return { problem: "not found" }; }
  if (pageOf && change.page) {
    for (var f = 0; f < found.length; f++) {
      var p = null;
      try { p = pageOf(found[f].story, found[f].start); } catch (err) { p = null; }
      if (p === change.page) { found[f].score += 0.5; }
    }
  }
  found.sort(function (a, b) { return b.score - a.score; });
  if (found.length > 1 && found[0].score === found[1].score) { return { problem: "ambiguous" }; }
  return { story: found[0].story, start: found[0].start, end: found[0].end };
};

// A deleted word takes one of the spaces around it, so "the very quick" loses "very " and not just "very".
FORMPDF.tidy = function (text, start, end) {
  var prev = start > 0 ? text.charAt(start - 1) : "", next = end < text.length ? text.charAt(end) : "";
  if (prev === " " && next === " ") { return { start: start, end: end + 1 }; }
  if (prev === " " && /[.,;:!?)]/.test(next)) { return { start: start - 1, end: end }; }
  return { start: start, end: end };
};

FORMPDF.wanted = function (change) {
  var s = change.status || "none";
  return s === "none" || s === "accepted";
};

FORMPDF.noteText = function (c) {
  var s = (c.author ? c.author + ": " : "") + (c.note || "");
  if (c.replies && c.replies.length) { s += "\r" + c.replies.join("\r"); }
  return s;
};

// Works out every edit before making any, so positions found in the original text stay right: per story, the edits
// are made from the end backwards. Returns {edits: [...], report: [...]}.
FORMPDF.plan = function (texts, list, pageOf) {
  var edits = [], report = [], taken = {};
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var line = { id: c.id || String(i + 1), type: c.type, page: c.page, text: c.text || "", value: c["with"] || c.note || "" };
    if (!FORMPDF.wanted(c)) { line.outcome = "skipped (" + c.status + ")"; report.push(line); continue; }
    if (c.type !== "delete" && c.type !== "replace" && c.type !== "insert" && c.type !== "comment") { line.outcome = "skipped (unknown type)"; report.push(line); continue; }
    var at = FORMPDF.locate(texts, c, pageOf);
    if (at.problem) { line.outcome = at.problem; report.push(line); continue; }
    var start = at.start, end = at.end;
    if (c.type === "delete") { var t = FORMPDF.tidy(texts[at.story], start, end); start = t.start; end = t.end; }
    var clash = false;
    if (c.type !== "comment") {
      for (var p = start; p <= Math.max(start, end - 1) && !clash; p++) { if (taken[at.story + ":" + p]) { clash = true; } }
    }
    if (clash) { line.outcome = "overlaps another change"; report.push(line); continue; }
    if (c.type === "delete" || c.type === "replace") { for (var q = start; q < end; q++) { taken[at.story + ":" + q] = true; } }
    edits.push({ story: at.story, start: start, end: end, type: c.type, value: c.type === "comment" ? FORMPDF.noteText(c) : (c["with"] || ""), line: line });
    line.outcome = "applied";
    report.push(line);
  }
  // from the end of each story backwards, by where each edit lands (a note lands at the end of its text); at the same
  // place a deletion or replacement goes first, so a note or insertion there ends up just before what replaced the text
  var at2 = function (e) { return e.type === "comment" ? e.end : e.start; };
  var point = function (e) { return e.type === "comment" || e.type === "insert" ? 1 : 0; };
  edits.sort(function (a, b) {
    if (a.story !== b.story) { return a.story - b.story; }
    if (at2(a) !== at2(b)) { return at2(b) - at2(a); }
    return point(a) - point(b);
  });
  return { edits: edits, report: report };
};

// Applies a plan to plain strings, the way the InDesign part applies it to stories; used to check a plan outside InDesign.
FORMPDF.applyToStrings = function (texts, edits) {
  var out = texts.slice(0);
  for (var i = 0; i < edits.length; i++) {
    var e = edits[i], t = out[e.story];
    if (e.type === "comment") { t = t.substr(0, e.end) + "[[note: " + e.value + "]]" + t.substr(e.end); }
    else { t = t.substr(0, e.start) + (e.type === "delete" ? "" : e.value) + t.substr(e.end); }
    out[e.story] = t;
  }
  return out;
};

FORMPDF.reportText = function (name, report) {
  var counts = {}, order = [], lines = ["formpdf changes from " + name, ""];
  for (var i = 0; i < report.length; i++) {
    var r = report[i];
    if (!counts[r.outcome]) { counts[r.outcome] = 0; order.push(r.outcome); }
    counts[r.outcome] += 1;
    lines.push(r.outcome + "\t" + r.type + "\tpage " + r.page + "\t" + r.id + "\t\"" + r.text + "\"" + (r.value ? " -> \"" + r.value + "\"" : ""));
  }
  var sum = [];
  for (var k = 0; k < order.length; k++) { sum.push(counts[order[k]] + " " + order[k]); }
  lines.splice(1, 0, sum.length ? sum.join(", ") : "no changes");
  return lines.join("\n");
};

// ---- InDesign ----

FORMPDF.run = function () {
  if (!app.documents.length) { alert("Open the InDesign document the PDF was made from first."); return; }
  var doc = app.activeDocument;
  var file = File.openDialog("Choose the formpdf change list (.json)", "*.json");
  if (!file) { return; }
  file.encoding = "UTF-8";
  file.open("r");
  var body = FORMPDF.parseJSON(file.read());
  file.close();
  if (!body || body.format !== "formpdf-changes") { alert("This is not a formpdf change list."); return; }
  var stories = [], texts = [];
  for (var s = 0; s < doc.stories.length; s++) { stories.push(doc.stories[s]); texts.push(doc.stories[s].contents); }
  var pageOf = function (si, index) {
    var frames = stories[si].characters[index].parentTextFrames;
    if (!frames.length || !frames[0].parentPage) { return null; }
    return frames[0].parentPage.documentOffset + 1;
  };
  var plan = FORMPDF.plan(texts, body.changes || [], pageOf);
  var track = plan.edits.length ? confirm(plan.edits.length + " of " + (body.changes || []).length + " changes were found. Record them with Track Changes, so each can be accepted or rejected in the Story Editor?") : false;
  app.doScript(function () {
    var was = {};
    for (var i = 0; i < plan.edits.length; i++) {
      var e = plan.edits[i], story = stories[e.story];
      if (track && was[e.story] === undefined) { was[e.story] = story.trackChanges; story.trackChanges = true; }
      if (e.type === "comment") {
        var note = story.insertionPoints[e.end].notes.add();
        note.texts[0].contents = e.value;
      } else if (e.type === "insert") {
        story.insertionPoints[e.start].contents = e.value;
      } else if (e.end > e.start) {
        var range = story.characters.itemByRange(e.start, e.end - 1);
        if (e.type === "delete") { range.remove(); } else { range.contents = e.value; }
      }
    }
    for (var k in was) { if (was.hasOwnProperty(k)) { stories[k].trackChanges = was[k]; } }
  }, ScriptLanguage.JAVASCRIPT, undefined, UndoModes.ENTIRE_SCRIPT, "Apply formpdf changes");
  var text = FORMPDF.reportText(body.document || file.name, plan.report);
  var out = new File(file.fsName.replace(/\.json$/i, "") + ".applied.txt");
  out.encoding = "UTF-8";
  out.open("w");
  out.write(text);
  out.close();
  alert(text.split("\n")[1] + ".\n\nThe report is in " + out.fsName + ".");
};

if (typeof app !== "undefined" && typeof ScriptLanguage !== "undefined") { FORMPDF.run(); }
