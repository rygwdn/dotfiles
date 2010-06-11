""" User configuration file for IPython

This is a more flexible and safe way to configure ipython than *rc files
(ipythonrc, ipythonrc-pysh etc.)

This file is always imported on ipython startup. You can import the
ipython extensions you need here (see IPython/Extensions directory).

Feel free to edit this file to customize your ipython experience.

Note that as such this file does nothing, for backwards compatibility.
Consult e.g. file 'ipy_profile_sh.py' for an example of the things
you can do here.

See http://ipython.scipy.org/moin/IpythonExtensionApi for detailed
description on what you could do here.
"""

# Most of your config files and extensions will probably start with this import

import IPython.ipapi
ip = IPython.ipapi.get()

# You probably want to uncomment this if you did %upgrade -nolegacy
# import ipy_defaults

import os

try:
    import pudb.ipython
except:
    pass

def main():

    # uncomment if you want to get ipython -p sh behaviour
    # without having to use command line switches
    # import ipy_profile_sh

    # Configure your favourite editor?
    # Good idea e.g. for %edit os.path.isfile

    #import ipy_editors

    # Choose one of these:

    #ipy_editors.scite()
    #ipy_editors.scite('c:/opt/scite/scite.exe')
    #ipy_editors.komodo()
    #ipy_editors.idle()
    # ... or many others, try 'ipy_editors??' after import to see them

    # Or roll your own:
    #ipy_editors.install_editor("c:/opt/jed +$line $file")


    o = ip.options
    # An example on how to set options
    #o.autocall = 1
    o.system_verbose = 0

    #import_all("os sys")
    #execf('~/_ipython/ns.py')


    # -- prompt
    # A different, more compact set of prompts from the default ones, that
    # always show your current location in the filesystem:

    #o.prompt_in1 = r'\C_LightBlue[\C_LightCyan\Y2\C_LightBlue]\C_Normal\n\C_Green|\#>'
    #o.prompt_in2 = r'.\D: '
    #o.prompt_out = r'[\#] '

    # Try one of these color settings if you can't read the text easily
    # autoexec is a list of IPython commands to execute on startup
    #o.autoexec.append('%colors LightBG')
    #o.autoexec.append('%colors NoColor')
    #o.autoexec.append('%colors Linux')

    # for sane integer division that converts to float (1/2 == 0.5)
    #o.autoexec.append('from __future__ import division')

    # For %tasks and %kill
    import jobctrl

    # For autoreloading of modules (%autoreload, %aimport)
    import ipy_autoreload
    #autoreload 2

    # For winpdb support (%wdb)
    #import ipy_winpdb

    # For bzr completer, requires bzrlib (the python installation of bzr)
    #ip.load('ipy_bzr')

    # Tab completer that is not quite so picky (i.e.
    # "foo".<TAB> and str(2).<TAB> will work). Complete
    # at your own risk!
    #import ipy_greedycompleter

    # If you are on Linux, you may be annoyed by
    # "Display all N possibilities? (y or n)" on tab completion,
    # as well as the paging through "more". Uncomment the following
    # lines to disable that behaviour
    import readline
    readline.parse_and_bind('set completion-query-items 1000')
    readline.parse_and_bind('set page-completions no')

    def _start_vim_server_f(self, parameter_s=''):
        import ipy_vimserver
        server = "vimserver"
        if parameter_s != '': server = parameter_s
        ipy_vimserver.setup(server)
    ip.expose_magic('vimserver', _start_vim_server_f)


    print """ Use >>> autoreload 2
to automatically reload modules after each command
>>> reset [-y]
is a bit more forceful, and resets all of ipython
>>> debug
does post-mortem after an exception
>>> obj?
prints lots of info about obj
>>> prun ...
profiles code
>>> psource obj
view source of obj
>>> magic
shows docs for all magic funcs
"""





# some config helper functions you can use
def import_all(modules):
    """ Usage: import_all("os sys") """
    for m in modules.split():
        ip.ex("from %s import *" % m)

def execf(fname):
    """ Execute a file in user namespace """
    ip.ex('execfile("%s")' % os.path.expanduser(fname))

main()
