"""
" HACK to make this file source'able by vim as well as importable by Python:
python reload(py_test_switcher)
finish
"""

import vim
import os
import re

DEBUG = False

patterns = [
    ('%/__init__.py', '%/tests/test_%.py'),
    ('%.py',          'tests/test_%.py'),
    ('%.py',          'test/test_%.py'),
    ('%.py',          'test_%.py'),
    ('%.py',          '%.txt'),
    ('%.py',          'tests/tests.py'),
    ('%.py',          'tests.py'),
    # Pylons
    ('controllers/%.py',  'tests/functional/test_%.py'),
    ('controllers/%.py',  'tests/test_%.py'),
    ('lib/%.py',          'tests/test_%.py'),
    ('model/__init__.py', 'tests/test_models.py'),
    # well, ...
    ('public/js/ControlPanel/%.js',    'tests/js/test_%.js'),
    # ivija
    ('resources/%.js',    'tests/test_%.js'),
]

def pattern2regex(pattern):
    if '%' in pattern:
        idx = pattern.index('%') + 1
        pattern = (pattern[:idx].replace('%', '([^/]+)') +
                   pattern[idx:].replace('%', '\\1'))
    return re.compile('(^|/)' + pattern.replace('.', '\\.') + '$')


def try_match(filename, pattern, replacement):
    if DEBUG:
        print 'trying %s -> %s' % (pattern, replacement)
    if '%' in replacement and '%' not in pattern:
        return None
    rx = pattern2regex(pattern)
    if not rx.search(filename):
        return None
    if DEBUG:
        print 'MATCH: %s -> %s' % (pattern, replacement)
    replacement = r'\1' + replacement.replace('%', r'\2')
    return rx.sub(replacement, filename)


def find_all_matches(filename):
    results = []
    for a, b in patterns:
        results.append(try_match(filename, a, b))
        results.append(try_match(filename, b, a))
    return filter(None, results)


def find_best_match(filename):
    matches = find_all_matches(filename)
    for match in matches:
        if os.path.exists(match):
            return match
    for match in matches:
        if os.path.exists(os.path.dirname(match)):
            return match
    return None


def switch_code_and_test(verbose=False):
    global DEBUG
    DEBUG = verbose
    filename = vim.eval('expand("%:p")')
    if DEBUG:
        print filename
    newfilename = find_best_match(filename)
    if newfilename:
        if DEBUG:
            print '->', newfilename
        vim.command('call SwitchToFile(%r)' % newfilename)
    else:
        pass

