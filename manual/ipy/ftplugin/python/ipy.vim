if exists('s:IPY_LOADED') || !has("python")
    finish
endif

let s:IPY_LOADED = 1

python << EOF
import socket
import os
import vim
import sys

class IPyServer(object):
    def __init__(self):
        self.server = None
        serv = os.environ.get('IPY_SERVER')
        # autoconnect if launched from ipython
        if serv:
            self.connnect(server=serv)

    def connect(self, servername=None, server=None):
        # connect to the ipython server, if we need to
        if not servername:
            servername = "vimserver"
        if servername and not server:
            server = os.path.abspath(os.path.expanduser("~/.ipython/%s" % servername))
        self.disconnect()

        try:
            self.server = socket.socket(socket.AF_UNIX)
            self.server.connect(server)
        except:
            print "Failed to connect to %s" % server
            self.server = None

    def disconnect(self):
        if self.server:
            self.server.close()

    def send(self, cmd):
        if self.server:
            start = 0
            while start < len(cmd):
                start += self.server.send(cmd[start:])
        else:
            raise Exception("Not connected to an IPython server")

    def run_file(self):
        self.send('%%run  %s' % vim.current.buffer.name)

    def run_range(self):
        r = vim.current.range
        self.send('\n'.join(vim.current.buffer[r.start:r.end + 1]) + '\n')
        print "sent lines %s -> %s to ipython" % (r.start, r.end + 1)

IPYSERVER = IPyServer()

EOF

map <leader>ip :python IPYSERVER.run_range()<CR>
vmap <leader>ip :python IPYSERVER.run_range()<CR>
com IPyRunAll 0,$ python IPYSERVER.run_range()
com IPyRunFile python IPYSERVER.run_file()
com -nargs=? IPyConnect python IPYSERVER.connect("<args>")

