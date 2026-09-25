# -*- coding: utf-8 -*-
"""v1.3.1: _CODE_RE FC2-<digits> branch + extract_code title/basename extraction.
Offline. Covers the three simulated javstash codes (HEYZO-2059 / 092026-001 /
FC2-4817186) plus FC2PPV regression and priority rules."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
import javstash_autofill_plus as M

PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond: print("  FAIL:", name, extra)

# --- _CODE_RE title-prefix extraction (the three target shapes) ---
titles = {
    "HEYZO-2059": "HEYZO-2059",
    "092026-001": "092026-001",
    "FC2-4817186": "FC2-4817186",
    "FC2_4817186": "FC2_4817186",
}
for title, expect in titles.items():
    check("title %s" % title, M._CODE_RE.match(title).group(1) == expect, M._CODE_RE.match(title))

# FC2PPV regression (must still take the PPV branch, untouched)
for t, e in (("FC2PPV-4817186", "FC2PPV-4817186"), ("FC2-PPV-4817186", "FC2-PPV-4817186"),
             ("FC2PPV_4817186", "FC2PPV_4817186")):
    m = M._CODE_RE.match(t)
    check("title %s" % t, m is not None and m.group(1) == e, m)

# FC2 with too-short number / non-FC2 prefix must NOT match; a normal letter
# code still matches (SSIS-1234 -> [A-Za-z]{2,6} branch, regression)
for t in ("FC2-123", "FC2XX-4817186"):
    check("exclude %s" % t, M._CODE_RE.match(t) is None, M._CODE_RE.match(t))
check("SSIS-1234 still matches", M._CODE_RE.match("SSIS-1234").group(1) == "SSIS-1234")

# --- extract_code: code field wins ---
sc = {"code": "ABP-123", "title": "FC2-4817186 xyz", "files": []}
check("code field priority", M.extract_code(sc) == "ABP-123")

# --- extract_code: title prefix (bare scene after scan, NFO not applied yet) ---
sc = {"code": "", "title": "FC2-4817186 出演 素人", "files": []}
check("title prefix", M.extract_code(sc) == "FC2-4817186")
sc = {"code": "", "title": "092026-001 無修正", "files": []}
check("title prefix date-style", M.extract_code(sc) == "092026-001")

# --- extract_code: basename fallback (title/code empty) ---
sc = {"code": "", "title": "", "files": [{"path": "/videos/FC2-4817186.mp4"}]}
check("basename fallback", M.extract_code(sc) == "FC2-4817186")
sc = {"code": "", "title": "", "files": [{"path": "/videos/HEYZO-2059.mp4"}]}
check("basename fallback 2", M.extract_code(sc) == "HEYZO-2059")
sc = {"code": "", "title": "", "files": [{"path": "/videos/random-name.mp4"}]}
check("no code anywhere", M.extract_code(sc) is None)

# --- codes_match unaffected ---
check("codes_match unaffected", M.codes_match("FC2PPV-4817186", "FC2PPV-4817186-4k") is True
      and M.codes_match("FC2-4817186", "SSIS-1234") is False)

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
sys.exit(1 if FAIL else 0)
