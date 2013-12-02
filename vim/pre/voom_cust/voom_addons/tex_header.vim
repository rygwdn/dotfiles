python << EOF

# Replace default headline construction procedure with a custom function:
# 1. Define a make_head Python function.
#       - It returns a string: Tree headline text.
#       - It requires two arguments: bline and match.
#           - bline is Body line from which we make Tree headline.
#           - match is MatchObject produced by re.search() for bline and fold
#             marker regex
#               - bline[:match.start()] gives part of Body line before the
#                 matching fold marker. This is what we usually start from.
# 2. Register function in dictionary voom.MAKE_HEAD for filetypes with which
#    it should be used.

import re

voom_head_latex_re = re.compile(r"\\.+.*{(.*)} *(.*)")
def voom_make_head_latex(bline,match):
    s = bline[:match.start()].strip(' \t%').strip()
    match = voom_head_latex_re.match(s)
    if match:
        sec, tail = match.groups()
        s = sec.strip()
        if tail:
            s += " - " + tail.strip()
    return s
voom.MAKE_HEAD['tex'] = voom_make_head_latex

EOF
