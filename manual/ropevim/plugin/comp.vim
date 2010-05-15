python << EOF
from ropevim import _interface
from ropemode.interface import _CodeAssist
from rope.base.exceptions import BadIdentifierError
from rope.contrib.codeassist import PyDocExtractor
import re
import vim

class Completer(object):
    def __init__(self):
        self.pydocex = PyDocExtractor()

    def create_code_assist(self):
        return _CodeAssist(_interface, _interface.env)

    _docstring_re = re.compile('^[\s\t\n]*([^\n]*)')
    def _completion(self, proposal):
        # we are using extended complete and return dicts instead of strings.
        # `ci` means "completion item". see `:help complete-items`
        ci = {'word': proposal.name}

        scope = proposal.scope[0].upper()
        type_ = proposal.type
        info = None

        if proposal.scope == 'parameter_keyword':
            scope = ' '
            type_ = 'param'
            if not hasattr(proposal, 'get_default'):
                # old version of rope
                pass
            else:
                default = proposal.get_default()
                if default is None:
                    info = '*'
                else:
                    info = '= %s' % default

        elif proposal.scope == 'keyword':
            scope = ' '
            type_ = 'keywd'

        elif proposal.scope == 'attribute':
            scope = 'M'
            if proposal.type == 'function':
                type_ = 'meth'
            elif proposal.type == 'instance':
                type_ = 'prop'

        elif proposal.type == 'function':
            type_ = 'func'

        elif proposal.type == 'instance':
            type_ = 'inst'

        elif proposal.type == 'module':
            type_ = 'mod'

        if info is None:
            obj_doc = proposal.get_doc()
            if obj_doc:
                info = self._docstring_re.match(obj_doc).group(1)
            else:
                info = ''

        if type_ is None:
            type_ = ' '
        else:
            type_ = type_.ljust(5)[:5]
        ci['menu'] = ' '.join((scope, type_, info))
        ci['info'] = proposal.get_doc()
        ret =  '{%s}' % ','.join(""" "%s":"%s" """ % \
                         (key, value.replace('"', '\\"')) \
                         for (key, value) in ci.iteritems() if value)
        return ret

    def __call__(self, findstart, base):
        try:
            if findstart:
                self.code_assist = self.create_code_assist()
                base_len = self.code_assist.offset - \
                           self.code_assist.starting_offset
                return int(vim.eval("col('.')")) - base_len - 1
            else:
                try:
                    proposals = self.code_assist._calculate_proposals()
                except Exception:
                    return []
                if vim.eval("complete_check()") != "0":
                    return []

                ps = [self._completion(p) for p in proposals]
                del self.code_assist

                return "[%s]" % ' , '.join(ps) 
        except BadIdentifierError:
            del self.code_assist
            if findstart:
                return -1
            else:
                return []
completer = Completer()
EOF


function! RopeCompleteFunc(findstart, base)
python << EOF
findstart = int(vim.eval("a:findstart"))
base = vim.eval("a:base")
#vim.command("echo %s" % completer(findstart, base))
vim.command("return %s" % completer(findstart, base))
EOF
endfunction 
